// Stable create idempotency (Revision 12 §7.2). Hosted mapping lives on
// platform Redis; standalone mapping lives on BYOS Redis. Same record shape.
// Family `idemp` — closed tags only; malformed/ambiguous wire is unavailable
// with zero further writes in that call.

import { createHash, randomUUID } from 'crypto';
import type { RedisPort } from './redisPort';
import { RedisCommitAmbiguousError } from './redisPort';
import { getPlatformClient } from './kvClient';
import { ensurePlatformSchemaLineage, platformKey } from './platformSchema';
import { isHex64, isResearcherId, isUuid } from './wire/types';
import { parseIdempotencyResult, parsePrefixedJson } from './wire/parse';
import type { StoredStudy, StudyConfig } from '@/types';

export const IDEMPOTENCY_TTL_SECONDS = 604_800;
export const MAX_IDEM_MAPPINGS = 100;
export const RETRY_AFTER_PENDING = 5;
export const IDEMPOTENCY_VALUE_PREFIX = 'oi:idemp:';
export const STANDALONE_SCOPE = 'standalone';

export type IdempotencyState = 'pending' | 'created' | 'deleted';

export interface CreateIdempotencyRecord {
  version: 2;
  researcherId: string;
  studyId: string;
  createdAt: number;
  updatedAt: number;
  fingerprint: string;
  state: IdempotencyState;
  operationId: string | null;
  study: StoredStudy;
}

export type BeginCreateIdempotencyResult =
  | { status: 'started' | 'replay'; record: CreateIdempotencyRecord }
  | { status: 'reuse' }
  | { status: 'quota' }
  | { status: 'adel' }
  | { status: 'noacct' }
  | { status: 'hold' }
  | { status: 'unavailable' }
  | { status: 'ambiguous' };

export type CasCreateIdempotencyResult =
  | { status: 'ok'; record: CreateIdempotencyRecord }
  | { status: 'reuse' }
  | { status: 'unavailable' }
  | { status: 'ambiguous' };

const NUL = Buffer.from([0]);

export const BEGIN_CREATE_IDEMPOTENCY_SCRIPT = `
local hosted = (#KEYS == 4)
if (#KEYS ~= 2) and (not hosted) then
  return {'oi:idemp-unavailable'}
end

local function parse_prefixed(value, prefix)
  if type(value) ~= 'string' then return nil end
  if string.sub(value, 1, #prefix) ~= prefix then return nil end
  local ok, obj = pcall(cjson.decode, string.sub(value, #prefix + 1))
  if not ok or type(obj) ~= 'table' then return nil end
  return obj
end

if hosted then
  if redis.call('HEXISTS', KEYS[3], ARGV[6]) == 1 then
    return {'oi:idemp-adel'}
  end
  local account = parse_prefixed(redis.call('GET', KEYS[4]), 'oi:account:')
  if not account or account.id ~= ARGV[6] then
    return {'oi:idemp-noacct'}
  end
end

local function fingerprint_of(value)
  if type(value) ~= 'string' then return nil end
  if string.sub(value, 1, 9) ~= 'oi:idemp:' then return nil end
  local ok, obj = pcall(cjson.decode, string.sub(value, 10))
  if not ok or type(obj) ~= 'table' or type(obj.fingerprint) ~= 'string' then
    return nil
  end
  return obj.fingerprint
end

local function classify_existing(existing)
  local fp = fingerprint_of(existing)
  if not fp then return {'oi:idemp-unavailable'} end
  if fp ~= ARGV[5] then return {'oi:idemp-reuse'} end
  return {'oi:idemp-replay', existing}
end

local existing = redis.call('GET', KEYS[1])
if existing then
  return classify_existing(existing)
end

local max = tonumber(ARGV[4])
if not max then return {'oi:idemp-unavailable'} end
if redis.call('ZCARD', KEYS[2]) >= max then
  return {'oi:idemp-quota'}
end

local set = redis.call('SET', KEYS[1], ARGV[2], 'EX', 604800, 'NX')
if not set then
  existing = redis.call('GET', KEYS[1])
  if not existing then return {'oi:idemp-unavailable'} end
  return classify_existing(existing)
end

redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
return {'oi:idemp-started', ARGV[2]}
`;

