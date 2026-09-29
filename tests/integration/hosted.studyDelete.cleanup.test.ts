// Hosted deletion's platform half. Real Lua against a runner-owned Redis;
// no inherited URL, provider request, or production credential is used.
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  beginDeleteStudyOperationV2,
  encodeAccountRecord,
  encodeOwnerRecord,
  encodeStorageBinding,
  hostedAuthorityArgvPrefixes,
  hostedAuthorityKeys,
  parsePendingStudyOperationV2,
  publishStudyOperationV2,
  resolveStudyOperationV2,
  type PendingStudyOperationV2,
} from '@/lib/platformDb';
import { MAX_HOSTED_DELETE_LINKS } from '@/lib/platformDb.operations';
import {
  beginCreateIdempotency,
  casCreateIdempotencyState,
  createFingerprint,
  createIdempotencyKeys,
  encodeCreateIdempotencyRecord,
  hashCreateIdempotencyKey,
  mintCreateStudy,
  parseCreateIdempotencyRecord,
} from '@/lib/createIdempotency';
import { HOSTED_CREATE_LINK_SCRIPT, type ParticipantLinkRecord } from '@/lib/participantLinks';
import { buildSchemaLineageValue, platformKey } from '@/lib/platformSchema';
import type { RedisNodeAdapter } from '@/lib/redisNodeAdapter';
import { makeStudyConfig } from '../fixtures/models';
import { startDisposableRedis, type DisposableRedis } from '../helpers/disposableRedis';

const STORAGE_ID = 'a'.repeat(64);
const NOW = 1_700_000_000_000;
let owned: DisposableRedis;
let redis: RedisNodeAdapter;

beforeAll(async () => {
  process.env.PLATFORM_KEY_PREFIX = `hosted-cleanup-${randomBytes(6).toString('hex')}`;
  owned = await startDisposableRedis();
  redis = owned.adapter();
}, 30_000);
afterAll(async () => { await owned?.close(); });

async function seed(researcherId: string, studyIds: string[]) {
  await redis.set(platformKey('schema-lineage'), buildSchemaLineageValue(NOW));
  await redis.set(platformKey(`researcher:${researcherId}`), encodeAccountRecord({ id: researcherId }));
  await redis.set(platformKey(`researcher-storage:${researcherId}`), encodeStorageBinding({
    version: 2, researcherId, storageId: STORAGE_ID, originHash: STORAGE_ID,
    credentialRevision: 1, bindingEpoch: 7, cipherSnapshot: 'synthetic-cipher',
  }));
  await redis.sadd(platformKey(`storage-researchers:${STORAGE_ID}`), researcherId);
  for (const studyId of studyIds) {
    await redis.set(platformKey(`study-owner:${studyId}`), encodeOwnerRecord({
      version: 2, researcherId, storageId: STORAGE_ID, generation: 1,
    }));
    await redis.sadd(platformKey(`researcher-studies:${researcherId}`), studyId);
  }
}

async function begin(researcherId: string, studyId: string, intent: { deleteInterviews?: boolean; expectedRevision?: number } = {}): Promise<PendingStudyOperationV2> {
  const result = await beginDeleteStudyOperationV2({
    client: redis, researcherId, studyId, storageId: STORAGE_ID,
    generation: 1, opNonce: randomBytes(16).toString('hex'), bindingEpoch: 7,
    idempotencyHash: null, fingerprint: null, now: NOW, ...intent,
  });
  expect(result.status).toBe('started');
  if (result.status !== 'started') throw new Error('Expected pending hosted deletion');
  return result.operation;
}

function resolve(operation: PendingStudyOperationV2, resolution: 'delete-complete' | 'delete-rollback', now = NOW + 1) {
  return resolveStudyOperationV2({
    client: redis, researcherId: operation.researcherId, studyId: operation.studyId,
    storageId: STORAGE_ID, generation: operation.generation, kind: 'delete',
    opNonce: operation.opNonce, resolution, now, createdAt: operation.createdAt,
  });
}

function link(researcherId: string, studyId: string, overrides: Partial<ParticipantLinkRecord> = {}): ParticipantLinkRecord {
  return {
    version: 1, id: randomBytes(32).toString('hex'), researcherId, studyId,
    studyRevision: 1, createdAt: NOW, revokedAt: null, expiresAt: null, ...overrides,
  };
}

