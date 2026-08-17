// @vitest-environment node

process.env.PLATFORM_KEY_PREFIX = '';

import { describe, expect, it } from 'vitest';
import { RedisCommitAmbiguousError } from '@/lib/redisPort';
import {
  RESOLVE_STUDY_OPERATION_SCRIPT,
  buildPendingStudyOperationV2,
  encodeLockValue,
  encodeOperationReceipt,
  encodeOperationRecord,
  encodeOwnerRecord,
  hostedResolveKeys,
  parsePendingStudyOperationV2,
  resolveStudyOperationV2,
  type OperationReceipt,
  type PendingStudyOperationV2,
  type StudyOpPhase,
} from '@/lib/platformDb';
import { parseResolveResult } from '@/lib/wire/parse';
import { MemoryPlatformRedis } from '../helpers/memoryPlatformRedis';

const STUDY_ID = '11111111-1111-4111-8111-111111111111';
const RESEARCHER = 'researcher-a';
const OTHER = 'researcher-b';
const STORAGE_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_STORAGE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const FINGERPRINT = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
const NONCE = '0123456789abcdef0123456789abcdef';
const OTHER_NONCE = 'fedcba9876543210fedcba9876543210';
const NOW = 1_700_000_000_000;
const CREATED_AT = 1_700_000_100_000;

function ownerRecord(researcherId = RESEARCHER, storageId = STORAGE_ID, generation = 1) {
  return encodeOwnerRecord({ version: 2, researcherId, storageId, generation });
}

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

