import { beforeEach, describe, expect, it, vi } from 'vitest';

const platformClient = vi.hoisted(() => ({
  eval: vi.fn(),
  get: vi.fn(),
}));
vi.mock('@/lib/kvClient', () => ({ getPlatformClient: () => platformClient }));
vi.mock('@/lib/email', () => ({ normalizeEmail: (value: string) => value.toLowerCase() }));

import {
  beginCreateStudyOperation,
  beginDeleteStudyOperation,
  consumePlatformRateLimit,
  consumePlatformRateLimits,
  deleteStudyOwnership,
  deleteResearcherAccount,
  getPendingStudyOperations,
  registerStudyOwnership,
  resolveStudyOperation,
  updateResearcherCredentialsAtomic,
} from '@/lib/platformDb';

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PLATFORM_KEY_PREFIX;
});

describe('platform credential lifecycle scripts', () => {
  it('atomically enforces every platform-owned hosted AI scope', async () => {
    platformClient.eval.mockResolvedValueOnce([1, 0]);
    const now = Math.floor(Date.now() / 1_000);

    await expect(consumePlatformRateLimits([
      {
        operation: 'ai-interview-session',
        subject: 'session-digest',
        maximum: 60,
        windowSeconds: 3_600,
      },
      {
        operation: 'ai-interview-researcher',
        subject: 'researcher-digest',
        maximum: 10_000,
        windowSeconds: 86_400,
      },
    ])).resolves.toEqual({ status: 'allowed' });

    const [script, keys, args] = platformClient.eval.mock.calls[0];
    expect(script).toContain("redis.call('GET', KEYS[i])");
    expect(script).toContain("redis.call('INCR', KEYS[i])");
    expect(script.indexOf("redis.call('GET', KEYS[i])"))
      .toBeLessThan(script.indexOf("redis.call('INCR', KEYS[i])"));
    expect(keys).toEqual([
      `rate-limit:ai-interview-session:${Math.floor(now / 3_600)}:session-digest`,
      `rate-limit:ai-interview-researcher:${Math.floor(now / 86_400)}:researcher-digest`,
    ]);
    expect(args).toEqual(['60', '3660', '10000', '86460']);
  });

  it('maps a rejected platform scope and fails closed on malformed results', async () => {
    const counters = [
      {
        operation: 'ai-greeting-session',
        subject: 'session-digest',
        maximum: 3,
        windowSeconds: 600,
      },
      {
        operation: 'ai-greeting-network',
        subject: 'network-digest',
        maximum: 200,
        windowSeconds: 3_600,
      },
    ];
    platformClient.eval.mockResolvedValueOnce([0, 2]);
    const limited = await consumePlatformRateLimits(counters);
    expect(limited.status).toBe('limited');
    if (limited.status === 'limited') {
      expect(limited.retryAfterSeconds).toBeGreaterThan(0);
      expect(limited.retryAfterSeconds).toBeLessThanOrEqual(3_600);
    }

    platformClient.eval.mockResolvedValueOnce([0, 9]);
    await expect(consumePlatformRateLimits(counters)).resolves.toEqual({ status: 'unavailable' });
  });

  it('fails closed and returns a retry window after the platform limit is exceeded', async () => {
    platformClient.eval.mockResolvedValue(13);
    const result = await consumePlatformRateLimit('credential-save', 'researcher-a', 12, 3_600);

    expect(result.status).toBe('limited');
    if (result.status === 'limited') expect(result.retryAfterSeconds).toBeGreaterThan(0);
    expect(platformClient.eval.mock.calls[0][1][0]).toContain('rate-limit:credential-save:');
  });

  it('maps credential CAS conflicts without claiming an update', async () => {
    platformClient.eval.mockResolvedValue(-2);
    const result = await updateResearcherCredentialsAtomic(
      'researcher-a',
      3,
      { encryptedGeminiApiKey: null, onboardingComplete: false }
    );

    expect(result).toEqual({ status: 'conflict' });
    expect(platformClient.eval).toHaveBeenCalledWith(
      expect.stringContaining('credentialRevision'),
      ['researcher:researcher-a'],
      ['3', JSON.stringify({ encryptedGeminiApiKey: null, onboardingComplete: false })]
    );
  });

  it('removes study ownership only for the expected researcher', async () => {
    platformClient.eval.mockResolvedValueOnce(-1);
    await expect(deleteStudyOwnership('study-a', 'researcher-a'))
      .resolves.toBe('owner-conflict');

    const [script, keys, args] = platformClient.eval.mock.calls[0];
    expect(script).toContain("owner ~= ARGV[1]");
    expect(keys).toEqual(['study-owner:study-a']);
    expect(args).toEqual(['researcher-a', 'researcher-studies:', 'study-a']);

    platformClient.eval.mockResolvedValueOnce(1);
    await expect(deleteStudyOwnership('study-a', 'researcher-a'))
      .resolves.toBe('deleted');
  });

  it('atomically enforces the hosted study ownership quota', async () => {
    platformClient.eval.mockResolvedValueOnce(-2);
    await expect(registerStudyOwnership('study-a', 'researcher-a'))
      .resolves.toBe('quota-exceeded');

    const [script, keys, args] = platformClient.eval.mock.calls[0];
    expect(script).toContain("SCARD', KEYS[2]");
    expect(keys).toEqual(['study-owner:study-a', 'researcher-studies:researcher-a']);
    expect(args).toEqual(['researcher-a', 'study-a', '1000']);
  });

  it('atomically reserves ownership and a bounded create operation', async () => {
    platformClient.eval.mockResolvedValueOnce(1);

    const result = await beginCreateStudyOperation('study-a', 'researcher-a');

    expect(result.status).toBe('started');
    const [script, keys, args] = platformClient.eval.mock.calls[0];
    expect(script).toContain("redis.call('SET', KEYS[1], ARGV[1])");
    expect(script).toContain("redis.call('SET', KEYS[3], ARGV[6])");
    expect(script).toContain("redis.call('SCARD', KEYS[2])");
    expect(script).toContain("redis.call('SCARD', KEYS[4])");
    expect(keys).toEqual([
      'study-owner:study-a',
      'researcher-studies:researcher-a',
      'study-operation:create:study-a',
      'study-operations:researcher-a',
      'study-operation-lock:study-a',
      'researcher:researcher-a',
    ]);
    expect(args.slice(0, 5)).toEqual([
      'researcher-a',
      'study-a',
      'create:study-a',
      '1000',
      '100',
    ]);
  });

  it('records delete intent without removing routing authority', async () => {
    platformClient.eval.mockResolvedValueOnce(1);

    const result = await beginDeleteStudyOperation('study-a', 'researcher-a');

    expect(result.status).toBe('started');
    const [script, keys, args] = platformClient.eval.mock.calls[0];
    expect(script).toContain("if owner ~= ARGV[1] then return -2 end");
    expect(script).not.toContain("redis.call('DEL', KEYS[1])");
    expect(keys).toEqual([
      'study-owner:study-a',
      'study-operation:delete:study-a',
      'study-operations:researcher-a',
      'study-operation-lock:study-a',
      'researcher-studies:researcher-a',
      'researcher:researcher-a',
    ]);
    expect(args.slice(0, 4)).toEqual([
      'researcher-a',
      'study-a',
      'delete:study-a',
      '100',
    ]);
  });

  it('resolves a terminal operation only after comparing operation and owner identity', async () => {
    platformClient.eval.mockResolvedValueOnce(1);
    const operation = {
      version: 1 as const,
      id: 'delete:study-a',
      kind: 'delete' as const,
      researcherId: 'researcher-a',
      studyId: 'study-a',
      createdAt: 1,
      updatedAt: 1,
    };

    await expect(resolveStudyOperation(operation, 'delete-complete')).resolves.toBe('resolved');

    const [script, keys, args] = platformClient.eval.mock.calls[0];
    expect(script).toContain("parsed.researcherId ~= ARGV[1]");
    expect(script).toContain("owner and owner ~= ARGV[1]");
    expect(script).toContain("redis.call('DEL', KEYS[1])");
    expect(keys).toEqual([
      'study-owner:study-a',
      'researcher-studies:researcher-a',
      'study-operation:delete:study-a',
      'study-operations:researcher-a',
      'study-operation-lock:study-a',
    ]);
    expect(args).toEqual([
      'researcher-a',
      'study-a',
      'delete:study-a',
      'delete',
      'delete-complete',
    ]);
  });

  it('loads only a bounded, owner-matching set of pending operations', async () => {
    platformClient.eval.mockResolvedValueOnce([
      'create:study-a',
      'malformed',
      'delete:study-b',
    ]);
    platformClient.get
      .mockResolvedValueOnce({
        version: 1, id: 'create:study-a', kind: 'create', researcherId: 'researcher-a',
        studyId: 'study-a', createdAt: 1, updatedAt: 1,
      })
      .mockResolvedValueOnce({
        version: 1, id: 'delete:study-b', kind: 'delete', researcherId: 'researcher-b',
        studyId: 'study-b', createdAt: 1, updatedAt: 1,
      });

    await expect(getPendingStudyOperations('researcher-a', 2)).resolves.toEqual({
      status: 'ok',
      operations: [expect.objectContaining({ id: 'create:study-a' })],
      invalidCount: 2,
    });
    expect(platformClient.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('SRANDMEMBER'"),
      ['study-operations:researcher-a'],
      ['2', '100']
    );
    expect(platformClient.get).toHaveBeenCalledTimes(2);
  });

  it('deletes only platform keys and returns the detached routing count', async () => {
    platformClient.eval.mockResolvedValue([1, 2]);
    const researcher = {
      id: 'researcher-a',
      email: 'owner@example.com',
      name: 'Owner',
      avatarUrl: null,
      oauthProvider: 'google' as const,
      oauthId: 'oauth-a',
      createdAt: 1,
      lastLoginAt: 1,
      onboardingComplete: true,
      encryptedRedisUrl: 'encrypted-external-url',
      encryptedRedisToken: 'encrypted-external-token',
      encryptedGeminiApiKey: 'encrypted-ai-key',
      encryptedAnthropicApiKey: null,
      redisConfiguredAt: 1,
    };
    const result = await deleteResearcherAccount(researcher);

    expect(result).toEqual({ status: 'deleted', detachedStudyCount: 2 });
    const [, keys, args] = platformClient.eval.mock.calls[0];
    expect(keys).toEqual([
      'researcher:researcher-a',
      'oauth:google:oauth-a',
      'email:owner@example.com',
      'all-researchers',
      'researcher-studies:researcher-a',
      'participant-links:researcher-a',
      'study-operations:researcher-a',
    ]);
    expect(args).toEqual([
      'study-owner:',
      '1000',
      'researcher-a',
      'participant-link:',
      'study-operation:',
      'study-operation-lock:',
    ]);
    expect(JSON.stringify(platformClient.eval.mock.calls[0])).not.toContain('external-token');
  });

  it('refuses unbounded automatic account cleanup', async () => {
    platformClient.eval.mockResolvedValue([-2, 1001]);
    const result = await deleteResearcherAccount({
      id: 'researcher-a', email: 'owner@example.com', name: 'Owner', avatarUrl: null,
      oauthProvider: 'google', oauthId: 'oauth-a', createdAt: 1, lastLoginAt: 1,
      onboardingComplete: true, encryptedRedisUrl: null, encryptedRedisToken: null,
      encryptedGeminiApiKey: null, encryptedAnthropicApiKey: null, redisConfiguredAt: null,
    });
    expect(result).toEqual({ status: 'too-many-records' });
  });
});
