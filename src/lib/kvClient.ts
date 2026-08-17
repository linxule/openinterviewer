// KV Client Factory (Revision 12 §2 / §12)
// Provides RedisPort clients for standalone mode (env var singleton), hosted
// mode (per-researcher dynamic clients), and the platform DB. Every adapter
// implements RedisPort; never expose @upstash/redis `Redis` to callers.

import { Redis as UpstashRedis } from '@upstash/redis';
import { createHash } from 'crypto';
import { isStandaloneMode } from './mode';
import type { RedisEvalArg, RedisPort } from './redisPort';

// Only allow Upstash Redis URLs to prevent SSRF against internal services
export function isValidUpstashUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname.endsWith('.upstash.io')
    );
  } catch {
    return false;
  }
}

// Production adapter: wraps @upstash/redis `Redis` and exposes only RedisPort.
// No fault hook in production. eval always passes string[] keys and string[]
// args.
class UpstashRedisAdapter implements RedisPort {
  private readonly inner: UpstashRedis;

  constructor(inner: UpstashRedis) {
    this.inner = inner;
  }

  get<T = unknown>(key: string): Promise<T | null> {
    return this.inner.get<T>(key);
  }

  set(key: string, value: string, opts?: { ex?: number; px?: number; nx?: boolean }): Promise<unknown> {
    if (!opts) return this.inner.set(key, value);
    const options: { ex?: number; px?: number; nx?: true } = {};
    if (opts.ex !== undefined) options.ex = opts.ex;
    if (opts.px !== undefined) options.px = opts.px;
    if (opts.nx) options.nx = true;
    return this.inner.set(key, value, options as never);
  }

  del(...keys: string[]): Promise<number> {
    if (keys.length === 0) return Promise.resolve(0);
    return this.inner.del(...keys);
  }

  exists(...keys: string[]): Promise<number> {
    if (keys.length === 0) return Promise.resolve(0);
    return this.inner.exists(...keys);
  }

  expire(key: string, seconds: number): Promise<number> {
    return this.inner.expire(key, seconds);
  }

  eval(script: string, keys: string[], args: RedisEvalArg[]): Promise<unknown> {
    return this.inner.eval(script, keys, args);
  }

  hget(key: string, field: string): Promise<unknown> {
    return this.inner.hget(key, field);
  }

  hset(key: string, field: string, value: string): Promise<number> {
    return this.inner.hset(key, { [field]: value });
  }

  hdel(key: string, ...fields: string[]): Promise<number> {
    if (fields.length === 0) return Promise.resolve(0);
    return this.inner.hdel(key, ...fields);
  }

  hgetall(key: string): Promise<unknown> {
    return this.inner.hgetall(key);
  }

  hexists(key: string, field: string): Promise<number> {
    return this.inner.hexists(key, field);
  }

  hlen(key: string): Promise<number> {
    return this.inner.hlen(key);
  }

  sadd(key: string, ...members: string[]): Promise<number> {
    if (members.length === 0) return Promise.resolve(0);
    return this.inner.sadd(key, members[0]!, ...members.slice(1));
  }

  srem(key: string, ...members: string[]): Promise<number> {
    if (members.length === 0) return Promise.resolve(0);
    return this.inner.srem(key, members[0]!, ...members.slice(1));
  }

  scard(key: string): Promise<number> {
    return this.inner.scard(key);
  }

  smembers(key: string): Promise<unknown> {
    return this.inner.smembers(key);
  }

  sismember(key: string, member: string): Promise<number> {
    return this.inner.sismember(key, member);
  }

  zadd(key: string, score: number, member: string): Promise<number> {
    return this.inner.zadd(key, { score, member }) as Promise<number>;
  }

  zrem(key: string, ...members: string[]): Promise<number> {
    if (members.length === 0) return Promise.resolve(0);
    return this.inner.zrem(key, members[0]!, ...members.slice(1));
  }

