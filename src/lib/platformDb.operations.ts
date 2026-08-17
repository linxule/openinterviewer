// Hosted HASH registry begin + reserving recovery + resolve + publish/prune
// (Revision 12 §6, §8.1–§8.5). Phase 3 slice: types, beginCreate/beginDelete,
// recoverReserving, resolveStudyOperationV2, publishStudyOperationV2.
// Does not implement authority or v1 API replacement.

import { RedisCommitAmbiguousError, type RedisPort } from './redisPort';
import { getPlatformClient } from './kvClient';
import { logRequestFailure } from './requestLog';
import { platformKey } from './platformSchema';
import {
  MAX_LIVE_OPS,
  MAX_STUDIES,
  isHex64,
  isOpNonce,
  isResearcherId,
  isUuid,
  type StudyOpPhase,
  type StudyOperationKind,
} from './wire/types';
import {
  MAX_GENERATION,
  parseBeginResult,
  parsePrefixedJson,
  parsePublishResult,
  parseRecoverResult,
  parseResolveResult,
} from './wire/parse';
import { OPERATION_RECORD_PREFIX, parseOperationRecord } from './wire/registry';

export type { StudyOpPhase, StudyOperationKind };
export { MAX_LIVE_OPS, MAX_STUDIES, MAX_GENERATION };

export const OP_GRACE_MS = 300_000;
export const RECEIPT_TTL_SECONDS = 604_800;
export const ACCOUNT_VALUE_PREFIX = 'oi:account:';
export const OWNER_VALUE_PREFIX = 'oi:owner:';
export const STORAGE_VALUE_PREFIX = 'oi:storage:';
export const LOCK_VALUE_PREFIX = 'oi:lock:';
export const RECEIPT_VALUE_PREFIX = 'oi:receipt:';

export interface OperationReceipt {
  version: 2;
  studyId: string;
  generation: number;
  kind: StudyOperationKind;
  researcherId: string;
  resolution: 'create-complete' | 'create-rollback' | 'delete-complete' | 'delete-rollback';
  createdAt: number;
}

export interface PendingStudyOperationV2 {
  version: 2;
  id: `${StudyOperationKind}:${string}:${number}`;
  kind: StudyOperationKind;
  phase: StudyOpPhase;
  researcherId: string;
  studyId: string;
  generation: number;
  opNonce: string;
  createdAt: number;
  updatedAt: number;
  idempotencyHash: string | null;
  fingerprint: string | null;
  frozenReceipt: OperationReceipt | null;
}

export interface StorageBinding {
  version: 2;
  researcherId: string;
  storageId: string;
  originHash: string;
  credentialRevision: number;
  bindingEpoch: number;
  cipherSnapshot: string;
}

export interface OwnerRecord {
  version: 2;
  researcherId: string;
  storageId: string;
  generation: number;
}

export type BeginStudyOperationV2Result =
  | { status: 'started' | 'replay'; operation: PendingStudyOperationV2 }
  | {
      status:
        | 'hold'
        | 'adel'
        | 'noacct'
        | 'bind'
        | 'opquota'
        | 'live'
        | 'studyquota'
        | 'owner'
        | 'notfound'
        | 'invalid'
        | 'unavailable'
        | 'ambiguous';
    };

export type RecoverReservingStudyOperationResult =
  | { status: 'pending' }
  | { status: 'abandoned' }
  | { status: 'wait' }
  | { status: 'ambiguous' }
  | { status: 'phase'; phase: StudyOpPhase }
  | { status: 'invalid' | 'unavailable' };

export interface BeginStudyOperationV2Input {
  client?: RedisPort;
  researcherId: string;
  studyId: string;
  storageId: string;
  generation: number;
  opNonce: string;
  bindingEpoch: number;
  now?: number;
  maxOps?: number;
  maxStudies?: number;
  idempotencyHash: string | null;
  fingerprint: string | null;
}

export interface RecoverReservingStudyOperationInput {
  client?: RedisPort;
  studyId: string;
  researcherId: string;
  generation: number;
  kind: StudyOperationKind;
  opNonce: string;
  now?: number;
  graceMs?: number;
}

export type StudyOperationResolutionV2 = OperationReceipt['resolution'];

export type ResolveStudyOperationV2Result =
  | { status: 'publishing'; operation: PendingStudyOperationV2 }
  | {
      status:
        | 'missing-operation'
        | 'ambiguous'
        | 'stale'
        | 'receipt-cut'
        | 'corrupt'
        | 'terminal'
        | 'invalid'
        | 'unavailable';
    };

export interface ResolveStudyOperationV2Input {
  client?: RedisPort;
  researcherId: string;
  studyId: string;
  storageId: string;
  generation: number;
  kind: StudyOperationKind;
  opNonce: string;
  resolution: StudyOperationResolutionV2;
  now?: number;
  createdAt?: number;
}

export type PublishStudyOperationV2Result =
  | { status: 'published'; zaddDelta: number }
  | { status: 'pruned'; zremDelta: number }
  | { status: 'stale' | 'corrupt' | 'invalid' | 'unavailable' | 'ambiguous' };

export interface PublishStudyOperationV2Input {
  client?: RedisPort;
  researcherId: string;
  studyId: string;
  generation: number;
  kind: StudyOperationKind;
  opNonce: string;
  resolution: StudyOperationResolutionV2;
  now?: number;
  createdAt?: number;
}

function isSafeNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_GENERATION;
}

export function studyOperationV2Id(
  kind: StudyOperationKind,
  studyId: string,
  generation: number,
): `${StudyOperationKind}:${string}:${number}` {
  return `${kind}:${studyId}:${generation}`;
}

