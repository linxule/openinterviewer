// The deferred/researcher-triggered analysis run. One exported function,
// called from exactly two places: the save route's `after()` callback and the
// researcher-triggered `POST /api/interviews/[id]/analyze` route. This is the
// only function that calls `synthesizeInterview` for a stored interview.
//
// Sequence, and nothing else: claim (the concurrency gate, first) -> read the
// record -> call the provider -> validate its provenance -> attach the
// result. The function never throws to its caller and never retries
// internally. One attempt, one recorded outcome.

import type { RedisPort } from './redisPort';
import type { AIProviderKeys } from './providers';
import { getInterviewProvider } from './providers';
import {
  attachInterviewAnalysis,
  claimInterviewAnalysis,
  getInterviewChecked,
  recordInterviewAnalysisFailure,
} from './kv';
import { validateProvenance } from './synthesisProvenance';
import { resolveEvidenceRef } from './evidence';
import { createRequestId, logRequestEvent, logRequestFailure } from './requestLog';
import type { InterviewAnalysisFailureKind, StoredStudy } from '@/types';

export type RunAnalysisOutcome =
  | { status: 'complete' | 'already-complete' | 'busy' | 'not-found' | 'unavailable' }
  | { status: 'failed'; failureKind: InterviewAnalysisFailureKind };

export async function runInterviewAnalysis(input: {
  interviewId: string;
  study: StoredStudy;
  kvClient: RedisPort;
  providerKeys: AIProviderKeys;
  platformAuthority?: { researcherId?: string | null; participantSessionId?: string };
}): Promise<RunAnalysisOutcome> {
  const { interviewId, study, kvClient, providerKeys } = input;
  // Whether this run was scheduled after a participant's save (no researcher
  // session on the request) or pressed by a researcher — counts only, never
  // an identity, for the telemetry event below.
  const operation = input.platformAuthority?.participantSessionId ? 'deferred' : 'researcher';

  // The `status` field is numeric everywhere in requestLog (route.failure's
  // HTTP status); 200 means a known record outcome, while 503 preserves
  // storage uncertainty. Neither a reason nor a status carries provider text.
  const logOutcome = (
    reason?: 'provider-failure' | 'invalid' | 'too-large' | 'unavailable',
    status = 200,
  ) => {
    logRequestEvent({
      event: 'interview.analysis',
      route: '/api/interviews/analyze',
      operation,
      status,
      ...(reason ? { reason } : {}),
    });
  };

  // 1. The concurrency gate, first: anything but `claimed` returns
  // immediately, with no provider call.
  const claim = await claimInterviewAnalysis(interviewId, kvClient);
  if (claim.status !== 'claimed') {
    const outcome: RunAnalysisOutcome =
      claim.status === 'already-complete' ? { status: 'already-complete' }
      : claim.status === 'not-found' ? { status: 'not-found' }
      : claim.status === 'unavailable' ? { status: 'unavailable' }
      : { status: 'busy' };
    logOutcome(outcome.status === 'unavailable' ? 'unavailable' : undefined,
      outcome.status === 'unavailable' ? 503 : 200);
    return outcome;
  }
  const claimId = claim.claimId;

  // Failure recording is also a conditional write: another run may have
  // completed, replaced this claim, or deleted the record. Report a failure
  // only when its write was acknowledged. An outage remains retryable even
  // when a best-effort storage-failure marker succeeds.
  const recordFailure = async (
    failureKind: InterviewAnalysisFailureKind,
    reason: 'provider-failure' | 'invalid' | 'too-large' | 'unavailable',
  ): Promise<RunAnalysisOutcome> => {
    const recorded = await recordInterviewAnalysisFailure(interviewId, claimId, failureKind, kvClient);
    switch (recorded.status) {
      case 'written':
        if (failureKind === 'storage') {
          logOutcome('unavailable', 503);
          return { status: 'unavailable' };
        }
        logOutcome(reason);
        return { status: 'failed', failureKind };
      case 'already-complete':
        logOutcome();
        return { status: 'already-complete' };
      case 'stale':
        logOutcome();
        return { status: 'busy' };
      case 'not-found':
        logOutcome();
        return { status: 'not-found' };
      default:
        logOutcome('unavailable', 503);
        return { status: 'unavailable' };
    }
  };

  // 2. A record that vanished between claim and read is `not-found` — the
  // study or interview was deleted concurrently; there is nothing to write to.
  const loaded = await getInterviewChecked(interviewId, kvClient);
  if (loaded.status === 'unavailable') {
    return recordFailure('storage', 'unavailable');
  }
  if (loaded.status === 'not-found') {
    logOutcome();
    return { status: 'not-found' };
  }
  const interview = loaded.interview;

  // 3. Call the provider with the same four arguments the participant-facing
  // route used to pass.
  let result;
  try {
    const provider = getInterviewProvider(study.config, providerKeys);
    result = await provider.synthesizeInterview(
      interview.transcript,
      study.config,
      interview.behaviorData,
      interview.participantProfile,
    );
  } catch (error) {
    // logRequestFailure is the only thing that ever sees the caught error;
    // never the stored record, never a response body, never a screen.
    logRequestFailure({ event: 'route.failure', route: '/api/interviews/analyze', operation }, error);
    return recordFailure('provider', 'provider-failure');
  }

  // 4. A result not naming the provider and model that actually ran is not
  // storable (AGENTS.md).
  const provenance = validateProvenance({
    aiProvider: result.execution.provider,
    aiModel: result.execution.model,
    requestedAiModel: result.execution.requestedModel,
    routedProvider: result.execution.routedProvider,
  });
  if (!provenance) {
    return recordFailure('invalid-output', 'invalid');
  }

  // 5. Attach the result.
  const attached = await attachInterviewAnalysis({
    interviewId,
    claimId,
    synthesis: result.value,
    provenance,
    studyRevision: study.revision,
  }, kvClient);

  // 7. Evidence telemetry, counts only, in a swallowing try — lifted verbatim
  // from synthesis/route.ts.
  try {
    const refs = result.value.themes.flatMap(theme => theme.evidenceRefs ?? []);
    logRequestEvent({
      event: 'synthesis.evidence',
      requestId: createRequestId(),
      route: '/api/interviews/analyze',
      refsOffered: refs.length,
      refsLocated: refs.filter(ref => resolveEvidenceRef(ref, interview.transcript).status === 'verified').length,
    });
  } catch {
    // Swallowed by design: a telemetry failure must never cost a paid call.
  }

  switch (attached.status) {
    case 'written':
      logOutcome();
      return { status: 'complete' };
    case 'already-complete':
      logOutcome();
      return { status: 'already-complete' };
    case 'stale':
      // A newer claim (a researcher's later press) already stands. No second
      // write; last-claim-wins is the only ordering the record can observe.
      logOutcome();
      return { status: 'busy' };
    case 'not-found':
      logOutcome();
      return { status: 'not-found' };
    case 'too-large':
      return recordFailure('too-large', 'too-large');
    case 'unavailable':
    default:
      return recordFailure('storage', 'unavailable');
  }
}