  zscore(key: string, member: string): Promise<string | null> {
    return this.inner.zscore(key, member).then((score) => (
      score === null || score === undefined ? null : String(score)
    ));
  }

  zcard(key: string): Promise<number> {
    return this.inner.zcard(key);
  }

  ping(): Promise<string> {
    return this.inner.ping();
  }
}

// Researcher BYOS clients are keyed by researcher + origin + token, never by
// raw URL. Eviction is process-local: other isolates may retain a branded
// client until CLIENT_CACHE_TTL_MS. Token rotation on the same origin relies
// on tokenHash in the cache key plus scoped eviction on this isolate.
const clientCache = new Map<string, { client: UpstashRedisAdapter; lastUsed: number }>();
export const CLIENT_CACHE_TTL_MS = 300_000;
export const CLIENT_CACHE_MAX = 50;

export type CacheEvictDisposition =
  | { disposition: 'none' }
  | { disposition: 'scoped'; researcherId: string; storageId: string }
  | { disposition: 'full'; researcherId: string };

export interface ResearcherClientIdentity {
  researcherId: string;
  storageId?: string;
}

/**
 * Canonical cache key (Revision 12 §12):
 * `${researcherId}:${storageId}:${tokenHash}`.
 */
export function buildResearcherCacheKey(options: {
  researcherId: string;
  storageId: string;
  tokenHash: string;
}): string {
  return `${options.researcherId}:${options.storageId}:${options.tokenHash}`;
}

const HASH_SEP = String.fromCharCode(0);

function domainHash(name: string, value: string): string {
  return createHash('sha256')
    .update(name)
    .update(HASH_SEP)
    .update(value)
    .digest('hex');
}

/** sha256(`oi:token-hash:v1` + 0x00 + raw token bytes), full 64 hex. */
export function tokenHash(rawToken: string): string {
  return domainHash('oi:token-hash:v1', rawToken);
}

/**
 * After isValidUpstashUrl: `https://${hostname.toLowerCase()}` with no path,
 * query, userinfo, or port. storageId is never derived from the token or the
 * raw pasted URL string.
 */
export function canonicalRedisOrigin(url: string): string | null {
  if (!isValidUpstashUrl(url)) return null;
  try {
    return `https://${new URL(url).hostname.toLowerCase()}`;
  } catch {
    return null;
  }
}

/** sha256(`oi:storage-id:v1` + 0x00 + canonicalOrigin), 64 hex. */
export function storageIdFromRedisUrl(url: string): string | null {
  const origin = canonicalRedisOrigin(url);
  if (!origin) return null;
  return domainHash('oi:storage-id:v1', origin);
}

/** Fingerprint of the exact encrypted url+token pair stored on the binding. */
export function redisCipherSnapshot(encryptedUrl: string, encryptedToken: string): string {
  return createHash('sha256')
    .update('oi:cipher-snapshot:v1')
    .update(HASH_SEP)
    .update(encryptedUrl)
    .update(HASH_SEP)
    .update(encryptedToken)
    .digest('hex');
}

function evictStaleResearcherClients(now = Date.now()): void {
  clientCache.forEach((entry, key) => {
    if (now - entry.lastUsed > CLIENT_CACHE_TTL_MS) clientCache.delete(key);
  });
}

function cacheKeySegments(key: string): [string, string, string] | null {
  const first = key.indexOf(':');
  if (first <= 0) return null;
  const second = key.indexOf(':', first + 1);
  if (second <= first + 1 || second === key.length - 1) return null;
  return [key.slice(0, first), key.slice(first + 1, second), key.slice(second + 1)];
}

/**
 * Disposition eviction (Revision 12 §12). Never evict another researcher who
 * shares the same Upstash origin. URL-keyed and no-arg full-map clears are gone.
 */
