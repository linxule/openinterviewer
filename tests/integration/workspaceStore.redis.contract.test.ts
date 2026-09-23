// @vitest-environment node
// ST-01: the shared WorkspaceStorePort scenarios against the Redis store on a
// runner-owned disposable Redis (never an inherited or shared instance).
//
// Replies pass through the automatic deserialization the production Upstash
// client applies to every command, so legacy bare-JSON records (the sample
// workspace) read back exactly as they do in production. The node-redis test
// adapter alone returns raw strings.

import { afterAll, beforeAll } from 'vitest';
import type { RedisPort } from '@/lib/redisPort';
import { createRedisWorkspaceStore } from '@/lib/storage/redis';
import { startDisposableRedis, type DisposableRedis } from '../helpers/disposableRedis';
import { defineWorkspaceStoreContract } from '../contract/workspaceStoreScenarios';

process.env.DEPLOYMENT_MODE = 'standalone';
delete process.env.DEPLOYMENT_TARGET;
delete process.env.REDIS_URL;
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;
delete process.env.PLATFORM_KV_REST_API_URL;
delete process.env.PLATFORM_KV_REST_API_TOKEN;

// Mirrors @upstash/redis parseResponse: JSON-parse strings (recursively in
// arrays), but keep a numeric-looking string whose number form differs.
function parseRecursive(value: unknown): unknown {
  const parsed = Array.isArray(value)
    ? value.map((item) => {
      try {
        return parseRecursive(item);
      } catch {
        return item;
      }
    })
    : JSON.parse(value as string);
  if (typeof parsed === 'number' && parsed.toString() !== value) return value;
  return parsed;
}

function upstashReply(value: unknown): unknown {
  try {
    return parseRecursive(value);
  } catch {
    return value;
  }
}

function withUpstashReplies(inner: RedisPort): RedisPort {
  return new Proxy(inner, {
    get(target, property, receiver) {
      const member = Reflect.get(target, property, receiver);
      if (typeof member !== 'function') return member;
      return (...args: unknown[]) =>
        Promise.resolve(member.apply(target, args)).then(upstashReply);
    },
  });
}

let owned: DisposableRedis | undefined;
let port: RedisPort | undefined;

beforeAll(async () => {
  owned = await startDisposableRedis();
  if (!owned.url.startsWith('redis://127.0.0.1:')) throw new Error('refusing a non-loopback Redis');
  port = withUpstashReplies(owned.adapter());
}, 60_000);

afterAll(async () => {
  await owned?.close();
});

defineWorkspaceStoreContract('Redis store on disposable redis-server', {
  backend: 'redis',
  async createStore() {
    if (!port) throw new Error('disposable Redis is not ready');
    return createRedisWorkspaceStore(port, { researcherId: null });
  },
  capabilities: {
    storeBoundaryLinkChecks: false,
    atomicSaveAdmission: false,
    sampleClearCascadesLinks: false,
  },
});
