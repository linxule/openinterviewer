// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const redisConstructor = vi.hoisted(() => vi.fn(function RedisMock(this: Record<string, unknown>) {
  this.ping = vi.fn(async () => 'PONG');
  return this;
}));
vi.mock('@upstash/redis', () => ({ Redis: redisConstructor }));

import {
  RedisAccessFencedError,
  createFencedRedisPort,
  getKVClient,
  getPlatformClient,
  getResearcherClient,
  isRedisAccessFenced,
  isValidUpstashUrl,
} from '@/lib/kvClient';
import type { RedisPort } from '@/lib/redisPort';
import { WORKER_RUNTIME_MARKER } from '@/lib/runtime/workerInvocation';

const REDIS_URL = 'https://fence-probe.upstash.io';
const REDIS_TOKEN = 'fence-probe-token-value';
const runtimeGlobals = globalThis as unknown as Record<symbol, unknown>;

const ENV_NAMES = [
  'DEPLOYMENT_TARGET',
  'DEPLOYMENT_MODE',
  'KV_REST_API_URL',
  'KV_REST_API_TOKEN',
  'PLATFORM_KV_REST_API_URL',
  'PLATFORM_KV_REST_API_TOKEN',
] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  process.env.DEPLOYMENT_MODE = 'standalone';
  process.env.KV_REST_API_URL = REDIS_URL;
  process.env.KV_REST_API_TOKEN = REDIS_TOKEN;
  process.env.PLATFORM_KV_REST_API_URL = REDIS_URL;
  process.env.PLATFORM_KV_REST_API_TOKEN = REDIS_TOKEN;
  delete process.env.DEPLOYMENT_TARGET;
  redisConstructor.mockClear();
});

afterEach(() => {
  delete runtimeGlobals[WORKER_RUNTIME_MARKER];
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

function expectFenced(action: () => unknown): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RedisAccessFencedError);
  const message = (thrown as Error).message;
  expect(message).toBe('Redis access is not available on the Cloudflare runtime');
  expect(message).not.toContain(REDIS_URL);
  expect(message).not.toContain(REDIS_TOKEN);
}

const factories: Array<[string, () => unknown]> = [
  ['getKVClient (standalone)', () => getKVClient()],
  ['getKVClient (hosted credentials)', () => getKVClient({ redisUrl: REDIS_URL, redisToken: REDIS_TOKEN, researcherId: 'r1' })],
  ['getPlatformClient', () => getPlatformClient()],
  ['getResearcherClient', () => getResearcherClient(REDIS_URL, REDIS_TOKEN, { researcherId: 'r1' })],
];

describe('RT-01 Redis fence inside a Worker', () => {
  it.each(factories)('RT-01 %s refuses in a Worker runtime regardless of env', (_label, factory) => {
    runtimeGlobals[WORKER_RUNTIME_MARKER] = true;
    expect(isRedisAccessFenced()).toBe(true);
    expectFenced(factory);
    process.env.DEPLOYMENT_TARGET = 'node';
    expectFenced(factory);
    process.env.DEPLOYMENT_MODE = 'hosted';
    expectFenced(factory);
    expect(redisConstructor).not.toHaveBeenCalled();
  });

  it.each(factories)('RT-01 %s refuses whenever the target is cloudflare', (_label, factory) => {
    process.env.DEPLOYMENT_TARGET = 'cloudflare';
    expectFenced(factory);
    expect(redisConstructor).not.toHaveBeenCalled();
  });

  it('RT-01 the fence also refuses a client cached before the marker appeared', () => {
    const client = getKVClient();
    const constructed = redisConstructor.mock.calls.length;
    runtimeGlobals[WORKER_RUNTIME_MARKER] = true;
    expectFenced(() => getKVClient());
    delete runtimeGlobals[WORKER_RUNTIME_MARKER];
    expect(getKVClient()).toBe(client);
    expect(redisConstructor).toHaveBeenCalledTimes(constructed);
  });

  it('RT-01 Node standalone still constructs its Redis client', () => {
    expect(isRedisAccessFenced()).toBe(false);
    expect(() => getKVClient()).not.toThrow();
  });
});

describe('RT-01 fenced RedisPort', () => {
  const calls: Array<[keyof RedisPort, (port: RedisPort) => Promise<unknown>]> = [
    ['get', (port) => port.get('k')],
    ['set', (port) => port.set('k', 'v', { nx: true })],
    ['del', (port) => port.del('k')],
    ['exists', (port) => port.exists('k')],
    ['expire', (port) => port.expire('k', 1)],
    ['eval', (port) => port.eval('return 1', ['k'], ['a'])],
    ['hget', (port) => port.hget('k', 'f')],
    ['hset', (port) => port.hset('k', 'f', 'v')],
    ['hdel', (port) => port.hdel('k', 'f')],
    ['hgetall', (port) => port.hgetall('k')],
    ['hexists', (port) => port.hexists('k', 'f')],
    ['hlen', (port) => port.hlen('k')],
    ['sadd', (port) => port.sadd('k', 'm')],
    ['srem', (port) => port.srem('k', 'm')],
    ['scard', (port) => port.scard('k')],
    ['smembers', (port) => port.smembers('k')],
    ['sismember', (port) => port.sismember('k', 'm')],
    ['zadd', (port) => port.zadd('k', 1, 'm')],
    ['zrem', (port) => port.zrem('k', 'm')],
    ['zscore', (port) => port.zscore('k', 'm')],
    ['zcard', (port) => port.zcard('k')],
    ['ping', (port) => port.ping()],
  ];

  it.each(calls)('RT-01 %s rejects with RedisAccessFencedError without I/O', async (_name, call) => {
    const port = createFencedRedisPort();
    await expect(call(port)).rejects.toBeInstanceOf(RedisAccessFencedError);
    expect(redisConstructor).not.toHaveBeenCalled();
  });

  it('RT-01 covers every RedisPort method', () => {
    expect(Object.keys(createFencedRedisPort()).sort()).toEqual(calls.map(([name]) => name).sort());
  });
});

describe('RT-01 Upstash URL validation is unchanged', () => {
  it('RT-01 accepts only HTTPS Upstash hosts', () => {
    expect(isValidUpstashUrl('https://example.upstash.io')).toBe(true);
    expect(isValidUpstashUrl('http://example.upstash.io')).toBe(false);
    expect(isValidUpstashUrl('https://example.upstash.io.evil.example')).toBe(false);
    expect(isValidUpstashUrl('not a url')).toBe(false);
  });
});
