// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import { RedisCommitAmbiguousError } from '@/lib/redisPort';
import type { RedisPort } from '@/lib/redisPort';
import {
  CREATE_STUDY_SCRIPT,
  DELETE_EMPTY_STUDY_SCRIPT,
  createStudyAtomic,
  deleteStudy,
  encodeMutationGuard,
  encodeOperationReceipt,
  parseCreateDeleteResult,
  parseMutationGuard,
  parseOperationReceipt,
  settleStudyOperationMutation,
  standaloneCreateMarkerId,
  standaloneDeleteMarkerId,
  type StandaloneOperationReceipt,
} from '@/lib/kv';
import { makeStoredStudy } from '../fixtures/models';

const STUDY_ID = '11111111-1111-4111-8111-111111111111';
const CREATED_AT = 1_700_000_000_000;

function receipt(overrides: Partial<StandaloneOperationReceipt> = {}): StandaloneOperationReceipt {
  return {
    version: 2,
    studyId: STUDY_ID,
    kind: 'create',
    researcherId: 'standalone',
    resolution: 'created',
    markerId: standaloneCreateMarkerId(STUDY_ID, CREATED_AT)!,
    createdAt: CREATED_AT,
    generation: 1,
    idempotencyHash: null,
    ...overrides,
  };
}

class MemoryByosRedis {
  readonly strings = new Map<string, string>();
  readonly sets = new Map<string, Set<string>>();
  evalCalls = 0;
  writes: string[] = [];
  lastKeys: string[] = [];
  lastArgs: string[] = [];
  forcedEval: unknown | undefined;
  evalError: unknown | undefined;

  async get(key: string): Promise<string | null> {
    return this.strings.has(key) ? this.strings.get(key)! : null;
  }

  async set(key: string, value: string): Promise<string> {
    this.strings.set(key, value);
    this.writes.push(`SET ${key}`);
    return 'OK';
  }

  async exists(key: string): Promise<number> {
    return this.strings.has(key) ? 1 : 0;
  }

  async del(key: string): Promise<number> {
    const had = this.strings.delete(key) ? 1 : 0;
    this.writes.push(`DEL ${key}`);
    return had;
  }

  async sadd(key: string, member: string): Promise<number> {
    const set = this.sets.get(key) ?? new Set<string>();
    const added = set.has(member) ? 0 : 1;
    set.add(member);
    this.sets.set(key, set);
    this.writes.push(`SADD ${key}`);
    return added;
  }

  async srem(key: string, member: string): Promise<number> {
    const set = this.sets.get(key);
    const removed = set?.delete(member) ? 1 : 0;
    this.writes.push(`SREM ${key}`);
    return removed;
  }

  async scard(key: string): Promise<number> {
    return this.sets.get(key)?.size ?? 0;
  }

