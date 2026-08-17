// Researcher Context Resolution
// Central abstraction for resolving per-request credentials in both deployment modes
// Every API route calls one of these to get the appropriate KV client and API keys

import type { RedisPort } from './redisPort';
import { cookies } from 'next/headers';
import { isStandaloneMode, isHostedMode } from './mode';
import { getKVClient, getResearcherClient } from './kvClient';
import {
  getResearcherByIdChecked,
  getStudyAuthorityChecked,
  type AuthorityPurpose,
  type OwnerRecord,
  type StudyAuthorityCheckedResult,
} from './platformDb';
import { decrypt } from './crypto';
import { verifySessionToken, verifyParticipantToken, SESSION_COOKIE_NAME } from './auth';
import { getStudy } from './kv';
import { getParticipantLinkById } from './participantLinks';
import { StoredStudy } from '@/types';
import type { AIProviderKeys } from './providers';
import { validateStudyConfig } from './studyConfigValidation';
import { logRequestFailure } from './requestLog';

export interface ResearcherContext {
  // Identity (null in standalone mode)
  researcherId: string | null;

  // Storage client (researcher's own Redis in hosted, env-var Redis in standalone)
  kvClient: RedisPort;

  // AI API keys
  geminiApiKey: string | null;
  anthropicApiKey: string | null;
  openaiApiKey: string | null;
  openrouterApiKey: string | null;

  // Whether the researcher has completed onboarding
  onboardingComplete: boolean;
}

// Keep provider credential projection in one place so every generation route
// forwards the full hosted BYOS set and future providers cannot be omitted by
// a route-local key literal.
export function providerKeysFromContext(
  context: Pick<
    ResearcherContext,
    'geminiApiKey' | 'anthropicApiKey' | 'openaiApiKey' | 'openrouterApiKey'
  >
): AIProviderKeys {
  return {
    geminiApiKey: context.geminiApiKey,
    anthropicApiKey: context.anthropicApiKey,
    openaiApiKey: context.openaiApiKey,
    openrouterApiKey: context.openrouterApiKey,
  };
}

// Resolve context for a researcher by ID (shared logic)
async function resolveById(researcherId: string): Promise<ResearcherContext> {
  const loaded = await getResearcherByIdChecked(researcherId);
  if (loaded.status === 'unavailable') {
    throw new Error('Researcher account storage is unavailable');
  }
  if (loaded.status === 'not-found') {
    throw new Error('Researcher account was not found');
  }
  const researcher = loaded.researcher;

  // Decrypt credentials
  const redisUrl = researcher.encryptedRedisUrl
    ? decrypt(researcher.encryptedRedisUrl, { researcherId, purpose: 'redis-url' })
    : null;
  const redisToken = researcher.encryptedRedisToken
    ? decrypt(researcher.encryptedRedisToken, { researcherId, purpose: 'redis-token' })
    : null;

  const missing: ResearcherSetupRequirement[] = [];
  if (!researcher.onboardingComplete) missing.push('onboarding');
  if (!redisUrl) missing.push('redis_url');
  if (!redisToken) missing.push('redis_token');
  if (missing.length > 0) {
    throw new ResearcherSetupRequiredError(missing);
  }
  // The missing-field guard above establishes both values at runtime; keep the
  // narrowed aliases local so credential strings never escape this resolver.
  const configuredRedisUrl = redisUrl as string;
  const configuredRedisToken = redisToken as string;
  const kvClient = getResearcherClient(configuredRedisUrl, configuredRedisToken, { researcherId });

  return {
    researcherId,
    kvClient,
    geminiApiKey: researcher.encryptedGeminiApiKey
      ? decrypt(researcher.encryptedGeminiApiKey, { researcherId, purpose: 'gemini-api-key' })
      : null,
    anthropicApiKey: researcher.encryptedAnthropicApiKey
      ? decrypt(researcher.encryptedAnthropicApiKey, { researcherId, purpose: 'anthropic-api-key' })
      : null,
    openaiApiKey: researcher.encryptedOpenAiApiKey
      ? decrypt(researcher.encryptedOpenAiApiKey, { researcherId, purpose: 'openai-api-key' })
      : null,
    openrouterApiKey: researcher.encryptedOpenRouterApiKey
      ? decrypt(researcher.encryptedOpenRouterApiKey, { researcherId, purpose: 'openrouter-api-key' })
      : null,
    onboardingComplete: researcher.onboardingComplete,
  };
}

