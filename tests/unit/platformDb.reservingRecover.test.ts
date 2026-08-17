// @vitest-environment node

process.env.PLATFORM_KEY_PREFIX = '';

import { describe, expect, it } from 'vitest';
import { RedisCommitAmbiguousError } from '@/lib/redisPort';
import {
  RECOVER_RESERVING_STUDY_OPERATION_SCRIPT,
  buildPendingStudyOperationV2,
  encodeLockValue,
  encodeOperationRecord,
  encodeOwnerRecord,
  hostedRecoverKeys,
  parsePendingStudyOperationV2,
  recoverReservingStudyOperation,
} from '@/lib/platformDb';
import { parseRecoverResult } from '@/lib/wire/parse';
import { MemoryPlatformRedis } from '../helpers/memoryPlatformRedis';

const STUDY_ID = '11111111-1111-4111-8111-111111111111';
const RESEARCHER = 'researcher-a';
const OTHER = 'researcher-b';
const STORAGE_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const FINGERPRINT = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
const NONCE = '0123456789abcdef0123456789abcdef';
const OTHER_NONCE = 'fedcba9876543210fedcba9876543210';
const CREATED_AT = 1_700_000_000_000;
const GRACE = 300_000;

function reservingField() {
  return encodeOperationRecord(buildPendingStudyOperationV2({
    kind: 'create',
    phase: 'reserving',
    researcherId: RESEARCHER,
    studyId: STUDY_ID,
    generation: 1,
    opNonce: NONCE,
    createdAt: CREATED_AT,
    idempotencyHash: HASH,
    fingerprint: FINGERPRINT,
  }));
}

function seedField(redis: MemoryPlatformRedis, encoded = reservingField()) {
  const hash = redis.hashes.get('study-ops:v2') ?? new Map<string, string>();
  hash.set(STUDY_ID, encoded);
  redis.hashes.set('study-ops:v2', hash);
}

function recoverInput(redis: MemoryPlatformRedis, now = CREATED_AT + 1_000) {
  return {
    client: redis.asPort(),
    studyId: STUDY_ID,
    researcherId: RESEARCHER,
    generation: 1,
    kind: 'create' as const,
    opNonce: NONCE,
    now,
    graceMs: GRACE,
  };
}

describe('reserving recovery script contract', () => {
  it('branches on phase before lock/owner checks and lists recover KEYS', () => {
    const phaseIdx = RECOVER_RESERVING_STUDY_OPERATION_SCRIPT.indexOf("if op.phase ~= 'reserving' then");
    const lockIdx = RECOVER_RESERVING_STUDY_OPERATION_SCRIPT.indexOf("redis.call('GET', KEYS[2])");
    const journalIdx = RECOVER_RESERVING_STUDY_OPERATION_SCRIPT.indexOf("redis.call('HEXISTS', KEYS[5]");
    expect(phaseIdx).toBeGreaterThan(-1);
    expect(phaseIdx).toBeLessThan(lockIdx);
    expect(phaseIdx).toBeLessThan(journalIdx);
    expect(RECOVER_RESERVING_STUDY_OPERATION_SCRIPT).toContain("return {'oi:recover-phase', op.phase}");
    expect(RECOVER_RESERVING_STUDY_OPERATION_SCRIPT).toContain("return {'oi:recover-wait'}");
    expect(RECOVER_RESERVING_STUDY_OPERATION_SCRIPT).toContain("return {'oi:recover-ambiguous'}");
    expect(hostedRecoverKeys(RESEARCHER, STUDY_ID)).toEqual([
      'study-ops:v2',
      `study-op-lock:${STUDY_ID}`,
      `study-owner:${STUDY_ID}`,
      `researcher-studies:${RESEARCHER}`,
      'account-delete-journal',
    ]);
  });
});

