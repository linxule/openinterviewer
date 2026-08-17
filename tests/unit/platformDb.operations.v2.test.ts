// @vitest-environment node

process.env.PLATFORM_KEY_PREFIX = '';

import { describe, expect, it } from 'vitest';
import { RedisCommitAmbiguousError } from '@/lib/redisPort';
import { buildSchemaLineageValue } from '@/lib/platformSchema';
import {
  BEGIN_STUDY_OPERATION_SCRIPT,
  beginCreateStudyOperationV2,
  beginDeleteStudyOperationV2,
  buildPendingStudyOperationV2,
  encodeAccountRecord,
  encodeLockValue,
  encodeOperationRecord,
  encodeOwnerRecord,
  encodeStorageBinding,
  hostedBeginKeys,
  parsePendingStudyOperationV2,
  studyOperationV2Id,
} from '@/lib/platformDb';
import { parseBeginResult } from '@/lib/wire/parse';
import { MemoryPlatformRedis } from '../helpers/memoryPlatformRedis';

const STUDY_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_STUDY = '22222222-2222-4222-8222-222222222222';
const RESEARCHER = 'researcher-a';
const OTHER_RESEARCHER = 'researcher-b';
const STORAGE_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_STORAGE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const FINGERPRINT = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
const NONCE = '0123456789abcdef0123456789abcdef';
const NOW = 1_700_000_000_000;

function seedHost(redis: MemoryPlatformRedis, overrides?: { journal?: boolean; lineage?: string | null }) {
  if (overrides?.lineage === undefined) {
    redis.strings.set('schema-lineage', buildSchemaLineageValue(NOW));
  } else if (overrides.lineage !== null) {
    redis.strings.set('schema-lineage', overrides.lineage);
  }
  redis.strings.set(`researcher:${RESEARCHER}`, encodeAccountRecord({ id: RESEARCHER }));
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
  if (overrides?.journal) {
    const journal = redis.hashes.get('account-delete-journal') ?? new Map<string, string>();
    journal.set(RESEARCHER, 'oi:adel-journal:{"version":2}');
    redis.hashes.set('account-delete-journal', journal);
  }
}

function createInput(redis: MemoryPlatformRedis) {
  return {
    client: redis.asPort(),
    researcherId: RESEARCHER,
    studyId: STUDY_ID,
    storageId: STORAGE_ID,
    generation: 1,
    opNonce: NONCE,
    bindingEpoch: 7,
    now: NOW,
    idempotencyHash: HASH,
    fingerprint: FINGERPRINT,
  };
}

describe('platformDb v2 begin script contract', () => {
  it('uses the HASH registry KEYS order and R1–R4 write order', () => {
    expect(BEGIN_STUDY_OPERATION_SCRIPT).toContain("redis.call('GET', KEYS[9])");
    expect(BEGIN_STUDY_OPERATION_SCRIPT).toContain("redis.call('HEXISTS', KEYS[8], ARGV[1])");
    expect(BEGIN_STUDY_OPERATION_SCRIPT).toContain("redis.call('SISMEMBER', KEYS[7], ARGV[1])");
    expect(BEGIN_STUDY_OPERATION_SCRIPT).toContain("redis.call('HLEN', KEYS[1])");
    expect(BEGIN_STUDY_OPERATION_SCRIPT).toContain("redis.call('HGET', KEYS[1], ARGV[2])");
    expect(BEGIN_STUDY_OPERATION_SCRIPT.indexOf("incoming.phase = 'reserving'"))
      .toBeLessThan(BEGIN_STUDY_OPERATION_SCRIPT.indexOf('-- fault cut R1'));
    expect(BEGIN_STUDY_OPERATION_SCRIPT.indexOf('-- fault cut R1'))
      .toBeLessThan(BEGIN_STUDY_OPERATION_SCRIPT.indexOf('-- fault cut R2'));
    expect(BEGIN_STUDY_OPERATION_SCRIPT.indexOf('-- fault cut R2'))
      .toBeLessThan(BEGIN_STUDY_OPERATION_SCRIPT.indexOf('-- fault cut R3'));
    expect(BEGIN_STUDY_OPERATION_SCRIPT.indexOf('-- fault cut R3'))
      .toBeLessThan(BEGIN_STUDY_OPERATION_SCRIPT.indexOf('-- fault cut R4'));
    expect(BEGIN_STUDY_OPERATION_SCRIPT).toContain("return {'oi:begin-started', pending}");
    expect(hostedBeginKeys(RESEARCHER, STUDY_ID, STORAGE_ID)).toEqual([
      'study-ops:v2',
      `study-op-lock:${STUDY_ID}`,
      `study-owner:${STUDY_ID}`,
      `researcher-studies:${RESEARCHER}`,
      `researcher:${RESEARCHER}`,
      `researcher-storage:${RESEARCHER}`,
      `storage-researchers:${STORAGE_ID}`,
      'account-delete-journal',
      'schema-lineage',
    ]);
  });
});

