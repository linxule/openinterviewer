// Schema lineage sentinel, bootstrap, and readiness state (Revision 12 §4).
// Exact v2 -> ok; any other present value -> hold; absent -> SET NX only when
// PLATFORM_SCHEMA_LINEAGE === 'v2-clean', then GET and revalidate. Idempotent,
// no SCAN, no backfill, no claim of v1 keys.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RedisEvalArg, RedisPort } from '@/lib/redisPort';
import {
  buildSchemaLineageValue,
  ensurePlatformSchemaLineage,
  parseSchemaLineageValue,
  platformKey,
  PLATFORM_SCHEMA_LINEAGE_SENTINEL,
  schemaLineageKey,
  SCHEMA_LINEAGE_VALUE_PREFIX,
} from '@/lib/platformSchema';

const EXACT_V2 = buildSchemaLineageValue(1_700_000_000_000);

class FakeRedis implements RedisPort {
  readonly store = new Map<string, unknown>();
  readonly writes: Array<{ method: string; args: unknown[] }> = [];

  private record(method: string, args: unknown[]): void {
    this.writes.push({ method, args });
  }

  get<T = unknown>(key: string): Promise<T> {
    return Promise.resolve((this.store.has(key) ? this.store.get(key) : null) as T);
  }

  set(key: string, value: string, opts?: { ex?: number; px?: number; nx?: boolean }): Promise<unknown> {
    this.record('set', [key, value, opts]);
    if (opts?.nx && this.store.has(key)) return Promise.resolve(0);
    this.store.set(key, value);
    return Promise.resolve(1);
  }

  del(...keys: string[]): Promise<number> {
    this.record('del', keys);
    let removed = 0;
    for (const key of keys) removed += this.store.delete(key) ? 1 : 0;
    return Promise.resolve(removed);
  }

  exists(...keys: string[]): Promise<number> {
    return Promise.resolve(keys.filter((key) => this.store.has(key)).length);
  }

  expire(): Promise<number> {
    return Promise.resolve(1);
  }

  eval(): Promise<unknown> {
    throw new Error('eval not used by lineage');
  }

  hget(): Promise<unknown> {
    return Promise.resolve(null);
  }

  hset(): Promise<number> {
    return Promise.resolve(0);
  }

  hdel(): Promise<number> {
    return Promise.resolve(0);
  }

  hgetall(): Promise<unknown> {
    return Promise.resolve({});
  }

  hexists(): Promise<number> {
    return Promise.resolve(0);
  }

  hlen(): Promise<number> {
    return Promise.resolve(0);
  }

  sadd(): Promise<number> {
    return Promise.resolve(0);
  }

  srem(): Promise<number> {
    return Promise.resolve(0);
  }

  scard(): Promise<number> {
    return Promise.resolve(0);
  }

  smembers(): Promise<unknown> {
    return Promise.resolve([]);
  }

  sismember(): Promise<number> {
    return Promise.resolve(0);
  }

  zadd(): Promise<number> {
    return Promise.resolve(0);
  }

  zrem(): Promise<number> {
    return Promise.resolve(0);
  }

  zscore(): Promise<string | null> {
    return Promise.resolve(null);
  }

  zcard(): Promise<number> {
    return Promise.resolve(0);
  }

