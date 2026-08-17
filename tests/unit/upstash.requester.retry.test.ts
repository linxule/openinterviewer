// @vitest-environment node
// Production Upstash retrying transport + auto-deserialization (Revision 12 §3 / §18).
// Uses a custom Requester only — never contacts live Upstash.

import { describe, expect, it } from 'vitest';
import { Redis, type Requester, type UpstashRequest, type UpstashResponse } from '@upstash/redis';
import { RedisCommitAmbiguousError } from '@/lib/redisPort';

class RecordingRequester implements Requester {
  readonly calls: UpstashRequest[] = [];
  failuresRemaining: number;
  result: unknown;
  throwAfterResult = false;

  constructor(result: unknown, failuresRemaining = 0) {
    this.result = result;
    this.failuresRemaining = failuresRemaining;
  }

  async request<TResult = unknown>(req: UpstashRequest): Promise<UpstashResponse<TResult>> {
    this.calls.push(req);
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error('ECONNRESET');
    }
    if (this.throwAfterResult) {
      throw new RedisCommitAmbiguousError('may-have-committed', new Error('response lost'));
    }
    return { result: this.result as TResult };
  }
}

function client(requester: RecordingRequester): Redis {
  return new Redis(requester);
}

describe('upstash.requester: auto-deserialization', () => {
  it('recursively JSON.parses unprefixed object leaves', async () => {
    const requester = new RecordingRequester({ id: 'bare' });
    // The HTTP body already decoded; Command still parseRecursive()s string leaves.
    requester.result = '{"id":"bare"}';
    expect(await client(requester).get('k')).toEqual({ id: 'bare' });
  });

  it('keeps non-coercible oi: prefixes as strings', async () => {
    const prefixed = 'oi:account:{"id":"researcher-a"}';
    const requester = new RecordingRequester(prefixed);
    expect(await client(requester).get('researcher:a')).toBe(prefixed);
  });

  it('does not coerce prefixed eval tags or unsafe integers', async () => {
    const requester = new RecordingRequester([
      'oi:begin-started',
      'oi:op:{"version":2}',
      '9007199254740993',
    ]);
    const wire = await client(requester).eval('return ARGV', [], []);
    expect(wire).toEqual(['oi:begin-started', 'oi:op:{"version":2}', '9007199254740993']);
  });

  it('coerces a safe numeric leaf the way the installed SDK does', async () => {
    const requester = new RecordingRequester('42');
    expect(await client(requester).get('n')).toBe(42);
  });
});

describe('upstash.requester: retry and response loss', () => {
  it('retries a transport throw then returns the committed result', async () => {
    const requester = new RecordingRequester(['oi:created'], 2);
    const redis = client(requester);
    let lastError: unknown;
    let value: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        value = await redis.eval('return {ARGV[1]}', [], ['oi:created']);
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    expect(lastError).toBeUndefined();
    expect(value).toEqual(['oi:created']);
    expect(requester.calls.length).toBe(3);
  });

  it('does not translate may-have-committed into a definite refusal', async () => {
    const requester = new RecordingRequester(['oi:created']);
    requester.throwAfterResult = true;
    await expect(client(requester).eval('return 1', [], [])).rejects.toBeInstanceOf(
      RedisCommitAmbiguousError
    );
    await expect(client(requester).eval('return 1', [], [])).rejects.toMatchObject({
      commitState: 'may-have-committed',
    });
  });
});
