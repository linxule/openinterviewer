// POST /api/generate-link - Generate an opaque participant share link.
// GET exchanges the one-time URL credential for a short-lived HttpOnly session.
// Requires admin authentication AND a canonically saved study: only the study id
// is accepted from legacy studyConfig input, and the record is fetched server-side.
// Participant access authority is re-checked server-side at request time.

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { StudyConfig, LinkExpirationOption } from '@/types';
import { getParticipantRequestContext, getRequestContext } from '@/lib/researcherContext';
import { configurationRequiredResponse } from '@/lib/researcherAccess';
import {
  createParticipantSessionToken,
  getParticipantSessionCookieOptions,
  getParticipantSessionCookieName,
  PARTICIPANT_SESSION_HEADER_NAME,
} from '@/lib/auth';
import { getStudyChecked } from '@/lib/kv';
import { isHostedMode } from '@/lib/mode';
import { consumePlatformRateLimit, getStudyOwnerChecked } from '@/lib/platformDb';
import { createParticipantLinkRecord, getParticipantLinkByCode } from '@/lib/participantLinks';
import { getAppBaseUrl } from '@/lib/appBaseUrl';

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
    const access = await getRequestContext();
    const setupResponse = configurationRequiredResponse(access);
    if (setupResponse) return setupResponse;
    const { authorized, context, researcherId, error } = access;
    if (!authorized || !context) {
      return NextResponse.json(
        { error: error || 'Admin authentication required to generate participant links' },
        { status: 401 }
      );
    }

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

    // Mint links only for canonically saved studies
    const loaded = await getStudyChecked(studyId, context.kvClient);
    if (loaded.status === 'unavailable') {
      return NextResponse.json(
        { error: 'Study storage is temporarily unavailable. Please try again.', retryable: true },
        { status: 503 }
      );
    }
    if (loaded.status === 'not-found') {
      return NextResponse.json(
        { error: 'Study not found. Save the study before generating a participant link.' },
        { status: 404 }
      );
    }

    const savedConfig = loaded.study.config;
    if (savedConfig.linksEnabled === false) {
      return NextResponse.json(
        { error: 'Participant links are disabled for this study.' },
        { status: 409 }
      );
    }

    if (isHostedMode()) {
      if (!researcherId) {
        return NextResponse.json({ error: 'Researcher identity is required.' }, { status: 401 });
      }
      const rateLimit = await consumePlatformRateLimit(
        'participant-link-create',
        researcherId,
        200,
        3_600
      );
      if (rateLimit.status === 'unavailable') {
        return NextResponse.json({ error: 'Participant link service is unavailable.' }, { status: 503 });
      }
      if (rateLimit.status === 'limited') {
        return NextResponse.json(
          { error: 'Too many participant links created. Try again later.' },
          { status: 429, headers: { 'Retry-After': String(rateLimit.retryAfterSeconds) } }
        );
      }
      const owner = await getStudyOwnerChecked(studyId);
      if (owner.status === 'unavailable') {
        return NextResponse.json({ error: 'Unable to verify study ownership.', retryable: true }, { status: 503 });
      }
      if (owner.status !== 'found' || owner.researcherId !== researcherId) {
        return NextResponse.json({ error: 'Study ownership is not registered for this researcher.' }, { status: 409 });
      }
    }

    const created = await createParticipantLinkRecord({
      studyId,
      studyRevision: loaded.study.revision ?? 1,
      researcherId: isHostedMode() ? (researcherId ?? null) : null,
      expiresAt: getExpirationTime(savedConfig.linkExpiration),
      standaloneClient: context.kvClient,
    });
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
    console.error('Generate link API error:', error);
    return NextResponse.json(
      { error: 'Failed to generate participant link' },
      { status: 500 }
    );
  }
}

// GET /api/generate-link?token=xxx - Verify and decode a token
// Used by participant page to validate token before starting interview
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
      data: { studyConfig: live.study.config, sessionHandle },
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
    console.error('Participant link exchange error:', error);
    return NextResponse.json(
      { valid: false, error: 'Invalid or expired token' },
      { status: 400 }
    );
  }
}