export function encodeLockValue(input: {
  generation: number;
  researcherId: string;
  kind: StudyOperationKind;
  opNonce: string;
}): string {
  return `${LOCK_VALUE_PREFIX}${input.generation}:${input.researcherId}:${input.kind}:${input.opNonce}`;
}

export function encodeOwnerRecord(owner: OwnerRecord): string {
  return `${OWNER_VALUE_PREFIX}${JSON.stringify(owner)}`;
}

export function encodeStorageBinding(binding: StorageBinding): string {
  return `${STORAGE_VALUE_PREFIX}${JSON.stringify(binding)}`;
}

export function encodeAccountRecord(account: { id: string }): string {
  return `${ACCOUNT_VALUE_PREFIX}${JSON.stringify(account)}`;
}

export function encodeOperationRecord(operation: PendingStudyOperationV2): string {
  return `${OPERATION_RECORD_PREFIX}${JSON.stringify(operation)}`;
}

export function encodeOperationReceipt(receipt: OperationReceipt): string {
  return `${RECEIPT_VALUE_PREFIX}${JSON.stringify(receipt)}`;
}

export function parseOperationReceipt(value: unknown): OperationReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const receipt = value as Record<string, unknown>;
  if (receipt.version !== 2) return null;
  if (receipt.kind !== 'create' && receipt.kind !== 'delete') return null;
  if (typeof receipt.studyId !== 'string' || !isUuid(receipt.studyId)) return null;
  if (!isGeneration(receipt.generation)) return null;
  if (typeof receipt.researcherId !== 'string' || !isResearcherId(receipt.researcherId)) return null;
  if (
    receipt.resolution !== 'create-complete'
    && receipt.resolution !== 'create-rollback'
    && receipt.resolution !== 'delete-complete'
    && receipt.resolution !== 'delete-rollback'
  ) {
    return null;
  }
  if (!isSafeNonNegativeInt(receipt.createdAt)) return null;
  return {
    version: 2,
    studyId: receipt.studyId,
    generation: receipt.generation,
    kind: receipt.kind,
    researcherId: receipt.researcherId,
    resolution: receipt.resolution,
    createdAt: receipt.createdAt,
  };
}

export function parseOwnerRecord(value: unknown): OwnerRecord | null {
  const parsed = parsePrefixedJson(value, OWNER_VALUE_PREFIX);
  if (!parsed.ok) return null;
  const payload = parsed.payload;
  if (payload.version !== 2) return null;
  if (typeof payload.researcherId !== 'string' || !isResearcherId(payload.researcherId)) return null;
  if (typeof payload.storageId !== 'string' || !isHex64(payload.storageId)) return null;
  if (!isGeneration(payload.generation)) return null;
  return {
    version: 2,
    researcherId: payload.researcherId,
    storageId: payload.storageId,
    generation: payload.generation,
  };
}

export function parseStorageBinding(value: unknown): StorageBinding | null {
  const parsed = parsePrefixedJson(value, STORAGE_VALUE_PREFIX);
  if (!parsed.ok) return null;
  const payload = parsed.payload;
  if (payload.version !== 2) return null;
  if (typeof payload.researcherId !== 'string' || !isResearcherId(payload.researcherId)) return null;
  if (typeof payload.storageId !== 'string' || !isHex64(payload.storageId)) return null;
  if (typeof payload.originHash !== 'string' || !isHex64(payload.originHash)) return null;
  if (!isSafeNonNegativeInt(payload.credentialRevision) || payload.credentialRevision < 1) return null;
  if (!isSafeNonNegativeInt(payload.bindingEpoch)) return null;
  if (typeof payload.cipherSnapshot !== 'string' || payload.cipherSnapshot.length === 0) return null;
  return {
    version: 2,
    researcherId: payload.researcherId,
    storageId: payload.storageId,
    originHash: payload.originHash,
    credentialRevision: payload.credentialRevision,
    bindingEpoch: payload.bindingEpoch,
    cipherSnapshot: payload.cipherSnapshot,
  };
}

export type ResearcherStorageBindingLoadResult =
  | { status: 'ok'; binding: StorageBinding }
  | { status: 'missing' }
  | { status: 'unavailable' };

export function parsePendingStudyOperationV2(value: unknown): PendingStudyOperationV2 | null {
  const parsed = parseOperationRecord(value);
  if (!parsed.ok) return null;
  const payload = parsed.operation;
  if (payload.kind !== 'create' && payload.kind !== 'delete') return null;
  if (
    payload.phase !== 'reserving'
    && payload.phase !== 'pending'
    && payload.phase !== 'resolving'
    && payload.phase !== 'publishing'
  ) {
    return null;
  }
  if (typeof payload.researcherId !== 'string' || !isResearcherId(payload.researcherId)) return null;
  if (typeof payload.studyId !== 'string' || !isUuid(payload.studyId)) return null;
  if (!isGeneration(payload.generation)) return null;
  if (typeof payload.opNonce !== 'string' || !isOpNonce(payload.opNonce)) return null;
  if (!isSafeNonNegativeInt(payload.createdAt) || !isSafeNonNegativeInt(payload.updatedAt)) return null;
  if (payload.id !== studyOperationV2Id(payload.kind, payload.studyId, payload.generation)) return null;
  const hash = payload.idempotencyHash;
  const fingerprint = payload.fingerprint;
  if (payload.kind === 'create') {
    if (typeof hash !== 'string' || !isHex64(hash)) return null;
    if (typeof fingerprint !== 'string' || !isHex64(fingerprint)) return null;
  } else if (hash !== null || fingerprint !== null) {
    return null;
  }
  const frozenReceipt = payload.frozenReceipt === null ? null : parseOperationReceipt(payload.frozenReceipt);
  if (payload.frozenReceipt !== null && frozenReceipt === null) return null;
  return {
    version: 2,
    id: payload.id as PendingStudyOperationV2['id'],
    kind: payload.kind,
    phase: payload.phase,
    researcherId: payload.researcherId,
    studyId: payload.studyId,
    generation: payload.generation,
    opNonce: payload.opNonce,
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt,
    idempotencyHash: payload.kind === 'create' ? hash as string : null,
    fingerprint: payload.kind === 'create' ? fingerprint as string : null,
    frozenReceipt,
  };
}

