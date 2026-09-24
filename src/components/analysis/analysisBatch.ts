import {
  analyzeInterview,
  getInterviewAnalysisStatus,
  startInterviewAnalysisV2,
  type AnalysisRequestFailureKind,
} from '@/services/analysisApi';
import {
  confirmedAnalysisFromStatus,
  isActiveAnalysis,
  type ConfirmedAnalysis,
} from '@/lib/analysisState';
import type { AnalysisActionKeys } from './actionKeys';
import { waitForAnalysisOutcome } from './statusPoller';

export type AnalysisBatchItem = {
  interviewId: string;
  /** How the researcher sees this row, e.g. "Interview 3". */
  label: string;
  /** Last confirmed state from the loaded register. */
  confirmed: ConfirmedAnalysis;
};

/** Only persisted outcomes are counted; accepted work never is. */
export type AnalysisBatchProgress = {
  total: number;
  finished: number;
  failed: number;
};

export type AnalysisBatchStopReason = 'pending' | 'update-required' | 'state-changed' | 'other';

export type AnalysisBatchResult =
  | { kind: 'finished'; progress: AnalysisBatchProgress }
  | { kind: 'stopped'; progress: AnalysisBatchProgress; error: string; reason: AnalysisBatchStopReason }
  /** Work for `item` is still pending; nothing after it was requested. */
  | { kind: 'awaiting'; progress: AnalysisBatchProgress; item: AnalysisBatchItem }
  | { kind: 'cancelled'; progress: AnalysisBatchProgress };

function stopReason(kind: AnalysisRequestFailureKind): AnalysisBatchStopReason {
  return kind === 'pending' || kind === 'update-required' || kind === 'state-changed' ? kind : 'other';
}

type BatchOptions = {
  studyId: string;
  items: AnalysisBatchItem[];
  signal: AbortSignal;
  onProgress: (progress: AnalysisBatchProgress) => void;
};

export type AnalysisBatchOptions =
  | (BatchOptions & { protocol: 'synchronous' })
  | (BatchOptions & { protocol: 'queued-v2'; keys: AnalysisActionKeys });

/**
 * API-04 batch, sequential and oldest-first as selected by the caller.
 * Continue after a persisted failure; stop on any request failure; stop when
 * one interview is still pending so later ones are never requested behind it.
 */
export async function runAnalysisBatch(options: AnalysisBatchOptions): Promise<AnalysisBatchResult> {
  const progress: AnalysisBatchProgress = { total: options.items.length, finished: 0, failed: 0 };
  const snapshot = () => ({ ...progress });
  const record = (status: 'complete' | 'failed') => {
    progress.finished += 1;
    if (status === 'failed') progress.failed += 1;
    options.onProgress(snapshot());
  };

  for (const item of options.items) {
    if (options.signal.aborted) return { kind: 'cancelled', progress: snapshot() };

    if (options.protocol === 'synchronous') {
      const result = await analyzeInterview(item.interviewId, options.studyId);
      if (options.signal.aborted) return { kind: 'cancelled', progress: snapshot() };
      if (!result.ok) return { kind: 'stopped', progress: snapshot(), error: result.error, reason: stopReason(result.kind) };
      // Busy means another run holds this interview: it is awaiting, not analyzed.
      if (result.outcome.status === 'busy') return { kind: 'awaiting', progress: snapshot(), item };
      record(result.outcome.status === 'failed' ? 'failed' : 'complete');
      continue;
    }

    let status = item.confirmed;
    // Work already scheduled is only observed. Posting for it could turn an
    // outcome that has meanwhile become uncertain into an unseen paid retry.
    if (!isActiveAnalysis(status)) {
      const action = options.keys.actionFor(item.interviewId, status.generation);
      const result = await startInterviewAnalysisV2({
        studyId: options.studyId,
        interviewId: item.interviewId,
        expectedGeneration: action.expectedGeneration,
        idempotencyKey: action.key,
        signal: options.signal,
      });
      if (options.signal.aborted) return { kind: 'cancelled', progress: snapshot() };
      options.keys.settle(item.interviewId, result);
      if (!result.ok) return { kind: 'stopped', progress: snapshot(), error: result.error, reason: stopReason(result.kind) };
      status = confirmedAnalysisFromStatus(result.outcome);
    }

    if (isActiveAnalysis(status)) {
      const waited = await waitForAnalysisOutcome({
        read: (signal) => getInterviewAnalysisStatus({ studyId: options.studyId, interviewId: item.interviewId, signal }),
        initial: status,
        signal: options.signal,
      });
      if (waited.kind === 'cancelled') return { kind: 'cancelled', progress: snapshot() };
      if (waited.kind === 'error') {
        return { kind: 'stopped', progress: snapshot(), error: waited.failure.error, reason: stopReason(waited.failure.kind) };
      }
      if (waited.kind === 'exhausted') return { kind: 'awaiting', progress: snapshot(), item };
      status = waited.status;
    }

    if (status.status === 'pending') {
      // Never scheduled after an accepted start: the server state is not what
      // this batch can explain. Stop rather than guess.
      return {
        kind: 'stopped',
        progress: snapshot(),
        error: 'The analysis result could not be confirmed. Reload the page before trying again.',
        reason: 'other',
      };
    }
    record(status.status);
  }
  return { kind: 'finished', progress: snapshot() };
}
