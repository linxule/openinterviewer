// Redis Client Storage Layer
// Supports both standalone (env-var singleton) and hosted (per-researcher dynamic) modes
// All functions accept an optional Redis client parameter for multi-tenant support

import { randomUUID } from 'crypto';
import type { RedisPort } from './redisPort';
import { RedisCommitAmbiguousError } from './redisPort';
import { getKVClient } from './kvClient';
import { resolveDeploymentMode } from './mode';
import {
  StoredInterview,
  StoredStudy,
  StoredAggregateSynthesis,
  SynthesisResult,
  InterviewAnalysisFailureKind,
} from '@/types';
import { HEX64, MAX_STUDY_REVISION, ok, UNAVAILABLE, type WireResult } from './wire/types';
import { parseAnalysisResult, parseFamilyWire, parsePersistResult, parsePrefixedJson, type AnalysisWireOutcome } from './wire/parse';
import { parseStudyCasResult } from './wire/studyCas';
import type { PersistRatePlanRow } from './rateLimit';
import { logRequestFailure } from './requestLog';
import { STUDY_JSON_LUA } from './studyJsonLua';
import type { SynthesisProvenance } from './synthesisProvenance';

// Key prefixes for organizing data
const INTERVIEW_PREFIX = 'interview:';
const STUDY_INDEX_PREFIX = 'study-interviews:';
const STUDY_PREFIX = 'study:';
const ALL_STUDIES_KEY = 'all-studies';
const ALL_INTERVIEWS_KEY = 'all-interviews';
export const STUDY_AGGREGATE_PREFIX = 'study-aggregate:';
export const AGGREGATE_VALUE_PREFIX = 'oi:aggregate:';
export const INTERVIEW_VALUE_PREFIX = 'oi:interview:';
export const STUDY_VALUE_PREFIX = 'oi:study:';
export const FINGERPRINT_VALUE_PREFIX = 'oi:fp:';
export const PERSIST_GUARD_VALUE_PREFIX = 'oi:pguard:';
export const INTERVIEW_PERSISTING_PREFIX = 'interview-persisting:';
export const MAX_PERSIST_RATE_PLAN = 4;

// Helper: resolve the Redis client to use
function resolveClient(client?: RedisPort): RedisPort {
  return client ?? getKVClient();
}

// Get interview by ID
export async function getInterview(id: string, client?: RedisPort): Promise<StoredInterview | null> {
  const result = await getInterviewChecked(id, client);
  if (result.status === 'unavailable') throw new Error('Interview storage is temporarily unavailable');
  return result.status === 'found' ? result.interview : null;
}

export type InterviewLoadResult =
  | { status: 'found'; interview: StoredInterview }
  | { status: 'not-found' }
  | { status: 'unavailable' };

export async function getInterviewChecked(id: string, client?: RedisPort): Promise<InterviewLoadResult> {
  try {
    const kv = resolveClient(client);
    const interview = decodeStoredInterview(await kv.get(`${INTERVIEW_PREFIX}${id}`));
    return interview ? { status: 'found', interview } : { status: 'not-found' };
  } catch (error) {
    logRequestFailure({ event: 'kv.unavailable' }, error);
    return { status: 'unavailable' };
  }
}

// Save interview (create or update).
// This is reserved for trusted maintenance/demo data. Participant completion
// uses persistCompletedInterview() below so completed records are immutable.
export async function saveInterview(interview: StoredInterview, client?: RedisPort): Promise<boolean> {
  try {
    const kv = resolveClient(client);
    // Save the interview
    await kv.set(`${INTERVIEW_PREFIX}${interview.id}`, JSON.stringify(interview));

    // Add to study index for easy lookup by study
    await kv.sadd(`${STUDY_INDEX_PREFIX}${interview.studyId}`, interview.id);

    const mode = resolveDeploymentMode();
    if (!mode.ok || mode.mode !== 'hosted') {
      await kv.sadd(ALL_INTERVIEWS_KEY, interview.id);
    }

    return true;
  } catch (error) {
    logRequestFailure({ event: 'kv.unavailable' }, error);
    return false;
  }
}

export type PersistCompletedInterviewResult =
  | { status: 'created' }
  | { status: 'duplicate' }
  | { status: 'conflict' }
  | { status: 'study-not-found' }
  | { status: 'links-disabled' }
  | { status: 'revision-stale' }
  | { status: 'rate-limited' }
  | { status: 'persist-guard' }
  | { status: 'unavailable' }
  | { status: 'ambiguous' };

export type AtomicRateLimitCounter = PersistRatePlanRow;

export interface PersistingGuard {
  version: 2;
  interviewId: string;
  studyId: string;
  fingerprint: string;
  expectedRevision: number;
  deploymentMode: 'hosted' | 'standalone';
  ratePlan: PersistRatePlanRow[];
  identity: { participantSessionId: string | null; linkId: string | null };
  frozenUpdatedAt: number;
}

export type PersistCompletedInterviewOptions = {
  expectedStudyRevision: number;
  allowDisabledLinks?: boolean;
  rateLimits?: PersistRatePlanRow[];
  identity?: { participantSessionId: string | null; linkId: string | null };
};

function decodeStoredInterview(value: unknown): StoredInterview | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const rec = value as Record<string, unknown>;
    if (typeof rec.id !== 'string' || typeof rec.studyId !== 'string') return null;
    if (rec.status !== 'completed' && rec.status !== 'in_progress') return null;
    if (typeof rec.createdAt !== 'number' || typeof rec.completedAt !== 'number') return null;
    return value as StoredInterview;
  }
  if (typeof value !== 'string' || !value.startsWith(INTERVIEW_VALUE_PREFIX)) return null;
  try {
    return decodeStoredInterview(JSON.parse(value.slice(INTERVIEW_VALUE_PREFIX.length)));
  } catch {
    return null;
  }
}

export function encodeInterviewValue(interview: StoredInterview): string {
  return `${INTERVIEW_VALUE_PREFIX}${JSON.stringify(interview)}`;
}

export function encodeFingerprintValue(fingerprint: string): string {
  return `${FINGERPRINT_VALUE_PREFIX}${fingerprint}`;
}

export function encodePersistingGuard(guard: PersistingGuard): string {
  return `${PERSIST_GUARD_VALUE_PREFIX}${JSON.stringify(guard)}`;
}

export function parsePersistingGuard(value: unknown): PersistingGuard | null {
  const parsed = parsePrefixedJson(value, PERSIST_GUARD_VALUE_PREFIX);
  if (!parsed.ok) return null;
  const payload = parsed.payload;
  if (payload.version !== 2) return null;
  if (typeof payload.interviewId !== 'string' || payload.interviewId.length === 0) return null;
  if (typeof payload.studyId !== 'string' || payload.studyId.length === 0) return null;
  if (typeof payload.fingerprint !== 'string' || !HEX64.test(payload.fingerprint)) return null;
  if (!Number.isSafeInteger(payload.expectedRevision) || (payload.expectedRevision as number) < 1) {
    return null;
  }
  if ((payload.expectedRevision as number) > MAX_STUDY_REVISION) return null;
  if (payload.deploymentMode !== 'hosted' && payload.deploymentMode !== 'standalone') return null;
  if (!Array.isArray(payload.ratePlan) || payload.ratePlan.length > MAX_PERSIST_RATE_PLAN) return null;
  const ratePlan: PersistRatePlanRow[] = [];
  for (const row of payload.ratePlan) {
    if (!row || typeof row !== 'object') return null;
    const rec = row as Record<string, unknown>;
    if (typeof rec.key !== 'string' || !rec.key.startsWith('interview-rate:')) return null;
    if (!Number.isSafeInteger(rec.maximum) || (rec.maximum as number) < 1) return null;
    if (!Number.isSafeInteger(rec.windowSeconds) || (rec.windowSeconds as number) < 1) return null;
    if (!Number.isSafeInteger(rec.windowStart) || (rec.windowStart as number) < 0) return null;
    ratePlan.push({
      key: rec.key,
      maximum: rec.maximum as number,
      windowSeconds: rec.windowSeconds as number,
      windowStart: rec.windowStart as number,
    });
  }
  const identity = payload.identity;
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return null;
  const identityRec = identity as Record<string, unknown>;
  if (identityRec.participantSessionId !== null && typeof identityRec.participantSessionId !== 'string') {
    return null;
  }
  if (identityRec.linkId !== null && typeof identityRec.linkId !== 'string') return null;
  if (!Number.isSafeInteger(payload.frozenUpdatedAt) || (payload.frozenUpdatedAt as number) < 0) {
    return null;
  }
  return {
    version: 2,
    interviewId: payload.interviewId,
    studyId: payload.studyId,
    fingerprint: payload.fingerprint,
    expectedRevision: payload.expectedRevision as number,
    deploymentMode: payload.deploymentMode,
    ratePlan,
    identity: {
      participantSessionId: identityRec.participantSessionId as string | null,
      linkId: identityRec.linkId as string | null,
    },
    frozenUpdatedAt: payload.frozenUpdatedAt as number,
  };
}

function persistOutcome(
  wire: unknown
): PersistCompletedInterviewResult {
  const parsed = parsePersistResult(wire);
  if (parsed.status !== 'ok') return { status: 'unavailable' };
  switch (parsed.value.outcome) {
    case 'created':
      return { status: 'created' };
    case 'duplicate':
      return { status: 'duplicate' };
    case 'conflict':
      return { status: 'conflict' };
    case 'not-found':
      return { status: 'study-not-found' };
    case 'links-disabled':
      return { status: 'links-disabled' };
    case 'revision-stale':
      return { status: 'revision-stale' };
    case 'rate-limited':
      return { status: 'rate-limited' };
    case 'guard':
      return { status: 'persist-guard' };
    case 'started':
      return { status: 'unavailable' };
    default:
      return { status: 'unavailable' };
  }
}