// Standalone context: uses env vars, no researcher identity
function getStandaloneContext(): ResearcherContext {
  return {
    researcherId: null,
    kvClient: getKVClient(),
    geminiApiKey: process.env.GEMINI_API_KEY || null,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
    openaiApiKey: process.env.OPENAI_API_KEY || null,
    openrouterApiKey: process.env.OPENROUTER_API_KEY || null,
    onboardingComplete: true,
  };
}

// ============================================
// For researcher/admin API routes
// ============================================

export interface RequestContextResult {
  authorized: boolean;
  context: ResearcherContext | null;
  researcherId?: string;
  error?: string;
  setupRequired?: boolean;
  missing?: ResearcherSetupRequirement[];
  statusCode?: number;
  retryable?: boolean;
  code?: string;
  reason?: string;
}

export type ResearcherSetupRequirement = 'onboarding' | 'redis_url' | 'redis_token';

export interface HostedResearcherIdentityResult {
  authorized: boolean;
  researcherId?: string;
  issuedAt?: number;
  error?: string;
}

export function hasRecentResearcherSession(
  identity: HostedResearcherIdentityResult,
  maximumAgeSeconds: number
): boolean {
  if (!identity.authorized || typeof identity.issuedAt !== 'number') return false;
  const nowSeconds = Math.floor(Date.now() / 1000);
  return identity.issuedAt >= nowSeconds - maximumAgeSeconds
    && identity.issuedAt <= nowSeconds + 60;
}

export class ResearcherSetupRequiredError extends Error {
  constructor(readonly missing: ResearcherSetupRequirement[]) {
    super('Researcher onboarding is incomplete');
    this.name = 'ResearcherSetupRequiredError';
  }
}

export type AuthorityAudience = 'researcher' | 'participant';

export type PresentedStudyAuthority =
  | { ok: true; owner: OwnerRecord }
  | {
      ok: false;
      statusCode: number;
      error: string;
      retryable?: boolean;
      reason?: string;
      code?: string;
    };

// Opaque participant vs researcher HTTP mapping (Revision 12 §16.4–§16.5).
// Callers must not decrypt BYOS, set cookies, call providers, or persist after
// a denial from this presenter.
export function presentStudyAuthority(
  result: StudyAuthorityCheckedResult,
  audience: AuthorityAudience,
): PresentedStudyAuthority {
  if (result.status === 'allow') return { ok: true, owner: result.owner };

  if (audience === 'participant') {
    if (
      result.status === 'live'
      || result.status === 'deny'
      || result.status === 'notfound'
      || result.status === 'noacct'
    ) {
      return { ok: false, statusCode: 404, error: 'This study is no longer active.' };
    }
    if (result.status === 'hold') {
      return {
        ok: false,
        statusCode: 503,
        error: 'Unable to verify study status. Please try again later.',
        retryable: false,
        reason: 'schema-hold',
      };
    }
    return {
      ok: false,
      statusCode: 503,
      error: 'Unable to verify study status. Please try again later.',
      retryable: true,
    };
  }

  if (result.status === 'live') {
    return {
      ok: false,
      statusCode: 409,
      error: 'A study operation is already in progress.',
      retryable: true,
      code: 'STUDY_OPERATION_PENDING',
    };
  }
  if (result.status === 'deny') {
    return { ok: false, statusCode: 403, error: 'Forbidden' };
  }
  if (result.status === 'notfound') {
    return { ok: false, statusCode: 404, error: 'Study not found' };
  }
  if (result.status === 'adel') {
    return {
      ok: false,
      statusCode: 503,
      error: 'Service temporarily unavailable',
      retryable: true,
    };
  }
  if (result.status === 'hold') {
    return {
      ok: false,
      statusCode: 503,
      error: 'Schema lineage is held',
      retryable: false,
      reason: 'schema-hold',
    };
  }
  if (result.status === 'noacct') {
    return { ok: false, statusCode: 401, error: 'Unauthorized' };
  }
  return {
    ok: false,
    statusCode: 503,
    error: 'Unable to verify study authority',
    retryable: true,
  };
}

