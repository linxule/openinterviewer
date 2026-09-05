// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RedisPort } from '@/lib/redisPort';
import {
  getParticipantRateLimitCounters,
  participantRateLimitResponse,
  refundParticipantRateLimit,
} from '@/lib/rateLimit';

afterEach(() => {
  delete process.env.RATE_LIMIT_SALT;
});

describe('participant AI rate limiting', () => {
  it('checks both a hashed client budget and a study-wide budget', async () => {
    process.env.RATE_LIMIT_SALT = 'test-only-rate-limit-salt';
    const evalMock = vi.fn().mockResolvedValue([1, 0, 0]);
    const client = { eval: evalMock } as unknown as RedisPort;
    const request = new Request('http://localhost/api/interview', {
      headers: { 'x-forwarded-for': '203.0.113.9' },
    });

    await expect(
      participantRateLimitResponse(request, 'study-a', 'interview', client, {
        sessionId: 'session-a',
        linkId: 'link-a',
        researcherId: 'researcher-a',
      })
    ).resolves.toBeNull();

    expect(evalMock).toHaveBeenCalledTimes(1);
    const [script, keys, args] = evalMock.mock.calls[0] as [string, string[], string[]];
    expect(script).toContain('if count >= maximum then');
    expect(script).toContain("redis.call('INCR', KEYS[i])");
    const firstKey = keys[0];
    expect(firstKey).toBe('rate-limit:interview:session:3600:session-a');
    const clientKey = keys[1];
    expect(clientKey).toMatch(/^rate-limit:interview:client:3600:study-a:[a-f0-9]{24}$/);
    expect(clientKey).not.toContain('203.0.113.9');
    expect(keys[4]).toBe(
      'rate-limit:interview:researcher:86400:researcher-a'
    );
    expect(args).toEqual(['60', '3600', '60', '3600', '2000', '86400', '5000', '86400', '10000', '86400']);
  });

  it('returns 429 with Retry-After when a budget is exceeded', async () => {
    const client = {
      eval: vi.fn().mockResolvedValue([0, 1, 17]),
    } as unknown as RedisPort;

    const response = await participantRateLimitResponse(
      new Request('http://localhost/api/interview'),
      'study-a',
      'interview',
      client,
      { sessionId: 'session-a', linkId: 'link-a' }
    );

    expect(response?.status).toBe(429);
    expect(response?.headers.get('Retry-After')).toBe('17');
  });

  it('fails closed when the rate-limit store is unavailable', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = {
      eval: vi.fn().mockRejectedValue(new Error('redis down')),
    } as unknown as RedisPort;

    const response = await participantRateLimitResponse(
      new Request('http://localhost/api/greeting'),
      'study-a',
      'greeting',
      client,
      { sessionId: 'session-a', linkId: 'link-a' }
    );

    expect(response?.status).toBe(503);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('allows a handful of legitimate synthesis retries per session per day', async () => {
    const request = new Request('http://localhost/api/synthesis');
    const counters = getParticipantRateLimitCounters(request, 'study-a', 'synthesis', {
      sessionId: 'session-a',
      linkId: 'link-a',
      researcherId: 'researcher-a',
    });
    const sessionCounter = counters?.find(counter => counter.key.includes(':session:'));
    expect(sessionCounter?.maximum).toBe(6);
    expect(sessionCounter?.windowSeconds).toBe(86_400);
  });

  describe('refundParticipantRateLimit', () => {
    it('evaluates a guarded decrement against the same keys the limiter checks', async () => {
      const evalMock = vi.fn().mockResolvedValue(1);
      const client = { eval: evalMock } as unknown as RedisPort;
      const request = new Request('http://localhost/api/synthesis', {
        headers: { 'x-forwarded-for': '203.0.113.9' },
      });
      const authority = { sessionId: 'session-a', linkId: 'link-a', researcherId: 'researcher-a' };

      await refundParticipantRateLimit(request, 'study-a', 'synthesis', client, authority);

      const expectedKeys = getParticipantRateLimitCounters(request, 'study-a', 'synthesis', authority)!
        .map(counter => counter.key);
      expect(evalMock).toHaveBeenCalledTimes(1);
      const [script, keys, args] = evalMock.mock.calls[0] as [string, string[], string[]];
      expect(script).toContain('if count > 0 then');
      expect(script).toContain("redis.call('DECR', KEYS[i])");
      expect(keys).toEqual(expectedKeys);
      expect(args).toEqual([]);
    });

    it('swallows a throwing client instead of rejecting', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const client = {
        eval: vi.fn().mockRejectedValue(new Error('redis down')),
      } as unknown as RedisPort;

      await expect(
        refundParticipantRateLimit(
          new Request('http://localhost/api/synthesis'),
          'study-a',
          'synthesis',
          client,
          { sessionId: 'session-a', linkId: 'link-a' }
        )
      ).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalled();
    });

    it('returns silently when authority is incomplete', async () => {
      const evalMock = vi.fn();
      const client = { eval: evalMock } as unknown as RedisPort;

      await refundParticipantRateLimit(
        new Request('http://localhost/api/synthesis'),
        'study-a',
        'synthesis',
        client,
        {}
      );

      expect(evalMock).not.toHaveBeenCalled();
    });
  });
});