export function hostedBeginKeys(researcherId: string, studyId: string, storageId: string): string[] {
  return [
    platformKey('study-ops:v2'),
    platformKey(`study-op-lock:${studyId}`),
    platformKey(`study-owner:${studyId}`),
    platformKey(`researcher-studies:${researcherId}`),
    platformKey(`researcher:${researcherId}`),
    platformKey(`researcher-storage:${researcherId}`),
    platformKey(`storage-researchers:${storageId}`),
    platformKey('account-delete-journal'),
    platformKey('schema-lineage'),
  ];
}

export function hostedRecoverKeys(researcherId: string, studyId: string): string[] {
  return [
    platformKey('study-ops:v2'),
    platformKey(`study-op-lock:${studyId}`),
    platformKey(`study-owner:${studyId}`),
    platformKey(`researcher-studies:${researcherId}`),
    platformKey('account-delete-journal'),
  ];
}

export function hostedResolveKeys(researcherId: string, studyId: string, generation: number): string[] {
  return [
    platformKey('study-ops:v2'),
    platformKey(`study-op-lock:${studyId}`),
    platformKey(`study-owner:${studyId}`),
    platformKey(`researcher-studies:${researcherId}`),
    platformKey(`study-op-receipt:${studyId}:${generation}`),
    platformKey(`study-op-receipts:${researcherId}`),
  ];
}

export function hostedPublishKeys(researcherId: string, studyId: string, generation: number): string[] {
  return [
    platformKey('study-ops:v2'),
    platformKey(`study-op-lock:${studyId}`),
    platformKey(`study-op-receipt:${studyId}:${generation}`),
    platformKey(`study-op-receipts:${researcherId}`),
  ];
}

export function buildPendingStudyOperationV2(input: {
  kind: StudyOperationKind;
  phase?: StudyOpPhase;
  researcherId: string;
  studyId: string;
  generation: number;
  opNonce: string;
  createdAt: number;
  updatedAt?: number;
  idempotencyHash: string | null;
  fingerprint: string | null;
}): PendingStudyOperationV2 {
  return {
    version: 2,
    id: studyOperationV2Id(input.kind, input.studyId, input.generation),
    kind: input.kind,
    phase: input.phase ?? 'reserving',
    researcherId: input.researcherId,
    studyId: input.studyId,
    generation: input.generation,
    opNonce: input.opNonce,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt ?? input.createdAt,
    idempotencyHash: input.idempotencyHash,
    fingerprint: input.fingerprint,
    frozenReceipt: null,
  };
}

