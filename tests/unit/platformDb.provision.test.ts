// @vitest-environment node

process.env.PLATFORM_KEY_PREFIX = '';

import { Redis } from '@upstash/redis';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const evalMock = vi.fn();
const getMock = vi.fn();

vi.mock('@/lib/kvClient', () => ({
  getPlatformClient: () => ({
    eval: evalMock,
    get: getMock,
  } as unknown as Redis),
}));

import { provisionResearcherByOAuth } from '@/lib/platformDb';

const existing = {
  id: 'researcher-existing',
  email: 'ada@example.com',
  name: 'Ada',
  avatarUrl: null,
  oauthProvider: 'google' as const,
  oauthId: 'google-1',
  createdAt: 1,
  lastLoginAt: 1,
  onboardingComplete: true,
  encryptedRedisUrl: null,
  encryptedRedisToken: null,
  encryptedGeminiApiKey: null,
  encryptedAnthropicApiKey: null,
  redisConfiguredAt: null,
};

describe('provisionResearcherByOAuth', () => {
  beforeEach(() => {
    evalMock.mockReset();
    getMock.mockReset();
  });

  it('creates a new account when oauth and email keys are free', async () => {
    evalMock.mockResolvedValue(1);

    const result = await provisionResearcherByOAuth({
      provider: 'google',
      oauthId: 'google-1',
      email: 'Ada@Example.com',
      name: 'Ada',
      avatarUrl: null,
    });

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(result.researcher.email).toBe('ada@example.com');
    expect(evalMock).toHaveBeenCalledTimes(1);
    const [script, keys, args] = evalMock.mock.calls[0] as [string, string[], string[]];
    expect(script).toContain("redis.call('SET', KEYS[1], ARGV[1], 'NX')");
    expect(script).toContain('return -1');
    expect(keys[0]).toBe('oauth:google:google-1');
    expect(keys[1]).toBe('email:ada@example.com');
    expect(args[1]).toContain('"email":"ada@example.com"');
  });

  it('returns found for an existing oauth identity and does not create a second account', async () => {
    evalMock.mockResolvedValue(0);
    getMock
      .mockResolvedValueOnce('researcher-existing')
      .mockResolvedValueOnce(existing);

    const result = await provisionResearcherByOAuth({
      provider: 'google',
      oauthId: 'google-1',
      email: 'ada@example.com',
      name: 'Ada',
      avatarUrl: null,
    });

    expect(result).toEqual({ status: 'found', researcher: existing });
  });

  it('reports a safe conflict instead of auto-linking by email', async () => {
    evalMock.mockResolvedValue(-1);

    await expect(provisionResearcherByOAuth({
      provider: 'github',
      oauthId: 'github-9',
      email: 'ada@example.com',
      name: 'Ada',
      avatarUrl: null,
    })).resolves.toEqual({ status: 'conflict' });
  });

  it('fails closed when platform Redis is unavailable', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    evalMock.mockRejectedValue(new Error('redis down'));

    await expect(provisionResearcherByOAuth({
      provider: 'google',
      oauthId: 'google-1',
      email: 'ada@example.com',
      name: 'Ada',
      avatarUrl: null,
    })).resolves.toEqual({ status: 'unavailable' });

    expect(errorSpy).toHaveBeenCalled();
  });

  it('fails closed when an oauth mapping exists but the account cannot be loaded', async () => {
    evalMock.mockResolvedValue(0);
    getMock.mockResolvedValue(null);

    await expect(provisionResearcherByOAuth({
      provider: 'google',
      oauthId: 'google-1',
      email: 'ada@example.com',
      name: 'Ada',
      avatarUrl: null,
    })).resolves.toEqual({ status: 'unavailable' });
  });
});