function persistKeys(
  interview: { id: string; studyId: string },
  mode: 'hosted' | 'standalone',
  ratePlan: PersistRatePlanRow[]
): string[] {
  const rateKeys = [
    ratePlan[0]?.key ?? '',
    ratePlan[1]?.key ?? '',
    ratePlan[2]?.key ?? '',
    ratePlan[3]?.key ?? '',
  ];
  const keys = [
    `${INTERVIEW_PREFIX}${interview.id}`,
    `interview-fingerprint:${interview.id}`,
    `${INTERVIEW_PERSISTING_PREFIX}${interview.id}`,
    `${STUDY_PERSISTING_PREFIX}${interview.studyId}`,
    `${STUDY_PREFIX}${interview.studyId}`,
    `${STUDY_MUTATION_GUARD_PREFIX}${interview.studyId}`,
    `${STUDY_INDEX_PREFIX}${interview.studyId}`,
    ...rateKeys,
  ];
  if (mode === 'standalone') keys.push(ALL_INTERVIEWS_KEY);
  return keys;
}

function persistP1Args(
  interview: StoredInterview,
  fingerprint: string,
  guard: PersistingGuard,
  options: PersistCompletedInterviewOptions
): string[] {
  const maxima = [0, 1, 2, 3].map(index => String(guard.ratePlan[index]?.maximum ?? 0));
  return [
    encodeInterviewValue(interview),
    encodeFingerprintValue(fingerprint),
    encodePersistingGuard(guard),
    interview.id,
    String(options.expectedStudyRevision),
    options.allowDisabledLinks ? '1' : '0',
    guard.deploymentMode,
    guard.identity.participantSessionId ?? '',
    guard.identity.linkId ?? '',
    ...maxima,
  ];
}

function persistFinishArgs(guard: PersistingGuard): string[] {
  const windows = [0, 1, 2, 3].map(index => String(guard.ratePlan[index]?.windowSeconds ?? 0));
  return [
    encodeFingerprintValue(guard.fingerprint),
    guard.interviewId,
    String(guard.expectedRevision),
    guard.deploymentMode,
    guard.identity.participantSessionId ?? '',
    guard.identity.linkId ?? '',
    ...windows,
  ];
}

export const PERSIST_COMPLETED_INTERVIEW_P1_SCRIPT = `
local function decode_json(value, prefix)
  if type(value) ~= 'string' or string.sub(value, 1, #prefix) ~= prefix then return nil end
  local ok, obj = pcall(cjson.decode, string.sub(value, #prefix + 1))
  if not ok or type(obj) ~= 'table' then return nil end
  return obj
end

local function decode_study(raw)
  if type(raw) ~= 'string' then return nil, false end
  local prefixed = string.sub(raw, 1, 9) == 'oi:study:'
  local payload = prefixed and string.sub(raw, 10) or raw
  local ok, obj = pcall(cjson.decode, payload)
  if not ok or type(obj) ~= 'table' then return nil, prefixed end
  return obj, prefixed
end

local function decode_fp(value)
  if type(value) ~= 'string' or string.sub(value, 1, 6) ~= 'oi:fp:' then return nil end
  return string.sub(value, 7)
end

local function valid_immutable(obj, interviewId, studyId)
  if type(obj) ~= 'table' then return false end
  if obj.id ~= interviewId or obj.studyId ~= studyId then return false end
  if obj.status ~= 'completed' then return false end
  if tonumber(obj.createdAt) == nil or tonumber(obj.completedAt) == nil then return false end
  return true
end

local mode = ARGV[7]
if mode ~= 'standalone' and mode ~= 'hosted' then
  return {'oi:persist-unavailable'}
end
if mode == 'hosted' and #KEYS ~= 11 then
  return {'oi:persist-unavailable'}
end
if mode == 'standalone' and #KEYS ~= 12 then
  return {'oi:persist-unavailable'}
end

local study, _prefixed = decode_study(redis.call('GET', KEYS[5]))
if not study then
  return {'oi:persist-not-found'}
end
if ARGV[6] ~= '1' and study.config and study.config.linksEnabled == false then
  return {'oi:persist-links'}
end
if (tonumber(study.revision) or 1) ~= tonumber(ARGV[5]) then
  return {'oi:persist-revision'}
end

local mutation = decode_json(redis.call('GET', KEYS[6]), 'oi:smg:')
local existingInterviewRaw = redis.call('GET', KEYS[1])
local existingFp = decode_fp(redis.call('GET', KEYS[2]))
local existingGuard = decode_json(redis.call('GET', KEYS[3]), 'oi:pguard:')
local requestFp = decode_fp(ARGV[2])
if not requestFp then
  return {'oi:persist-unavailable'}
end

local matchingRetry = false
if existingGuard then
  if existingGuard.fingerprint ~= requestFp
    or existingGuard.interviewId ~= ARGV[4]
    or existingGuard.studyId ~= study.id
    or existingGuard.deploymentMode ~= mode
    or tostring(existingGuard.expectedRevision) ~= ARGV[5]
    or (existingGuard.identity and existingGuard.identity.participantSessionId or '') ~= ARGV[8]
    or (existingGuard.identity and existingGuard.identity.linkId or '') ~= ARGV[9]
  then
    return {'oi:persist-conflict'}
  end
  matchingRetry = true
end

if existingInterviewRaw or existingFp then
  local stored = decode_json(existingInterviewRaw, 'oi:interview:')
  if not stored then
    stored = decode_study(existingInterviewRaw)
  end
  if existingFp and existingFp ~= requestFp then
    return {'oi:persist-conflict'}
  end
  if stored and (stored.id ~= ARGV[4] or stored.studyId ~= study.id) then
    return {'oi:persist-conflict'}
  end
  if stored and not valid_immutable(stored, ARGV[4], study.id) then
    return {'oi:persist-conflict'}
  end
  if existingFp == requestFp and stored and redis.call('SISMEMBER', KEYS[7], ARGV[4]) == 1 and not existingGuard then
    return {'oi:persist-duplicate'}
  end
  matchingRetry = true
end

if mutation and mutation.state ~= 'created' and not matchingRetry then
  -- fault cut persist-cancel
  -- fault cut persist-deleted
  return {'oi:persist-guard'}
end

if not matchingRetry then
  for i = 1, 4 do
    local rateKey = KEYS[7 + i]
    if rateKey ~= '' then
      local maximum = tonumber(ARGV[9 + i]) or 0
      local score = redis.call('ZSCORE', rateKey, ARGV[4])
      if not score and redis.call('ZCARD', rateKey) >= maximum and maximum > 0 then
        return {'oi:persist-rate'}
      end
    end
  end
  redis.call('SET', KEYS[1], ARGV[1], 'NX')
  redis.call('SET', KEYS[2], ARGV[2], 'NX')
end

if existingInterviewRaw and not redis.call('GET', KEYS[2]) then
  redis.call('SET', KEYS[2], ARGV[2], 'NX')
  if decode_fp(redis.call('GET', KEYS[2])) ~= requestFp then
    return {'oi:persist-conflict'}
  end
end

if not existingGuard then
  redis.call('SET', KEYS[3], ARGV[3])
end
redis.call('SADD', KEYS[4], ARGV[4])
return {'oi:persist-started'}
`;

export const PERSIST_COMPLETED_INTERVIEW_FINISH_SCRIPT = `${STUDY_JSON_LUA}
local function decode_json(value, prefix)
  if type(value) ~= 'string' or string.sub(value, 1, #prefix) ~= prefix then return nil end
  local ok, obj = pcall(cjson.decode, string.sub(value, #prefix + 1))
  if not ok or type(obj) ~= 'table' then return nil end
  return obj
end

local function decode_study(raw)
  if type(raw) ~= 'string' then return nil, false end
  local prefixed = string.sub(raw, 1, 9) == 'oi:study:'
  local payload = prefixed and string.sub(raw, 10) or raw
  local ok, obj = pcall(cjson.decode, payload)
  if not ok or type(obj) ~= 'table' then return nil, prefixed end
  return obj, prefixed, payload
end

local function decode_fp(value)
  if type(value) ~= 'string' or string.sub(value, 1, 6) ~= 'oi:fp:' then return nil end
  return string.sub(value, 7)
end

local function valid_immutable(obj, interviewId, studyId)
  if type(obj) ~= 'table' then return false end
  if obj.id ~= interviewId or obj.studyId ~= studyId then return false end
  if obj.status ~= 'completed' then return false end
  if tonumber(obj.createdAt) == nil or tonumber(obj.completedAt) == nil then return false end
  return true
end

local mode = ARGV[4]
if mode ~= 'standalone' and mode ~= 'hosted' then
  return {'oi:persist-unavailable'}
end
if mode == 'hosted' and #KEYS ~= 11 then
  return {'oi:persist-unavailable'}
end
if mode == 'standalone' and #KEYS ~= 12 then
  return {'oi:persist-unavailable'}
end

local requestFp = decode_fp(ARGV[1])
local guard = decode_json(redis.call('GET', KEYS[3]), 'oi:pguard:')
if not guard then
  local stored = decode_json(redis.call('GET', KEYS[1]), 'oi:interview:')
  local existingFp = decode_fp(redis.call('GET', KEYS[2]))
  if stored and existingFp == requestFp and valid_immutable(stored, ARGV[2], stored.studyId) and redis.call('SISMEMBER', KEYS[7], ARGV[2]) == 1 then
    return {'oi:persist-duplicate'}
  end
  return {'oi:persist-unavailable'}
end

if guard.interviewId ~= ARGV[2]
  or guard.fingerprint ~= requestFp
  or guard.deploymentMode ~= mode
  or tostring(guard.expectedRevision) ~= ARGV[3]
  or (guard.identity and guard.identity.participantSessionId or '') ~= ARGV[5]
  or (guard.identity and guard.identity.linkId or '') ~= ARGV[6]
then
  -- fault cut persist-conflict
  return {'oi:persist-conflict'}
end

local stored = decode_json(redis.call('GET', KEYS[1]), 'oi:interview:')
local existingFp = decode_fp(redis.call('GET', KEYS[2]))
if not stored or existingFp ~= requestFp or not valid_immutable(stored, guard.interviewId, guard.studyId) then
  return {'oi:persist-conflict'}
end

local study, studyPrefixed, studyJson = decode_study(redis.call('GET', KEYS[5]))
if not study or study.id ~= guard.studyId then
  return {'oi:persist-not-found'}
end
if (tonumber(study.revision) or 1) ~= tonumber(guard.expectedRevision) then
  return {'oi:persist-revision'}
end

redis.call('SADD', KEYS[7], ARGV[2])
-- fault cut F1
if mode == 'standalone' then
  redis.call('SADD', KEYS[12], ARGV[2])
end

local updatedJson = patch_json_object(studyJson, {
  {'interviewCount', tostring(redis.call('SCARD', KEYS[7]))},
  {'isLocked', 'true'},
  {'updatedAt', string.format('%.0f', tonumber(guard.frozenUpdatedAt))}
})
redis.call('SET', KEYS[5], encode_study(updatedJson, studyPrefixed))
-- fault cut F2

for i = 1, 4 do
  local rateKey = KEYS[7 + i]
  if rateKey ~= '' then
    redis.call('ZADD', rateKey, 1, ARGV[2])
    -- fault cut F3
    local window = tonumber(ARGV[6 + i]) or 0
    if window > 0 then
      redis.call('EXPIRE', rateKey, window + 60)
      -- fault cut F4
    end
  end
end

-- fault cut F5
-- fault cut persist-guard-cleanup
redis.call('DEL', KEYS[3])
redis.call('SREM', KEYS[4], ARGV[2])
return {'oi:persist-created'}
`;

