// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRequestId,
  logRequestEvent,
  logRequestFailure,
} from '@/lib/requestLog';

const BANNED = [
  'message',
  'stack',
  'body',
  'cookie',
  'token',
  'prompt',
  'transcript',
  'sess_handle_ABCDEFG123',
  'sk-abc',
  'AIza',
  'rediss://',
  'redis://',
];

function parseLogged(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy.mock.calls[0]).toHaveLength(1);
  return JSON.parse(String(spy.mock.calls[0][0])) as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createRequestId', () => {
  it('reuses a presented UUID v4 and otherwise mints one', () => {
    const presented = '550e8400-e29b-41d4-a716-446655440000';
    expect(createRequestId(presented)).toBe(presented);
    expect(createRequestId(`  ${presented}  `)).toBe(presented);

    const mintedFromInvalid = createRequestId('not-a-uuid');
    expect(mintedFromInvalid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(mintedFromInvalid).not.toBe('not-a-uuid');

    const mintedFromV1 = createRequestId('123e4567-e89b-12d3-a456-426614174000');
    expect(mintedFromV1).not.toBe('123e4567-e89b-12d3-a456-426614174000');
    expect(createRequestId(null)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });
});

describe('logRequestEvent allowlist', () => {
  it('drops banned keys, nested values, and non-allowlisted events/reasons', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const leaked = {
      event: 'kv.unavailable',
      errorType: 'Error',
      reason: 'unavailable',
      message: 'api key sk-abc transcript hello cookie=abc token=xyz',
      stack: 'Error: api key sk-abc',
      body: '{"prompt":"tell me a secret"}',
      cookie: 'session=sess_handle_ABCDEFG123',
      token: 'sk-abc',
      prompt: 'interview prompt',
      transcript: 'participant transcript hello',
      sessionHandle: 'sess_handle_ABCDEFG123',
      redisUrl: 'rediss://default:secret@example.upstash.io:6379',
      apiKey: 'AIzaSyLeak',
      nested: { token: 'sk-abc', cookie: 'abc' },
      list: ['sk-abc'],
      cause: new Error('sk-abc'),
    };

    logRequestEvent(leaked as unknown as Parameters<typeof logRequestEvent>[0]);

    const payload = parseLogged(spy);
    expect(Object.keys(payload).sort()).toEqual(['errorType', 'event', 'reason', 'ts'].sort());
    expect(payload.event).toBe('kv.unavailable');
    expect(payload.errorType).toBe('Error');
    expect(payload.reason).toBe('unavailable');
    expect(typeof payload.ts).toBe('number');
    const serialized = JSON.stringify(spy.mock.calls);
    for (const banned of BANNED) {
      expect(serialized).not.toContain(banned);
    }
    expect(serialized).not.toContain('AIzaSyLeak');
  });

  it('passes synthesis.evidence with numeric ref counts and drops stowaway fields', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    logRequestEvent({
      event: 'synthesis.evidence',
      requestId: '550e8400-e29b-41d4-a716-446655440000',
      route: '/api/synthesis',
      refsOffered: 3,
      refsLocated: 1,
      // Never allowlisted: anything that could carry participant speech.
      quote: 'the participant said something',
      turnText: 'transcript content',
    } as unknown as Parameters<typeof logRequestEvent>[0]);

    const payload = parseLogged(spy);
    expect(payload.event).toBe('synthesis.evidence');
    expect(payload.refsOffered).toBe(3);
    expect(payload.refsLocated).toBe(1);
    expect(payload).not.toHaveProperty('quote');
    expect(payload).not.toHaveProperty('turnText');
    expect(JSON.stringify(spy.mock.calls)).not.toContain('participant said');
  });

  it('rejects non-numeric values in refsOffered/refsLocated (counts only, ever)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    logRequestEvent({
      event: 'synthesis.evidence',
      refsOffered: 'a quote that leaked into a count field',
      refsLocated: NaN,
    } as unknown as Parameters<typeof logRequestEvent>[0]);

    const payload = parseLogged(spy);
    expect(payload.event).toBe('synthesis.evidence');
    expect(payload).not.toHaveProperty('refsOffered');
    expect(payload).not.toHaveProperty('refsLocated');
    expect(JSON.stringify(spy.mock.calls)).not.toContain('leaked');
  });

  it('accepts the corrupt-record reason', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    logRequestEvent({ event: 'interview.analysis', reason: 'corrupt-record', status: 503 });
    const payload = parseLogged(spy);
    expect(payload.reason).toBe('corrupt-record');
    expect(payload.status).toBe(503);
  });

  it('rejects unknown event names and unknown reasons', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    logRequestEvent({ event: 'study.123@example.com', reason: 'please retry later' });
    expect(spy).not.toHaveBeenCalled();

    logRequestEvent({ event: 'route.failure', reason: 'user-facing copy', errorType: 'Error' });
    const payload = parseLogged(spy);
    expect(payload.event).toBe('route.failure');
    expect(payload).not.toHaveProperty('reason');
  });
});

describe('logRequestFailure', () => {
  it('emits once per Error and never prints banned substrings from the Error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const err = new Error('api key sk-abc transcript hello cookie=abc token=xyz');
    (err as Error & { body?: string }).body = 'prompt transcript cookie=abc';

    expect(logRequestFailure({ event: 'kv.unavailable' }, err)).toBe(true);
    expect(logRequestFailure({ event: 'kv.unavailable' }, err)).toBe(false);
    expect(logRequestFailure({ event: 'route.failure', route: '/api/interview' }, err)).toBe(false);

    const payload = parseLogged(spy);
    expect(payload).toMatchObject({
      event: 'kv.unavailable',
      errorType: 'Error',
    });
    const serialized = JSON.stringify(spy.mock.calls);
    for (const banned of BANNED) {
      expect(serialized).not.toContain(banned);
    }
  });
});