describe('recoverReservingStudyOperation', () => {
  it('installs pending when the lock is this generation', async () => {
    const redis = new MemoryPlatformRedis();
    seedField(redis);
    redis.strings.set(
      `study-op-lock:${STUDY_ID}`,
      encodeLockValue({ generation: 1, researcherId: RESEARCHER, kind: 'create', opNonce: NONCE }),
    );
    const result = await recoverReservingStudyOperation(recoverInput(redis));
    expect(result.status).toBe('pending');
    expect(parsePendingStudyOperationV2(redis.hashes.get('study-ops:v2')?.get(STUDY_ID))?.phase).toBe('pending');
  });

  it('returns the current phase immediately and writes nothing', async () => {
    const redis = new MemoryPlatformRedis();
    seedField(redis, encodeOperationRecord(buildPendingStudyOperationV2({
      kind: 'create',
      phase: 'publishing',
      researcherId: RESEARCHER,
      studyId: STUDY_ID,
      generation: 1,
      opNonce: NONCE,
      createdAt: CREATED_AT,
      idempotencyHash: HASH,
      fingerprint: FINGERPRINT,
    })));
    redis.strings.set(
      `study-op-lock:${STUDY_ID}`,
      encodeLockValue({ generation: 9, researcherId: OTHER, kind: 'delete', opNonce: OTHER_NONCE }),
    );
    const result = await recoverReservingStudyOperation(recoverInput(redis));
    expect(result).toEqual({ status: 'phase', phase: 'publishing' });
    expect(redis.writes).toEqual([]);
  });

  it('sets the exact lock and pending when lock is nil and owner reverse matches', async () => {
    const redis = new MemoryPlatformRedis();
    seedField(redis);
    redis.strings.set(
      `study-owner:${STUDY_ID}`,
      encodeOwnerRecord({ version: 2, researcherId: RESEARCHER, storageId: STORAGE_ID, generation: 1 }),
    );
    redis.sets.set(`researcher-studies:${RESEARCHER}`, new Set([STUDY_ID]));
    const result = await recoverReservingStudyOperation(recoverInput(redis));
    expect(result.status).toBe('pending');
    expect(redis.strings.get(`study-op-lock:${STUDY_ID}`)).toBe(
      encodeLockValue({ generation: 1, researcherId: RESEARCHER, kind: 'create', opNonce: NONCE }),
    );
    expect(parsePendingStudyOperationV2(redis.hashes.get('study-ops:v2')?.get(STUDY_ID))?.phase).toBe('pending');
  });

  it('waits inside grace and HDELs only the field after grace when owner is absent', async () => {
    const waiting = new MemoryPlatformRedis();
    seedField(waiting);
    expect((await recoverReservingStudyOperation(recoverInput(waiting, CREATED_AT + 10))).status).toBe('wait');
    expect(waiting.hashes.get('study-ops:v2')?.has(STUDY_ID)).toBe(true);
    expect(waiting.writes).toEqual([]);

    const expired = new MemoryPlatformRedis();
    seedField(expired);
    expect((await recoverReservingStudyOperation(recoverInput(expired, CREATED_AT + GRACE))).status).toBe('abandoned');
    expect(expired.hashes.get('study-ops:v2')?.has(STUDY_ID)).toBe(false);
    expect(expired.writes).toEqual(['HDEL']);
  });

  it('returns ambiguous for another generation lock and does not write', async () => {
    const redis = new MemoryPlatformRedis();
    seedField(redis);
    redis.strings.set(
      `study-op-lock:${STUDY_ID}`,
      encodeLockValue({ generation: 2, researcherId: OTHER, kind: 'delete', opNonce: OTHER_NONCE }),
    );
    const result = await recoverReservingStudyOperation(recoverInput(redis));
    expect(result.status).toBe('ambiguous');
    expect(redis.writes).toEqual([]);
    expect(parsePendingStudyOperationV2(redis.hashes.get('study-ops:v2')?.get(STUDY_ID))?.phase).toBe('reserving');
  });

  it('fails closed on a malformed lock or field', async () => {
    const malformedLock = new MemoryPlatformRedis();
    seedField(malformedLock);
    malformedLock.strings.set(`study-op-lock:${STUDY_ID}`, 'not-a-lock');
    expect((await recoverReservingStudyOperation(recoverInput(malformedLock))).status).toBe('unavailable');
    expect(malformedLock.writes).toEqual([]);

    const malformedField = new MemoryPlatformRedis();
    seedField(malformedField, 'oi:op:{"version":1}');
    expect((await recoverReservingStudyOperation(recoverInput(malformedField))).status).toBe('unavailable');
  });

  it('does not steal a mismatched owner and treats journal as unavailable', async () => {
    const mismatch = new MemoryPlatformRedis();
    seedField(mismatch);
    mismatch.strings.set(
      `study-owner:${STUDY_ID}`,
      encodeOwnerRecord({ version: 2, researcherId: OTHER, storageId: STORAGE_ID, generation: 1 }),
    );
    expect((await recoverReservingStudyOperation(recoverInput(mismatch))).status).toBe('ambiguous');
    expect(mismatch.writes).toEqual([]);

    const journaled = new MemoryPlatformRedis();
    seedField(journaled);
    journaled.hashes.set('account-delete-journal', new Map([[RESEARCHER, 'oi:adel-journal:{}']]));
    expect((await recoverReservingStudyOperation(recoverInput(journaled))).status).toBe('unavailable');
    expect(journaled.writes).toEqual([]);
  });

  it('decodes only recover family tags and maps commit ambiguity', async () => {
    expect(parseRecoverResult(['oi:recover-phase', 'pending'])).toEqual({
      status: 'ok',
      value: { outcome: 'phase', phase: 'pending' },
    });
    expect(parseRecoverResult(['oi:recover-wait']).status).toBe('ok');
    expect(parseRecoverResult(['oi:begin-started', 'x']).status).toBe('unavailable');
    expect(parseRecoverResult(['oi:recover-phase', 'nope']).status).toBe('unavailable');

    const redis = new MemoryPlatformRedis();
    seedField(redis);
    redis.evalError = new RedisCommitAmbiguousError('may-have-committed');
    expect((await recoverReservingStudyOperation(recoverInput(redis))).status).toBe('ambiguous');
    redis.evalError = new RedisCommitAmbiguousError('zero-write');
    expect((await recoverReservingStudyOperation(recoverInput(redis))).status).toBe('unavailable');
  });
});
