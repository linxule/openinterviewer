import type { RedisPort } from '../redisPort';
import type {
  ExplorationAnswer, ExplorationStorePort, ExplorationWriteOutcome,
} from '../exploration/types';
import { MAX_EXPLORATION_ANSWERS } from '../exploration/types';
import { parseExplorationAnswer, isExplorationReservation, isCompleteExplorationInput, isFailExplorationInput } from '../exploration/validation';
import { canonicalJson, immutableSourceContentHash } from '../exploration/dataset';
import type { StoredInterview } from '@/types';
import { STUDY_JSON_LUA } from '../studyJsonLua';
import { logRequestFailure } from '../requestLog';

export const EXPLORATION_VALUE_PREFIX = 'oi:exploration:';
export const EXPLORATION_RECORD_PREFIX = 'study-exploration:';
export const EXPLORATION_INDEX_PREFIX = 'study-exploration-index:';
export const EXPLORATION_KEYS_PREFIX = 'study-exploration-keys:';
export const EXPLORATION_ORDER_PREFIX = 'study-exploration-order:';
const ID = /^[A-Za-z0-9_-]{1,120}$/;

/** Closed parser: corrupt records never become successful request replays. */
export function decodeExplorationAnswer(raw: unknown): ExplorationAnswer | null {
  if (typeof raw !== 'string' || !raw.startsWith(EXPLORATION_VALUE_PREFIX)) return null;
  try { return parseExplorationAnswer(JSON.parse(raw.slice(EXPLORATION_VALUE_PREFIX.length))); }
  catch { return null; }
}

const COMMON = `${STUDY_JSON_LUA}
local function decode(raw, prefix)
  if type(raw) ~= 'string' or string.sub(raw, 1, #prefix) ~= prefix then return nil end
  local ok, obj = pcall(cjson.decode, string.sub(raw, #prefix + 1))
  if not ok or type(obj) ~= 'table' then return nil end
  return obj
end
local studyRaw = redis.call('GET', KEYS[1])
if not studyRaw then return {'study-not-found'} end
local studyJson = string.sub(studyRaw, 1, 9) == 'oi:study:' and string.sub(studyRaw, 10) or studyRaw
local ok, study = pcall(cjson.decode, studyJson)
if not ok or type(study) ~= 'table' or study.id ~= ARGV[1] then return {'unavailable'} end
local guardRaw = redis.call('GET', KEYS[2])
if guardRaw then
  local guard = decode(guardRaw, 'oi:smg:')
  if not guard then return {'unavailable'} end
  if guard.state ~= 'created' then return {'held'} end
end
`;

const RESERVE = `${COMMON}
local mapped = redis.call('HGET', KEYS[4], ARGV[3])
if mapped then
  local m = decode(mapped, 'oi:exploration-key:')
  if not m or type(m.id) ~= 'string' or type(m.fingerprint) ~= 'string' then return {'unavailable'} end
  if m.fingerprint ~= ARGV[4] then return {'key-reuse'} end
  local raw = redis.call('GET', 'study-exploration:' .. ARGV[1] .. ':' .. m.id)
  if not raw then return {'unavailable'} end
  return {'replay', raw}
end
if (tonumber(study.revision) or 1) ~= tonumber(ARGV[2]) then return {'revision-stale'} end
if redis.call('SCARD', KEYS[3]) >= 500 then return {'quota'} end
if redis.call('ZCARD', KEYS[6]) ~= redis.call('SCARD', KEYS[3]) then return {'unavailable'} end
if redis.call('EXISTS', KEYS[5]) == 1 then return {'unavailable'} end
redis.call('SET', KEYS[5], ARGV[6])
redis.call('SADD', KEYS[3], ARGV[5])
redis.call('ZADD', KEYS[6], ARGV[7], ARGV[5])
redis.call('HSET', KEYS[4], ARGV[3], 'oi:exploration-key:' .. cjson.encode({id=ARGV[5],fingerprint=ARGV[4]}))
return {'created', ARGV[6]}
`;

