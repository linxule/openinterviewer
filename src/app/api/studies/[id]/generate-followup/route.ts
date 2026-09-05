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
import { getStudyChecked, getStudyInterviewsChecked } from '@/lib/kv';
import { mapCollectionLoad, mapStudyLoad } from '@/lib/ownedStudies';
import { AggregateSynthesisResult, StudyConfig } from '@/types';
import { readBoundedJsonObject } from '@/lib/requestBody';
import { validateResolvedAggregateSynthesis } from '@/lib/providerValidation';
import { hostedAiRateLimitResponse } from '@/lib/platformAiRateLimit';
import { providerErrorResponse } from '@/lib/providerErrors';
import { verifyAggregateSynthesisReceipt } from '@/lib/synthesisReceipt';
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

    const parsedBody = await readBoundedJsonObject(request, 256_000);
    if (!parsedBody.ok) {
      return NextResponse.json(
        { error: parsedBody.status === 413 ? 'Synthesis payload is too large.' : 'Invalid synthesis payload.' },
        { status: parsedBody.status }
      );
    }
    const rawSynthesis = parsedBody.value.synthesis;
    if (!rawSynthesis || typeof rawSynthesis !== 'object' || Array.isArray(rawSynthesis)) {
      return NextResponse.json(
        { error: 'Missing or invalid synthesis data' },
        { status: 400 }
      );
    }
    const metadata = rawSynthesis as Partial<AggregateSynthesisResult>;
    const receipt = metadata._receipt;
    if (typeof receipt !== 'string') {
      return NextResponse.json({ error: 'Aggregate synthesis receipt is missing.' }, { status: 403 });
    }
    const { _receipt: _discardedReceipt, ...unsignedSynthesis } = rawSynthesis as AggregateSynthesisResult;
    const signedProvenance = await verifyAggregateSynthesisReceipt({
      receipt,
      synthesis: unsignedSynthesis,
    });
    if (!signedProvenance) {
      return NextResponse.json({ error: 'Aggregate synthesis receipt is invalid or expired.' }, { status: 403 });
    }
    let providerSynthesis;
    try {
      providerSynthesis = validateResolvedAggregateSynthesis(rawSynthesis);
    } catch {
      return NextResponse.json({ error: 'Missing or invalid synthesis data' }, { status: 400 });
    }
    const interviewIds = metadata.interviewIds;
    if (
      metadata.studyId !== parentStudy.id
      || metadata.studyRevision !== parentStudy.revision
      || !Array.isArray(interviewIds)
      || interviewIds.length < 2
      || interviewIds.length > 1_000
      || !interviewIds.every(value => typeof value === 'string' && value.length <= 200)
      || metadata.interviewCount !== interviewIds.length
    ) {
      return NextResponse.json({ error: 'Synthesis provenance does not match the current study.' }, { status: 409 });
    }

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
      generatedAt: typeof metadata.generatedAt === 'number' && Number.isSafeInteger(metadata.generatedAt)
        ? metadata.generatedAt
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
