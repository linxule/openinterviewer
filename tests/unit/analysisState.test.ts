import { describe, expect, it } from 'vitest';
import {
  adoptAnalysisStatus,
  analysisStatus,
  confirmedAnalysisFromRecord,
  confirmedAnalysisFromStatus,
  hasScheduledAnalysis,
  isActiveAnalysis,
  isAwaitingAnalysis,
  isDurableAnalysisRecord,
  needsAnalysisRecovery,
  type ConfirmedAnalysis,
} from '@/lib/analysisState';
import type { InterviewAnalysisState } from '@/types';
import { makeStoredInterview } from '../fixtures/models';

describe('analysisState: analysisStatus', () => {
  it('returns the stored analysis status when the record carries one', () => {
    const interview = makeStoredInterview({
      analysis: { status: 'running', attempts: 1, lastAttemptAt: 1 },
    });
    expect(analysisStatus(interview)).toBe('running');
  });

  it('derives complete for a legacy record (no analysis member) that carries a synthesis', () => {
    const interview = makeStoredInterview({
      synthesis: {
        statedPreferences: [], revealedPreferences: [], themes: [],
        contradictions: [], keyInsights: [], bottomLine: 'Bottom line',
      },
    });
    expect(analysisStatus(interview)).toBe('complete');
  });

  it('derives pending for a legacy record with synthesis: null', () => {
    const interview = makeStoredInterview({ synthesis: null });
    expect(analysisStatus(interview)).toBe('pending');
  });

  it('trusts the stored analysis status even when a synthesis is also present', () => {
    const interview = makeStoredInterview({
      analysis: { status: 'failed', attempts: 2, lastAttemptAt: 1, failureKind: 'provider' },
      synthesis: null,
    });
    expect(analysisStatus(interview)).toBe('failed');
  });
});

describe('analysisState: isAwaitingAnalysis', () => {
  it('is true for pending, running, and failed', () => {
    expect(isAwaitingAnalysis(makeStoredInterview({ analysis: { status: 'pending', attempts: 0, lastAttemptAt: 1 } }))).toBe(true);
    expect(isAwaitingAnalysis(makeStoredInterview({ analysis: { status: 'running', attempts: 1, lastAttemptAt: 1 } }))).toBe(true);
    expect(isAwaitingAnalysis(makeStoredInterview({ analysis: { status: 'failed', attempts: 1, lastAttemptAt: 1 } }))).toBe(true);
  });

  it('is false for complete', () => {
    expect(isAwaitingAnalysis(makeStoredInterview({ analysis: { status: 'complete', attempts: 1, lastAttemptAt: 1 } }))).toBe(false);
  });
});

describe('analysisState: confirmed durable state (API-02, UI-CF-02)', () => {
  it('UI-CF-02: a legacy record with no job is generation 0 and never scheduled', () => {
    expect(confirmedAnalysisFromRecord(makeStoredInterview({ synthesis: null }))).toEqual({
      status: 'pending', generation: 0, phase: 'not-scheduled',
    });
    expect(confirmedAnalysisFromRecord(makeStoredInterview({
      analysis: { status: 'pending', attempts: 0, lastAttemptAt: 1 },
    }))).toEqual({ status: 'pending', generation: 0, phase: 'not-scheduled' });
  });

  it('UI-CF-02: a pending generation is queued work; running stays running', () => {
    expect(confirmedAnalysisFromRecord(makeStoredInterview({
      analysis: { status: 'pending', attempts: 0, lastAttemptAt: 1, generation: 2 },
    }))).toEqual({ status: 'pending', generation: 2, phase: 'queued' });
    expect(confirmedAnalysisFromRecord(makeStoredInterview({
      analysis: { status: 'running', attempts: 1, lastAttemptAt: 1, generation: 2 },
    }))).toEqual({ status: 'pending', generation: 2, phase: 'running' });
  });

  it('UI-CF-02: recovery-required failures keep their flag; ordinary ones do not gain it', () => {
    const recovery = makeStoredInterview({
      analysis: { status: 'failed', attempts: 1, lastAttemptAt: 1, generation: 3, failureKind: 'timeout', recoveryRequired: true },
    });
    expect(confirmedAnalysisFromRecord(recovery)).toEqual({
      status: 'failed', generation: 3, failureKind: 'timeout', recoveryRequired: true,
    });
    expect(needsAnalysisRecovery(recovery)).toBe(true);

    const ordinary = makeStoredInterview({
      analysis: { status: 'failed', attempts: 1, lastAttemptAt: 1, failureKind: 'provider' },
    });
    expect(confirmedAnalysisFromRecord(ordinary)).toEqual({
      status: 'failed', generation: 0, failureKind: 'provider', recoveryRequired: false,
    });
    expect(needsAnalysisRecovery(ordinary)).toBe(false);
  });

  it('API-02: already-complete folds into complete and polling hints are dropped', () => {
    expect(confirmedAnalysisFromStatus({ status: 'already-complete', generation: 2 })).toEqual({ status: 'complete', generation: 2 });
    expect(confirmedAnalysisFromStatus({ status: 'pending', generation: 2, phase: 'queued', pollAfterMs: 2000 }))
      .toEqual({ status: 'pending', generation: 2, phase: 'queued' });
  });

  it('API-03: only scheduled, unfinished work is active', () => {
    expect(isActiveAnalysis({ status: 'pending', generation: 1, phase: 'queued' })).toBe(true);
    expect(isActiveAnalysis({ status: 'pending', generation: 1, phase: 'running' })).toBe(true);
    expect(isActiveAnalysis({ status: 'pending', generation: 0, phase: 'not-scheduled' })).toBe(false);
    expect(isActiveAnalysis({ status: 'complete', generation: 1 })).toBe(false);
    expect(isActiveAnalysis(null)).toBe(false);
  });
});