function mapPersistCommitError(error: unknown): PersistCompletedInterviewResult {
  if (error instanceof RedisCommitAmbiguousError) {
    return { status: error.commitState === 'may-have-committed' ? 'ambiguous' : 'unavailable' };
  }
  return { status: 'unavailable' };
}

export async function persistCompletedInterviewP1(
  interview: StoredInterview,
  submissionFingerprint: string,
  options: PersistCompletedInterviewOptions,
  client?: RedisPort
): Promise<PersistCompletedInterviewResult | { status: 'started'; guard: PersistingGuard }> {
  const resolvedMode = resolveDeploymentMode();
  if (!resolvedMode.ok) return { status: 'unavailable' };
  if (!HEX64.test(submissionFingerprint)) return { status: 'unavailable' };
  if (
    !Number.isSafeInteger(options.expectedStudyRevision)
    || options.expectedStudyRevision < 1
    || options.expectedStudyRevision > MAX_STUDY_REVISION
  ) {
    return { status: 'unavailable' };
  }
  const ratePlan = (options.rateLimits ?? []).slice(0, MAX_PERSIST_RATE_PLAN);
  if ((options.rateLimits?.length ?? 0) > MAX_PERSIST_RATE_PLAN) return { status: 'unavailable' };
  if (ratePlan.some(row => !row.key.startsWith('interview-rate:'))) return { status: 'unavailable' };

  const guard: PersistingGuard = {
    version: 2,
    interviewId: interview.id,
    studyId: interview.studyId,
    fingerprint: submissionFingerprint,
    expectedRevision: options.expectedStudyRevision,
    deploymentMode: resolvedMode.mode,
    ratePlan,
    identity: {
      participantSessionId: options.identity?.participantSessionId ?? null,
      linkId: options.identity?.linkId ?? null,
    },
    frozenUpdatedAt: Date.now(),
  };

  try {
    const wire = await resolveClient(client).eval(
      PERSIST_COMPLETED_INTERVIEW_P1_SCRIPT,
      persistKeys(interview, resolvedMode.mode, ratePlan),
      persistP1Args(interview, submissionFingerprint, guard, options)
    );
    const parsed = parsePersistResult(wire);
    if (parsed.status !== 'ok') return { status: 'unavailable' };
    if (parsed.value.outcome === 'started') return { status: 'started', guard };
    return persistOutcome(wire);
  } catch (error) {
    logRequestFailure({ event: 'kv.unavailable' }, error);
    return mapPersistCommitError(error);
  }
}

export async function persistCompletedInterviewFinish(
  guard: PersistingGuard,
  client?: RedisPort
): Promise<PersistCompletedInterviewResult> {
  const resolvedMode = resolveDeploymentMode();
  if (!resolvedMode.ok || resolvedMode.mode !== guard.deploymentMode) {
    return { status: 'unavailable' };
  }
  try {
    const wire = await resolveClient(client).eval(
      PERSIST_COMPLETED_INTERVIEW_FINISH_SCRIPT,
      persistKeys({ id: guard.interviewId, studyId: guard.studyId }, resolvedMode.mode, guard.ratePlan),
      persistFinishArgs(guard)
    );
    const parsed = parsePersistResult(wire);
    if (parsed.status !== 'ok') return { status: 'unavailable' };
    if (parsed.value.outcome === 'started') return { status: 'unavailable' };
    return persistOutcome(wire);
  } catch (error) {
    logRequestFailure({ event: 'kv.unavailable' }, error);
    return mapPersistCommitError(error);
  }
}

/**
 * Crash-total participant completion: P1 writes interview + fingerprint +
 * persisting guard without indexes or rate ZADDs; Finish is the exact retry
 * that SADD indexes, locks the study, ZADDs once, then deletes the guard.
 */
export async function persistCompletedInterview(
  interview: StoredInterview,
  submissionFingerprint: string,
  options: PersistCompletedInterviewOptions,
  client?: RedisPort
): Promise<PersistCompletedInterviewResult> {
  const p1 = await persistCompletedInterviewP1(interview, submissionFingerprint, options, client);
  if (p1.status !== 'started') return p1;

  const kv = resolveClient(client);
  let frozen = p1.guard;
  try {
    const storedGuard = parsePersistingGuard(
      await kv.get(`${INTERVIEW_PERSISTING_PREFIX}${interview.id}`)
    );
    if (storedGuard) frozen = storedGuard;
  } catch (error) {
    logRequestFailure({ event: 'kv.unavailable' }, error);
    return mapPersistCommitError(error);
  }

  return persistCompletedInterviewFinish(frozen, client);
}

// ---------------------------------------------------------------------------
// Slice P: the analysis writer. One new script, one key, one read and at most
// one SET per call — there is no multi-write prefix here and therefore no new
// fault cut. Two runs racing to analyze the same interview both call
// claimInterviewAnalysis; the CAS inside the script guarantees exactly one
// gets 'claimed' and the loser never reaches the provider.
// ---------------------------------------------------------------------------

const INTERVIEW_ID_TOKEN = /^[A-Za-z0-9_-]{1,120}$/;

/** The serialized ceiling for one attached synthesis — the same number as
 *  MAX_STORED_AGGREGATE_BYTES, checked before the client is resolved so an
 *  oversized synthesis costs no Redis round trip. */
export const MAX_ATTACHED_SYNTHESIS_BYTES = 256_000;
/** How long one claim holds the record before another run may take over. */
export const ANALYSIS_CLAIM_LEASE_MS = 180_000;

export type ClaimAnalysisResult =
  | { status: 'claimed'; claimId: string; attempts: number }
  | { status: 'busy' | 'already-complete' | 'not-found' | 'unavailable' };

export type AttachAnalysisResult =
  { status: 'written' | 'already-complete' | 'stale' | 'too-large' | 'not-found' | 'unavailable' };

/**
 * KEYS[1] interview:<id>   ARGV[1] op 'claim'|'complete'|'fail'
 * ARGV[2] interviewId      ARGV[3] nowMs   ARGV[4] leaseMs
 * ARGV[5] claimId (claim: the new token; complete/fail: the token held)
 * ARGV[6] the replacement `analysis` metadata as JSON text; the script owns
 *   attempts and preserves the running attempt's lastAttemptAt on completion
 * ARGV[7] complete only: the `synthesis` member as JSON text; '' otherwise
 * ARGV[8] complete only: a flat JSON object of the provenance members
 *   (aiProvider/aiModel/requestedAiModel/routedProvider) to patch alongside
 *   `analysis` and `synthesis`, so a record never carries a synthesis
 *   without the model that produced it; '{}' otherwise
 */
export const ATTACH_INTERVIEW_ANALYSIS_SCRIPT = `${STUDY_JSON_LUA}
local function decode_interview(raw)
  if type(raw) ~= 'string' or string.sub(raw, 1, 13) ~= 'oi:interview:' then return nil end
  local payload = string.sub(raw, 14)
  local ok, obj = pcall(cjson.decode, payload)
  if not ok or type(obj) ~= 'table' then return nil end
  return obj, payload
end

local interview, body = decode_interview(redis.call('GET', KEYS[1]))
if not interview then return {'oi:analysis-notfound'} end
if interview.status ~= 'completed' or interview.id ~= ARGV[2] then
  return {'oi:analysis-notfound'}
end
if type(interview.studyId) ~= 'string' or type(interview.createdAt) ~= 'number' or type(interview.completedAt) ~= 'number' then
  return {'oi:analysis-unavailable'}
end

local op = ARGV[1]
local nowMs = tonumber(ARGV[3])
local leaseMs = tonumber(ARGV[4])
local claimId = ARGV[5]

-- Effective state: the same derivation as the read-side analysisStatus(), so
-- a legacy record (no analysis member) cannot be re-analyzed by accident.
local analysisRaw = json_object_value(body, 'analysis')
local state = nil
if analysisRaw and analysisRaw ~= 'null' then
  local dok, decoded = pcall(cjson.decode, analysisRaw)
  if dok and type(decoded) == 'table' then state = decoded end
end

local effectiveStatus
local effectiveClaimId
local effectiveClaimedAt
local attempts = 0
if state then
  effectiveStatus = state.status
  effectiveClaimId = state.claimId
  effectiveClaimedAt = tonumber(state.claimedAt)
  attempts = state.attempts
  if type(attempts) ~= 'number' or attempts < 0 or attempts > 9007199254740991 or attempts ~= math.floor(attempts) then
    return {'oi:analysis-unavailable'}
  end
else
  local synthesisRaw = json_object_value(body, 'synthesis')
  effectiveStatus = (synthesisRaw and synthesisRaw ~= 'null') and 'complete' or 'pending'
end

if op == 'claim' then
  if effectiveStatus == 'complete' then return {'oi:analysis-done'} end
  if effectiveStatus == 'running' and effectiveClaimedAt and (nowMs - effectiveClaimedAt) < leaseMs then
    return {'oi:analysis-busy'}
  end
  if attempts >= 9007199254740991 then return {'oi:analysis-unavailable'} end
  local nextAttempts = string.format('%.0f', attempts + 1)
  local nextAnalysis = patch_json_object(ARGV[6], {{'attempts', nextAttempts}})
  local patched = patch_json_object(body, {{'analysis', nextAnalysis}})
  redis.call('SET', KEYS[1], 'oi:interview:' .. patched)
  return {'oi:analysis-claimed', 'oi:count:' .. nextAttempts}
end

if effectiveStatus == 'complete' then return {'oi:analysis-done'} end
if effectiveStatus ~= 'running' or effectiveClaimId ~= claimId then
  return {'oi:analysis-stale'}
end

-- Counters and the attempt-start timestamp come from this claimed record,
-- never a GET taken before a contender's claim or failure became visible.
local lastAttemptAt = json_object_value(analysisRaw, 'lastAttemptAt')
if not lastAttemptAt then return {'oi:analysis-unavailable'} end
local nextAnalysis = patch_json_object(ARGV[6], {
  {'attempts', string.format('%.0f', attempts)},
  {'lastAttemptAt', lastAttemptAt}
})

if op == 'complete' then
  local updates = {{'analysis', nextAnalysis}, {'synthesis', ARGV[7]}}
  for _, member in ipairs(json_object_members(ARGV[8])) do
    updates[#updates + 1] = {member.key, member.value}
  end
  local patched = patch_json_object(body, updates)
  redis.call('SET', KEYS[1], 'oi:interview:' .. patched)
  return {'oi:analysis-written'}
end

if op == 'fail' then
  local patched = patch_json_object(body, {{'analysis', nextAnalysis}})
  redis.call('SET', KEYS[1], 'oi:interview:' .. patched)
  return {'oi:analysis-recorded'}
end

return {'oi:analysis-unavailable'}
`;

