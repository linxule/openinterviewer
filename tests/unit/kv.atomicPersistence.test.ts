// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RedisPort } from '@/lib/redisPort';
import { RedisCommitAmbiguousError } from '@/lib/redisPort';
import {
  getStudyChecked,
  createStudyAtomic,
  deleteStudy,
  persistCompletedInterview,
  persistCompletedInterviewP1,
  persistCompletedInterviewFinish,
  replaceStudyConfigAtomic,
  settleStudyOperationMutation,
  setStudyLinksEnabled,
  encodePersistingGuard,
  PERSIST_COMPLETED_INTERVIEW_P1_SCRIPT,
  PERSIST_COMPLETED_INTERVIEW_FINISH_SCRIPT,
  type PersistingGuard,
} from '@/lib/kv';
import { makeStoredInterview, makeStoredStudy } from '../fixtures/models';

const FINGERPRINT = 'ab'.repeat(32);

function ratePlan(studyId = 'study-atomic') {
  return [
    { key: `interview-rate:session:${studyId}:0`, maximum: 2, windowSeconds: 86_400, windowStart: 0 },
    { key: `interview-rate:study:${studyId}:0`, maximum: 2_000, windowSeconds: 86_400, windowStart: 0 },
  ];
}

function makeGuard(overrides: Partial<PersistingGuard> = {}): PersistingGuard {
  return {
    version: 2,
    interviewId: 'interview-atomic',
    studyId: 'study-atomic',
    fingerprint: FINGERPRINT,
    expectedRevision: 3,
    deploymentMode: 'standalone',
    ratePlan: ratePlan(),
    identity: { participantSessionId: 'session-a', linkId: 'link-a' },
    frozenUpdatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('completed interview storage boundary', () => {
  it.each([
    [['oi:persist-created'], 'created'],
    [['oi:persist-duplicate'], 'duplicate'],
    [['oi:persist-conflict'], 'conflict'],
    [['oi:persist-not-found'], 'study-not-found'],
    [['oi:persist-links'], 'links-disabled'],
    [['oi:persist-revision'], 'revision-stale'],
    [['oi:persist-rate'], 'rate-limited'],
    [['oi:persist-guard'], 'persist-guard'],
  ] as const)('maps Redis result %j to %s', async (redisResult, expectedStatus) => {
    const evalMock = vi.fn().mockResolvedValue(redisResult);
    const client = { eval: evalMock } as unknown as RedisPort;
    const interview = makeStoredInterview({ id: 'interview-atomic', studyId: 'study-atomic' });

    const result = await persistCompletedInterviewP1(
      interview,
      FINGERPRINT,
      {
        expectedStudyRevision: 3,
        rateLimits: ratePlan(),
        identity: { participantSessionId: 'session-a', linkId: 'link-a' },
      },
      client
    );

    expect(result).toEqual({ status: expectedStatus });
    expect(evalMock).toHaveBeenCalledTimes(1);
    const [script, keys, args] = evalMock.mock.calls[0] as [string, string[], string[]];
    expect(script).toBe(PERSIST_COMPLETED_INTERVIEW_P1_SCRIPT);
    expect(script).toContain("redis.call('SET', KEYS[1], ARGV[1], 'NX')");
    expect(script).toContain("redis.call('ZCARD', rateKey)");
    expect(script).toContain("redis.call('ZSCORE', rateKey, ARGV[4])");
    expect(script).not.toContain("redis.call('INCR'");
    expect(script).not.toContain('study.interviewCount = redis.call');
    expect(keys).toEqual([
      'interview:interview-atomic',
      'interview-fingerprint:interview-atomic',
      'interview-persisting:interview-atomic',
      'study-persisting:study-atomic',
      'study:study-atomic',
      'study-mutation-guard:study-atomic',
      'study-interviews:study-atomic',
      'interview-rate:session:study-atomic:0',
      'interview-rate:study:study-atomic:0',
      '',
      '',
      'all-interviews',
    ]);
    expect(args[1]).toBe(`oi:fp:${FINGERPRINT}`);
    expect(args[4]).toBe('3');
    expect(args[6]).toBe('standalone');
  });

  it('omits all-interviews on hosted P1 and Finish', async () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'hosted');
    const evalMock = vi.fn().mockResolvedValue(['oi:persist-started']);
    const client = { eval: evalMock } as unknown as RedisPort;

    await persistCompletedInterviewP1(
      makeStoredInterview({ id: 'interview-hosted', studyId: 'study-hosted' }),
      FINGERPRINT,
      {
        expectedStudyRevision: 1,
        rateLimits: ratePlan('study-hosted'),
        identity: { participantSessionId: null, linkId: null },
      },
      client
    );

    const keys = evalMock.mock.calls[0][1] as string[];
    expect(keys).not.toContain('all-interviews');
    expect(keys).toHaveLength(11);
  });

  it('Finish ZADDs once, derives lock/count, and deletes the guard last', async () => {
    const evalMock = vi.fn().mockResolvedValue(['oi:persist-created']);
    const client = { eval: evalMock } as unknown as RedisPort;
    const result = await persistCompletedInterviewFinish(makeGuard(), client);

    expect(result).toEqual({ status: 'created' });
    const [script, keys] = evalMock.mock.calls[0] as [string, string[]];
    expect(script).toBe(PERSIST_COMPLETED_INTERVIEW_FINISH_SCRIPT);
    expect(script).toContain('fault cut F1');
    expect(script).toContain('fault cut F2');
    expect(script).toContain('fault cut F3');
    expect(script).toContain('fault cut F4');
    expect(script).toContain('fault cut F5');
    expect(script).toContain("redis.call('SADD', KEYS[7], ARGV[2])");
    expect(script).toContain("redis.call('SADD', KEYS[12], ARGV[2])");
    expect(script).toContain("study.interviewCount = redis.call('SCARD', KEYS[7])");
    expect(script).toContain('study.isLocked = true');
    expect(script).toContain("redis.call('ZADD', rateKey, 1, ARGV[2])");
    expect(script).toContain('window + 60');
    expect(script.indexOf("redis.call('DEL', KEYS[3])")).toBeGreaterThan(script.indexOf('fault cut F5'));
    expect(script).not.toContain("redis.call('INCR'");
    expect(keys[keys.length - 1]).toBe('all-interviews');
  });

  it('does not compare request Date.now when proving duplicate equivalence', () => {
    expect(PERSIST_COMPLETED_INTERVIEW_FINISH_SCRIPT).toContain('valid_immutable');
    expect(PERSIST_COMPLETED_INTERVIEW_FINISH_SCRIPT).not.toContain('Date.now');
    expect(PERSIST_COMPLETED_INTERVIEW_FINISH_SCRIPT).not.toContain('completedAt ==');
    expect(PERSIST_COMPLETED_INTERVIEW_P1_SCRIPT).not.toContain('Date.now');
  });

  it('runs Finish after P1 using the frozen guard, not a newly minted timestamp', async () => {
    const guard = makeGuard();
    const evalMock = vi.fn()
      .mockResolvedValueOnce(['oi:persist-started'])
      .mockResolvedValueOnce(['oi:persist-created']);
    const client = {
      eval: evalMock,
      get: vi.fn().mockResolvedValue(encodePersistingGuard(guard)),
    } as unknown as RedisPort;

    const result = await persistCompletedInterview(
      makeStoredInterview({ id: 'interview-atomic', studyId: 'study-atomic' }),
      FINGERPRINT,
      {
        expectedStudyRevision: 3,
        rateLimits: ratePlan(),
        identity: { participantSessionId: 'session-a', linkId: 'link-a' },
      },
      client
    );

    expect(result).toEqual({ status: 'created' });
    expect(evalMock).toHaveBeenCalledTimes(2);
    expect(evalMock.mock.calls[1][0]).toBe(PERSIST_COMPLETED_INTERVIEW_FINISH_SCRIPT);
    expect(evalMock.mock.calls[1][2][2]).toBe('3');
  });

  it('returns unavailable when the single atomic operation fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = {
      eval: vi.fn().mockRejectedValue(new Error('redis unavailable')),
    } as unknown as RedisPort;

    const result = await persistCompletedInterview(
      makeStoredInterview({ id: 'interview-down', studyId: 'study-down' }),
      FINGERPRINT,
      { expectedStudyRevision: 1, rateLimits: ratePlan('study-down') },
      client
    );

    expect(result).toEqual({ status: 'unavailable' });
    expect(errorSpy).toHaveBeenCalled();
  });

  it('does not translate may-have-committed into a definite refusal', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = {
      eval: vi.fn().mockRejectedValue(new RedisCommitAmbiguousError('may-have-committed')),
    } as unknown as RedisPort;

    await expect(persistCompletedInterviewP1(
      makeStoredInterview({ id: 'interview-amb', studyId: 'study-amb' }),
      FINGERPRINT,
      { expectedStudyRevision: 1, rateLimits: ratePlan('study-amb') },
      client
    )).resolves.toEqual({ status: 'ambiguous' });
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('checked study reads', () => {
  it('distinguishes storage failure from a genuine missing study', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const unavailableClient = {
      get: vi.fn().mockRejectedValue(new Error('redis unavailable')),
    } as unknown as RedisPort;
    const missingClient = {
      get: vi.fn().mockResolvedValue(null),
    } as unknown as RedisPort;

    await expect(getStudyChecked('study-down', unavailableClient)).resolves.toEqual({
      status: 'unavailable',
    });
    await expect(getStudyChecked('study-missing', missingClient)).resolves.toEqual({
      status: 'not-found',
    });
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('atomic study mutations', () => {
  it('creates a study and its index entry in one Redis script', async () => {
    const evalMock = vi.fn().mockResolvedValue(['oi:created']);
    const client = {
      eval: evalMock,
      get: vi.fn().mockResolvedValue(null),
    } as unknown as RedisPort;
    const study = makeStoredStudy({ id: 'study-create', createdAt: 10 });

    await expect(createStudyAtomic(study, client)).resolves.toBe('created');

    const [script, keys] = evalMock.mock.calls[0] as [string, string[]];
    expect(script).toContain("redis.call('SET', KEYS[1], ARGV[1])");
    expect(script).toContain("redis.call('SADD', KEYS[2], ARGV[2])");
    expect(script).toContain('fault cut S2');
    expect(keys).toEqual([
      'study:study-create',
      'all-studies',
      'study-operation-result:create:study-create:10',
      'study-mutation-guard:study-create',
      'study-persisting:study-create',
    ]);
  });

  it('atomically records a hosted create result and respects reconciliation cancellation', async () => {
    const evalMock = vi.fn().mockResolvedValue(['oi:cancelled']);
    const client = {
      eval: evalMock,
      get: vi.fn().mockResolvedValue(null),
    } as unknown as RedisPort;
    const study = makeStoredStudy({ id: 'study-create' });

    await expect(createStudyAtomic(
      study,
      client,
      'create:study-create:123'
    )).resolves.toBe('cancelled');

    const [script, keys, args] = evalMock.mock.calls[0] as [string, string[], string[]];
    expect(script).toContain("receipt_resolution");
    expect(script).toContain("redis.call('SET', KEYS[3], ARGV[4], 'EX', 604800)");
    expect(keys[2]).toBe('study-operation-result:create:study-create:123');
    expect(args[2]).toBe('create:study-create:123');
  });

  it('maps T0c.1 link mutation output and refuses coerced study objects', async () => {
    const updated = makeStoredStudy({
      id: 'study-links',
      interviewCount: 4,
      isLocked: true,
    });
    updated.config.linksEnabled = false;
    const evalMock = vi.fn().mockResolvedValue(['oi:updated', `oi:json:${JSON.stringify(updated)}`]);
    const client = { eval: evalMock } as unknown as RedisPort;

    await expect(setStudyLinksEnabled('study-links', false, client)).resolves.toEqual({
      status: 'updated',
      study: updated,
    });

    const [script, keys] = evalMock.mock.calls[0] as [string, string[]];
    expect(script).toContain('study.config.linksEnabled');
    expect(script).toContain("return {'oi:updated', 'oi:json:' .. cjson.encode(study)}");
    expect(script).not.toContain('study.interviewCount =');
    expect(keys).toEqual([
      'study:study-links',
      'study-persisting:study-links',
      'study-mutation-guard:study-links',
    ]);

    evalMock.mockResolvedValueOnce(updated);
    await expect(setStudyLinksEnabled('study-links', false, client)).resolves.toEqual({
      status: 'unavailable',
    });
  });

  it('uses compare-and-set for config replacement and preserves server metadata', async () => {
    const before = makeStoredStudy({
      id: 'study-config',
      interviewCount: 2,
      isLocked: true,
      updatedAt: 100,
      revision: 7,
    });
    const updated = { ...before, config: { ...before.config, name: 'Updated' }, updatedAt: 200 };
    const evalMock = vi.fn().mockResolvedValue(['oi:updated', `oi:json:${JSON.stringify(updated)}`]);
    const client = { eval: evalMock } as unknown as RedisPort;

    await expect(
      replaceStudyConfigAtomic('study-config', 7, updated.config, client)
    ).resolves.toEqual({ status: 'updated', study: updated });

    const [script, keys] = evalMock.mock.calls[0] as [string, string[]];
    expect(script).toContain('(tonumber(study.revision) or 1) ~= tonumber(ARGV[1])');
    expect(script).toContain('pcall(cjson.decode, ARGV[2])');
    expect(script).toContain('study.config = config');
    expect(script).toContain("return {'oi:updated', 'oi:json:' .. cjson.encode(study)}");
    expect(script).not.toContain('study.interviewCount =');
    expect(script).not.toContain('study.isLocked =');
    expect(keys).toEqual([
      'study:study-config',
      'study-persisting:study-config',
      'study-mutation-guard:study-config',
    ]);

    evalMock.mockResolvedValueOnce([1, updated]);
    await expect(
      replaceStudyConfigAtomic('study-config', 7, updated.config, client)
    ).resolves.toEqual({ status: 'unavailable' });
  });

  it('checks for interviews and deletes the study in one Redis script', async () => {
    const evalMock = vi.fn().mockResolvedValue(['oi:deleted']);
    const client = {
      eval: evalMock,
      get: vi.fn().mockResolvedValue(null),
    } as unknown as RedisPort;

    await expect(deleteStudy('study-delete', client)).resolves.toEqual({
      status: 'deleted',
      success: true,
    });

    expect(evalMock).toHaveBeenCalledTimes(1);
    const [script, keys] = evalMock.mock.calls[0] as [string, string[]];
    expect(script).toContain("redis.call('SCARD', KEYS[6])");
    expect(script).toContain("redis.call('DEL', KEYS[1])");
    expect(script).toContain('fault cut D1');
    expect(keys).toEqual([
      'study:study-delete',
      'study-interviews:study-delete',
      'all-studies',
      'study-operation-result:delete:study-delete:0',
      'study-mutation-guard:study-delete',
      'study-persisting:study-delete',
    ]);
  });

  it('installs the inverse tombstone atomically before platform rollback', async () => {
    const evalMock = vi.fn().mockResolvedValue(['oi:cancelled']);
    const client = { eval: evalMock } as unknown as RedisPort;

    await expect(settleStudyOperationMutation(
      'delete',
      'study-delete',
      'delete:study-delete:123',
      client
    )).resolves.toBe('mutation-cancelled');

    const [script, keys] = evalMock.mock.calls[0] as [string, string[]];
    expect(script).toContain("oi:receipt:");
    expect(script).toContain("redis.call('SET', KEYS[2], ARGV[3], 'EX', 604800)");
    expect(keys).toEqual([
      'study:study-delete',
      'study-operation-result:delete:study-delete:123',
      'study-mutation-guard:study-delete',
    ]);
  });
});