export const CAS_CREATE_IDEMPOTENCY_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if type(existing) ~= 'string' or string.sub(existing, 1, 9) ~= 'oi:idemp:' then
  return {'oi:idemp-unavailable'}
end
local ok, obj = pcall(cjson.decode, string.sub(existing, 10))
if not ok or type(obj) ~= 'table' then return {'oi:idemp-unavailable'} end
if type(obj.fingerprint) ~= 'string' or obj.fingerprint ~= ARGV[1] then
  return {'oi:idemp-reuse'}
end

local nextState = ARGV[2]
local now = tonumber(ARGV[3])
if not now then return {'oi:idemp-unavailable'} end
local opId = ARGV[4]
if opId == '' then opId = cjson.null end

local function encode(record)
  return 'oi:idemp:' .. cjson.encode(record)
end

if obj.state == nextState then
  if nextState == 'pending' and opId ~= cjson.null and (obj.operationId == nil or obj.operationId == cjson.null) then
    obj.operationId = opId
    obj.updatedAt = now
    local encoded = encode(obj)
    redis.call('SET', KEYS[1], encoded, 'EX', 604800)
    return {'oi:idemp-replay', encoded}
  end
  return {'oi:idemp-replay', existing}
end

if nextState == 'created' and obj.state ~= 'pending' then
  return {'oi:idemp-unavailable'}
end
if nextState == 'deleted' and obj.state ~= 'pending' and obj.state ~= 'created' then
  return {'oi:idemp-unavailable'}
end
if nextState == 'pending' then
  return {'oi:idemp-unavailable'}
end

obj.state = nextState
obj.updatedAt = now
if opId ~= cjson.null then
  obj.operationId = opId
