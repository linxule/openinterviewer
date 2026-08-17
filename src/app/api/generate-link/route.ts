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
import { getStudyChecked } from '@/lib/kv';
import { isHostedMode } from '@/lib/mode';
import { consumePlatformRateLimit } from '@/lib/platformDb';
import { asStudyAuthorityFromLink, createParticipantLinkRecord, getParticipantLinkByCode } from '@/lib/participantLinks';
import { getAppBaseUrl } from '@/lib/appBaseUrl';
import { missingProviderCredential } from '@/lib/providerAvailability';
import { validateStudyConfig } from '@/lib/studyConfigValidation';
import { resolveAITransport } from '@/lib/aiTransport';
import { createRequestId, logRequestFailure } from '@/lib/requestLog';

const STUDY_ID_PATTERN = /^[a-zA-Z0-9-]+$/;

const getExpirationTime = (option?: LinkExpirationOption): number | null => {
  switch (option) {
    case '7days': return Date.now() + 7 * 24 * 60 * 60 * 1000;
    case '30days': return Date.now() + 30 * 24 * 60 * 60 * 1000;
    case '90days': return Date.now() + 90 * 24 * 60 * 60 * 1000;
    case 'never': return null;
    default: return Date.now() + 30 * 24 * 60 * 60 * 1000;
  }
};

function publicBaseUrl(request: Request): string {
  if (process.env.APP_BASE_URL || process.env.NODE_ENV === 'production') return getAppBaseUrl();
  return new URL(request.url).origin;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { studyConfig } = body as { studyConfig?: Partial<StudyConfig> };

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
    const loaded = await getStudyChecked(studyId, gated.context.kvClient);
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

    const created = await createParticipantLinkRecord({
      studyId,
      studyRevision: mapped.study.revision ?? 1,
      researcherId: isHostedMode() ? (gated.researcherId ?? null) : null,
      expiresAt: getExpirationTime(savedConfig.linkExpiration),
      standaloneClient: gated.context.kvClient,
    });
    const createdAuthority = asStudyAuthorityFromLink(created);
    if (createdAuthority) {
      const presented = presentStudyAuthority(createdAuthority, 'researcher');
      if (!presented.ok) {
        return NextResponse.json(
          {
            error: presented.error,
            retryable: presented.retryable,
            ...(presented.code ? { code: presented.code } : {}),
            ...(presented.reason ? { reason: presented.reason } : {}),
          },
          { status: presented.statusCode },
        );
      }
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
  try {
    const { searchParams } = new URL(request.url);
    const code = searchParams.get('token');

    if (!code) {
      return NextResponse.json(
        { error: 'Missing token parameter' },
        { status: 400 }
      );
    }

    const loaded = await getParticipantLinkByCode(code);
    const exchangeAuthority = asStudyAuthorityFromLink(loaded);
    if (exchangeAuthority) {
      const presented = presentStudyAuthority(exchangeAuthority, 'participant');
      if (!presented.ok) {
        return NextResponse.json(
          { valid: false, error: presented.error, retryable: presented.retryable },
          { status: presented.statusCode },
        );
      }
    }
    if (loaded.status === 'unavailable') {
      return NextResponse.json({ valid: false, error: 'Unable to verify participant link.', retryable: true }, { status: 503 });
    }
    if (loaded.status !== 'found') {
      return NextResponse.json({ valid: false, error: 'This participant link is invalid, expired, or revoked.' }, { status: 403 });
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
    if (!live.valid) {
      return NextResponse.json(
        { valid: false, error: live.error || 'Participant link is no longer active', retryable: live.retryable },
        { status: live.statusCode ?? 403 }
      );
    }

    if (!live.study) {
      return NextResponse.json({ valid: false, error: 'Study is no longer active.' }, { status: 403 });
    }

    const response = NextResponse.json({
      valid: true,
      data: {
        studyConfig: live.study.config,
        sessionHandle,
        aiTransport: isHostedMode() ? 'direct' : resolveAITransport(),
      },
    });
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
      { status: 400 }
    );
  }
}
