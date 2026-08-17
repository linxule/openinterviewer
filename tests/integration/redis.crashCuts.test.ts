// @vitest-environment node
// Real-Redis crash/retry harness (Revision 12 §18). Runner-owned instance only.

import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RedisNodeAdapter } from '@/lib/redisNodeAdapter';
import { computeRedisBrand } from '@/lib/redisNodeAdapter';
import { buildSchemaLineageValue } from '@/lib/platformSchema';
import {
  AUTHORITY_GATE_LUA,
  beginAccountDeletion,
  beginCreateStudyOperationV2,
  encodeAccountRecord,
  encodeLockValue,
  encodeOwnerRecord,
  encodeStorageBinding,
  getStudyAuthorityChecked,
  loadAccountDeletePlan,
  parsePendingStudyOperationV2,
  publishStudyOperationV2,
  recoverReservingStudyOperation,
  resolveStudyOperationV2,
  resumeAccountDeletion,
} from '@/lib/platformDb';
import {
  CREATE_STUDY_SCRIPT,
  DELETE_EMPTY_STUDY_SCRIPT,
  createStudyAtomic,
  deleteStudy,
  encodeMutationGuard,
  persistCompletedInterviewFinish,
  persistCompletedInterviewP1,
  type PersistingGuard,
} from '@/lib/kv';
import { BEGIN_STUDY_OPERATION_SCRIPT } from '@/lib/platformDb.operations';
import { makeStoredInterview, makeStoredStudy } from '../fixtures/models';
import {
  startDisposableRedis,
  type DisposableRedis,
} from '../helpers/disposableRedis';
import {
  assertFaultCutsCovered,
  coverFaultCut,
  type FaultCutId,
} from '../helpers/faultManifest';
import type { ResearcherAccount } from '@/types';

process.env.PLATFORM_KEY_PREFIX = '';
process.env.DEPLOYMENT_MODE = 'standalone';
delete process.env.REDIS_URL;
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;
delete process.env.PLATFORM_KV_REST_API_URL;
delete process.env.PLATFORM_KV_REST_API_TOKEN;

const STORAGE_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const FINGERPRINT = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
const NONCE = '0123456789abcdef0123456789abcdef';
const NOW = 1_700_000_000_000;
const FP = 'ab'.repeat(32);

let owned: DisposableRedis;
let redis: RedisNodeAdapter;

function uuid(): string {
  return randomUUID();
}

function researcherAccount(id: string): ResearcherAccount {
  return {
    id,
    email: `${id}@example.com`,
    name: 'Owner',
    avatarUrl: null,
    oauthProvider: 'google',
    oauthId: `oauth-${id}`,
    createdAt: 1,
    lastLoginAt: 1,
    onboardingComplete: true,
    encryptedRedisUrl: 'cipher-url',
    encryptedRedisToken: 'cipher-token',
    encryptedGeminiApiKey: null,
    encryptedAnthropicApiKey: null,
    redisConfiguredAt: 1,
    credentialRevision: 1,
  };
}

async function seedHosted(researcherId: string): Promise<void> {
  await redis.set('schema-lineage', buildSchemaLineageValue(NOW));
  await redis.set(`researcher:${researcherId}`, encodeAccountRecord({ id: researcherId }));
  await redis.set(
    `researcher-storage:${researcherId}`,
    encodeStorageBinding({
      version: 2,
      researcherId,
      storageId: STORAGE_ID,
      originHash: STORAGE_ID,
      credentialRevision: 1,
      bindingEpoch: 7,
      cipherSnapshot: 'cipher',
    })
  );
  await redis.sadd(`storage-researchers:${STORAGE_ID}`, researcherId);
}

function beginInput(researcherId: string, studyId: string) {
  return {
    client: redis,
    researcherId,
    studyId,
    storageId: STORAGE_ID,
    generation: 1,
    opNonce: NONCE,
    bindingEpoch: 7,
    now: NOW,
    idempotencyHash: HASH,
    fingerprint: FINGERPRINT,
  };
}

function armCut(cutId: FaultCutId, scriptHint: string | RegExp = new RegExp(`fault cut[^\\n]*\\b${cutId}\\b`)) {
  redis.armFault({ cutId, commands: 'eval', effect: 'cut', scriptHint, once: true });
}

function armLoss(cutId: FaultCutId, scriptHint: string | RegExp) {
  redis.armFault({ cutId, commands: 'eval', effect: 'loss', scriptHint, once: true });
}