const WRITE = `${COMMON}
local raw = redis.call('GET', KEYS[3])
if not raw then return {'not-found'} end
local answer = decode(raw, 'oi:exploration:')
if not answer or answer.studyId ~= ARGV[1] or answer.id ~= ARGV[2] then return {'unavailable'} end
if answer.requestFingerprint ~= ARGV[3] then return {'conflict'} end
if answer.status == 'complete' then
  if ARGV[4] == 'complete' and ARGV[10] == '1' and raw == ARGV[8] then return {'saved', raw} end
  return {'conflict'}
end
if answer.status ~= 'running' and answer.status ~= 'recovery-required' then return {'conflict'} end
if raw ~= ARGV[8] then return {'conflict'} end
if ARGV[4] == 'complete' then
  local snapshots = cjson.decode(ARGV[11])
  local position = 0
  for _, source in ipairs(answer.scope.sources or {}) do
    position = position + 1
    local interviewRaw = redis.call('GET', 'interview:' .. source.interviewId)
    if not interviewRaw then return {'conflict'} end
    if interviewRaw ~= snapshots[position] then return {'conflict'} end
    local payload = string.sub(interviewRaw, 1, 13) == 'oi:interview:' and string.sub(interviewRaw, 14) or interviewRaw
    local iok, interview = pcall(cjson.decode, payload)
    if not iok or type(interview) ~= 'table' or interview.studyId ~= ARGV[1] or interview.id ~= source.interviewId then return {'conflict'} end
  end
end
local updated = ARGV[9]
redis.call('SET', KEYS[3], updated)
return {'saved', updated}
`;

function base(studyId: string): string[] {
  return [`study:${studyId}`, `study-mutation-guard:${studyId}`];
}
function record(studyId: string, id: string): string { return `${EXPLORATION_RECORD_PREFIX}${studyId}:${id}`; }
function tuple(wire: unknown): unknown[] | null {
  return Array.isArray(wire) && wire.length >= 1 && typeof wire[0] === 'string' ? wire : null;
}
function encoded(answer: ExplorationAnswer): string { return `${EXPLORATION_VALUE_PREFIX}${JSON.stringify(answer)}`; }