export async function resolveHostedResearcherStudyContext(input: {
  researcherId: string;
  studyId: string;
  purpose: AuthorityPurpose;
}): Promise<RequestContextResult & { owner?: OwnerRecord }> {
  const gate = await getStudyAuthorityChecked({
    researcherId: input.researcherId,
    studyId: input.studyId,
    purpose: input.purpose,
  });
  const presented = presentStudyAuthority(gate, 'researcher');
  if (!presented.ok) {
    return {
      authorized: false,
      context: null,
      researcherId: input.researcherId,
      error: presented.error,
      statusCode: presented.statusCode,
      retryable: presented.retryable,
      code: presented.code,
      reason: presented.reason,
    };
  }

  try {
    const context = await resolveById(input.researcherId);
    return {
      authorized: true,
      context,
      researcherId: input.researcherId,
      owner: presented.owner,
    };
  } catch (err) {
    if (err instanceof ResearcherSetupRequiredError) {
      return {
        authorized: true,
        context: null,
        researcherId: input.researcherId,
        error: 'Researcher onboarding is incomplete',
        setupRequired: true,
        missing: err.missing,
        owner: presented.owner,
      };
    }
    logRequestFailure({ event: 'route.failure', route: 'researcher-context' }, err);
    return {
      authorized: true,
      context: null,
      researcherId: input.researcherId,
      error: 'Researcher account storage is temporarily unavailable',
      statusCode: 503,
      retryable: true,
    };
  }
}

export async function gateHostedResearcherStudy(
  access: RequestContextResult,
  studyId: string,
  purpose: AuthorityPurpose,
): Promise<RequestContextResult & { owner?: OwnerRecord }> {
  if (!isHostedMode()) return access;
  if (!access.authorized || !access.researcherId) {
    return {
      authorized: false,
      context: null,
      error: access.error || 'Unauthorized',
      statusCode: 401,
    };
  }
  return resolveHostedResearcherStudyContext({
    researcherId: access.researcherId,
    studyId,
    purpose,
  });
}

// Hosted study-scoped surfaces: identity + authority, then BYOS decrypt.
// Standalone falls through to the deployment Redis context.
export async function getAuthorizedResearcherStudyContext(
  studyId: string,
  purpose: AuthorityPurpose,
): Promise<RequestContextResult & { owner?: OwnerRecord }> {
  if (!isHostedMode()) return getRequestContext();
  const identity = await getHostedResearcherIdentity();
  if (!identity.authorized || !identity.researcherId) {
    return {
      authorized: false,
      context: null,
      error: identity.error || 'Unauthorized',
      statusCode: 401,
    };
  }
  return resolveHostedResearcherStudyContext({
    researcherId: identity.researcherId,
    studyId,
    purpose,
  });
}

// Identity-only authentication for hosted onboarding/account lifecycle routes.
// It deliberately does not resolve or decrypt BYOS credentials, so a new user
// can configure storage without the unsafe null-Redis placeholder used before.
export async function getHostedResearcherIdentity(): Promise<HostedResearcherIdentityResult> {
  if (!isHostedMode()) {
    return { authorized: false, error: 'Only available in hosted mode' };
  }

  const cookieStore = await cookies();
  const authCookie = cookieStore.get(SESSION_COOKIE_NAME);
  if (!authCookie?.value) return { authorized: false, error: 'Unauthorized' };

  const session = await verifySessionToken(authCookie.value);
  if (!session.valid) {
    return { authorized: false, error: 'Session expired or invalid' };
  }
  if (!session.researcherId) {
    return { authorized: false, error: 'No researcher identity in session' };
  }

  return {
    authorized: true,
    researcherId: session.researcherId,
    issuedAt: session.issuedAt,
  };
}