async function evalAttachAnalysis(
  op: 'claim' | 'complete' | 'fail',
  interviewId: string,
  claimId: string,
  analysisMember: string,
  synthesisMember: string,
  provenanceMember: string,
  client?: RedisPort,
  nowMs: number = Date.now(),
): Promise<AnalysisWireOutcome | null> {
  const wire = await resolveClient(client).eval(
    ATTACH_INTERVIEW_ANALYSIS_SCRIPT,
    [`${INTERVIEW_PREFIX}${interviewId}`],
    [op, interviewId, String(nowMs), String(ANALYSIS_CLAIM_LEASE_MS), claimId, analysisMember, synthesisMember, provenanceMember]
  );
  const parsed = parseAnalysisResult(wire);
  return parsed.status === 'ok' ? parsed.value : null;
}

export async function claimInterviewAnalysis(
  interviewId: string,
  client?: RedisPort,
  nowMs: number = Date.now(),
): Promise<ClaimAnalysisResult> {
  if (!INTERVIEW_ID_TOKEN.test(interviewId)) return { status: 'unavailable' };
  const claimId = randomUUID();
  const analysisMember = JSON.stringify({
    status: 'running',
    lastAttemptAt: nowMs,
    claimId,
    claimedAt: nowMs,
  });

  try {
    const outcome = await evalAttachAnalysis('claim', interviewId, claimId, analysisMember, '', '{}', client, nowMs);
    if (!outcome) return { status: 'unavailable' };
    switch (outcome.outcome) {
      case 'claimed':
        return { status: 'claimed', claimId, attempts: outcome.attempts };
      case 'busy':
        return { status: 'busy' };
      case 'done':
        return { status: 'already-complete' };
      case 'notfound':
        return { status: 'not-found' };
      default:
        return { status: 'unavailable' };
    }
  } catch (error) {
    logRequestFailure({ event: 'kv.unavailable' }, error);
    return { status: 'unavailable' };
  }
}

export async function attachInterviewAnalysis(
  input: {
    interviewId: string;
    claimId: string;
    synthesis: SynthesisResult;
    provenance: SynthesisProvenance;
    studyRevision: number;
  },
  client?: RedisPort,
): Promise<AttachAnalysisResult> {
  if (!INTERVIEW_ID_TOKEN.test(input.interviewId)) return { status: 'unavailable' };
  const nowMs = Date.now();
  const synthesisMember = JSON.stringify(input.synthesis);
  const synthesisBytes = new TextEncoder().encode(synthesisMember).byteLength;
  if (synthesisBytes > MAX_ATTACHED_SYNTHESIS_BYTES) return { status: 'too-large' };
  const provenanceMember = JSON.stringify({
    aiProvider: input.provenance.aiProvider,
    aiModel: input.provenance.aiModel,
    requestedAiModel: input.provenance.requestedAiModel,
    ...(input.provenance.routedProvider !== undefined
      ? { routedProvider: input.provenance.routedProvider }
      : {}),
  });

  try {
    const analysisMember = JSON.stringify({
      status: 'complete',
      studyRevision: input.studyRevision,
    });
    const outcome = await evalAttachAnalysis(
      'complete', input.interviewId, input.claimId, analysisMember, synthesisMember, provenanceMember, client, nowMs,
    );
    if (!outcome) return { status: 'unavailable' };
    switch (outcome.outcome) {
      case 'written':
        return { status: 'written' };
      case 'done':
        return { status: 'already-complete' };
      case 'stale':
        return { status: 'stale' };
      case 'notfound':
        return { status: 'not-found' };
      default:
        return { status: 'unavailable' };
    }
  } catch (error) {
    logRequestFailure({ event: 'kv.unavailable' }, error);
    return { status: 'unavailable' };
  }
}

export async function recordInterviewAnalysisFailure(
  interviewId: string,
  claimId: string,
  failureKind: InterviewAnalysisFailureKind,
  client?: RedisPort,
): Promise<AttachAnalysisResult> {
  if (!INTERVIEW_ID_TOKEN.test(interviewId)) return { status: 'unavailable' };
  const nowMs = Date.now();
  try {
    const analysisMember = JSON.stringify({
      status: 'failed',
      failureKind,
    });
    const outcome = await evalAttachAnalysis('fail', interviewId, claimId, analysisMember, '', '{}', client, nowMs);
    if (!outcome) return { status: 'unavailable' };
    switch (outcome.outcome) {
      case 'recorded':
        return { status: 'written' };
      case 'done':
        return { status: 'already-complete' };
      case 'stale':
        return { status: 'stale' };
      case 'notfound':
        return { status: 'not-found' };
      default:
        return { status: 'unavailable' };
    }
  } catch (error) {
    logRequestFailure({ event: 'kv.unavailable' }, error);
    return { status: 'unavailable' };
  }
}

export type CollectionLoadResult<T> =
  | { status: 'ok'; items: T[] }
  | { status: 'too-large'; count: number; maximum: number }
  | { status: 'unavailable' };

async function getInterviewCollectionChecked(
  indexKey: string,
  client?: RedisPort,
  maximum = 5_000
): Promise<CollectionLoadResult<StoredInterview>> {
  try {
    const kv = resolveClient(client);
    const count = await kv.scard(indexKey);
    if (count > maximum) return { status: 'too-large', count, maximum };
    const ids = (await kv.smembers(indexKey)) as string[];
    if (!ids || ids.length === 0) return { status: 'ok', items: [] };
    if (ids.length > maximum) return { status: 'too-large', count: ids.length, maximum };

    const interviews = await Promise.all(
      ids.map(id => kv.get(`${INTERVIEW_PREFIX}${id}`))
    );

    return {
      status: 'ok',
      items: interviews
        .map(decodeStoredInterview)
        .filter((i): i is StoredInterview => i !== null)
        .sort((a, b) => b.createdAt - a.createdAt),
    };
  } catch (error) {
    logRequestFailure({ event: 'kv.unavailable' }, error);
    return { status: 'unavailable' };
  }
}

export async function getAllInterviewsChecked(
  client?: RedisPort,
  maximum = 5_000
): Promise<CollectionLoadResult<StoredInterview>> {
  return getInterviewCollectionChecked('all-interviews', client, maximum);
}

// Get all interviews. Prefer the checked variant in request handlers.
export async function getAllInterviews(client?: RedisPort): Promise<StoredInterview[]> {
  const result = await getAllInterviewsChecked(client);
  if (result.status !== 'ok') throw new Error(`Interview collection ${result.status}`);
  return result.items;
}

// Get interviews for a specific study
export async function getStudyInterviews(studyId: string, client?: RedisPort): Promise<StoredInterview[]> {
  const result = await getStudyInterviewsChecked(studyId, client);
  if (result.status !== 'ok') throw new Error(`Study interview collection ${result.status}`);
  return result.items;
}

export async function getStudyInterviewsChecked(
  studyId: string,
  client?: RedisPort,
  maximum = 5_000
): Promise<CollectionLoadResult<StoredInterview>> {
  return getInterviewCollectionChecked(`${STUDY_INDEX_PREFIX}${studyId}`, client, maximum);
}

// Delete interview
export async function deleteInterview(id: string, studyId: string, client?: RedisPort): Promise<boolean> {
  try {
    const kv = resolveClient(client);
    await kv.del(`${INTERVIEW_PREFIX}${id}`);
    await kv.srem(`${STUDY_INDEX_PREFIX}${studyId}`, id);
    await kv.srem('all-interviews', id);
    return true;
  } catch (error) {
    logRequestFailure({ event: 'kv.unavailable' }, error);
    return false;
  }
}

// Check if KV is available (for development without KV)
export async function isKVAvailable(client?: RedisPort): Promise<boolean> {
  try {
    const kv = resolveClient(client);
    await kv.ping();
    return true;
  } catch {
    return false;
  }
}

// ============================================
// Study Storage Functions
// ============================================

// Save study (create or update)
export async function saveStudy(study: StoredStudy, client?: RedisPort): Promise<boolean> {
  try {
    const kv = resolveClient(client);
    await kv.set(`${STUDY_PREFIX}${study.id}`, JSON.stringify(study));
    await kv.sadd(ALL_STUDIES_KEY, study.id);
    return true;
  } catch (error) {
    logRequestFailure({ event: 'kv.unavailable' }, error);
    return false;
  }
}

