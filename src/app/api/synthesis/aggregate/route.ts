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
import {
  aggregateInputTooLargeBody,
  loadDurableAggregateInputs,
  MAX_AGGREGATE_INTERVIEWS,
  mapCollectionLoad,
  mapReadinessHold,
  mapStudyLoad,
  RESEARCHER_MUTATION_STATES,
} from '@/lib/ownedStudies';
import { providerErrorResponse } from '@/lib/providerErrorResponse';
import { aggregateProvenance } from '@/lib/synthesisProvenance';
import { hostedAiRateLimitResponse } from '@/lib/platformAiRateLimit';
import type {
  AggregateSynthesisResult,
  AggregateTheme,
  StoredAggregateSynthesis,
  StoredInterview,
  SynthesisResult,
} from '@/types';
import { readBoundedJsonObject } from '@/lib/requestBody';
import { createRequestId, logRequestEvent, logRequestFailure } from '@/lib/requestLog';
import { resolveEvidenceRef, withRecordBackedEvidence } from '@/lib/evidence';
import { deploymentNotReadyResponse } from '@/lib/runtime/readinessGate';
import { isDurableWorkspaceStore } from '@/lib/storage/types';
import {
  currentProviderTransport,
  providerNotConfiguredResponse,
  researcherTransportNotDisclosedResponse,
  uncoveredCount,
} from '@/lib/transportDisclosure';

const ROUTE = '/api/synthesis/aggregate';
const INTERVIEW_MESSAGES = {
  unavailable: 'Interview storage is temporarily unavailable.',
  tooLarge: 'This study has too many interviews for an interactive aggregate analysis.',
};