export const BEGIN_STUDY_OPERATION_SCRIPT = `
local function parse_prefixed(value, prefix)
  if type(value) ~= 'string' then return nil end
  if string.sub(value, 1, #prefix) ~= prefix then return nil end
  local ok, obj = pcall(cjson.decode, string.sub(value, #prefix + 1))
  if not ok or type(obj) ~= 'table' then return nil end
  return obj
end

local function json_null(value)
  return value == nil or value == cjson.null
end

local function same_optional(left, right)
  if json_null(left) and json_null(right) then return true end
  return left == right
end

local function parse_lock(value)
  if type(value) ~= 'string' then return nil end
  local parts = {}
  local count = 0
  for part in string.gmatch(value, '[^:]+') do
    count = count + 1
    parts[count] = part
  end
  if count ~= 6 or parts[1] ~= 'oi' or parts[2] ~= 'lock' then return nil end
  local generation = tonumber(parts[3])
  if not generation then return nil end
  if parts[5] ~= 'create' and parts[5] ~= 'delete' then return nil end
  return {
    generation = generation,
    researcherId = parts[4],
    kind = parts[5],
    opNonce = parts[6]
  }
end

local function encode_op(obj)
  return 'oi:op:' .. cjson.encode(obj)
end

local lineage = parse_prefixed(redis.call('GET', KEYS[9]), 'oi:lineage:')
if not lineage or lineage.version ~= 2 or lineage.authority ~= 'v2' or lineage.operations ~= 'hash-v2' then
  return {'oi:begin-hold'}
end

if redis.call('HEXISTS', KEYS[8], ARGV[1]) == 1 then
  return {'oi:begin-adel'}
end

local account = parse_prefixed(redis.call('GET', KEYS[5]), 'oi:account:')
if not account or account.id ~= ARGV[1] then
  return {'oi:begin-noacct'}
end

local storage = parse_prefixed(redis.call('GET', KEYS[6]), 'oi:storage:')
if not storage
  or storage.researcherId ~= ARGV[1]
  or storage.storageId ~= ARGV[3]
  or tonumber(storage.bindingEpoch) ~= tonumber(ARGV[12]) then
  return {'oi:begin-bind'}
end

if redis.call('SISMEMBER', KEYS[7], ARGV[1]) ~= 1 then
  return {'oi:begin-bind'}
end

local existing = redis.call('HGET', KEYS[1], ARGV[2])
if (not existing) and redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[10]) then
  return {'oi:begin-opquota'}
end

local incoming = parse_prefixed(ARGV[7], 'oi:op:')
if not incoming then return {'oi:begin-unavailable'} end

if existing then
  local op = parse_prefixed(existing, 'oi:op:')
  if not op then return {'oi:begin-unavailable'} end
  if op.phase ~= 'reserving' and op.phase ~= 'pending' and op.phase ~= 'resolving' and op.phase ~= 'publishing' then
    return {'oi:begin-unavailable'}
  end
  if op.researcherId == ARGV[1]
    and tonumber(op.generation) == tonumber(ARGV[5])
    and op.kind == ARGV[4]
    and same_optional(op.idempotencyHash, incoming.idempotencyHash) then
    return {'oi:begin-replay', existing}
  end
  return {'oi:begin-live'}
end

local lock = redis.call('GET', KEYS[2])
if lock then
  local parsedLock = parse_lock(lock)
  if not parsedLock then return {'oi:begin-unavailable'} end
  if tonumber(parsedLock.generation) ~= tonumber(ARGV[5]) then
    return {'oi:begin-live'}
  end
end

if ARGV[4] == 'create' then
  if (not redis.call('GET', KEYS[3])) and redis.call('SCARD', KEYS[4]) >= tonumber(ARGV[11]) then
    return {'oi:begin-studyquota'}
  end
elseif ARGV[4] == 'delete' then
  local ownerRaw = redis.call('GET', KEYS[3])
  if not ownerRaw then return {'oi:begin-notfound'} end
  local owner = parse_prefixed(ownerRaw, 'oi:owner:')
  if not owner then return {'oi:begin-unavailable'} end
  if owner.researcherId ~= ARGV[1] or owner.storageId ~= ARGV[3] then
    return {'oi:begin-owner'}
  end
else
  return {'oi:begin-unavailable'}
end

incoming.phase = 'reserving'
incoming.updatedAt = tonumber(ARGV[9])
redis.call('HSET', KEYS[1], ARGV[2], encode_op(incoming))
-- fault cut R1

if ARGV[4] == 'create' then
  if redis.call('SET', KEYS[3], ARGV[8], 'NX') == false then
    local existingOwner = parse_prefixed(redis.call('GET', KEYS[3]), 'oi:owner:')
    if not existingOwner then return {'oi:begin-unavailable'} end
    if existingOwner.researcherId ~= ARGV[1] or existingOwner.storageId ~= ARGV[3] then
      return {'oi:begin-owner'}
    end
  end
  -- fault cut R2
  redis.call('SADD', KEYS[4], ARGV[2])
  -- fault cut R3
end

redis.call('SET', KEYS[2], 'oi:lock:' .. ARGV[5] .. ':' .. ARGV[1] .. ':' .. ARGV[4] .. ':' .. ARGV[6])
-- fault cut R4

incoming.phase = 'pending'
incoming.updatedAt = tonumber(ARGV[9])
local pending = encode_op(incoming)
redis.call('HSET', KEYS[1], ARGV[2], pending)
return {'oi:begin-started', pending}
`;

export const RECOVER_RESERVING_STUDY_OPERATION_SCRIPT = `
local function parse_prefixed(value, prefix)
  if type(value) ~= 'string' then return nil end
  if string.sub(value, 1, #prefix) ~= prefix then return nil end
  local ok, obj = pcall(cjson.decode, string.sub(value, #prefix + 1))
  if not ok or type(obj) ~= 'table' then return nil end
  return obj
end

local function parse_lock(value)
  if type(value) ~= 'string' then return nil end
  local parts = {}
  local count = 0
  for part in string.gmatch(value, '[^:]+') do
    count = count + 1
    parts[count] = part
  end
  if count ~= 6 or parts[1] ~= 'oi' or parts[2] ~= 'lock' then return nil end
  local generation = tonumber(parts[3])
  if not generation then return nil end
  if parts[5] ~= 'create' and parts[5] ~= 'delete' then return nil end
  return {
    generation = generation,
    researcherId = parts[4],
    kind = parts[5],
    opNonce = parts[6]
  }
end

local field = redis.call('HGET', KEYS[1], ARGV[1])
local op = parse_prefixed(field, 'oi:op:')
if not op then return {'oi:recover-unavailable'} end
if op.phase ~= 'reserving' then
  if op.phase == 'pending' or op.phase == 'resolving' or op.phase == 'publishing' then
    return {'oi:recover-phase', op.phase}
  end
  return {'oi:recover-unavailable'}
end

if redis.call('HEXISTS', KEYS[5], ARGV[2]) == 1 then
  return {'oi:recover-unavailable'}
end

if op.studyId ~= ARGV[1]
  or op.researcherId ~= ARGV[2]
  or tonumber(op.generation) ~= tonumber(ARGV[3])
  or op.kind ~= ARGV[4] then
  return {'oi:recover-unavailable'}
end

local function install_pending()
  op.phase = 'pending'
  op.updatedAt = tonumber(ARGV[6])
  redis.call('HSET', KEYS[1], ARGV[1], 'oi:op:' .. cjson.encode(op))
  -- fault cut recover
  return {'oi:recover-phase', 'pending'}
end

local lockRaw = redis.call('GET', KEYS[2])
if lockRaw then
  local lock = parse_lock(lockRaw)
  if not lock then return {'oi:recover-unavailable'} end
  if tonumber(lock.generation) == tonumber(ARGV[3]) then
    return install_pending()
  end
  return {'oi:recover-ambiguous'}
end

local ownerRaw = redis.call('GET', KEYS[3])
if not ownerRaw then
  local createdAt = tonumber(op.createdAt)
  local now = tonumber(ARGV[6])
  local grace = tonumber(ARGV[7])
  if not createdAt or not now or not grace then return {'oi:recover-unavailable'} end
  if (now - createdAt) < grace then
    return {'oi:recover-wait'}
  end
  redis.call('HDEL', KEYS[1], ARGV[1])
  return {'oi:recover-phase', 'reserving'}
end

local owner = parse_prefixed(ownerRaw, 'oi:owner:')
if not owner then return {'oi:recover-unavailable'} end
if owner.researcherId == ARGV[2] and redis.call('SISMEMBER', KEYS[4], ARGV[1]) == 1 then
  redis.call('SET', KEYS[2], 'oi:lock:' .. ARGV[3] .. ':' .. ARGV[2] .. ':' .. ARGV[4] .. ':' .. ARGV[5])
  return install_pending()
end
return {'oi:recover-ambiguous'}
`;