end
local encoded = encode(obj)
redis.call('SET', KEYS[1], encoded, 'EX', 604800)
return {'oi:idemp-replay', encoded}
`;

export function parseIdempotencyKey(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim();
  return isUuid(key) ? key : null;
}

export function hashCreateIdempotencyKey(
  researcherIdOrStandalone: string,
  rawKey: string,
): string {
  return createHash('sha256')
    .update('oi:create-idempotency:v1')
    .update(NUL)
    .update(researcherIdOrStandalone)
    .update(NUL)
    .update(rawKey)
    .digest('hex');
}

export function canonicalCreateJson(config: StudyConfig): string {
  const { id: _id, createdAt: _createdAt, ...rest } = config;
  return JSON.stringify(sortKeys(rest));
}

export function createFingerprint(config: StudyConfig): string {
  return createHash('sha256')
    .update('oi:create-fp:v1')
    .update(NUL)
    .update(canonicalCreateJson(config))
    .digest('hex');
}

export function resolveCreateIdempotencyClient(
  mode: 'hosted' | 'standalone',
  byosClient: RedisPort,
): RedisPort {
  return mode === 'hosted' ? getPlatformClient() : byosClient;
}

export function createIdempotencyKeys(
  mode: 'hosted' | 'standalone',
  researcherId: string,
  idempotencyHash: string,
): { mapping: string; index: string; journal?: string; researcher?: string } {
  const mappingSuffix = `create-idemp:${idempotencyHash}`;
  const indexSuffix = `create-idemp-index:${researcherId}`;
  if (mode === 'hosted') {
    return {
      mapping: platformKey(mappingSuffix),
      index: platformKey(indexSuffix),
      journal: platformKey('account-delete-journal'),
      researcher: platformKey(`researcher:${researcherId}`),
    };
  }
  return { mapping: mappingSuffix, index: indexSuffix };
}

export function encodeCreateIdempotencyRecord(record: CreateIdempotencyRecord): string {
  return `${IDEMPOTENCY_VALUE_PREFIX}${JSON.stringify(record)}`;
}

export function parseCreateIdempotencyRecord(value: unknown): CreateIdempotencyRecord | null {
  const parsed = parsePrefixedJson(value, IDEMPOTENCY_VALUE_PREFIX);
  if (!parsed.ok) return null;
  const payload = parsed.payload;
  if (payload.version !== 2) return null;
  if (typeof payload.researcherId !== 'string' || !isResearcherId(payload.researcherId)) return null;
  if (typeof payload.studyId !== 'string' || !isUuid(payload.studyId)) return null;
  if (!Number.isSafeInteger(payload.createdAt) || (payload.createdAt as number) < 0) return null;
  if (!Number.isSafeInteger(payload.updatedAt) || (payload.updatedAt as number) < 0) return null;
  if (typeof payload.fingerprint !== 'string' || !isHex64(payload.fingerprint)) return null;
  if (payload.state !== 'pending' && payload.state !== 'created' && payload.state !== 'deleted') {
    return null;
  }
  if (payload.operationId !== null && (typeof payload.operationId !== 'string' || payload.operationId.length === 0)) {
    return null;
  }
  const study = asStoredStudy(payload.study, payload.studyId);
  if (!study) return null;
  return {
    version: 2,
    researcherId: payload.researcherId,
    studyId: payload.studyId,
    createdAt: payload.createdAt as number,
    updatedAt: payload.updatedAt as number,
    fingerprint: payload.fingerprint,
    state: payload.state,
    operationId: payload.operationId as string | null,
    study,
  };
}

export function mintCreateStudy(config: StudyConfig, now = Date.now(), studyId = randomUUID()): StoredStudy {
  const owned: StudyConfig = { ...config, id: studyId, createdAt: now };
  return {
    id: studyId,
    config: owned,
    createdAt: now,
    updatedAt: now,
    interviewCount: 0,
    isLocked: false,
    revision: 1,
  };
}

export async function beginCreateIdempotency(options: {
  client: RedisPort;
  mode: 'hosted' | 'standalone';
  researcherId: string;
  idempotencyKey: string;
  fingerprint: string;
  mintStudy: () => StoredStudy;
  now?: number;
  maxMappings?: number;
}): Promise<BeginCreateIdempotencyResult> {
  const researcherId = options.researcherId;
  if (!isResearcherId(researcherId) || !isUuid(options.idempotencyKey) || !isHex64(options.fingerprint)) {
    return { status: 'unavailable' };
  }

  if (options.mode === 'hosted') {
    try {
      const lineage = await ensurePlatformSchemaLineage(options.client);
      if (lineage === 'hold') return { status: 'hold' };
    } catch {
      return { status: 'unavailable' };
    }
  }

  const hash = hashCreateIdempotencyKey(researcherId, options.idempotencyKey);
  const keys = createIdempotencyKeys(options.mode, researcherId, hash);

  try {
    const existing = await options.client.get(keys.mapping);
    if (existing !== null && existing !== undefined) {
      return classifyExistingMapping(existing, options.fingerprint);
    }

    const now = options.now ?? Date.now();
    const study = options.mintStudy();
    if (!isUuid(study.id) || study.id !== study.config.id) {
      return { status: 'unavailable' };
    }
    const record: CreateIdempotencyRecord = {
      version: 2,
      researcherId,
      studyId: study.id,
      createdAt: study.createdAt,
      updatedAt: now,
      fingerprint: options.fingerprint,
      state: 'pending',
      operationId: null,
      study,
    };
    const encoded = encodeCreateIdempotencyRecord(record);
    const keyList = options.mode === 'hosted'
      ? [keys.mapping, keys.index, keys.journal as string, keys.researcher as string]
      : [keys.mapping, keys.index];
    const wire = await options.client.eval(
      BEGIN_CREATE_IDEMPOTENCY_SCRIPT,
      keyList,
      [
        hash,
        encoded,
        String(now),
        String(options.maxMappings ?? MAX_IDEM_MAPPINGS),
        options.fingerprint,
        researcherId,
      ],
    );
    return decodeBeginWire(wire);
  } catch (error) {
    return decodeCommitError(error);
  }
}

export async function casCreateIdempotencyState(options: {
  client: RedisPort;
  mode: 'hosted' | 'standalone';
  researcherId: string;
  idempotencyKey: string;
  fingerprint: string;
  nextState: IdempotencyState;
  operationId?: string | null;
  now?: number;
}): Promise<CasCreateIdempotencyResult> {
  const hash = hashCreateIdempotencyKey(options.researcherId, options.idempotencyKey);
  const keys = createIdempotencyKeys(options.mode, options.researcherId, hash);
  try {
    const wire = await options.client.eval(
      CAS_CREATE_IDEMPOTENCY_SCRIPT,
      [keys.mapping],
      [
        options.fingerprint,
        options.nextState,
        String(options.now ?? Date.now()),
        options.operationId ?? '',
      ],
    );
    return decodeCasWire(wire);
  } catch (error) {
    const begun = decodeCommitError(error);
    if (begun.status === 'ambiguous') return { status: 'ambiguous' };
    return { status: 'unavailable' };
  }
}

export async function attachCreateIdempotencyOperation(options: {
  client: RedisPort;
  mode: 'hosted' | 'standalone';
  researcherId: string;
  idempotencyKey: string;
  fingerprint: string;
  operationId: string;
  now?: number;
}): Promise<CasCreateIdempotencyResult> {
  return casCreateIdempotencyState({
    ...options,
    nextState: 'pending',
    operationId: options.operationId,
  });
}

function classifyExistingMapping(
  existing: unknown,
  fingerprint: string,
): BeginCreateIdempotencyResult {
  const record = parseCreateIdempotencyRecord(existing);
  if (!record) return { status: 'unavailable' };
  if (record.fingerprint !== fingerprint) return { status: 'reuse' };
  return { status: 'replay', record };
}

function decodeBeginWire(wire: unknown): BeginCreateIdempotencyResult {
  const parsed = parseIdempotencyResult(wire);
  if (parsed.status !== 'ok') return { status: 'unavailable' };
  const outcome = parsed.value;
  if (outcome.outcome === 'adel' || outcome.outcome === 'noacct' || outcome.outcome === 'reuse' || outcome.outcome === 'quota') {
    return { status: outcome.outcome };
  }
  if (outcome.outcome === 'started' || outcome.outcome === 'replay') {
    const record = parseCreateIdempotencyRecord(outcome.value);
    if (!record) return { status: 'unavailable' };
    return { status: outcome.outcome, record };
  }
  return { status: 'unavailable' };
}

function decodeCasWire(wire: unknown): CasCreateIdempotencyResult {
  const parsed = parseIdempotencyResult(wire);
  if (parsed.status !== 'ok') return { status: 'unavailable' };
  if (parsed.value.outcome === 'reuse') return { status: 'reuse' };
  if (parsed.value.outcome === 'replay' || parsed.value.outcome === 'started') {
    const record = parseCreateIdempotencyRecord(parsed.value.value);
    if (!record) return { status: 'unavailable' };
    return { status: 'ok', record };
  }
  return { status: 'unavailable' };
}

function decodeCommitError(error: unknown): BeginCreateIdempotencyResult {
  if (error instanceof RedisCommitAmbiguousError) {
    return error.commitState === 'may-have-committed'
      ? { status: 'ambiguous' }
      : { status: 'unavailable' };
  }
  return { status: 'unavailable' };
}

function asStoredStudy(value: unknown, expectedId: string): StoredStudy | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const study = value as StoredStudy;
  if (study.id !== expectedId || !isUuid(study.id)) return null;
  if (!study.config || typeof study.config !== 'object') return null;
  if (study.config.id !== study.id) return null;
  if (!Number.isSafeInteger(study.createdAt) || study.createdAt < 0) return null;
  if (!Number.isSafeInteger(study.updatedAt) || study.updatedAt < 0) return null;
  if (!Number.isSafeInteger(study.interviewCount) || study.interviewCount < 0) return null;
  if (typeof study.isLocked !== 'boolean') return null;
  if (!Number.isSafeInteger(study.revision) || study.revision < 1) return null;
  return study;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== 'object') return value;
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(input).sort()) {
    output[key] = sortKeys(input[key]);
  }
  return output;
}