export type CreateStudyResult =
  | 'created'
  | 'conflict'
  | 'cancelled'
  | 'unavailable'
  | 'ambiguous';

export type DeleteStudyStatus =
  | 'deleted'
  | 'cancelled'
  | 'not-found'
  | 'conflict'
  | 'still-pending'
  | 'unavailable'
  | 'ambiguous';

export type DeleteStudyResult = {
  status: DeleteStudyStatus;
  success: boolean;
  error?: string;
  code?: 'STUDY_PERSIST_PENDING';
  reason?: 'ambiguous';
};

export type CreateDeleteWireOutcome =
  | { outcome: 'created' }
  | { outcome: 'deleted' }
  | { outcome: 'cancelled' }
  | { outcome: 'still-pending' }
  | { outcome: 'not-found' }
  | { outcome: 'conflict'; revision: number }
  | { outcome: 'invalid' };

export type StandaloneReceiptResolution = 'created' | 'deleted' | 'cancelled';

export interface StandaloneOperationReceipt {
  version: 2;
  studyId: string;
  kind: 'create' | 'delete';
  researcherId: string;
  resolution: StandaloneReceiptResolution;
  markerId: string;
  createdAt: number;
  generation: number;
  idempotencyHash: string | null;
}

export interface StudyMutationGuard {
  version: 2;
  studyId: string;
  kind: 'create' | 'delete';
  generation: number;
  state: 'in-flight' | 'cancelled' | 'deleted' | 'created';
  markerId: string;
}

export const RECEIPT_TTL_SECONDS = 604_800;
export const STUDY_OPERATION_MARKER_PREFIX = 'study-operation-result:';
export const STUDY_MUTATION_GUARD_PREFIX = 'study-mutation-guard:';
export const STUDY_PERSISTING_PREFIX = 'study-persisting:';
export const RECEIPT_VALUE_PREFIX = 'oi:receipt:';
export const MUTATION_GUARD_VALUE_PREFIX = 'oi:smg:';
const STUDY_ID_TOKEN = /^[A-Za-z0-9-]{1,128}$/;

export function studyOperationMarkerId(operationId: string, createdAt: number): string | null {
  if (!/^(create|delete):[A-Za-z0-9-]{1,128}$/.test(operationId)
    || !Number.isSafeInteger(createdAt)
    || createdAt < 0) {
    return null;
  }
  return `${operationId}:${createdAt}`;
}

export function standaloneCreateMarkerId(studyId: string, createdAt: number): string | null {
  return studyOperationMarkerId(`create:${studyId}`, createdAt);
}

export function standaloneDeleteMarkerId(studyId: string): string | null {
  return studyOperationMarkerId(`delete:${studyId}`, 0);
}

export function encodeOperationReceipt(receipt: StandaloneOperationReceipt): string {
  return `${RECEIPT_VALUE_PREFIX}${JSON.stringify(receipt)}`;
}

export function encodeMutationGuard(guard: StudyMutationGuard): string {
  return `${MUTATION_GUARD_VALUE_PREFIX}${JSON.stringify(guard)}`;
}

export function parseOperationReceipt(value: unknown): StandaloneOperationReceipt | null {
  const parsed = parsePrefixedJson(value, RECEIPT_VALUE_PREFIX);
  if (!parsed.ok) return null;
  const payload = parsed.payload;
  if (payload.version !== 2) return null;
  if (typeof payload.studyId !== 'string' || !STUDY_ID_TOKEN.test(payload.studyId)) return null;
  if (payload.kind !== 'create' && payload.kind !== 'delete') return null;
  if (typeof payload.researcherId !== 'string' || payload.researcherId.length === 0) return null;
  if (
    payload.resolution !== 'created'
    && payload.resolution !== 'deleted'
    && payload.resolution !== 'cancelled'
  ) {
    return null;
  }
  if (typeof payload.markerId !== 'string' || payload.markerId.length === 0) return null;
  if (!Number.isSafeInteger(payload.createdAt) || (payload.createdAt as number) < 0) return null;
  if (!Number.isSafeInteger(payload.generation) || (payload.generation as number) < 1) return null;
  if (payload.idempotencyHash !== null && (typeof payload.idempotencyHash !== 'string' || payload.idempotencyHash.length === 0)) {
    return null;
  }
  return {
    version: 2,
    studyId: payload.studyId,
    kind: payload.kind,
    researcherId: payload.researcherId,
    resolution: payload.resolution,
    markerId: payload.markerId,
    createdAt: payload.createdAt as number,
    generation: payload.generation as number,
    idempotencyHash: payload.idempotencyHash as string | null,
  };
}

export function parseMutationGuard(value: unknown): StudyMutationGuard | null {
  const parsed = parsePrefixedJson(value, MUTATION_GUARD_VALUE_PREFIX);
  if (!parsed.ok) return null;
  const payload = parsed.payload;
  if (payload.version !== 2) return null;
  if (typeof payload.studyId !== 'string' || !STUDY_ID_TOKEN.test(payload.studyId)) return null;
  if (payload.kind !== 'create' && payload.kind !== 'delete') return null;
  if (!Number.isSafeInteger(payload.generation) || (payload.generation as number) < 1) return null;
  if (
    payload.state !== 'in-flight'
    && payload.state !== 'cancelled'
    && payload.state !== 'deleted'
    && payload.state !== 'created'
  ) {
    return null;
  }
  if (typeof payload.markerId !== 'string' || payload.markerId.length === 0) return null;
  return {
    version: 2,
    studyId: payload.studyId,
    kind: payload.kind,
    generation: payload.generation as number,
    state: payload.state,
    markerId: payload.markerId,
  };
}

export function parseCreateDeleteResult(wire: unknown): WireResult<CreateDeleteWireOutcome> {
  const parsed = parseFamilyWire('byos-mutation', wire);
  if (parsed.status !== 'ok') return parsed;
  switch (parsed.value.tag) {
    case 'oi:created':
      return ok({ outcome: 'created' });
    case 'oi:deleted':
      return ok({ outcome: 'deleted' });
    case 'oi:cancelled':
      return ok({ outcome: 'cancelled' });
    case 'oi:still-pending':
      return ok({ outcome: 'still-pending' });
    case 'oi:not-found':
      return ok({ outcome: 'not-found' });
    case 'oi:conflict':
      return ok({ outcome: 'conflict', revision: parsed.value.payload as number });
    case 'oi:invalid':
      return ok({ outcome: 'invalid' });
    default:
      return UNAVAILABLE;
  }
}

function classifyCommitError(error: unknown): 'ambiguous' | 'unavailable' {
  if (error instanceof RedisCommitAmbiguousError) {
    return error.commitState === 'may-have-committed' ? 'ambiguous' : 'unavailable';
  }
  return 'unavailable';
}

function receiptKey(markerId: string): string {
  return `${STUDY_OPERATION_MARKER_PREFIX}${markerId}`;
}

function mutationGuardKey(studyId: string): string {
  return `${STUDY_MUTATION_GUARD_PREFIX}${studyId}`;
}

function persistingKey(studyId: string): string {
  return `${STUDY_PERSISTING_PREFIX}${studyId}`;
}

export const CREATE_STUDY_SCRIPT = `
local function receipt_resolution(value)
  if type(value) ~= 'string' or string.sub(value, 1, 11) ~= 'oi:receipt:' then return nil end
  local ok, obj = pcall(cjson.decode, string.sub(value, 12))
  if not ok or type(obj) ~= 'table' or type(obj.resolution) ~= 'string' then return nil end
  return obj.resolution
end

local mode = ARGV[6]
if mode ~= 'standalone' and mode ~= 'hosted' then
  return {'oi:byos-unavailable'}
end
if mode == 'hosted' and #KEYS ~= 4 then
  return {'oi:byos-unavailable'}
end
if mode == 'standalone' and #KEYS ~= 5 then
  return {'oi:byos-unavailable'}
end

local existingReceipt
local guard
if mode == 'hosted' then
  existingReceipt = redis.call('GET', KEYS[2])
  guard = redis.call('GET', KEYS[3])
else
  existingReceipt = redis.call('GET', KEYS[3])
  guard = redis.call('GET', KEYS[4])
end
if existingReceipt then
  local resolution = receipt_resolution(existingReceipt)
  if resolution == 'created' then return {'oi:created'} end
  if resolution == 'cancelled' then return {'oi:cancelled'} end
  if resolution == 'deleted' then return {'oi:conflict', 'oi:revision:0'} end
  return {'oi:byos-unavailable'}
end

if guard then
  if type(guard) ~= 'string' or string.sub(guard, 1, 7) ~= 'oi:smg:' then
    return {'oi:byos-unavailable'}
  end
  local ok, obj = pcall(cjson.decode, string.sub(guard, 8))
  if not ok or type(obj) ~= 'table' then
    return {'oi:byos-unavailable'}
  end
  if obj.state == 'cancelled' then
    return {'oi:cancelled'}
  end
  if obj.state == 'deleted' or (obj.state == 'in-flight' and obj.kind == 'delete') then
    return {'oi:conflict', 'oi:revision:0'}
  end
end

if mode == 'hosted' then
  if redis.call('SCARD', KEYS[4]) > 0 then
    return {'oi:still-pending'}
  end
elseif redis.call('SCARD', KEYS[5]) > 0 then
  return {'oi:still-pending'}
end

if redis.call('EXISTS', KEYS[1]) == 1 then
  local stored = redis.call('GET', KEYS[1])
  -- Dual-read: writers now prefix with oi:study:, but legacy unprefixed
  -- bodies of the same study are the same content and must repair (W2), not
  -- conflict. Keep until all writers prefix.
  local legacy = string.sub(ARGV[1], 9)
  if stored ~= ARGV[1] and stored ~= legacy then
    return {'oi:conflict', 'oi:revision:0'}
  end
  -- fault cut W2: study present, receipt not terminal
  if mode == 'standalone' then
    redis.call('SADD', KEYS[2], ARGV[2])
    redis.call('SET', KEYS[3], ARGV[4], 'EX', 604800)
    redis.call('SET', KEYS[4], ARGV[5])
  else
    redis.call('SET', KEYS[2], ARGV[4], 'EX', 604800)
    redis.call('SET', KEYS[3], ARGV[5])
  end
  return {'oi:created'}
end

-- fault cut W1 / S1: mapping reserved, study absent
redis.call('SET', KEYS[1], ARGV[1])
-- fault cut S2: study SET committed, all-studies not yet
if mode == 'standalone' then
  redis.call('SADD', KEYS[2], ARGV[2])
end
-- fault cut S3: study+index committed, receipt absent
if mode == 'hosted' then
  redis.call('SET', KEYS[2], ARGV[4], 'EX', 604800)
  redis.call('SET', KEYS[3], ARGV[5])
else
  redis.call('SET', KEYS[3], ARGV[4], 'EX', 604800)
  redis.call('SET', KEYS[4], ARGV[5])
end
-- fault cut S4: receipt committed
return {'oi:created'}
`;