  async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    this.evalCalls += 1;
    this.lastKeys = keys;
    this.lastArgs = args;
    if (this.evalError) throw this.evalError;
    if (this.forcedEval !== undefined) return this.forcedEval;
    if (script.includes('fault cut S2')) return this.runCreate(keys, args);
    if (script.includes('fault cut D1')) return this.runDelete(keys, args);
    return this.runSettle(keys, args);
  }

  private receiptResolution(value: string | undefined): string | null {
    const parsed = value ? parseOperationReceipt(value) : null;
    return parsed?.resolution ?? null;
  }

  private runCreate(keys: string[], args: string[]): unknown {
    const hosted = args[5] === 'hosted' || keys.length === 4;
    const receiptKey = hosted ? keys[1] : keys[2];
    const guardKey = hosted ? keys[2] : keys[3];
    const persistKey = hosted ? keys[3] : keys[4];
    const indexKey = hosted ? null : keys[1];
    const existing = this.strings.get(receiptKey);
    if (existing) {
      const resolution = this.receiptResolution(existing);
      if (resolution === 'created') return ['oi:created'];
      if (resolution === 'cancelled') return ['oi:cancelled'];
      if (resolution === 'deleted') return ['oi:conflict', 'oi:revision:0'];
      return ['oi:byos-unavailable'];
    }
    const createGuard = parseMutationGuard(this.strings.get(guardKey));
    if (this.strings.has(guardKey) && !createGuard) return ['oi:byos-unavailable'];
    if (createGuard?.state === 'cancelled') return ['oi:cancelled'];
    if (createGuard?.state === 'deleted' || (createGuard?.state === 'in-flight' && createGuard.kind === 'delete')) {
      return ['oi:conflict', 'oi:revision:0'];
    }
    if ((this.sets.get(persistKey)?.size ?? 0) > 0) return ['oi:still-pending'];
    if (this.strings.has(keys[0])) {
      // Mirror CREATE_STUDY_SCRIPT dual-read: the stored body equals the
      // prefixed ARGV or its legacy unprefixed form.
      const storedBody = this.strings.get(keys[0]);
      const legacy = typeof args[0] === 'string' ? args[0].slice('oi:study:'.length) : args[0];
      if (storedBody !== args[0] && storedBody !== legacy) return ['oi:conflict', 'oi:revision:0'];
      if (indexKey) {
        this.sets.get(indexKey) ?? this.sets.set(indexKey, new Set());
        this.sets.get(indexKey)!.add(args[1]);
      }
      this.strings.set(receiptKey, args[3]);
      this.strings.set(guardKey, args[4]);
      this.writes.push('W2-repair');
      return ['oi:created'];
    }
    this.strings.set(keys[0], args[0]);
    this.writes.push('S2');
    if (indexKey) {
      const index = this.sets.get(indexKey) ?? new Set<string>();
      index.add(args[1]);
      this.sets.set(indexKey, index);
      this.writes.push('S3');
    }
    this.strings.set(receiptKey, args[3]);
    this.writes.push('S4');
    this.strings.set(guardKey, args[4]);
    return ['oi:created'];
  }

  private runDelete(keys: string[], args: string[]): unknown {
    const hosted = args[5] === 'hosted' || keys.length === 5;
    const receiptKey = hosted ? keys[2] : keys[3];
    const guardKey = hosted ? keys[3] : keys[4];
    const persistKey = hosted ? keys[4] : keys[5];
    const indexKey = hosted ? null : keys[2];
    const existing = this.strings.get(receiptKey);
    if (existing) {
      const resolution = this.receiptResolution(existing);
      if (resolution === 'deleted' || resolution === 'cancelled') {
        const leftover = parseMutationGuard(this.strings.get(guardKey));
        if (leftover && leftover.markerId === args[1] && String(leftover.generation) === args[4]) {
          this.strings.delete(guardKey);
          this.writes.push('guard-cleanup');
        }
        return resolution === 'deleted' ? ['oi:deleted'] : ['oi:cancelled'];
      }
      if (resolution !== 'created') return ['oi:byos-unavailable'];
    }
    if ((this.sets.get(persistKey)?.size ?? 0) > 0) return ['oi:still-pending'];
    this.strings.set(guardKey, args[3]);
    this.writes.push('D1');
    if ((this.sets.get(keys[1])?.size ?? 0) > 0) return ['oi:conflict', 'oi:revision:0'];
    if (!this.strings.has(keys[0])) {
      if (indexKey) this.sets.get(indexKey)?.delete(args[0]);
      this.strings.set(receiptKey, args[2]);
      this.strings.delete(guardKey);
      return ['oi:deleted'];
    }
    this.strings.delete(keys[0]);
    this.writes.push('D2');
    if (indexKey) {
      this.sets.get(indexKey)?.delete(args[0]);
      this.writes.push('D3');
    }
    this.strings.set(receiptKey, args[2]);
    this.writes.push('D4');
    this.strings.delete(guardKey);
    return ['oi:deleted'];
  }

  private runSettle(keys: string[], args: string[]): unknown {
    const resolution = this.receiptResolution(this.strings.get(keys[1]));
    const exists = this.strings.has(keys[0]);
    if (args[0] === 'create') {
      if (resolution === 'created' || exists) {
        this.strings.set(keys[1], args[1]);
        this.strings.set(keys[2], args[3]);
        return ['oi:created'];
      }
      this.strings.set(keys[1], args[2]);
      this.strings.set(keys[2], args[4]);
      return ['oi:cancelled'];
    }
    if (resolution === 'deleted' || !exists) {
      this.strings.set(keys[1], args[1]);
      this.strings.set(keys[2], args[3]);
      return ['oi:deleted'];
    }
    this.strings.set(keys[1], args[2]);
    this.strings.set(keys[2], args[4]);
    return ['oi:cancelled'];
  }
}

