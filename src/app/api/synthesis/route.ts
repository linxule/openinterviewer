// POST /api/synthesis - Synthesize interview patterns
// Server-side only - API keys never sent to client
// Requires valid participant token to prevent quota abuse
// Provider/model/prompts always come from the canonical saved study loaded
// server-side; request bodies are never authoritative.

import { NextResponse } from 'next/server';
import {
  getInterviewProvider,
} from '@/lib/providers';
import {
  providerKeysFromContext,
  resolveParticipantOrPreviewContext,
  selectedStudyIdFromParticipantBody,
} from '@/lib/researcherContext';
import { loadCanonicalStudy } from '@/lib/canonicalStudy';
import { providerErrorResponse } from '@/lib/providerErrors';
import { participantRateLimitResponse } from '@/lib/rateLimit';
import { hostedAiRateLimitResponse } from '@/lib/platformAiRateLimit';
import { validateBehavior, validateProfile, validateTranscript } from '@/lib/interviewSubmission';
import { createSynthesisReceipt } from '@/lib/synthesisReceipt';
import { verifyParticipantConsent } from '@/lib/participantConsent';
import { readBoundedJsonObject } from '@/lib/requestBody';
import {
  StudyConfig,
  ParticipantProfile,
  InterviewMessage,
  BehaviorData
} from '@/types';
import { createRequestId, logRequestFailure } from '@/lib/requestLog';

export async function POST(request: Request) {
  try {
    const parsedBody = await readBoundedJsonObject(request, 600_000);
    if (!parsedBody.ok) {
      return NextResponse.json(
        { error: parsedBody.status === 413 ? 'Synthesis request is too large.' : 'Synthesis request is malformed.' },
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
    let {
      history,
      behaviorData,
      participantProfile
    } = body as {
      history: InterviewMessage[];
      studyConfig?: StudyConfig; // Legacy display payload — never authoritative
      behaviorData: BehaviorData;
      participantProfile: ParticipantProfile | null;
    };

    // Validate required fields
    if (!history || !behaviorData) {
      return NextResponse.json(
        { error: 'Missing required fields: history, behaviorData' },
        { status: 400 }
      );
    }

    try {
      history = validateTranscript(history);
      behaviorData = validateBehavior(behaviorData);
      participantProfile = validateProfile(participantProfile);
    } catch {
      return NextResponse.json({ error: 'Interview data is malformed or exceeds allowed limits.' }, { status: 400 });
    }

    // Canonical study authority: the token's studyId wins; the body may carry
    // only a study id for authenticated admin previews.
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
          { error: 'Participant consent is required before interview analysis.', code: 'CONSENT_REQUIRED' },
          { status: 428 }
        );
      }

      const limited = await participantRateLimitResponse(
        request,
        canonical.study.id,
        'synthesis',
        context.kvClient,
        { sessionId: participantSessionId, linkId, researcherId: context.researcherId }
      );
      if (limited) return limited;
    }

    const platformLimited = await hostedAiRateLimitResponse(
      request,
      'synthesis',
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
      const result = await provider.synthesizeInterview(
        history,
        canonical.study.config,
        behaviorData,
        participantProfile
      );
      const receipt = await createSynthesisReceipt({
        studyId: canonical.study.id,
        studyRevision: canonical.study.revision ?? 1,
        participantSessionId: isAdmin ? 'admin-preview' : participantSessionId!,
        aiProvider: result.execution.provider,
        requestedAiModel: result.execution.requestedModel,
        aiModel: result.execution.model,
        routedProvider: result.execution.routedProvider,
        transcript: history,
        participantProfile,
        behaviorData,
        synthesis: result.value,
      });
      return NextResponse.json({ ...result.value, _receipt: receipt });
    } catch (providerError) {
      return providerErrorResponse(providerError);
    }
  } catch (error) {
    logRequestFailure({
      event: 'route.failure',
      route: '/api/synthesis',
      method: 'POST',
      status: 500,
      requestId: createRequestId(request.headers.get('x-request-id')),
    }, error);
    return NextResponse.json(
      { error: 'Failed to synthesize interview' },
      { status: 500 }
    );
  }
}
