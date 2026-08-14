// @vitest-environment node

import { Redis } from '@upstash/redis';
import { describe, expect, it, vi } from 'vitest';
import {
  getStudyChecked,
  createStudyAtomic,
  deleteStudy,
  persistCompletedInterview,
  replaceStudyConfigAtomic,
  settleStudyOperationMutation,
  setStudyLinksEnabled,
} from '@/lib/kv';
import { makeStoredInterview, makeStoredStudy } from '../fixtures/models';

describe('completed interview storage boundary', () => {
  it.each([
    [1, 'created'],
    [0, 'duplicate'],
    [-1, 'conflict'],
    [-2, 'study-not-found'],
    [-3, 'links-disabled'],
    [-4, 'revision-stale'],
    [-5, 'rate-limited'],
  ] as const)('maps Redis result %s to %s', async (redisResult, expectedStatus) => {
    const evalMock = vi.fn().mockResolvedValue(redisResult);
    const client = { eval: evalMock } as unknown as Redis;
    const interview = makeStoredInterview({ id: 'interview-atomic', studyId: 'study-atomic' });

    const result = await persistCompletedInterview(
      interview,
      'fingerprint',
      { expectedStudyRevision: 3 },
      client
    );

    expect(result).toEqual({ status: expectedStatus });
    expect(evalMock).toHaveBeenCalledTimes(1);
    const [script, keys, args] = evalMock.mock.calls[0] as [string, string[], string[]];
    expect(script).toContain("redis.call('SET', KEYS[1], ARGV[1])");
    expect(script).toContain("study.interviewCount = redis.call('SCARD', KEYS[2])");
    expect(script).toContain('study.isLocked = true');
    expect(script).toContain('currentRevision ~= tonumber(ARGV[6])');
    expect(keys).toEqual([
      'interview:interview-atomic',
      'study-interviews:study-atomic',
      'all-interviews',
      'study:study-atomic',
      'interview-fingerprint:interview-atomic',
    ]);
    expect(args[1]).toBe('fingerprint');
    expect(args[5]).toBe('3');
    expect(args[6]).toBe('0');
  });

  it('checks and consumes save quotas inside the same commit script', async () => {
    const evalMock = vi.fn().mockResolvedValue(1);
    const client = { eval: evalMock } as unknown as Redis;

    await persistCompletedInterview(
      makeStoredInterview({ id: 'interview-limited', studyId: 'study-limited' }),
      'fingerprint',
      {
        expectedStudyRevision: 2,
        rateLimits: [
          { key: 'rate:session', maximum: 2, windowSeconds: 86_400 },
          { key: 'rate:study', maximum: 2_000, windowSeconds: 86_400 },
        ],
      },
      client
    );

    const [script, keys, args] = evalMock.mock.calls[0] as [string, string[], string[]];
    expect(script.indexOf('existingFingerprint')).toBeLessThan(script.indexOf('rateLimitCount'));
    expect(script).toContain("redis.call('INCR', KEYS[5 + i])");
    expect(keys.slice(5)).toEqual(['rate:session', 'rate:study']);
    expect(args.slice(6)).toEqual(['2', '2', '86400', '2000', '86400']);
  });

  it('returns unavailable when the single atomic operation fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = {
      eval: vi.fn().mockRejectedValue(new Error('redis unavailable')),
    } as unknown as Redis;

    const result = await persistCompletedInterview(
      makeStoredInterview({ id: 'interview-down', studyId: 'study-down' }),
      'fingerprint',
      { expectedStudyRevision: 1 },
      client
    );

    expect(result).toEqual({ status: 'unavailable' });
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('checked study reads', () => {
  it('distinguishes storage failure from a genuine missing study', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const unavailableClient = {
      get: vi.fn().mockRejectedValue(new Error('redis unavailable')),
    } as unknown as Redis;
    const missingClient = {
      get: vi.fn().mockResolvedValue(null),
    } as unknown as Redis;

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
    const evalMock = vi.fn().mockResolvedValue(1);
    const client = { eval: evalMock } as unknown as Redis;
    const study = makeStoredStudy({ id: 'study-create' });

    await expect(createStudyAtomic(study, client)).resolves.toBe('created');

    const [script, keys] = evalMock.mock.calls[0] as [string, string[]];
    expect(script).toContain("redis.call('SET', KEYS[1], ARGV[1])");
    expect(script).toContain("redis.call('SADD', KEYS[2], ARGV[2])");
    expect(keys).toEqual([
      'study:study-create',
      'all-studies',
      'study-operation-result:standalone',
    ]);
  });

  it('atomically records a hosted create result and respects reconciliation cancellation', async () => {
    const evalMock = vi.fn().mockResolvedValue(-2);
    const client = { eval: evalMock } as unknown as Redis;
    const study = makeStoredStudy({ id: 'study-create' });

    await expect(createStudyAtomic(
      study,
      client,
      'create:study-create:123'
    )).resolves.toBe('cancelled');

    const [script, keys, args] = evalMock.mock.calls[0] as [string, string[], string[]];
    expect(script).toContain("redis.call('GET', KEYS[3]) == 'cancelled'");
    expect(script).toContain("redis.call('SET', KEYS[3], 'created')");
    expect(keys[2]).toBe('study-operation-result:create:study-create:123');
    expect(args[2]).toBe('create:study-create:123');
  });

  it('accepts Upstash-deserialized link mutation output without parsing it again', async () => {
    const updated = makeStoredStudy({
      id: 'study-links',
      interviewCount: 4,
      isLocked: true,
    });
    updated.config.linksEnabled = false;
    const evalMock = vi.fn().mockResolvedValue(updated);
    const client = { eval: evalMock } as unknown as Redis;

    await expect(setStudyLinksEnabled('study-links', false, client)).resolves.toEqual({
      status: 'updated',
      study: updated,
    });

    const [script] = evalMock.mock.calls[0] as [string];
    expect(script).toContain('study.config.linksEnabled');
    expect(script).not.toContain('study.interviewCount =');
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
    const evalMock = vi.fn().mockResolvedValue([1, updated]);
    const client = { eval: evalMock } as unknown as Redis;

    await expect(
      replaceStudyConfigAtomic('study-config', 7, updated.config, client)
    ).resolves.toEqual({ status: 'updated', study: updated });

    const [script] = evalMock.mock.calls[0] as [string];
    expect(script).toContain('(tonumber(study.revision) or 1) ~= tonumber(ARGV[1])');
    expect(script).toContain('study.config = cjson.decode(ARGV[2])');
    expect(script).not.toContain('study.interviewCount =');
    expect(script).not.toContain('study.isLocked =');
  });

  it('checks for interviews and deletes the study in one Redis script', async () => {
    const evalMock = vi.fn().mockResolvedValue(1);
    const client = { eval: evalMock } as unknown as Redis;

    await expect(deleteStudy('study-delete', client)).resolves.toEqual({ success: true });

    expect(evalMock).toHaveBeenCalledTimes(1);
    const [script, keys] = evalMock.mock.calls[0] as [string, string[]];
    expect(script).toContain("redis.call('SCARD', KEYS[2])");
    expect(script).toContain("redis.call('DEL', KEYS[1])");
    expect(keys).toEqual([
      'study:study-delete',
      'study-interviews:study-delete',
      'all-studies',
      'study-operation-result:standalone',
    ]);
  });

  it('installs the inverse tombstone atomically before platform rollback', async () => {
    const evalMock = vi.fn().mockResolvedValue(0);
    const client = { eval: evalMock } as unknown as Redis;

    await expect(settleStudyOperationMutation(
      'delete',
      'study-delete',
      'delete:study-delete:123',
      client
    )).resolves.toBe('mutation-cancelled');

    const [script, keys] = evalMock.mock.calls[0] as [string, string[]];
    expect(script).toContain("redis.call('SET', KEYS[2], 'cancelled')");
    expect(keys).toEqual([
      'study:study-delete',
      'study-operation-result:delete:study-delete:123',
    ]);
  });
});
