// @vitest-environment node
// Gap F5: the Node standalone sign-in budget's scripts on a runner-owned
// disposable Redis (never an inherited or shared instance). The route over a
// modelled Redis is tests/unit/api.auth.node.test.ts; the Cloudflare budget
// with the same policy is tests/workers/login.test.ts.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RedisPort } from '@/lib/redisPort';
import type { AdmissionIdentity } from '@/lib/runtime/workerInvocation';
import { loginClientKey } from '@/lib/storage/durableObject';
import {
  LOGIN_GLOBAL_KEY,
  createRedisLoginBudget,
  loginClientRedisKey,
} from '@/lib/storage/redisLoginBudget';
import {
  LOGIN_CLIENT_MAX_FAILURES,
  LOGIN_CLIENT_WINDOW_SECONDS,
  LOGIN_GLOBAL_MAX_FAILURES,
  LOGIN_GLOBAL_WINDOW_SECONDS,
} from '@/lib/storage/types';
import { startDisposableRedis, type DisposableRedis } from '../helpers/disposableRedis';

delete process.env.REDIS_URL;
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;

const SALT = 'synthetic-rate-limit-salt-0123456789abcdef';
const V4: AdmissionIdentity = { kind: 'address', address: '203.0.113.7' };
const NOW = 0;

let owned: DisposableRedis | undefined;
let port: RedisPort | undefined;

beforeAll(async () => {
  owned = await startDisposableRedis();
  if (!owned.url.startsWith('redis://127.0.0.1:')) throw new Error('refusing a non-loopback Redis');
  port = owned.adapter();
}, 60_000);

afterAll(async () => {
  await owned?.close();
});

function redis(): RedisPort {
  if (!port) throw new Error('disposable Redis is not ready');
  return port;
}

/** One raw command through EVAL (the port has no PTTL/PEXPIRE/FLUSHDB). */
function command(...parts: string[]): Promise<unknown> {
  return redis().eval(`return redis.call(unpack(ARGV))`, [], parts);
}

async function count(key: string): Promise<number | null> {
  const value = await command('GET', key);
  return value === null ? null : Number(value);
}

async function clientKey(identity: AdmissionIdentity | null): Promise<string> {
  return loginClientRedisKey(await loginClientKey(SALT, identity));
}

beforeEach(async () => {
  await command('FLUSHDB');
});