function encodeLink(record: ParticipantLinkRecord) { return `oi:link:${JSON.stringify(record)}`; }
function linkKey(id: string) { return platformKey(`participant-link:${id}`); }
function linkIndex(researcherId: string) { return platformKey(`participant-links:${researcherId}`); }

async function seedLink(record: ParticipantLinkRecord, indexedResearcherId = record.researcherId!) {
  await redis.set(linkKey(record.id), encodeLink(record));
  await redis.sadd(linkIndex(indexedResearcherId), record.id);
}

async function seedMapping(researcherId: string, studyId: string, idempotencyKey = randomUUID()) {
  const study = mintCreateStudy(makeStudyConfig({ name: 'Private synthetic protocol', description: 'Retained only until deletion' }), NOW, studyId);
  const fingerprint = createFingerprint(study.config);
  const keys = createIdempotencyKeys('hosted', researcherId, hashCreateIdempotencyKey(researcherId, idempotencyKey));
  await redis.set(keys.mapping, encodeCreateIdempotencyRecord({
    version: 2, researcherId, studyId, createdAt: NOW, updatedAt: NOW,
    state: 'created', fingerprint, operationId: `create:${studyId}:1`, study,
  }), { ex: 120 });
  await redis.zadd(keys.index, NOW, hashCreateIdempotencyKey(researcherId, idempotencyKey));
  return { keys, study, fingerprint, idempotencyKey };
}

async function createLink(record: ParticipantLinkRecord) {
  return redis.eval(HOSTED_CREATE_LINK_SCRIPT, [
    ...hostedAuthorityKeys(record.studyId), linkKey(record.id), linkIndex(record.researcherId!),
  ], [
    record.researcherId!, record.studyId, 'link', ...hostedAuthorityArgvPrefixes(),
    encodeLink(record), record.id, `${platformKey('participant-link')}:`,
    String(MAX_HOSTED_DELETE_LINKS), '',
  ]);
}