export async function createStudyAtomic(
  study: StoredStudy,
  client?: RedisPort,
  operationMarkerId?: string,
  options?: { idempotencyHash?: string | null; researcherId?: string }
): Promise<CreateStudyResult> {
  const markerId = operationMarkerId
    || standaloneCreateMarkerId(study.id, study.createdAt)
    || null;
  if (!markerId || !STUDY_ID_TOKEN.test(study.id)) return 'unavailable';

  const receipt: StandaloneOperationReceipt = {
    version: 2,
    studyId: study.id,
    kind: 'create',
    researcherId: options?.researcherId || 'standalone',
    resolution: 'created',
    markerId,
    createdAt: study.createdAt,
    generation: 1,
    idempotencyHash: options?.idempotencyHash ?? null,
  };
  const guard: StudyMutationGuard = {
    version: 2,
    studyId: study.id,
    kind: 'create',
    generation: 1,
    state: 'created',
    markerId,
  };

  try {
    const resolvedMode = resolveDeploymentMode();
    if (!resolvedMode.ok) return 'unavailable';
    const hosted = resolvedMode.mode === 'hosted';

    const kv = resolveClient(client);
    const existing = await kv.get(receiptKey(markerId));
    if (existing !== null && existing !== undefined) {
      const parsed = parseOperationReceipt(existing);
      if (!parsed) return 'unavailable';
      if (parsed.resolution === 'created') return 'created';
      if (parsed.resolution === 'cancelled') return 'cancelled';
      return 'conflict';
    }

    const keys = hosted
      ? [
          `${STUDY_PREFIX}${study.id}`,
          receiptKey(markerId),
          mutationGuardKey(study.id),
          persistingKey(study.id),
        ]
      : [
          `${STUDY_PREFIX}${study.id}`,
          ALL_STUDIES_KEY,
          receiptKey(markerId),
          mutationGuardKey(study.id),
          persistingKey(study.id),
        ];
    const wire = await kv.eval(
      CREATE_STUDY_SCRIPT,
      keys,
      [
        `${STUDY_VALUE_PREFIX}${JSON.stringify(study)}`,
        study.id,
        markerId,
        encodeOperationReceipt(receipt),
        encodeMutationGuard(guard),
        resolvedMode.mode,
      ]
    );
    const parsed = parseCreateDeleteResult(wire);
    if (parsed.status !== 'ok') return 'unavailable';
    if (parsed.value.outcome === 'created') return 'created';
    if (parsed.value.outcome === 'cancelled') return 'cancelled';
    if (parsed.value.outcome === 'conflict' || parsed.value.outcome === 'invalid') return 'conflict';
    if (parsed.value.outcome === 'still-pending') return 'unavailable';
    return 'unavailable';
  } catch (error) {
    logRequestFailure({ event: 'kv.unavailable' }, error);
    return classifyCommitError(error);
  }
}

export type StudyMutationResult =
  | { status: 'updated'; study: StoredStudy }
  | { status: 'conflict' }
  | { status: 'not-found' }
  | { status: 'unavailable' }
  | { status: 'ambiguous' }
  | { status: 'persist-guard' };

