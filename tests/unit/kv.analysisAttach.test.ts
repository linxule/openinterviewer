// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import type { RedisPort } from '@/lib/redisPort';
import {
  attachInterviewAnalysis,
  claimInterviewAnalysis,
  MAX_ATTACHED_SYNTHESIS_BYTES,
  recordInterviewAnalysisFailure,
} from '@/lib/kv';
import { makeStoredInterview } from '../fixtures/models';

function fixtureSynthesis() {
  return {
    statedPreferences: [], revealedPreferences: [], themes: [],
    contradictions: [], keyInsights: [], bottomLine: 'Bottom line',
  };
}

function encodedInterview(overrides: Record<string, unknown> = {}) {
  const interview = makeStoredInterview({ id: 'interview-a', status: 'completed', ...overrides });
  return `oi:interview:${JSON.stringify(interview)}`;
}

describe('kv.analysisAttach: claimInterviewAnalysis', () => {
  it('sends one eval with exactly one key and the claim op', async () => {
    const evalMock = vi.fn().mockResolvedValue(['oi:analysis-claimed', 'claim-1']);
    const client = {
      get: vi.fn().mockResolvedValue(encodedInterview()),
      eval: evalMock,
    } as unknown as RedisPort;

    const result = await claimInterviewAnalysis('interview-a', client);

    // The wire's `claimed` payload (the mock's 'claim-1') is what the caller
    // gets back — the CAS token is authoritative from Redis, not the id the
    // caller happened to generate for this attempt.
    expect(result).toEqual({ status: 'claimed', claimId: 'claim-1', attempts: 1 });
    expect(evalMock).toHaveBeenCalledTimes(1);
    const [, keys, args] = evalMock.mock.calls[0] as [string, string[], string[]];
    expect(keys).toEqual(['interview:interview-a']);
    expect(args[0]).toBe('claim');
    expect(args[1]).toBe('interview-a');
    expect(typeof args[4]).toBe('string');
    expect(args[4].length).toBeGreaterThan(0);
  });

  it('maps each documented claim outcome', async () => {
    const client = (tag: string) => ({
      get: vi.fn().mockResolvedValue(encodedInterview()),
      eval: vi.fn().mockResolvedValue([tag]),
    }) as unknown as RedisPort;

    await expect(claimInterviewAnalysis('interview-a', client('oi:analysis-busy')))
      .resolves.toEqual({ status: 'busy' });
    await expect(claimInterviewAnalysis('interview-a', client('oi:analysis-done')))
      .resolves.toEqual({ status: 'already-complete' });
    await expect(claimInterviewAnalysis('interview-a', client('oi:analysis-notfound')))
      .resolves.toEqual({ status: 'not-found' });
  });

  it('maps an unknown tag to unavailable', async () => {
    const client = {
      get: vi.fn().mockResolvedValue(encodedInterview()),
      eval: vi.fn().mockResolvedValue(['oi:something-else']),
    } as unknown as RedisPort;

    await expect(claimInterviewAnalysis('interview-a', client)).resolves.toEqual({ status: 'unavailable' });
  });

  it('rejects a malformed interview id without constructing a key', async () => {
    const evalMock = vi.fn();
    const client = { get: vi.fn(), eval: evalMock } as unknown as RedisPort;

    await expect(claimInterviewAnalysis('../not an id', client)).resolves.toEqual({ status: 'unavailable' });
    expect(evalMock).not.toHaveBeenCalled();
  });

  it('reports not-found when the interview does not exist', async () => {
    const evalMock = vi.fn();
    const client = { get: vi.fn().mockResolvedValue(null), eval: evalMock } as unknown as RedisPort;

    await expect(claimInterviewAnalysis('interview-a', client)).resolves.toEqual({ status: 'not-found' });
    expect(evalMock).not.toHaveBeenCalled();
  });
});

describe('kv.analysisAttach: attachInterviewAnalysis', () => {
  it('refuses an oversized synthesis before resolving a client — zero Redis round trips', async () => {
    const get = vi.fn();
    const evalMock = vi.fn();
    const client = { get, eval: evalMock } as unknown as RedisPort;
    const oversized = {
      ...fixtureSynthesis(),
      bottomLine: 'x'.repeat(MAX_ATTACHED_SYNTHESIS_BYTES + 1),
    };

    const result = await attachInterviewAnalysis({
      interviewId: 'interview-a',
      claimId: 'claim-1',
      synthesis: oversized,
      provenance: { aiProvider: 'gemini', aiModel: 'gemini-3.7-flash', requestedAiModel: 'gemini-3.7-flash' },
      studyRevision: 1,
    }, client);

    expect(result).toEqual({ status: 'too-large' });
    expect(get).not.toHaveBeenCalled();
    expect(evalMock).not.toHaveBeenCalled();
  });

  it('maps each documented attach outcome', async () => {
    const client = (tag: string) => ({
      get: vi.fn().mockResolvedValue(encodedInterview({
        analysis: { status: 'running', attempts: 1, lastAttemptAt: 1, claimId: 'claim-1', claimedAt: 1 },
      })),
      eval: vi.fn().mockResolvedValue([tag]),
    }) as unknown as RedisPort;

    const input = {
      interviewId: 'interview-a',
      claimId: 'claim-1',
      synthesis: fixtureSynthesis(),
      provenance: { aiProvider: 'gemini' as const, aiModel: 'gemini-3.7-flash', requestedAiModel: 'gemini-3.7-flash' },
      studyRevision: 1,
    };

    await expect(attachInterviewAnalysis(input, client('oi:analysis-written'))).resolves.toEqual({ status: 'written' });
    await expect(attachInterviewAnalysis(input, client('oi:analysis-done'))).resolves.toEqual({ status: 'already-complete' });
    await expect(attachInterviewAnalysis(input, client('oi:analysis-stale'))).resolves.toEqual({ status: 'stale' });
    await expect(attachInterviewAnalysis(input, client('oi:analysis-notfound'))).resolves.toEqual({ status: 'not-found' });
  });

  it('maps an unknown wire tag to unavailable', async () => {
    const client = {
      get: vi.fn().mockResolvedValue(encodedInterview({
        analysis: { status: 'running', attempts: 1, lastAttemptAt: 1, claimId: 'claim-1', claimedAt: 1 },
      })),
      eval: vi.fn().mockResolvedValue(['oi:not-a-real-tag']),
    } as unknown as RedisPort;

    await expect(attachInterviewAnalysis({
      interviewId: 'interview-a',
      claimId: 'claim-1',
      synthesis: fixtureSynthesis(),
      provenance: { aiProvider: 'gemini', aiModel: 'gemini-3.7-flash', requestedAiModel: 'gemini-3.7-flash' },
      studyRevision: 1,
    }, client)).resolves.toEqual({ status: 'unavailable' });
  });
});

describe('kv.analysisAttach: recordInterviewAnalysisFailure', () => {
  it('maps oi:analysis-recorded to written', async () => {
    const client = {
      get: vi.fn().mockResolvedValue(encodedInterview({
        analysis: { status: 'running', attempts: 1, lastAttemptAt: 1, claimId: 'claim-1', claimedAt: 1 },
      })),
      eval: vi.fn().mockResolvedValue(['oi:analysis-recorded']),
    } as unknown as RedisPort;

    await expect(recordInterviewAnalysisFailure('interview-a', 'claim-1', 'provider', client))
      .resolves.toEqual({ status: 'written' });
  });
});
