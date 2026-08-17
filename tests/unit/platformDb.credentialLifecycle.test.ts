import { beforeEach, describe, expect, it, vi } from 'vitest';

const platformClient = vi.hoisted(() => ({
  eval: vi.fn(),
  get: vi.fn(),
}));
vi.mock('@/lib/kvClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/kvClient')>();
  return { ...actual, getPlatformClient: () => platformClient };
});
vi.mock('@/lib/email', () => ({ normalizeEmail: (value: string) => value.toLowerCase() }));

import {
  beginCreateStudyOperation,
  beginDeleteStudyOperation,
  consumePlatformRateLimit,
  consumePlatformRateLimits,
  deleteResearcherAccount,
  deleteStudyOwnership,
  getPendingStudyOperations,
  registerStudyOwnership,
  resolveStudyOperation,
  UPDATE_RESEARCHER_CREDENTIALS_SCRIPT,
  updateResearcherCredentialsAtomic,
} from '@/lib/platformDb';
import { encodeAccountRecord, encodeStorageBinding } from '@/lib/platformDb.operations';
import { buildSchemaLineageValue } from '@/lib/platformSchema';
import { MemoryPlatformRedis } from '../helpers/memoryPlatformRedis';

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PLATFORM_KEY_PREFIX;
  platformClient.get.mockResolvedValue(null);
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
    platformClient.get.mockResolvedValueOnce(null);
    await expect(consumePlatformRateLimit('credential-save', 'researcher-a', 12, 3_600))
      .resolves.toEqual({ status: 'hold' });
    expect(platformClient.eval).not.toHaveBeenCalled();

    platformClient.get.mockResolvedValue(buildSchemaLineageValue(1));
    platformClient.eval.mockResolvedValue(13);
    const result = await consumePlatformRateLimit('credential-save', 'researcher-a', 12, 3_600);

    expect(result.status).toBe('limited');
    if (result.status === 'limited') expect(result.retryAfterSeconds).toBeGreaterThan(0);
    expect(platformClient.eval.mock.calls[0][1][0]).toContain('rate-limit:credential-save:');
  });

  it('maps credential CAS conflicts without claiming an update', async () => {
    platformClient.eval.mockResolvedValue(['oi:cred-conflict']);
    const result = await updateResearcherCredentialsAtomic(
      'researcher-a',
      3,
      { encryptedGeminiApiKey: null, onboardingComplete: false }
    );

    expect(result).toEqual({ status: 'conflict' });
    expect(platformClient.eval).toHaveBeenCalledWith(
      expect.stringContaining('credential-cas'),
      [
        'researcher:researcher-a',
        'researcher-storage:researcher-a',
        'researcher-studies:researcher-a',
        'storage-researchers:_',
        'storage-researchers:_',
        'account-delete-journal',
        'study-ops:v2',
      ],
      [
        'researcher-a',
        '3',
        '',
        '',
        '',
        'none',
        '',
        '',
        '',
        JSON.stringify({ encryptedGeminiApiKey: null, onboardingComplete: false }),
        '1000',
      ],
    );
  });

  it('refuses origin change or clear while studies exist and keeps token rotation on the same origin', async () => {
    expect(UPDATE_RESEARCHER_CREDENTIALS_SCRIPT).toContain("redis.call('SCARD', KEYS[3])");
    expect(UPDATE_RESEARCHER_CREDENTIALS_SCRIPT).toContain("redis.call('HEXISTS', KEYS[6], ARGV[1])");
    expect(UPDATE_RESEARCHER_CREDENTIALS_SCRIPT).toContain("storage.storageId == ARGV[7]");
    expect(UPDATE_RESEARCHER_CREDENTIALS_SCRIPT).toContain('bindingEpoch = tonumber(storage.bindingEpoch) + 1');
    expect(UPDATE_RESEARCHER_CREDENTIALS_SCRIPT).toContain("return {'oi:cred-refused'}");
    expect(UPDATE_RESEARCHER_CREDENTIALS_SCRIPT.indexOf("if storage.storageId == ARGV[7] then"))
      .toBeLessThan(UPDATE_RESEARCHER_CREDENTIALS_SCRIPT.indexOf('bindingEpoch = tonumber(storage.bindingEpoch) + 1'));

    const stored = encodeStorageBinding({
      version: 2,
      researcherId: 'researcher-a',
      storageId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      originHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      credentialRevision: 3,
      bindingEpoch: 4,
      cipherSnapshot: 'snap-old',
    });
    platformClient.get.mockResolvedValue(stored);
    platformClient.eval.mockResolvedValue(['oi:cred-refused']);

    await expect(updateResearcherCredentialsAtomic(
      'researcher-a',
      3,
      { encryptedRedisUrl: null, encryptedRedisToken: null, redisConfiguredAt: null },
    )).resolves.toEqual({ status: 'refused' });

    const [script, keys, args] = platformClient.eval.mock.calls[0];
    expect(script).toContain('credential-cas');
    expect(keys[3]).toBe('storage-researchers:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(args[5]).toBe('clear');
  });

  it('same-origin token rotation increments revision, keeps bindingEpoch, and requests scoped evict', async () => {
    const storageId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    platformClient.get.mockResolvedValue(encodeStorageBinding({
      version: 2,
      researcherId: 'researcher-a',
      storageId,
      originHash: storageId,
      credentialRevision: 3,
      bindingEpoch: 4,
      cipherSnapshot: 'snap-old',
    }));
    platformClient.eval.mockResolvedValue([
      'oi:cred-updated',
      'oi:json:{"credentialRevision":4,"bindingEpoch":4,"storageId":"' + storageId + '","disposition":"scoped"}',
    ]);

    const encryptedUrl = 'cipher-url';
    const encryptedToken = 'cipher-token';
    const result = await updateResearcherCredentialsAtomic(
      'researcher-a',
      3,
      { encryptedRedisUrl: encryptedUrl, encryptedRedisToken: encryptedToken, redisConfiguredAt: 9 },
      { storageId },
    );

    expect(result).toEqual({
      status: 'updated',
      credentialRevision: 4,
      bindingEpoch: 4,
      storageId,
      evict: { disposition: 'scoped', researcherId: 'researcher-a', storageId },
    });
    expect(platformClient.eval.mock.calls[0][2][5]).toBe('set');
    expect(platformClient.eval.mock.calls[0][2][6]).toBe(storageId);
    expect(platformClient.eval.mock.calls[0][2][8]).toMatch(/^[a-f0-9]{64}$/);
  });

  it('maps journal HEXISTS to adel and transport may-have-committed to ambiguous', async () => {
    platformClient.eval.mockResolvedValueOnce(['oi:cred-adel']);
    await expect(updateResearcherCredentialsAtomic(
      'researcher-a',
      1,
      { onboardingComplete: true },
    )).resolves.toEqual({ status: 'adel' });

    const { RedisCommitAmbiguousError } = await import('@/lib/redisPort');
    platformClient.eval.mockRejectedValueOnce(new RedisCommitAmbiguousError('may-have-committed'));
    await expect(updateResearcherCredentialsAtomic(
      'researcher-a',
      1,
      { onboardingComplete: true },
    )).resolves.toEqual({ status: 'ambiguous' });
  });

  it('already redis-less clear is updated with disposition none', async () => {
    platformClient.get.mockResolvedValue(null);
    platformClient.eval.mockResolvedValue([
      'oi:cred-updated',
      'oi:json:{"credentialRevision":2,"bindingEpoch":0,"storageId":null,"disposition":"none"}',
    ]);
    await expect(updateResearcherCredentialsAtomic(
      'researcher-a',
      1,
      { encryptedRedisUrl: null, encryptedRedisToken: null, redisConfiguredAt: null },
    )).resolves.toEqual({
      status: 'updated',
      credentialRevision: 2,
      bindingEpoch: 0,
      storageId: null,
      evict: { disposition: 'none' },
    });
    expect(platformClient.eval.mock.calls[0][2][5]).toBe('clear');
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

  it('does not claim terminal deletion on schema-hold', async () => {
    const redis = new MemoryPlatformRedis();
    redis.strings.set('researcher:researcher-a', encodeAccountRecord({ id: 'researcher-a' }));
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
      encryptedOpenAiApiKey: null,
      encryptedOpenRouterApiKey: null,
      redisConfiguredAt: 1,
    };
    const result = await deleteResearcherAccount(researcher, 1_000, { client: redis.asPort() });

    expect(result).toEqual({ status: 'unavailable' });
    expect(redis.strings.has('researcher:researcher-a')).toBe(true);
    expect(JSON.stringify(redis.writes)).not.toContain('encrypted-external-token');
    expect(JSON.stringify(redis.writes)).not.toContain('encrypted-ai-key');
  });

  it('deletes only platform keys and never writes BYOS material', async () => {
    const redis = new MemoryPlatformRedis();
    redis.strings.set('schema-lineage', buildSchemaLineageValue(1));
    redis.strings.set('researcher:researcher-a', encodeAccountRecord({ id: 'researcher-a' }));
    redis.strings.set('oauth:google:oauth-a', 'researcher-a');
    redis.strings.set('email:owner@example.com', 'researcher-a');
    redis.sets.set('all-researchers', new Set(['researcher-a']));
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
      encryptedOpenAiApiKey: null,
      encryptedOpenRouterApiKey: null,
      redisConfiguredAt: 1,
    };
    const result = await deleteResearcherAccount(researcher, 1_000, { client: redis.asPort() });

    expect(result.status).toBe('deleted');
    expect(redis.strings.has('researcher:researcher-a')).toBe(false);
    expect(JSON.stringify(redis.writes)).not.toContain('encrypted-external-token');
    expect(JSON.stringify(redis.writes)).not.toContain('encrypted-ai-key');
  });

  it('refuses unbounded automatic account cleanup', async () => {
    const redis = new MemoryPlatformRedis();
    redis.strings.set('schema-lineage', buildSchemaLineageValue(1));
    const journal = new Map<string, string>();
    for (let i = 0; i < 100; i += 1) {
      journal.set(`other-${i}`, 'oi:adel-journal:{"version":2}');
    }
    redis.hashes.set('account-delete-journal', journal);
    redis.strings.set('researcher:researcher-a', encodeAccountRecord({ id: 'researcher-a' }));
    const result = await deleteResearcherAccount({
      id: 'researcher-a', email: 'owner@example.com', name: 'Owner', avatarUrl: null,
      oauthProvider: 'google', oauthId: 'oauth-a', createdAt: 1, lastLoginAt: 1,
      onboardingComplete: true, encryptedRedisUrl: null, encryptedRedisToken: null,
      encryptedGeminiApiKey: null, encryptedAnthropicApiKey: null,
      encryptedOpenAiApiKey: null, encryptedOpenRouterApiKey: null, redisConfiguredAt: null,
    }, 1_000, { client: redis.asPort() });
    expect(result).toEqual({ status: 'too-many-records' });
    expect(redis.hashes.get('account-delete-journal')?.has('researcher-a')).toBe(false);
  });
});
