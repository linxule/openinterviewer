// Schema lineage sentinel, bootstrap, and readiness (Revision 12 §4).
//
// P(schema-lineage) STRING `oi:lineage:{"version":2,"authority":"v2",
// "operations":"hash-v2","createdAt":<ms>}`. Idempotent bootstrap: no SCAN,
// no backfill, no claim of v1 keys. Absence of P(study-ops:v2) is not proof.
//
// Call order for every hosted request that would write a platform key:
// construct the platform RedisPort, ensurePlatformSchemaLineage, on `hold`
// respond 503 { error, retryable:false, reason:'schema-hold' } with zero
// rate-limit or other writes. Standalone does not use platform lineage.

import type { RedisPort } from './redisPort';

export const PLATFORM_SCHEMA_LINEAGE_SENTINEL = 'v2-clean';
export const SCHEMA_LINEAGE_VALUE_PREFIX = 'oi:lineage:';
export const SCHEMA_LINEAGE_KEY_SUFFIX = 'schema-lineage';

export type SchemaLineageState = 'ok' | 'hold';

export function schemaHoldPayload(): { retryable: false; reason: 'schema-hold' } {
  return { retryable: false, reason: 'schema-hold' };
}

export interface SchemaLineageV2 {
  version: 2;
  authority: 'v2';
  operations: 'hash-v2';
  createdAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Exact v2 shape check. Any other value (including malformed) is `hold`. */
export function parseSchemaLineageValue(value: unknown): SchemaLineageState {
  if (typeof value !== 'string' || !value.startsWith(SCHEMA_LINEAGE_VALUE_PREFIX)) {
    return 'hold';
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.slice(SCHEMA_LINEAGE_VALUE_PREFIX.length));
  } catch {
    return 'hold';
  }
  if (!isRecord(parsed)) return 'hold';
  const keys = Object.keys(parsed);
  if (
    keys.length !== 4
    || parsed.version !== 2
    || parsed.authority !== 'v2'
    || parsed.operations !== 'hash-v2'
    || typeof parsed.createdAt !== 'number'
    || !Number.isSafeInteger(parsed.createdAt)
    || parsed.createdAt < 0
  ) {
    return 'hold';
  }
  return 'ok';
}

export function buildSchemaLineageValue(createdAt: number): string {
  const payload: SchemaLineageV2 = {
    version: 2,
    authority: 'v2',
    operations: 'hash-v2',
    createdAt,
  };
  return `${SCHEMA_LINEAGE_VALUE_PREFIX}${JSON.stringify(payload)}`;
}

/**
 * P(k) = `${PLATFORM_KEY_PREFIX}:${k}` when the prefix is set, else `k`.
 * Hosted production without a valid prefix throws at key construction
 * (existing rule).
 */
export function platformKey(k: string): string {
  const prefix = process.env.PLATFORM_KEY_PREFIX;
  if (prefix) {
    if (!/^[a-z0-9_-]{1,64}$/.test(prefix)) {
      throw new Error('PLATFORM_KEY_PREFIX is invalid');
    }
    return `${prefix}:${k}`;
  }
  return k;
}

export function schemaLineageKey(): string {
  return platformKey(SCHEMA_LINEAGE_KEY_SUFFIX);
}

/**
 * Idempotent lineage check and bootstrap:
 * 1. GET lineage; exact v2 -> ok.
 * 2. Present and not exact v2 -> hold.
 * 3. Absent: write only when PLATFORM_SCHEMA_LINEAGE === 'v2-clean' via
 *    SET NX of the exact v2 payload, then GET and revalidate. A lost NX race
 *    that produced v2 -> ok; any other value -> hold.
 * 4. Absent and env not exactly 'v2-clean' -> hold.
 */
export async function ensurePlatformSchemaLineage(
  client: RedisPort,
  env: NodeJS.ProcessEnv = process.env
): Promise<SchemaLineageState> {
  const key = schemaLineageKey();
  const current = await client.get(key);
  if (current !== null && current !== undefined) {
    return parseSchemaLineageValue(current);
  }

  if (env.PLATFORM_SCHEMA_LINEAGE !== PLATFORM_SCHEMA_LINEAGE_SENTINEL) {
    return 'hold';
  }

  await client.set(key, buildSchemaLineageValue(Date.now()), { nx: true });
  const after = await client.get(key);
  return parseSchemaLineageValue(after);
}