function resolveClient(client?: RedisPort): RedisPort {
  return client ?? getPlatformClient();
}

export async function loadResearcherStorageBinding(
  researcherId: string,
  client?: RedisPort,
): Promise<ResearcherStorageBindingLoadResult> {
  if (!isResearcherId(researcherId)) return { status: 'missing' };
  try {
    const raw = await resolveClient(client).get(platformKey(`researcher-storage:${researcherId}`));
    if (raw === null || raw === undefined) return { status: 'missing' };
    const binding = parseStorageBinding(raw);
    if (!binding || binding.researcherId !== researcherId) return { status: 'missing' };
    return { status: 'ok', binding };
  } catch {
    return { status: 'unavailable' };
  }
}

function validBeginIdentity(input: BeginStudyOperationV2Input, kind: StudyOperationKind): boolean {
  if (!isResearcherId(input.researcherId) || !isUuid(input.studyId) || !isHex64(input.storageId)) {
    return false;
  }
  if (!isGeneration(input.generation) || !isOpNonce(input.opNonce)) return false;
  if (!Number.isSafeInteger(input.bindingEpoch) || input.bindingEpoch < 0) return false;
  if (kind === 'create') {
    return typeof input.idempotencyHash === 'string'
      && isHex64(input.idempotencyHash)
      && typeof input.fingerprint === 'string'
      && isHex64(input.fingerprint);
  }
  return input.idempotencyHash === null && input.fingerprint === null;
}

function mapAmbiguous(error: unknown): 'ambiguous' | 'unavailable' {
  if (error instanceof RedisCommitAmbiguousError) {
    return error.commitState === 'may-have-committed' ? 'ambiguous' : 'unavailable';
  }
  return 'unavailable';
}

function decodeBeginWire(wire: unknown): BeginStudyOperationV2Result {
  const parsed = parseBeginResult(wire);
  if (parsed.status !== 'ok') return { status: 'unavailable' };
  if (parsed.value.outcome === 'started' || parsed.value.outcome === 'replay') {
    const operation = parsePendingStudyOperationV2(parsed.value.value);
    if (!operation) return { status: 'unavailable' };
    return { status: parsed.value.outcome, operation };
  }
  return { status: parsed.value.outcome };
}

async function beginStudyOperationV2(
  kind: StudyOperationKind,
  input: BeginStudyOperationV2Input,
): Promise<BeginStudyOperationV2Result> {
  const maxOps = input.maxOps ?? MAX_LIVE_OPS;
  const maxStudies = input.maxStudies ?? MAX_STUDIES;
  if (!validBeginIdentity(input, kind) || maxOps < 1 || maxStudies < 1) {
    return { status: 'invalid' };
  }

  const now = input.now ?? Date.now();
  const operation = buildPendingStudyOperationV2({
    kind,
    phase: 'reserving',
    researcherId: input.researcherId,
    studyId: input.studyId,
    generation: input.generation,
    opNonce: input.opNonce,
    createdAt: now,
    updatedAt: now,
    idempotencyHash: input.idempotencyHash,
    fingerprint: input.fingerprint,
  });
  const owner: OwnerRecord = {
    version: 2,
    researcherId: input.researcherId,
    storageId: input.storageId,
    generation: input.generation,
  };

  try {
    const wire = await resolveClient(input.client).eval(
      BEGIN_STUDY_OPERATION_SCRIPT,
      hostedBeginKeys(input.researcherId, input.studyId, input.storageId),
      [
        input.researcherId,
        input.studyId,
        input.storageId,
        kind,
        String(input.generation),
        input.opNonce,
        encodeOperationRecord(operation),
        encodeOwnerRecord(owner),
        String(now),
        String(maxOps),
        String(maxStudies),
        String(input.bindingEpoch),
      ],
    );
    return decodeBeginWire(wire);
  } catch (error) {
    logRequestFailure({ event: 'platform.unavailable' }, error);
    return { status: mapAmbiguous(error) };
  }
}

export async function beginCreateStudyOperationV2(
  input: BeginStudyOperationV2Input,
): Promise<BeginStudyOperationV2Result> {
  return beginStudyOperationV2('create', input);
}

export async function beginDeleteStudyOperationV2(
  input: BeginStudyOperationV2Input,
): Promise<BeginStudyOperationV2Result> {
  return beginStudyOperationV2('delete', input);
}