function asPort(memory: MemoryByosRedis): RedisPort {
  return memory as unknown as RedisPort;
}

function study() {
  return makeStoredStudy({
    id: STUDY_ID,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    config: {
      ...makeStoredStudy().config,
      id: STUDY_ID,
      createdAt: CREATED_AT,
    },
  });
}

describe('create/delete closed-wire parsers', () => {
  it('accepts family tags for created/deleted/cancelled/still-pending/conflict', () => {
    expect(parseCreateDeleteResult(['oi:created'])).toEqual({ status: 'ok', value: { outcome: 'created' } });
    expect(parseCreateDeleteResult(['oi:deleted'])).toEqual({ status: 'ok', value: { outcome: 'deleted' } });
    expect(parseCreateDeleteResult(['oi:cancelled'])).toEqual({ status: 'ok', value: { outcome: 'cancelled' } });
    expect(parseCreateDeleteResult(['oi:still-pending'])).toEqual({
      status: 'ok',
      value: { outcome: 'still-pending' },
    });
    expect(parseCreateDeleteResult(['oi:conflict', 'oi:revision:0'])).toEqual({
      status: 'ok',
      value: { outcome: 'conflict', revision: 0 },
    });
  });

  it('fails closed on malformed, truncated, extra, coerced, and foreign wires', () => {
    const bad = [
      null,
      1,
      'oi:created',
      [],
      ['oi:created', 'x'],
      ['oi:deleted', 'x'],
      ['oi:conflict'],
      ['oi:conflict', 0],
      ['oi:conflict', 'oi:revision:1.5'],
      ['oi:idemp-started', 'x'],
      ['oi:receipt-unavailable'],
      ['oi:updated', 'oi:json:{"ok":true}'],
      ['oi:byos-unavailable'],
    ];
    for (const wire of bad) {
      expect(parseCreateDeleteResult(wire).status, JSON.stringify(wire)).toBe('unavailable');
    }
  });

  it('rejects bare and coerced receipt leaves', () => {
    expect(parseOperationReceipt('created')).toBeNull();
    expect(parseOperationReceipt({ resolution: 'created' })).toBeNull();
    expect(parseOperationReceipt(encodeOperationReceipt(receipt({ version: 1 as 2 })))).toBeNull();
    expect(parseOperationReceipt(encodeOperationReceipt(receipt()))).toMatchObject({
      resolution: 'created',
      studyId: STUDY_ID,
    });
  });
});