export function evictResearcherClients(target: CacheEvictDisposition): void {
  if (target.disposition === 'none') return;
  if (target.disposition === 'full') {
    clientCache.forEach((_, key) => {
      const parts = cacheKeySegments(key);
      if (parts && parts[0] === target.researcherId) clientCache.delete(key);
    });
    return;
  }
  clientCache.forEach((_, key) => {
    const parts = cacheKeySegments(key);
    if (parts && parts[0] === target.researcherId && parts[1] === target.storageId) {
      clientCache.delete(key);
    }
  });
}

// Standalone: lazily-initialized singleton using env vars
let standaloneClient: UpstashRedisAdapter | null = null;

function getStandaloneClient(): RedisPort {
  if (!standaloneClient) {
    const url = process.env.KV_REST_API_URL || '';
    const token = process.env.KV_REST_API_TOKEN || '';
    // Client creation doesn't throw with empty credentials.
    // Operations will fail, and isKVAvailable() will return false.
    standaloneClient = new UpstashRedisAdapter(new UpstashRedis({ url, token }));
  }
  return standaloneClient;
}

// Platform DB: separate singleton for the hosted platform's own KV
let platformClient: UpstashRedisAdapter | null = null;

export function getPlatformClient(): RedisPort {
  if (!platformClient) {
    const url = process.env.PLATFORM_KV_REST_API_URL;
    const token = process.env.PLATFORM_KV_REST_API_TOKEN;
    if (!url || !token) {
      throw new Error('PLATFORM_KV_REST_API_URL and PLATFORM_KV_REST_API_TOKEN required in hosted mode');
    }
    platformClient = new UpstashRedisAdapter(new UpstashRedis({ url, token }));
  }
  return platformClient;
}

// Dynamic client for a researcher's own Redis.
// Cache key includes researcherId + storageId + tokenHash so same-origin
// token rotation is a new entry and cross-researcher shared-origin entries
// stay isolated.
export function getResearcherClient(
  redisUrl: string,
  redisToken: string,
  identity: ResearcherClientIdentity,
): RedisPort {
  if (!isValidUpstashUrl(redisUrl)) {
    throw new Error('Invalid Redis URL: only Upstash Redis URLs (https://*.upstash.io) are supported');
  }
  if (!identity.researcherId) {
    throw new Error('Researcher identity is required for hosted Redis clients');
  }

  evictStaleResearcherClients();

  const storageId = identity.storageId ?? storageIdFromRedisUrl(redisUrl);
  if (!storageId) {
    throw new Error('Invalid Redis URL: only Upstash Redis URLs (https://*.upstash.io) are supported');
  }

  const cacheKey = buildResearcherCacheKey({
    researcherId: identity.researcherId,
    storageId,
    tokenHash: tokenHash(redisToken),
  });
  const cached = clientCache.get(cacheKey);

  if (cached) {
    cached.lastUsed = Date.now();
    return cached.client;
  }

  const client = new UpstashRedisAdapter(new UpstashRedis({ url: redisUrl, token: redisToken }));
  clientCache.set(cacheKey, { client, lastUsed: Date.now() });

  if (clientCache.size > CLIENT_CACHE_MAX) {
    const entries: Array<[string, number]> = [];
    clientCache.forEach((entry, key) => {
      entries.push([key, entry.lastUsed]);
    });
    entries.sort((a, b) => a[1] - b[1]);
    const toEvict = entries.slice(0, clientCache.size - CLIENT_CACHE_MAX);
    toEvict.forEach(([key]) => clientCache.delete(key));
  }

  return client;
}

export function getKVClient(credentials?: {
  redisUrl: string;
  redisToken: string;
  researcherId: string;
  storageId?: string;
}): RedisPort {
  if (isStandaloneMode()) {
    return getStandaloneClient();
  }

  if (!credentials) {
    throw new Error('Researcher Redis credentials required in hosted mode');
  }

  return getResearcherClient(credentials.redisUrl, credentials.redisToken, {
    researcherId: credentials.researcherId,
    storageId: credentials.storageId,
  });
}