describe('platformDb v2 beginCreate/beginDelete', () => {
  it('reserves lock, owner, reverse set, and pending HASH field', async () => {
    const redis = new MemoryPlatformRedis();
    seedHost(redis);
    const result = await beginCreateStudyOperationV2(createInput(redis));
    expect(result.status).toBe('started');
    if (result.status !== 'started') return;
    expect(result.operation).toMatchObject({
      version: 2,
      id: studyOperationV2Id('create', STUDY_ID, 1),
      phase: 'pending',
      kind: 'create',
      researcherId: RESEARCHER,
      studyId: STUDY_ID,
      generation: 1,
      idempotencyHash: HASH,
      fingerprint: FINGERPRINT,
      frozenReceipt: null,
    });
    expect(redis.writes).toEqual([
      'R1',
      'R2',
      'R3',
      'R4',
    ]);
    expect(redis.strings.get(`study-op-lock:${STUDY_ID}`)).toBe(
      encodeLockValue({ generation: 1, researcherId: RESEARCHER, kind: 'create', opNonce: NONCE }),
    );
    expect(parsePendingStudyOperationV2(redis.hashes.get('study-ops:v2')?.get(STUDY_ID))?.phase).toBe('pending');
    expect(redis.sets.get(`researcher-studies:${RESEARCHER}`)?.has(STUDY_ID)).toBe(true);
  });

  it('replays the same researcher/generation/kind/hash without a second field', async () => {
    const redis = new MemoryPlatformRedis();
    seedHost(redis);
    const first = await beginCreateStudyOperationV2(createInput(redis));
    expect(first.status).toBe('started');
    redis.writes = [];
    const replay = await beginCreateStudyOperationV2(createInput(redis));
    expect(replay.status).toBe('replay');
    if (replay.status !== 'replay') return;
    expect(replay.operation.studyId).toBe(STUDY_ID);
    expect(redis.writes).toEqual([]);
    expect(redis.hashes.get('study-ops:v2')?.size).toBe(1);
  });

  it('refuses a live field from another researcher or generation', async () => {
    const redis = new MemoryPlatformRedis();
    seedHost(redis);
    await beginCreateStudyOperationV2(createInput(redis));
    redis.strings.set(`researcher:${OTHER_RESEARCHER}`, encodeAccountRecord({ id: OTHER_RESEARCHER }));
    redis.strings.set(
      `researcher-storage:${OTHER_RESEARCHER}`,
      encodeStorageBinding({
        version: 2,
        researcherId: OTHER_RESEARCHER,
        storageId: STORAGE_ID,
        originHash: STORAGE_ID,
        credentialRevision: 1,
        bindingEpoch: 7,
        cipherSnapshot: 'cipher',
      }),
    );
    redis.sets.get(`storage-researchers:${STORAGE_ID}`)?.add(OTHER_RESEARCHER);
    const cross = await beginCreateStudyOperationV2({
      ...createInput(redis),
      researcherId: OTHER_RESEARCHER,
    });
    expect(cross.status).toBe('live');
    const nextGen = await beginCreateStudyOperationV2({ ...createInput(redis), generation: 2 });
    expect(nextGen.status).toBe('live');
  });

  it('enforces lineage, journal, account, storage, reverse, and quotas before writes', async () => {
    const hold = new MemoryPlatformRedis();
    seedHost(hold, { lineage: null });
    expect((await beginCreateStudyOperationV2(createInput(hold))).status).toBe('hold');
    expect(hold.writes).toEqual([]);

    const adel = new MemoryPlatformRedis();
    seedHost(adel, { journal: true });
    expect((await beginCreateStudyOperationV2(createInput(adel))).status).toBe('adel');
    expect(adel.writes).toEqual([]);

    const noacct = new MemoryPlatformRedis();
    seedHost(noacct);
    noacct.strings.delete(`researcher:${RESEARCHER}`);
    expect((await beginCreateStudyOperationV2(createInput(noacct))).status).toBe('noacct');

    const bind = new MemoryPlatformRedis();
    seedHost(bind);
    bind.sets.set(`storage-researchers:${STORAGE_ID}`, new Set());
    expect((await beginCreateStudyOperationV2(createInput(bind))).status).toBe('bind');

    const epoch = new MemoryPlatformRedis();
    seedHost(epoch);
    expect((await beginCreateStudyOperationV2({ ...createInput(epoch), bindingEpoch: 99 })).status).toBe('bind');

    const opquota = new MemoryPlatformRedis();
    seedHost(opquota);
    const ops = new Map<string, string>();
    for (let index = 0; index < 100; index += 1) {
      const id = `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
      ops.set(id, encodeOperationRecord(buildPendingStudyOperationV2({
        kind: 'create',
        researcherId: RESEARCHER,
        studyId: id,
        generation: 1,
        opNonce: NONCE,
        createdAt: NOW,
        idempotencyHash: HASH,
        fingerprint: FINGERPRINT,
      })));
    }
    opquota.hashes.set('study-ops:v2', ops);
    expect((await beginCreateStudyOperationV2(createInput(opquota))).status).toBe('opquota');
    expect(opquota.writes).toEqual([]);

    const studyquota = new MemoryPlatformRedis();
    seedHost(studyquota);
    const studies = new Set<string>();
    for (let index = 0; index < 2; index += 1) studies.add(`study-${index}`);
    studyquota.sets.set(`researcher-studies:${RESEARCHER}`, studies);
    expect((await beginCreateStudyOperationV2({ ...createInput(studyquota), maxStudies: 2 })).status).toBe('studyquota');
  });

  it('starts delete only with a matching owner and does not delete that owner', async () => {
    const redis = new MemoryPlatformRedis();
    seedHost(redis);
    redis.strings.set(
      `study-owner:${STUDY_ID}`,
      encodeOwnerRecord({ version: 2, researcherId: RESEARCHER, storageId: STORAGE_ID, generation: 1 }),
    );
    const missing = await beginDeleteStudyOperationV2({
      ...createInput(redis),
      studyId: OTHER_STUDY,
      idempotencyHash: null,
      fingerprint: null,
    });
    expect(missing.status).toBe('notfound');

    redis.strings.set(
      `study-owner:${STUDY_ID}`,
      encodeOwnerRecord({ version: 2, researcherId: RESEARCHER, storageId: OTHER_STORAGE, generation: 1 }),
    );
    const ownerConflict = await beginDeleteStudyOperationV2({
      ...createInput(redis),
      idempotencyHash: null,
      fingerprint: null,
    });
    expect(ownerConflict.status).toBe('owner');
    redis.strings.set(
      `study-owner:${STUDY_ID}`,
      encodeOwnerRecord({ version: 2, researcherId: RESEARCHER, storageId: STORAGE_ID, generation: 1 }),
    );

    const started = await beginDeleteStudyOperationV2({
      ...createInput(redis),
      idempotencyHash: null,
      fingerprint: null,
    });
    expect(started.status).toBe('started');
    if (started.status !== 'started') return;
    expect(started.operation.kind).toBe('delete');
    expect(started.operation.idempotencyHash).toBeNull();
    expect(redis.strings.get(`study-owner:${STUDY_ID}`)).toBe(
      encodeOwnerRecord({ version: 2, researcherId: RESEARCHER, storageId: STORAGE_ID, generation: 1 }),
    );
    expect(redis.writes.includes('R2')).toBe(false);
    expect(redis.writes.includes('R3')).toBe(false);
    expect(redis.writes.includes('R1')).toBe(true);
    expect(redis.writes.includes('R4')).toBe(true);
  });

  it('decodes only closed begin tags and maps ambiguous transport to ambiguous', async () => {
    expect(parseBeginResult(['oi:begin-started', encodeOperationRecord(buildPendingStudyOperationV2({
      kind: 'create',
      phase: 'pending',
      researcherId: RESEARCHER,
      studyId: STUDY_ID,
      generation: 1,
      opNonce: NONCE,
      createdAt: NOW,
      idempotencyHash: HASH,
      fingerprint: FINGERPRINT,
    }))]).status).toBe('ok');
    expect(parseBeginResult(['oi:created']).status).toBe('unavailable');
    expect(parseBeginResult(['oi:begin-started']).status).toBe('unavailable');
    expect(parseBeginResult(['oi:begin-replay', { version: 2 }]).status).toBe('unavailable');
    expect(parseBeginResult(1).status).toBe('unavailable');

    const redis = new MemoryPlatformRedis();
    seedHost(redis);
    redis.evalError = new RedisCommitAmbiguousError('may-have-committed');
    expect((await beginCreateStudyOperationV2(createInput(redis))).status).toBe('ambiguous');
    redis.evalError = new RedisCommitAmbiguousError('zero-write');
    expect((await beginCreateStudyOperationV2(createInput(redis))).status).toBe('unavailable');

    redis.evalError = undefined;
    redis.forcedEval = ['oi:begin-started', 'not-prefixed'];
    expect((await beginCreateStudyOperationV2(createInput(redis))).status).toBe('unavailable');
    redis.forcedEval = ['oi:begin-hold'];
    expect((await beginCreateStudyOperationV2(createInput(redis))).status).toBe('hold');
  });

  it('rejects invalid local identity without touching Redis', async () => {
    const redis = new MemoryPlatformRedis();
    const result = await beginCreateStudyOperationV2({
      ...createInput(redis),
      studyId: 'not-a-uuid',
    });
    expect(result.status).toBe('invalid');
    expect(redis.evalCalls).toBe(0);
  });
});
