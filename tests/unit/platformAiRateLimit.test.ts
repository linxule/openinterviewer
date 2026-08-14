// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const modeMock = vi.hoisted(() => ({ isHostedMode: vi.fn() }));
vi.mock('@/lib/mode', () => modeMock);

const platformMock = vi.hoisted(() => ({ consumePlatformRateLimits: vi.fn() }));
vi.mock('@/lib/platformDb', () => platformMock);

vi.mock('@/lib/auth', () => ({ SESSION_COOKIE_NAME: 'research-auth' }));

import {
  HOSTED_AI_RATE_LIMIT_POLICY,
  hostedAiRateLimitResponse,
} from '@/lib/platformAiRateLimit';

const originalSalt = process.env.RATE_LIMIT_SALT;

beforeEach(() => {
  vi.clearAllMocks();
  modeMock.isHostedMode.mockReturnValue(true);
  platformMock.consumePlatformRateLimits.mockResolvedValue({ status: 'allowed' });
  process.env.RATE_LIMIT_SALT = 'platform-ai-rate-limit-salt-at-least-32-characters';
});

afterEach(() => {
  if (originalSalt === undefined) delete process.env.RATE_LIMIT_SALT;
  else process.env.RATE_LIMIT_SALT = originalSalt;
});

describe('hosted AI platform rate limits', () => {
  it('does not touch platform storage in standalone mode', async () => {
    modeMock.isHostedMode.mockReturnValue(false);

    await expect(hostedAiRateLimitResponse(
      new Request('http://localhost/api/interview'),
      'interview',
      {}
    )).resolves.toBeNull();
    expect(platformMock.consumePlatformRateLimits).not.toHaveBeenCalled();
  });

  it('atomically consumes hashed participant session, network, and researcher scopes', async () => {
    const response = await hostedAiRateLimitResponse(
      new Request('http://localhost/api/interview', {
        headers: { 'x-forwarded-for': '203.0.113.10, 10.0.0.1' },
      }),
      'interview',
      { researcherId: 'researcher-a', participantSessionId: 'participant-session-a' }
    );

    expect(response).toBeNull();
    const counters = platformMock.consumePlatformRateLimits.mock.calls[0][0];
    expect(counters).toEqual([
      {
        operation: 'ai-interview-session',
        subject: expect.stringMatching(/^[a-f0-9]{64}$/),
        ...HOSTED_AI_RATE_LIMIT_POLICY.interview.session,
      },
      {
        operation: 'ai-interview-network',
        subject: expect.stringMatching(/^[a-f0-9]{64}$/),
        ...HOSTED_AI_RATE_LIMIT_POLICY.interview.network,
      },
      {
        operation: 'ai-interview-researcher',
        subject: expect.stringMatching(/^[a-f0-9]{64}$/),
        ...HOSTED_AI_RATE_LIMIT_POLICY.interview.researcher,
      },
    ]);
    expect(JSON.stringify(counters)).not.toContain('participant-session-a');
    expect(JSON.stringify(counters)).not.toContain('203.0.113.10');
    expect(JSON.stringify(counters)).not.toContain('researcher-a');
  });

  it('uses the authenticated cookie as the admin session scope', async () => {
    const response = await hostedAiRateLimitResponse(
      new Request('http://localhost/api/synthesis/aggregate', {
        headers: { cookie: 'other=value; research-auth=researcher-session-token' },
      }),
      'aggregate',
      { researcherId: 'researcher-a' }
    );

    expect(response).toBeNull();
    const counters = platformMock.consumePlatformRateLimits.mock.calls[0][0];
    expect(counters[0]).toMatchObject({ operation: 'ai-aggregate-session' });
    expect(JSON.stringify(counters)).not.toContain('researcher-session-token');
  });

  it('fails closed when authority, secret, or platform storage is unavailable', async () => {
    const missingAuthority = await hostedAiRateLimitResponse(
      new Request('http://localhost/api/interview'),
      'interview',
      { researcherId: 'researcher-a' }
    );
    expect(missingAuthority?.status).toBe(503);
    expect(platformMock.consumePlatformRateLimits).not.toHaveBeenCalled();

    delete process.env.RATE_LIMIT_SALT;
    const missingSecret = await hostedAiRateLimitResponse(
      new Request('http://localhost/api/interview'),
      'interview',
      { researcherId: 'researcher-a', participantSessionId: 'participant-session-a' }
    );
    expect(missingSecret?.status).toBe(503);
    expect(platformMock.consumePlatformRateLimits).not.toHaveBeenCalled();

    process.env.RATE_LIMIT_SALT = 'platform-ai-rate-limit-salt-at-least-32-characters';
    platformMock.consumePlatformRateLimits.mockResolvedValueOnce({ status: 'unavailable' });
    const unavailable = await hostedAiRateLimitResponse(
      new Request('http://localhost/api/interview'),
      'interview',
      { researcherId: 'researcher-a', participantSessionId: 'participant-session-a' }
    );
    expect(unavailable?.status).toBe(503);
  });

  it('returns the rejected platform retry window without calling a provider', async () => {
    platformMock.consumePlatformRateLimits.mockResolvedValueOnce({
      status: 'limited',
      retryAfterSeconds: 321,
    });

    const response = await hostedAiRateLimitResponse(
      new Request('http://localhost/api/synthesis'),
      'synthesis',
      { researcherId: 'researcher-a', participantSessionId: 'participant-session-a' }
    );

    expect(response?.status).toBe(429);
    expect(response?.headers.get('Retry-After')).toBe('321');
  });
});