// Cookie/JWT identity only. Reconcile and other hosted lifecycle routes must not
// resolve BYOS or decrypt credentials through getRequestContext.
export async function getResearcherIdentity(): Promise<HostedResearcherIdentityResult> {
  return getHostedResearcherIdentity();
}

export async function getRequestContext(): Promise<RequestContextResult> {
  const cookieStore = await cookies();
  const authCookie = cookieStore.get(SESSION_COOKIE_NAME);

  if (!authCookie?.value) {
    return { authorized: false, context: null, error: 'Unauthorized' };
  }

  const session = await verifySessionToken(authCookie.value);
  if (!session.valid) {
    return { authorized: false, context: null, error: 'Session expired or invalid' };
  }

  try {
    if (isStandaloneMode()) {
      return {
        authorized: true,
        context: getStandaloneContext(),
      };
    }

    // Hosted mode: resolve researcher credentials
    if (!session.researcherId) {
      return { authorized: false, context: null, error: 'No researcher identity in session' };
    }

    const context = await resolveById(session.researcherId);
    return {
      authorized: true,
      context,
      researcherId: session.researcherId,
    };
  } catch (err) {
    if (err instanceof ResearcherSetupRequiredError) {
      return {
        authorized: true,
        context: null,
        researcherId: session.researcherId,
        error: 'Researcher onboarding is incomplete',
        setupRequired: true,
        missing: err.missing,
      };
    }
    logRequestFailure({ event: 'route.failure', route: 'researcher-context' }, err);
    return {
      authorized: true,
      context: null,
      researcherId: session.researcherId,
      error: 'Researcher account storage is temporarily unavailable',
      statusCode: 503,
      retryable: true,
    };
  }
}

// ============================================
// For participant API routes
// ============================================

export interface ParticipantContextResult {
  valid: boolean;
  context: ResearcherContext | null;
  studyId?: string;
  isAdmin?: boolean;
  error?: string;
  // Suggested HTTP status for the denial when !valid (503 = retryable, 403 = denied, 401 = auth)
  statusCode?: number;
  retryable?: boolean;
  study?: StoredStudy;
  linkId?: string;
  participantSessionId?: string;
  studyRevision?: number;
  persistRepairOnly?: boolean;
  needsStudySelection?: boolean;
}

export interface ParticipantContextOptions {
  purpose?: AuthorityPurpose;
  selectedStudyId?: string;
}