function asStoredStudy(value: unknown): StoredStudy | null {
  if (typeof value === 'string') {
    if (!value.startsWith(STUDY_VALUE_PREFIX)) return null;
    try {
      return asStoredStudy(JSON.parse(value.slice(STUDY_VALUE_PREFIX.length)));
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.id !== 'string' || !STUDY_ID_TOKEN.test(rec.id)) return null;
  if (!rec.config || typeof rec.config !== 'object' || Array.isArray(rec.config)) return null;
  if (!Number.isFinite(rec.createdAt) || !Number.isFinite(rec.updatedAt)) return null;
  if (!Number.isFinite(rec.interviewCount) || (rec.interviewCount as number) < 0) return null;
  if (typeof rec.isLocked !== 'boolean') return null;
  if (!Number.isFinite(rec.revision) || (rec.revision as number) < 1) return null;
  return value as StoredStudy;
}

function mutationPersistGuard(wire: unknown): StudyMutationResult | null {
  if (!Array.isArray(wire) || wire[0] !== 'oi:persist-guard') return null;
  const parsed = parsePersistResult(wire);
  return parsed.status === 'ok' && parsed.value.outcome === 'guard'
    ? { status: 'persist-guard' }
    : { status: 'unavailable' };
}

function mapStudyCasWire(wire: unknown): StudyMutationResult {
  const blocked = mutationPersistGuard(wire);
  if (blocked) return blocked;
  const parsed = parseStudyCasResult(wire);
  if (parsed.status !== 'ok') return { status: 'unavailable' };
  switch (parsed.value.outcome) {
    case 'updated': {
      const study = asStoredStudy(parsed.value.study);
      return study ? { status: 'updated', study } : { status: 'unavailable' };
    }
    case 'not-found':
      return { status: 'not-found' };
    case 'conflict':
      return { status: 'conflict' };
    default:
      return { status: 'unavailable' };
  }
}

function studyCasKeys(studyId: string): string[] {
  return [
    `${STUDY_PREFIX}${studyId}`,
    `${STUDY_PERSISTING_PREFIX}${studyId}`,
    mutationGuardKey(studyId),
  ];
}

const STUDY_CAS_LUA = `${STUDY_JSON_LUA}
local function decode_study(raw)
  if type(raw) ~= 'string' then return nil, false end
  local prefixed = string.sub(raw, 1, 9) == 'oi:study:'
  local payload = prefixed and string.sub(raw, 10) or raw
  local ok, obj = pcall(cjson.decode, payload)
  if not ok or type(obj) ~= 'table' then return nil, prefixed end
  return obj, prefixed, payload
end

if redis.call('SCARD', KEYS[2]) > 0 then
  return {'oi:persist-guard'}
end

local mutationRaw = redis.call('GET', KEYS[3])
if mutationRaw then
  if type(mutationRaw) ~= 'string' or string.sub(mutationRaw, 1, 7) ~= 'oi:smg:' then
    return {'oi:byos-unavailable'}
  end
  local mok, mutation = pcall(cjson.decode, string.sub(mutationRaw, 8))
  if not mok or type(mutation) ~= 'table' then
    return {'oi:byos-unavailable'}
  end
  if mutation.state ~= 'created' then
    return {'oi:persist-guard'}
  end
end
`;

export const SET_STUDY_LINKS_SCRIPT = `${STUDY_CAS_LUA}
local study, prefixed, studyJson = decode_study(redis.call('GET', KEYS[1]))
if not study then return {'oi:not-found'} end
local nextRev = (tonumber(study.revision) or 1) + 1
if nextRev > 99999999999999 then return {'oi:invalid'} end
local configJson = study.config and json_object_value(studyJson, 'config') or '{}'
local updatedJson = patch_json_object(studyJson, {
  {'config', patch_json_object(configJson, {{'linksEnabled', ARGV[1] == '1' and 'true' or 'false'}})},
  {'updatedAt', ARGV[2]},
  {'revision', string.format('%.0f', nextRev)}
})
redis.call('SET', KEYS[1], encode_study(updatedJson, prefixed))
return {'oi:updated', 'oi:json:' .. updatedJson}
`;

export async function setStudyLinksEnabled(
  studyId: string,
  enabled: boolean,
  client?: RedisPort
): Promise<StudyMutationResult> {
  if (!STUDY_ID_TOKEN.test(studyId)) return { status: 'unavailable' };
  try {
    const kv = resolveClient(client);
    const value = await kv.eval(
      SET_STUDY_LINKS_SCRIPT,
      studyCasKeys(studyId),
      [enabled ? '1' : '0', String(Date.now())]
    );
    return mapStudyCasWire(value);
  } catch (error) {
    logRequestFailure({ event: 'kv.unavailable' }, error);
    return classifyCommitError(error) === 'ambiguous'
      ? { status: 'ambiguous' }
      : { status: 'unavailable' };
  }
}

export const REPLACE_STUDY_CONFIG_SCRIPT = `${STUDY_CAS_LUA}
local study, prefixed, studyJson = decode_study(redis.call('GET', KEYS[1]))
if not study then return {'oi:not-found'} end
if (tonumber(study.revision) or 1) ~= tonumber(ARGV[1]) then
  return {'oi:conflict', 'oi:revision:' .. string.format('%.0f', math.floor(tonumber(study.revision) or 1))}
end
local cok, config = pcall(cjson.decode, ARGV[2])
if not cok or type(config) ~= 'table' then return {'oi:invalid'} end
local nextRev = (tonumber(study.revision) or 1) + 1
if nextRev > 99999999999999 then return {'oi:invalid'} end
local updatedJson = patch_json_object(studyJson, {
  {'config', ARGV[2]},
  {'updatedAt', ARGV[3]},
  {'revision', string.format('%.0f', nextRev)}
})
redis.call('SET', KEYS[1], encode_study(updatedJson, prefixed))
return {'oi:updated', 'oi:json:' .. updatedJson}
`;

export async function replaceStudyConfigAtomic(
  studyId: string,
  expectedRevision: number,
  config: StoredStudy['config'],
  client?: RedisPort
): Promise<StudyMutationResult> {
  if (!STUDY_ID_TOKEN.test(studyId)) return { status: 'unavailable' };
  if (
    !Number.isSafeInteger(expectedRevision)
    || expectedRevision < 1
    || expectedRevision > MAX_STUDY_REVISION
  ) {
    return { status: 'unavailable' };
  }
  try {
    const kv = resolveClient(client);
    const result = await kv.eval(
      REPLACE_STUDY_CONFIG_SCRIPT,
      studyCasKeys(studyId),
      [String(expectedRevision), JSON.stringify(config), String(Date.now())]
    );
    return mapStudyCasWire(result);
  } catch (error) {
    logRequestFailure({ event: 'kv.unavailable' }, error);
    return classifyCommitError(error) === 'ambiguous'
      ? { status: 'ambiguous' }
      : { status: 'unavailable' };
  }
}

// Typed result for study reads where not-found and storage-unavailable must be
// distinguished (security checks fail closed on either, but with different errors).
export type StudyLoadResult =
  | { status: 'found'; study: StoredStudy }
  | { status: 'not-found' }
  | { status: 'unavailable' };

// Read a study, distinguishing "no such record" from "storage could not be read".
export async function getStudyChecked(id: string, client?: RedisPort): Promise<StudyLoadResult> {
  try {
    const kv = resolveClient(client);
    const study = asStoredStudy(await kv.get(`${STUDY_PREFIX}${id}`));
    return study ? { status: 'found', study } : { status: 'not-found' };
  } catch (error) {
    logRequestFailure({ event: 'kv.unavailable' }, error);
    return { status: 'unavailable' };
  }
}

// Get study by ID.
// Returns null only for a genuine miss. Storage failures throw so callers can
// fail closed instead of mistaking an unavailable store for a missing record.
export async function getStudy(id: string, client?: RedisPort): Promise<StoredStudy | null> {
  const result = await getStudyChecked(id, client);
  if (result.status === 'unavailable') {
    throw new Error('Study storage is temporarily unavailable');
  }
  return result.status === 'found' ? result.study : null;
}

export function encodeAggregateValue(aggregate: StoredAggregateSynthesis): string {
  return `${AGGREGATE_VALUE_PREFIX}${JSON.stringify(aggregate)}`;
}

/**
 * A stored aggregate that does not decode is absent. The `studyId` check is a
 * key/value mixup guard; the `_receipt` check is a structural refusal — a
 * receipt in the record means something other than this route wrote it.
 */
function decodeStoredAggregate(value: unknown, studyId: string): StoredAggregateSynthesis | null {
  const parsed = parsePrefixedJson(value, AGGREGATE_VALUE_PREFIX);
  if (!parsed.ok) return null;
  const rec = parsed.payload;
  if (rec.studyId !== studyId) return null;
  if ('_receipt' in rec) return null;
  if (!Number.isSafeInteger(rec.studyRevision) || (rec.studyRevision as number) < 0) return null;
  if (!Number.isSafeInteger(rec.savedAt) || !Number.isSafeInteger(rec.generatedAt)) return null;
  if (!Array.isArray(rec.interviewIds) || rec.interviewIds.length === 0) return null;
  if (rec.interviewIds.some(id => typeof id !== 'string' || id.length === 0 || id.length > 200)) return null;
  if (rec.interviewCount !== rec.interviewIds.length) return null;
  if (!Array.isArray(rec.commonThemes) || !Array.isArray(rec.divergentViews)) return null;
  if (!Array.isArray(rec.keyFindings) || !Array.isArray(rec.researchImplications)) return null;
  if (typeof rec.bottomLine !== 'string') return null;
  if (typeof rec.aiProvider !== 'string' || typeof rec.aiModel !== 'string') return null;
  return parsed.payload as unknown as StoredAggregateSynthesis;
}

export type AggregateLoadResult =
  | { status: 'found'; aggregate: StoredAggregateSynthesis }
  | { status: 'not-found' }
  | { status: 'unavailable' };

// Read the stored aggregate synthesis for a study, distinguishing "no
// analysis yet" from "storage could not be read". There is no unchecked twin:
// every caller is a request handler and must fail closed on `unavailable`.
export async function getStudyAggregateChecked(
  studyId: string,
  client?: RedisPort,
): Promise<AggregateLoadResult> {
  try {
    const kv = resolveClient(client);
    const raw = await kv.get(`${STUDY_AGGREGATE_PREFIX}${studyId}`);
    const decoded = decodeStoredAggregate(raw, studyId);
    return decoded ? { status: 'found', aggregate: decoded } : { status: 'not-found' };
  } catch (error) {
    logRequestFailure({ event: 'kv.unavailable' }, error);
    return { status: 'unavailable' };
  }
}

/**
 * The serialized ceiling for one stored aggregate. The same number as
 * generate-followup's request bound (route.ts:50) — the largest aggregate this
 * deployment has ever been willing to move over a wire. Provider caps allow a
 * valid aggregate several megabytes wide (MAX_PROVIDER_LIST_ITEMS ×
 * MAX_PROVIDER_TEXT), so a byte ceiling is load-bearing, not belt-and-braces.
 */
export const MAX_STORED_AGGREGATE_BYTES = 256_000;

export type SaveAggregateResult = 'saved' | 'too-large' | 'unavailable';

// Persist the aggregate synthesis for a study. One SET, no options, no TTL,
// no Lua: a single-key SET of one string cannot leave a torn value. Latest
// replaces; there is no history and no CAS (see slice-N-spec.md N12).
export async function saveStudyAggregate(
  aggregate: StoredAggregateSynthesis,
  client?: RedisPort,
): Promise<SaveAggregateResult> {
  if (!STUDY_ID_TOKEN.test(aggregate.studyId)) return 'unavailable';
  const value = encodeAggregateValue(aggregate);
  if (new TextEncoder().encode(value).byteLength > MAX_STORED_AGGREGATE_BYTES) return 'too-large';
  try {
    const kv = resolveClient(client);
    await kv.set(`${STUDY_AGGREGATE_PREFIX}${aggregate.studyId}`, value);
    return 'saved';
  } catch (error) {
    logRequestFailure({ event: 'kv.unavailable' }, error);
    return 'unavailable';
  }
}

// Get all studies
export async function getAllStudies(client?: RedisPort): Promise<StoredStudy[]> {
  const result = await getAllStudiesChecked(client);
  if (result.status !== 'ok') throw new Error(`Study collection ${result.status}`);
  return result.items;
}

export async function getAllStudiesChecked(
  client?: RedisPort,
  maximum = 1_000
): Promise<CollectionLoadResult<StoredStudy>> {
  try {
    const kv = resolveClient(client);
    const count = await kv.scard(ALL_STUDIES_KEY);
    if (count > maximum) return { status: 'too-large', count, maximum };
    const ids = (await kv.smembers(ALL_STUDIES_KEY)) as string[];
    if (!ids || ids.length === 0) return { status: 'ok', items: [] };
    if (ids.length > maximum) return { status: 'too-large', count: ids.length, maximum };

    const studies = await Promise.all(
      ids.map(id => kv.get(`${STUDY_PREFIX}${id}`))
    );

    return {
      status: 'ok',
      items: studies
        .map(asStoredStudy)
        .filter((s): s is StoredStudy => s !== null)
        .sort((a, b) => b.createdAt - a.createdAt),
    };
  } catch (error) {
    logRequestFailure({ event: 'kv.unavailable' }, error);
    return { status: 'unavailable' };
  }
}

export const DELETE_EMPTY_STUDY_SCRIPT = `
local function receipt_resolution(value)
  if type(value) ~= 'string' or string.sub(value, 1, 11) ~= 'oi:receipt:' then return nil end
  local ok, obj = pcall(cjson.decode, string.sub(value, 12))
  if not ok or type(obj) ~= 'table' or type(obj.resolution) ~= 'string' then return nil end
  return obj.resolution
end

local function same_generation_guard(value)
  if type(value) ~= 'string' or string.sub(value, 1, 7) ~= 'oi:smg:' then return false end
  local ok, obj = pcall(cjson.decode, string.sub(value, 8))
  if not ok or type(obj) ~= 'table' then return false end
  return obj.markerId == ARGV[2] and tostring(obj.generation) == ARGV[5]
end

local mode = ARGV[6]
if mode ~= 'standalone' and mode ~= 'hosted' then
  return {'oi:byos-unavailable'}
end
if mode == 'hosted' and #KEYS ~= 6 then
  return {'oi:byos-unavailable'}
end
if mode == 'standalone' and #KEYS ~= 7 then
  return {'oi:byos-unavailable'}
end

local aggregateKey
if mode == 'hosted' then
  aggregateKey = KEYS[6]
else
  aggregateKey = KEYS[7]
end

local function cleanup_this_generation()
  local guardKey, persistSet
  if mode == 'hosted' then
    guardKey = KEYS[4]
    persistSet = KEYS[5]
  else
    guardKey = KEYS[5]
    persistSet = KEYS[6]
  end
  local guard = redis.call('GET', guardKey)
  if same_generation_guard(guard) then
    redis.call('DEL', guardKey)
  end
  local members = redis.call('SMEMBERS', persistSet)
  if type(members) ~= 'table' then return end
  for i = 1, #members do
    local pkey = 'interview-persisting:' .. members[i]
    local raw = redis.call('GET', pkey)
    if type(raw) == 'string' and string.sub(raw, 1, 10) == 'oi:pguard:' then
      local ok, obj = pcall(cjson.decode, string.sub(raw, 11))
      if ok and type(obj) == 'table' and obj.markerId == ARGV[2] and tostring(obj.generation) == ARGV[5] then
        redis.call('DEL', pkey)
        redis.call('SREM', persistSet, members[i])
      end
    end
  end
end

local existingReceipt
if mode == 'hosted' then
  existingReceipt = redis.call('GET', KEYS[3])
else
  existingReceipt = redis.call('GET', KEYS[4])
end
if existingReceipt then
  local resolution = receipt_resolution(existingReceipt)
  if resolution == 'deleted' then
    cleanup_this_generation()
    return {'oi:deleted'}
  end
  if resolution == 'cancelled' then
    cleanup_this_generation()
    return {'oi:cancelled'}
  end
  if resolution ~= 'created' then return {'oi:byos-unavailable'} end
end

-- Before any SCARD/EXISTS study decision, refuse a live persist generation.
if mode == 'hosted' then
  if redis.call('SCARD', KEYS[5]) > 0 then
    return {'oi:still-pending'}
  end
elseif redis.call('SCARD', KEYS[6]) > 0 then
  return {'oi:still-pending'}
end

if mode == 'hosted' then
  redis.call('SET', KEYS[4], ARGV[4])
else
  redis.call('SET', KEYS[5], ARGV[4])
end
-- fault cut D1: mutation guard written, study present

if redis.call('SCARD', KEYS[2]) > 0 then
  return {'oi:conflict', 'oi:revision:0'}
end

-- The aggregate is a cache of a paid model call. Deleting it here means a
-- refused delete (the study still has interviews) never destroys it, and the
-- study record is never removed while its aggregate survives. A crash at D5
-- leaves a live study without its cached analysis, which the researcher can
-- regenerate; the reverse order would leave a value no code path can reach.
redis.call('DEL', aggregateKey)
-- fault cut D5: aggregate cache removed, study record still present

if redis.call('EXISTS', KEYS[1]) == 0 then
  if mode == 'standalone' then
    redis.call('SREM', KEYS[3], ARGV[1])
    redis.call('SET', KEYS[4], ARGV[3], 'EX', 604800)
  else
    redis.call('SET', KEYS[3], ARGV[3], 'EX', 604800)
  end
  -- fault cut D4: receipt written, this-generation guard not cleaned
  cleanup_this_generation()
  return {'oi:deleted'}
end

redis.call('DEL', KEYS[1])
-- fault cut D2: study DEL, index not SREM
if mode == 'standalone' then
  redis.call('SREM', KEYS[3], ARGV[1])
end
-- fault cut D3: study+index removed, receipt absent
if mode == 'hosted' then
  redis.call('SET', KEYS[3], ARGV[3], 'EX', 604800)
else
  redis.call('SET', KEYS[4], ARGV[3], 'EX', 604800)
end
-- fault cut D4: receipt written, this-generation guard not cleaned
cleanup_this_generation()
return {'oi:deleted'}
`;

function deleteResult(
  status: DeleteStudyStatus,
  error?: string,
  extra?: { code?: 'STUDY_PERSIST_PENDING'; reason?: 'ambiguous' }
): DeleteStudyResult {
  if (status === 'deleted') return { status, success: true };
  return { status, success: false, error, ...extra };
}

// Delete a study only if no interview exists. The emptiness check and delete
// are one Redis operation, so an interview commit cannot create an orphan by
// interleaving between them. No caller GET of the study body.
export async function deleteStudy(
  id: string,
  client?: RedisPort,
  operationMarkerId?: string
): Promise<DeleteStudyResult> {
  const markerId = operationMarkerId || standaloneDeleteMarkerId(id);
  if (!markerId || !STUDY_ID_TOKEN.test(id)) {
    return deleteResult('unavailable', 'Failed to delete study');
  }

  const receipt: StandaloneOperationReceipt = {
    version: 2,
    studyId: id,
    kind: 'delete',
    researcherId: 'standalone',
    resolution: 'deleted',
    markerId,
    createdAt: 0,
    generation: 1,
    idempotencyHash: null,
  };
  const guard: StudyMutationGuard = {
    version: 2,
    studyId: id,
    kind: 'delete',
    generation: 1,
    state: 'in-flight',
    markerId,
  };

  try {
    const resolvedMode = resolveDeploymentMode();
    if (!resolvedMode.ok) return deleteResult('unavailable', 'Failed to delete study');
    const hosted = resolvedMode.mode === 'hosted';

    const kv = resolveClient(client);
    const existing = await kv.get(receiptKey(markerId));
    if (existing !== null && existing !== undefined) {
      const parsed = parseOperationReceipt(existing);
      if (!parsed) return deleteResult('unavailable', 'Failed to delete study');
      if (parsed.resolution === 'deleted' || parsed.resolution === 'cancelled') {
        const guardRaw = await kv.get(mutationGuardKey(id));
        const leftover = parseMutationGuard(guardRaw);
        const sameGeneration = Boolean(
          leftover
          && leftover.markerId === markerId
          && leftover.generation === 1
        );
        if (!sameGeneration) {
          return parsed.resolution === 'deleted'
            ? deleteResult('deleted')
            : deleteResult('cancelled', 'Study operation cancelled');
        }
      }
    }

    const keys = hosted
      ? [
          `${STUDY_PREFIX}${id}`,
          `${STUDY_INDEX_PREFIX}${id}`,
          receiptKey(markerId),
          mutationGuardKey(id),
          persistingKey(id),
          `${STUDY_AGGREGATE_PREFIX}${id}`,
        ]
      : [
          `${STUDY_PREFIX}${id}`,
          `${STUDY_INDEX_PREFIX}${id}`,
          ALL_STUDIES_KEY,
          receiptKey(markerId),
          mutationGuardKey(id),
          persistingKey(id),
          `${STUDY_AGGREGATE_PREFIX}${id}`,
        ];
    const wire = await kv.eval(
      DELETE_EMPTY_STUDY_SCRIPT,
      keys,
      [
        id,
        markerId,
        encodeOperationReceipt(receipt),
        encodeMutationGuard(guard),
        '1',
        resolvedMode.mode,
      ]
    );
    const parsed = parseCreateDeleteResult(wire);
    if (parsed.status !== 'ok') return deleteResult('unavailable', 'Failed to delete study');
    if (parsed.value.outcome === 'deleted') return deleteResult('deleted');
    if (parsed.value.outcome === 'cancelled') {
      return deleteResult('cancelled', 'Study operation cancelled');
    }
    if (parsed.value.outcome === 'still-pending') {
      return deleteResult('still-pending', 'STUDY_PERSIST_PENDING', { code: 'STUDY_PERSIST_PENDING' });
    }
    if (parsed.value.outcome === 'conflict') {
      return deleteResult('conflict', 'Cannot delete study with existing interviews');
    }
    if (parsed.value.outcome === 'not-found') {
      return deleteResult('not-found', 'Study not found');
    }
    return deleteResult('unavailable', 'Failed to delete study');
  } catch (error) {
    logRequestFailure({ event: 'kv.unavailable' }, error);
    const classified = classifyCommitError(error);
    return classified === 'ambiguous'
      ? deleteResult('ambiguous', 'Failed to delete study', { reason: 'ambiguous' })
      : deleteResult('unavailable', 'Failed to delete study');
  }
}

export type SettleStudyOperationMutationResult =
  | 'mutation-applied'
  | 'mutation-cancelled'
  | 'unavailable'
  | 'ambiguous';

export const SETTLE_STUDY_OPERATION_SCRIPT = `
local function receipt_resolution(value)
  if type(value) ~= 'string' or string.sub(value, 1, 11) ~= 'oi:receipt:' then return nil end
  local ok, obj = pcall(cjson.decode, string.sub(value, 12))
  if not ok or type(obj) ~= 'table' or type(obj.resolution) ~= 'string' then return nil end
  return obj.resolution
end

local marker = receipt_resolution(redis.call('GET', KEYS[2]))
local exists = redis.call('EXISTS', KEYS[1]) == 1
if ARGV[1] == 'create' then
  if marker == 'created' or exists then
    redis.call('SET', KEYS[2], ARGV[2], 'EX', 604800)
    redis.call('SET', KEYS[3], ARGV[4])
    return {'oi:created'}
  end
  redis.call('SET', KEYS[2], ARGV[3], 'EX', 604800)
  redis.call('SET', KEYS[3], ARGV[5])
  return {'oi:cancelled'}
end
if ARGV[1] == 'delete' then
  if marker == 'deleted' or not exists then
    redis.call('SET', KEYS[2], ARGV[2], 'EX', 604800)
    redis.call('SET', KEYS[3], ARGV[4])
    return {'oi:deleted'}
  end
  redis.call('SET', KEYS[2], ARGV[3], 'EX', 604800)
  redis.call('SET', KEYS[3], ARGV[5])
  return {'oi:cancelled'}
end
return {'oi:byos-unavailable'}
`;

// Atomically observes the study and installs a BYOS tombstone for the inverse
// outcome. A delayed original mutation must check the same marker, so once this
// returns mutation-cancelled it cannot later cross the platform rollback.
export async function settleStudyOperationMutation(
  kind: 'create' | 'delete',
  studyId: string,
  operationMarkerId: string,
  client?: RedisPort
): Promise<SettleStudyOperationMutationResult> {
  const appliedResolution = kind === 'create' ? 'created' : 'deleted';
  const applied: StandaloneOperationReceipt = {
    version: 2,
    studyId,
    kind,
    researcherId: 'standalone',
    resolution: appliedResolution,
    markerId: operationMarkerId,
    createdAt: 0,
    generation: 1,
    idempotencyHash: null,
  };
  const cancelled: StandaloneOperationReceipt = {
    ...applied,
    resolution: 'cancelled',
  };
  const appliedGuard: StudyMutationGuard = {
    version: 2,
    studyId,
    kind,
    generation: 1,
    state: appliedResolution,
    markerId: operationMarkerId,
  };
  const cancelledGuard: StudyMutationGuard = {
    ...appliedGuard,
    state: 'cancelled',
  };

  try {
    const wire = await resolveClient(client).eval(
      SETTLE_STUDY_OPERATION_SCRIPT,
      [
        `${STUDY_PREFIX}${studyId}`,
        receiptKey(operationMarkerId),
        mutationGuardKey(studyId),
      ],
      [
        kind,
        encodeOperationReceipt(applied),
        encodeOperationReceipt(cancelled),
        encodeMutationGuard(appliedGuard),
        encodeMutationGuard(cancelledGuard),
      ]
    );
    const parsed = parseCreateDeleteResult(wire);
    if (parsed.status !== 'ok') return 'unavailable';
    if (parsed.value.outcome === 'created' || parsed.value.outcome === 'deleted') {
      return 'mutation-applied';
    }
    if (parsed.value.outcome === 'cancelled') return 'mutation-cancelled';
    return 'unavailable';
  } catch (error) {
    logRequestFailure({ event: 'kv.unavailable' }, error);
    return classifyCommitError(error);
  }
}
