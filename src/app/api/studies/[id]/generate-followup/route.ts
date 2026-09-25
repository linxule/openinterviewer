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
import {
  forEachEligibleAggregateInput,
  MAX_AGGREGATE_INTERVIEWS,
  mapCollectionLoad,
  mapReadinessHold,
  mapStudyLoad,
  PAID_CALL_STATES,
} from '@/lib/ownedStudies';
import { AggregateSynthesisResult, StudyConfig } from '@/types';
import { validateResolvedAggregateSynthesis } from '@/lib/providerValidation';
import { hostedAiRateLimitResponse } from '@/lib/platformAiRateLimit';
import { providerErrorResponse } from '@/lib/providerErrorResponse';
import { aggregateProvenance } from '@/lib/synthesisProvenance';
import {
  currentProviderTransport,
  providerNotConfiguredResponse,
  researcherTransportNotDisclosedResponse,
  participantDisclosures,
  uncoveredCount,
} from '@/lib/transportDisclosure';
import { createRequestId, logRequestFailure } from '@/lib/requestLog';
import { deploymentNotReadyResponse } from '@/lib/runtime/readinessGate';
import { isDurableWorkspaceStore } from '@/lib/storage/types';

const ROUTE = '/api/studies/[id]/generate-followup';
const INTERVIEW_MESSAGES = {
  unavailable: 'Interview storage is temporarily unavailable.',
  tooLarge: 'This study has too many interviews for interactive follow-up generation.',
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const notReady = deploymentNotReadyResponse(ROUTE);
    if (notReady) return notReady;

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

    const store = gated.context.store;
    // A paid call without a write: a durable workspace allows it while
    // draining and refuses it while frozen or in recovery (gap F26).
    if (isDurableWorkspaceStore(store)) {
      const readiness = await store.readiness();
      if (readiness.status === 'unavailable') {
        return NextResponse.json({ error: 'Study storage is temporarily unavailable.', retryable: true }, { status: 503 });
      }
      const held = mapReadinessHold(readiness, PAID_CALL_STATES, ROUTE);
      if (held) return held;
    }

    const loadedStudy = await store.getStudy(studyId);
    const studyMapped = mapStudyLoad(loadedStudy);
    if (!studyMapped.ok) return NextResponse.json(studyMapped.body, { status: studyMapped.status });
    const parentStudy = studyMapped.study;

    const loadedAggregate = await store.getAggregate(parentStudy.id);
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

    const eligibleIds = new Set<string>();
    // D9 (Cloudflare): the aggregate carries participant quotes, so every
    // source interview's consent must cover the transport of this call.
    const current = currentProviderTransport(gated.context, parentStudy.config.aiProvider);
    if (current.applies && !current.ok) return providerNotConfiguredResponse();
    const sourceDisclosures: Array<'cloudflare-gateway' | undefined> = [];
    if (isDurableWorkspaceStore(store)) {
      // Only eligibility is needed: page current-revision analyzed interviews,
      // keep ids and stop once every aggregate source has been seen.
      const wanted = new Set(interviewIds);
      const pass = await forEachEligibleAggregateInput(store, parentStudy, page => {
        for (const interview of page) {
          if (wanted.has(interview.id) && !eligibleIds.has(interview.id)) {
            eligibleIds.add(interview.id);
            sourceDisclosures.push(...participantDisclosures([interview]));
          }
        }
        return eligibleIds.size < wanted.size;
      }, 'follow-up');
      if (pass === 'unavailable') {
        return NextResponse.json({ error: INTERVIEW_MESSAGES.unavailable, retryable: true }, { status: 503 });
      }
      if (pass === 'too-large') {
        return NextResponse.json({ error: INTERVIEW_MESSAGES.tooLarge }, { status: 413 });
      }
    } else {
      const loadedInterviews = await store.listInterviews({
        scope: 'study',
        studyId: parentStudy.id,
        maximum: MAX_AGGREGATE_INTERVIEWS,
      });
      const interviewsMapped = mapCollectionLoad(loadedInterviews, INTERVIEW_MESSAGES);
      if (!interviewsMapped.ok) {
        return NextResponse.json(interviewsMapped.body, { status: interviewsMapped.status });
      }
      for (const interview of interviewsMapped.items) {
        if (interview.studyRevision === parentStudy.revision && interview.synthesis) eligibleIds.add(interview.id);
      }
    }
    if (new Set(interviewIds).size !== interviewIds.length || interviewIds.some(id => !eligibleIds.has(id))) {
      return NextResponse.json({ error: 'Synthesis interview provenance is invalid.' }, { status: 409 });
    }
    if (current.applies && current.ok) {
      const uncovered = uncoveredCount(sourceDisclosures, current.transport);
      if (uncovered > 0) return researcherTransportNotDisclosedResponse(uncovered);
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
      ...(signedProvenance.aiTransport ? { aiTransport: signedProvenance.aiTransport } : {}),
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
      interviewerInstructions: parentStudy.config.interviewerInstructions,
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
      route: ROUTE,
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
