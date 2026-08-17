// @vitest-environment node
// Real-Redis shared-BYOS isolation (Revision 12 §11 / §20). Runner-owned instance only.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RedisNodeAdapter } from '@/lib/redisNodeAdapter';
import { computeRedisBrand } from '@/lib/redisNodeAdapter';
import { buildSchemaLineageValue } from '@/lib/platformSchema';
import {
  buildPendingStudyOperationV2,
  encodeAccountRecord,
  encodeOperationRecord,
  encodeOwnerRecord,
  encodeStorageBinding,
  getStudyAuthorityChecked,
} from '@/lib/platformDb';
import { startDisposableRedis, type DisposableRedis } from '../helpers/disposableRedis';

process.env.PLATFORM_KEY_PREFIX = '';
process.env.DEPLOYMENT_MODE = 'hosted';
delete process.env.REDIS_URL;
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;
delete process.env.PLATFORM_KV_REST_API_URL;
delete process.env.PLATFORM_KV_REST_API_TOKEN;

const STUDY_A = '11111111-1111-4111-8111-111111111111';
const STUDY_B = '22222222-2222-4222-8222-222222222222';
const RESEARCHER_A = 'researcher-a';
const RESEARCHER_B = 'researcher-b';
const STORAGE_ID = 'a'.repeat(64);
const HASH = 'c'.repeat(64);
const FINGERPRINT = 'd'.repeat(64);
const NONCE = '0123456789abcdef0123456789abcdef';
const NOW = 1_700_000_000_000;

let owned: DisposableRedis;
let redis: RedisNodeAdapter;

async function seedSharedStorage(): Promise<void> {
  await redis.set('schema-lineage', buildSchemaLineageValue(NOW));
  for (const researcherId of [RESEARCHER_A, RESEARCHER_B]) {
    await redis.set(`researcher:${researcherId}`, encodeAccountRecord({ id: researcherId }));
    await redis.set(
      `researcher-storage:${researcherId}`,
      encodeStorageBinding({
        version: 2,
        researcherId,
        storageId: STORAGE_ID,
        originHash: STORAGE_ID,
        credentialRevision: 1,
        bindingEpoch: 1,
        cipherSnapshot: 'cipher',
      })
    );
  }
  await redis.set(`study-owner:${STUDY_A}`, encodeOwnerRecord({
    version: 2,
    researcherId: RESEARCHER_A,
    storageId: STORAGE_ID,
    generation: 1,
  }));
  await redis.set(`study-owner:${STUDY_B}`, encodeOwnerRecord({
    version: 2,
    researcherId: RESEARCHER_B,
    storageId: STORAGE_ID,
    generation: 1,
  }));
  await redis.sadd(`researcher-studies:${RESEARCHER_A}`, STUDY_A);
  await redis.sadd(`researcher-studies:${RESEARCHER_B}`, STUDY_B);
  await redis.sadd(`storage-researchers:${STORAGE_ID}`, RESEARCHER_A, RESEARCHER_B);
}

beforeAll(async () => {
  owned = await startDisposableRedis();
  redis = owned.adapter();
  expect(owned.url.startsWith('redis://127.0.0.1:')).toBe(true);
  expect(owned.url).not.toBe(process.env.REDIS_URL);
  expect(redis.brand).toBe(computeRedisBrand(owned.url, owned.ownershipToken));
  expect(await redis.ping()).toMatch(/PONG/i);
}, 60_000);

afterAll(async () => {
  await owned?.close();
});

beforeEach(async () => {
  await seedSharedStorage();
});

describe('hosted shared-BYOS real Redis', () => {
  it('allows A and denies B on A’s study with zero writes on denial', async () => {
    const beforeOwner = await redis.get(`study-owner:${STUDY_A}`);
    const beforeIndex = await redis.smembers(`researcher-studies:${RESEARCHER_A}`);

    const allowA = await getStudyAuthorityChecked({
      client: redis,
      researcherId: RESEARCHER_A,
      studyId: STUDY_A,
      purpose: 'read',
    });
    const denyB = await getStudyAuthorityChecked({
      client: redis,
      researcherId: RESEARCHER_B,
      studyId: STUDY_A,
      purpose: 'read',
    });
    const allowBOwn = await getStudyAuthorityChecked({
      client: redis,
      researcherId: RESEARCHER_B,
      studyId: STUDY_B,
      purpose: 'mutate-config',
    });

    expect(allowA.status).toBe('allow');
    expect(denyB.status).not.toBe('allow');
    expect(allowBOwn.status).toBe('allow');
    expect(await redis.get(`study-owner:${STUDY_A}`)).toBe(beforeOwner);
    expect(await redis.smembers(`researcher-studies:${RESEARCHER_A}`)).toEqual(beforeIndex);
    expect(await redis.smembers(`researcher-studies:${RESEARCHER_B}`)).toEqual([STUDY_B]);
  });

  it('fails closed on journal, live ops, and poisoned owner/reverse without leaking B’s study', async () => {
    await redis.hset('account-delete-journal', RESEARCHER_A, 'oi:adel-journal:{"version":2}');
    const adel = await getStudyAuthorityChecked({
      client: redis,
      researcherId: RESEARCHER_A,
      studyId: STUDY_A,
      purpose: 'read',
    });
    expect(adel.status).toBe('adel');

    await redis.hdel('account-delete-journal', RESEARCHER_A);
    const liveOp = buildPendingStudyOperationV2({
      kind: 'delete',
      phase: 'reserving',
      researcherId: RESEARCHER_A,
      studyId: STUDY_A,
      generation: 1,
      opNonce: NONCE,
      createdAt: NOW,
      idempotencyHash: null,
      fingerprint: null,
    });
    await redis.hset('study-ops:v2', STUDY_A, encodeOperationRecord(liveOp));
    const live = await getStudyAuthorityChecked({
      client: redis,
      researcherId: RESEARCHER_A,
      studyId: STUDY_A,
      purpose: 'new-persist',
    });
    expect(live.status).toBe('live');

    await redis.hdel('study-ops:v2', STUDY_A);
    await redis.set(`study-owner:${STUDY_A}`, encodeOwnerRecord({
      version: 2,
      researcherId: RESEARCHER_B,
      storageId: STORAGE_ID,
      generation: 1,
    }));
    const poisoned = await getStudyAuthorityChecked({
      client: redis,
      researcherId: RESEARCHER_A,
      studyId: STUDY_A,
      purpose: 'read',
    });
    expect(poisoned.status).not.toBe('allow');

    await redis.srem(`storage-researchers:${STORAGE_ID}`, RESEARCHER_A);
    await redis.set(`study-owner:${STUDY_A}`, encodeOwnerRecord({
      version: 2,
      researcherId: RESEARCHER_A,
      storageId: STORAGE_ID,
      generation: 1,
    }));
    const reverse = await getStudyAuthorityChecked({
      client: redis,
      researcherId: RESEARCHER_A,
      studyId: STUDY_A,
      purpose: 'link',
    });
    expect(reverse.status).not.toBe('allow');

    const stillB = await getStudyAuthorityChecked({
      client: redis,
      researcherId: RESEARCHER_B,
      studyId: STUDY_B,
      purpose: 'preview',
    });
    expect(stillB.status).toBe('allow');
    expect(await redis.sismember(`researcher-studies:${RESEARCHER_B}`, STUDY_A)).toBe(0);
    expect(randomUUID()).toMatch(/^[0-9a-f-]{36}$/i);
  });
});
