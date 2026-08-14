// Redis Client Storage Layer
// Supports both standalone (env-var singleton) and hosted (per-researcher dynamic) modes
// All functions accept an optional Redis client parameter for multi-tenant support

import { Redis } from '@upstash/redis';
import { getKVClient } from './kvClient';
import { StoredInterview, StoredStudy } from '@/types';

// Key prefixes for organizing data
const INTERVIEW_PREFIX = 'interview:';
const STUDY_INDEX_PREFIX = 'study-interviews:';
const STUDY_PREFIX = 'study:';
const ALL_STUDIES_KEY = 'all-studies';

// Helper: resolve the Redis client to use
function resolveClient(client?: Redis): Redis {
  return client ?? getKVClient();
}

// Get interview by ID
export async function getInterview(id: string, client?: Redis): Promise<StoredInterview | null> {
  const result = await getInterviewChecked(id, client);
  if (result.status === 'unavailable') throw new Error('Interview storage is temporarily unavailable');
  return result.status === 'found' ? result.interview : null;
}

export type InterviewLoadResult =
  | { status: 'found'; interview: StoredInterview }
  | { status: 'not-found' }
  | { status: 'unavailable' };

export async function getInterviewChecked(id: string, client?: Redis): Promise<InterviewLoadResult> {
  try {
    const kv = resolveClient(client);
    const interview = await kv.get<StoredInterview>(`${INTERVIEW_PREFIX}${id}`);
    return interview ? { status: 'found', interview } : { status: 'not-found' };
  } catch (error) {
    console.error('Error getting interview:', error);
    return { status: 'unavailable' };
  }
}