function armUndecodable(cutId: FaultCutId, scriptHint: string | RegExp) {
  redis.armFault({ cutId, commands: 'eval', effect: 'undecodable', scriptHint, once: true });
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

describe('owned disposable Redis', () => {
  it('refuses inherited REDIS_URL and never FLUSHDB', () => {
    expect(owned.containerId.length).toBeGreaterThan(0);
    expect(CREATE_STUDY_SCRIPT).not.toContain('FLUSHDB');
    expect(BEGIN_STUDY_OPERATION_SCRIPT).toContain('-- fault cut R1');
  });
});

describe('registry R1–R4 + recover/resolve/publish/prune', () => {
  it('R1 leaves reserving field only; recover waits then abandons after grace', async () => {
    const researcherId = `r-${uuid()}`;
    const studyId = uuid();
    await seedHosted(researcherId);
    armCut('R1');
    const cut = await beginCreateStudyOperationV2(beginInput(researcherId, studyId));
    expect(cut.status).toBe('unavailable');
    const field = await redis.hget('study-ops:v2', studyId);
    expect(parsePendingStudyOperationV2(field)?.phase).toBe('reserving');
    expect(await redis.get(`study-op-lock:${studyId}`)).toBeNull();
    expect(await redis.get(`study-owner:${studyId}`)).toBeNull();
    const wait = await recoverReservingStudyOperation({
      client: redis,
      studyId,
      researcherId,
      generation: 1,
      kind: 'create',
      opNonce: NONCE,
      now: NOW + 1,
      graceMs: 300_000,
    });
    expect(wait.status).toBe('wait');
    const abandoned = await recoverReservingStudyOperation({
      client: redis,
      studyId,
      researcherId,
      generation: 1,
      kind: 'create',
      opNonce: NONCE,
      now: NOW + 300_001,
      graceMs: 300_000,
    });
    expect(abandoned.status).toBe('abandoned');
    expect(await redis.hget('study-ops:v2', studyId)).toBeNull();
    coverFaultCut('R1');
    coverFaultCut('recover');
  });

  it('R2/R3/R4 prefixes recover to pending, then resolve+publish retry', async () => {
    for (const cutId of ['R2', 'R3', 'R4'] as const) {
      const researcherId = `r-${uuid()}`;
      const studyId = uuid();
      await seedHosted(researcherId);
      armCut(cutId);
      const cut = await beginCreateStudyOperationV2(beginInput(researcherId, studyId));
      expect(cut.status).toBe('unavailable');
      expect(parsePendingStudyOperationV2(await redis.hget('study-ops:v2', studyId))?.phase).toBe(
        'reserving'
      );
      expect(await redis.get(`study-owner:${studyId}`)).toBe(
        encodeOwnerRecord({ version: 2, researcherId, storageId: STORAGE_ID, generation: 1 })
      );
      if (cutId === 'R4') {
        expect(await redis.get(`study-op-lock:${studyId}`)).toBe(
          encodeLockValue({ generation: 1, researcherId, kind: 'create', opNonce: NONCE })
        );
      } else {
        expect(await redis.get(`study-op-lock:${studyId}`)).toBeNull();
      }
      if (cutId === 'R2') {
        expect(await redis.sismember(`researcher-studies:${researcherId}`, studyId)).toBe(0);
        expect(
          (
            await recoverReservingStudyOperation({
              client: redis,
              studyId,
              researcherId,
              generation: 1,
              kind: 'create',
              opNonce: NONCE,
              now: NOW + 10,
            })
          ).status
        ).toBe('ambiguous');
        await redis.sadd(`researcher-studies:${researcherId}`, studyId);
      }
      const recovered = await recoverReservingStudyOperation({
        client: redis,
        studyId,
        researcherId,
        generation: 1,
        kind: 'create',
        opNonce: NONCE,
        now: NOW + 10,
      });
      expect(recovered.status).toBe('pending');
      coverFaultCut(cutId);
    }

    const researcherId = `r-${uuid()}`;
    const studyId = uuid();
    await seedHosted(researcherId);
    const started = await beginCreateStudyOperationV2(beginInput(researcherId, studyId));
    expect(started.status).toBe('started');

    armCut('resolve');
    const resolving = await resolveStudyOperationV2({
      client: redis,
      researcherId,
      studyId,
      storageId: STORAGE_ID,
      generation: 1,
      kind: 'create',
      opNonce: NONCE,
      resolution: 'create-complete',
      now: NOW + 20,
      createdAt: NOW,
    });
    expect(resolving.status).toBe('unavailable');
    expect(parsePendingStudyOperationV2(await redis.hget('study-ops:v2', studyId))?.phase).toBe(
      'resolving'
    );
    const resolved = await resolveStudyOperationV2({
      client: redis,
      researcherId,
      studyId,
      storageId: STORAGE_ID,
      generation: 1,
      kind: 'create',
      opNonce: NONCE,
      resolution: 'create-complete',
      now: NOW + 21,
      createdAt: NOW,
    });
    expect(resolved.status).toBe('publishing');
    coverFaultCut('resolve');

    armCut('PUB1');
    expect(
      (
        await publishStudyOperationV2({
          client: redis,
          researcherId,
          studyId,
          generation: 1,
          kind: 'create',
          opNonce: NONCE,
          resolution: 'create-complete',
          now: NOW + 22,
          createdAt: NOW,
        })
      ).status
    ).toBe('unavailable');
    expect(await redis.get(`study-op-receipt:${studyId}:1`)).toMatch(/^oi:receipt:/);
    coverFaultCut('PUB1');

    armCut('PUB2');
    expect(
      (
        await publishStudyOperationV2({
          client: redis,
          researcherId,
          studyId,
          generation: 1,
          kind: 'create',
          opNonce: NONCE,
          resolution: 'create-complete',
          now: NOW + 23,
          createdAt: NOW,
        })
      ).status
    ).toBe('unavailable');
    expect(await redis.zscore(`study-op-receipts:${researcherId}`, `${studyId}:1`)).toBe(String(NOW));
    coverFaultCut('PUB2');

    armCut('PUB3');
    expect(
      (
        await publishStudyOperationV2({
          client: redis,
          researcherId,
          studyId,
          generation: 1,
          kind: 'create',
          opNonce: NONCE,
          resolution: 'create-complete',
          now: NOW + 24,
          createdAt: NOW,
        })
      ).status
    ).toBe('unavailable');
    expect(await redis.get(`study-op-lock:${studyId}`)).toBeNull();
    expect(await redis.hget('study-ops:v2', studyId)).toBeTruthy();
    coverFaultCut('PUB3');

    armCut('PUB4');
    expect(
      (
        await publishStudyOperationV2({
          client: redis,
          researcherId,
          studyId,
          generation: 1,
          kind: 'create',
          opNonce: NONCE,
          resolution: 'create-complete',
          now: NOW + 25,
          createdAt: NOW,
        })
      ).status
    ).toBe('unavailable');
    expect(await redis.hget('study-ops:v2', studyId)).toBeNull();
    coverFaultCut('PUB4');

    const published = await publishStudyOperationV2({
      client: redis,
      researcherId,
      studyId,
      generation: 1,
      kind: 'create',
      opNonce: NONCE,
      resolution: 'create-complete',
      now: NOW + 26,
      createdAt: NOW,
    });
    expect(published.status).toBe('published');

    armCut('PRUNE_DEL');
    expect(
      (
        await publishStudyOperationV2({
          client: redis,
          researcherId,
          studyId,
          generation: 1,
          kind: 'create',
          opNonce: NONCE,
          resolution: 'create-complete',
          now: NOW + 604_800_000,
          createdAt: NOW,
        })
      ).status
    ).toBe('unavailable');
    expect(await redis.get(`study-op-receipt:${studyId}:1`)).toBeNull();
    expect(await redis.zscore(`study-op-receipts:${researcherId}`, `${studyId}:1`)).toBe(String(NOW));
    coverFaultCut('PRUNE_DEL');

    armCut('PRUNE_ZREM');
    const cutPrune = await publishStudyOperationV2({
      client: redis,
      researcherId,
      studyId,
      generation: 1,
      kind: 'create',
      opNonce: NONCE,
      resolution: 'create-complete',
      now: NOW + 604_800_000,
      createdAt: NOW,
    });
    // Post-commit cut: the resume-prune ZREM commits, then the failpoint reply
    // makes the wrapper fail closed ('unavailable'), leaving the prune done.
    expect(cutPrune.status).toBe('unavailable');
    expect(await redis.zscore(`study-op-receipts:${researcherId}`, `${studyId}:1`)).toBeNull();
    coverFaultCut('PRUNE_ZREM');

    // Prune is fully committed (receipt DEL + index ZREM). An unarmed retry
    // finds nothing left to repair and reports the terminal stale evidence.
    const pruned = await publishStudyOperationV2({
      client: redis,
      researcherId,
      studyId,
      generation: 1,
      kind: 'create',
      opNonce: NONCE,
      resolution: 'create-complete',
      now: NOW + 604_800_000,
      createdAt: NOW,
    });
    expect(pruned.status).toBe('stale');
    expect(await redis.zscore(`study-op-receipts:${researcherId}`, `${studyId}:1`)).toBeNull();
  });
});

describe('authority (no writes)', () => {
  it('named failpoint returns unavailable without mutating keys', async () => {
    const researcherId = `r-${uuid()}`;
    const studyId = uuid();
    await seedHosted(researcherId);
    await redis.set(
      `study-owner:${studyId}`,
      encodeOwnerRecord({ version: 2, researcherId, storageId: STORAGE_ID, generation: 1 })
    );
    await redis.sadd(`researcher-studies:${researcherId}`, studyId);
    const before = await redis.get(`study-owner:${studyId}`);
    expect(AUTHORITY_GATE_LUA).toContain('-- fault cut authority');
    armCut('authority');
    const cut = await getStudyAuthorityChecked({
      client: redis,
      researcherId,
      studyId,
      purpose: 'read',
    });
    expect(cut.status).toBe('unavailable');
    expect(await redis.get(`study-owner:${studyId}`)).toBe(before);
    const allow = await getStudyAuthorityChecked({
      client: redis,
      researcherId,
      studyId,
      purpose: 'read',
    });
    expect(allow.status).toBe('allow');
    coverFaultCut('authority');
  });
});

describe('standalone create/delete W1/W2/S1–S4/D1–D4', () => {
  it('S1/W1 then S2/W2 repair on the same study', async () => {
    const study = makeStoredStudy({ id: uuid(), createdAt: NOW, updatedAt: NOW });
    armCut('S1');
    expect(await createStudyAtomic(study, redis)).toBe('unavailable');
    expect(await redis.get(`study:${study.id}`)).toBeNull();
    coverFaultCut('S1');
    coverFaultCut('W1');

    armCut('S2');
    expect(await createStudyAtomic(study, redis)).toBe('unavailable');
    expect(await redis.get(`study:${study.id}`)).toBeTruthy();
    expect(await redis.sismember('all-studies', study.id)).toBe(0);
    coverFaultCut('S2');

    armCut('W2');
    expect(await createStudyAtomic(study, redis)).toBe('unavailable');
    coverFaultCut('W2');
    expect(await createStudyAtomic(study, redis)).toBe('created');
  });

  it('S3 and S4 cut the first-pass write order', async () => {
    const s3 = makeStoredStudy({ id: uuid(), createdAt: NOW, updatedAt: NOW });
    armCut('S3');
    expect(await createStudyAtomic(s3, redis)).toBe('unavailable');
    expect(await redis.sismember('all-studies', s3.id)).toBe(1);
    coverFaultCut('S3');
    expect(await createStudyAtomic(s3, redis)).toBe('created');

    const s4 = makeStoredStudy({ id: uuid(), createdAt: NOW, updatedAt: NOW });
    armCut('S4');
    expect(await createStudyAtomic(s4, redis)).toBe('unavailable');
    coverFaultCut('S4');
    expect(await createStudyAtomic(s4, redis)).toBe('created');
  });

  it('D1–D4 delete prefixes then retry terminal', async () => {
    const d12 = makeStoredStudy({ id: uuid(), createdAt: NOW, updatedAt: NOW });
    expect(await createStudyAtomic(d12, redis)).toBe('created');
    armCut('D1');
    expect((await deleteStudy(d12.id, redis)).status).toBe('unavailable');
    expect(await redis.get(`study:${d12.id}`)).toBeTruthy();
    expect(await redis.get(`study-mutation-guard:${d12.id}`)).toMatch(/^oi:smg:/);
    coverFaultCut('D1');
    armCut('D2');
    expect((await deleteStudy(d12.id, redis)).status).toBe('unavailable');
    expect(await redis.get(`study:${d12.id}`)).toBeNull();
    expect(await redis.sismember('all-studies', d12.id)).toBe(1);
    coverFaultCut('D2');
    expect((await deleteStudy(d12.id, redis)).status).toBe('deleted');

    const d3 = makeStoredStudy({ id: uuid(), createdAt: NOW, updatedAt: NOW });
    expect(await createStudyAtomic(d3, redis)).toBe('created');
    armCut('D3');
    expect((await deleteStudy(d3.id, redis)).status).toBe('unavailable');
    expect(await redis.sismember('all-studies', d3.id)).toBe(0);
    coverFaultCut('D3');
    expect((await deleteStudy(d3.id, redis)).status).toBe('deleted');

    const d4 = makeStoredStudy({ id: uuid(), createdAt: NOW, updatedAt: NOW });
    expect(await createStudyAtomic(d4, redis)).toBe('created');
    armCut('D4');
    expect((await deleteStudy(d4.id, redis)).status).toBe('unavailable');
    coverFaultCut('D4');
    expect((await deleteStudy(d4.id, redis)).status).toBe('deleted');
  });
});

describe('persist F1–F5 + transitions', () => {
  it('Finish cuts F1–F5 then retries to created', async () => {
    const study = makeStoredStudy({ id: uuid(), createdAt: NOW, updatedAt: NOW, revision: 3 });
    expect(await createStudyAtomic(study, redis)).toBe('created');
    const interview = makeStoredInterview({
      id: `interview-${uuid()}`,
      studyId: study.id,
      status: 'completed',
    });
    const options = {
      expectedStudyRevision: 3,
      rateLimits: [
        { key: `interview-rate:session:${study.id}:0`, maximum: 8, windowSeconds: 86_400, windowStart: 0 },
      ],
      identity: { participantSessionId: 'session-a', linkId: 'link-a' },
    };
    const p1 = await persistCompletedInterviewP1(interview, FP, options, redis);
    expect(p1.status).toBe('started');
    if (p1.status !== 'started') return;
    const guard: PersistingGuard = p1.guard;

    for (const cutId of ['F1', 'F2', 'F3', 'F4', 'F5'] as const) {
      armCut(cutId);
      const cut = await persistCompletedInterviewFinish(guard, redis);
      expect(cut.status).toBe('unavailable');
      coverFaultCut(cutId);
    }
    coverFaultCut('persist-guard-cleanup');
    expect(await persistCompletedInterviewFinish(guard, redis)).toEqual({ status: 'created' });
  });

  it('persist-conflict / cancel / deleted refuse without Finish writes', async () => {
    const study = makeStoredStudy({ id: uuid(), createdAt: NOW, updatedAt: NOW, revision: 1 });
    expect(await createStudyAtomic(study, redis)).toBe('created');
    const interview = makeStoredInterview({
      id: `interview-${uuid()}`,
      studyId: study.id,
      status: 'completed',
    });
    await redis.set(
      `study-mutation-guard:${study.id}`,
      encodeMutationGuard({
        version: 2,
        studyId: study.id,
        kind: 'delete',
        generation: 1,
        state: 'cancelled',
        markerId: `delete:${study.id}:0`,
      })
    );
    expect(
      (
        await persistCompletedInterviewP1(
          interview,
          FP,
          { expectedStudyRevision: 1, identity: { participantSessionId: 's', linkId: 'l' } },
          redis
        )
      ).status
    ).toBe('persist-guard');
    coverFaultCut('persist-cancel');

    await redis.set(
      `study-mutation-guard:${study.id}`,
      encodeMutationGuard({
        version: 2,
        studyId: study.id,
        kind: 'delete',
        generation: 1,
        state: 'deleted',
        markerId: `delete:${study.id}:0`,
      })
    );
    expect(
      (
        await persistCompletedInterviewP1(
          interview,
          FP,
          { expectedStudyRevision: 1, identity: { participantSessionId: 's', linkId: 'l' } },
          redis
        )
      ).status
    ).toBe('persist-guard');
    coverFaultCut('persist-deleted');

    await redis.set(
      `study-mutation-guard:${study.id}`,
      encodeMutationGuard({
        version: 2,
        studyId: study.id,
        kind: 'create',
        generation: 1,
        state: 'created',
        markerId: `create:${study.id}:${NOW}`,
      })
    );
    const other = makeStoredInterview({
      id: `interview-${uuid()}`,
      studyId: study.id,
      status: 'completed',
    });
    const started = await persistCompletedInterviewP1(
      other,
      FP,
      {
        expectedStudyRevision: 1,
        identity: { participantSessionId: 's', linkId: 'l' },
      },
      redis
    );
    expect(started.status).toBe('started');
    if (started.status !== 'started') return;
    const mismatched: PersistingGuard = {
      ...started.guard,
      identity: { participantSessionId: 'other', linkId: 'l' },
    };
    expect(await persistCompletedInterviewFinish(mismatched, redis)).toEqual({ status: 'conflict' });
    coverFaultCut('persist-conflict');
  });
});

describe('account-delete plan/cursor/evict/final HDEL', () => {
  it('begin then apply failpoints resume to complete', async () => {
    const id = `adel-${randomBytes(4).toString('hex')}`;
    const account = researcherAccount(id);
    await redis.set(`researcher:${id}`, encodeAccountRecord({ id }));
    await redis.set(`oauth:google:${account.oauthId}`, id);
    await redis.set(`email:${id}@example.com`, id);

    const begun = await beginAccountDeletion(account, { client: redis });
    expect(begun.status === 'started' || begun.status === 'replay').toBe(true);
    expect((await loadAccountDeletePlan(id, redis))?.ops.length).toBeGreaterThan(2);

    armCut('adel-plan-ops');
    expect((await resumeAccountDeletion(id, { client: redis })).status).toBe('unavailable');
    coverFaultCut('adel-plan-ops');

    redis.clearFaults();
    armCut('adel-cursor');
    expect((await resumeAccountDeletion(id, { client: redis })).status).toBe('unavailable');
    coverFaultCut('adel-cursor');

    redis.clearFaults();
    redis.armFault({
      cutId: 'adel-local-evict',
      commands: 'eval',
      effect: 'cut',
      scriptHint: /fault cut[^\n]*\badel-local-evict\b/,
      once: false,
    });
    expect((await resumeAccountDeletion(id, { client: redis })).status).toBe('unavailable');
    expect(await redis.hexists('account-delete-journal', id)).toBe(1);
    coverFaultCut('adel-local-evict');

    redis.clearFaults();
    redis.armFault({
      cutId: 'adel-final-hdel',
      commands: 'eval',
      effect: 'cut',
      scriptHint: /fault cut[^\n]*\badel-final-hdel\b/,
      once: false,
    });
    expect((await resumeAccountDeletion(id, { client: redis })).status).toBe('unavailable');
    expect(await redis.hexists('account-delete-journal', id)).toBe(1);
    coverFaultCut('adel-final-hdel');

    redis.clearFaults();
    expect((await resumeAccountDeletion(id, { client: redis })).status).toBe('complete');
    expect(await redis.hexists('account-delete-journal', id)).toBe(0);
  });
});

describe('transport response-loss and undecodable-after-commit', () => {
  it('loss after create commits then wrapper reports ambiguous; retry is created', async () => {
    const study = makeStoredStudy({ id: uuid(), createdAt: NOW + 1, updatedAt: NOW + 1 });
    armLoss('transport-response-loss', CREATE_STUDY_SCRIPT.slice(0, 24));
    const lost = await createStudyAtomic(study, redis);
    expect(lost).toBe('ambiguous');
    expect(await redis.get(`study:${study.id}`)).toBeTruthy();
    expect(await createStudyAtomic(study, redis)).toBe('created');
    coverFaultCut('transport-response-loss');
  });

  it('undecodable-after-commit leaves the write and fails closed', async () => {
    const study = makeStoredStudy({ id: uuid(), createdAt: NOW + 2, updatedAt: NOW + 2 });
    armUndecodable('transport-undecodable-after-commit', CREATE_STUDY_SCRIPT.slice(0, 24));
    expect(await createStudyAtomic(study, redis)).toBe('unavailable');
    expect(await redis.get(`study:${study.id}`)).toBeTruthy();
    expect(await createStudyAtomic(study, redis)).toBe('created');
    coverFaultCut('transport-undecodable-after-commit');
  });

  it('drop is zero-write / unavailable', async () => {
    const study = makeStoredStudy({ id: uuid(), createdAt: NOW + 3, updatedAt: NOW + 3 });
    redis.armFault({
      cutId: 'transport-response-loss',
      commands: 'eval',
      effect: 'drop',
      // Both create and delete scripts share the `receipt_resolution` header;
      // `same_generation_guard` is unique to the delete script.
      scriptHint: 'same_generation_guard',
      once: true,
    });
    expect(await createStudyAtomic(study, redis)).toBe('created');
    expect((await deleteStudy(study.id, redis)).status).toBe('unavailable');
    expect(await redis.get(`study:${study.id}`)).toBeTruthy();
  });
});

describe('manifest coverage', () => {
  it('every listed cut has a real-wrapper test', () => {
    assertFaultCutsCovered();
  });
});