  ping(): Promise<string> {
    return Promise.resolve('PONG');
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('platformSchema: parseSchemaLineageValue', () => {
  it('accepts the exact v2 shape', () => {
    expect(parseSchemaLineageValue(EXACT_V2)).toBe('ok');
    expect(parseSchemaLineageValue('oi:lineage:{"version":2,"authority":"v2","operations":"hash-v2","createdAt":1700000000000}')).toBe('ok');
  });

  it('holds on missing prefix, malformed JSON, and non-strings', () => {
    expect(parseSchemaLineageValue(null)).toBe('hold');
    expect(parseSchemaLineageValue(undefined)).toBe('hold');
    expect(parseSchemaLineageValue(42)).toBe('hold');
    expect(parseSchemaLineageValue({})).toBe('hold');
    expect(parseSchemaLineageValue('schema-lineage:{}')).toBe('hold');
    expect(parseSchemaLineageValue('oi:lineage:{not-json')).toBe('hold');
  });

  it('holds on any non-exact v2 payload', () => {
    const bad = [
      'oi:lineage:{"version":1,"authority":"v2","operations":"hash-v2","createdAt":1}',
      'oi:lineage:{"version":2,"authority":"v1","operations":"hash-v2","createdAt":1}',
      'oi:lineage:{"version":2,"authority":"v2","operations":"set-v1","createdAt":1}',
      'oi:lineage:{"version":2,"authority":"v2","operations":"hash-v2"}',
      'oi:lineage:{"version":2,"authority":"v2","operations":"hash-v2","createdAt":"1"}',
      'oi:lineage:{"version":2,"authority":"v2","operations":"hash-v2","createdAt":1.5}',
      'oi:lineage:{"version":2,"authority":"v2","operations":"hash-v2","createdAt":-1}',
      'oi:lineage:{"version":2,"authority":"v2","operations":"hash-v2","createdAt":9007199254740992}',
      'oi:lineage:{"version":2,"authority":"v2","operations":"hash-v2","createdAt":1,"extra":true}',
      'oi:lineage:[]',
    ];
    for (const value of bad) {
      expect(parseSchemaLineageValue(value), value).toBe('hold');
    }
  });
});

describe('platformSchema: buildSchemaLineageValue', () => {
  it('produces a value that re-parses as exact v2', () => {
    const value = buildSchemaLineageValue(1_700_000_000_000);
    expect(value.startsWith(SCHEMA_LINEAGE_VALUE_PREFIX)).toBe(true);
    expect(parseSchemaLineageValue(value)).toBe('ok');
  });
});

describe('platformSchema: ensurePlatformSchemaLineage', () => {
  it('returns ok with zero writes when the sentinel is already exact v2', async () => {
    const client = new FakeRedis();
    client.store.set(schemaLineageKey(), EXACT_V2);
    await expect(ensurePlatformSchemaLineage(client)).resolves.toBe('ok');
    expect(client.writes).toHaveLength(0);
  });

  it('holds with zero writes on any present non-v2 value', async () => {
    const client = new FakeRedis();
    client.store.set(schemaLineageKey(), 'oi:lineage:{"version":1}');
    await expect(ensurePlatformSchemaLineage(client)).resolves.toBe('hold');
    expect(client.writes).toHaveLength(0);
  });

  it('holds without writing when absent and env is not exactly v2-clean', async () => {
    const client = new FakeRedis();
    await expect(ensurePlatformSchemaLineage(client)).resolves.toBe('hold');
    vi.stubEnv('PLATFORM_SCHEMA_LINEAGE', 'v1-clean');
    await expect(ensurePlatformSchemaLineage(client)).resolves.toBe('hold');
    expect(client.writes).toHaveLength(0);
  });

  it('bootstraps via SET NX of the exact v2 payload when env is v2-clean', async () => {
    vi.stubEnv('PLATFORM_SCHEMA_LINEAGE', PLATFORM_SCHEMA_LINEAGE_SENTINEL);
    const client = new FakeRedis();
    await expect(ensurePlatformSchemaLineage(client)).resolves.toBe('ok');
    expect(client.writes).toHaveLength(1);
    const write = client.writes[0];
    expect(write.method).toBe('set');
    const [key, value, opts] = write.args as [string, string, { nx: boolean }];
    expect(key).toBe(schemaLineageKey());
    expect(opts.nx).toBe(true);
    expect(parseSchemaLineageValue(value)).toBe('ok');
  });

  it('returns ok when a lost NX race still produced exact v2', async () => {
    vi.stubEnv('PLATFORM_SCHEMA_LINEAGE', PLATFORM_SCHEMA_LINEAGE_SENTINEL);
    const client = new FakeRedis();
    client.store.set(schemaLineageKey(), EXACT_V2); // another writer won the race
    await expect(ensurePlatformSchemaLineage(client)).resolves.toBe('ok');
  });

  it('holds when a lost NX race produced a non-v2 value', async () => {
    vi.stubEnv('PLATFORM_SCHEMA_LINEAGE', PLATFORM_SCHEMA_LINEAGE_SENTINEL);
    const client = new FakeRedis();
    client.store.set(schemaLineageKey(), 'oi:lineage:{"version":1}');
    await expect(ensurePlatformSchemaLineage(client)).resolves.toBe('hold');
  });

  it('holds when the post-write GET comes back empty', async () => {
    vi.stubEnv('PLATFORM_SCHEMA_LINEAGE', PLATFORM_SCHEMA_LINEAGE_SENTINEL);
    const client = new FakeRedis();
    const originalSet = client.set.bind(client);
    client.set = (key, value, opts) => {
      if (opts?.nx) return Promise.resolve(1); // claim success but store nothing
      return originalSet(key, value, opts);
    };
    await expect(ensurePlatformSchemaLineage(client)).resolves.toBe('hold');
  });
});

describe('platformSchema: platform key construction', () => {
  it('prefixes keys when PLATFORM_KEY_PREFIX is set', () => {
    vi.stubEnv('PLATFORM_KEY_PREFIX', 'build-test');
    expect(platformKey('schema-lineage')).toBe('build-test:schema-lineage');
    expect(schemaLineageKey()).toBe('build-test:schema-lineage');
  });

  it('uses bare keys without a prefix', () => {
    vi.stubEnv('PLATFORM_KEY_PREFIX', '');
    expect(schemaLineageKey()).toBe('schema-lineage');
  });

  it('throws on an invalid prefix at key construction', () => {
    vi.stubEnv('PLATFORM_KEY_PREFIX', 'BAD PREFIX!');
    expect(() => platformKey('schema-lineage')).toThrow();
  });
});

describe('platformSchema: RedisPort surface', () => {
  it('declares the closed port methods with the contract signatures', () => {
    const port: RedisPort = new FakeRedis();
    expect(typeof port.get).toBe('function');
    expect(typeof port.eval).toBe('function');
    void (port.eval as (script: string, keys: string[], args: RedisEvalArg[]) => Promise<unknown>);
  });
});