// Save interview (create or update).
// This is reserved for trusted maintenance/demo data. Participant completion
// uses persistCompletedInterview() below so completed records are immutable.
export async function saveInterview(interview: StoredInterview, client?: Redis): Promise<boolean> {
  try {
    const kv = resolveClient(client);
    // Save the interview
    await kv.set(`${INTERVIEW_PREFIX}${interview.id}`, interview);

    // Add to study index for easy lookup by study
    await kv.sadd(`${STUDY_INDEX_PREFIX}${interview.studyId}`, interview.id);

    // Add to global index
    await kv.sadd('all-interviews', interview.id);

    return true;
  } catch (error) {
    console.error('Error saving interview:', error);
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
  | { status: 'unavailable' };

export type AtomicRateLimitCounter = {
  key: string;
  maximum: number;
  windowSeconds: number;
};

const PERSIST_COMPLETED_INTERVIEW_SCRIPT = `
local studyJson = redis.call('GET', KEYS[4])
if not studyJson then
  return -2
end

local study = cjson.decode(studyJson)
if ARGV[5] ~= '1' and study.config and study.config.linksEnabled == false then
  return -3
end

local existingInterview = redis.call('GET', KEYS[1])
local existingFingerprint = redis.call('GET', KEYS[5])
if existingInterview or existingFingerprint then
  if existingInterview and existingFingerprint == ARGV[2] then
    return 0
  end
  return -1
end

local currentRevision = tonumber(study.revision or 1)
if currentRevision ~= tonumber(ARGV[6]) then
  return -4
end

local rateLimitCount = tonumber(ARGV[7] or '0')
for i = 1, rateLimitCount do
  local maximum = tonumber(ARGV[7 + (i - 1) * 2 + 1])
  local count = tonumber(redis.call('GET', KEYS[5 + i]) or '0')
  if count >= maximum then
    return -5
  end
end

for i = 1, rateLimitCount do
  local window = tonumber(ARGV[7 + (i - 1) * 2 + 2])
  local count = redis.call('INCR', KEYS[5 + i])
  if count == 1 then redis.call('EXPIRE', KEYS[5 + i], window) end
end

redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[5], ARGV[2])
redis.call('SADD', KEYS[2], ARGV[3])
redis.call('SADD', KEYS[3], ARGV[3])

study.interviewCount = redis.call('SCARD', KEYS[2])
study.isLocked = true
study.updatedAt = tonumber(ARGV[4])
redis.call('SET', KEYS[4], cjson.encode(study))

return 1
`;

/**
 * Atomically create a completed interview and all of its metadata side effects.
 *
 * A retry carrying the same submission fingerprint is a successful no-op. An
 * existing id with different content is a conflict and is never overwritten.
 * The study count is derived from the study index inside the same Redis script,
 * avoiding both process-local dedupe and read/modify/write races.
 */
export async function persistCompletedInterview(
  interview: StoredInterview,
  submissionFingerprint: string,
  options: {
    expectedStudyRevision: number;
    allowDisabledLinks?: boolean;
    rateLimits?: AtomicRateLimitCounter[];
  },
  client?: Redis
): Promise<PersistCompletedInterviewResult> {
  try {
    const kv = resolveClient(client);
    const result = await kv.eval<string[], number>(
      PERSIST_COMPLETED_INTERVIEW_SCRIPT,
      [
        `${INTERVIEW_PREFIX}${interview.id}`,
        `${STUDY_INDEX_PREFIX}${interview.studyId}`,
        'all-interviews',
        `${STUDY_PREFIX}${interview.studyId}`,
        `interview-fingerprint:${interview.id}`,
        ...(options.rateLimits ?? []).map(limit => limit.key),
      ],
      [
        JSON.stringify(interview),
        submissionFingerprint,
        interview.id,
        String(Date.now()),
        options.allowDisabledLinks ? '1' : '0',
        String(options.expectedStudyRevision),
        String(options.rateLimits?.length ?? 0),
        ...(options.rateLimits ?? []).flatMap(limit => [
          String(limit.maximum),
          String(limit.windowSeconds),
        ]),
      ]
    );

    if (result === 1) return { status: 'created' };
    if (result === 0) return { status: 'duplicate' };
    if (result === -1) return { status: 'conflict' };
    if (result === -2) return { status: 'study-not-found' };
    if (result === -3) return { status: 'links-disabled' };
    if (result === -4) return { status: 'revision-stale' };
    if (result === -5) return { status: 'rate-limited' };

    console.error('Unexpected completed interview persistence result:', result);
    return { status: 'unavailable' };
  } catch (error) {
    console.error('Error persisting completed interview:', error);
    return { status: 'unavailable' };
  }
}

export type CollectionLoadResult<T> =
  | { status: 'ok'; items: T[] }
  | { status: 'too-large'; count: number; maximum: number }
  | { status: 'unavailable' };

async function getInterviewCollectionChecked(
  indexKey: string,
  client?: Redis,
  maximum = 5_000
): Promise<CollectionLoadResult<StoredInterview>> {
  try {
    const kv = resolveClient(client);
    const count = await kv.scard(indexKey);
    if (count > maximum) return { status: 'too-large', count, maximum };
    const ids = await kv.smembers(indexKey);
    if (!ids || ids.length === 0) return { status: 'ok', items: [] };
    if (ids.length > maximum) return { status: 'too-large', count: ids.length, maximum };

    const interviews = await Promise.all(
      ids.map(id => kv.get<StoredInterview>(`${INTERVIEW_PREFIX}${id}`))
    );

    return {
      status: 'ok',
      items: interviews
        .filter((i): i is StoredInterview => i !== null)
        .sort((a, b) => b.createdAt - a.createdAt),
    };
  } catch (error) {
    console.error('Error getting interview collection:', error);
    return { status: 'unavailable' };
  }
}

export async function getAllInterviewsChecked(
  client?: Redis,
  maximum = 5_000
): Promise<CollectionLoadResult<StoredInterview>> {
  return getInterviewCollectionChecked('all-interviews', client, maximum);
}

// Get all interviews. Prefer the checked variant in request handlers.
export async function getAllInterviews(client?: Redis): Promise<StoredInterview[]> {
  const result = await getAllInterviewsChecked(client);
  if (result.status !== 'ok') throw new Error(`Interview collection ${result.status}`);
  return result.items;
}

// Get interviews for a specific study
export async function getStudyInterviews(studyId: string, client?: Redis): Promise<StoredInterview[]> {
  const result = await getStudyInterviewsChecked(studyId, client);
  if (result.status !== 'ok') throw new Error(`Study interview collection ${result.status}`);
  return result.items;
}

export async function getStudyInterviewsChecked(
  studyId: string,
  client?: Redis,
  maximum = 5_000
): Promise<CollectionLoadResult<StoredInterview>> {
  return getInterviewCollectionChecked(`${STUDY_INDEX_PREFIX}${studyId}`, client, maximum);
}

// Delete interview
export async function deleteInterview(id: string, studyId: string, client?: Redis): Promise<boolean> {
  try {
    const kv = resolveClient(client);
    await kv.del(`${INTERVIEW_PREFIX}${id}`);
    await kv.srem(`${STUDY_INDEX_PREFIX}${studyId}`, id);
    await kv.srem('all-interviews', id);
    return true;
  } catch (error) {
    console.error('Error deleting interview:', error);
    return false;
  }
}

// Check if KV is available (for development without KV)
export async function isKVAvailable(client?: Redis): Promise<boolean> {
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
export async function saveStudy(study: StoredStudy, client?: Redis): Promise<boolean> {
  try {
    const kv = resolveClient(client);
    await kv.set(`${STUDY_PREFIX}${study.id}`, study);
    await kv.sadd(ALL_STUDIES_KEY, study.id);
    return true;
  } catch (error) {
    console.error('Error saving study:', error);
    return false;
  }
}

export type CreateStudyResult = 'created' | 'conflict' | 'cancelled' | 'unavailable';

const STUDY_OPERATION_MARKER_PREFIX = 'study-operation-result:';

export function studyOperationMarkerId(operationId: string, createdAt: number): string | null {
  if (!/^(create|delete):[A-Za-z0-9-]{1,128}$/.test(operationId)
    || !Number.isSafeInteger(createdAt)
    || createdAt < 0) {
    return null;
  }
  return `${operationId}:${createdAt}`;
}

const CREATE_STUDY_SCRIPT = `
if ARGV[3] ~= '' and redis.call('GET', KEYS[3]) == 'cancelled' then return -2 end
if redis.call('EXISTS', KEYS[1]) == 1 then
  if ARGV[3] ~= '' then redis.call('SET', KEYS[3], 'created') end
  return 0
end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SADD', KEYS[2], ARGV[2])
if ARGV[3] ~= '' then redis.call('SET', KEYS[3], 'created') end
return 1
`;

export async function createStudyAtomic(
  study: StoredStudy,
  client?: Redis,
  operationMarkerId?: string
): Promise<CreateStudyResult> {
  try {
    const kv = resolveClient(client);
    const result = await kv.eval<string[], number>(
      CREATE_STUDY_SCRIPT,
      [
        `${STUDY_PREFIX}${study.id}`,
        ALL_STUDIES_KEY,
        `${STUDY_OPERATION_MARKER_PREFIX}${operationMarkerId || 'standalone'}`,
      ],
      [JSON.stringify(study), study.id, operationMarkerId || '']
    );
    if (result === 1) return 'created';
    if (result === 0) return 'conflict';
    if (result === -2) return 'cancelled';
    return 'unavailable';
  } catch (error) {
    console.error('Error creating study:', error);
    return 'unavailable';
  }
}

export type StudyMutationResult =
  | { status: 'updated'; study: StoredStudy }
  | { status: 'conflict' }
  | { status: 'not-found' }
  | { status: 'unavailable' };

const SET_STUDY_LINKS_SCRIPT = `
local studyJson = redis.call('GET', KEYS[1])
if not studyJson then return nil end
local study = cjson.decode(studyJson)
if not study.config then study.config = {} end
study.config.linksEnabled = ARGV[1] == '1'
study.updatedAt = tonumber(ARGV[2])
study.revision = (tonumber(study.revision) or 1) + 1
local updated = cjson.encode(study)
redis.call('SET', KEYS[1], updated)
return updated
`;

export async function setStudyLinksEnabled(
  studyId: string,
  enabled: boolean,
  client?: Redis
): Promise<StudyMutationResult> {
  try {
    const kv = resolveClient(client);
    const value = await kv.eval<string[], StoredStudy | null>(
      SET_STUDY_LINKS_SCRIPT,
      [`${STUDY_PREFIX}${studyId}`],
      [enabled ? '1' : '0', String(Date.now())]
    );
    if (value === null) return { status: 'not-found' };
    return { status: 'updated', study: value };
  } catch (error) {
    console.error('Error updating study link status:', error);
    return { status: 'unavailable' };
  }
}

const REPLACE_STUDY_CONFIG_SCRIPT = `
local studyJson = redis.call('GET', KEYS[1])
if not studyJson then return {0} end
local study = cjson.decode(studyJson)
if (tonumber(study.revision) or 1) ~= tonumber(ARGV[1]) then return {-1} end
study.config = cjson.decode(ARGV[2])
study.updatedAt = tonumber(ARGV[3])
study.revision = (tonumber(study.revision) or 1) + 1
local updated = cjson.encode(study)
redis.call('SET', KEYS[1], updated)
return {1, updated}
`;

export async function replaceStudyConfigAtomic(
  studyId: string,
  expectedRevision: number,
  config: StoredStudy['config'],
  client?: Redis
): Promise<StudyMutationResult> {
  try {
    const kv = resolveClient(client);
    const result = await kv.eval<string[], [number, StoredStudy?]>(
      REPLACE_STUDY_CONFIG_SCRIPT,
      [`${STUDY_PREFIX}${studyId}`],
      [String(expectedRevision), JSON.stringify(config), String(Date.now())]
    );
    if (result[0] === 0) return { status: 'not-found' };
    if (result[0] === -1) return { status: 'conflict' };
    if (result[0] === 1 && result[1]) {
      return { status: 'updated', study: result[1] };
    }
    return { status: 'unavailable' };
  } catch (error) {
    console.error('Error replacing study config:', error);
    return { status: 'unavailable' };
  }
}

// Typed result for study reads where not-found and storage-unavailable must be
// distinguished (security checks fail closed on either, but with different errors).
export type StudyLoadResult =
  | { status: 'found'; study: StoredStudy }
  | { status: 'not-found' }
  | { status: 'unavailable' };

// Read a study, distinguishing "no such record" from "storage could not be read".
export async function getStudyChecked(id: string, client?: Redis): Promise<StudyLoadResult> {
  try {
    const kv = resolveClient(client);
    const study = await kv.get<StoredStudy>(`${STUDY_PREFIX}${id}`);
    return study ? { status: 'found', study } : { status: 'not-found' };
  } catch (error) {
    console.error('Error reading study from storage:', error);
    return { status: 'unavailable' };
  }
}

// Get study by ID.
// Returns null only for a genuine miss. Storage failures throw so callers can
// fail closed instead of mistaking an unavailable store for a missing record.
export async function getStudy(id: string, client?: Redis): Promise<StoredStudy | null> {
  const result = await getStudyChecked(id, client);
  if (result.status === 'unavailable') {
    throw new Error('Study storage is temporarily unavailable');
  }
  return result.status === 'found' ? result.study : null;
}

// Get all studies
export async function getAllStudies(client?: Redis): Promise<StoredStudy[]> {
  const result = await getAllStudiesChecked(client);
  if (result.status !== 'ok') throw new Error(`Study collection ${result.status}`);
  return result.items;
}

export async function getAllStudiesChecked(
  client?: Redis,
  maximum = 1_000
): Promise<CollectionLoadResult<StoredStudy>> {
  try {
    const kv = resolveClient(client);
    const count = await kv.scard(ALL_STUDIES_KEY);
    if (count > maximum) return { status: 'too-large', count, maximum };
    const ids = await kv.smembers(ALL_STUDIES_KEY);
    if (!ids || ids.length === 0) return { status: 'ok', items: [] };
    if (ids.length > maximum) return { status: 'too-large', count: ids.length, maximum };

    const studies = await Promise.all(
      ids.map(id => kv.get<StoredStudy>(`${STUDY_PREFIX}${id}`))
    );

    return {
      status: 'ok',
      items: studies
        .filter((s): s is StoredStudy => s !== null)
        .sort((a, b) => b.createdAt - a.createdAt),
    };
  } catch (error) {
    console.error('Error getting all studies:', error);
    return { status: 'unavailable' };
  }
}

const DELETE_EMPTY_STUDY_SCRIPT = `
if ARGV[2] ~= '' and redis.call('GET', KEYS[4]) == 'cancelled' then return -2 end
if redis.call('SCARD', KEYS[2]) > 0 then return 0 end
if redis.call('EXISTS', KEYS[1]) == 0 then
  if ARGV[2] ~= '' then redis.call('SET', KEYS[4], 'deleted') end
  return -1
end
redis.call('DEL', KEYS[1])
redis.call('SREM', KEYS[3], ARGV[1])
if ARGV[2] ~= '' then redis.call('SET', KEYS[4], 'deleted') end
return 1
`;

// Delete a study only if no interview exists. The emptiness check and delete
// are one Redis operation, so an interview commit cannot create an orphan by
// interleaving between them.
export async function deleteStudy(
  id: string,
  client?: Redis,
  operationMarkerId?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const kv = resolveClient(client);
    const result = await kv.eval<string[], number>(
      DELETE_EMPTY_STUDY_SCRIPT,
      [
        `${STUDY_PREFIX}${id}`,
        `${STUDY_INDEX_PREFIX}${id}`,
        ALL_STUDIES_KEY,
        `${STUDY_OPERATION_MARKER_PREFIX}${operationMarkerId || 'standalone'}`,
      ],
      [id, operationMarkerId || '']
    );
    if (result === 0) {
      return { success: false, error: 'Cannot delete study with existing interviews' };
    }
    if (result === -1) {
      return { success: false, error: 'Study not found' };
    }
    if (result === -2) {
      return { success: false, error: 'Study operation cancelled' };
    }
    if (result !== 1) {
      return { success: false, error: 'Failed to delete study' };
    }
    return { success: true };
  } catch (error) {
    console.error('Error deleting study:', error);
    return { success: false, error: 'Failed to delete study' };
  }
}

export type SettleStudyOperationMutationResult =
  | 'mutation-applied'
  | 'mutation-cancelled'
  | 'unavailable';

// Atomically observes the study and installs a BYOS tombstone for the inverse
// outcome. A delayed original mutation must check the same marker, so once this
// returns mutation-cancelled it cannot later cross the platform rollback.
export async function settleStudyOperationMutation(
  kind: 'create' | 'delete',
  studyId: string,
  operationMarkerId: string,
  client?: Redis
): Promise<SettleStudyOperationMutationResult> {
  const script = `
    local marker = redis.call('GET', KEYS[2])
    local exists = redis.call('EXISTS', KEYS[1]) == 1
    if ARGV[1] == 'create' then
      if marker == 'created' or exists then
        redis.call('SET', KEYS[2], 'created')
        return 1
      end
      redis.call('SET', KEYS[2], 'cancelled')
      return 0
    end
    if ARGV[1] == 'delete' then
      if marker == 'deleted' or not exists then
        redis.call('SET', KEYS[2], 'deleted')
        return 1
      end
      redis.call('SET', KEYS[2], 'cancelled')
      return 0
    end
    return -1
  `;
  try {
    const result = Number(await resolveClient(client).eval<string[], number>(
      script,
      [
        `${STUDY_PREFIX}${studyId}`,
        `${STUDY_OPERATION_MARKER_PREFIX}${operationMarkerId}`,
      ],
      [kind]
    ));
    if (result === 1) return 'mutation-applied';
    if (result === 0) return 'mutation-cancelled';
    return 'unavailable';
  } catch (error) {
    console.error('Error settling study operation mutation:', error);
    return 'unavailable';
  }
}