describe('standalone create/delete receipts', () => {
  it('replays a terminal create receipt without eval (S4 / response-loss)', async () => {
    const memory = new MemoryByosRedis();
    const marker = standaloneCreateMarkerId(STUDY_ID, CREATED_AT)!;
    memory.strings.set(`study-operation-result:${marker}`, encodeOperationReceipt(receipt()));

    await expect(createStudyAtomic(study(), asPort(memory), marker)).resolves.toBe('created');
    expect(memory.evalCalls).toBe(0);
  });

  it('replays the same created result after a may-have-committed eval', async () => {
    const memory = new MemoryByosRedis();
    const stored = study();
    memory.evalError = new RedisCommitAmbiguousError('may-have-committed');
    await expect(createStudyAtomic(stored, asPort(memory))).resolves.toBe('ambiguous');

    memory.evalError = undefined;
    const first = await createStudyAtomic(stored, asPort(memory));
    const second = await createStudyAtomic(stored, asPort(memory));
    expect(first).toBe('created');
    expect(second).toBe('created');
    expect(memory.evalCalls).toBe(2);
  });

  it('repairs W2 (study present, receipt missing) as created, not conflict', async () => {
    // Regression for review P1-2: CREATE_STUDY_SCRIPT must dual-read a legacy
    // unprefixed body of the same study instead of reporting conflict.
    const memory = new MemoryByosRedis();
    const stored = study();
    memory.strings.set(`study:${STUDY_ID}`, JSON.stringify(stored));

    await expect(createStudyAtomic(stored, asPort(memory))).resolves.toBe('created');
    const marker = standaloneCreateMarkerId(STUDY_ID, CREATED_AT)!;
    expect(parseOperationReceipt(memory.strings.get(`study-operation-result:${marker}`))).toMatchObject({
      resolution: 'created',
    });
    expect(memory.writes).toContain('W2-repair');
  });

  it('repairs W2 when the stored body is already oi:study:-prefixed', async () => {
    // New-writer form: a crash after the body SET but before the receipt SET
    // must repair as created, keeping the prefixed body untouched.
    const memory = new MemoryByosRedis();
    const stored = study();
    memory.strings.set(`study:${STUDY_ID}`, `oi:study:${JSON.stringify(stored)}`);

    await expect(createStudyAtomic(stored, asPort(memory))).resolves.toBe('created');
    const marker = standaloneCreateMarkerId(STUDY_ID, CREATED_AT)!;
    expect(parseOperationReceipt(memory.strings.get(`study-operation-result:${marker}`))).toMatchObject({
      resolution: 'created',
    });
    expect(memory.strings.get(`study:${STUDY_ID}`)).toBe(`oi:study:${JSON.stringify(stored)}`);
  });

  it('writes study then index then receipt (S1-S4 order)', async () => {
    const memory = new MemoryByosRedis();
    await createStudyAtomic(study(), asPort(memory));
    expect(memory.writes.filter((item) => item === 'S2' || item === 'S3' || item === 'S4')).toEqual([
      'S2',
      'S3',
      'S4',
    ]);
    expect(CREATE_STUDY_SCRIPT.indexOf('fault cut S2'))
      .toBeLessThan(CREATE_STUDY_SCRIPT.indexOf('fault cut S3'));
    expect(CREATE_STUDY_SCRIPT.indexOf('fault cut S3'))
      .toBeLessThan(CREATE_STUDY_SCRIPT.indexOf('fault cut S4'));
  });

  it('returns conflict when an existing study body does not match', async () => {
    const memory = new MemoryByosRedis();
    memory.strings.set(`study:${STUDY_ID}`, '{"id":"other"}');
    await expect(createStudyAtomic(study(), asPort(memory))).resolves.toBe('conflict');
  });

  it('fails closed on malformed GET receipt and does not eval', async () => {
    const memory = new MemoryByosRedis();
    const marker = standaloneCreateMarkerId(STUDY_ID, CREATED_AT)!;
    memory.strings.set(`study-operation-result:${marker}`, 'created');
    await expect(createStudyAtomic(study(), asPort(memory), marker)).resolves.toBe('unavailable');
    expect(memory.evalCalls).toBe(0);
  });

  it('fails closed on malformed eval wire with no further writes', async () => {
    const memory = new MemoryByosRedis();
    memory.forcedEval = ['oi:created', 'extra'];
    const before = memory.writes.length;
    await expect(createStudyAtomic(study(), asPort(memory))).resolves.toBe('unavailable');
    expect(memory.writes.length).toBe(before);
  });

  it('classifies zero-write transport errors as unavailable', async () => {
    const memory = new MemoryByosRedis();
    memory.evalError = new RedisCommitAmbiguousError('zero-write');
    await expect(createStudyAtomic(study(), asPort(memory))).resolves.toBe('unavailable');
  });

  it('omits the all-studies key on hosted create and still writes the receipt', async () => {
    const previous = process.env.DEPLOYMENT_MODE;
    process.env.DEPLOYMENT_MODE = 'hosted';
    try {
      const memory = new MemoryByosRedis();
      await expect(createStudyAtomic(study(), asPort(memory))).resolves.toBe('created');
      expect(memory.lastKeys).toEqual([
        `study:${STUDY_ID}`,
        `study-operation-result:create:${STUDY_ID}:${CREATED_AT}`,
        `study-mutation-guard:${STUDY_ID}`,
        `study-persisting:${STUDY_ID}`,
      ]);
      expect(memory.lastKeys).not.toContain('all-studies');
      expect(memory.lastArgs[5]).toBe('hosted');
      expect(memory.sets.has('all-studies')).toBe(false);
      expect(memory.writes).toEqual(['S2', 'S4']);
    } finally {
      if (previous === undefined) delete process.env.DEPLOYMENT_MODE;
      else process.env.DEPLOYMENT_MODE = previous;
    }
  });
});

