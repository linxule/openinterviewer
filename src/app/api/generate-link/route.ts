// POST /api/generate-link - Generate an opaque participant share link.
// GET exchanges the one-time URL credential for a short-lived HttpOnly session.
// Requires admin authentication AND a canonically saved study: only the study id
// is accepted from legacy studyConfig input, and the record is fetched server-side.
// Participant access authority is re-checked server-side at request time.

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { StudyConfig, LinkExpirationOption } from '@/types';
import { getAuthorizedResearcherStudyContext, getParticipantRequestContext, presentStudyAuthority } from '@/lib/researcherContext';
import { mapStudyLoad } from '@/lib/ownedStudies';
import { configurationRequiredResponse, schemaHoldResponse } from '@/lib/researcherAccess';
import {
  createParticipantSessionToken,
  getParticipantSessionCookieOptions,
  getParticipantSessionCookieName,
  PARTICIPANT_SESSION_HEADER_NAME,
} from '@/lib/auth';
import { isHostedMode } from '@/lib/mode';
import { consumePlatformRateLimit } from '@/lib/platformDb';
import {
  asStudyAuthorityFromLink,
  createParticipantLinkRecord,
  getParticipantLinkByCode,
  type ParticipantLinkLoadResult,
} from '@/lib/participantLinks';
import { getAppBaseUrl } from '@/lib/appBaseUrl';
import { missingProviderCredential } from '@/lib/providerAvailability';
import { validateStudyConfig } from '@/lib/studyConfigValidation';
import { resolveAITransport } from '@/lib/aiTransport';
import { createRequestId, logRequestFailure } from '@/lib/requestLog';
import { readBoundedJsonObject } from '@/lib/requestBody';
import { getKVClient } from '@/lib/kvClient';
import { PARTICIPANT_EXCHANGE_HELD_COPY, researcherHeldCopy, workspaceHeldResponse } from '@/lib/canonicalStudy';
import { deploymentNotReadyResponse } from '@/lib/runtime/readinessGate';
import { isProductionStrict } from '@/lib/runtime/target';
import { resolveWorkspaceStore } from '@/lib/storage/resolve';
import type { LinkLoadOutcome, WorkspaceStorePort } from '@/lib/storage/types';

const STUDY_ID_PATTERN = /^[a-zA-Z0-9-]+$/;
const ROUTE = '/api/generate-link';

// Legacy researcher clients (StudyDetail) still post the complete saved study
// config although only its id is read. The cap admits every valid 128 KiB
// study config plus its wrapper, the same bound as the greeting route.
const GENERATE_LINK_REQUEST_MAX_BYTES = 140_000;

const DAY_MS = 24 * 60 * 60 * 1000;

const getExpirationTime = (option: LinkExpirationOption | undefined, now: number): number | null => {
  switch (option) {
    case '7days': return now + 7 * DAY_MS;
    case '30days': return now + 30 * DAY_MS;
    case '90days': return now + 90 * DAY_MS;
    case 'never': return null;
    default: return now + 30 * DAY_MS;
  }
};

// The participant URL origin is the configured APP_BASE_URL wherever the
// deployment is production-strict (Node production, every Cloudflare Worker);
// the request host is used only for local development.
function publicBaseUrl(request: Request): string {
  if (process.env.APP_BASE_URL || isProductionStrict()) return getAppBaseUrl();
  return new URL(request.url).origin;
}

// Link results that carry a study-authority denial (hosted platform gate) or a
// storage failure use the shared authority presenter, exactly as before the
// workspace store existed; other store outcomes fall through.
function linkAuthorityDenialResponse(
  result: { status: string; phase?: 'reserving' | 'pending' | 'resolving' | 'publishing' },
  audience: 'researcher' | 'participant',
  extra: Record<string, unknown> = {},
  headers?: HeadersInit,
): NextResponse | null {
  const authority = asStudyAuthorityFromLink(result);
  if (!authority) return null;
  const presented = presentStudyAuthority(authority, audience);
  if (presented.ok) return null;
  const researcherDetail = audience === 'researcher'
    ? {
      ...(presented.code ? { code: presented.code } : {}),
      ...(presented.reason ? { reason: presented.reason } : {}),
    }
    : {};
  return NextResponse.json(
    { ...extra, error: presented.error, retryable: presented.retryable, ...researcherDetail },
    { status: presented.statusCode, headers },
  );
}

// Participant exchange responses set (or refuse) a session cookie: never cache.
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

// Standalone link exchange resolves the opaque code through the workspace
// store (Redis on Node, the durable workspace on Cloudflare). Hosted links
// keep their platform-gated exchange. A store that cannot be constructed is
// the same retryable storage failure the Redis read reported before.
async function exchangeLink(code: string): Promise<ParticipantLinkLoadResult | LinkLoadOutcome> {
  if (isHostedMode()) return getParticipantLinkByCode(code);
  let store: WorkspaceStorePort;
  try {
    store = resolveWorkspaceStore({ redisClient: () => getKVClient(), researcherId: null });
  } catch (error) {
    logRequestFailure({ event: 'workspace.store', route: ROUTE, method: 'GET', reason: 'unavailable' }, error);
    return { status: 'unavailable' };
  }
  return store.resolveParticipantLinkByCode({ code, now: Date.now(), purpose: 'exchange' });
}

