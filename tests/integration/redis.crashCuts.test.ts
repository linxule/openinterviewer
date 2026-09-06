// @vitest-environment node
// Real-Redis crash/retry harness (Revision 12 §18). Runner-owned instance only.

import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RedisNodeAdapter } from '@/lib/redisNodeAdapter';
import type { RedisPort } from '@/lib/redisPort';
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
  attachInterviewAnalysis,
  ANALYSIS_CLAIM_LEASE_MS,
  claimInterviewAnalysis,
  CREATE_STUDY_SCRIPT,
  DELETE_EMPTY_STUDY_SCRIPT,
  createStudyAtomic,
  deleteStudy,
  encodeMutationGuard,
  encodeInterviewValue,
  getInterviewChecked,
  getStudyAggregateChecked,
  persistCompletedInterview,
  persistCompletedInterviewFinish,
  persistCompletedInterviewP1,
  recordInterviewAnalysisFailure,
  replaceStudyConfigAtomic,
  saveStudyAggregate,
  setStudyLinksEnabled,
  STUDY_VALUE_PREFIX,
  type PersistingGuard,
} from '@/lib/kv';
import { BEGIN_STUDY_OPERATION_SCRIPT } from '@/lib/platformDb.operations';
import { makeStoredInterview, makeStoredStudy, makeStudyConfig } from '../fixtures/models';
import { loadCanonicalStudy } from '@/lib/canonicalStudy';
import { validateStudyConfig } from '@/lib/studyConfigValidation';
import {
  startDisposableRedis,
  type DisposableRedis,
} from '../helpers/disposableRedis';
import {
  assertFaultCutsCovered,
  coverFaultCut,
  type FaultCutId,
} from '../helpers/faultManifest';
import type { ResearcherAccount, StoredStudy } from '@/types';

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

  function fixtureAggregate(studyId: string) {
    return {
      studyId,
      studyRevision: 1,
      interviewIds: ['interview-x'],
      interviewCount: 1,
      aiProvider: 'gemini' as const,
      aiModel: 'gemini-2.5-flash',
      commonThemes: [],
      divergentViews: [],
      keyFindings: ['A finding'],
      researchImplications: ['An implication'],
      bottomLine: 'A bottom line.',
      generatedAt: NOW,
      savedAt: NOW,
    };
  }

  it('round-trips the aggregate and deletes it with the study', async () => {
    const study = makeStoredStudy({ id: uuid(), createdAt: NOW, updatedAt: NOW });
    expect(await createStudyAtomic(study, redis)).toBe('created');
    const aggregate = fixtureAggregate(study.id);

    expect(await saveStudyAggregate(aggregate, redis)).toBe('saved');
    expect(await getStudyAggregateChecked(study.id, redis)).toEqual({ status: 'found', aggregate });
    expect(await getStudyAggregateChecked(uuid(), redis)).toEqual({ status: 'not-found' });

    expect((await deleteStudy(study.id, redis)).status).toBe('deleted');
    expect(await redis.get(`study-aggregate:${study.id}`)).toBeNull();
  });

  it('D5 cuts after the aggregate DEL, leaving the study present and the aggregate gone', async () => {
    const study = makeStoredStudy({ id: uuid(), createdAt: NOW, updatedAt: NOW });
    expect(await createStudyAtomic(study, redis)).toBe('created');
    const aggregate = fixtureAggregate(study.id);
    expect(await saveStudyAggregate(aggregate, redis)).toBe('saved');

    armCut('D5');
    expect((await deleteStudy(study.id, redis)).status).toBe('unavailable');
    expect(await redis.get(`study:${study.id}`)).toBeTruthy();
    expect(await redis.get(`study-aggregate:${study.id}`)).toBeNull();
    coverFaultCut('D5');

    expect((await deleteStudy(study.id, redis)).status).toBe('deleted');
  });

  it('a refused delete (conflict) keeps the aggregate', async () => {
    const study = makeStoredStudy({ id: uuid(), createdAt: NOW, updatedAt: NOW });
    expect(await createStudyAtomic(study, redis)).toBe('created');
    const aggregate = fixtureAggregate(study.id);
    expect(await saveStudyAggregate(aggregate, redis)).toBe('saved');
    await redis.sadd(`study-interviews:${study.id}`, 'interview-x');

    const result = await deleteStudy(study.id, redis);
    expect(result.status).toBe('conflict');
    expect(await getStudyAggregateChecked(study.id, redis)).toEqual({ status: 'found', aggregate });
  });

  it('accepts the current six-key hosted arity and refuses the pre-slice five-key shape', async () => {
    const study = makeStoredStudy({ id: uuid(), createdAt: NOW, updatedAt: NOW });
    expect(await createStudyAtomic(study, redis)).toBe('created');

    const previousMode = process.env.DEPLOYMENT_MODE;
    process.env.DEPLOYMENT_MODE = 'hosted';
    try {
      expect((await deleteStudy(study.id, redis)).status).toBe('deleted');
    } finally {
      process.env.DEPLOYMENT_MODE = previousMode;
    }

    const wire = await redis.eval(
      DELETE_EMPTY_STUDY_SCRIPT,
      [
        `study:${uuid()}`,
        `study-interviews:${uuid()}`,
        `study-operation-result:${uuid()}`,
        `study-mutation-guard:${uuid()}`,
        `study-persisting:${uuid()}`,
      ],
      ['stub-id', 'stub-marker', 'stub-receipt', 'stub-guard', '1', 'hosted'],
    );
    expect(wire).toEqual(['oi:byos-unavailable']);
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

describe('study JSON preservation on owned Redis', () => {
  const escapedText = 'Quotes " and backslashes \\ with ],},: and 雪\nnext line';
  const metadata = {
    emptyArray: [],
    emptyObject: {},
    nested: [[], {}, { 'escaped"key\\': [escapedText, [], { value: null }] }],
    precise: 0.12345678901234568,
    integer: Number.MAX_SAFE_INTEGER,
  };

  async function readStored(studyId: string, prefixed: boolean) {
    const raw = await redis.get<string>(`study:${studyId}`);
    if (typeof raw !== 'string') throw new Error('Stored study JSON is missing');
    expect(raw.startsWith(STUDY_VALUE_PREFIX)).toBe(prefixed);
    const body = prefixed ? raw.slice(STUDY_VALUE_PREFIX.length) : raw;
    const study = JSON.parse(body) as StoredStudy & { metadata: typeof metadata };
    expect(study.metadata).toEqual(metadata);
    return study;
  }

  it.each([true, false])('keeps participant saves valid across duplicate retries and a second participant (prefixed=%s)', async (prefixed) => {
    for (const profileSchema of [[], [{
      id: 'role', label: 'Role', extractionHint: escapedText, required: false, options: [],
    }]]) {
      const studyId = uuid();
      const config = makeStudyConfig({ id: studyId, topicAreas: [], profileSchema, description: escapedText });
      const study = { ...makeStoredStudy({ id: studyId, config }), metadata };
      expect(validateStudyConfig(config).ok).toBe(true);
      expect(await createStudyAtomic(study, redis)).toBe('created');
      if (!prefixed) await redis.set(`study:${studyId}`, JSON.stringify(study, null, 2));
      const first = makeStoredInterview({ id: `interview-${uuid()}`, studyId });
      const options = {
        expectedStudyRevision: 1,
        identity: { participantSessionId: `session-${uuid()}`, linkId: `link-${uuid()}` },
      };

      expect(await persistCompletedInterview(first, FP, options, redis)).toEqual({ status: 'created' });
      const afterFirst = await readStored(studyId, prefixed);
      expect(afterFirst.config).toEqual(config);
      expect(validateStudyConfig(afterFirst.config).ok).toBe(true);
      expect(afterFirst).toMatchObject({ interviewCount: 1, isLocked: true, revision: 1 });
      if (prefixed) {
        expect((await loadCanonicalStudy({ kvClient: redis, tokenStudyId: studyId })).ok).toBe(true);
      }
      expect(await persistCompletedInterview(first, FP, options, redis)).toEqual({ status: 'duplicate' });
      expect(await readStored(studyId, prefixed)).toEqual(afterFirst);

      const second = makeStoredInterview({ id: `interview-${uuid()}`, studyId });
      expect(await persistCompletedInterview(second, 'cd'.repeat(32), {
        ...options,
        identity: { ...options.identity, participantSessionId: `session-${uuid()}` },
      }, redis)).toEqual({ status: 'created' });
      const afterSecond = await readStored(studyId, prefixed);
      expect(afterSecond.config).toEqual(config);
      expect(validateStudyConfig(afterSecond.config).ok).toBe(true);
      expect(afterSecond).toMatchObject({ interviewCount: 2, isLocked: true, revision: 1 });
      expect(await redis.scard(`study-interviews:${studyId}`)).toBe(2);
    }
  });

  it.each([true, false])('preserves JSON in link/config mutations and their response payloads (prefixed=%s)', async (prefixed) => {
    const studyId = uuid();
    const config = makeStudyConfig({ id: studyId, topicAreas: [], profileSchema: [], description: escapedText });
    const study = { ...makeStoredStudy({ id: studyId, config }), metadata };
    // Escaped property names and whitespace are valid JSON too.
    const body = JSON.stringify(study, null, 2).replace('"config":', '"confi\\u0067":');
    await redis.set(`study:${studyId}`, (prefixed ? STUDY_VALUE_PREFIX : '') + body);

    const disabled = await setStudyLinksEnabled(studyId, false, redis);
    expect(disabled.status).toBe('updated');
    if (disabled.status !== 'updated') throw new Error('Link toggle failed');
    expect(disabled.study.config).toEqual({ ...config, linksEnabled: false });
    expect(disabled.study.revision).toBe(2);
    expect(await readStored(studyId, prefixed)).toEqual(disabled.study);

    const replacement = {
      ...config,
      topicAreas: [escapedText],
      profileSchema: [
        { id: 'role', label: 'Role', extractionHint: escapedText, required: false, options: [] },
        { id: 'choice', label: 'Choice', extractionHint: 'Pick one', required: true, options: ['one', escapedText] },
      ],
    };
    const replaced = await replaceStudyConfigAtomic(studyId, 2, replacement, redis);
    expect(replaced.status).toBe('updated');
    if (replaced.status !== 'updated') throw new Error('Config replacement failed');
    expect(replaced.study.config).toEqual(replacement);
    expect(replaced.study.revision).toBe(3);
    expect(validateStudyConfig(replaced.study.config).ok).toBe(true);
    expect(await readStored(studyId, prefixed)).toEqual(replaced.study);

    const enabled = await setStudyLinksEnabled(studyId, true, redis);
    expect(enabled.status).toBe('updated');
    if (enabled.status !== 'updated') throw new Error('Link toggle failed');
    expect(enabled.study.config).toEqual({ ...replacement, linksEnabled: true });
    expect(enabled.study.revision).toBe(4);
    expect(validateStudyConfig(enabled.study.config).ok).toBe(true);
    expect(await readStored(studyId, prefixed)).toEqual(enabled.study);
  });

  it('leaves malformed stored objects invalid instead of converting them into arrays', async () => {
    const studyId = uuid();
    const config = { ...makeStudyConfig({ id: studyId }), topicAreas: {} };
    await redis.set(`study:${studyId}`, STUDY_VALUE_PREFIX + JSON.stringify({
      ...makeStoredStudy({ id: studyId }), config, metadata,
    }));
    const result = await setStudyLinksEnabled(studyId, false, redis);
    expect(result.status).toBe('updated');
    const stored = await readStored(studyId, true);
    expect(stored.config.topicAreas).toEqual({});
    expect(validateStudyConfig(stored.config).ok).toBe(false);
    expect((await loadCanonicalStudy({ kvClient: redis, tokenStudyId: studyId })).ok).toBe(false);
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

describe('slice P: interview analysis attach preserves untouched JSON types', () => {
  it('counts a delayed contender after intervening failures without overwriting its attempt-start time', async () => {
    const interview = makeStoredInterview({ id: `interview-${uuid()}` });
    await redis.set(`interview:${interview.id}`, encodeInterviewValue(interview));
    const waiting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const delayedClient = {
      get: redis.get.bind(redis),
      eval: async (...args: Parameters<RedisPort['eval']>) => {
        waiting.resolve();
        await release.promise;
        return redis.eval(...args);
      },
    } as RedisPort;

    // Before the fix this request GETs attempts=0, then queues its EVAL
    // behind two complete claim/failure cycles and writes attempts=1 again.
    const delayedClaim = claimInterviewAnalysis(interview.id, delayedClient, NOW);
    await waiting.promise;
    try {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const claim = await claimInterviewAnalysis(interview.id, redis, NOW + attempt);
        expect(claim).toMatchObject({ status: 'claimed', attempts: attempt });
        if (claim.status !== 'claimed') throw new Error('Claim failed');
        expect(await recordInterviewAnalysisFailure(interview.id, claim.claimId, 'provider', redis))
          .toEqual({ status: 'written' });
        const failed = await getInterviewChecked(interview.id, redis);
        expect(failed.status === 'found' && failed.interview.analysis).toMatchObject({
          status: 'failed', attempts: attempt, lastAttemptAt: NOW + attempt,
        });
      }
    } finally {
      release.resolve();
    }

    const claim = await delayedClaim;
    expect(claim).toMatchObject({ status: 'claimed', attempts: 3 });
    if (claim.status !== 'claimed') throw new Error('Delayed claim failed');
    expect(await attachInterviewAnalysis({
      interviewId: interview.id,
      claimId: claim.claimId,
      synthesis: {
        statedPreferences: [], revealedPreferences: [], themes: [],
        contradictions: [], keyInsights: [], bottomLine: 'Saved analysis',
      },
      provenance: { aiProvider: 'gemini', aiModel: 'gemini-3.7-flash', requestedAiModel: 'gemini-3.7-flash' },
      studyRevision: 2,
    }, redis)).toEqual({ status: 'written' });
    const completed = await getInterviewChecked(interview.id, redis);
    expect(completed.status === 'found' && completed.interview.analysis).toMatchObject({
      status: 'complete', attempts: 3, lastAttemptAt: NOW, studyRevision: 2,
    });
  });

  it('admits one racing claim and fences its writes after a lease takeover', async () => {
    const interview = makeStoredInterview({ id: `interview-${uuid()}` });
    await redis.set(`interview:${interview.id}`, encodeInterviewValue(interview));
    const racing = await Promise.all([
      claimInterviewAnalysis(interview.id, redis, NOW),
      claimInterviewAnalysis(interview.id, redis, NOW),
    ]);
    expect(racing.map(claim => claim.status).sort()).toEqual(['busy', 'claimed']);
    const first = racing.find(claim => claim.status === 'claimed');
    if (!first || first.status !== 'claimed') throw new Error('Claim failed');
    const takeover = await claimInterviewAnalysis(interview.id, redis, NOW + ANALYSIS_CLAIM_LEASE_MS);
    expect(takeover).toMatchObject({ status: 'claimed', attempts: 2 });
    if (takeover.status !== 'claimed') throw new Error('Takeover failed');
    expect(await attachInterviewAnalysis({
      interviewId: interview.id,
      claimId: first.claimId,
      synthesis: {
        statedPreferences: [], revealedPreferences: [], themes: [],
        contradictions: [], keyInsights: [], bottomLine: 'Stale analysis',
      },
      provenance: { aiProvider: 'gemini', aiModel: 'gemini-3.7-flash', requestedAiModel: 'gemini-3.7-flash' },
      studyRevision: 1,
    }, redis)).toEqual({ status: 'stale' });
    expect(await recordInterviewAnalysisFailure(interview.id, first.claimId, 'provider', redis))
      .toEqual({ status: 'stale' });
    expect(await recordInterviewAnalysisFailure(interview.id, takeover.claimId, 'provider', redis))
      .toEqual({ status: 'written' });
    const failed = await getInterviewChecked(interview.id, redis);
    expect(failed.status === 'found' && failed.interview.analysis).toMatchObject({
      status: 'failed', attempts: 2, lastAttemptAt: NOW + ANALYSIS_CLAIM_LEASE_MS,
    });
  });

  it.each([-1, 1.5, '2'])('refuses a malformed attempt counter (%s) as corrupt without changing the record', async (attempts) => {
    const interview = makeStoredInterview({ id: `interview-${uuid()}` });
    const encoded = `oi:interview:${JSON.stringify({
      ...interview,
      analysis: { status: 'pending', attempts, lastAttemptAt: NOW },
    })}`;
    await redis.set(`interview:${interview.id}`, encoded);
    expect(await claimInterviewAnalysis(interview.id, redis, NOW)).toEqual({ status: 'corrupt' });
    expect(await redis.get(`interview:${interview.id}`)).toBe(encoded);
  });

  it('refuses a missing attempt counter as corrupt without changing the record', async () => {
    const interview = makeStoredInterview({ id: `interview-${uuid()}` });
    const encoded = `oi:interview:${JSON.stringify({
      ...interview,
      analysis: { status: 'pending', lastAttemptAt: NOW },
    })}`;
    await redis.set(`interview:${interview.id}`, encoded);
    expect(await claimInterviewAnalysis(interview.id, redis, NOW)).toEqual({ status: 'corrupt' });
    expect(await redis.get(`interview:${interview.id}`)).toBe(encoded);
  });

  it('refuses an exhausted attempt counter as unavailable, not corrupt, without changing the record', async () => {
    const interview = makeStoredInterview({ id: `interview-${uuid()}` });
    const encoded = `oi:interview:${JSON.stringify({
      ...interview,
      analysis: { status: 'pending', attempts: Number.MAX_SAFE_INTEGER, lastAttemptAt: NOW },
    })}`;
    await redis.set(`interview:${interview.id}`, encoded);
    expect(await claimInterviewAnalysis(interview.id, redis, NOW)).toEqual({ status: 'unavailable' });
    expect(await redis.get(`interview:${interview.id}`)).toBe(encoded);
  });

  it('refuses a running claim without an attempt-start time as corrupt on attach and fail, byte-for-byte unchanged', async () => {
    const interview = makeStoredInterview({ id: `interview-${uuid()}` });
    const encoded = `oi:interview:${JSON.stringify({
      ...interview,
      analysis: { status: 'running', attempts: 1, claimId: 'claim-held', claimedAt: NOW },
    })}`;
    await redis.set(`interview:${interview.id}`, encoded);
    expect(await attachInterviewAnalysis({
      interviewId: interview.id,
      claimId: 'claim-held',
      synthesis: {
        statedPreferences: [], revealedPreferences: [], themes: [],
        contradictions: [], keyInsights: [], bottomLine: 'Refused analysis',
      },
      provenance: { aiProvider: 'gemini', aiModel: 'gemini-3.7-flash', requestedAiModel: 'gemini-3.7-flash' },
      studyRevision: 1,
    }, redis)).toEqual({ status: 'corrupt' });
    expect(await redis.get(`interview:${interview.id}`)).toBe(encoded);
    expect(await recordInterviewAnalysisFailure(interview.id, 'claim-held', 'provider', redis))
      .toEqual({ status: 'corrupt' });
    expect(await redis.get(`interview:${interview.id}`)).toBe(encoded);
  });

  it('refuses a record with a non-numeric identity timestamp as corrupt without changing it', async () => {
    const interview = makeStoredInterview({ id: `interview-${uuid()}` });
    const encoded = `oi:interview:${JSON.stringify({ ...interview, createdAt: String(NOW) })}`;
    await redis.set(`interview:${interview.id}`, encoded);
    expect(await claimInterviewAnalysis(interview.id, redis, NOW)).toEqual({ status: 'corrupt' });
    expect(await redis.get(`interview:${interview.id}`)).toBe(encoded);
  });

  it('still claims a legacy record that has no analysis member and starts its counter at one', async () => {
    const interview = makeStoredInterview({ id: `interview-${uuid()}` });
    const record = { ...interview } as Record<string, unknown>;
    delete record.analysis;
    expect(record).not.toHaveProperty('analysis');
    await redis.set(`interview:${interview.id}`, `oi:interview:${JSON.stringify(record)}`);
    const claim = await claimInterviewAnalysis(interview.id, redis, NOW);
    expect(claim).toMatchObject({ status: 'claimed', attempts: 1 });
    const stored = await getInterviewChecked(interview.id, redis);
    expect(stored.status === 'found' && stored.interview.analysis).toMatchObject({
      status: 'running', attempts: 1, lastAttemptAt: NOW,
    });
  });

  it('claim then attach on a record with an empty array and an empty string round-trips both byte-identically', async () => {
    const studyId = uuid();
    const config = makeStudyConfig({ id: studyId, aiProvider: 'gemini', aiModel: 'gemini-3.7-flash' });
    const study = makeStoredStudy({ id: studyId, config });
    expect(await createStudyAtomic(study, redis)).toBe('created');

    const interview = makeStoredInterview({
      id: `interview-${uuid()}`,
      studyId,
      // The classic cjson pitfall this Lua patcher exists to avoid: an empty
      // array decodes indistinguishably from an empty object unless the
      // untouched member's raw text is preserved verbatim.
      behaviorData: {
        timePerTopic: {},
        messagesPerTopic: {},
        topicsExplored: [],
        contradictions: [],
      },
      participantProfile: { id: 'profile-empty', fields: [], rawContext: '', timestamp: NOW },
    });
    const options = {
      expectedStudyRevision: 1,
      identity: { participantSessionId: `session-${uuid()}`, linkId: `link-${uuid()}` },
    };
    expect(await persistCompletedInterview(interview, FP, options, redis)).toEqual({ status: 'created' });

    const claimed = await claimInterviewAnalysis(interview.id, redis);
    expect(claimed.status).toBe('claimed');
    if (claimed.status !== 'claimed') throw new Error('Claim failed');

    const synthesis = {
      statedPreferences: [], revealedPreferences: [], themes: [],
      contradictions: [], keyInsights: ['An insight'], bottomLine: 'A bottom line',
    };
    const attached = await attachInterviewAnalysis({
      interviewId: interview.id,
      claimId: claimed.claimId,
      synthesis,
      provenance: { aiProvider: 'gemini', aiModel: 'gemini-3.7-flash', requestedAiModel: 'gemini-3.7-flash' },
      studyRevision: 1,
    }, redis);
    expect(attached.status).toBe('written');

    const raw = await redis.get<string>(`interview:${interview.id}`);
    if (typeof raw !== 'string') throw new Error('Stored interview JSON is missing');
    expect(raw.startsWith('oi:interview:')).toBe(true);
    const stored = JSON.parse(raw.slice('oi:interview:'.length)) as typeof interview;

    // The untouched members round-trip with their original JSON types —
    // real cjson is the only place `[]` vs `{}` is genuinely exercised.
    expect(stored.behaviorData.topicsExplored).toEqual([]);
    expect(Array.isArray(stored.behaviorData.topicsExplored)).toBe(true);
    expect(stored.participantProfile?.rawContext).toBe('');
    expect(stored.synthesis).toEqual(synthesis);
    expect(stored.analysis).toMatchObject({ status: 'complete', studyRevision: 1 });
    expect(stored.aiProvider).toBe('gemini');
    expect(stored.aiModel).toBe('gemini-3.7-flash');
  });
});

describe('manifest coverage', () => {
  it('every listed cut has a real-wrapper test', () => {
    assertFaultCutsCovered();
  });
});