export async function recoverReservingStudyOperation(
  input: RecoverReservingStudyOperationInput,
): Promise<RecoverReservingStudyOperationResult> {
  const graceMs = input.graceMs ?? OP_GRACE_MS;
  if (
    !isUuid(input.studyId)
    || !isResearcherId(input.researcherId)
    || !isGeneration(input.generation)
    || (input.kind !== 'create' && input.kind !== 'delete')
    || !isOpNonce(input.opNonce)
    || graceMs < 0
  ) {
    return { status: 'invalid' };
  }

  try {
    const wire = await resolveClient(input.client).eval(
      RECOVER_RESERVING_STUDY_OPERATION_SCRIPT,
      hostedRecoverKeys(input.researcherId, input.studyId),
      [
        input.studyId,
        input.researcherId,
        String(input.generation),
        input.kind,
        input.opNonce,
        String(input.now ?? Date.now()),
        String(graceMs),
      ],
    );
    const parsed = parseRecoverResult(wire);
    if (parsed.status !== 'ok') return { status: 'unavailable' };
    if (parsed.value.outcome === 'wait') return { status: 'wait' };
    if (parsed.value.outcome === 'ambiguous') return { status: 'ambiguous' };
    if (parsed.value.phase === 'reserving') return { status: 'abandoned' };
    if (parsed.value.phase === 'pending') return { status: 'pending' };
    return { status: 'phase', phase: parsed.value.phase };
  } catch (error) {
    logRequestFailure({ event: 'platform.unavailable' }, error);
    return { status: mapAmbiguous(error) };
  }
}

export const RESOLVE_STUDY_OPERATION_SCRIPT = `
local function parse_prefixed(value, prefix)
  if type(value) ~= 'string' then return nil end
  if string.sub(value, 1, #prefix) ~= prefix then return nil end
  local ok, obj = pcall(cjson.decode, string.sub(value, #prefix + 1))
  if not ok or type(obj) ~= 'table' then return nil end
  return obj
end

local function parse_lock(value)
  if type(value) ~= 'string' then return nil end
  local parts = {}
  local count = 0
  for part in string.gmatch(value, '[^:]+') do
    count = count + 1
    parts[count] = part
  end
  if count ~= 6 or parts[1] ~= 'oi' or parts[2] ~= 'lock' then return nil end
  local generation = tonumber(parts[3])
  if not generation then return nil end
  if parts[5] ~= 'create' and parts[5] ~= 'delete' then return nil end
  return {
    generation = generation,
    researcherId = parts[4],
    kind = parts[5],
    opNonce = parts[6]
  }
end

local function encode_op(obj)
  return 'oi:op:' .. cjson.encode(obj)
end

local function owner_matches(owner)
  return owner
    and owner.researcherId == ARGV[2]
    and owner.storageId == ARGV[3]
end

local resolution = ARGV[7]
if resolution ~= 'create-complete' and resolution ~= 'create-rollback'
  and resolution ~= 'delete-complete' and resolution ~= 'delete-rollback' then
  return {'oi:resolve-unavailable'}
end
if string.sub(resolution, 1, #ARGV[5]) ~= ARGV[5] then
  return {'oi:resolve-unavailable'}
end

local expectedReceipt = parse_prefixed(ARGV[9], 'oi:receipt:')
if not expectedReceipt then return {'oi:resolve-unavailable'} end

local field = redis.call('HGET', KEYS[1], ARGV[1])
if not field then
  local lockRaw = redis.call('GET', KEYS[2])
  if lockRaw then
    if not parse_lock(lockRaw) then return {'oi:resolve-unavailable'} end
  end
  local receiptRaw = redis.call('GET', KEYS[5])
  local score = redis.call('ZSCORE', KEYS[6], ARGV[1] .. ':' .. ARGV[4])
  if receiptRaw then
    if type(receiptRaw) ~= 'string' or receiptRaw ~= ARGV[9] then
      return {'oi:resolve-stale'}
    end
    if not score then
      return {'oi:resolve-receipt-cut'}
    end
    if tonumber(score) ~= tonumber(expectedReceipt.createdAt) then
      return {'oi:resolve-corrupt'}
    end
    return {'oi:resolve-terminal'}
  end
  if not lockRaw then
    return {'oi:resolve-ambiguous'}
  end
  local lock = parse_lock(lockRaw)
  if tonumber(lock.generation) == tonumber(ARGV[4])
    and lock.researcherId == ARGV[2]
    and lock.kind == ARGV[5]
    and lock.opNonce == ARGV[6] then
    return {'oi:resolve-missing-operation'}
  end
  return {'oi:resolve-ambiguous'}
end

local op = parse_prefixed(field, 'oi:op:')
if not op then return {'oi:resolve-unavailable'} end
if op.studyId ~= ARGV[1]
  or op.researcherId ~= ARGV[2]
  or tonumber(op.generation) ~= tonumber(ARGV[4])
  or op.kind ~= ARGV[5] then
  return {'oi:resolve-unavailable'}
end

if op.phase == 'publishing' then
  if type(op.frozenReceipt) ~= 'table' then return {'oi:resolve-unavailable'} end
  return {'oi:resolve-publishing', field}
end

if op.phase ~= 'pending' and op.phase ~= 'resolving' then
  return {'oi:resolve-unavailable'}
end

if op.phase == 'pending' then
  local lockRaw = redis.call('GET', KEYS[2])
  local lock = parse_lock(lockRaw)
  if not lock then return {'oi:resolve-unavailable'} end
  if tonumber(lock.generation) ~= tonumber(ARGV[4])
    or lock.researcherId ~= ARGV[2]
    or lock.kind ~= ARGV[5]
    or lock.opNonce ~= ARGV[6] then
    return {'oi:resolve-unavailable'}
  end
end

local ownerRaw = redis.call('GET', KEYS[3])
local owner = nil
if ownerRaw then
  owner = parse_prefixed(ownerRaw, 'oi:owner:')
  if not owner then return {'oi:resolve-unavailable'} end
end

if resolution == 'create-complete' or resolution == 'delete-rollback' then
  if not owner_matches(owner) then return {'oi:resolve-unavailable'} end
end

op.phase = 'resolving'
op.updatedAt = tonumber(ARGV[8])
redis.call('HSET', KEYS[1], ARGV[1], encode_op(op))
-- fault cut resolve

ownerRaw = redis.call('GET', KEYS[3])
owner = nil
if ownerRaw then
  owner = parse_prefixed(ownerRaw, 'oi:owner:')
  if not owner then return {'oi:resolve-unavailable'} end
end

if resolution == 'create-complete' then
  if not owner_matches(owner) then return {'oi:resolve-unavailable'} end
  redis.call('SADD', KEYS[4], ARGV[1])
elseif resolution == 'delete-rollback' then
  if not owner_matches(owner) then return {'oi:resolve-unavailable'} end
  redis.call('SADD', KEYS[4], ARGV[1])
elseif resolution == 'create-rollback' or resolution == 'delete-complete' then
  if owner_matches(owner) then
    if redis.call('GET', KEYS[3]) == ownerRaw then
      redis.call('DEL', KEYS[3])
    end
  end
  redis.call('SREM', KEYS[4], ARGV[1])
else
  return {'oi:resolve-unavailable'}
end

op.phase = 'publishing'
op.updatedAt = tonumber(ARGV[8])
op.frozenReceipt = expectedReceipt
local publishing = encode_op(op)
redis.call('HSET', KEYS[1], ARGV[1], publishing)
return {'oi:resolve-publishing', publishing}
`;