describe('hosted study-delete control-plane cleanup', () => {
  it('persists explicit confirmation before BYOS access and replays only the same frozen deletion intent', async () => {
    const researcherId = `intent-${randomBytes(8).toString('hex')}`;
    const studyId = randomUUID();
    await seed(researcherId, [studyId]);
    const operation = await begin(researcherId, studyId, { deleteInterviews: true, expectedRevision: 7 });
    expect(operation).toMatchObject({ deleteInterviews: true, expectedRevision: 7 });
    const raw = await redis.hget(platformKey('study-ops:v2'), studyId);
    expect(parsePendingStudyOperationV2(raw)).toMatchObject({ deleteInterviews: true, expectedRevision: 7 });
    const replayInput = {
      client: redis, researcherId, studyId, storageId: STORAGE_ID,
      generation: 1, opNonce: randomBytes(16).toString('hex'), bindingEpoch: 7,
      idempotencyHash: null, fingerprint: null, now: NOW + 1,
    };
    expect((await beginDeleteStudyOperationV2({ ...replayInput, deleteInterviews: true, expectedRevision: 7 })).status)
      .toBe('replay');
    expect((await beginDeleteStudyOperationV2(replayInput)).status).toBe('live');
    expect((await beginDeleteStudyOperationV2({ ...replayInput, deleteInterviews: true, expectedRevision: 8 })).status)
      .toBe('live');
    expect(await redis.hget(platformKey('study-ops:v2'), studyId)).toBe(raw);
  });

  it('releases link capacity, redacts deleted create receipts, and preserves other studies and tenants through replay', async () => {
    const researcherId = `cleanup-${randomBytes(8).toString('hex')}`;
    const otherResearcher = `other-${randomBytes(8).toString('hex')}`;
    const studyId = randomUUID();
    const siblingStudy = randomUUID();
    const foreignStudy = randomUUID();
    await seed(researcherId, [studyId, siblingStudy]);
    await seed(otherResearcher, [foreignStudy]);
    const sibling = link(researcherId, siblingStudy);
    const foreign = link(otherResearcher, foreignStudy);
    await seedLink(sibling);
    await seedLink(foreign);
    // A stray foreign index member must not authorize deleting that record.
    await redis.sadd(linkIndex(researcherId), foreign.id);
    // Include legacy link encoding, a revoked link and a stale expired index
    // member. The full index refuses new credentials before this deletion.
    const targetLinks = Array.from({ length: MAX_HOSTED_DELETE_LINKS - 3 }, (_, index) =>
      link(researcherId, studyId, { revokedAt: index === 0 ? NOW : null }));
    await Promise.all(targetLinks.map((record, index) => redis.set(linkKey(record.id), index === 1 ? JSON.stringify(record) : encodeLink(record))));
    const staleId = randomBytes(32).toString('hex');
    await redis.sadd(linkIndex(researcherId), ...targetLinks.map((record) => record.id), staleId);
    // Replace the expired member with a live target to show a real quota hit.
    const replacement = link(researcherId, studyId, { id: staleId });
    await redis.set(linkKey(staleId), encodeLink(replacement));
    const nextLink = link(researcherId, siblingStudy);
    expect(await createLink(nextLink)).toEqual(['oi:link-quota']);
    await redis.del(linkKey(staleId));

    const targetMapping = await seedMapping(researcherId, studyId);
    const siblingMapping = await seedMapping(researcherId, siblingStudy);
    const foreignMapping = await seedMapping(otherResearcher, foreignStudy);
    const siblingRaw = await redis.get(siblingMapping.keys.mapping);
    const foreignRaw = await redis.get(foreignMapping.keys.mapping);
    const originalTtl = Number(await redis.eval('return redis.call("PTTL", KEYS[1])', [targetMapping.keys.mapping], []));
    const operation = await begin(researcherId, studyId);
    const first = await resolve(operation, 'delete-complete');
    expect(first.status).toBe('publishing');
    for (const record of targetLinks) expect(await redis.get(linkKey(record.id))).toBeNull();
    expect((await redis.smembers(linkIndex(researcherId)) as string[]).sort()).toEqual([sibling.id, foreign.id].sort());
    expect(await redis.get(linkKey(sibling.id))).toBe(encodeLink(sibling));
    expect(await redis.get(linkKey(foreign.id))).toBe(encodeLink(foreign));
    expect(await redis.get(siblingMapping.keys.mapping)).toBe(siblingRaw);
    expect(await redis.get(foreignMapping.keys.mapping)).toBe(foreignRaw);
    expect(await createLink(nextLink)).toEqual(['oi:link-created']);
    const targetRaw = await redis.get<string>(targetMapping.keys.mapping);
    expect(targetRaw).not.toContain('Private synthetic protocol');
    expect(targetRaw).not.toContain('Retained only until deletion');
    expect(parseCreateIdempotencyRecord(targetRaw)).toMatchObject({
      studyId, researcherId, state: 'deleted', study: null, fingerprint: targetMapping.fingerprint,
    });
    const ttl = Number(await redis.eval('return redis.call("PTTL", KEYS[1])', [targetMapping.keys.mapping], []));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(originalTtl);
    const replay = await beginCreateIdempotency({
      client: redis, mode: 'hosted', researcherId,
      idempotencyKey: targetMapping.idempotencyKey, fingerprint: targetMapping.fingerprint,
      mintStudy: () => { throw new Error('Consumed create key must not mint a study'); },
    });
    expect(replay).toMatchObject({ status: 'replay', record: { state: 'deleted', study: null } });
    expect((await resolve(operation, 'delete-complete', NOW + 2)).status).toBe('publishing');
    expect(await redis.get(targetMapping.keys.mapping)).toBe(targetRaw);
    const published = await publishStudyOperationV2({
      client: redis, researcherId, studyId, generation: operation.generation,
      kind: 'delete', opNonce: operation.opNonce, resolution: 'delete-complete',
      now: NOW + 3, createdAt: operation.createdAt,
    });
    expect(published.status).toBe('published');
    expect(await redis.hget(platformKey('study-ops:v2'), studyId)).toBeNull();
    const receiptRaw = await redis.get<string>(platformKey(`study-op-receipt:${studyId}:${operation.generation}`));
    expect(receiptRaw).toContain('delete-complete');
    expect(receiptRaw).not.toContain('Private synthetic protocol');
  });

  it('leaves links and configuration untouched when deletion rolls back', async () => {
    const researcherId = `rollback-${randomBytes(8).toString('hex')}`;
    const studyId = randomUUID();
    await seed(researcherId, [studyId]);
    const record = link(researcherId, studyId);
    await seedLink(record);
    const mapping = await seedMapping(researcherId, studyId);
    const raw = await redis.get(mapping.keys.mapping);
    const operation = await begin(researcherId, studyId);
    expect((await resolve(operation, 'delete-rollback')).status).toBe('publishing');
    expect(await redis.get(linkKey(record.id))).toBe(encodeLink(record));
    expect(await redis.smembers(linkIndex(researcherId))).toEqual([record.id]);
    expect(await redis.get(mapping.keys.mapping)).toBe(raw);
    expect(await redis.sismember(platformKey(`researcher-studies:${researcherId}`), studyId)).toBe(1);
  });

  it('refuses corrupt or over-cap cleanup before any mutation and resumes safely after the fault is repaired', async () => {
    const researcherId = `retry-${randomBytes(8).toString('hex')}`;
    const studyId = randomUUID();
    await seed(researcherId, [studyId]);
    const record = link(researcherId, studyId);
    await seedLink(record);
    const malformed = link(researcherId, studyId);
    await redis.set(linkKey(malformed.id), 'oi:link:{bad json');
    await redis.sadd(linkIndex(researcherId), malformed.id);
    const mapping = await seedMapping(researcherId, studyId);
    const mappingRaw = await redis.get(mapping.keys.mapping);
    const operation = await begin(researcherId, studyId);
    const pendingRaw = await redis.hget(platformKey('study-ops:v2'), studyId);
    expect((await resolve(operation, 'delete-complete')).status).toBe('unavailable');
    expect(await redis.hget(platformKey('study-ops:v2'), studyId)).toBe(pendingRaw);
    expect(await redis.get(linkKey(record.id))).toBe(encodeLink(record));
    expect(await redis.get(mapping.keys.mapping)).toBe(mappingRaw);
    expect(await redis.get(platformKey(`study-owner:${studyId}`))).not.toBeNull();
    await redis.del(linkKey(malformed.id));
    const overflow = Array.from({ length: MAX_HOSTED_DELETE_LINKS }, () => randomBytes(32).toString('hex'));
    await redis.sadd(linkIndex(researcherId), ...overflow);
    expect((await resolve(operation, 'delete-complete')).status).toBe('unavailable');
    expect(await redis.hget(platformKey('study-ops:v2'), studyId)).toBe(pendingRaw);
    await redis.srem(linkIndex(researcherId), ...overflow);
    expect((await resolve(operation, 'delete-complete')).status).toBe('publishing');
    expect(await redis.get(linkKey(record.id))).toBeNull();
    expect(parsePendingStudyOperationV2(await redis.hget(platformKey('study-ops:v2'), studyId))?.phase).toBe('publishing');
    expect(parseCreateIdempotencyRecord(await redis.get(mapping.keys.mapping))?.study).toBeNull();
  });

  it('redacts CAS deletion receipts and keeps deleted-key retries consumed', async () => {
    const researcherId = `cas-${randomBytes(8).toString('hex')}`;
    const studyId = randomUUID();
    const mapping = await seedMapping(researcherId, studyId);
    const changed = await casCreateIdempotencyState({
      client: redis, mode: 'hosted', researcherId, idempotencyKey: mapping.idempotencyKey,
      fingerprint: mapping.fingerprint, nextState: 'deleted', now: NOW + 1,
    });
    expect(changed).toMatchObject({ status: 'ok', record: { state: 'deleted', study: null } });
    expect(await redis.get<string>(mapping.keys.mapping)).not.toContain('Private synthetic protocol');
    const again = await casCreateIdempotencyState({
      client: redis, mode: 'hosted', researcherId, idempotencyKey: mapping.idempotencyKey,
      fingerprint: mapping.fingerprint, nextState: 'created', now: NOW + 2,
    });
    expect(again.status).toBe('unavailable');
    expect(parseCreateIdempotencyRecord(await redis.get(mapping.keys.mapping))).toMatchObject({ state: 'deleted', study: null });
  });
});
