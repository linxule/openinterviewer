// POST /api/studies/[id]/generate-followup - Generate follow-up study from synthesis
// Server-side only - requires authenticated session
// Uses AI to suggest new research questions based on findings

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getInterviewProvider } from '@/lib/providers';
import { getRequestContext } from '@/lib/researcherContext';
import { configurationRequiredResponse } from '@/lib/researcherAccess';
import { getStudyChecked, getStudyInterviewsChecked } from '@/lib/kv';
import { AggregateSynthesisResult, StudyConfig } from '@/types';
import { readBoundedJsonObject } from '@/lib/requestBody';
import { validateAggregateSynthesisPayload } from '@/lib/providerValidation';
import { hostedAiRateLimitResponse } from '@/lib/platformAiRateLimit';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const access = await getRequestContext();
    const setupResponse = configurationRequiredResponse(access);
    if (setupResponse) return setupResponse;
    const { authorized, context, error } = access;
    if (!authorized || !context) {
      return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
    }

    const { id: studyId } = await params;

    // Fetch parent study
    const loadedStudy = await getStudyChecked(studyId, context.kvClient);
    if (loadedStudy.status === 'unavailable') {
      return NextResponse.json({ error: 'Study storage is temporarily unavailable.', retryable: true }, { status: 503 });
    }
    if (loadedStudy.status === 'not-found') {
      return NextResponse.json(
        { error: 'Study not found' },
        { status: 404 }
      );
    }
    const parentStudy = loadedStudy.study;

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
    let providerSynthesis;
    try {
      providerSynthesis = validateAggregateSynthesisPayload(rawSynthesis);
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

    const loadedInterviews = await getStudyInterviewsChecked(parentStudy.id, context.kvClient, 1_000);
    if (loadedInterviews.status === 'unavailable') {
      return NextResponse.json({ error: 'Interview storage is temporarily unavailable.', retryable: true }, { status: 503 });
    }
    if (loadedInterviews.status === 'too-large') {
      return NextResponse.json({ error: 'This study has too many interviews for interactive follow-up generation.' }, { status: 413 });
    }
    const eligibleIds = new Set(
      loadedInterviews.items
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
      aiProvider: parentStudy.config.aiProvider ?? 'gemini',
      aiModel: parentStudy.config.aiModel ?? 'default',
      generatedAt: typeof metadata.generatedAt === 'number' && Number.isSafeInteger(metadata.generatedAt)
        ? metadata.generatedAt
        : Date.now(),
      ...providerSynthesis,
    };

    const platformLimited = await hostedAiRateLimitResponse(
      request,
      'followup',
      { researcherId: context.researcherId }
    );
    if (platformLimited) return platformLimited;

    // Get the configured AI provider with researcher's API keys
    const provider = getInterviewProvider(parentStudy.config, {
      geminiApiKey: context.geminiApiKey,
      anthropicApiKey: context.anthropicApiKey,
    });

    // Generate follow-up study suggestions
    const suggestions = await provider.generateFollowupStudy(
      parentStudy.config,
      synthesis
    );

    // Build pre-filled config for follow-up study
    const followUpConfig: Partial<StudyConfig> = {
      name: suggestions.name,
      description: `Follow-up study based on "${parentStudy.config.name}"`,
      researchQuestion: suggestions.researchQuestion,
      coreQuestions: suggestions.coreQuestions,
      topicAreas: synthesis.commonThemes?.length > 0
        ? synthesis.commonThemes.slice(0, 5).map(t => t.theme)
        : parentStudy.config.topicAreas,
      profileSchema: parentStudy.config.profileSchema,
      aiBehavior: parentStudy.config.aiBehavior,
      consentText: parentStudy.config.consentText,
      aiProvider: parentStudy.config.aiProvider,
      aiModel: parentStudy.config.aiModel,
      enableReasoning: parentStudy.config.enableReasoning,
      parentStudyId: parentStudy.id,
      parentStudyName: parentStudy.config.name,
      generatedFrom: 'synthesis'
    };

    return NextResponse.json({
      followUpConfig,
      parentStudy: {
        id: parentStudy.id,
        name: parentStudy.config.name
      }
    });
  } catch (error) {
    console.error('Generate follow-up API error:', error);
    return NextResponse.json(
      { error: 'Failed to generate follow-up study' },
      { status: 500 }
    );
  }
}