function resolutionMatchesKind(
  resolution: StudyOperationResolutionV2,
  kind: StudyOperationKind,
): boolean {
  return resolution.startsWith(kind);
}

function decodeResolveWire(wire: unknown): ResolveStudyOperationV2Result {
  const parsed = parseResolveResult(wire);
  if (parsed.status !== 'ok') return { status: 'unavailable' };
  if (parsed.value.outcome === 'publishing') {
    const operation = parsePendingStudyOperationV2(parsed.value.value);
    if (!operation || operation.phase !== 'publishing' || operation.frozenReceipt === null) {
      return { status: 'unavailable' };
    }
    return { status: 'publishing', operation };
  }
  return { status: parsed.value.outcome };
}

export async function resolveStudyOperationV2(
  input: ResolveStudyOperationV2Input,
): Promise<ResolveStudyOperationV2Result> {
  const createdAt = input.createdAt ?? input.now ?? Date.now();
  const now = input.now ?? createdAt;
  if (
    !isResearcherId(input.researcherId)
    || !isUuid(input.studyId)
    || !isHex64(input.storageId)
    || !isGeneration(input.generation)
    || (input.kind !== 'create' && input.kind !== 'delete')
    || !isOpNonce(input.opNonce)
    || !isSafeNonNegativeInt(createdAt)
    || !isSafeNonNegativeInt(now)
    || (
      input.resolution !== 'create-complete'
      && input.resolution !== 'create-rollback'
      && input.resolution !== 'delete-complete'
      && input.resolution !== 'delete-rollback'
    )
    || !resolutionMatchesKind(input.resolution, input.kind)
  ) {
    return { status: 'invalid' };
  }

  const receipt: OperationReceipt = {
    version: 2,
    studyId: input.studyId,
    generation: input.generation,
    kind: input.kind,
    researcherId: input.researcherId,
    resolution: input.resolution,
    createdAt,
  };

  try {
    const wire = await resolveClient(input.client).eval(
      RESOLVE_STUDY_OPERATION_SCRIPT,
      hostedResolveKeys(input.researcherId, input.studyId, input.generation),
      [
        input.studyId,
        input.researcherId,
        input.storageId,
        String(input.generation),
        input.kind,
        input.opNonce,
        input.resolution,
        String(now),
        encodeOperationReceipt(receipt),
      ],
    );
    return decodeResolveWire(wire);
  } catch (error) {
    logRequestFailure({ event: 'platform.unavailable' }, error);
    return { status: mapAmbiguous(error) };
  }
}

