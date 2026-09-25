// POST /api/interview - Generate AI interview response
// Server-side only - API keys never sent to client
// Requires valid participant token to prevent quota abuse
// Provider/model/prompts always come from the canonical saved study loaded
// server-side; request bodies carry only conversation/progress payloads.

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
import { researcherAiBudgetResponse } from '@/lib/researcherAiBudget';
import { validateProfile, validateTranscript } from '@/lib/interviewSubmission';
import { readBoundedJsonObject } from '@/lib/requestBody';
import { deploymentNotReadyResponse } from '@/lib/runtime/readinessGate';
import { covers } from '@/lib/providers/endpoint';
import {
  currentProviderTransport,
  providerNotConfiguredResponse,
  transportNotDisclosedResponse,
} from '@/lib/transportDisclosure';
import {
  StudyConfig,
  ParticipantProfile,
  InterviewMessage,
  QuestionProgress
} from '@/types';
import { createRequestId, logRequestFailure } from '@/lib/requestLog';

const ROUTE = '/api/interview';

// Payload size limits to prevent abuse
const MAX_HISTORY_MESSAGES = 100;
const MAX_CONTEXT_LENGTH = 10000;

export async function POST(request: Request) {
  // Cloudflare only (both null on Node): a not-ready deployment and a Workers
  // subrequest are refused before any storage, budget or provider use.
  const notReady = deploymentNotReadyResponse(ROUTE);
  if (notReady) return notReady;
  const subrequest = participantAdmissionRefusal('interview');
  if (subrequest) return subrequest;
  try {
    const parsedBody = await readBoundedJsonObject(request, 600_000);
    if (!parsedBody.ok) {
      return NextResponse.json(
        { error: parsedBody.status === 413 ? 'Interview request is too large.' : 'Interview request is malformed.' },
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
    let {
      history,
      participantProfile,
      questionProgress,
      currentContext
    } = body as {
      history: InterviewMessage[];
      studyConfig?: StudyConfig; // Legacy display payload — never authoritative
      participantProfile: ParticipantProfile | null;
      questionProgress: QuestionProgress;
      currentContext: string;
    };

    // Validate required fields
    if (!history || !questionProgress) {
      return NextResponse.json(
        { error: 'Missing required fields: history, questionProgress' },
        { status: 400 }
      );
    }

    try {
      history = validateTranscript(history).slice(-MAX_HISTORY_MESSAGES);
      participantProfile = validateProfile(participantProfile);
      if (typeof currentContext !== 'string' || currentContext.length > MAX_CONTEXT_LENGTH) {
        throw new Error('invalid context');
      }
      if (
        !questionProgress
        || !Array.isArray(questionProgress.questionsAsked)
        || questionProgress.questionsAsked.length > 200
        || !questionProgress.questionsAsked.every(index => Number.isInteger(index) && index >= 0)
        || typeof questionProgress.total !== 'number'
        || typeof questionProgress.isComplete !== 'boolean'
      ) {
        throw new Error('invalid progress');
      }
    } catch {
      return NextResponse.json({ error: 'Interview request is malformed or exceeds allowed limits.' }, { status: 400 });
    }

    // Canonical study authority: the token's studyId wins; the body may carry
    // only a study id for authenticated admin previews.
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
          { error: 'Participant consent is required before continuing the interview.', code: 'CONSENT_REQUIRED' },
          { status: 428 }
        );
      }

      // Cloudflare (D9): participant content goes only by a transport the
      // consent covers. Refused before admission, so no budget is consumed
      // and no adapter is constructed.
      const current = currentProviderTransport(context, canonical.study.config.aiProvider);
      if (current.applies) {
        if (!current.ok) return providerNotConfiguredResponse();
        if (!covers(consent.consent.disclosedTransport ?? 'direct', current.transport)) {
          return transportNotDisclosedResponse();
        }
      }

      // Check-all then charge-all through the workspace store. The durable
      // store refuses admission while frozen or in recovery (held 503).
      const limited = await participantStoreAdmission({
        request,
        route: ROUTE,
        studyId: canonical.study.id,
        operation: 'interview',
        store: context.store,
        authority: { sessionId: participantSessionId, linkId, researcherId: context.researcherId },
      });
      if (limited) return limited;
    } else {
      const previewHeld = await researcherPreviewHoldResponse(context.store, ROUTE);
      if (previewHeld) return previewHeld;
      const budgetLimited = await researcherAiBudgetResponse(request, 'interview', context.store, ROUTE);
      if (budgetLimited) return budgetLimited;
    }

    const platformLimited = await hostedAiRateLimitResponse(
      request,
      'interview',
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
      const result = await provider.generateInterviewResponse(
        history,
        canonical.study.config,
        participantProfile,
        questionProgress,
        currentContext
      );
      return NextResponse.json(result);
    } catch (providerError) {
      return providerErrorResponse(providerError);
    }
  } catch (error) {
    logRequestFailure({
      event: 'route.failure',
      route: '/api/interview',
      method: 'POST',
      status: 500,
      requestId: createRequestId(request.headers.get('x-request-id')),
    }, error);
    return NextResponse.json(
      { error: 'Failed to generate interview response' },
      { status: 500 }
    );
  }
}
