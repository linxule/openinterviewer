// Public Redis port branding (Revision 12 §2, §18). Brand is
// sha256('oi:redis-brand:v1' + 0x00 + exactUrl + 0x00 + ownershipToken).
// Fault seams refuse unless the brand matches the runner-minted token;
// production adapters have no fault hook.

import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RedisCommitAmbiguousError, type RedisPort } from '@/lib/redisPort';
import { computeRedisBrand, createRedisNodeAdapter } from '@/lib/redisNodeAdapter';

const BRAND_PREIMAGE_PREFIX = 'oi:redis-brand:v1';
const URL = 'redis://127.0.0.1:6379';

function sha256(preimage: string): string {
  return createHash('sha256').update(preimage).digest('hex');
}

describe('redisPort.brand: computeRedisBrand', () => {
  it('is sha256 of the domain-separated preimage', () => {
    const token = randomBytes(32).toString('hex');
    const expected = sha256(
      `${BRAND_PREIMAGE_PREFIX}\u0000${URL}\u0000${token}`
    );
    expect(computeRedisBrand(URL, token)).toBe(expected);
  });

  it('is deterministic for the same url and token', () => {
    const token = randomBytes(32).toString('hex');
    expect(computeRedisBrand(URL, token)).toBe(computeRedisBrand(URL, token));
  });

  it('changes when the url changes', () => {
    const token = randomBytes(32).toString('hex');
    expect(computeRedisBrand(URL, token)).not.toBe(
      computeRedisBrand('redis://127.0.0.1:6380', token)
    );
  });

  it('changes when the ownership token changes', () => {
    expect(computeRedisBrand(URL, randomBytes(32).toString('hex'))).not.toBe(
      computeRedisBrand(URL, randomBytes(32).toString('hex'))
    );
  });
});

describe('redisPort.brand: branded adapter construction', () => {
  it('exposes the computed brand when an ownership token is minted', () => {
    const token = randomBytes(32).toString('hex');
    const adapter = createRedisNodeAdapter({ url: URL, ownershipToken: token });
    expect(adapter.brand).toBe(computeRedisBrand(URL, token));
    expect(adapter.url).toBe(URL);
    void adapter.close();
  });

  it('exposes no brand without an ownership token (production-like adapters)', () => {
    const adapter = createRedisNodeAdapter({ url: URL });
    expect(adapter.brand).toBeNull();
    void adapter.close();
  });

  it('fault seams refuse when the adapter is not branded', () => {
    const adapter = createRedisNodeAdapter({ url: URL });
    expect(() =>
      adapter.armFault({ cutId: 'TEST-1', commands: 'eval', effect: 'drop' })
    ).toThrow(/ownership token/);
    void adapter.close();
  });

  it('fault seams accept when the brand matches the runner-minted token', () => {
    const token = randomBytes(32).toString('hex');
    const adapter = createRedisNodeAdapter({ url: URL, ownershipToken: token });
    expect(() =>
      adapter.armFault({ cutId: 'TEST-1', commands: 'eval', effect: 'throw', errorMessage: 'boom' })
    ).not.toThrow();
    adapter.clearFaults();
    void adapter.close();
  });

  it('an adapter is a valid RedisPort (compile-time + runtime surface)', () => {
    const token = randomBytes(32).toString('hex');
    const port: RedisPort = createRedisNodeAdapter({ url: URL, ownershipToken: token });
    expect(typeof port.get).toBe('function');
    expect(typeof port.set).toBe('function');
    expect(typeof port.eval).toBe('function');
    expect(typeof port.ping).toBe('function');
  });
});

describe('redisPort.brand: RedisCommitAmbiguousError', () => {
  it('preserves the commit state and is an Error', () => {
    const error = new RedisCommitAmbiguousError('may-have-committed');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('RedisCommitAmbiguousError');
    expect(error.commitState).toBe('may-have-committed');
  });

  it('carries the cause when provided', () => {
    const cause = new Error('connection reset');
    const error = new RedisCommitAmbiguousError('zero-write', cause);
    expect(error.commitState).toBe('zero-write');
    expect(error.cause).toBe(cause);
  });

  it('does not translate may-have-committed into a definite refusal', () => {
    const error = new RedisCommitAmbiguousError('may-have-committed');
    expect(error.commitState).toBe('may-have-committed');
  });
});
