// @vitest-environment node

process.env.PLATFORM_KEY_PREFIX = '';

import { describe, expect, it } from 'vitest';
import { RedisCommitAmbiguousError } from '@/lib/redisPort';
import {
  PUBLISH_STUDY_OPERATION_SCRIPT,
  RECEIPT_TTL_SECONDS,
  buildPendingStudyOperationV2,
  encodeLockValue,
  encodeOperationReceipt,
  encodeOperationRecord,
  hostedPublishKeys,
  publishStudyOperationV2,
  type OperationReceipt,
  type PendingStudyOperationV2,
} from '@/lib/platformDb';
import { parsePublishResult } from '@/lib/wire/parse';
import { MemoryPlatformRedis } from '../helpers/memoryPlatformRedis';

const STUDY_ID = '11111111-1111-4111-8111-111111111111';
const SIBLING_ID = '22222222-2222-4222-8222-222222222222';
const RESEARCHER = 'researcher-a';
const OTHER = 'researcher-b';
const HASH = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const FINGERPRINT = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
const NONCE = '0123456789abcdef0123456789abcdef';
const OTHER_NONCE = 'fedcba9876543210fedcba9876543210';
const NOW = 1_700_000_000_000;
const CREATED_AT = 1_700_000_100_000;

function receipt(overrides?: Partial<OperationReceipt>): OperationReceipt {
  return {
    version: 2,
    studyId: STUDY_ID,
    generation: 1,
    kind: 'create',
    researcherId: RESEARCHER,
    resolution: 'create-complete',
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function publishingField(frozen: OperationReceipt = receipt()) {
  const operation = buildPendingStudyOperationV2({
    kind: frozen.kind,
    phase: 'publishing',
    researcherId: RESEARCHER,
    studyId: STUDY_ID,
    generation: 1,
    opNonce: NONCE,
    createdAt: NOW,
    idempotencyHash: frozen.kind === 'create' ? HASH : null,
    fingerprint: frozen.kind === 'create' ? FINGERPRINT : null,
  });
  operation.frozenReceipt = frozen;
  return encodeOperationRecord(operation);
}

function exactLock(kind: PendingStudyOperationV2['kind'] = 'create') {
  return encodeLockValue({ generation: 1, researcherId: RESEARCHER, kind, opNonce: NONCE });
}

function seedPublishing(redis: MemoryPlatformRedis, frozen: OperationReceipt = receipt()) {
  const hash = redis.hashes.get('study-ops:v2') ?? new Map<string, string>();
  hash.set(STUDY_ID, publishingField(frozen));
  redis.hashes.set('study-ops:v2', hash);
}

function publishInput(
  redis: MemoryPlatformRedis,
  overrides?: Partial<Parameters<typeof publishStudyOperationV2>[0]>,
) {
  return {
    client: redis.asPort(),
    researcherId: RESEARCHER,
    studyId: STUDY_ID,
    generation: 1,
    kind: 'create' as const,
    opNonce: NONCE,
    resolution: 'create-complete' as const,
    now: NOW,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

describe('publishStudyOperationV2 script contract', () => {
  it('orders PUB1 SET → PUB2 ZADD → PUB3 lock CAD → PUB4 HDEL, and prune DEL before ZREM', () => {
    const present = PUBLISH_STUDY_OPERATION_SCRIPT.slice(
      PUBLISH_STUDY_OPERATION_SCRIPT.indexOf('if not op or op.phase'),
    );
    const setIdx = present.indexOf("redis.call('SET', KEYS[3]");
    const pub1 = present.indexOf('-- fault cut PUB1');
    const zaddIdx = present.indexOf("redis.call('ZADD', KEYS[4]");
    const pub2 = present.indexOf('-- fault cut PUB2');
    const pub3 = present.indexOf('-- fault cut PUB3');
    const hdelIdx = present.indexOf("redis.call('HDEL', KEYS[1]");
    const pub4 = present.indexOf('-- fault cut PUB4');
    const delReceipt = PUBLISH_STUDY_OPERATION_SCRIPT.indexOf("redis.call('DEL', KEYS[3])");
    const pruneDel = PUBLISH_STUDY_OPERATION_SCRIPT.indexOf('-- fault cut PRUNE_DEL');
    const zremIdx = PUBLISH_STUDY_OPERATION_SCRIPT.indexOf("redis.call('ZREM', KEYS[4]");
    const pruneZrem = PUBLISH_STUDY_OPERATION_SCRIPT.indexOf('-- fault cut PRUNE_ZREM');
    expect(setIdx).toBeGreaterThan(-1);
    expect(pub1).toBeGreaterThan(setIdx);
    expect(zaddIdx).toBeGreaterThan(pub1);
    expect(pub2).toBeGreaterThan(zaddIdx);
    expect(pub3).toBeGreaterThan(pub2);
    expect(hdelIdx).toBeGreaterThan(pub3);
    expect(pub4).toBeGreaterThan(hdelIdx);
    expect(delReceipt).toBeGreaterThan(-1);
    expect(pruneDel).toBeGreaterThan(delReceipt);
    expect(zremIdx).toBeGreaterThan(pruneDel);
    expect(pruneZrem).toBeGreaterThan(zremIdx);
    expect(hostedPublishKeys(RESEARCHER, STUDY_ID, 1)).toEqual([
      'study-ops:v2',
      `study-op-lock:${STUDY_ID}`,
      `study-op-receipt:${STUDY_ID}:1`,
      `study-op-receipts:${RESEARCHER}`,
    ]);
  });
});

describe('publishStudyOperationV2 PUB1–PUB4', () => {
  it('SETs a missing receipt, ZADDs a nil score, CADs the exact lock, then HDELs last', async () => {
    const redis = new MemoryPlatformRedis();
    seedPublishing(redis);
    redis.strings.set(`study-op-lock:${STUDY_ID}`, exactLock());
    const result = await publishStudyOperationV2(publishInput(redis));
    expect(result).toEqual({ status: 'published', zaddDelta: 1 });
    expect(redis.strings.get(`study-op-receipt:${STUDY_ID}:1`)).toBe(encodeOperationReceipt(receipt()));
    expect(redis.zsets.get(`study-op-receipts:${RESEARCHER}`)?.get(`${STUDY_ID}:1`)).toBe(CREATED_AT);
    expect(redis.strings.has(`study-op-lock:${STUDY_ID}`)).toBe(false);
    expect(redis.hashes.get('study-ops:v2')?.has(STUDY_ID)).toBe(false);
    expect(redis.writes).toEqual(['SET receipt', 'ZADD', 'DEL lock', 'HDEL']);
  });

  it('repairs an absent score with ZADD only and reports cardinality delta 0 on an exact replay', async () => {
    const cut = new MemoryPlatformRedis();
    seedPublishing(cut);
    cut.strings.set(`study-op-receipt:${STUDY_ID}:1`, encodeOperationReceipt(receipt()));
    cut.strings.set(`study-op-lock:${STUDY_ID}`, exactLock());
    expect(await publishStudyOperationV2(publishInput(cut))).toEqual({ status: 'published', zaddDelta: 1 });
    expect(cut.writes).toEqual(['ZADD', 'DEL lock', 'HDEL']);

    const replay = new MemoryPlatformRedis();
    seedPublishing(replay);
    replay.strings.set(`study-op-receipt:${STUDY_ID}:1`, encodeOperationReceipt(receipt()));
    replay.zsets.set(`study-op-receipts:${RESEARCHER}`, new Map([[`${STUDY_ID}:1`, CREATED_AT]]));
    expect(await publishStudyOperationV2(publishInput(replay))).toEqual({ status: 'published', zaddDelta: 0 });
    expect(replay.zsets.get(`study-op-receipts:${RESEARCHER}`)?.size).toBe(1);
    expect(replay.writes).toEqual(['HDEL']);
  });

  it('recreates an expired receipt from frozenReceipt and leaves an equal score untouched', async () => {
    const redis = new MemoryPlatformRedis();
    seedPublishing(redis);
    redis.zsets.set(`study-op-receipts:${RESEARCHER}`, new Map([[`${STUDY_ID}:1`, CREATED_AT]]));
    redis.strings.set(`study-op-lock:${STUDY_ID}`, exactLock());
    expect(await publishStudyOperationV2(publishInput(redis))).toEqual({ status: 'published', zaddDelta: 0 });
    expect(redis.strings.get(`study-op-receipt:${STUDY_ID}:1`)).toBe(encodeOperationReceipt(receipt()));
    expect(redis.writes).toEqual(['SET receipt', 'DEL lock', 'HDEL']);
  });

  it('refuses an unequal score as corrupt with zero writes', async () => {
    const redis = new MemoryPlatformRedis();
    seedPublishing(redis);
    redis.strings.set(`study-op-receipt:${STUDY_ID}:1`, encodeOperationReceipt(receipt()));
    redis.zsets.set(`study-op-receipts:${RESEARCHER}`, new Map([[`${STUDY_ID}:1`, CREATED_AT + 1]]));
    redis.strings.set(`study-op-lock:${STUDY_ID}`, exactLock());
    expect(await publishStudyOperationV2(publishInput(redis))).toEqual({ status: 'corrupt' });
    expect(redis.writes).toEqual([]);
    expect(redis.hashes.get('study-ops:v2')?.has(STUDY_ID)).toBe(true);
    expect(redis.strings.has(`study-op-lock:${STUDY_ID}`)).toBe(true);
  });

  it('CADs only the exact lock and preserves successor or nil lock rows', async () => {
    const successor = encodeLockValue({
      generation: 2,
      researcherId: OTHER,
      kind: 'delete',
      opNonce: OTHER_NONCE,
    });

    const exact = new MemoryPlatformRedis();
    seedPublishing(exact);
    exact.strings.set(`study-op-lock:${STUDY_ID}`, exactLock());
    expect((await publishStudyOperationV2(publishInput(exact))).status).toBe('published');
    expect(exact.strings.has(`study-op-lock:${STUDY_ID}`)).toBe(false);

    const next = new MemoryPlatformRedis();
    seedPublishing(next);
    next.strings.set(`study-op-lock:${STUDY_ID}`, successor);
    expect((await publishStudyOperationV2(publishInput(next))).status).toBe('published');
    expect(next.strings.get(`study-op-lock:${STUDY_ID}`)).toBe(successor);
    expect(next.writes).toEqual(['SET receipt', 'ZADD', 'HDEL']);

    const nil = new MemoryPlatformRedis();
    seedPublishing(nil);
    expect((await publishStudyOperationV2(publishInput(nil))).status).toBe('published');
    expect(nil.strings.has(`study-op-lock:${STUDY_ID}`)).toBe(false);
    expect(nil.writes).toEqual(['SET receipt', 'ZADD', 'HDEL']);

    const malformed = new MemoryPlatformRedis();
    seedPublishing(malformed);
    malformed.strings.set(`study-op-lock:${STUDY_ID}`, 'oi:lock:bad');
    expect(await publishStudyOperationV2(publishInput(malformed))).toEqual({ status: 'unavailable' });
    expect(malformed.writes).toEqual([]);
    expect(malformed.hashes.get('study-ops:v2')?.has(STUDY_ID)).toBe(true);
  });
});

describe('publishStudyOperationV2 missing-field prune and isolation', () => {
  it('prunes a terminal expired receipt with DEL before ZREM and leaves a sibling member', async () => {
    const redis = new MemoryPlatformRedis();
    const siblingField = encodeOperationRecord(buildPendingStudyOperationV2({
      kind: 'delete',
      phase: 'pending',
      researcherId: OTHER,
      studyId: SIBLING_ID,
      generation: 9,
      opNonce: OTHER_NONCE,
      createdAt: NOW,
      idempotencyHash: null,
      fingerprint: null,
    }));
    redis.hashes.set('study-ops:v2', new Map([[SIBLING_ID, siblingField]]));
    redis.strings.set(`study-op-receipt:${STUDY_ID}:1`, encodeOperationReceipt(receipt()));
    redis.zsets.set(`study-op-receipts:${RESEARCHER}`, new Map([
      [`${STUDY_ID}:1`, CREATED_AT],
      [`${SIBLING_ID}:9`, CREATED_AT + 5],
    ]));
    const result = await publishStudyOperationV2(publishInput(redis, {
      now: CREATED_AT + RECEIPT_TTL_SECONDS,
    }));
    expect(result).toEqual({ status: 'pruned', zremDelta: 1 });
    expect(redis.strings.has(`study-op-receipt:${STUDY_ID}:1`)).toBe(false);
    expect(redis.zsets.get(`study-op-receipts:${RESEARCHER}`)?.has(`${STUDY_ID}:1`)).toBe(false);
    expect(redis.zsets.get(`study-op-receipts:${RESEARCHER}`)?.get(`${SIBLING_ID}:9`)).toBe(CREATED_AT + 5);
    expect(redis.hashes.get('study-ops:v2')?.get(SIBLING_ID)).toBe(siblingField);
    expect(redis.writes).toEqual(['DEL receipt', 'ZREM']);
  });

  it('repairs a registry-absent receipt-cut with ZADD only and isolates a malformed sibling lock', async () => {
    const redis = new MemoryPlatformRedis();
    redis.strings.set(`study-op-receipt:${STUDY_ID}:1`, encodeOperationReceipt(receipt()));
    redis.strings.set(`study-op-lock:${SIBLING_ID}`, 'not-a-lock');
    redis.zsets.set(`study-op-receipts:${RESEARCHER}`, new Map([[`${SIBLING_ID}:9`, 1]]));
    expect(await publishStudyOperationV2(publishInput(redis))).toEqual({ status: 'published', zaddDelta: 1 });
    expect(redis.zsets.get(`study-op-receipts:${RESEARCHER}`)?.get(`${STUDY_ID}:1`)).toBe(CREATED_AT);
    expect(redis.zsets.get(`study-op-receipts:${RESEARCHER}`)?.get(`${SIBLING_ID}:9`)).toBe(1);
    expect(redis.strings.get(`study-op-lock:${SIBLING_ID}`)).toBe('not-a-lock');
    expect(redis.writes).toEqual(['ZADD']);
  });

  it('returns stale for a non-publishing field and invalid without eval', async () => {
    const pending = new MemoryPlatformRedis();
    const operation = buildPendingStudyOperationV2({
      kind: 'create',
      phase: 'pending',
      researcherId: RESEARCHER,
      studyId: STUDY_ID,
      generation: 1,
      opNonce: NONCE,
      createdAt: NOW,
      idempotencyHash: HASH,
      fingerprint: FINGERPRINT,
    });
    pending.hashes.set('study-ops:v2', new Map([[STUDY_ID, encodeOperationRecord(operation)]]));
    expect(await publishStudyOperationV2(publishInput(pending))).toEqual({ status: 'stale' });
    expect(pending.writes).toEqual([]);

    const invalid = new MemoryPlatformRedis();
    expect((await publishStudyOperationV2(publishInput(invalid, { studyId: 'nope' }))).status).toBe('invalid');
    expect((await publishStudyOperationV2(publishInput(invalid, {
      kind: 'delete',
      resolution: 'create-complete',
    }))).status).toBe('invalid');
    expect(invalid.evalCalls).toBe(0);
  });
});

describe('publishStudyOperationV2 closed-wire decoder', () => {
  it('accepts publish family tags and refuses malformed or foreign wire with zero further writes', async () => {
    expect(parsePublishResult(['oi:publish-published', 'oi:count:1'])).toEqual({
      status: 'ok',
      value: { outcome: 'published', count: 1 },
    });
    expect(parsePublishResult(['oi:publish-pruned', 'oi:count:0'])).toEqual({
      status: 'ok',
      value: { outcome: 'pruned', count: 0 },
    });
    expect(parsePublishResult(['oi:publish-stale'])).toEqual({ status: 'ok', value: { outcome: 'stale' } });
    expect(parsePublishResult(['oi:publish-corrupt'])).toEqual({ status: 'ok', value: { outcome: 'corrupt' } });
    expect(parsePublishResult(['oi:publish-unavailable']).status).toBe('unavailable');
    expect(parsePublishResult(['oi:resolve-terminal']).status).toBe('unavailable');
    expect(parsePublishResult(['oi:publish-published']).status).toBe('unavailable');
    expect(parsePublishResult(['oi:publish-published', 'oi:count:1', 'x']).status).toBe('unavailable');
    expect(parsePublishResult({ tag: 'oi:publish-published' }).status).toBe('unavailable');

    const redis = new MemoryPlatformRedis();
    seedPublishing(redis);
    redis.forcedEval = ['oi:resolve-publishing', publishingField()];
    expect(await publishStudyOperationV2(publishInput(redis))).toEqual({ status: 'unavailable' });
    expect(redis.writes).toEqual([]);

    redis.forcedEval = ['oi:publish-published'];
    expect(await publishStudyOperationV2(publishInput(redis))).toEqual({ status: 'unavailable' });

    redis.forcedEval = undefined;
    redis.evalError = new RedisCommitAmbiguousError('may-have-committed');
    expect(await publishStudyOperationV2(publishInput(redis))).toEqual({ status: 'ambiguous' });
    redis.evalError = new RedisCommitAmbiguousError('zero-write');
    expect(await publishStudyOperationV2(publishInput(redis))).toEqual({ status: 'unavailable' });
  });
});
