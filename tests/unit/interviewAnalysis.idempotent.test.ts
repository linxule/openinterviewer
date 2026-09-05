// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredInterview, makeStudyConfig } from '../fixtures/models';

/**
 * runInterviewAnalysis's concurrency contract, against mocked kv primitives.
 * The claim CAS (kv.ts) is the real gate under real Redis; here we drive its
 * documented outcomes directly to pin the caller's behaviour around it.
 */

const kvMock = vi.hoisted(() => ({
  claimInterviewAnalysis: vi.fn(),
  getInterviewChecked: vi.fn(),
  attachInterviewAnalysis: vi.fn(),
  recordInterviewAnalysisFailure: vi.fn(),
}));
vi.mock('@/lib/kv', () => kvMock);

const synthesizeInterview = vi.hoisted(() => vi.fn());
vi.mock('@/lib/providers', () => ({
  getInterviewProvider: vi.fn(() => ({ synthesizeInterview })),
}));

import { runInterviewAnalysis } from '@/lib/interviewAnalysis';

const study = { ...makeStudyConfig(), aiProvider: 'gemini' as const, aiModel: 'gemini-3.7-flash' };
const storedStudy = {
  id: study.id, config: study, createdAt: 1, updatedAt: 1,
  interviewCount: 1, isLocked: true, revision: 2,
};

function providerResult(overrides: Record<string, unknown> = {}) {
  return {
    value: {
      statedPreferences: [], revealedPreferences: [], themes: [],
      contradictions: [], keyInsights: [], bottomLine: 'Bottom line',
    },
    execution: {
      provider: 'gemini', requestedModel: 'gemini-3.7-flash', model: 'gemini-3.7-flash',
    },
    ...overrides,
  };
}

const baseInput = () => ({
  interviewId: 'interview-a',
  study: storedStudy,
  kvClient: {} as never,
  providerKeys: {},
});

beforeEach(() => {
  vi.clearAllMocks();
  kvMock.getInterviewChecked.mockResolvedValue({ status: 'found', interview: makeStoredInterview({ id: 'interview-a' }) });
});

describe('runInterviewAnalysis: concurrency', () => {
  it('two racing calls produce exactly one synthesizeInterview and one attachInterviewAnalysis; the loser gets busy with no second write', async () => {
    kvMock.claimInterviewAnalysis
      .mockResolvedValueOnce({ status: 'claimed', claimId: 'claim-1', attempts: 1 })
      .mockResolvedValueOnce({ status: 'busy' });
    synthesizeInterview.mockResolvedValue(providerResult());
    kvMock.attachInterviewAnalysis.mockResolvedValue({ status: 'written' });

    const [a, b] = await Promise.all([
      runInterviewAnalysis(baseInput()),
      runInterviewAnalysis(baseInput()),
    ]);

    expect([a.status, b.status].sort()).toEqual(['busy', 'complete']);
    expect(synthesizeInterview).toHaveBeenCalledTimes(1);
    expect(kvMock.attachInterviewAnalysis).toHaveBeenCalledTimes(1);
  });

  it('an attach that returns stale makes no second write attempt', async () => {
    kvMock.claimInterviewAnalysis.mockResolvedValue({ status: 'claimed', claimId: 'claim-1', attempts: 1 });
    synthesizeInterview.mockResolvedValue(providerResult());
    kvMock.attachInterviewAnalysis.mockResolvedValue({ status: 'stale' });

    const result = await runInterviewAnalysis(baseInput());

    expect(result).toEqual({ status: 'busy' });
    expect(kvMock.attachInterviewAnalysis).toHaveBeenCalledTimes(1);
    expect(kvMock.recordInterviewAnalysisFailure).not.toHaveBeenCalled();
  });

  it('a run against an already-complete record makes no provider call at all', async () => {
    kvMock.claimInterviewAnalysis.mockResolvedValue({ status: 'already-complete' });

    const result = await runInterviewAnalysis(baseInput());

    expect(result).toEqual({ status: 'already-complete' });
    expect(synthesizeInterview).not.toHaveBeenCalled();
    expect(kvMock.getInterviewChecked).not.toHaveBeenCalled();
  });
});

describe('runInterviewAnalysis: failure classification', () => {
  it('a provider throw records failureKind provider, and the thrown value reaches nowhere near the record', async () => {
    kvMock.claimInterviewAnalysis.mockResolvedValue({ status: 'claimed', claimId: 'claim-1', attempts: 1 });
    const secretError = new Error('super secret upstream body: sk-abc123');
    synthesizeInterview.mockRejectedValue(secretError);

    const result = await runInterviewAnalysis(baseInput());

    expect(result).toEqual({ status: 'failed', failureKind: 'provider' });
    expect(kvMock.recordInterviewAnalysisFailure).toHaveBeenCalledWith('interview-a', 'claim-1', 'provider', {});
    // The thrown error itself is never among the failure-recording arguments.
    for (const call of kvMock.recordInterviewAnalysisFailure.mock.calls) {
      expect(call).not.toContain(secretError);
      expect(JSON.stringify(call)).not.toContain('sk-abc123');
    }
  });

  it('a validation throw (unnamed provider/model) records invalid-output', async () => {
    kvMock.claimInterviewAnalysis.mockResolvedValue({ status: 'claimed', claimId: 'claim-1', attempts: 1 });
    synthesizeInterview.mockResolvedValue(providerResult({
      execution: { provider: 'gemini', requestedModel: '', model: '' },
    }));

    const result = await runInterviewAnalysis(baseInput());

    expect(result).toEqual({ status: 'failed', failureKind: 'invalid-output' });
    expect(kvMock.recordInterviewAnalysisFailure).toHaveBeenCalledWith('interview-a', 'claim-1', 'invalid-output', {});
    expect(kvMock.attachInterviewAnalysis).not.toHaveBeenCalled();
  });

  it('an oversized synthesis (attach: too-large) records too-large and never reaches the wire beyond the attach call', async () => {
    kvMock.claimInterviewAnalysis.mockResolvedValue({ status: 'claimed', claimId: 'claim-1', attempts: 1 });
    synthesizeInterview.mockResolvedValue(providerResult());
    kvMock.attachInterviewAnalysis.mockResolvedValue({ status: 'too-large' });

    const result = await runInterviewAnalysis(baseInput());

    expect(result).toEqual({ status: 'failed', failureKind: 'too-large' });
    expect(kvMock.recordInterviewAnalysisFailure).toHaveBeenCalledWith('interview-a', 'claim-1', 'too-large', {});
  });

  it('a vanished record between claim and read is not-found, with no provider call', async () => {
    kvMock.claimInterviewAnalysis.mockResolvedValue({ status: 'claimed', claimId: 'claim-1', attempts: 1 });
    kvMock.getInterviewChecked.mockResolvedValue({ status: 'not-found' });

    const result = await runInterviewAnalysis(baseInput());

    expect(result).toEqual({ status: 'not-found' });
    expect(synthesizeInterview).not.toHaveBeenCalled();
  });
});
