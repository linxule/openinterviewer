import type { InterviewAnalysisFailureKind, InterviewAnalysisStatus, StoredInterview } from '@/types';
import type { AnalysisPhase, AnalysisStatusBody } from '@/lib/storage/analysisProtocol';

/**
 * The one derivation of an interview's analysis state. Legacy records carry no
 * `analysis` member; their status is read off the synthesis the server itself
 * wrote — a stored fact about the record, not an inference from another one.
 * Every read surface calls this. No component reimplements the derivation,
 * and no component reads `interview.analysis?.status` directly.
 */
export function analysisStatus(
  interview: Pick<StoredInterview, 'analysis' | 'synthesis'>,
): InterviewAnalysisStatus {
  return interview.analysis ? interview.analysis.status : interview.synthesis ? 'complete' : 'pending';
}

/** True for pending, running and failed. */
export function isAwaitingAnalysis(
  interview: Pick<StoredInterview, 'analysis' | 'synthesis'>,
): boolean {
  return analysisStatus(interview) !== 'complete';
}

/**
 * A recorded failure whose paid provider outcome could not be confirmed
 * (durable analysis only). Running it again may make another paid request.
 */
export function needsAnalysisRecovery(
  interview: Pick<StoredInterview, 'analysis' | 'synthesis'>,
): boolean {
  return analysisStatus(interview) === 'failed' && interview.analysis?.recoveryRequired === true;
}

/**
 * The last server-confirmed analysis state of one interview under the durable
 * (v2) protocol, whether it came from the stored record or the status API.
 * `already-complete` is folded into `complete`; polling hints are dropped.
 */
export type ConfirmedAnalysis =
  | { status: 'pending'; generation: number; phase: AnalysisPhase }
  | { status: 'complete'; generation: number }
  | {
    status: 'failed';
    generation: number;
    failureKind?: InterviewAnalysisFailureKind;
    recoveryRequired: boolean;
  };

export function confirmedAnalysisFromRecord(
  interview: Pick<StoredInterview, 'analysis' | 'synthesis'>,
): ConfirmedAnalysis {
  const generation = interview.analysis?.generation ?? 0;
  switch (analysisStatus(interview)) {
    case 'complete':
      return { status: 'complete', generation };
    case 'failed':
      return {
        status: 'failed',
        generation,
        ...(interview.analysis?.failureKind ? { failureKind: interview.analysis.failureKind } : {}),
        recoveryRequired: interview.analysis?.recoveryRequired === true,
      };
    case 'running':
      return { status: 'pending', generation, phase: 'running' };
    case 'pending':
      // Generation 0 is a legacy record that was never scheduled; a later
      // generation has durable queued work behind it.
      return { status: 'pending', generation, phase: generation > 0 ? 'queued' : 'not-scheduled' };
  }
}

export function confirmedAnalysisFromStatus(body: AnalysisStatusBody): ConfirmedAnalysis {
  switch (body.status) {
    case 'pending':
      return { status: 'pending', generation: body.generation, phase: body.phase };
    case 'complete':
    case 'already-complete':
      return { status: 'complete', generation: body.generation };
    case 'failed':
      return {
        status: 'failed',
        generation: body.generation,
        failureKind: body.failureKind,
        recoveryRequired: body.recoveryRequired,
      };
  }
}

/** Scheduled work that has not reached a persisted outcome yet (worth polling). */
export function isActiveAnalysis(state: ConfirmedAnalysis | null): boolean {
  return state?.status === 'pending' && state.phase !== 'not-scheduled';
}

/** Only the durable store writes a generation; Node records never carry one. */
export function isDurableAnalysisRecord(interview: Pick<StoredInterview, 'analysis'>): boolean {
  return interview.analysis?.generation !== undefined;
}

/**
 * Durable work already queued or running for this interview. It is observed,
 * never requested again, so it stays out of any batch (F8). Node records keep
 * their legacy batch eligibility.
 */
export function hasScheduledAnalysis(interview: Pick<StoredInterview, 'analysis' | 'synthesis'>): boolean {
  return isDurableAnalysisRecord(interview) && isActiveAnalysis(confirmedAnalysisFromRecord(interview));
}

export function isTerminalAnalysis(state: ConfirmedAnalysis | null): boolean {
  return state?.status === 'complete' || state?.status === 'failed';
}

/**
 * Monotonic adoption (API-03): a newer generation always wins, an older one is
 * rejected, and within one generation a persisted outcome never regresses to
 * pending. Returns `current` itself when the incoming state is rejected.
 */
export function adoptAnalysisStatus(
  current: ConfirmedAnalysis | null,
  incoming: ConfirmedAnalysis,
): ConfirmedAnalysis {
  if (!current) return incoming;
  if (incoming.generation < current.generation) return current;
  if (
    incoming.generation === current.generation
    && isTerminalAnalysis(current)
    && incoming.status === 'pending'
  ) {
    return current;
  }
  return incoming;
}

export function sameConfirmedAnalysis(a: ConfirmedAnalysis | null, b: ConfirmedAnalysis | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.status !== b.status || a.generation !== b.generation) return false;
  if (a.status === 'pending' && b.status === 'pending') return a.phase === b.phase;
  if (a.status === 'failed' && b.status === 'failed') {
    return a.failureKind === b.failureKind && a.recoveryRequired === b.recoveryRequired;
  }
  return true;
}
