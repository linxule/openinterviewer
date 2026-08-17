// POST /api/synthesis/aggregate - Generate aggregate synthesis across interviews
// Server-side only - requires authenticated session
// Analyzes all interviews for a study to find cross-participant patterns

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import {
  getInterviewProvider,
} from '@/lib/providers';
import { getAuthorizedResearcherStudyContext, providerKeysFromContext } from '@/lib/researcherContext';
import { configurationRequiredResponse } from '@/lib/researcherAccess';
import { getStudyChecked, getStudyInterviewsChecked } from '@/lib/kv';
import { mapCollectionLoad, mapStudyLoad } from '@/lib/ownedStudies';
import { providerErrorResponse } from '@/lib/providerErrors';
import { createAggregateSynthesisReceipt } from '@/lib/synthesisReceipt';
import { hostedAiRateLimitResponse } from '@/lib/platformAiRateLimit';
import { AggregateSynthesisResult, SynthesisResult } from '@/types';
import { readBoundedJsonObject } from '@/lib/requestBody';
import { createRequestId, logRequestFailure } from '@/lib/requestLog';

export async function POST(request: Request) {
  try {
    const parsedBody = await readBoundedJsonObject(request, 4_096);
    if (!parsedBody.ok) {
      return NextResponse.json(
        { error: parsedBody.status === 413 ? 'Aggregate request is too large.' : 'Invalid aggregate request.' },
        { status: parsedBody.status }
      );
    }
    const studyId = typeof parsedBody.value.studyId === 'string'
      ? parsedBody.value.studyId
      : '';

    if (!studyId) {
      return NextResponse.json(
        { error: 'Missing required field: studyId' },
        { status: 400 }
      );
    }

    const gated = await getAuthorizedResearcherStudyContext(studyId, 'read');
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

    const loadedStudy = await getStudyChecked(studyId, gated.context.kvClient);
    const studyMapped = mapStudyLoad(loadedStudy);
    if (!studyMapped.ok) return NextResponse.json(studyMapped.body, { status: studyMapped.status });
    const study = studyMapped.study;

    const loadedInterviews = await getStudyInterviewsChecked(studyId, gated.context.kvClient, 1_000);
    const interviewsMapped = mapCollectionLoad(loadedInterviews, {
      unavailable: 'Interview storage is temporarily unavailable.',
      tooLarge: 'This study has too many interviews for an interactive aggregate analysis.',
    });
    if (!interviewsMapped.ok) {
      return NextResponse.json(interviewsMapped.body, { status: interviewsMapped.status });
    }
    const interviews = interviewsMapped.items;
    const currentRevisionInterviews = interviews.filter(
      interview => interview.studyRevision === study.revision && interview.synthesis
    );

    if (currentRevisionInterviews.length < 2) {
      return NextResponse.json(
        {
          error: 'Need at least 2 completed interviews from the current study revision',
          studyRevision: study.revision,
          eligibleInterviewCount: currentRevisionInterviews.length,
        },
        { status: 400 }
      );
    }

    const syntheses: SynthesisResult[] = currentRevisionInterviews.map(
      interview => interview.synthesis!
    );

    const platformLimited = await hostedAiRateLimitResponse(
      request,
      'aggregate',
      { researcherId: gated.researcherId }
    );
    if (platformLimited) return platformLimited;

    // Get the configured AI provider with researcher's API keys.
    let provider;
    try {
      provider = getInterviewProvider(study.config, providerKeysFromContext(gated.context));
    } catch {
      return NextResponse.json(
        { error: 'AI provider is not configured on the server.' },
        { status: 502 }
      );
    }

    // Generate aggregate synthesis
    let aggregateResult;
    try {
      aggregateResult = await provider.synthesizeAggregate(
        study.config,
        syntheses,
        currentRevisionInterviews.length
      );
    } catch (providerError) {
      return providerErrorResponse(providerError);
    }

    // Build full result with metadata
    const fullResult: AggregateSynthesisResult = {
      ...aggregateResult.value,
      studyId,
      studyRevision: study.revision,
      interviewIds: currentRevisionInterviews.map(interview => interview.id),
      interviewCount: currentRevisionInterviews.length,
      aiProvider: aggregateResult.execution.provider,
      requestedAiModel: aggregateResult.execution.requestedModel,
      aiModel: aggregateResult.execution.model,
      routedProvider: aggregateResult.execution.routedProvider,
      generatedAt: Date.now()
    };

    const receipt = await createAggregateSynthesisReceipt(fullResult);

    return NextResponse.json({ synthesis: { ...fullResult, _receipt: receipt } });
  } catch (error) {
    logRequestFailure({
      event: 'route.failure',
      route: '/api/synthesis/aggregate',
      method: 'POST',
      status: 500,
      requestId: createRequestId(request.headers.get('x-request-id')),
    }, error);
    return NextResponse.json(
      { error: 'Failed to generate aggregate synthesis' },
      { status: 500 }
    );
  }
}
