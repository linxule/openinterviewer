// POST /api/synthesis/aggregate - Generate aggregate synthesis across interviews
// Server-side only - requires authenticated session
// Analyzes all interviews for a study to find cross-participant patterns

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getInterviewProvider } from '@/lib/providers';
import { getRequestContext } from '@/lib/researcherContext';
import { configurationRequiredResponse } from '@/lib/researcherAccess';
import { getStudy, getStudyInterviewsChecked, isKVAvailable } from '@/lib/kv';
import { providerErrorResponse } from '@/lib/providerErrors';
import { hostedAiRateLimitResponse } from '@/lib/platformAiRateLimit';
import { AggregateSynthesisResult, SynthesisResult } from '@/types';
import { readBoundedJsonObject } from '@/lib/requestBody';

export async function POST(request: Request) {
  try {
    const access = await getRequestContext();
    const setupResponse = configurationRequiredResponse(access);
    if (setupResponse) return setupResponse;
    const { authorized, context, error } = access;
    if (!authorized || !context) {
      return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
    }

    const kvAvailable = await isKVAvailable(context.kvClient);
    if (!kvAvailable) {
      return NextResponse.json(
        { error: 'Storage not configured. Connect Vercel KV to enable this feature.' },
        { status: 503 }
      );
    }

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

    // Fetch study to get config
    const study = await getStudy(studyId, context.kvClient);
    if (!study) {
      return NextResponse.json(
        { error: 'Study not found' },
        { status: 404 }
      );
    }

    // Fetch all interviews for this study
    const loadedInterviews = await getStudyInterviewsChecked(studyId, context.kvClient, 1_000);
    if (loadedInterviews.status === 'unavailable') {
      return NextResponse.json(
        { error: 'Interview storage is temporarily unavailable.', retryable: true },
        { status: 503 }
      );
    }
    if (loadedInterviews.status === 'too-large') {
      return NextResponse.json(
        { error: 'This study has too many interviews for an interactive aggregate analysis.' },
        { status: 413 }
      );
    }
    const interviews = loadedInterviews.items;
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
      { researcherId: context.researcherId }
    );
    if (platformLimited) return platformLimited;

    // Get the configured AI provider with researcher's API keys
    const provider = getInterviewProvider(study.config, {
      geminiApiKey: context.geminiApiKey,
      anthropicApiKey: context.anthropicApiKey,
    });

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
      studyId,
      studyRevision: study.revision,
      interviewIds: currentRevisionInterviews.map(interview => interview.id),
      interviewCount: currentRevisionInterviews.length,
      aiProvider: study.config.aiProvider ?? 'gemini',
      aiModel: study.config.aiModel ?? 'default',
      ...aggregateResult,
      generatedAt: Date.now()
    };

    return NextResponse.json({ synthesis: fullResult });
  } catch (error) {
    console.error('Aggregate synthesis API error:', error);
    return NextResponse.json(
      { error: 'Failed to generate aggregate synthesis' },
      { status: 500 }
    );
  }
}