function field(phase: StudyOpPhase, kind: PendingStudyOperationV2['kind'] = 'create', frozen: OperationReceipt | null = null) {
  const operation = buildPendingStudyOperationV2({
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
  operation.frozenReceipt = frozen;
  return encodeOperationRecord(operation);
}

function seedPending(
  redis: MemoryPlatformRedis,
  phase: StudyOpPhase = 'pending',
  kind: PendingStudyOperationV2['kind'] = 'create',
) {
  const hash = redis.hashes.get('study-ops:v2') ?? new Map<string, string>();
  hash.set(STUDY_ID, field(phase, kind, phase === 'publishing' ? receipt({ kind, resolution: kind === 'create' ? 'create-complete' : 'delete-complete' }) : null));
  redis.hashes.set('study-ops:v2', hash);
  redis.strings.set(`study-owner:${STUDY_ID}`, ownerRecord());
  redis.sets.set(`researcher-studies:${RESEARCHER}`, new Set([STUDY_ID]));
}

function exactLock(kind: PendingStudyOperationV2['kind'] = 'create') {
  return encodeLockValue({ generation: 1, researcherId: RESEARCHER, kind, opNonce: NONCE });
}

function resolveInput(
  redis: MemoryPlatformRedis,
  overrides?: Partial<Parameters<typeof resolveStudyOperationV2>[0]>,
) {
  return {
    client: redis.asPort(),
    researcherId: RESEARCHER,
    studyId: STUDY_ID,
    storageId: STORAGE_ID,
    generation: 1,
    kind: 'create' as const,
    opNonce: NONCE,
    resolution: 'create-complete' as const,
    now: NOW,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

describe('resolveStudyOperationV2 script contract', () => {
  it('lists resolve KEYS and HSETs resolving before owner mutation, skipping pending lock checks after that phase', () => {
    const resolvingIdx = RESOLVE_STUDY_OPERATION_SCRIPT.indexOf("op.phase = 'resolving'");
    const faultIdx = RESOLVE_STUDY_OPERATION_SCRIPT.indexOf('-- fault cut resolve');
    const saddIdx = RESOLVE_STUDY_OPERATION_SCRIPT.indexOf("redis.call('SADD', KEYS[4]");
    const lockIdx = RESOLVE_STUDY_OPERATION_SCRIPT.indexOf("if op.phase == 'pending' then");
    const publishingIdx = RESOLVE_STUDY_OPERATION_SCRIPT.indexOf("op.phase = 'publishing'");
    expect(resolvingIdx).toBeGreaterThan(-1);
    expect(faultIdx).toBeGreaterThan(resolvingIdx);
    expect(saddIdx).toBeGreaterThan(faultIdx);
    expect(lockIdx).toBeGreaterThan(-1);
    expect(lockIdx).toBeLessThan(resolvingIdx);
    expect(publishingIdx).toBeGreaterThan(saddIdx);
    expect(RESOLVE_STUDY_OPERATION_SCRIPT).toContain("return {'oi:resolve-publishing'");
    expect(RESOLVE_STUDY_OPERATION_SCRIPT).toContain('op.frozenReceipt = expectedReceipt');
    expect(hostedResolveKeys(RESEARCHER, STUDY_ID, 1)).toEqual([
      'study-ops:v2',
      `study-op-lock:${STUDY_ID}`,
      `study-owner:${STUDY_ID}`,
      `researcher-studies:${RESEARCHER}`,
      `study-op-receipt:${STUDY_ID}:1`,
      `study-op-receipts:${RESEARCHER}`,
    ]);
  });
});

describe('resolveStudyOperationV2 pending/resolving to publishing', () => {
  it('freezes the receipt and SADDs on create-complete from pending with the exact lock', async () => {
    const redis = new MemoryPlatformRedis();
    seedPending(redis);
    redis.strings.set(`study-op-lock:${STUDY_ID}`, exactLock());
    const result = await resolveStudyOperationV2(resolveInput(redis));
    expect(result.status).toBe('publishing');
    if (result.status !== 'publishing') return;
    expect(result.operation.phase).toBe('publishing');
    expect(result.operation.frozenReceipt).toEqual(receipt());
    expect(redis.sets.get(`researcher-studies:${RESEARCHER}`)?.has(STUDY_ID)).toBe(true);
    expect(redis.strings.get(`study-owner:${STUDY_ID}`)).toBe(ownerRecord());
    expect(redis.writes).toEqual(['HSET resolving', 'SADD', 'HSET publishing']);
  });

  it('CADs the matching owner and SREMs on create-rollback', async () => {
    const redis = new MemoryPlatformRedis();
    seedPending(redis);
    redis.strings.set(`study-op-lock:${STUDY_ID}`, exactLock());
    const result = await resolveStudyOperationV2(resolveInput(redis, { resolution: 'create-rollback' }));
    expect(result.status).toBe('publishing');
    expect(redis.strings.has(`study-owner:${STUDY_ID}`)).toBe(false);
    expect(redis.sets.get(`researcher-studies:${RESEARCHER}`)?.has(STUDY_ID)).toBe(false);
    expect(parsePendingStudyOperationV2(redis.hashes.get('study-ops:v2')?.get(STUDY_ID))?.frozenReceipt?.resolution)
      .toBe('create-rollback');
    expect(redis.writes).toEqual(['HSET resolving', 'DEL owner', 'SREM', 'HSET publishing']);
  });

  it('SADDs on delete-rollback and SREMs on delete-complete without touching a foreign owner', async () => {
    const rollback = new MemoryPlatformRedis();
    seedPending(rollback, 'pending', 'delete');
    rollback.strings.set(`study-op-lock:${STUDY_ID}`, exactLock('delete'));
    expect((await resolveStudyOperationV2(resolveInput(rollback, {
      kind: 'delete',
      resolution: 'delete-rollback',
    }))).status).toBe('publishing');
    expect(rollback.sets.get(`researcher-studies:${RESEARCHER}`)?.has(STUDY_ID)).toBe(true);

    const complete = new MemoryPlatformRedis();
    seedPending(complete, 'pending', 'delete');
    complete.strings.set(`study-op-lock:${STUDY_ID}`, exactLock('delete'));
    complete.strings.set(`study-owner:${STUDY_ID}`, ownerRecord(OTHER, OTHER_STORAGE, 9));
    const result = await resolveStudyOperationV2(resolveInput(complete, {
      kind: 'delete',
      resolution: 'delete-complete',
    }));
    expect(result.status).toBe('publishing');
    expect(complete.strings.get(`study-owner:${STUDY_ID}`)).toBe(ownerRecord(OTHER, OTHER_STORAGE, 9));
    expect(complete.sets.get(`researcher-studies:${RESEARCHER}`)?.has(STUDY_ID)).toBe(false);
    expect(complete.writes).toEqual(['HSET resolving', 'SREM', 'HSET publishing']);
  });

  it('continues from resolving without pending lock checks', async () => {
    const redis = new MemoryPlatformRedis();
    seedPending(redis, 'resolving');
    redis.strings.set(
      `study-op-lock:${STUDY_ID}`,
      encodeLockValue({ generation: 9, researcherId: OTHER, kind: 'delete', opNonce: OTHER_NONCE }),
    );
    const result = await resolveStudyOperationV2(resolveInput(redis));
    expect(result.status).toBe('publishing');
    expect(parsePendingStudyOperationV2(redis.hashes.get('study-ops:v2')?.get(STUDY_ID))?.phase).toBe('publishing');
  });

  it('replays an already-publishing field with zero writes', async () => {
    const redis = new MemoryPlatformRedis();
    seedPending(redis, 'publishing');
    const result = await resolveStudyOperationV2(resolveInput(redis));
    expect(result.status).toBe('publishing');
    if (result.status !== 'publishing') return;
    expect(result.operation.frozenReceipt).toEqual(receipt());
    expect(redis.writes).toEqual([]);
  });
});

describe('resolveStudyOperationV2 zero-write refusals', () => {
  it('refuses pending without the exact lock and writes nothing', async () => {
    const missing = new MemoryPlatformRedis();
    seedPending(missing);
    expect((await resolveStudyOperationV2(resolveInput(missing))).status).toBe('unavailable');
    expect(missing.writes).toEqual([]);

    const other = new MemoryPlatformRedis();
    seedPending(other);
    other.strings.set(
      `study-op-lock:${STUDY_ID}`,
      encodeLockValue({ generation: 2, researcherId: RESEARCHER, kind: 'create', opNonce: NONCE }),
    );
    expect((await resolveStudyOperationV2(resolveInput(other))).status).toBe('unavailable');
    expect(other.writes).toEqual([]);

    const malformed = new MemoryPlatformRedis();
    seedPending(malformed);
    malformed.strings.set(`study-op-lock:${STUDY_ID}`, 'not-a-lock');
    expect((await resolveStudyOperationV2(resolveInput(malformed))).status).toBe('unavailable');
    expect(malformed.writes).toEqual([]);
  });

  it('refuses create-complete when owner is missing or mismatched', async () => {
    const missing = new MemoryPlatformRedis();
    seedPending(missing);
    missing.strings.delete(`study-owner:${STUDY_ID}`);
    missing.strings.set(`study-op-lock:${STUDY_ID}`, exactLock());
    expect((await resolveStudyOperationV2(resolveInput(missing))).status).toBe('unavailable');
    expect(missing.writes).toEqual([]);

    const mismatch = new MemoryPlatformRedis();
    seedPending(mismatch);
    mismatch.strings.set(`study-owner:${STUDY_ID}`, ownerRecord(OTHER));
    mismatch.strings.set(`study-op-lock:${STUDY_ID}`, exactLock());
    expect((await resolveStudyOperationV2(resolveInput(mismatch))).status).toBe('unavailable');
    expect(mismatch.writes).toEqual([]);
    expect(mismatch.strings.get(`study-owner:${STUDY_ID}`)).toBe(ownerRecord(OTHER));
  });

  it('refuses reserving and malformed fields without writes', async () => {
    const reserving = new MemoryPlatformRedis();
    seedPending(reserving, 'reserving');
    reserving.strings.set(`study-op-lock:${STUDY_ID}`, exactLock());
    expect((await resolveStudyOperationV2(resolveInput(reserving))).status).toBe('unavailable');
    expect(reserving.writes).toEqual([]);

    const malformed = new MemoryPlatformRedis();
    const hash = malformed.hashes.get('study-ops:v2') ?? new Map<string, string>();
    hash.set(STUDY_ID, 'oi:op:{"version":1}');
    malformed.hashes.set('study-ops:v2', hash);
    expect((await resolveStudyOperationV2(resolveInput(malformed))).status).toBe('unavailable');
    expect(malformed.writes).toEqual([]);
  });

  it('returns invalid for identity/resolution mismatches without eval', async () => {
    const redis = new MemoryPlatformRedis();
    seedPending(redis);
    expect((await resolveStudyOperationV2(resolveInput(redis, { studyId: 'nope' }))).status).toBe('invalid');
    expect((await resolveStudyOperationV2(resolveInput(redis, {
      kind: 'delete',
      resolution: 'create-complete',
    }))).status).toBe('invalid');
    expect(redis.evalCalls).toBe(0);
  });
});

describe('resolveStudyOperationV2 registry-absent classification', () => {
  it('classifies lock/receipt/zscore without mutating owner', async () => {
    const owner = ownerRecord();
    const exact = encodeOperationReceipt(receipt());

    const missingOp = new MemoryPlatformRedis();
    missingOp.strings.set(`study-owner:${STUDY_ID}`, owner);
    missingOp.strings.set(`study-op-lock:${STUDY_ID}`, exactLock());
    expect((await resolveStudyOperationV2(resolveInput(missingOp))).status).toBe('missing-operation');
    expect(missingOp.strings.get(`study-owner:${STUDY_ID}`)).toBe(owner);
    expect(missingOp.writes).toEqual([]);

    const nilLock = new MemoryPlatformRedis();
    nilLock.strings.set(`study-owner:${STUDY_ID}`, owner);
    expect((await resolveStudyOperationV2(resolveInput(nilLock))).status).toBe('ambiguous');
    expect(nilLock.writes).toEqual([]);

    const otherLock = new MemoryPlatformRedis();
    otherLock.strings.set(`study-owner:${STUDY_ID}`, owner);
    otherLock.strings.set(
      `study-op-lock:${STUDY_ID}`,
      encodeLockValue({ generation: 2, researcherId: OTHER, kind: 'delete', opNonce: OTHER_NONCE }),
    );
    expect((await resolveStudyOperationV2(resolveInput(otherLock))).status).toBe('ambiguous');

    const badLock = new MemoryPlatformRedis();
    badLock.strings.set(`study-op-lock:${STUDY_ID}`, 'oi:lock:bad');
    expect((await resolveStudyOperationV2(resolveInput(badLock))).status).toBe('unavailable');
    expect(badLock.writes).toEqual([]);

    const stale = new MemoryPlatformRedis();
    stale.strings.set(`study-op-receipt:${STUDY_ID}:1`, encodeOperationReceipt(receipt({ createdAt: 1 })));
    expect((await resolveStudyOperationV2(resolveInput(stale))).status).toBe('stale');

    const cut = new MemoryPlatformRedis();
    cut.strings.set(`study-op-receipt:${STUDY_ID}:1`, exact);
    expect((await resolveStudyOperationV2(resolveInput(cut))).status).toBe('receipt-cut');

    const corrupt = new MemoryPlatformRedis();
    corrupt.strings.set(`study-op-receipt:${STUDY_ID}:1`, exact);
    corrupt.zsets.set(`study-op-receipts:${RESEARCHER}`, new Map([[`${STUDY_ID}:1`, CREATED_AT + 1]]));
    expect((await resolveStudyOperationV2(resolveInput(corrupt))).status).toBe('corrupt');

    const terminal = new MemoryPlatformRedis();
    terminal.strings.set(`study-op-receipt:${STUDY_ID}:1`, exact);
    terminal.zsets.set(`study-op-receipts:${RESEARCHER}`, new Map([[`${STUDY_ID}:1`, CREATED_AT]]));
    terminal.strings.set(`study-owner:${STUDY_ID}`, owner);
    expect((await resolveStudyOperationV2(resolveInput(terminal))).status).toBe('terminal');
    expect(terminal.strings.get(`study-owner:${STUDY_ID}`)).toBe(owner);
    expect(terminal.writes).toEqual([]);
  });
});

describe('resolveStudyOperationV2 closed-wire decoder', () => {
  it('accepts resolve family tags and refuses malformed or foreign wire with zero writes', async () => {
    expect(parseResolveResult(['oi:resolve-publishing', 'oi:op:{"version":2}'])).toEqual({
      status: 'ok',
      value: { outcome: 'publishing', value: 'oi:op:{"version":2}' },
    });
    expect(parseResolveResult(['oi:resolve-missing-operation'])).toEqual({
      status: 'ok',
      value: { outcome: 'missing-operation' },
    });
    expect(parseResolveResult(['oi:resolve-terminal']).status).toBe('ok');
    expect(parseResolveResult(['oi:begin-started', 'x']).status).toBe('unavailable');
    expect(parseResolveResult(['oi:resolve-publishing']).status).toBe('unavailable');
    expect(parseResolveResult(['oi:resolve-publishing', 'x', 'y']).status).toBe('unavailable');
    expect(parseResolveResult({ tag: 'oi:resolve-publishing' }).status).toBe('unavailable');

    const redis = new MemoryPlatformRedis();
    seedPending(redis);
    redis.strings.set(`study-op-lock:${STUDY_ID}`, exactLock());
    redis.forcedEval = ['oi:begin-started', field('publishing')];
    expect((await resolveStudyOperationV2(resolveInput(redis))).status).toBe('unavailable');
    expect(redis.writes).toEqual([]);

    redis.forcedEval = ['oi:resolve-publishing'];
    expect((await resolveStudyOperationV2(resolveInput(redis))).status).toBe('unavailable');

    redis.forcedEval = ['oi:resolve-publishing', field('pending')];
    expect((await resolveStudyOperationV2(resolveInput(redis))).status).toBe('unavailable');

    redis.forcedEval = undefined;
    redis.evalError = new RedisCommitAmbiguousError('may-have-committed');
    expect((await resolveStudyOperationV2(resolveInput(redis))).status).toBe('ambiguous');
    redis.evalError = new RedisCommitAmbiguousError('zero-write');
    expect((await resolveStudyOperationV2(resolveInput(redis))).status).toBe('unavailable');
  });
});