export function createRedisExplorationStore(client: RedisPort): ExplorationStorePort {
  const execute = async (script: string, keys: string[], args: string[]) => {
    try { return tuple(await client.eval(script, keys, args)); }
    catch (error) { logRequestFailure({ event: 'kv.unavailable', operation: 'exploration' }, error); return null; }
  };
  const write = async (input: Parameters<ExplorationStorePort['complete']>[0] | Parameters<ExplorationStorePort['fail']>[0]): Promise<ExplorationWriteOutcome> => {
    const complete = 'result' in input;
    if (complete ? !isCompleteExplorationInput(input) : !isFailExplorationInput(input)) return { status: 'unavailable' };
    let existingRaw: unknown;
    try { existingRaw = await client.get(record(input.studyId, input.answerId)); }
    catch (error) { logRequestFailure({ event: 'kv.unavailable', operation: 'exploration' }, error); return { status: 'unavailable' }; }
    if (existingRaw === null) return { status: 'not-found' };
    const existing = decodeExplorationAnswer(existingRaw);
    if (!existing || existing.studyId !== input.studyId || existing.id !== input.answerId) return { status: 'unavailable' };
    if (existing.requestFingerprint !== input.requestFingerprint
      || (existing.status !== 'complete' && input.now < existing.updatedAt)) return { status: 'conflict' };
    const identicalComplete = complete && existing.status === 'complete'
      && canonicalJson(existing.result) === canonicalJson(input.result)
      && canonicalJson(existing.execution) === canonicalJson(input.execution);
    let sourceSnapshots: string[] = [];
    if (complete && existing.status !== 'complete') {
      const wire = await execute(`${COMMON}
if redis.call('GET', KEYS[3]) ~= ARGV[2] then return {'conflict'} end
local sources = cjson.decode(ARGV[3])
local result = {'sources'}
for _, id in ipairs(sources) do
  local raw = redis.call('GET', 'interview:' .. id)
  if not raw then return {'conflict'} end
  table.insert(result, 'oi:source:' .. raw)
end
return result`, [...base(input.studyId), record(input.studyId, input.answerId)],
      [input.studyId, existingRaw as string, JSON.stringify(existing.scope.sources.map(source => source.interviewId))]);
      if (!wire || wire[0] !== 'sources') {
        return { status: wire?.[0] === 'study-not-found' ? 'study-not-found' : wire?.[0] === 'held' ? 'held'
          : wire?.[0] === 'conflict' ? 'conflict' : 'unavailable' };
      }
      if (wire.length !== existing.scope.sources.length + 1 || wire.slice(1).some(raw => typeof raw !== 'string' || !raw.startsWith('oi:source:'))) return { status: 'unavailable' };
      sourceSnapshots = (wire.slice(1) as string[]).map(raw => raw.slice('oi:source:'.length));
      try {
        for (let index = 0; index < sourceSnapshots.length; index += 1) {
          const raw = sourceSnapshots[index];
          const interview = JSON.parse(raw.startsWith('oi:interview:') ? raw.slice('oi:interview:'.length) : raw) as StoredInterview;
          const expected = existing.scope.sources[index];
          if (!interview || interview.id !== expected.interviewId || interview.studyId !== existing.studyId
            || await immutableSourceContentHash(interview) !== expected.contentHash) return { status: 'conflict' };
        }
      } catch { return { status: 'unavailable' }; }
    }
    const { failureKind: _failure, ...retained } = existing;
    const next: ExplorationAnswer = complete
      ? { ...retained, status: 'complete', result: input.result, execution: input.execution, updatedAt: input.now }
      : { ...retained, status: input.status, failureKind: input.failureKind, updatedAt: input.now };
    const nextRaw = encoded(next);
    if (!decodeExplorationAnswer(nextRaw)) return { status: 'unavailable' };
    const wire = await execute(WRITE, [...base(input.studyId), record(input.studyId, input.answerId)],
      [input.studyId, input.answerId, input.requestFingerprint, complete ? 'complete' : input.status,
        String(input.now), '', '', existingRaw as string, nextRaw, identicalComplete ? '1' : '0', JSON.stringify(sourceSnapshots)]);
    if (wire?.length === 2 && wire[0] === 'saved') {
      const answer = decodeExplorationAnswer(wire[1]);
      return answer && answer.id === input.answerId && answer.studyId === input.studyId
        && answer.requestFingerprint === input.requestFingerprint ? { status: 'saved', answer } : { status: 'unavailable' };
    }
    if (wire?.length === 1 && ['study-not-found', 'not-found', 'conflict', 'held'].includes(wire[0] as string)) {
      return { status: wire[0] as 'study-not-found' | 'not-found' | 'conflict' | 'held' };
    }
    return { status: 'unavailable' };
  };
  return {
    async lookup(input) {
      if (!ID.test(input.studyId) || !/^[a-f0-9]{64}$/.test(input.keyDigest)
        || !/^[a-f0-9]{64}$/.test(input.requestFingerprint)) return { status: 'unavailable' };
      const wire = await execute(`${COMMON}
local mapped = redis.call('HGET', KEYS[3], ARGV[2])
if not mapped then return {'not-found'} end
local mapping = decode(mapped, 'oi:exploration-key:')
if not mapping or type(mapping.id) ~= 'string' or type(mapping.fingerprint) ~= 'string' then return {'unavailable'} end
if mapping.fingerprint ~= ARGV[3] then return {'key-reuse'} end
local raw = redis.call('GET', 'study-exploration:' .. ARGV[1] .. ':' .. mapping.id)
if not raw then return {'unavailable'} end
return {'found', raw}`, [...base(input.studyId), `${EXPLORATION_KEYS_PREFIX}${input.studyId}`],
      [input.studyId, input.keyDigest, input.requestFingerprint]);
      if (wire?.length === 1 && (wire[0] === 'not-found' || wire[0] === 'study-not-found')) return { status: 'not-found' };
      if (wire?.length === 1 && wire[0] === 'key-reuse') return { status: 'key-reuse' };
      const answer = wire?.length === 2 && wire[0] === 'found' ? decodeExplorationAnswer(wire[1]) : null;
      return answer && answer.studyId === input.studyId && answer.requestFingerprint === input.requestFingerprint
        ? { status: 'found', answer } : { status: 'unavailable' };
    },
    async reserve(input) {
      const raw = encoded(input.answer);
      if (!isExplorationReservation(input)) return { status: 'unavailable' };
      const id = input.answer.studyId;
      const wire = await execute(RESERVE, [...base(id), `${EXPLORATION_INDEX_PREFIX}${id}`,
        `${EXPLORATION_KEYS_PREFIX}${id}`, record(id, input.answer.id), `${EXPLORATION_ORDER_PREFIX}${id}`],
      [id, String(input.expectedStudyRevision), input.keyDigest, input.answer.requestFingerprint, input.answer.id, raw, String(input.answer.createdAt)]);
      if (wire?.length === 2 && (wire[0] === 'created' || wire[0] === 'replay')) {
        const answer = decodeExplorationAnswer(wire[1]);
        return answer && answer.studyId === id && answer.requestFingerprint === input.answer.requestFingerprint
          ? { status: wire[0], answer } : { status: 'unavailable' };
      }
      if (wire?.length === 1 && ['key-reuse', 'quota', 'study-not-found', 'revision-stale', 'held'].includes(wire[0] as string)) {
        return { status: wire[0] as 'key-reuse' | 'quota' | 'study-not-found' | 'revision-stale' | 'held' };
      }
      return { status: 'unavailable' };
    },
    async get(input) {
      if (!ID.test(input.studyId) || !ID.test(input.answerId)) return { status: 'unavailable' };
      const wire = await execute(`${COMMON} local raw = redis.call('GET', KEYS[3]); if not raw then return {'not-found'} end; return {'found', raw}`,
        [...base(input.studyId), record(input.studyId, input.answerId)], [input.studyId]);
      if (wire?.length === 1 && (wire[0] === 'not-found' || wire[0] === 'study-not-found')) return { status: 'not-found' };
      const answer = wire?.length === 2 && wire[0] === 'found' ? decodeExplorationAnswer(wire[1]) : null;
      return answer && answer.studyId === input.studyId && answer.id === input.answerId ? { status: 'found', answer } : { status: 'unavailable' };
    },
    async list(input) {
      if (!ID.test(input.studyId) || !Number.isSafeInteger(input.maximum) || input.maximum < 0 || input.maximum > MAX_EXPLORATION_ANSWERS) return { status: 'unavailable' };
      if (input.pageSize !== undefined && (!Number.isSafeInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 25)) return { status: 'unavailable' };
      const cursor = input.cursor?.match(/^(\d+):([A-Za-z0-9_-]{1,120})$/);
      if (input.cursor !== undefined && (!cursor || !Number.isSafeInteger(Number(cursor[1])))) return { status: 'unavailable' };
      const wire = await execute(`${COMMON}
if redis.call('SCARD', KEYS[3]) > tonumber(ARGV[2]) then return {'too-large'} end
if redis.call('ZCARD', KEYS[4]) ~= redis.call('SCARD', KEYS[3]) then return {'unavailable'} end
local result = {'ok', ''}
local limit = tonumber(ARGV[3])
local ids = redis.call('ZREVRANGE', KEYS[4], 0, -1, 'WITHSCORES')
local count = 0
local lastCursor = ''
for position = 1, #ids, 2 do
  local id = ids[position]
  local score = tonumber(ids[position + 1])
  if ARGV[4] == '' or score < tonumber(ARGV[4]) or (score == tonumber(ARGV[4]) and id < ARGV[5]) then
    if count == limit then result[2] = lastCursor; break end
    local raw = redis.call('GET', 'study-exploration:' .. ARGV[1] .. ':' .. id)
    local answer = decode(raw, 'oi:exploration:')
    if not answer or answer.id ~= id or answer.createdAt ~= score or answer.studyId ~= ARGV[1] then return {'unavailable'} end
    table.insert(result, raw)
    count = count + 1
    lastCursor = string.format('%.0f', score) .. ':' .. id
  end
end
return result`, [...base(input.studyId), `${EXPLORATION_INDEX_PREFIX}${input.studyId}`, `${EXPLORATION_ORDER_PREFIX}${input.studyId}`],
      [input.studyId, String(input.maximum), String(input.pageSize ?? input.maximum), cursor?.[1] ?? '', cursor?.[2] ?? '']);
      if (wire?.length === 1 && wire[0] === 'too-large') return { status: 'too-large' };
      if (wire?.length === 1 && wire[0] === 'study-not-found') return { status: 'ok', answers: [] };
      if (!wire || wire[0] !== 'ok') return { status: 'unavailable' };
      if (typeof wire[1] !== 'string') return { status: 'unavailable' };
      const answers = wire.slice(2).map(decodeExplorationAnswer);
      if (answers.some(a => !a || a.studyId !== input.studyId)) return { status: 'unavailable' };
      return { status: 'ok', answers: answers as ExplorationAnswer[],
        ...(input.pageSize !== undefined ? { nextCursor: wire[1] || null } : {}) };
    },
    complete: write,
    fail: write,
  };
}