describe('standalone delete receipts and persist-guard', () => {
  it('replays a terminal delete receipt without eval (D4 / response-loss)', async () => {
    const memory = new MemoryByosRedis();
    const marker = standaloneDeleteMarkerId(STUDY_ID)!;
    memory.strings.set(
      `study-operation-result:${marker}`,
      encodeOperationReceipt(receipt({ kind: 'delete', resolution: 'deleted', markerId: marker, createdAt: 0 })),
    );
    await expect(deleteStudy(STUDY_ID, asPort(memory), marker)).resolves.toEqual({
      status: 'deleted',
      success: true,
    });
    expect(memory.evalCalls).toBe(0);
  });

  it('returns the same deleted result after response-loss then replay', async () => {
    const memory = new MemoryByosRedis();
    memory.strings.set(`study:${STUDY_ID}`, JSON.stringify(study()));
    memory.evalError = new RedisCommitAmbiguousError('may-have-committed');
    await expect(deleteStudy(STUDY_ID, asPort(memory))).resolves.toMatchObject({
      status: 'ambiguous',
      reason: 'ambiguous',
    });
    memory.evalError = undefined;
    await expect(deleteStudy(STUDY_ID, asPort(memory))).resolves.toEqual({
      status: 'deleted',
      success: true,
    });
    await expect(deleteStudy(STUDY_ID, asPort(memory))).resolves.toEqual({
      status: 'deleted',
      success: true,
    });
  });

  it('refuses delete while study-persisting is nonempty (before EXISTS/SCARD study)', async () => {
    const memory = new MemoryByosRedis();
    memory.strings.set(`study:${STUDY_ID}`, JSON.stringify(study()));
    memory.sets.set(`study-persisting:${STUDY_ID}`, new Set(['interview-1']));
    await expect(deleteStudy(STUDY_ID, asPort(memory))).resolves.toMatchObject({
      status: 'still-pending',
      code: 'STUDY_PERSIST_PENDING',
    });
    expect(memory.strings.has(`study:${STUDY_ID}`)).toBe(true);
    expect(DELETE_EMPTY_STUDY_SCRIPT.indexOf("redis.call('SCARD', KEYS[6])"))
      .toBeLessThan(DELETE_EMPTY_STUDY_SCRIPT.indexOf("redis.call('EXISTS', KEYS[1])"));
  });

  it('deletes a missing body only when interview and persisting sets are empty', async () => {
    const memory = new MemoryByosRedis();
    await expect(deleteStudy(STUDY_ID, asPort(memory))).resolves.toEqual({
      status: 'deleted',
      success: true,
    });
  });

  it('conflicts when interviews exist', async () => {
    const memory = new MemoryByosRedis();
    memory.strings.set(`study:${STUDY_ID}`, JSON.stringify(study()));
    memory.sets.set(`study-interviews:${STUDY_ID}`, new Set(['iv-1']));
    await expect(deleteStudy(STUDY_ID, asPort(memory))).resolves.toMatchObject({
      status: 'conflict',
      error: 'Cannot delete study with existing interviews',
    });
  });

  it('cleans a leftover same-generation guard after a terminal delete receipt (D4 recover)', async () => {
    const memory = new MemoryByosRedis();
    const marker = standaloneDeleteMarkerId(STUDY_ID)!;
    memory.strings.set(
      `study-operation-result:${marker}`,
      encodeOperationReceipt(receipt({ kind: 'delete', resolution: 'deleted', markerId: marker, createdAt: 0 })),
    );
    memory.strings.set(
      `study-mutation-guard:${STUDY_ID}`,
      encodeMutationGuard({
        version: 2,
        studyId: STUDY_ID,
        kind: 'delete',
        generation: 1,
        state: 'in-flight',
        markerId: marker,
      }),
    );

    await expect(deleteStudy(STUDY_ID, asPort(memory), marker)).resolves.toEqual({
      status: 'deleted',
      success: true,
    });
    expect(memory.evalCalls).toBe(1);
    expect(memory.strings.has(`study-mutation-guard:${STUDY_ID}`)).toBe(false);
    expect(memory.writes).toContain('guard-cleanup');
  });

  it('preserves a successor mutation guard when replaying a terminal delete receipt', async () => {
    const memory = new MemoryByosRedis();
    const marker = standaloneDeleteMarkerId(STUDY_ID)!;
    const successor = encodeMutationGuard({
      version: 2,
      studyId: STUDY_ID,
      kind: 'create',
      generation: 2,
      state: 'created',
      markerId: `create:${STUDY_ID}:99`,
    });
    memory.strings.set(
      `study-operation-result:${marker}`,
      encodeOperationReceipt(receipt({ kind: 'delete', resolution: 'deleted', markerId: marker, createdAt: 0 })),
    );
    memory.strings.set(`study-mutation-guard:${STUDY_ID}`, successor);

    await expect(deleteStudy(STUDY_ID, asPort(memory), marker)).resolves.toEqual({
      status: 'deleted',
      success: true,
    });
    expect(memory.evalCalls).toBe(0);
    expect(memory.strings.get(`study-mutation-guard:${STUDY_ID}`)).toBe(successor);
  });

  it('refuses create when a delete mutation guard is still in-flight or deleted', async () => {
    const memory = new MemoryByosRedis();
    memory.strings.set(
      `study-mutation-guard:${STUDY_ID}`,
      encodeMutationGuard({
        version: 2,
        studyId: STUDY_ID,
        kind: 'delete',
        generation: 1,
        state: 'in-flight',
        markerId: standaloneDeleteMarkerId(STUDY_ID)!,
      }),
    );
    await expect(createStudyAtomic(study(), asPort(memory))).resolves.toBe('conflict');
    expect(memory.strings.has(`study:${STUDY_ID}`)).toBe(false);

    memory.strings.set(
      `study-mutation-guard:${STUDY_ID}`,
      encodeMutationGuard({
        version: 2,
        studyId: STUDY_ID,
        kind: 'delete',
        generation: 1,
        state: 'deleted',
        markerId: standaloneDeleteMarkerId(STUDY_ID)!,
      }),
    );
    await expect(createStudyAtomic(study(), asPort(memory))).resolves.toBe('conflict');
    expect(CREATE_STUDY_SCRIPT).toContain("obj.state == 'deleted'");
  });

  it('writes guard, study DEL, SREM, receipt, then cleans this-generation guard', async () => {
    const memory = new MemoryByosRedis();
    memory.strings.set(`study:${STUDY_ID}`, JSON.stringify(study()));
    memory.sets.set('all-studies', new Set([STUDY_ID]));
    await deleteStudy(STUDY_ID, asPort(memory));
    expect(memory.writes.filter((item) => ['D1', 'D2', 'D3', 'D4'].includes(item))).toEqual([
      'D1',
      'D2',
      'D3',
      'D4',
    ]);
    expect(memory.strings.has(`study-mutation-guard:${STUDY_ID}`)).toBe(false);
    expect(DELETE_EMPTY_STUDY_SCRIPT.indexOf('fault cut D1'))
      .toBeLessThan(DELETE_EMPTY_STUDY_SCRIPT.indexOf('fault cut D2'));
    expect(DELETE_EMPTY_STUDY_SCRIPT).toContain('same_generation_guard(guard)');
    expect(DELETE_EMPTY_STUDY_SCRIPT.indexOf('fault cut D4'))
      .toBeLessThan(DELETE_EMPTY_STUDY_SCRIPT.lastIndexOf('cleanup_this_generation()'));
  });

  it('fails closed on a malformed delete eval wire', async () => {
    const memory = new MemoryByosRedis();
    memory.forcedEval = { deleted: true };
    await expect(deleteStudy(STUDY_ID, asPort(memory))).resolves.toMatchObject({
      status: 'unavailable',
    });
  });

  it('omits the all-studies key on hosted delete and still writes the receipt', async () => {
    const previous = process.env.DEPLOYMENT_MODE;
    process.env.DEPLOYMENT_MODE = 'hosted';
    try {
      const memory = new MemoryByosRedis();
      memory.strings.set(`study:${STUDY_ID}`, JSON.stringify(study()));
      memory.sets.set('all-studies', new Set([STUDY_ID]));
      await expect(deleteStudy(STUDY_ID, asPort(memory))).resolves.toEqual({
        status: 'deleted',
        success: true,
      });
      expect(memory.lastKeys).toEqual([
        `study:${STUDY_ID}`,
        `study-interviews:${STUDY_ID}`,
        `study-operation-result:delete:${STUDY_ID}:0`,
        `study-mutation-guard:${STUDY_ID}`,
        `study-persisting:${STUDY_ID}`,
        `study-aggregate:${STUDY_ID}`,
      ]);
      expect(memory.lastKeys).not.toContain('all-studies');
      expect(memory.lastArgs[5]).toBe('hosted');
      expect(memory.sets.get('all-studies')?.has(STUDY_ID)).toBe(true);
      expect(memory.writes.filter((item) => ['D1', 'D2', 'D3', 'D4'].includes(item))).toEqual([
        'D1',
        'D2',
        'D4',
      ]);
    } finally {
      if (previous === undefined) delete process.env.DEPLOYMENT_MODE;
      else process.env.DEPLOYMENT_MODE = previous;
    }
  });

  it('settle writes oi:receipt: / oi:smg: never a bare cancelled string', async () => {
    const memory = new MemoryByosRedis();
    memory.strings.set(`study:${STUDY_ID}`, JSON.stringify(study()));
    await expect(settleStudyOperationMutation(
      'delete',
      STUDY_ID,
      'delete:study:1',
      asPort(memory),
    )).resolves.toBe('mutation-cancelled');
    const marker = memory.strings.get('study-operation-result:delete:study:1');
    expect(marker?.startsWith('oi:receipt:')).toBe(true);
    expect(marker).not.toBe('cancelled');
    expect(memory.strings.get(`study-mutation-guard:${STUDY_ID}`)?.startsWith('oi:smg:')).toBe(true);
    expect(encodeMutationGuard({
      version: 2,
      studyId: STUDY_ID,
      kind: 'delete',
      generation: 1,
      state: 'cancelled',
      markerId: 'delete:study:1',
    }).startsWith('oi:smg:')).toBe(true);
  });
});
