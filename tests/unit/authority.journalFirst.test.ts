// @vitest-environment node

process.env.PLATFORM_KEY_PREFIX = '';

import { describe, expect, it } from 'vitest';
import { RedisCommitAmbiguousError } from '@/lib/redisPort';
import { buildSchemaLineageValue } from '@/lib/platformSchema';
import {
  AUTHORITY_GATE_LUA,
  buildPendingStudyOperationV2,
  encodeAccountRecord,
  encodeLockValue,
  encodeOperationRecord,
  encodeOwnerRecord,
  encodeStorageBinding,
  getStudyAuthorityChecked,
  hostedAuthorityKeys,
  type AuthorityPurpose,
} from '@/lib/platformDb';
import { MemoryPlatformRedis } from '../helpers/memoryPlatformRedis';

const STUDY_ID = '11111111-1111-4111-8111-111111111111';
const RESEARCHER = 'researcher-a';
const OTHER = 'researcher-b';
const STORAGE_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_STORAGE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const FINGERPRINT = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
const NONCE = '0123456789abcdef0123456789abcdef';
const NOW = 1_700_000_000_000;

function ownerRecord() {
  return { version: 2 as const, researcherId: RESEARCHER, storageId: STORAGE_ID, generation: 1 };
}

function seedBoundOwner(redis: MemoryPlatformRedis, overrides?: { journalCaller?: string; lineage?: string | null }) {
  if (overrides?.lineage === undefined) {
    redis.strings.set('schema-lineage', buildSchemaLineageValue(NOW));
  } else if (overrides.lineage !== null) {
    redis.strings.set('schema-lineage', overrides.lineage);
  }
  redis.strings.set(`researcher:${RESEARCHER}`, encodeAccountRecord({ id: RESEARCHER }));
  redis.strings.set(`researcher:${OTHER}`, encodeAccountRecord({ id: OTHER }));
  redis.strings.set(`study-owner:${STUDY_ID}`, encodeOwnerRecord(ownerRecord()));
  redis.sets.set(`researcher-studies:${RESEARCHER}`, new Set([STUDY_ID]));
  redis.strings.set(
    `researcher-storage:${RESEARCHER}`,
    encodeStorageBinding({
      version: 2,
      researcherId: RESEARCHER,
      storageId: STORAGE_ID,
      originHash: STORAGE_ID,
      credentialRevision: 1,
      bindingEpoch: 7,
      cipherSnapshot: 'cipher',
    }),
  );
  redis.sets.set(`storage-researchers:${STORAGE_ID}`, new Set([RESEARCHER]));
  if (overrides?.journalCaller) {
    const journal = redis.hashes.get('account-delete-journal') ?? new Map<string, string>();
    journal.set(overrides.journalCaller, 'oi:adel-journal:{"version":2}');
    redis.hashes.set('account-delete-journal', journal);
  }
}

function seedLive(
  redis: MemoryPlatformRedis,
  kind: 'create' | 'delete',
  phase: 'reserving' | 'pending' | 'resolving' | 'publishing',
) {
  const op = buildPendingStudyOperationV2({
    kind,
    phase,
    researcherId: RESEARCHER,
    studyId: STUDY_ID,
    generation: 1,
    opNonce: NONCE,
    createdAt: NOW,
    idempotencyHash: kind === 'create' ? HASH : null,
    fingerprint: kind === 'create' ? FINGERPRINT : null,
  });
  const hash = redis.hashes.get('study-ops:v2') ?? new Map<string, string>();
  hash.set(STUDY_ID, encodeOperationRecord(op));
  redis.hashes.set('study-ops:v2', hash);
}

function check(
  redis: MemoryPlatformRedis,
  purpose: AuthorityPurpose,
  researcherId = RESEARCHER,
) {
  return getStudyAuthorityChecked({
    client: redis.asPort(),
    researcherId,
    studyId: STUDY_ID,
    purpose,
  });
}