export const PUBLISH_STUDY_OPERATION_SCRIPT = `
local function parse_prefixed(value, prefix)
  if type(value) ~= 'string' then return nil end
  if string.sub(value, 1, #prefix) ~= prefix then return nil end
  local ok, obj = pcall(cjson.decode, string.sub(value, #prefix + 1))
  if not ok or type(obj) ~= 'table' then return nil end
  return obj
end

local function parse_lock(value)
  if type(value) ~= 'string' then return nil end
  local parts = {}
  local count = 0
  for part in string.gmatch(value, '[^:]+') do
    count = count + 1
    parts[count] = part
  end
  if count ~= 6 or parts[1] ~= 'oi' or parts[2] ~= 'lock' then return nil end
  local generation = tonumber(parts[3])
  if not generation then return nil end
  if parts[5] ~= 'create' and parts[5] ~= 'delete' then return nil end
  return {
    generation = generation,
    researcherId = parts[4],
    kind = parts[5],
    opNonce = parts[6]
  }
end

local function receipt_equal(left, right)
  if type(left) ~= 'table' or type(right) ~= 'table' then return false end
  return tonumber(left.version) == tonumber(right.version)
    and left.studyId == right.studyId
    and tonumber(left.generation) == tonumber(right.generation)
    and left.kind == right.kind
    and left.researcherId == right.researcherId
    and left.resolution == right.resolution
    and tonumber(left.createdAt) == tonumber(right.createdAt)
end

local function cad_exact_lock()
  local lockRaw = redis.call('GET', KEYS[2])
  if not lockRaw then return true end
  if lockRaw == ARGV[3] then
    if redis.call('GET', KEYS[2]) == ARGV[3] then
      redis.call('DEL', KEYS[2])
    end
    return true
  end
  if not parse_lock(lockRaw) then return false end
  return true
end

local expectedReceipt = parse_prefixed(ARGV[4], 'oi:receipt:')
if not expectedReceipt then return {'oi:publish-unavailable'} end

local member = ARGV[1] .. ':' .. ARGV[2]
local createdAtScore = tonumber(ARGV[5])
if not createdAtScore then return {'oi:publish-unavailable'} end

local function classify_absent()
  local lockRaw = redis.call('GET', KEYS[2])
  if lockRaw and not parse_lock(lockRaw) then return {'oi:publish-unavailable'} end
  local receiptRaw = redis.call('GET', KEYS[3])
  local score = redis.call('ZSCORE', KEYS[4], member)
  local now = tonumber(ARGV[6])
  local ttl = tonumber(ARGV[7])
  if receiptRaw then
    if type(receiptRaw) ~= 'string' or receiptRaw ~= ARGV[4] then
      return {'oi:publish-stale'}
    end
    if not score then
      local added = redis.call('ZADD', KEYS[4], createdAtScore, member)
      -- fault cut PUB2
      return {'oi:publish-published', 'oi:count:' .. tostring(added)}
    end
    if tonumber(score) ~= createdAtScore then
      return {'oi:publish-corrupt'}
    end
    if now and ttl and (now - createdAtScore) >= ttl then
      redis.call('DEL', KEYS[3])
      -- fault cut PRUNE_DEL
      local removed = redis.call('ZREM', KEYS[4], member)
      -- fault cut PRUNE_ZREM
      return {'oi:publish-pruned', 'oi:count:' .. tostring(removed)}
    end
    if not cad_exact_lock() then return {'oi:publish-unavailable'} end
    return {'oi:publish-published', 'oi:count:0'}
  end
  -- Resume prune after PRUNE_DEL: receipt already gone, pinned score remains.
  if score and now and ttl and (now - createdAtScore) >= ttl and tonumber(score) == createdAtScore then
    local removed = redis.call('ZREM', KEYS[4], member)
    -- fault cut PRUNE_ZREM
    return {'oi:publish-pruned', 'oi:count:' .. tostring(removed)}
  end
  return {'oi:publish-stale'}
end

local field = redis.call('HGET', KEYS[1], ARGV[1])
if not field then
  return classify_absent()
end

local op = parse_prefixed(field, 'oi:op:')
if not op or op.phase ~= 'publishing' or not receipt_equal(op.frozenReceipt, expectedReceipt) then
  return {'oi:publish-stale'}
end

local lockProbe = redis.call('GET', KEYS[2])
if lockProbe and lockProbe ~= ARGV[3] and not parse_lock(lockProbe) then
  return {'oi:publish-unavailable'}
end

local receiptRaw = redis.call('GET', KEYS[3])
if not receiptRaw then
  redis.call('SET', KEYS[3], ARGV[4], 'EX', ARGV[7])
  -- fault cut PUB1
elseif type(receiptRaw) ~= 'string' or receiptRaw ~= ARGV[4] then
  return {'oi:publish-stale'}
end

local score = redis.call('ZSCORE', KEYS[4], member)
local delta = 0
if not score then
  delta = redis.call('ZADD', KEYS[4], createdAtScore, member)
  -- fault cut PUB2
elseif tonumber(score) ~= createdAtScore then
  return {'oi:publish-corrupt'}
end

if not cad_exact_lock() then return {'oi:publish-unavailable'} end
-- fault cut PUB3

redis.call('HDEL', KEYS[1], ARGV[1])
-- fault cut PUB4
return {'oi:publish-published', 'oi:count:' .. tostring(delta)}
`;

function decodePublishWire(wire: unknown): PublishStudyOperationV2Result {
  const parsed = parsePublishResult(wire);
  if (parsed.status !== 'ok') return { status: 'unavailable' };
  if (parsed.value.outcome === 'published') {
    return { status: 'published', zaddDelta: parsed.value.count };
  }
  if (parsed.value.outcome === 'pruned') {
    return { status: 'pruned', zremDelta: parsed.value.count };
  }
  return { status: parsed.value.outcome };
}

export async function publishStudyOperationV2(
  input: PublishStudyOperationV2Input,
): Promise<PublishStudyOperationV2Result> {
  const createdAt = input.createdAt ?? input.now ?? Date.now();
  const now = input.now ?? createdAt;
  if (
    !isResearcherId(input.researcherId)
    || !isUuid(input.studyId)
    || !isGeneration(input.generation)
    || (input.kind !== 'create' && input.kind !== 'delete')
    || !isOpNonce(input.opNonce)
    || !isSafeNonNegativeInt(createdAt)
    || !isSafeNonNegativeInt(now)
    || (
      input.resolution !== 'create-complete'
      && input.resolution !== 'create-rollback'
      && input.resolution !== 'delete-complete'
      && input.resolution !== 'delete-rollback'
    )
    || !resolutionMatchesKind(input.resolution, input.kind)
  ) {
    return { status: 'invalid' };
  }

  const receipt: OperationReceipt = {
    version: 2,
    studyId: input.studyId,
    generation: input.generation,
    kind: input.kind,
    researcherId: input.researcherId,
    resolution: input.resolution,
    createdAt,
  };

  try {
    const wire = await resolveClient(input.client).eval(
      PUBLISH_STUDY_OPERATION_SCRIPT,
      hostedPublishKeys(input.researcherId, input.studyId, input.generation),
      [
        input.studyId,
        String(input.generation),
        encodeLockValue({
          generation: input.generation,
          researcherId: input.researcherId,
          kind: input.kind,
          opNonce: input.opNonce,
        }),
        encodeOperationReceipt(receipt),
        String(createdAt),
        String(now),
        String(RECEIPT_TTL_SECONDS),
      ],
    );
    return decodePublishWire(wire);
  } catch (error) {
    logRequestFailure({ event: 'platform.unavailable' }, error);
    return { status: mapAmbiguous(error) };
  }
}
