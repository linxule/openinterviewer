// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const platformMock = vi.hoisted(() => ({ consumePlatformRateLimit: vi.fn() }));
vi.mock('@/lib/platformDb', () => platformMock);

import { oauthRateLimitResponse } from '@/lib/oauthRateLimit';

const request = () => new Request('https://research.example/api/auth/oauth/google', {
  headers: { 'x-forwarded-for': '203.0.113.4, 10.0.0.1' },
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.RATE_LIMIT_SALT = 'oauth-rate-limit-salt-at-least-32-characters';
});

afterEach(() => {
  delete process.env.RATE_LIMIT_SALT;
});

describe('OAuth platform rate limiting', () => {
  it('allows a request and stores only a keyed network hash', async () => {
    platformMock.consumePlatformRateLimit.mockResolvedValue({ status: 'allowed', remaining: 59 });

    await expect(oauthRateLimitResponse(request(), 'oauth-google-start', 60)).resolves.toBeNull();

    expect(platformMock.consumePlatformRateLimit).toHaveBeenCalledWith(
      'oauth-google-start',
      expect.stringMatching(/^[a-f0-9]{32}$/),
      60,
      3_600
    );
    expect(platformMock.consumePlatformRateLimit.mock.calls[0][1]).not.toContain('203.0.113.4');
  });

  it('returns a bounded retry response when the limit is exceeded', async () => {
    platformMock.consumePlatformRateLimit.mockResolvedValue({
      status: 'limited',
      retryAfterSeconds: 321,
    });

    const response = await oauthRateLimitResponse(request(), 'oauth-google-callback', 30);

    expect(response?.status).toBe(429);
    expect(response?.headers.get('retry-after')).toBe('321');
  });

  it('fails closed when the salt or platform database is unavailable', async () => {
    delete process.env.RATE_LIMIT_SALT;
    const missingSalt = await oauthRateLimitResponse(request(), 'oauth-github-start', 60);
    expect(missingSalt?.status).toBe(503);
    expect(platformMock.consumePlatformRateLimit).not.toHaveBeenCalled();

    process.env.RATE_LIMIT_SALT = 'oauth-rate-limit-salt-at-least-32-characters';
    platformMock.consumePlatformRateLimit.mockResolvedValue({ status: 'unavailable' });
    const unavailable = await oauthRateLimitResponse(request(), 'oauth-github-callback', 30);
    expect(unavailable?.status).toBe(503);
  });
});