export function selectedStudyIdFromParticipantBody(
  body: Record<string, unknown>,
): string | undefined {
  if (typeof body.studyId === 'string' && body.studyId.length > 0) return body.studyId;
  const studyConfig = body.studyConfig;
  if (studyConfig && typeof studyConfig === 'object' && !Array.isArray(studyConfig)) {
    const id = (studyConfig as { id?: unknown }).id;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return undefined;
}

function deniedParticipantContext(
  presented: Extract<PresentedStudyAuthority, { ok: false }>,
  extra?: Partial<ParticipantContextResult>,
): ParticipantContextResult {
  return {
    valid: false,
    context: null,
    error: presented.error,
    statusCode: presented.statusCode,
    retryable: presented.retryable,
    ...extra,
  };
}

async function resolveHostedPreviewContext(input: {
  researcherId: string;
  studyId: string;
}): Promise<ParticipantContextResult> {
  const gate = await getStudyAuthorityChecked({
    researcherId: input.researcherId,
    studyId: input.studyId,
    purpose: 'preview',
  });
  const presented = presentStudyAuthority(gate, 'researcher');
  if (!presented.ok) {
    return deniedParticipantContext(presented, { isAdmin: true });
  }
  try {
    const context = await resolveById(input.researcherId);
    return { valid: true, context, isAdmin: true, studyId: input.studyId };
  } catch (err) {
    if (err instanceof ResearcherSetupRequiredError) {
      return {
        valid: false,
        context: null,
        isAdmin: true,
        error: 'Researcher onboarding is incomplete',
        statusCode: 401,
      };
    }
    logRequestFailure({ event: 'route.failure', route: 'researcher-context' }, err);
    return {
      valid: false,
      context: null,
      isAdmin: true,
      error: 'Researcher account storage is temporarily unavailable',
      statusCode: 503,
      retryable: true,
    };
  }
}

export async function resolveParticipantOrPreviewContext(
  request: Request,
  options: ParticipantContextOptions = {},
): Promise<ParticipantContextResult> {
  const initial = await getParticipantRequestContext(request, options);
  if (
    initial.valid
    && initial.isAdmin
    && (initial.needsStudySelection || !initial.context)
    && options.selectedStudyId
  ) {
    return getParticipantRequestContext(request, {
      purpose: 'preview',
      selectedStudyId: options.selectedStudyId,
    });
  }
  return initial;
}

export async function getParticipantRequestContext(
  request: Request,
  options: ParticipantContextOptions = {},
): Promise<ParticipantContextResult> {
  const auth = await verifyParticipantToken(request);

  if (!auth.valid) {
    return { valid: false, context: null, error: auth.error };
  }

  // Admin preview: platform owner+storage before any BYOS decrypt or provider work.
  if (auth.isAdmin) {
    if (isStandaloneMode()) {
      const admin = await getRequestContext();
      if (!admin.authorized || !admin.context) {
        return { valid: false, context: null, error: admin.error || 'Invalid researcher session', statusCode: 401 };
      }
      return {
        valid: true,
        context: admin.context,
        isAdmin: true,
        studyId: options.selectedStudyId ?? auth.studyId,
      };
    }

    const identity = await getHostedResearcherIdentity();
    if (!identity.authorized || !identity.researcherId) {
      return { valid: false, context: null, error: identity.error || 'Invalid researcher session', statusCode: 401 };
    }
    const studyId = auth.studyId || options.selectedStudyId;
    if (!studyId) {
      return {
        valid: true,
        context: null,
        isAdmin: true,
        needsStudySelection: true,
      };
    }
    return resolveHostedPreviewContext({
      researcherId: identity.researcherId,
      studyId,
    });
  }

  if (!auth.studyId) {
    return { valid: false, context: null, error: 'Participant link is missing its study.', statusCode: 401 };
  }

  if (!auth.linkId || !auth.sessionId) {
    return { valid: false, context: null, error: 'Participant session is missing link authority.', statusCode: 401 };
  }

  // Standalone mode: use env vars
  if (isStandaloneMode()) {
    const standaloneContext = getStandaloneContext();
    const link = await getParticipantLinkById(auth.linkId, standaloneContext.kvClient);
    if (link.status === 'unavailable') {
      return { valid: false, context: null, error: 'Unable to verify participant link.', statusCode: 503, retryable: true };
    }
    if (
      link.status !== 'found'
      || link.link.studyId !== auth.studyId
      || link.link.studyRevision !== auth.studyRevision
    ) {
      return { valid: false, context: null, error: 'Participant link is no longer active.', statusCode: 403 };
    }

    // Check if links are enabled for this study (fail closed on any doubt)
    try {
      const study = await getStudy(auth.studyId, standaloneContext.kvClient);
      if (!study) {
        return {
          valid: false,
          context: null,
          error: 'This study is no longer active.',
          statusCode: 403,
        };
      }
      const validatedStudy = validateStudyConfig(study.config);
      if (!validatedStudy.ok) {
        return {
          valid: false,
          context: null,
          error: 'This study must be reviewed and saved by the researcher before participant access can continue.',
          statusCode: 409,
        };
      }
      if (study.config.linksEnabled === false) {
        return {
          valid: false,
          context: null,
          error: 'Participant links have been disabled for this study.',
          statusCode: 403,
        };
      }
      if ((study.revision ?? 1) !== auth.studyRevision) {
        return { valid: false, context: null, error: 'This study link was replaced after the study changed.', statusCode: 409 };
      }
      return {
        valid: true,
        context: standaloneContext,
        studyId: auth.studyId,
        study: { ...study, config: validatedStudy.config },
        linkId: auth.linkId,
        participantSessionId: auth.sessionId,
        studyRevision: auth.studyRevision,
      };
    } catch (kvError) {
      logRequestFailure({ event: 'kv.unavailable' }, kvError);
      return {
        valid: false,
        context: null,
        error: 'Unable to verify study status. Please try again later.',
        statusCode: 503,
        retryable: true,
      };
    }
  }

  // Hosted mode: platform authority before link re-check, BYOS, cookies, or persist.
  try {
    const requestedPurpose = options.purpose ?? 'read';
    let persistRepairOnly = false;
    let gate = await getStudyAuthorityChecked({
      researcherId: auth.researcherId ?? '',
      studyId: auth.studyId,
      purpose: requestedPurpose,
    });
    if (gate.status === 'live' && requestedPurpose === 'new-persist') {
      const repair = await getStudyAuthorityChecked({
        researcherId: auth.researcherId ?? '',
        studyId: auth.studyId,
        purpose: 'persist-repair',
      });
      if (repair.status === 'allow') {
        gate = repair;
        persistRepairOnly = true;
      }
    }
    const presented = presentStudyAuthority(gate, 'participant');
    if (!presented.ok) {
      return deniedParticipantContext(presented);
    }

    const link = await getParticipantLinkById(auth.linkId);
    if (link.status === 'unavailable') {
      return { valid: false, context: null, error: 'Unable to verify participant link.', statusCode: 503, retryable: true };
    }
    if (
      link.status !== 'found'
      || link.link.studyId !== auth.studyId
      || link.link.studyRevision !== auth.studyRevision
      || link.link.researcherId !== auth.researcherId
    ) {
      return { valid: false, context: null, error: 'Participant link is no longer active.', statusCode: 403 };
    }

    const researcherId = presented.owner.researcherId;
    if (auth.researcherId && auth.researcherId !== researcherId) {
      return { valid: false, context: null, error: 'This study is no longer active.', statusCode: 404 };
    }

    const context = await resolveById(researcherId);

    // Check if links are enabled for this study (using researcher's own KV)
    if (auth.studyId) {
      try {
        const study = await getStudy(auth.studyId, context.kvClient);
        if (!study) {
          return {
            valid: false,
            context: null,
            error: 'This study is no longer active.',
            statusCode: 404,
          };
        }
        const validatedStudy = validateStudyConfig(study.config);
        if (!validatedStudy.ok) {
          return {
            valid: false,
            context: null,
            error: 'This study must be reviewed and saved by the researcher before participant access can continue.',
            statusCode: 409,
          };
        }
        if (study.config.linksEnabled === false) {
          return {
            valid: false,
            context: null,
            error: 'Participant links have been disabled for this study.',
            statusCode: 403,
          };
        }
        if ((study.revision ?? 1) !== auth.studyRevision) {
          return { valid: false, context: null, error: 'This study link was replaced after the study changed.', statusCode: 409 };
        }
        return {
          valid: true,
          context,
          studyId: auth.studyId,
          study: { ...study, config: validatedStudy.config },
          linkId: auth.linkId,
          participantSessionId: auth.sessionId,
          studyRevision: auth.studyRevision,
          persistRepairOnly,
        };
      } catch (kvError) {
        // Fail closed: if we can't verify link status, deny access
        logRequestFailure({ event: 'kv.unavailable' }, kvError);
        return {
          valid: false,
          context: null,
          error: 'Unable to verify study status. Please try again later.',
          statusCode: 503,
          retryable: true,
        };
      }
    }

    return { valid: false, context: null, error: 'Study context is missing.', statusCode: 403 };
  } catch (err) {
    logRequestFailure({ event: 'route.failure', route: 'participant-context' }, err);
    return { valid: false, context: null, error: 'Failed to resolve study context', statusCode: 503, retryable: true };
  }
}
