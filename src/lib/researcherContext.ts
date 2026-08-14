// Researcher Context Resolution
// Central abstraction for resolving per-request credentials in both deployment modes
// Every API route calls one of these to get the appropriate KV client and API keys

import { Redis } from '@upstash/redis';
import { cookies } from 'next/headers';
import { isStandaloneMode, isHostedMode } from './mode';
import { getKVClient, getResearcherClient } from './kvClient';
import { getResearcherByIdChecked, getStudyOwnerChecked } from './platformDb';
import { decrypt } from './crypto';
import { verifySessionToken, verifyParticipantToken, SESSION_COOKIE_NAME } from './auth';
import { getStudy } from './kv';
import { getParticipantLinkById } from './participantLinks';
import { StoredStudy } from '@/types';

export interface ResearcherContext {
  // Identity (null in standalone mode)
  researcherId: string | null;

  // Storage client (researcher's own Redis in hosted, env-var Redis in standalone)
  kvClient: Redis;

  // AI API keys
  geminiApiKey: string | null;
  anthropicApiKey: string | null;

  // Whether the researcher has completed onboarding
  onboardingComplete: boolean;
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
  const kvClient = getResearcherClient(configuredRedisUrl, configuredRedisToken);

  return {
    researcherId,
    kvClient,
    geminiApiKey: researcher.encryptedGeminiApiKey
      ? decrypt(researcher.encryptedGeminiApiKey, { researcherId, purpose: 'gemini-api-key' })
      : null,
    anthropicApiKey: researcher.encryptedAnthropicApiKey
      ? decrypt(researcher.encryptedAnthropicApiKey, { researcherId, purpose: 'anthropic-api-key' })
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
    console.error('Failed to resolve researcher context:', err);
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
}

export async function getParticipantRequestContext(
  request: Request
): Promise<ParticipantContextResult> {
  const auth = await verifyParticipantToken(request);

  if (!auth.valid) {
    return { valid: false, context: null, error: auth.error };
  }

  // Admin preview: use their own session context
  if (auth.isAdmin) {
    const admin = await getRequestContext();
    if (!admin.authorized || !admin.context) {
      return { valid: false, context: null, error: admin.error || 'Invalid researcher session', statusCode: 401 };
    }
    return { valid: true, context: admin.context, isAdmin: true };
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
        study,
        linkId: auth.linkId,
        participantSessionId: auth.sessionId,
        studyRevision: auth.studyRevision,
      };
    } catch (kvError) {
      console.error('Failed to check link status for study:', auth.studyId, kvError);
      return {
        valid: false,
        context: null,
        error: 'Unable to verify study status. Please try again later.',
        statusCode: 503,
        retryable: true,
      };
    }
  }

  // Hosted mode: resolve researcher from token or study ownership
  try {
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

    // Platform ownership is authoritative. A token claim is only a routing hint
    // and must match the current owner record.
    const ownership = await getStudyOwnerChecked(auth.studyId);
    if (ownership.status === 'unavailable') {
      return { valid: false, context: null, error: 'Unable to verify study ownership.', statusCode: 503, retryable: true };
    }
    const researcherId = ownership.status === 'found' ? ownership.researcherId : undefined;

    if (!researcherId) {
      return { valid: false, context: null, error: 'Study owner not found', statusCode: 403 };
    }
    if (auth.researcherId && auth.researcherId !== researcherId) {
      return { valid: false, context: null, error: 'Participant link does not match the study owner', statusCode: 403 };
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
            statusCode: 403,
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
          study,
          linkId: auth.linkId,
          participantSessionId: auth.sessionId,
          studyRevision: auth.studyRevision,
        };
      } catch (kvError) {
        // Fail closed: if we can't verify link status, deny access
        console.error('Failed to check link status for study:', auth.studyId, kvError);
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
    console.error('Failed to resolve participant context:', err);
    return { valid: false, context: null, error: 'Failed to resolve study context', statusCode: 503, retryable: true };
  }
}
