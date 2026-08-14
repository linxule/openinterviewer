// KV Client Factory
// Provides Redis clients for standalone mode (env var singleton),
// hosted mode (per-researcher dynamic clients), and platform DB

import { Redis } from '@upstash/redis';
import { createHash } from 'crypto';
import { isStandaloneMode } from './mode';

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

// Cache researcher clients keyed by Redis URL to avoid re-creation
const clientCache = new Map<string, { client: Redis; lastUsed: number }>();
const CLIENT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const CLIENT_CACHE_MAX = 50;

function evictStaleResearcherClients(now = Date.now()): void {
  clientCache.forEach((entry, key) => {
    if (now - entry.lastUsed > CLIENT_CACHE_TTL) clientCache.delete(key);
  });
}

// Credential lifecycle routes call this immediately on rotate/clear/delete so
// old tokens are not retained in a live client until normal TTL expiry.
export function evictResearcherClients(redisUrl?: string): void {
  if (!redisUrl) {
    clientCache.clear();
    return;
  }
  const prefix = `${redisUrl}:`;
  clientCache.forEach((_, key) => {
    if (key.startsWith(prefix)) clientCache.delete(key);
  });
}

// Standalone: lazily-initialized singleton using env vars
let standaloneClient: Redis | null = null;

function getStandaloneClient(): Redis {
  if (!standaloneClient) {
    const url = process.env.KV_REST_API_URL || '';
    const token = process.env.KV_REST_API_TOKEN || '';
    // Client creation doesn't throw with empty credentials.
    // Operations will fail, and isKVAvailable() will return false.
    standaloneClient = new Redis({ url, token });
  }
  return standaloneClient;
}

// Platform DB: separate singleton for the hosted platform's own KV
let platformClient: Redis | null = null;

export function getPlatformClient(): Redis {
  if (!platformClient) {
    const url = process.env.PLATFORM_KV_REST_API_URL;
    const token = process.env.PLATFORM_KV_REST_API_TOKEN;
    if (!url || !token) {
      throw new Error('PLATFORM_KV_REST_API_URL and PLATFORM_KV_REST_API_TOKEN required in hosted mode');
    }
    platformClient = new Redis({ url, token });
  }
  return platformClient;
}

// Dynamic client for a researcher's own Redis
// Cache key includes token hash so credential rotation creates a new client
export function getResearcherClient(redisUrl: string, redisToken: string): Redis {
  // Validate URL to prevent SSRF
  if (!isValidUpstashUrl(redisUrl)) {
    throw new Error('Invalid Redis URL: only Upstash Redis URLs (https://*.upstash.io) are supported');
  }

  // Expiry is enforced on every lookup, independently of cache size.
  evictStaleResearcherClients();

  const tokenHash = createHash('sha256').update(redisToken).digest('hex').slice(0, 16);
  const cacheKey = `${redisUrl}:${tokenHash}`;
  const cached = clientCache.get(cacheKey);

  if (cached) {
    cached.lastUsed = Date.now();
    return cached.client;
  }

  const client = new Redis({ url: redisUrl, token: redisToken });
  clientCache.set(cacheKey, { client, lastUsed: Date.now() });

  // Cleanup when cache exceeds max size
  if (clientCache.size > CLIENT_CACHE_MAX) {
    // If still over limit, evict least recently used.
    if (clientCache.size > CLIENT_CACHE_MAX) {
      const entries: Array<[string, number]> = [];
      clientCache.forEach((entry, key) => {
        entries.push([key, entry.lastUsed]);
      });
      entries.sort((a, b) => a[1] - b[1]);
      const toEvict = entries.slice(0, clientCache.size - CLIENT_CACHE_MAX);
      toEvict.forEach(([key]) => clientCache.delete(key));
    }
  }

  return client;
}

// Get the appropriate KV client for the current request context
// In standalone mode: returns env-var-based singleton (no credentials needed)
// In hosted mode: requires researcher's Redis credentials
export function getKVClient(credentials?: { redisUrl: string; redisToken: string }): Redis {
  if (isStandaloneMode()) {
    return getStandaloneClient();
  }

  // Hosted mode: credentials are required
  if (!credentials) {
    throw new Error('Researcher Redis credentials required in hosted mode');
  }

  return getResearcherClient(credentials.redisUrl, credentials.redisToken);
}
