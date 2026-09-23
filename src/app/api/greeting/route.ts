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
import {
  loadCanonicalStudy,
  PARTICIPANT_INTERVIEW_HELD_COPY,
  participantContextRefusal,
  participantStoreAdmission,
  researcherPreviewHoldResponse,
} from '@/lib/canonicalStudy';
import { providerErrorResponse } from '@/lib/providerErrorResponse';
import { participantAdmissionRefusal } from '@/lib/rateLimit';
import { hostedAiRateLimitResponse } from '@/lib/platformAiRateLimit';
import { readBoundedJsonObject } from '@/lib/requestBody';
import { deploymentNotReadyResponse } from '@/lib/runtime/readinessGate';
import { StudyConfig } from '@/types';
import { createRequestId, logRequestFailure } from '@/lib/requestLog';

const ROUTE = '/api/greeting';

// Legacy clients still send the complete study config. It is not authoritative,
// but the cap must admit every valid 128 KiB study mutation plus its wrapper.
const GREETING_REQUEST_MAX_BYTES = 140_000;

export async function POST(request: Request) {
  // Cloudflare only (both null on Node): a not-ready deployment and a Workers
  // subrequest are refused before any storage, budget or provider use.
  const notReady = deploymentNotReadyResponse(ROUTE);
  if (notReady) return notReady;
  const subrequest = participantAdmissionRefusal('greeting');
  if (subrequest) return subrequest;
  try {
    const parsedBody = await readBoundedJsonObject(request, GREETING_REQUEST_MAX_BYTES);
    if (!parsedBody.ok) {
      return NextResponse.json(
        { error: parsedBody.status === 413 ? 'Greeting request is too large.' : 'Greeting request is malformed.' },
        { status: parsedBody.status }
      );
    }
    const body = parsedBody.value;

    const resolved = await resolveParticipantOrPreviewContext(request, {
      purpose: 'read',
      selectedStudyId: selectedStudyIdFromParticipantBody(body),
    });
    const { valid, context, studyId, isAdmin, linkId, participantSessionId } = resolved;
    if (!valid || !context) {
      return participantContextRefusal(resolved, {
        route: ROUTE,
        error: 'Valid participant token required',
        held: PARTICIPANT_INTERVIEW_HELD_COPY,
      });
    }

    // The body's studyConfig carries only a study id (admin preview); the
    // canonical saved study record is loaded server-side through the request's
    // workspace store and is the sole source of provider/model config.
    const canonical = await loadCanonicalStudy({
      store: context.store,
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
      const consent = await context.store.verifyConsent({
        participantSessionId,
        studyId: canonical.study.id,
        studyRevision: canonical.study.revision ?? 1,
        consentText: canonical.study.config.consentText || '',
        now: Date.now(),
      });
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

      // Check-all then charge-all through the workspace store. The durable
      // store refuses admission while frozen or in recovery (held 503).
      const limited = await participantStoreAdmission({
        request,
        route: ROUTE,
        studyId: canonical.study.id,
        operation: 'greeting',
        store: context.store,
        authority: { sessionId: participantSessionId, linkId, researcherId: context.researcherId },
      });
      if (limited) return limited;
    } else {
      const previewHeld = await researcherPreviewHoldResponse(context.store, ROUTE);
      if (previewHeld) return previewHeld;
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