export async function POST(request: Request) {
  const notReady = deploymentNotReadyResponse(ROUTE);
  if (notReady) return notReady;
  try {
    const parsedBody = await readBoundedJsonObject(request, GENERATE_LINK_REQUEST_MAX_BYTES);
    if (!parsedBody.ok) {
      return NextResponse.json(
        { error: parsedBody.status === 413 ? 'Request body is too large' : 'Invalid request body' },
        { status: parsedBody.status }
      );
    }
    const { studyConfig } = parsedBody.value as { studyConfig?: Partial<StudyConfig> };

    // Accept only the study id from legacy studyConfig input
    const studyId = typeof studyConfig?.id === 'string' ? studyConfig.id : '';
    if (!studyId || !STUDY_ID_PATTERN.test(studyId)) {
      return NextResponse.json(
        { error: 'Missing or invalid study ID' },
        { status: 400 }
      );
    }

    const gated = await getAuthorizedResearcherStudyContext(studyId, 'link');
    const denied = configurationRequiredResponse(gated);
    if (denied) return denied;
    if (!gated.authorized || !gated.context) {
      return NextResponse.json(
        {
          error: gated.error || 'Unauthorized',
          retryable: gated.retryable,
          ...(gated.code ? { code: gated.code } : {}),
          ...(gated.reason ? { reason: gated.reason } : {}),
        },
        { status: gated.statusCode ?? 401 },
      );
    }

    // Mint links only for canonically saved studies
    const loaded = await gated.context.store.getStudy(studyId);
    const mapped = mapStudyLoad(
      loaded,
      'Study not found. Save the study before generating a participant link.',
    );
    if (!mapped.ok) return NextResponse.json(mapped.body, { status: mapped.status });

    const validatedStudy = validateStudyConfig(mapped.study.config);
    if (!validatedStudy.ok) {
      return NextResponse.json({
        error: 'Review and save this study with an explicit AI provider and model before creating participant links.',
        code: 'STUDY_REQUIRES_RESAVE',
      }, { status: 409 });
    }
    const savedConfig = validatedStudy.config;
    if (savedConfig.linksEnabled === false) {
      return NextResponse.json(
        { error: 'Participant links are disabled for this study.' },
        { status: 409 }
      );
    }

    let missingProvider;
    try {
      missingProvider = missingProviderCredential(gated.context, savedConfig);
    } catch {
      return NextResponse.json({ error: 'The selected AI provider is invalid.' }, { status: 400 });
    }
    if (missingProvider) {
      return NextResponse.json({
        error: 'Connect a key for the selected AI provider before creating a participant link.',
        code: 'PROVIDER_NOT_CONFIGURED',
        provider: missingProvider,
      }, { status: 409 });
    }

    if (isHostedMode()) {
      if (!gated.researcherId) {
        return NextResponse.json({ error: 'Researcher identity is required.' }, { status: 401 });
      }
      const rateLimit = await consumePlatformRateLimit(
        'participant-link-create',
        gated.researcherId,
        200,
        3_600
      );
      if (rateLimit.status === 'hold') return schemaHoldResponse();
      if (rateLimit.status === 'unavailable') {
        return NextResponse.json({ error: 'Participant link service is unavailable.' }, { status: 503 });
      }
      if (rateLimit.status === 'limited') {
        return NextResponse.json(
          { error: 'Too many participant links created. Try again later.' },
          { status: 429, headers: { 'Retry-After': String(rateLimit.retryAfterSeconds) } }
        );
      }
    }

    const now = Date.now();
    const studyRevision = mapped.study.revision ?? 1;
    const expiresAt = getExpirationTime(savedConfig.linkExpiration, now);
    // Hosted links live in the platform database behind its authority gate
    // (unchanged saga path). Standalone links go through the workspace store,
    // which on the durable backend re-checks the study, its revision and link
    // status at the write.
    const created = isHostedMode()
      ? await createParticipantLinkRecord({
        studyId,
        studyRevision,
        researcherId: gated.researcherId ?? null,
        expiresAt,
        standaloneClient: gated.context.kvClient,
      })
      : await gated.context.store.createParticipantLink({ studyId, studyRevision, expiresAt, now });
    const linkDenied = linkAuthorityDenialResponse(created, 'researcher');
    if (linkDenied) return linkDenied;
    if (created.status === 'held') {
      return workspaceHeldResponse({
        route: ROUTE,
        reason: created.reason,
        ...researcherHeldCopy('Participant links cannot be created'),
      });
    }
    if (created.status === 'study-not-found') {
      return NextResponse.json(
        { error: 'Study not found. Save the study before generating a participant link.' },
        { status: 404 }
      );
    }
    if (created.status === 'links-disabled') {
      return NextResponse.json(
        { error: 'Participant links are disabled for this study.' },
        { status: 409 }
      );
    }
    if (created.status === 'revision-stale') {
      return NextResponse.json(
        { error: 'This study changed while the link was being created. Reload the study and try again.' },
        { status: 409 }
      );
    }
    if (created.status === 'quota-exceeded') {
      return NextResponse.json(
        { error: 'Participant link quota reached. Reuse existing links or wait for expired links to be pruned.' },
        { status: 409 }
      );
    }
    if (created.status !== 'created') {
      return NextResponse.json({ error: 'Unable to create participant link.', retryable: true }, { status: 503 });
    }

    const participantUrl = `${publicBaseUrl(request)}/p/${created.code}`;

    return NextResponse.json({
      token: created.code,
      url: participantUrl
    });
  } catch (error) {
    logRequestFailure({
      event: 'route.failure',
      route: '/api/generate-link',
      method: 'POST',
      status: 500,
      requestId: createRequestId(request.headers.get('x-request-id')),
    }, error);
    return NextResponse.json(
      { error: 'Failed to generate participant link' },
      { status: 500 }
    );
  }
}