export async function POST(request: Request) {
  try {
    const notReady = deploymentNotReadyResponse(ROUTE);
    if (notReady) return notReady;

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

    const store = gated.context.store;
    // A paid call that ends in a researcher mutation (the aggregate write,
    // which the durable workspace accepts only while open). OPS-01 refuses new
    // researcher mutations while draining, frozen or in recovery, so the call
    // is refused before the provider is paid; only preview and follow-up are
    // paid no-write calls allowed while draining (gap F26).
    if (isDurableWorkspaceStore(store)) {
      const readiness = await store.readiness();
      if (readiness.status === 'unavailable') {
        return NextResponse.json({ error: 'Study storage is temporarily unavailable.', retryable: true }, { status: 503 });
      }
      const held = mapReadinessHold(readiness, RESEARCHER_MUTATION_STATES, ROUTE);
      if (held) return held;
    }

    const loadedStudy = await store.getStudy(studyId);
    const studyMapped = mapStudyLoad(loadedStudy);
    if (!studyMapped.ok) return NextResponse.json(studyMapped.body, { status: studyMapped.status });
    const study = studyMapped.study;

    let currentRevisionInterviews: StoredInterview[];
    if (isDurableWorkspaceStore(store)) {
      // Bounded keyset pages of current-revision analyzed interviews only,
      // never the 1,000 full-record collection (RT-09).
      const inputs = await loadDurableAggregateInputs(store, study);
      if (inputs.status === 'unavailable') {
        return NextResponse.json({ error: INTERVIEW_MESSAGES.unavailable, retryable: true }, { status: 503 });
      }
      if (inputs.status === 'too-large') {
        return NextResponse.json({ error: INTERVIEW_MESSAGES.tooLarge }, { status: 413 });
      }
      if (inputs.status === 'input-too-large') {
        return NextResponse.json(aggregateInputTooLargeBody(), { status: 413 });
      }
      currentRevisionInterviews = inputs.interviews;
    } else {
      const loadedInterviews = await store.listInterviews({
        scope: 'study',
        studyId,
        maximum: MAX_AGGREGATE_INTERVIEWS,
      });
      const interviewsMapped = mapCollectionLoad(loadedInterviews, INTERVIEW_MESSAGES);
      if (!interviewsMapped.ok) {
        return NextResponse.json(interviewsMapped.body, { status: interviewsMapped.status });
      }
      currentRevisionInterviews = interviewsMapped.items.filter(
        interview => interview.studyRevision === study.revision && interview.synthesis
      );
    }

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

    // D9 (Cloudflare): every included transcript's consent must cover the
    // transport this call would use. An uncovered interview refuses the whole
    // call; interviews are never silently dropped from an aggregate.
    const current = currentProviderTransport(gated.context, study.config.aiProvider);
    if (current.applies) {
      if (!current.ok) return providerNotConfiguredResponse();
      const uncovered = uncoveredCount(
        currentRevisionInterviews.map(interview => interview.consentTransport),
        current.transport,
      );
      if (uncovered > 0) return researcherTransportNotDisclosedResponse(uncovered);
    }

    // The route holds the transcripts; the prompt builder does not. So the
    // catalogue the provider sees is already checked against the records it
    // names: every surviving ref's quote is the record's own characters, and
    // an unlocatable ref never reaches the prompt. Legacy (evidence-shaped)
    // themes pass through unchanged, by identity (L7.1).
    const syntheses: SynthesisResult[] = currentRevisionInterviews.map(
      interview => withRecordBackedEvidence(interview.synthesis!, interview.transcript)
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

    // Resolve the model's catalogue positions into interview ids BEFORE
    // signing (L7.2). This is the one place a fabricated id could otherwise
    // enter a signed record: the model never sees or returns an interview
    // id, only a 1-based position into the same array the route built.
    const interviewIds = currentRevisionInterviews.map(interview => interview.id);
    const commonThemes: AggregateTheme[] = aggregateResult.value.commonThemes.map(theme => ({
      theme: theme.theme,
      frequency: theme.frequency,
      quoteRefs: theme.quoteRefs.flatMap(claim => {
        const interviewId = interviewIds[claim.interviewIndex - 1];
        // An out-of-range interviewIndex names no record at all: there is no
        // coordinate to print and no transcript to be unverified against, so
        // it is dropped rather than rendered with no provenance (L7.2.1).
        return interviewId === undefined
          ? []
          : [{ quote: claim.quote, turnIndex: claim.turnIndex, interviewId }];
      }),
    }));

    // Build full result with metadata
    const fullResult: AggregateSynthesisResult = {
      ...aggregateResult.value,
      commonThemes,
      studyId,
      studyRevision: study.revision,
      interviewIds,
      interviewCount: currentRevisionInterviews.length,
      aiProvider: aggregateResult.execution.provider,
      requestedAiModel: aggregateResult.execution.requestedModel,
      aiModel: aggregateResult.execution.model,
      routedProvider: aggregateResult.execution.routedProvider,
      ...(aggregateResult.execution.aiTransport ? { aiTransport: aggregateResult.execution.aiTransport } : {}),
      generatedAt: Date.now()
    };

    // A record that does not name the provider and model that actually ran
    // is not storable (AGENTS.md).
    if (!aggregateProvenance(fullResult)) {
      return NextResponse.json(
        { error: 'Failed to generate aggregate synthesis' },
        { status: 500 },
      );
    }

    // Persist before responding, but never at the cost of the result: a write
    // that fails returns the aggregate anyway, without `savedAt`, and the
    // footer reads `not saved — regenerate to refresh`. The paid call is not
    // thrown away because storage blinked, the workspace entered a hold after
    // the readiness check, or the study was deleted meanwhile (the durable
    // store refuses the orphan).
    const savedAt = Date.now();
    const stored: StoredAggregateSynthesis = { ...fullResult, savedAt };
    const write = await store.saveAggregate(stored);

    // Match-rate telemetry (ADR-003: counts only — never quote, turn, or
    // interview-id text). This is the only place the server runs the matcher
    // on aggregate refs; the result never touches fullResult (L8, L13).
    try {
      const claims = aggregateResult.value.commonThemes.flatMap(theme => theme.quoteRefs);
      logRequestEvent({
        event: 'synthesis.evidence',
        requestId: createRequestId(request.headers.get('x-request-id')),
        route: ROUTE,
        refsOffered: claims.length,
        refsLocated: claims.filter(claim => {
          const interview = currentRevisionInterviews[claim.interviewIndex - 1];
          return interview !== undefined
            && resolveEvidenceRef(
                 { quote: claim.quote, turnIndex: claim.turnIndex },
                 interview.transcript,
               ).status === 'verified';
        }).length,
      });
    } catch {
      // Swallowed by design: a telemetry failure must never cost a paid
      // aggregate call.
    }

    return NextResponse.json({ synthesis: write === 'saved' ? stored : fullResult });
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