describe('F5 Node sign-in budget on real Redis', () => {
  it('F5 counts 10 per client in a fixed 15-minute window opened by the first attempt; a refused attempt counts nowhere', async () => {
    const budget = createRedisLoginBudget(redis(), SALT);
    for (let attempt = 0; attempt < LOGIN_CLIENT_MAX_FAILURES; attempt += 1) {
      expect(await budget.admitLoginAttempt({ identity: V4, now: NOW })).toEqual({ status: 'admitted' });
    }
    const limited = await budget.admitLoginAttempt({ identity: V4, now: NOW });
    expect(limited).toMatchObject({ status: 'limited', scope: 'client' });
    if (limited.status !== 'limited') throw new Error('unreachable');
    expect(limited.retryAfterSeconds).toBeGreaterThan(LOGIN_CLIENT_WINDOW_SECONDS - 5);
    expect(limited.retryAfterSeconds).toBeLessThanOrEqual(LOGIN_CLIENT_WINDOW_SECONDS);

    const key = await clientKey(V4);
    expect(await count(key)).toBe(LOGIN_CLIENT_MAX_FAILURES);
    expect(await count(LOGIN_GLOBAL_KEY)).toBe(LOGIN_CLIENT_MAX_FAILURES);
    expect(Number(await command('PTTL', LOGIN_GLOBAL_KEY))).toBeGreaterThan((LOGIN_GLOBAL_WINDOW_SECONDS - 5) * 1000);
    const keys = (await command('KEYS', '*')) as string[];
    expect(keys.sort()).toEqual([LOGIN_GLOBAL_KEY, key].sort());
    expect(JSON.stringify(keys)).not.toContain('203.0.113.7');
  });

  it('F5 later attempts never extend a window', async () => {
    const budget = createRedisLoginBudget(redis(), SALT);
    await budget.admitLoginAttempt({ identity: V4, now: NOW });
    const key = await clientKey(V4);
    await command('PEXPIRE', key, '5000');
    await budget.admitLoginAttempt({ identity: V4, now: NOW });
    expect(await count(key)).toBe(2);
    expect(Number(await command('PTTL', key))).toBeLessThanOrEqual(5000);
  });

  it('F5 a refund returns one attempt to both windows and removes a window left at zero', async () => {
    const budget = createRedisLoginBudget(redis(), SALT);
    await budget.admitLoginAttempt({ identity: V4, now: NOW });
    await budget.admitLoginAttempt({ identity: V4, now: NOW });
    const key = await clientKey(V4);
    const ttlBefore = Number(await command('PTTL', key));
    expect(await budget.refundLoginAttempt({ identity: V4, now: NOW })).toEqual({ status: 'refunded' });
    expect(await count(key)).toBe(1);
    expect(Number(await command('PTTL', key))).toBeGreaterThan(0);
    expect(Number(await command('PTTL', key))).toBeLessThanOrEqual(ttlBefore);
    expect(await budget.refundLoginAttempt({ identity: V4, now: NOW })).toEqual({ status: 'refunded' });
    expect(await command('EXISTS', key, LOGIN_GLOBAL_KEY)).toBe(0);
    // A refund with nothing counted (the window ended meanwhile) is a no-op.
    expect(await budget.refundLoginAttempt({ identity: V4, now: NOW })).toEqual({ status: 'refunded' });
    expect(await command('DBSIZE')).toBe(0);
  });

  it('F5 the global window refuses every client at 200 and reports the later end when both are full', async () => {
    const budget = createRedisLoginBudget(redis(), SALT);
    await command('SET', LOGIN_GLOBAL_KEY, String(LOGIN_GLOBAL_MAX_FAILURES), 'PX', '1800000');
    const other: AdmissionIdentity = { kind: 'address', address: '198.51.100.1' };
    expect(await budget.admitLoginAttempt({ identity: other, now: NOW })).toMatchObject({ status: 'limited', scope: 'global' });
    expect(await command('EXISTS', await clientKey(other))).toBe(0);

    await command('SET', await clientKey(V4), String(LOGIN_CLIENT_MAX_FAILURES), 'PX', '600000');
    expect(await budget.admitLoginAttempt({ identity: V4, now: NOW })).toMatchObject({ status: 'limited', scope: 'global' });
    await command('PEXPIRE', LOGIN_GLOBAL_KEY, '60000');
    const later = await budget.admitLoginAttempt({ identity: V4, now: NOW });
    expect(later).toMatchObject({ status: 'limited', scope: 'client' });
    if (later.status !== 'limited') throw new Error('unreachable');
    expect(later.retryAfterSeconds).toBeGreaterThan(590);
    expect(await count(LOGIN_GLOBAL_KEY)).toBe(LOGIN_GLOBAL_MAX_FAILURES);
  });

  it('F5 a full counter without an expiry is given one instead of refusing forever', async () => {
    const budget = createRedisLoginBudget(redis(), SALT);
    const key = await clientKey(V4);
    await command('SET', key, String(LOGIN_CLIENT_MAX_FAILURES));
    expect(await budget.admitLoginAttempt({ identity: V4, now: NOW })).toEqual({
      status: 'limited',
      scope: 'client',
      retryAfterSeconds: LOGIN_CLIENT_WINDOW_SECONDS,
    });
    expect(Number(await command('PTTL', key))).toBeGreaterThan(0);
  });

  it('F5 a corrupt counter makes admission unavailable (the route fails closed) and changes nothing', async () => {
    const budget = createRedisLoginBudget(redis(), SALT);
    await command('SET', LOGIN_GLOBAL_KEY, 'not-a-number');
    expect(await budget.admitLoginAttempt({ identity: V4, now: NOW })).toEqual({ status: 'unavailable' });
    expect(await command('EXISTS', await clientKey(V4))).toBe(0);
    expect(await budget.refundLoginAttempt({ identity: V4, now: NOW })).toEqual({ status: 'unavailable' });
  });

  it('F5 a concurrent burst from one client is admitted exactly 10 times', async () => {
    const budget = createRedisLoginBudget(redis(), SALT);
    const outcomes = await Promise.all(
      Array.from({ length: 40 }, () => budget.admitLoginAttempt({ identity: V4, now: NOW })),
    );
    expect(outcomes.filter((outcome) => outcome.status === 'admitted')).toHaveLength(LOGIN_CLIENT_MAX_FAILURES);
    expect(outcomes.filter((outcome) => outcome.status === 'limited')).toHaveLength(40 - LOGIN_CLIENT_MAX_FAILURES);
    expect(await count(LOGIN_GLOBAL_KEY)).toBe(LOGIN_CLIENT_MAX_FAILURES);
  });

  it('F5 RT-07 (owner amendment) an IPv6 /64 shares one budget; another /64 does not', async () => {
    const budget = createRedisLoginBudget(redis(), SALT);
    for (let attempt = 0; attempt < LOGIN_CLIENT_MAX_FAILURES; attempt += 1) {
      const address = `2001:db8:0:1:${attempt.toString(16)}::1`;
      expect(await budget.admitLoginAttempt({ identity: { kind: 'address', address }, now: NOW })).toEqual({ status: 'admitted' });
    }
    expect(await budget.admitLoginAttempt({ identity: { kind: 'address', address: '2001:DB8:0:1::FFFF' }, now: NOW }))
      .toMatchObject({ status: 'limited', scope: 'client' });
    expect(await budget.admitLoginAttempt({ identity: { kind: 'address', address: '2001:db8:0:2::1' }, now: NOW }))
      .toEqual({ status: 'admitted' });
  });
});