// GET /api/generate-link?token=xxx - Exchange an opaque share code for the
// participant's short-lived HttpOnly session. The historical query name is
// retained for link compatibility; the value is not a JWT or browser bearer.
// Strips sensitive fields (researcherId) from response
export async function GET(request: Request) {
  const notReady = deploymentNotReadyResponse(ROUTE);
  if (notReady) return notReady;
  try {
    const { searchParams } = new URL(request.url);
    const code = searchParams.get('token');

    if (!code) {
      return NextResponse.json(
        { error: 'Missing token parameter' },
        { status: 400, headers: NO_STORE }
      );
    }

    const loaded = await exchangeLink(code);
    const linkDenied = linkAuthorityDenialResponse(loaded, 'participant', { valid: false }, NO_STORE);
    if (linkDenied) return linkDenied;
    // A draining, frozen or recovering workspace starts no new collection
    // (OPS-01); other holds need operator action.
    if (loaded.status === 'held') {
      return workspaceHeldResponse({
        route: ROUTE,
        reason: loaded.reason,
        ...PARTICIPANT_EXCHANGE_HELD_COPY,
        body: { valid: false },
      });
    }
    if (loaded.status === 'unavailable') {
      return NextResponse.json(
        { valid: false, error: 'Unable to verify participant link.', retryable: true },
        { status: 503, headers: NO_STORE },
      );
    }
    if (loaded.status !== 'found') {
      return NextResponse.json(
        { valid: false, error: 'This participant link is invalid, expired, or revoked.' },
        { status: 403, headers: NO_STORE },
      );
    }

    const sessionHandle = crypto.randomUUID();
    const sessionToken = await createParticipantSessionToken(loaded.link, sessionHandle);
    const sessionCookieName = getParticipantSessionCookieName(sessionHandle);
    const liveRequest = new Request(request.url, {
      headers: {
        Cookie: `${sessionCookieName}=${sessionToken}`,
        [PARTICIPANT_SESSION_HEADER_NAME]: sessionHandle,
      },
    });
    const live = await getParticipantRequestContext(liveRequest);
    // A hold that began after the exchange refuses like the exchange's own.
    if (live.holdReason !== undefined) {
      return workspaceHeldResponse({
        route: ROUTE,
        reason: live.holdReason,
        ...PARTICIPANT_EXCHANGE_HELD_COPY,
        body: { valid: false },
      });
    }
    if (!live.valid) {
      return NextResponse.json(
        { valid: false, error: live.error || 'Participant link is no longer active', retryable: live.retryable },
        { status: live.statusCode ?? 403, headers: NO_STORE }
      );
    }

    if (!live.study) {
      return NextResponse.json({ valid: false, error: 'Study is no longer active.' }, { status: 403, headers: NO_STORE });
    }

    // Prompts are built server-side from the canonical study; the researcher's
    // instructions to the interviewer never need to reach the participant's browser.
    const { interviewerInstructions: _interviewerInstructions, ...participantStudyConfig } = live.study.config;
    const response = NextResponse.json({
      valid: true,
      data: {
        studyConfig: participantStudyConfig,
        sessionHandle,
        aiTransport: isHostedMode() ? 'direct' : resolveAITransport(),
      },
    }, { headers: NO_STORE });
    const remainingSeconds = loaded.link.expiresAt
      ? Math.min(4 * 60 * 60, Math.max(1, Math.floor((loaded.link.expiresAt - Date.now()) / 1000)))
      : undefined;
    response.cookies.set(
      sessionCookieName,
      sessionToken,
      getParticipantSessionCookieOptions(remainingSeconds)
    );
    return response;
  } catch (error) {
    logRequestFailure({
      event: 'route.failure',
      route: '/api/generate-link',
      method: 'GET',
      status: 400,
      requestId: createRequestId(request.headers.get('x-request-id')),
    }, error);
    return NextResponse.json(
      { valid: false, error: 'Invalid or expired token' },
      { status: 400, headers: NO_STORE }
    );
  }
}