describe('authority gate KEYS and read-only order', () => {
  it('uses lineage → journal → account → owner/storage/reverse → registry/lock', () => {
    expect(hostedAuthorityKeys(STUDY_ID)).toEqual([
      'account-delete-journal',
      `study-owner:${STUDY_ID}`,
      'study-ops:v2',
      `study-op-lock:${STUDY_ID}`,
      'schema-lineage',
    ]);
    const lineage = AUTHORITY_GATE_LUA.indexOf("redis.call('GET', KEYS[5])");
    const journal = AUTHORITY_GATE_LUA.indexOf("redis.call('HEXISTS', KEYS[1]");
    const account = AUTHORITY_GATE_LUA.indexOf('ARGV[4] .. caller');
    const owner = AUTHORITY_GATE_LUA.indexOf("redis.call('GET', KEYS[2])");
    const reverse = AUTHORITY_GATE_LUA.indexOf('ARGV[5] .. owner.researcherId');
    const storage = AUTHORITY_GATE_LUA.indexOf('ARGV[6] .. owner.researcherId');
    const storageReverse = AUTHORITY_GATE_LUA.indexOf('ARGV[7] .. owner.storageId');
    const field = AUTHORITY_GATE_LUA.indexOf("redis.call('HGET', KEYS[3]");
    const lock = AUTHORITY_GATE_LUA.indexOf("redis.call('GET', KEYS[4])");
    expect(lineage).toBeGreaterThan(-1);
    expect(lineage).toBeLessThan(journal);
    expect(journal).toBeLessThan(account);
    expect(account).toBeLessThan(owner);
    expect(owner).toBeLessThan(reverse);
    expect(reverse).toBeLessThan(storage);
    expect(storage).toBeLessThan(storageReverse);
    expect(storageReverse).toBeLessThan(field);
    expect(field).toBeLessThan(lock);
    expect(AUTHORITY_GATE_LUA).not.toMatch(/redis\.call\('(SET|HSET|DEL|HDEL|SADD|SREM|ZADD|ZREM)'/);
  });
});

describe('authority.journalFirst', () => {
  it('returns adel when the caller journal exists even if the account JSON is gone', async () => {
    const redis = new MemoryPlatformRedis();
    redis.strings.set('schema-lineage', buildSchemaLineageValue(NOW));
    const journal = new Map<string, string>();
    journal.set(RESEARCHER, 'oi:adel-journal:{"version":2}');
    redis.hashes.set('account-delete-journal', journal);

    const result = await check(redis, 'read');
    expect(result).toEqual({ status: 'adel' });
    expect(redis.writes).toEqual([]);
    expect(redis.strings.has(`researcher:${RESEARCHER}`)).toBe(false);
  });

  it('returns adel after owner decode when the owner journal is present', async () => {
    const redis = new MemoryPlatformRedis();
    seedBoundOwner(redis, { journalCaller: RESEARCHER });
    const result = await check(redis, 'read', '');
    expect(result).toEqual({ status: 'adel' });
    expect(redis.writes).toEqual([]);
  });
});

describe('getStudyAuthorityChecked pair, live-op, and transport', () => {
  it('allows a bound owner with no live op', async () => {
    const redis = new MemoryPlatformRedis();
    seedBoundOwner(redis);
    const result = await check(redis, 'read');
    expect(result).toEqual({ status: 'allow', owner: ownerRecord() });
    expect(redis.writes).toEqual([]);
  });

  it('returns noacct when the caller account is missing and the journal is absent', async () => {
    const redis = new MemoryPlatformRedis();
    redis.strings.set('schema-lineage', buildSchemaLineageValue(NOW));
    expect(await check(redis, 'mutate-config')).toEqual({ status: 'noacct' });
    expect(redis.writes).toEqual([]);
  });

  it('returns deny for a different researcher and mismatch/corrupt for poisoned pairs', async () => {
    const redis = new MemoryPlatformRedis();
    seedBoundOwner(redis);
    expect(await check(redis, 'read', OTHER)).toEqual({ status: 'deny' });

    redis.strings.set(
      `researcher-storage:${RESEARCHER}`,
      encodeStorageBinding({
        version: 2,
        researcherId: RESEARCHER,
        storageId: OTHER_STORAGE,
        originHash: OTHER_STORAGE,
        credentialRevision: 1,
        bindingEpoch: 7,
        cipherSnapshot: 'cipher',
      }),
    );
    expect(await check(redis, 'read')).toEqual({ status: 'mismatch' });

    seedBoundOwner(redis);
    redis.sets.delete(`researcher-studies:${RESEARCHER}`);
    expect(await check(redis, 'link')).toEqual({ status: 'corrupt' });

    seedBoundOwner(redis);
    redis.sets.delete(`storage-researchers:${STORAGE_ID}`);
    expect(await check(redis, 'preview')).toEqual({ status: 'corrupt' });

    seedBoundOwner(redis);
    redis.strings.set(`study-owner:${STUDY_ID}`, '{"researcherId":"researcher-a"}');
    expect(await check(redis, 'read')).toEqual({ status: 'unavailable' });
    expect(redis.writes).toEqual([]);
  });

  it('applies purpose-specific live-op rules including reserving-before-lock', async () => {
    const redis = new MemoryPlatformRedis();
    seedBoundOwner(redis);
    seedLive(redis, 'create', 'reserving');
    expect(await check(redis, 'read')).toEqual({ status: 'live', phase: 'reserving' });
    expect(await check(redis, 'persist-repair')).toEqual({ status: 'live', phase: 'reserving' });
    expect(await check(redis, 'delete')).toEqual({ status: 'live', phase: 'reserving' });

    const deleting = new MemoryPlatformRedis();
    seedBoundOwner(deleting);
    seedLive(deleting, 'delete', 'pending');
    expect(await check(deleting, 'read')).toEqual({ status: 'live', phase: 'pending' });
    expect(await check(deleting, 'new-persist')).toEqual({ status: 'live', phase: 'pending' });
    expect(await check(deleting, 'persist-repair')).toEqual({ status: 'allow', owner: ownerRecord() });
    expect(await check(deleting, 'delete')).toEqual({ status: 'allow', owner: ownerRecord() });

    const lockOnly = new MemoryPlatformRedis();
    seedBoundOwner(lockOnly);
    lockOnly.strings.set(
      `study-op-lock:${STUDY_ID}`,
      encodeLockValue({ generation: 1, researcherId: RESEARCHER, kind: 'create', opNonce: NONCE }),
    );
    expect(await check(lockOnly, 'mutate-config')).toEqual({ status: 'live', phase: 'reserving' });

    lockOnly.strings.set(`study-op-lock:${STUDY_ID}`, 'not-a-lock');
    expect(await check(lockOnly, 'read')).toEqual({ status: 'unavailable' });
    expect(deleting.writes).toEqual([]);
    expect(lockOnly.writes).toEqual([]);
  });

  it('holds on lineage miss and maps transport faults without writes', async () => {
    const redis = new MemoryPlatformRedis();
    expect(await check(redis, 'read')).toEqual({ status: 'hold' });

    redis.evalError = new RedisCommitAmbiguousError('may-have-committed');
    redis.strings.set('schema-lineage', buildSchemaLineageValue(NOW));
    expect(await check(redis, 'read')).toEqual({ status: 'ambiguous' });

    redis.evalError = new RedisCommitAmbiguousError('zero-write');
    expect(await check(redis, 'read')).toEqual({ status: 'unavailable' });
    expect(redis.writes).toEqual([]);
  });
});