describe('analysisState: batch eligibility (API-04, IMPLEMENTATION.md F8)', () => {
  it('API-04: only records carrying a generation are durable', () => {
    expect(isDurableAnalysisRecord(makeStoredInterview({ synthesis: null }))).toBe(false);
    expect(isDurableAnalysisRecord(makeStoredInterview({
      analysis: { status: 'running', attempts: 1, lastAttemptAt: 1 },
    }))).toBe(false);
    expect(isDurableAnalysisRecord(makeStoredInterview({
      analysis: { status: 'pending', attempts: 0, lastAttemptAt: 1, generation: 0 },
    }))).toBe(true);
  });

  it('API-04: durable queued and running work is scheduled; not-scheduled and failed work is not', () => {
    const at = (analysis: InterviewAnalysisState) => makeStoredInterview({ analysis });
    expect(hasScheduledAnalysis(at({ status: 'pending', attempts: 0, lastAttemptAt: 1, generation: 2 }))).toBe(true);
    expect(hasScheduledAnalysis(at({ status: 'running', attempts: 1, lastAttemptAt: 1, generation: 2 }))).toBe(true);
    expect(hasScheduledAnalysis(at({ status: 'pending', attempts: 0, lastAttemptAt: 1, generation: 0 }))).toBe(false);
    expect(hasScheduledAnalysis(at({
      status: 'failed', attempts: 1, lastAttemptAt: 1, generation: 2, failureKind: 'timeout', recoveryRequired: true,
    }))).toBe(false);
    expect(hasScheduledAnalysis(at({ status: 'complete', attempts: 1, lastAttemptAt: 1, generation: 2 }))).toBe(false);
  });

  it('API-04: a Node running record keeps its legacy batch eligibility', () => {
    expect(hasScheduledAnalysis(makeStoredInterview({
      analysis: { status: 'running', attempts: 1, lastAttemptAt: 1, claimedAt: 1 },
    }))).toBe(false);
  });
});

describe('analysisState: monotonic adoption (API-03)', () => {
  const queued2: ConfirmedAnalysis = { status: 'pending', generation: 2, phase: 'queued' };
  const running2: ConfirmedAnalysis = { status: 'pending', generation: 2, phase: 'running' };
  const complete2: ConfirmedAnalysis = { status: 'complete', generation: 2 };
  const failed2: ConfirmedAnalysis = { status: 'failed', generation: 2, failureKind: 'provider', recoveryRequired: false };
  const queued3: ConfirmedAnalysis = { status: 'pending', generation: 3, phase: 'queued' };

  it('API-03: adopts a newer generation, even over a persisted outcome', () => {
    expect(adoptAnalysisStatus(complete2, queued3)).toBe(queued3);
    expect(adoptAnalysisStatus(failed2, queued3)).toBe(queued3);
  });

  it('API-03: rejects a response older than the displayed generation', () => {
    expect(adoptAnalysisStatus(queued3, complete2)).toBe(queued3);
    expect(adoptAnalysisStatus(queued3, failed2)).toBe(queued3);
  });

  it('API-03: never regresses a persisted outcome to pending within a generation', () => {
    expect(adoptAnalysisStatus(complete2, running2)).toBe(complete2);
    expect(adoptAnalysisStatus(failed2, queued2)).toBe(failed2);
  });

  it('API-03: accepts phase changes and outcomes within the same generation', () => {
    expect(adoptAnalysisStatus(queued2, running2)).toBe(running2);
    expect(adoptAnalysisStatus(running2, complete2)).toBe(complete2);
    expect(adoptAnalysisStatus(null, running2)).toBe(running2);
  });
});
