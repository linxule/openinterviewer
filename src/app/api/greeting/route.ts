// POST /api/greeting - Get interview greeting
// Server-side only - API keys never sent to client
// Requires valid participant token to prevent quota abuse
// Provider/model/prompts always come from the canonical saved study loaded
// server-side; request bodies are never authoritative.

import { NextResponse } from 'next/server';
import { getInterviewProvider } from '@/lib/providers';
import {
  providerKeysFromContext,
  resolveParticipantOrPreviewContext,
  selectedStudyIdFromParticipantBody,
} from '@/lib/researcherContext';
import { loadCanonicalStudy } from '@/lib/canonicalStudy';
import { providerErrorResponse } from '@/lib/providerErrors';
import { participantRateLimitResponse } from '@/lib/rateLimit';
import { hostedAiRateLimitResponse } from '@/lib/platformAiRateLimit';
import { verifyParticipantConsent } from '@/lib/participantConsent';
import { readBoundedJsonObject } from '@/lib/requestBody';
import { StudyConfig } from '@/types';
import { createRequestId, logRequestFailure } from '@/lib/requestLog';

// Legacy clients still send the complete study config. It is not authoritative,
// but the cap must admit every valid 128 KiB study mutation plus its wrapper.
const GREETING_REQUEST_MAX_BYTES = 140_000;

export async function POST(request: Request) {
  try {
    const parsedBody = await readBoundedJsonObject(request, GREETING_REQUEST_MAX_BYTES);
    if (!parsedBody.ok) {
      return NextResponse.json(
        { error: parsedBody.status === 413 ? 'Greeting request is too large.' : 'Greeting request is malformed.' },
        { status: parsedBody.status }
      );
    }
    const body = parsedBody.value;

    const { valid, context, studyId, isAdmin, error, statusCode, linkId, participantSessionId } =
      await resolveParticipantOrPreviewContext(request, {
        purpose: 'read',
        selectedStudyId: selectedStudyIdFromParticipantBody(body),
      });
    if (!valid || !context) {
      return NextResponse.json(
        { error: error || 'Valid participant token required' },
        { status: statusCode ?? 401 }
      );
    }

    // The body's studyConfig carries only a study id (admin preview); the
    // canonical saved study record is loaded server-side through the request's
    // researcher KV context and is the sole source of provider/model config.
    const canonical = await loadCanonicalStudy({
      kvClient: context.kvClient,
      tokenStudyId: studyId,
      legacyBodyStudyId: (body as { studyConfig?: StudyConfig }).studyConfig?.id,
      isAdmin,
    });
    if (!canonical.ok) {
      return canonical.response;
    }

    if (!isAdmin) {
      if (!participantSessionId) {
        return NextResponse.json({ error: 'Participant session authority is incomplete.' }, { status: 401 });
      }
      const consent = await verifyParticipantConsent(
        {
          participantSessionId,
          studyId: canonical.study.id,
          studyRevision: canonical.study.revision ?? 1,
          consentText: canonical.study.config.consentText || '',
        },
        context.kvClient
      );
      if (consent.status === 'unavailable') {
        return NextResponse.json(
          { error: 'Unable to verify participant consent. Please try again.', retryable: true },
          { status: 503 }
        );
      }
      if (consent.status !== 'accepted') {
        return NextResponse.json(
          { error: 'Participant consent must be accepted before the interview begins.', code: 'CONSENT_REQUIRED' },
          { status: 428 }
        );
      }

      const limited = await participantRateLimitResponse(
        request,
        canonical.study.id,
        'greeting',
        context.kvClient,
        { sessionId: participantSessionId, linkId, researcherId: context.researcherId }
      );
      if (limited) return limited;
    }

    const platformLimited = await hostedAiRateLimitResponse(
      request,
      'greeting',
      {
        researcherId: context.researcherId,
        participantSessionId: isAdmin ? undefined : participantSessionId,
      }
    );
    if (platformLimited) return platformLimited;

    let provider;
    try {
      provider = getInterviewProvider(canonical.study.config, providerKeysFromContext(context));
    } catch {
      return NextResponse.json(
        { error: 'AI provider is not configured on the server.' },
        { status: 502 }
      );
    }

    try {
      const greeting = await provider.getInterviewGreeting(canonical.study.config);
      return NextResponse.json({ greeting });
    } catch (providerError) {
      return providerErrorResponse(providerError);
    }
  } catch (error) {
    logRequestFailure({
      event: 'route.failure',
      route: '/api/greeting',
      method: 'POST',
      status: 500,
      requestId: createRequestId(request.headers.get('x-request-id')),
    }, error);
    return NextResponse.json(
      { error: 'Failed to generate greeting' },
      { status: 500 }
    );
  }
}
