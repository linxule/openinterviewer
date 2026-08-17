// In-memory RedisPort for hosted begin/recover/resolve/publish unit tests.
// Mirrors Revision 12 §8.1–§8.5 command order; production still uses the Lua
// scripts.

import { parseLockValue, parsePrefixedJson } from '@/lib/wire/parse';
import { parsePendingStudyOperationV2 } from '@/lib/platformDb.operations';
import {
  interpretAccountDeleteApply,
  interpretAccountDeletePersist,
} from '@/lib/platformDb.accountDelete';
import type { RedisPort } from '@/lib/redisPort';

export class MemoryPlatformRedis {
  readonly strings = new Map<string, string>();
  readonly hashes = new Map<string, Map<string, string>>();
  readonly sets = new Map<string, Set<string>>();
  readonly zsets = new Map<string, Map<string, number>>();
  writes: string[] = [];
  forcedEval: unknown | undefined;
  evalError: unknown | undefined;
  evalCalls = 0;

  async get(key: string): Promise<string | null> {
    return this.strings.has(key) ? this.strings.get(key)! : null;
  }

  async set(key: string, value: string, opts?: { nx?: boolean }): Promise<string | null> {
    if (opts?.nx && this.strings.has(key)) return null;
    this.strings.set(key, value);
    this.writes.push(`SET ${key}`);
    return 'OK';
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    const added = hash.has(field) ? 0 : 1;
    hash.set(field, value);
    this.hashes.set(key, hash);
    this.writes.push(`HSET ${key} ${field}`);
    return added;
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    let removed = 0;
    for (const field of fields) {
      if (this.hashes.get(key)?.delete(field)) removed += 1;
      this.writes.push(`HDEL ${key} ${field}`);
    }
    return removed;
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.strings.delete(key)) removed += 1;
      if (this.hashes.delete(key)) removed += 1;
      if (this.sets.delete(key)) removed += 1;
      if (this.zsets.delete(key)) removed += 1;
      this.writes.push(`DEL ${key}`);
    }
    return removed;
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? new Set<string>())];
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key);
    let removed = 0;
    for (const member of members) {
      if (set?.delete(member)) removed += 1;
      this.writes.push(`SREM ${key}`);
    }
    return removed;
  }

  async zcard(key: string): Promise<number> {
    return this.zsets.get(key)?.size ?? 0;
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    const zset = this.zsets.get(key);
    let removed = 0;
    for (const member of members) {
      if (zset?.delete(member)) removed += 1;
      this.writes.push(`ZREM ${key}`);
    }
    return removed;
  }

  async hlen(key: string): Promise<number> {
    return this.hashes.get(key)?.size ?? 0;
  }

  async hexists(key: string, field: string): Promise<number> {
    return this.hashes.get(key)?.has(field) ? 1 : 0;
  }

  async sadd(key: string, member: string): Promise<number> {
    const set = this.sets.get(key) ?? new Set<string>();
    const added = set.has(member) ? 0 : 1;
    set.add(member);
    this.sets.set(key, set);
    this.writes.push(`SADD ${key}`);
    return added;
  }

  async scard(key: string): Promise<number> {
    return this.sets.get(key)?.size ?? 0;
  }

  async sismember(key: string, member: string): Promise<number> {
    return this.sets.get(key)?.has(member) ? 1 : 0;
  }

  async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    this.evalCalls += 1;
    if (this.evalError) throw this.evalError;
    if (this.forcedEval !== undefined) return this.forcedEval;
    if (script.includes('-- adel-zrange')) {
      return [...(this.zsets.get(keys[0])?.keys() ?? [])];
    }
    if (script.includes('-- adel-persist')) {
      return interpretAccountDeletePersist(this, keys, args);
    }
    if (script.includes('-- adel-apply')) {
      return interpretAccountDeleteApply(this, keys, args);
    }
    if (script.includes('-- hosted-link-create')) return this.runHostedLinkCreate(keys, args);
    if (script.includes('-- hosted-link-list')) return this.runHostedLinkList(keys, args);
    if (script.includes('-- hosted-link-revoke')) return this.runHostedLinkRevoke(keys, args);
    if (script.includes('-- hosted-link-exchange')) return this.runHostedLinkExchange(keys, args);
    if (script.includes('-- authority (no writes)')) return this.runAuthority(keys, args);
    if (script.includes('fault cut R1')) return this.runBegin(keys, args);
    if (script.includes('fault cut resolve')) return this.runResolve(keys, args);
    if (script.includes('fault cut PUB1')) return this.runPublish(keys, args);
    if (script.includes("op.phase ~= 'reserving'")) return this.runRecover(keys, args);
    throw new Error('unknown script');
  }

  asPort(): RedisPort {
    return this as unknown as RedisPort;
  }

  private runAuthority(keys: string[], args: string[]): unknown {
    const [caller, studyId, purpose, researcherPrefix, studiesPrefix, storagePrefix, reversePrefix] = args;
    if (
      purpose !== 'read' && purpose !== 'mutate-config' && purpose !== 'link'
      && purpose !== 'preview' && purpose !== 'new-persist'
      && purpose !== 'persist-repair' && purpose !== 'delete'
    ) {
      return ['oi:authz-unavailable'];
    }

    const lineage = this.parsePrefixed(this.strings.get(keys[4]), 'oi:lineage:');
    if (!lineage || lineage.version !== 2 || lineage.authority !== 'v2' || lineage.operations !== 'hash-v2') {
      return ['oi:authz-hold'];
    }

    if (caller !== '' && this.hashes.get(keys[0])?.has(caller)) {
      return ['oi:authz-adel'];
    }

    if (caller !== '') {
      const account = this.parsePrefixed(this.strings.get(`${researcherPrefix}${caller}`), 'oi:account:');
      if (!account || account.id !== caller) return ['oi:authz-noacct'];
    }

    const ownerRaw = this.strings.get(keys[1]);
    let owner: Record<string, unknown> | null = null;
    if (ownerRaw) {
      owner = this.parsePrefixed(ownerRaw, 'oi:owner:');
      if (!owner || typeof owner.researcherId !== 'string' || typeof owner.storageId !== 'string') {
        return ['oi:authz-unavailable'];
      }
      if (this.hashes.get(keys[0])?.has(owner.researcherId)) return ['oi:authz-adel'];
      if (!this.sets.get(`${studiesPrefix}${owner.researcherId}`)?.has(studyId)) {
        return ['oi:authz-corrupt'];
      }
      const storage = this.parsePrefixed(
        this.strings.get(`${storagePrefix}${owner.researcherId}`),
        'oi:storage:',
      );
      if (!storage) return ['oi:authz-unavailable'];
      if (storage.researcherId !== owner.researcherId || storage.storageId !== owner.storageId) {
        return ['oi:authz-mismatch'];
      }
      if (!this.sets.get(`${reversePrefix}${owner.storageId}`)?.has(owner.researcherId)) {
        return ['oi:authz-corrupt'];
      }
      if (caller !== '' && owner.researcherId !== caller) return ['oi:authz-deny'];
    }

    const field = this.hashes.get(keys[2])?.get(studyId);
    let liveKind: string | null = null;
    let livePhase: string | null = null;
    if (field) {
      const op = this.parsePrefixed(field, 'oi:op:');
      if (!op) return ['oi:authz-unavailable'];
      if (op.phase !== 'reserving' && op.phase !== 'pending' && op.phase !== 'resolving' && op.phase !== 'publishing') {
        return ['oi:authz-unavailable'];
      }
      if (op.studyId !== studyId) return ['oi:authz-corrupt'];
      if (op.kind !== 'create' && op.kind !== 'delete') return ['oi:authz-unavailable'];
      liveKind = String(op.kind);
      livePhase = String(op.phase);
    } else {
      const lockRaw = this.strings.get(keys[3]);
      if (lockRaw) {
        const lock = parseLockValue(lockRaw);
        if (!lock) return ['oi:authz-unavailable'];
        liveKind = lock.kind;
        livePhase = 'reserving';
      }
    }

    if (liveKind) {
      const allowLiveDelete = liveKind === 'delete' && (purpose === 'persist-repair' || purpose === 'delete');
      if (liveKind === 'create' || !allowLiveDelete) {
        return ['oi:authz-live', livePhase];
      }
    }

    if (!owner || !ownerRaw) return ['oi:authz-notfound'];
    return ['oi:authz-allow', ownerRaw];
  }

  private parsePrefixed(value: unknown, prefix: string): Record<string, unknown> | null {
    const parsed = parsePrefixedJson(value, prefix);
    return parsed.ok ? parsed.payload : null;
  }

  private encodeOp(operation: Record<string, unknown>): string {
    return `oi:op:${JSON.stringify(operation)}`;
  }

  private runBegin(keys: string[], args: string[]): unknown {
    const [researcherId, studyId, storageId, kind, generation, opNonce, prefixedOp, prefixedOwner, now, maxOps, maxStudies, bindingEpoch] = args;
    const lineage = this.parsePrefixed(this.strings.get(keys[8]), 'oi:lineage:');
    if (!lineage || lineage.version !== 2 || lineage.authority !== 'v2' || lineage.operations !== 'hash-v2') {
      return ['oi:begin-hold'];
    }
    if (this.hashes.get(keys[7])?.has(researcherId)) return ['oi:begin-adel'];
    const account = this.parsePrefixed(this.strings.get(keys[4]), 'oi:account:');
    if (!account || account.id !== researcherId) return ['oi:begin-noacct'];
    const storage = this.parsePrefixed(this.strings.get(keys[5]), 'oi:storage:');
    if (
      !storage
      || storage.researcherId !== researcherId
      || storage.storageId !== storageId
      || Number(storage.bindingEpoch) !== Number(bindingEpoch)
    ) {
      return ['oi:begin-bind'];
    }
    if (!this.sets.get(keys[6])?.has(researcherId)) return ['oi:begin-bind'];

    const existing = this.hashes.get(keys[0])?.get(studyId);
    if (!existing && (this.hashes.get(keys[0])?.size ?? 0) >= Number(maxOps)) {
      return ['oi:begin-opquota'];
    }
    const incoming = this.parsePrefixed(prefixedOp, 'oi:op:');
    if (!incoming) return ['oi:begin-unavailable'];
    if (existing) {
      const op = parsePendingStudyOperationV2(existing);
      if (!op) return ['oi:begin-unavailable'];
      if (
        op.researcherId === researcherId
        && op.generation === Number(generation)
        && op.kind === kind
        && op.idempotencyHash === (incoming.idempotencyHash ?? null)
      ) {
        return ['oi:begin-replay', existing];
      }
      return ['oi:begin-live'];
    }

    const lockRaw = this.strings.get(keys[1]);
    if (lockRaw) {
      const lock = parseLockValue(lockRaw);
      if (!lock) return ['oi:begin-unavailable'];
      if (lock.generation !== Number(generation)) return ['oi:begin-live'];
    }

    if (kind === 'create') {
      if (!this.strings.get(keys[2]) && (this.sets.get(keys[3])?.size ?? 0) >= Number(maxStudies)) {
        return ['oi:begin-studyquota'];
      }
    } else if (kind === 'delete') {
      const ownerRaw = this.strings.get(keys[2]);
      if (!ownerRaw) return ['oi:begin-notfound'];
      const owner = this.parsePrefixed(ownerRaw, 'oi:owner:');
      if (!owner) return ['oi:begin-unavailable'];
      if (owner.researcherId !== researcherId || owner.storageId !== storageId) return ['oi:begin-owner'];
    } else {
      return ['oi:begin-unavailable'];
    }

    incoming.phase = 'reserving';
    incoming.updatedAt = Number(now);
    const reservingHash = this.hashes.get(keys[0]) ?? new Map<string, string>();
    reservingHash.set(studyId, this.encodeOp(incoming));
    this.hashes.set(keys[0], reservingHash);
    this.writes.push('R1');

    if (kind === 'create') {
      if (!this.strings.has(keys[2])) {
        this.strings.set(keys[2], prefixedOwner);
        this.writes.push('R2');
      } else {
        const existingOwner = this.parsePrefixed(this.strings.get(keys[2]), 'oi:owner:');
        if (!existingOwner) return ['oi:begin-unavailable'];
        if (existingOwner.researcherId !== researcherId || existingOwner.storageId !== storageId) {
          return ['oi:begin-owner'];
        }
      }
      const studies = this.sets.get(keys[3]) ?? new Set<string>();
      studies.add(studyId);
      this.sets.set(keys[3], studies);
      this.writes.push('R3');
    }

    this.strings.set(keys[1], `oi:lock:${generation}:${researcherId}:${kind}:${opNonce}`);
    this.writes.push('R4');
    incoming.phase = 'pending';
    incoming.updatedAt = Number(now);
    const pending = this.encodeOp(incoming);
    reservingHash.set(studyId, pending);
    return ['oi:begin-started', pending];
  }

  private runRecover(keys: string[], args: string[]): unknown {
    const [studyId, researcherId, generation, kind, opNonce, now, graceMs] = args;
    const field = this.hashes.get(keys[0])?.get(studyId);
    const op = parsePendingStudyOperationV2(field);
    if (!op) return ['oi:recover-unavailable'];
    if (op.phase !== 'reserving') return ['oi:recover-phase', op.phase];
    if (this.hashes.get(keys[4])?.has(researcherId)) return ['oi:recover-unavailable'];
    if (
      op.studyId !== studyId
      || op.researcherId !== researcherId
      || op.generation !== Number(generation)
      || op.kind !== kind
    ) {
      return ['oi:recover-unavailable'];
    }

    const installPending = () => {
      const next = { ...op, phase: 'pending' as const, updatedAt: Number(now) };
      const hash = this.hashes.get(keys[0]) ?? new Map<string, string>();
      hash.set(studyId, `oi:op:${JSON.stringify(next)}`);
      this.hashes.set(keys[0], hash);
      this.writes.push('HSET pending');
      return ['oi:recover-phase', 'pending'];
    };

    const lockRaw = this.strings.get(keys[1]);
    if (lockRaw) {
      const lock = parseLockValue(lockRaw);
      if (!lock) return ['oi:recover-unavailable'];
      if (lock.generation === Number(generation)) return installPending();
      return ['oi:recover-ambiguous'];
    }

    const ownerRaw = this.strings.get(keys[2]);
    if (!ownerRaw) {
      if (Number(now) - op.createdAt < Number(graceMs)) return ['oi:recover-wait'];
      this.hashes.get(keys[0])?.delete(studyId);
      this.writes.push('HDEL');
      return ['oi:recover-phase', 'reserving'];
    }
    const owner = this.parsePrefixed(ownerRaw, 'oi:owner:');
    if (!owner) return ['oi:recover-unavailable'];
    if (owner.researcherId === researcherId && this.sets.get(keys[3])?.has(studyId)) {
      this.strings.set(keys[1], `oi:lock:${generation}:${researcherId}:${kind}:${opNonce}`);
      this.writes.push('SET lock');
      return installPending();
    }
    return ['oi:recover-ambiguous'];
  }

  private exactLock(
    lock: { generation: number; researcherId: string; kind: string; opNonce: string } | null,
    generation: number,
    researcherId: string,
    kind: string,
    opNonce: string,
  ): boolean {
    return !!lock
      && lock.generation === generation
      && lock.researcherId === researcherId
      && lock.kind === kind
      && lock.opNonce === opNonce;
  }

  private runResolve(keys: string[], args: string[]): unknown {
    const [studyId, researcherId, storageId, generationRaw, kind, opNonce, resolution, now, prefixedReceipt] = args;
    const generation = Number(generationRaw);
    if (
      resolution !== 'create-complete'
      && resolution !== 'create-rollback'
      && resolution !== 'delete-complete'
      && resolution !== 'delete-rollback'
    ) {
      return ['oi:resolve-unavailable'];
    }
    if (!resolution.startsWith(kind)) return ['oi:resolve-unavailable'];
    const expectedReceipt = this.parsePrefixed(prefixedReceipt, 'oi:receipt:');
    if (!expectedReceipt) return ['oi:resolve-unavailable'];

    const field = this.hashes.get(keys[0])?.get(studyId);
    if (!field) {
      const lockRaw = this.strings.get(keys[1]);
      if (lockRaw && !parseLockValue(lockRaw)) return ['oi:resolve-unavailable'];
      const receiptRaw = this.strings.get(keys[4]);
      const score = this.zsets.get(keys[5])?.get(`${studyId}:${generation}`);
      if (receiptRaw !== undefined) {
        if (receiptRaw !== prefixedReceipt) return ['oi:resolve-stale'];
        if (score === undefined) return ['oi:resolve-receipt-cut'];
        if (score !== Number(expectedReceipt.createdAt)) return ['oi:resolve-corrupt'];
        return ['oi:resolve-terminal'];
      }
      if (!lockRaw) return ['oi:resolve-ambiguous'];
      const lock = parseLockValue(lockRaw);
      if (this.exactLock(lock, generation, researcherId, kind, opNonce)) {
        return ['oi:resolve-missing-operation'];
      }
      return ['oi:resolve-ambiguous'];
    }

    const op = parsePendingStudyOperationV2(field);
    if (
      !op
      || op.studyId !== studyId
      || op.researcherId !== researcherId
      || op.generation !== generation
      || op.kind !== kind
    ) {
      return ['oi:resolve-unavailable'];
    }
    if (op.phase === 'publishing') {
      if (!op.frozenReceipt) return ['oi:resolve-unavailable'];
      return ['oi:resolve-publishing', field];
    }
    if (op.phase !== 'pending' && op.phase !== 'resolving') {
      return ['oi:resolve-unavailable'];
    }
    if (op.phase === 'pending') {
      const lock = parseLockValue(this.strings.get(keys[1]));
      if (!this.exactLock(lock, generation, researcherId, kind, opNonce)) {
        return ['oi:resolve-unavailable'];
      }
    }

    const parseOwner = (raw: string | undefined) => {
      if (!raw) return { owner: null as Record<string, unknown> | null, raw: undefined as string | undefined, bad: false };
      const owner = this.parsePrefixed(raw, 'oi:owner:');
      if (!owner) return { owner: null, raw, bad: true };
      return { owner, raw, bad: false };
    };
    const ownerMatches = (owner: Record<string, unknown> | null) =>
      !!owner && owner.researcherId === researcherId && owner.storageId === storageId;

    let parsedOwner = parseOwner(this.strings.get(keys[2]));
    if (parsedOwner.bad) return ['oi:resolve-unavailable'];
    if (
      (resolution === 'create-complete' || resolution === 'delete-rollback')
      && !ownerMatches(parsedOwner.owner)
    ) {
      return ['oi:resolve-unavailable'];
    }

    const next = { ...op, phase: 'resolving' as const, updatedAt: Number(now) };
    const hash = this.hashes.get(keys[0]) ?? new Map<string, string>();
    hash.set(studyId, this.encodeOp(next));
    this.hashes.set(keys[0], hash);
    this.writes.push('HSET resolving');

    parsedOwner = parseOwner(this.strings.get(keys[2]));
    if (parsedOwner.bad) return ['oi:resolve-unavailable'];
    if (resolution === 'create-complete' || resolution === 'delete-rollback') {
      if (!ownerMatches(parsedOwner.owner)) return ['oi:resolve-unavailable'];
      const studies = this.sets.get(keys[3]) ?? new Set<string>();
      studies.add(studyId);
      this.sets.set(keys[3], studies);
      this.writes.push('SADD');
    } else {
      if (ownerMatches(parsedOwner.owner) && this.strings.get(keys[2]) === parsedOwner.raw) {
        this.strings.delete(keys[2]);
        this.writes.push('DEL owner');
      }
      const studies = this.sets.get(keys[3]) ?? new Set<string>();
      studies.delete(studyId);
      this.sets.set(keys[3], studies);
      this.writes.push('SREM');
    }

    const publishingOp = {
      ...next,
      phase: 'publishing' as const,
      updatedAt: Number(now),
      frozenReceipt: expectedReceipt,
    };
    const publishing = this.encodeOp(publishingOp);
    hash.set(studyId, publishing);
    this.writes.push('HSET publishing');
    return ['oi:resolve-publishing', publishing];
  }

  private receiptEqual(left: Record<string, unknown> | null, prefixed: string): boolean {
    if (!left) return false;
    const expected = this.parsePrefixed(prefixed, 'oi:receipt:');
    if (!expected) return false;
    return Number(left.version) === Number(expected.version)
      && left.studyId === expected.studyId
      && Number(left.generation) === Number(expected.generation)
      && left.kind === expected.kind
      && left.researcherId === expected.researcherId
      && left.resolution === expected.resolution
      && Number(left.createdAt) === Number(expected.createdAt);
  }

  private cadExactLock(lockKey: string, expectedLock: string): boolean {
    const lockRaw = this.strings.get(lockKey);
    if (!lockRaw) return true;
    if (lockRaw === expectedLock) {
      if (this.strings.get(lockKey) === expectedLock) {
        this.strings.delete(lockKey);
        this.writes.push('DEL lock');
      }
      return true;
    }
    return !!parseLockValue(lockRaw);
  }

  private runPublish(keys: string[], args: string[]): unknown {
    const [studyId, generationRaw, expectedLock, prefixedReceipt, createdAtRaw, nowRaw, ttlRaw] = args;
    const expectedReceipt = this.parsePrefixed(prefixedReceipt, 'oi:receipt:');
    if (!expectedReceipt) return ['oi:publish-unavailable'];
    const createdAtScore = Number(createdAtRaw);
    if (!Number.isFinite(createdAtScore)) return ['oi:publish-unavailable'];
    const member = `${studyId}:${generationRaw}`;
    const zset = () => {
      const existing = this.zsets.get(keys[3]) ?? new Map<string, number>();
      this.zsets.set(keys[3], existing);
      return existing;
    };

    const classifyAbsent = (): unknown => {
      const lockRaw = this.strings.get(keys[1]);
      if (lockRaw && !parseLockValue(lockRaw)) return ['oi:publish-unavailable'];
      const receiptRaw = this.strings.get(keys[2]);
      const score = this.zsets.get(keys[3])?.get(member);
      if (receiptRaw !== undefined) {
        if (receiptRaw !== prefixedReceipt) return ['oi:publish-stale'];
        if (score === undefined) {
          const added = zset().has(member) ? 0 : 1;
          zset().set(member, createdAtScore);
          this.writes.push('ZADD');
          return ['oi:publish-published', `oi:count:${added}`];
        }
        if (score !== createdAtScore) return ['oi:publish-corrupt'];
        if (Number(nowRaw) - createdAtScore >= Number(ttlRaw)) {
          this.strings.delete(keys[2]);
          this.writes.push('DEL receipt');
          const removed = zset().delete(member) ? 1 : 0;
          this.writes.push('ZREM');
          return ['oi:publish-pruned', `oi:count:${removed}`];
        }
        if (!this.cadExactLock(keys[1], expectedLock)) return ['oi:publish-unavailable'];
        return ['oi:publish-published', 'oi:count:0'];
      }
      return ['oi:publish-stale'];
    };

    const field = this.hashes.get(keys[0])?.get(studyId);
    if (!field) return classifyAbsent();

    const op = parsePendingStudyOperationV2(field);
    const frozen = op?.frozenReceipt ? { ...op.frozenReceipt } as Record<string, unknown> : null;
    if (!op || op.phase !== 'publishing' || !this.receiptEqual(frozen, prefixedReceipt)) {
      return ['oi:publish-stale'];
    }

    const lockProbe = this.strings.get(keys[1]);
    if (lockProbe && lockProbe !== expectedLock && !parseLockValue(lockProbe)) {
      return ['oi:publish-unavailable'];
    }

    const receiptRaw = this.strings.get(keys[2]);
    if (receiptRaw === undefined) {
      this.strings.set(keys[2], prefixedReceipt);
      this.writes.push('SET receipt');
    } else if (receiptRaw !== prefixedReceipt) {
      return ['oi:publish-stale'];
    }

    const score = this.zsets.get(keys[3])?.get(member);
    let delta = 0;
    if (score === undefined) {
      delta = zset().has(member) ? 0 : 1;
      zset().set(member, createdAtScore);
      this.writes.push('ZADD');
    } else if (score !== createdAtScore) {
      return ['oi:publish-corrupt'];
    }

    if (!this.cadExactLock(keys[1], expectedLock)) return ['oi:publish-unavailable'];
    const hash = this.hashes.get(keys[0]) ?? new Map<string, string>();
    hash.delete(studyId);
    this.hashes.set(keys[0], hash);
    this.writes.push('HDEL');
    return ['oi:publish-published', `oi:count:${delta}`];
  }

  private parseLink(value: unknown): Record<string, unknown> | null {
    const prefixed = this.parsePrefixed(value, 'oi:link:');
    if (prefixed) return prefixed;
    if (typeof value !== 'string') return null;
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }

  private runHostedLinkCreate(keys: string[], args: string[]): unknown {
    const gated = this.runAuthority(keys.slice(0, 5), args.slice(0, 7));
    if (!Array.isArray(gated) || gated[0] !== 'oi:authz-allow') return gated;
    const recordKey = keys[5];
    const indexKey = keys[6];
    const encoded = args[7];
    const linkId = args[8];
    const recordPrefix = args[9];
    const max = Number(args[10]);
    const expiresAt = args[11];
    if (this.strings.has(recordKey)) return ['oi:link-exists'];
    if (linkId) {
      const index = this.sets.get(indexKey) ?? new Set<string>();
      if (index.size >= max) {
        for (const existingId of [...index]) {
          if (!this.strings.has(`${recordPrefix}${existingId}`)) {
            index.delete(existingId);
            this.writes.push(`SREM ${indexKey}`);
          }
        }
        this.sets.set(indexKey, index);
        if (index.size >= max) return ['oi:link-quota'];
      }
    }
    this.strings.set(recordKey, encoded);
    this.writes.push(`SET ${recordKey}`);
    if (linkId) {
      const index = this.sets.get(indexKey) ?? new Set<string>();
      index.add(linkId);
      this.sets.set(indexKey, index);
      this.writes.push(`SADD ${indexKey}`);
    }
    if (expiresAt) this.writes.push(`PEXPIREAT ${recordKey}`);
    return ['oi:link-created'];
  }

  private runHostedLinkList(keys: string[], args: string[]): unknown {
    const gated = this.runAuthority(keys.slice(0, 5), args.slice(0, 7));
    if (!Array.isArray(gated) || gated[0] !== 'oi:authz-allow') return gated;
    const indexKey = keys[5];
    const recordPrefix = args[7];
    const studyId = args[1];
    const caller = args[0];
    const now = Number(args[9]);
    const members = [...(this.sets.get(indexKey) ?? new Set<string>())];
    const links: string[] = [];
    const stale: string[] = [];
    for (const id of members) {
      if (!/^[0-9a-f]{64}$/.test(id)) {
        stale.push(id);
        continue;
      }
      const raw = this.strings.get(`${recordPrefix}${id}`);
      if (!raw) {
        stale.push(id);
        continue;
      }
      const link = this.parseLink(raw);
      if (!link || link.id !== id) return ['oi:link-unavailable'];
      if (link.expiresAt != null && Number(link.expiresAt) <= now) {
        stale.push(id);
        continue;
      }
      if (link.studyId !== studyId) continue;
      if (caller !== '' && link.researcherId !== caller) {
        stale.push(id);
        continue;
      }
      links.push(raw);
    }
    if (stale.length > 0) {
      const index = this.sets.get(indexKey) ?? new Set<string>();
      for (const id of stale) index.delete(id);
      this.sets.set(indexKey, index);
      this.writes.push(`SREM ${indexKey}`);
    }
    return ['oi:link-list', JSON.stringify(links)];
  }

  private runHostedLinkRevoke(keys: string[], args: string[]): unknown {
    const gated = this.runAuthority(keys.slice(0, 5), args.slice(0, 7));
    if (!Array.isArray(gated) || gated[0] !== 'oi:authz-allow') return gated;
    const recordKey = keys[5];
    const indexKey = keys[6];
    const linkId = args[7];
    const now = Number(args[8]);
    const raw = this.strings.get(recordKey);
    if (!raw) {
      const index = this.sets.get(indexKey) ?? new Set<string>();
      index.delete(linkId);
      this.sets.set(indexKey, index);
      this.writes.push(`SREM ${indexKey}`);
      return ['oi:link-missing'];
    }
    const link = this.parseLink(raw);
    if (!link) return ['oi:link-unavailable'];
    if (link.studyId !== args[1]) return ['oi:link-owner'];
    if (args[0] !== '' && link.researcherId !== args[0]) return ['oi:link-owner'];
    if (link.expiresAt != null && Number(link.expiresAt) <= now) {
      const index = this.sets.get(indexKey) ?? new Set<string>();
      index.delete(linkId);
      this.sets.set(indexKey, index);
      this.writes.push(`SREM ${indexKey}`);
      return ['oi:link-missing'];
    }
    if (link.revokedAt != null) return ['oi:link-already'];
    link.revokedAt = now;
    this.strings.set(recordKey, `oi:link:${JSON.stringify(link)}`);
    this.writes.push(`SET ${recordKey}`);
    return ['oi:link-revoked'];
  }

  private runHostedLinkExchange(keys: string[], args: string[]): unknown {
    const raw = this.strings.get(keys[3]);
    if (!raw) return ['oi:link-missing'];
    const link = this.parseLink(raw);
    if (!link || typeof link.studyId !== 'string' || !link.studyId) return ['oi:link-unavailable'];
    const studyId = String(link.studyId);
    const gated = this.runAuthority(
      [keys[0], `${args[7]}${studyId}`, keys[1], `${args[8]}${studyId}`, keys[2]],
      [args[0], studyId, args[2], args[3], args[4], args[5], args[6]],
    );
    if (!Array.isArray(gated) || gated[0] !== 'oi:authz-allow') return gated;
    if (link.revokedAt != null) return ['oi:link-revoked'];
    if (link.expiresAt != null && Number(link.expiresAt) <= Number(args[9])) return ['oi:link-expired'];
    if (typeof link.id !== 'string') return ['oi:link-unavailable'];
    return ['oi:link-found', raw];
  }
}
