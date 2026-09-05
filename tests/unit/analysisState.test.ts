import { describe, expect, it } from 'vitest';
import { analysisStatus, isAwaitingAnalysis } from '@/lib/analysisState';
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
