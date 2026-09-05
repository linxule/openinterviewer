// POST /api/studies/[id]/generate-followup - Generate follow-up study from synthesis
// Server-side only - requires authenticated session
// Uses AI to suggest new research questions based on findings

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import {
  getInterviewProvider,
} from '@/lib/providers';
import { getAuthorizedResearcherStudyContext, providerKeysFromContext } from '@/lib/researcherContext';
import { configurationRequiredResponse } from '@/lib/researcherAccess';
import { getStudyAggregateChecked, getStudyChecked, getStudyInterviewsChecked } from '@/lib/kv';
import { mapCollectionLoad, mapStudyLoad } from '@/lib/ownedStudies';
import { AggregateSynthesisResult, StudyConfig } from '@/types';
import { validateResolvedAggregateSynthesis } from '@/lib/providerValidation';
import { hostedAiRateLimitResponse } from '@/lib/platformAiRateLimit';
import { providerErrorResponse } from '@/lib/providerErrors';
import { aggregateProvenance } from '@/lib/synthesisReceipt';
import { createRequestId, logRequestFailure } from '@/lib/requestLog';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: studyId } = await params;

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
    const parentStudy = studyMapped.study;

    const loadedAggregate = await getStudyAggregateChecked(parentStudy.id, gated.context.kvClient);
    if (loadedAggregate.status === 'unavailable') {
      return NextResponse.json(
        { error: 'Analysis storage is temporarily unavailable.', retryable: true },
        { status: 503 },
      );
    }
    if (loadedAggregate.status === 'not-found') {
      return NextResponse.json(
        { error: 'Run the aggregate analysis for this study before generating a follow-up.' },
        { status: 409 },
      );
    }
    const stored = loadedAggregate.aggregate;

    // Same three refusals as the receipt path enforced, now over a record the
    // server wrote: revision binding, complete provenance, and shape.
    if (stored.studyRevision !== parentStudy.revision) {
      return NextResponse.json(
        { error: 'Synthesis provenance does not match the current study.' },
        { status: 409 },
      );
    }
    const signedProvenance = aggregateProvenance(stored);
    if (!signedProvenance) {
      return NextResponse.json(
        { error: 'Stored analysis provenance is incomplete. Re-analyze this study.' },
        { status: 409 },
      );
    }
    let providerSynthesis;
    try {
      providerSynthesis = validateResolvedAggregateSynthesis(stored);
    } catch {
      return NextResponse.json({ error: 'Missing or invalid synthesis data' }, { status: 400 });
    }
    const interviewIds = stored.interviewIds;

    const loadedInterviews = await getStudyInterviewsChecked(parentStudy.id, gated.context.kvClient, 1_000);
    const interviewsMapped = mapCollectionLoad(loadedInterviews, {
      unavailable: 'Interview storage is temporarily unavailable.',
      tooLarge: 'This study has too many interviews for interactive follow-up generation.',
    });
    if (!interviewsMapped.ok) {
      return NextResponse.json(interviewsMapped.body, { status: interviewsMapped.status });
    }
    const loadedInterviewItems = interviewsMapped.items;
    const eligibleIds = new Set(
      loadedInterviewItems
        .filter(interview => interview.studyRevision === parentStudy.revision && interview.synthesis)
        .map(interview => interview.id)
    );
    if (new Set(interviewIds).size !== interviewIds.length || interviewIds.some(id => !eligibleIds.has(id))) {
      return NextResponse.json({ error: 'Synthesis interview provenance is invalid.' }, { status: 409 });
    }
    const synthesis: AggregateSynthesisResult = {
      studyId: parentStudy.id,
      studyRevision: parentStudy.revision,
      interviewIds,
      interviewCount: interviewIds.length,
      aiProvider: signedProvenance.aiProvider,
      requestedAiModel: signedProvenance.requestedAiModel,
      aiModel: signedProvenance.aiModel,
      routedProvider: signedProvenance.routedProvider,
      generatedAt: typeof stored.generatedAt === 'number' && Number.isSafeInteger(stored.generatedAt)
        ? stored.generatedAt
        : Date.now(),
      ...providerSynthesis,
    };

    const platformLimited = await hostedAiRateLimitResponse(
      request,
      'followup',
      { researcherId: gated.researcherId }
    );
    if (platformLimited) return platformLimited;

    // Get the configured AI provider with researcher's API keys.
    let provider;
    try {
      provider = getInterviewProvider(parentStudy.config, providerKeysFromContext(gated.context));
    } catch {
      return NextResponse.json(
        { error: 'AI provider is not configured on the server.' },
        { status: 502 }
      );
    }

    // Generate follow-up study suggestions
    let suggestions;
    try {
      suggestions = await provider.generateFollowupStudy(
        parentStudy.config,
        synthesis
      );
    } catch (providerError) {
      return providerErrorResponse(providerError);
    }

    // Build pre-filled config for follow-up study
    const followUpConfig: Partial<StudyConfig> = {
      name: suggestions.value.name,
      description: `Follow-up study based on "${parentStudy.config.name}"`,
      researchQuestion: suggestions.value.researchQuestion,
      coreQuestions: suggestions.value.coreQuestions,
      topicAreas: synthesis.commonThemes?.length > 0
        ? synthesis.commonThemes.slice(0, 5).map(t => t.theme)
        : parentStudy.config.topicAreas,
      profileSchema: parentStudy.config.profileSchema,
      aiBehavior: parentStudy.config.aiBehavior,
      consentText: parentStudy.config.consentText,
      researcherContact: parentStudy.config.researcherContact,
      aiProvider: parentStudy.config.aiProvider,
      aiModel: parentStudy.config.aiModel,
      enableReasoning: parentStudy.config.enableReasoning,
      parentStudyId: parentStudy.id,
      parentStudyName: parentStudy.config.name,
      generatedFrom: 'synthesis'
    };

    return NextResponse.json({
      followUpConfig,
      generation: suggestions.execution,
      parentStudy: {
        id: parentStudy.id,
        name: parentStudy.config.name
      }
    });
  } catch (error) {
    logRequestFailure({
      event: 'route.failure',
      route: '/api/studies/[id]/generate-followup',
      method: 'POST',
      status: 500,
      requestId: createRequestId(request.headers.get('x-request-id')),
    }, error);
    return NextResponse.json(
      { error: 'Failed to generate follow-up study' },
      { status: 500 }
    );
  }
}
