#!/usr/bin/env node
// inventory-redis (OPS-04 "Inventory old storage"): a read-only, metadata-only
// inventory of the Upstash Redis database behind a standalone Node/Vercel
// deployment, taken before choosing clean-start or preserve-data.
//
//   node scripts/cloudflare/inventory-redis.mjs [--max-keys N] [--max-seconds N] [--scan-count N]
//
// Credentials: {"KV_REST_API_URL": "https://<db>.upstash.io", "KV_REST_API_TOKEN": "…"} as
// JSON on stdin (KV_REST_API_READ_ONLY_TOKEN may replace KV_REST_API_TOKEN, and is
// preferred), or no-echo prompts in an interactive terminal. Never arguments or
// environment variables. The URL must pass the same check as src/lib/kvClient.ts
// (https and a *.upstash.io host); requests go only to that origin.
//
// Guarantees:
// - Only read commands are sent (PING, DBSIZE, SCAN, TYPE, PTTL, STRLEN, SCARD, ZCARD,
//   HLEN, LLEN, MEMORY USAGE and EVAL_RO of the one projection script below). The
//   executor refuses anything else before any network I/O.
// - Record bodies never leave the server. Identity/version/status fields are read by
//   PROJECTION_SCRIPT under EVAL_RO, which Redis runs read-only; it returns booleans,
//   counts, enumerated states and timestamps only.
// - The report prints no key names, identifiers, bodies, transcripts, link codes,
//   session identifiers or credentials: counts, sizes, distributions and error classes.
// - The scan is bounded by a key and a time budget; truncation is reported and the
//   report is then marked incomplete (exit 3).
//
// Exit codes: 0 complete report, 3 incomplete report (truncated or partial), 2 refused
// (bad input or credentials rejected), 1 failed (no report).
// Reference: docs/operations/cloudflare-migration/RUNBOOK.md (Production transition).

import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { isMain } from './lib.mjs';

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_REFUSED = 2;
export const EXIT_INCOMPLETE = 3;

export const REPORT_FORMAT = 'openinterviewer.redis-inventory.v1';

export const DEFAULT_LIMITS = Object.freeze({ maxKeys: 50_000, maxSeconds: 300, scanCount: 250 });
const HARD_LIMITS = Object.freeze({ maxKeys: 1_000_000, maxSeconds: 3_600, scanCountMin: 10, scanCountMax: 1_000 });
/** Same lease as kv.ts ANALYSIS_CLAIM_LEASE_MS (the inventory test keeps them equal). */
export const ANALYSIS_CLAIM_LEASE_MS = 180_000;
/** Collections larger than this are counted but not member-checked (reported). */
const MAX_CHECKED_MEMBERS = 10_000;
/** Keys per EVAL_RO call: keeps each server-side script short. */
const PROJECTION_CHUNK = 25;
const PROJECTION_CALLS_PER_REQUEST = 8;
const REQUEST_TIMEOUT_MS = 30_000;

const USAGE = `Usage: node scripts/cloudflare/inventory-redis.mjs [options]

Read-only, metadata-only inventory of a standalone deployment's Upstash Redis (OPS-04).
Prints one JSON report on stdout: counts, sizes, schema/shape distributions, pending
operations and orphaned references. No key names, identifiers or record contents.

Options
  --max-keys <n>      stop after this many distinct keys (default ${DEFAULT_LIMITS.maxKeys}, at most ${HARD_LIMITS.maxKeys})
  --max-seconds <n>   stop after this many seconds (default ${DEFAULT_LIMITS.maxSeconds}, at most ${HARD_LIMITS.maxSeconds})
  --scan-count <n>    SCAN COUNT hint per page (default ${DEFAULT_LIMITS.scanCount}, ${HARD_LIMITS.scanCountMin}-${HARD_LIMITS.scanCountMax})

Credentials
  {"KV_REST_API_URL": "https://<db>.upstash.io", "KV_REST_API_TOKEN": "…"} as JSON on stdin
  (prefer the read-only token: {"KV_REST_API_URL": "…", "KV_REST_API_READ_ONLY_TOKEN": "…"}),
  or no-echo prompts in an interactive terminal. Never arguments or environment variables.

Exit codes: 0 complete, 3 incomplete (truncated or partial), 2 refused, 1 failed.
`;

export class InventoryError extends Error {
  /** @param {string} message @param {{ exitCode?: number, errorClass?: string }} [options] */
  constructor(message, { exitCode = EXIT_FAILED, errorClass = 'failed' } = {}) {
    super(message);
    this.name = 'InventoryError';
    this.exitCode = exitCode;
    this.errorClass = errorClass;
  }
}

/** @param {string} message @param {string} [errorClass] */
const refuse = (message, errorClass = 'refused') => new InventoryError(message, { exitCode: EXIT_REFUSED, errorClass });

// ---------- Server-side projection (EVAL_RO only) ----------

/**
 * KEYS: keys of one family. ARGV: family, key prefix (for the key's identity
 * suffix), now (epoch ms), analysis claim lease (ms), member-check bound.
 * Returns one JSON object per key, in KEYS order, built only from booleans,
 * counts, enumerated states and timestamps. Keep every returned field on that
 * list: the report is printed and the bodies it reads are participant data.
 */
export const PROJECTION_SCRIPT = `-- openinterviewer redis inventory projection v1 (read-only; EVAL_RO)
local family = ARGV[1]
local prefix = ARGV[2]
local nowMs = tonumber(ARGV[3])
local leaseMs = tonumber(ARGV[4])
local maxMembers = tonumber(ARGV[5])

local function rcall(...)
  local res = redis.pcall(...)
  if type(res) == 'table' and res.err then return nil end
  return res
end
local function exists(key) return rcall('EXISTS', key) == 1 end
local function ismember(key, member) return rcall('SISMEMBER', key, member) == 1 end
local function card(key)
  local n = rcall('SCARD', key)
  if type(n) == 'number' then return n end
  return 0
end
local function isnull(v) return v == nil or v == cjson.null end
local function num(v) if type(v) == 'number' then return v end return nil end
local function enum(v, allowed)
  if isnull(v) then return 'absent' end
  if type(v) == 'string' and allowed[v] then return v end
  return 'other'
end
local function version(obj)
  local v = num(obj.version)
  if v and v >= 0 and v < 1000 and v == math.floor(v) then return v end
  if isnull(obj.version) then return 'absent' end
  return 'other'
end
local function safe_id(v)
  return type(v) == 'string' and #v > 0 and #v <= 128 and string.match(v, '^[A-Za-z0-9_-]+$') ~= nil
end
local function decode(raw, tag)
  local payload, enc = raw, 'bare'
  if tag ~= '' and string.sub(raw, 1, #tag) == tag then
    payload, enc = string.sub(raw, #tag + 1), 'prefixed'
  end
  local ok, obj = pcall(cjson.decode, payload)
  if not ok or type(obj) ~= 'table' then return nil, 'undecodable' end
  return obj, enc
end
-- 'present' | 'missing' | 'undecodable' | 'invalid-id', and the stored revision
local function study_ref(id)
  if not safe_id(id) then return 'invalid-id', nil end
  local raw = rcall('GET', 'study:' .. id)
  if raw == false or raw == nil then
    if exists('study:' .. id) then return 'undecodable', nil end
    return 'missing', nil
  end
  local s = decode(raw, 'oi:study:')
  if not s then return 'undecodable', nil end
  return 'present', num(s.revision)
end
local function revision_current(ref, rev, recorded)
  if ref ~= 'present' or rev == nil or num(recorded) == nil then return nil end
  return recorded == rev
end
-- alsoIn: another index; dangling members also listed there are counted as missingAlsoListed.
local function collection(r, key, kind, target, alsoIn)
  local n
  if kind == 'zset' then n = rcall('ZCARD', key) else n = rcall('SCARD', key) end
  if type(n) ~= 'number' then r.wrongType = true return end
  r.members = n
  if n > maxMembers then r.skipped = true return end
  local list
  if kind == 'zset' then list = rcall('ZRANGE', key, 0, -1) else list = rcall('SMEMBERS', key) end
  if type(list) ~= 'table' then r.skipped = true return end
  local missing, alsoListed = 0, 0
  for _, member in ipairs(list) do
    if type(member) ~= 'string' or not exists(target .. member) then
      missing = missing + 1
      if alsoIn and type(member) == 'string' and ismember(alsoIn, member) then alsoListed = alsoListed + 1 end
    end
  end
  r.missing = missing
  if alsoIn then r.missingAlsoListed = alsoListed end
end

local TAGS = {
  study = 'oi:study:', interview = 'oi:interview:', link = 'oi:link:', aggregate = 'oi:aggregate:',
  consent = '', idempotency = 'oi:idemp:', receipt = 'oi:receipt:', ['mutation-guard'] = 'oi:smg:',
  ['persist-guard'] = 'oi:pguard:', fingerprint = 'oi:fp:'
}
local ANALYSIS = { pending = true, running = true, complete = true, failed = true }
local FAILURE = { provider = true, ['invalid-output'] = true, ['too-large'] = true, timeout = true, storage = true }

local out = {}
for i, key in ipairs(KEYS) do
  local suffix = string.sub(key, #prefix + 1)
  local r = {}
  local tag = TAGS[family]
  local raw = nil
  local obj = nil
  if tag ~= nil then
    local value = redis.pcall('GET', key)
    if type(value) == 'table' then
      r.wrongType = true
    elseif value == false or value == nil then
      r.missing = true
    else
      raw = value
      if family == 'fingerprint' then
        if string.sub(raw, 1, #tag) == tag then r.enc = 'prefixed' else r.enc = 'bare' end
      else
        obj, r.enc = decode(raw, tag)
      end
    end
  end

  if family == 'study' then
    if raw then
      if obj then
        r.idOk = obj.id == suffix
        r.revision = num(obj.revision)
        r.locked = obj.isLocked == true
        r.cachedCount = num(obj.interviewCount)
        r.createdAt = num(obj.createdAt)
        r.linksDisabled = type(obj.config) == 'table' and obj.config.linksEnabled == false
      end
      r.indexCount = card('study-interviews:' .. suffix)
      r.listed = ismember('all-studies', suffix)
      r.aggregate = exists('study-aggregate:' .. suffix)
      r.guard = exists('study-mutation-guard:' .. suffix)
      r.persisting = card('study-persisting:' .. suffix)
    end
  elseif family == 'interview' then
    if raw then
      if obj then
        r.idOk = obj.id == suffix
        r.status = enum(obj.status, { completed = true, in_progress = true })
        r.study = study_ref(obj.studyId)
        if safe_id(obj.studyId) then r.indexed = ismember('study-interviews:' .. obj.studyId, suffix) end
        local a = obj.analysis
        if type(a) == 'table' then
          r.analysis = enum(a.status, ANALYSIS)
          r.attempts = num(a.attempts)
          if a.status == 'running' then
            local claimedAt = num(a.claimedAt)
            r.leaseExpired = claimedAt == nil or (nowMs - claimedAt) >= leaseMs
          end
          if a.status == 'failed' then r.failureKind = enum(a.failureKind, FAILURE) end
          r.recovery = a.recoveryRequired == true
          r.generation = num(a.generation) ~= nil
        elseif isnull(a) then
          r.analysis = 'absent'
        else
          r.analysis = 'other'
        end
        r.synthesis = type(obj.synthesis) == 'table'
        r.conductedBy = not isnull(obj.conductedByProvider)
        r.studyRevision = num(obj.studyRevision) ~= nil
        r.consent = type(obj.consentHash) == 'string'
        r.link = type(obj.participantLinkId) == 'string'
        r.createdAt = num(obj.createdAt)
        r.completedAt = num(obj.completedAt)
      end
      r.listed = ismember('all-interviews', suffix)
      r.fingerprint = exists('interview-fingerprint:' .. suffix)
      r.persistGuard = exists('interview-persisting:' .. suffix)
    end
  elseif family == 'link' then
    if obj then
      r.idOk = obj.id == suffix
      r.version = version(obj)
      local ref, rev = study_ref(obj.studyId)
      r.study = ref
      r.revisionCurrent = revision_current(ref, rev, obj.studyRevision)
      r.revoked = not isnull(obj.revokedAt)
      local expiresAt = num(obj.expiresAt)
      r.expired = expiresAt ~= nil and expiresAt <= nowMs
      if safe_id(obj.researcherId) then
        r.owner = 'researcher'
        r.indexed = ismember('participant-links:' .. obj.researcherId, suffix)
      else
        r.owner = 'none'
        r.indexed = ismember('participant-link-index:none', suffix)
      end
    end
  elseif family == 'aggregate' then
    local ref, rev = study_ref(suffix)
    r.study = ref
    if obj then
      r.idOk = obj.studyId == suffix
      r.receiptMember = obj._receipt ~= nil
      r.revisionCurrent = revision_current(ref, rev, obj.studyRevision)
    end
  elseif family == 'consent' then
    if obj then
      r.version = version(obj)
      local ref, rev = study_ref(obj.studyId)
      r.study = ref
      r.revisionCurrent = revision_current(ref, rev, obj.studyRevision)
    end
  elseif family == 'idempotency' then
    if obj then
      r.version = version(obj)
      r.state = enum(obj.state, { pending = true, created = true, deleted = true })
      r.study = study_ref(obj.studyId)
    end
  elseif family == 'receipt' then
    if obj then
      r.version = version(obj)
      r.kind = enum(obj.kind, { create = true, delete = true })
      r.resolution = enum(obj.resolution, { created = true, deleted = true, cancelled = true })
    end
  elseif family == 'mutation-guard' then
    if obj then
      r.version = version(obj)
      r.kind = enum(obj.kind, { create = true, delete = true })
      r.state = enum(obj.state, { ['in-flight'] = true, cancelled = true, deleted = true, created = true })
    end
    if raw then r.study = study_ref(suffix) end
  elseif family == 'persist-guard' then
    if obj then
      r.version = version(obj)
      r.study = study_ref(obj.studyId)
      if safe_id(obj.studyId) then r.inStudySet = ismember('study-persisting:' .. obj.studyId, suffix) end
    end
    if raw then r.interview = exists('interview:' .. suffix) end
  elseif family == 'fingerprint' then
    if raw then r.interview = exists('interview:' .. suffix) end
  elseif family == 'study-index' then
    collection(r, key, 'set', 'interview:', 'all-interviews')
    r.study = study_ref(suffix)
  elseif family == 'persisting-set' then
    collection(r, key, 'set', 'interview-persisting:')
    r.study = study_ref(suffix)
  elseif family == 'all-studies' then
    collection(r, key, 'set', 'study:')
  elseif family == 'all-interviews' then
    collection(r, key, 'set', 'interview:')
  elseif family == 'link-index' then
    collection(r, key, 'set', 'participant-link:')
  elseif family == 'idempotency-index' then
    collection(r, key, 'zset', 'create-idemp:')
  else
    r.unknownFamily = true
  end
  out[i] = cjson.encode(r)
end
return out
`;

// ---------- Key families (standalone layout: kv.ts, participantLinks.ts, …) ----------

/**
 * @typedef {{ name: string, prefixes?: string[], exact?: string, type: string | null, projection: string | null }} Family
 */

/** @type {Family[]} */
export const FAMILIES = [
  { name: 'studies', prefixes: ['study:'], type: 'string', projection: 'study' },
  { name: 'interviews', prefixes: ['interview:'], type: 'string', projection: 'interview' },
  { name: 'interviewFingerprints', prefixes: ['interview-fingerprint:'], type: 'string', projection: 'fingerprint' },
  { name: 'interviewPersistGuards', prefixes: ['interview-persisting:'], type: 'string', projection: 'persist-guard' },
  { name: 'studyInterviewIndexes', prefixes: ['study-interviews:'], type: 'set', projection: 'study-index' },
  { name: 'studyPersistingSets', prefixes: ['study-persisting:'], type: 'set', projection: 'persisting-set' },
  { name: 'allStudiesIndex', exact: 'all-studies', type: 'set', projection: 'all-studies' },
  { name: 'allInterviewsIndex', exact: 'all-interviews', type: 'set', projection: 'all-interviews' },
  { name: 'aggregates', prefixes: ['study-aggregate:'], type: 'string', projection: 'aggregate' },
  { name: 'operationReceipts', prefixes: ['study-operation-result:'], type: 'string', projection: 'receipt' },
  { name: 'mutationGuards', prefixes: ['study-mutation-guard:'], type: 'string', projection: 'mutation-guard' },
  { name: 'participantLinks', prefixes: ['participant-link:'], type: 'string', projection: 'link' },
  { name: 'participantLinkIndexes', prefixes: ['participant-link-index:', 'participant-links:'], type: 'set', projection: 'link-index' },
  { name: 'consents', prefixes: ['participant-consent:'], type: 'string', projection: 'consent' },
  { name: 'createIdempotency', prefixes: ['create-idemp:'], type: 'string', projection: 'idempotency' },
  { name: 'createIdempotencyIndexes', prefixes: ['create-idemp-index:'], type: 'zset', projection: 'idempotency-index' },
  { name: 'participantRateLimits', prefixes: ['rate-limit:'], type: 'string', projection: null },
  { name: 'saveRateLimits', prefixes: ['interview-rate:'], type: 'zset', projection: null },
];
const UNRECOGNIZED = { name: 'unrecognized', type: null, projection: null };

/** @param {string} key @returns {{ family: Family | typeof UNRECOGNIZED, prefix: string }} */
export function classifyKey(key) {
  for (const family of FAMILIES) {
    if (family.exact !== undefined) {
      if (key === family.exact) return { family, prefix: '' };
      continue;
    }
    for (const prefix of family.prefixes ?? []) {
      if (key.length > prefix.length && key.startsWith(prefix)) return { family, prefix };
    }
  }
  return { family: UNRECOGNIZED, prefix: '' };
}

/**
 * A printable label for an unrecognized key: its first segment when that is a
 * short lowercase word (a namespace such as `other-app:`), never anything that
 * could be an identifier or token.
 * @param {string} key
 */
export function unrecognizedLabel(key) {
  const match = /^([a-z][a-z-]{0,31}):./.exec(key);
  return match ? `${match[1]}:` : '(other)';
}

// ---------- Read-only executor (Upstash REST) ----------

const READ_ONLY_COMMANDS = new Set(['PING', 'DBSIZE', 'SCAN', 'TYPE', 'PTTL', 'STRLEN', 'SCARD', 'ZCARD', 'HLEN', 'LLEN']);

/** Refuses, before any I/O, every command that is not on the read-only list. @param {unknown} command */
export function assertReadCommand(command) {
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== 'string')) {
    throw new InventoryError('internal: malformed command', { errorClass: 'internal' });
  }
  const name = command[0].toUpperCase();
  if (READ_ONLY_COMMANDS.has(name)) return;
  if (name === 'MEMORY' && command.length === 3 && command[1].toUpperCase() === 'USAGE') return;
  if (name === 'EVAL_RO' && command[1] === PROJECTION_SCRIPT) return;
  throw new InventoryError(`refusing to send ${/^[A-Z_]{1,20}$/.test(name) ? name : 'a command'}: the inventory sends read-only commands only`, {
    errorClass: 'write-refused',
  });
}

/** kvClient.ts isValidUpstashUrl, verbatim. @param {string} url */
export function isValidUpstashUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname.endsWith('.upstash.io');
  } catch {
    return false;
  }
}

/**
 * The origin requests go to: the kvClient check, then (stricter) no userinfo,
 * and the canonical `https://<host>` form kvClient's canonicalRedisOrigin uses.
 * @param {unknown} url
 */
export function upstashOrigin(url) {
  if (typeof url !== 'string' || url.length === 0 || url.length > 2048 || !isValidUpstashUrl(url)) {
    throw refuse('KV_REST_API_URL must be an https URL on an *.upstash.io host (the check src/lib/kvClient.ts applies)', 'invalid-url');
  }
  const parsed = new URL(url);
  if (parsed.username || parsed.password) throw refuse('KV_REST_API_URL must not carry credentials', 'invalid-url');
  return `https://${parsed.hostname.toLowerCase()}`;
}

/** sha256(`oi:storage-id:v1` + 0x00 + origin): kvClient's storageIdFromRedisUrl. @param {string} origin */
export function storageIdForOrigin(origin) {
  return createHash('sha256').update('oi:storage-id:v1').update('\u0000').update(origin).digest('hex');
}

/** @param {unknown} token */
function validateToken(token) {
  if (typeof token !== 'string' || token.length === 0) throw refuse('the REST token is blank', 'invalid-token');
  if (token.length > 4096) throw refuse('the REST token is longer than 4096 characters', 'invalid-token');
  if (/[\s\u0000-\u001f\u007f]/.test(token)) throw refuse('the REST token contains whitespace or control characters', 'invalid-token');
}

/**
 * A server error message can echo command arguments (key names); keep only a class.
 * @param {unknown} message
 */
export function classifyRedisError(message) {
  const text = typeof message === 'string' ? message : '';
  if (/unknown command|unknown subcommand|not supported|unsupported|not available/i.test(text)) return 'unsupported-command';
  if (/noperm|permission|not allowed|read ?only|readonly/i.test(text)) return 'not-permitted';
  if (/wrongtype/i.test(text)) return 'wrong-type';
  if (/busy|timeout|timed out/i.test(text)) return 'server-busy';
  return 'redis-error';
}

/** @param {unknown} error */
function transportClass(error) {
  const err = /** @type {{ name?: string, code?: string, cause?: { code?: string } }} */ (error ?? {});
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timeout';
  const code = err.cause?.code ?? err.code;
  return typeof code === 'string' && /^[A-Z_]{2,40}$/.test(code) ? `network-${code.toLowerCase()}` : 'network-error';
}

/**
 * @typedef {{ ok: true, value: unknown } | { ok: false, errorClass: string }} CommandReply
 * @typedef {{ origin: string, storageId: string, stats: { requests: number, commands: number },
 *   pipeline(commands: string[][]): Promise<CommandReply[]> }} ReadExecutor
 */

/**
 * The production executor: Upstash REST `/pipeline` (POST, JSON array of
 * commands, `Authorization: Bearer`), one request per call, no redirects.
 * @param {{ url: unknown, token: unknown, fetchImpl?: typeof fetch, timeoutMs?: number }} options
 * @returns {ReadExecutor}
 */
export function createUpstashRestExecutor({ url, token, fetchImpl = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const origin = upstashOrigin(url);
  validateToken(token);
  const authorization = `Bearer ${/** @type {string} */ (token)}`;
  const stats = { requests: 0, commands: 0 };
  return {
    origin,
    storageId: storageIdForOrigin(origin),
    stats,
    async pipeline(commands) {
      if (!Array.isArray(commands) || commands.length === 0) {
        throw new InventoryError('internal: empty pipeline', { errorClass: 'internal' });
      }
      for (const command of commands) assertReadCommand(command);
      stats.requests += 1;
      stats.commands += commands.length;
      let response;
      try {
        response = await fetchImpl(`${origin}/pipeline`, {
          method: 'POST',
          headers: { authorization, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(commands),
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const errorClass = transportClass(error);
        throw new InventoryError(`request to Upstash failed (${errorClass})`, { errorClass });
      }
      if (response.status === 401 || response.status === 403) {
        throw new InventoryError(`Upstash refused the token (HTTP ${response.status})`, { exitCode: EXIT_REFUSED, errorClass: 'unauthorized' });
      }
      if (!response.ok) {
        throw new InventoryError(`Upstash request failed (HTTP ${response.status})`, { errorClass: `http-${response.status}` });
      }
      let body;
      try {
        body = await response.json();
      } catch {
        throw new InventoryError('Upstash returned a response that is not JSON', { errorClass: 'bad-response' });
      }
      if (!Array.isArray(body) || body.length !== commands.length) {
        throw new InventoryError('Upstash returned a pipeline response of the wrong shape', { errorClass: 'bad-response' });
      }
      return body.map((item) => {
        if (item && typeof item === 'object' && 'error' in item && item.error !== undefined && item.error !== null) {
          return { ok: false, errorClass: classifyRedisError(item.error) };
        }
        if (item && typeof item === 'object' && 'result' in item) return { ok: true, value: item.result };
        return { ok: false, errorClass: 'bad-response' };
      });
    },
  };
}

// ---------- Inventory ----------

/** @param {unknown} value */
function toCount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d{1,18}$/.test(value)) return Number(value);
  return null;
}

/** @param {Record<string, number>} counter @param {string} name */
function inc(counter, name, by = 1) {
  counter[name] = (counter[name] ?? 0) + by;
}

/** @param {{ oldest: string | null, newest: string | null }} range @param {unknown} ms */
function widen(range, ms) {
  if (typeof ms !== 'number' || !Number.isSafeInteger(ms) || ms <= 0) return;
  const iso = new Date(ms).toISOString();
  if (range.oldest === null || iso < range.oldest) range.oldest = iso;
  if (range.newest === null || iso > range.newest) range.newest = iso;
}

const emptyRange = () => ({ oldest: null, newest: null });
const encodingCounter = () => ({ prefixed: 0, bare: 0, undecodable: 0 });
const studyRefCounter = () => ({ present: 0, missing: 0, undecodable: 0, 'invalid-id': 0 });

function emptyRecords() {
  return {
    studies: {
      projected: 0, encoding: encodingCounter(), identityMismatch: 0,
      revision: { present: 0, missing: 0, max: 0 }, locked: 0, linksDisabled: 0,
      notInAllStudies: 0, cachedCountMismatch: 0, withAggregate: 0, withMutationGuard: 0,
      withUnfinishedPersists: 0, createdAt: emptyRange(),
    },
    interviews: {
      projected: 0, encoding: encodingCounter(), identityMismatch: 0,
      status: { completed: 0, in_progress: 0, other: 0, absent: 0 },
      study: studyRefCounter(),
      analysis: {
        member: { absent: 0, pending: 0, running: 0, complete: 0, failed: 0, other: 0 },
        effective: { pending: 0, running: 0, complete: 0, failed: 0, other: 0 },
        runningLeaseActive: 0, runningLeaseExpired: 0, pendingAfterAttempt: 0, attempted: 0,
        recoveryRequired: 0, withGeneration: 0,
        failureKind: {},
        importMapping: { notScheduled: 0, complete: 0, failedTerminal: 0, recoveryRequired: 0, unmapped: 0 },
      },
      shape: { withSynthesis: 0, withConductedBy: 0, withStudyRevision: 0, withConsent: 0, withParticipantLink: 0 },
      notInStudyIndex: 0, notInAllInterviews: 0, withoutFingerprint: 0, withPersistGuard: 0,
      createdAt: emptyRange(), completedAt: emptyRange(),
    },
    participantLinks: {
      projected: 0, encoding: encodingCounter(), identityMismatch: 0, version: {},
      state: { active: 0, expired: 0, revoked: 0 }, owner: { none: 0, researcher: 0 },
      study: studyRefCounter(), revisionStale: 0, notIndexed: 0,
    },
    aggregates: {
      projected: 0, encoding: encodingCounter(), identityMismatch: 0, study: studyRefCounter(),
      revisionStale: 0, withReceiptMember: 0,
    },
    consents: { projected: 0, encoding: encodingCounter(), version: {}, study: studyRefCounter(), revisionStale: 0 },
    createIdempotency: {
      projected: 0, encoding: encodingCounter(), version: {},
      state: { pending: 0, created: 0, deleted: 0, other: 0, absent: 0 },
      study: studyRefCounter(), createdWithoutStudy: 0,
    },
    operationReceipts: {
      projected: 0, encoding: encodingCounter(), version: {},
      kind: { create: 0, delete: 0, other: 0, absent: 0 },
      resolution: { created: 0, deleted: 0, cancelled: 0, other: 0, absent: 0 },
    },
    mutationGuards: {
      projected: 0, encoding: encodingCounter(), version: {},
      kind: { create: 0, delete: 0, other: 0, absent: 0 },
      state: { 'in-flight': 0, cancelled: 0, deleted: 0, created: 0, other: 0, absent: 0 },
      study: studyRefCounter(),
    },
    persistGuards: {
      projected: 0, encoding: encodingCounter(), version: {}, study: studyRefCounter(),
      interviewMissing: 0, notInStudyPersistingSet: 0,
    },
    fingerprints: { projected: 0, encoding: encodingCounter(), interviewMissing: 0 },
  };
}

const collectionStats = () => ({ keys: 0, members: 0, missingTargets: 0, skippedOverBound: 0, study: studyRefCounter() });

function emptyCollections() {
  return {
    allStudies: collectionStats(),
    allInterviews: collectionStats(),
    // Dangling members that all-interviews also lists: one missing interview, listed twice.
    studyInterviewIndexes: { ...collectionStats(), missingTargetsAlsoInAllInterviews: 0 },
    studyPersistingSets: collectionStats(),
    participantLinkIndexes: collectionStats(),
    createIdempotencyIndexes: collectionStats(),
  };
}

const COLLECTION_BY_PROJECTION = {
  'all-studies': 'allStudies',
  'all-interviews': 'allInterviews',
  'study-index': 'studyInterviewIndexes',
  'persisting-set': 'studyPersistingSets',
  'link-index': 'participantLinkIndexes',
  'idempotency-index': 'createIdempotencyIndexes',
};

const SIZE_COMMAND = { string: 'STRLEN', set: 'SCARD', zset: 'ZCARD', hash: 'HLEN', list: 'LLEN' };

function emptyFamilyStats() {
  return {
    count: 0,
    types: {},
    typeMismatch: 0,
    ttl: { persistent: 0, expiring: 0 },
    bytes: { total: 0, max: 0 },
    members: { total: 0, max: 0 },
    memoryUsage: { total: 0, max: 0 },
  };
}

/** @param {{ total: number, max: number }} stat @param {number} value */
function addSize(stat, value) {
  stat.total += value;
  if (value > stat.max) stat.max = value;
}

/** @param {Record<string, number>} counter @param {unknown} value */
function incVersion(counter, value) {
  inc(counter, typeof value === 'number' ? `v${value}` : String(value ?? 'absent'));
}

/** @param {Record<string, number>} counter @param {unknown} ref */
function incStudyRef(counter, ref) {
  if (typeof ref === 'string' && ref in counter) inc(counter, ref);
}

/**
 * Walk the database with bounded SCAN pages and return the metadata report.
 * @param {ReadExecutor} executor
 * @param {{ maxKeys?: number, maxSeconds?: number, scanCount?: number, clock?: () => number,
 *   progress?: (message: string) => void }} [options]
 */
export async function runInventory(executor, options = {}) {
  const limits = resolveLimits(options);
  const clock = options.clock ?? Date.now;
  const progress = options.progress ?? (() => {});
  const startedAt = clock();
  const nowMs = startedAt;
  const deadline = startedAt + limits.maxSeconds * 1000;

  const families = new Map();
  const unrecognizedPrefixes = new Map();
  const records = emptyRecords();
  const collections = emptyCollections();
  const errors = [];
  const capabilities = { memoryUsage: /** @type {boolean | null} */ (null), fieldProjection: /** @type {boolean | null} */ (null), fieldProjectionError: /** @type {string | null} */ (null) };
  const scan = {
    finished: false, truncated: /** @type {string | null} */ (null), pages: 0, keysSeen: 0, duplicatesSkipped: 0,
    vanishedDuringScan: 0, dbsizeBefore: /** @type {number | null} */ (null), dbsizeAfter: /** @type {number | null} */ (null),
  };
  let unprojected = 0;
  let projectedWrongType = 0;
  /** SCAN may return a key more than once; memory is bounded by maxKeys. */
  const seenKeys = new Set();

  /** @param {string} phase @param {string} errorClass */
  const recordError = (phase, errorClass) => {
    const existing = errors.find((entry) => entry.phase === phase && entry.errorClass === errorClass);
    if (existing) existing.count += 1;
    else errors.push({ phase, errorClass, count: 1 });
  };
  /** @param {string} name */
  const familyStats = (name) => {
    if (!families.has(name)) families.set(name, emptyFamilyStats());
    return families.get(name);
  };

  const [pong, dbsize] = await executor.pipeline([['PING'], ['DBSIZE']]);
  if (!pong.ok) throw new InventoryError(`PING failed (${pong.errorClass})`, { errorClass: pong.errorClass });
  scan.dbsizeBefore = dbsize.ok ? toCount(dbsize.value) : null;

  /** @param {string} key */
  async function probeMemory(key) {
    try {
      const [reply] = await executor.pipeline([['MEMORY', 'USAGE', key]]);
      capabilities.memoryUsage = reply.ok;
    } catch (error) {
      if (!(error instanceof InventoryError) || error.exitCode === EXIT_REFUSED || !error.errorClass.startsWith('http-4')) throw error;
      capabilities.memoryUsage = false;
    }
  }

  /** @param {{ family: Family, prefix: string, keys: string[] }[]} groups */
  async function project(groups) {
    const calls = [];
    for (const group of groups) {
      for (let at = 0; at < group.keys.length; at += PROJECTION_CHUNK) {
        const keys = group.keys.slice(at, at + PROJECTION_CHUNK);
        calls.push({
          projection: /** @type {string} */ (group.family.projection),
          keys,
          command: [
            'EVAL_RO', PROJECTION_SCRIPT, String(keys.length), ...keys,
            /** @type {string} */ (group.family.projection), group.prefix, String(nowMs),
            String(ANALYSIS_CLAIM_LEASE_MS), String(MAX_CHECKED_MEMBERS),
          ],
        });
      }
    }
    for (let at = 0; at < calls.length; at += PROJECTION_CALLS_PER_REQUEST) {
      const batch = calls.slice(at, at + PROJECTION_CALLS_PER_REQUEST);
      if (capabilities.fieldProjection === false) {
        for (const call of batch) unprojected += call.keys.length;
        continue;
      }
      let replies;
      try {
        replies = await executor.pipeline(batch.map((call) => call.command));
      } catch (error) {
        if (!(error instanceof InventoryError) || error.exitCode === EXIT_REFUSED || !error.errorClass.startsWith('http-4')) throw error;
        capabilities.fieldProjection = false;
        capabilities.fieldProjectionError = error.errorClass;
        for (const call of batch) unprojected += call.keys.length;
        continue;
      }
      batch.forEach((call, index) => {
        const reply = replies[index];
        if (!reply.ok) {
          if (reply.errorClass === 'unsupported-command' || reply.errorClass === 'not-permitted') {
            capabilities.fieldProjection = false;
            capabilities.fieldProjectionError = reply.errorClass;
          } else {
            recordError('projection', reply.errorClass);
          }
          unprojected += call.keys.length;
          return;
        }
        const values = Array.isArray(reply.value) ? reply.value : null;
        if (!values || values.length !== call.keys.length) {
          recordError('projection', 'bad-response');
          unprojected += call.keys.length;
          return;
        }
        capabilities.fieldProjection = true;
        for (const raw of values) {
          let fields;
          try {
            fields = typeof raw === 'string' ? JSON.parse(raw) : null;
          } catch {
            fields = null;
          }
          if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
            recordError('projection', 'bad-response');
            unprojected += 1;
            continue;
          }
          if (fields.wrongType) projectedWrongType += 1;
          accumulate(call.projection, fields);
        }
      });
    }
  }

  /** @param {string} projection @param {Record<string, any>} f */
  function accumulate(projection, f) {
    const collectionName = COLLECTION_BY_PROJECTION[/** @type {keyof typeof COLLECTION_BY_PROJECTION} */ (projection)];
    if (collectionName) {
      const c = collections[/** @type {keyof typeof collections} */ (collectionName)];
      if (f.wrongType) return;
      c.keys += 1;
      c.members += typeof f.members === 'number' ? f.members : 0;
      if (f.skipped) c.skippedOverBound += 1;
      if (typeof f.missing === 'number') c.missingTargets += f.missing;
      if (typeof f.missingAlsoListed === 'number' && 'missingTargetsAlsoInAllInterviews' in c) {
        c.missingTargetsAlsoInAllInterviews += f.missingAlsoListed;
      }
      if (f.study !== undefined) incStudyRef(c.study, f.study);
      return;
    }
    if (f.missing || f.wrongType) return;
    switch (projection) {
      case 'study': {
        const s = records.studies;
        s.projected += 1;
        inc(s.encoding, f.enc);
        if (f.idOk === false) s.identityMismatch += 1;
        if (typeof f.revision === 'number') {
          s.revision.present += 1;
          s.revision.max = Math.max(s.revision.max, f.revision);
        } else if (f.enc !== 'undecodable') {
          s.revision.missing += 1;
        }
        if (f.locked) s.locked += 1;
        if (f.linksDisabled) s.linksDisabled += 1;
        if (f.listed === false) s.notInAllStudies += 1;
        if (typeof f.cachedCount === 'number' && f.cachedCount !== f.indexCount) s.cachedCountMismatch += 1;
        if (f.aggregate) s.withAggregate += 1;
        if (f.guard) s.withMutationGuard += 1;
        if (f.persisting > 0) s.withUnfinishedPersists += 1;
        widen(s.createdAt, f.createdAt);
        break;
      }
      case 'interview': {
        const s = records.interviews;
        s.projected += 1;
        inc(s.encoding, f.enc);
        if (f.listed === false) s.notInAllInterviews += 1;
        if (f.fingerprint === false) s.withoutFingerprint += 1;
        if (f.persistGuard) s.withPersistGuard += 1;
        if (f.enc === 'undecodable') break;
        if (f.idOk === false) s.identityMismatch += 1;
        inc(s.status, f.status);
        incStudyRef(s.study, f.study);
        if (f.indexed === false) s.notInStudyIndex += 1;
        inc(s.analysis.member, f.analysis);
        const effective = f.analysis === 'absent' ? (f.synthesis ? 'complete' : 'pending') : f.analysis;
        inc(s.analysis.effective, effective);
        const attempts = typeof f.attempts === 'number' ? f.attempts : 0;
        if (attempts > 0) s.analysis.attempted += 1;
        if (effective === 'running') {
          if (f.leaseExpired) s.analysis.runningLeaseExpired += 1;
          else s.analysis.runningLeaseActive += 1;
        }
        if (effective === 'pending' && attempts > 0) s.analysis.pendingAfterAttempt += 1;
        if (f.recovery) s.analysis.recoveryRequired += 1;
        if (f.generation) s.analysis.withGeneration += 1;
        if (f.failureKind !== undefined) inc(s.analysis.failureKind, f.failureKind);
        // IMPLEMENTATION.md §7 F7: the importer's mapping of Node analysis states.
        let mapping = 'unmapped';
        if (effective === 'complete') mapping = 'complete';
        else if (effective === 'failed') mapping = 'failedTerminal';
        else if (effective === 'running') mapping = 'recoveryRequired';
        else if (effective === 'pending') mapping = attempts > 0 ? 'recoveryRequired' : 'notScheduled';
        inc(s.analysis.importMapping, mapping);
        if (f.synthesis) s.shape.withSynthesis += 1;
        if (f.conductedBy) s.shape.withConductedBy += 1;
        if (f.studyRevision) s.shape.withStudyRevision += 1;
        if (f.consent) s.shape.withConsent += 1;
        if (f.link) s.shape.withParticipantLink += 1;
        widen(s.createdAt, f.createdAt);
        widen(s.completedAt, f.completedAt);
        break;
      }
      case 'link': {
        const s = records.participantLinks;
        s.projected += 1;
        inc(s.encoding, f.enc);
        if (f.enc === 'undecodable') break;
        if (f.idOk === false) s.identityMismatch += 1;
        incVersion(s.version, f.version);
        if (f.revoked) s.state.revoked += 1;
        else if (f.expired) s.state.expired += 1;
        else s.state.active += 1;
        inc(s.owner, f.owner);
        incStudyRef(s.study, f.study);
        if (f.revisionCurrent === false) s.revisionStale += 1;
        if (f.indexed === false) s.notIndexed += 1;
        break;
      }
      case 'aggregate': {
        const s = records.aggregates;
        s.projected += 1;
        inc(s.encoding, f.enc);
        incStudyRef(s.study, f.study);
        if (f.enc === 'undecodable') break;
        if (f.idOk === false) s.identityMismatch += 1;
        if (f.receiptMember) s.withReceiptMember += 1;
        if (f.revisionCurrent === false) s.revisionStale += 1;
        break;
      }
      case 'consent': {
        const s = records.consents;
        s.projected += 1;
        inc(s.encoding, f.enc);
        if (f.enc === 'undecodable') break;
        incVersion(s.version, f.version);
        incStudyRef(s.study, f.study);
        if (f.revisionCurrent === false) s.revisionStale += 1;
        break;
      }
      case 'idempotency': {
        const s = records.createIdempotency;
        s.projected += 1;
        inc(s.encoding, f.enc);
        if (f.enc === 'undecodable') break;
        incVersion(s.version, f.version);
        inc(s.state, f.state);
        incStudyRef(s.study, f.study);
        if (f.state === 'created' && f.study === 'missing') s.createdWithoutStudy += 1;
        break;
      }
      case 'receipt': {
        const s = records.operationReceipts;
        s.projected += 1;
        inc(s.encoding, f.enc);
        if (f.enc === 'undecodable') break;
        incVersion(s.version, f.version);
        inc(s.kind, f.kind);
        inc(s.resolution, f.resolution);
        break;
      }
      case 'mutation-guard': {
        const s = records.mutationGuards;
        s.projected += 1;
        inc(s.encoding, f.enc);
        incStudyRef(s.study, f.study);
        if (f.enc === 'undecodable') break;
        incVersion(s.version, f.version);
        inc(s.kind, f.kind);
        inc(s.state, f.state);
        break;
      }
      case 'persist-guard': {
        const s = records.persistGuards;
        s.projected += 1;
        inc(s.encoding, f.enc);
        if (f.interview === false) s.interviewMissing += 1;
        if (f.enc === 'undecodable') break;
        incVersion(s.version, f.version);
        incStudyRef(s.study, f.study);
        if (f.inStudySet === false) s.notInStudyPersistingSet += 1;
        break;
      }
      case 'fingerprint': {
        const s = records.fingerprints;
        s.projected += 1;
        inc(s.encoding, f.enc);
        if (f.interview === false) s.interviewMissing += 1;
        break;
      }
      default:
        recordError('projection', 'unknown-family');
    }
  }

  /** @param {string[]} keys */
  async function inspectBatch(keys) {
    const meta = await executor.pipeline(keys.flatMap((key) => [['TYPE', key], ['PTTL', key]]));
    const live = [];
    keys.forEach((key, index) => {
      const typeReply = meta[index * 2];
      const ttlReply = meta[index * 2 + 1];
      if (!typeReply.ok) {
        recordError('type', typeReply.errorClass);
        return;
      }
      const type = String(typeReply.value);
      if (type === 'none') {
        scan.vanishedDuringScan += 1;
        return;
      }
      const { family, prefix } = classifyKey(key);
      const stats = familyStats(family.name);
      stats.count += 1;
      inc(stats.types, /^[A-Za-z0-9_-]{1,32}$/.test(type) ? type : 'other');
      if (family.type !== null && type !== family.type) stats.typeMismatch += 1;
      if (family === UNRECOGNIZED) {
        const label = unrecognizedLabel(key);
        unrecognizedPrefixes.set(label, (unrecognizedPrefixes.get(label) ?? 0) + 1);
      }
      const ttl = ttlReply.ok ? toCount(ttlReply.value) : null;
      if (ttl === null) recordError('ttl', ttlReply.ok ? 'bad-response' : ttlReply.errorClass);
      else if (ttl >= 0) stats.ttl.expiring += 1;
      else if (ttl === -1) stats.ttl.persistent += 1;
      live.push({ key, type, family, prefix, stats });
    });
    if (live.length === 0) return;

    if (capabilities.memoryUsage === null) await probeMemory(live[0].key);
    const sizeCommands = [];
    const sizeTargets = [];
    for (const item of live) {
      const command = SIZE_COMMAND[/** @type {keyof typeof SIZE_COMMAND} */ (item.type)];
      if (command) {
        sizeCommands.push([command, item.key]);
        sizeTargets.push({ item, kind: item.type === 'string' ? 'bytes' : 'members' });
      }
      if (capabilities.memoryUsage) {
        sizeCommands.push(['MEMORY', 'USAGE', item.key]);
        sizeTargets.push({ item, kind: 'memoryUsage' });
      }
    }
    if (sizeCommands.length > 0) {
      const replies = await executor.pipeline(sizeCommands);
      replies.forEach((reply, index) => {
        const { item, kind } = sizeTargets[index];
        const value = reply.ok ? toCount(reply.value) : null;
        if (value === null) {
          if (!(reply.ok && reply.value === null)) recordError('size', reply.ok ? 'bad-response' : reply.errorClass);
          return;
        }
        addSize(item.stats[kind], value);
      });
    }

    const groups = new Map();
    for (const item of live) {
      if (!item.family.projection || item.type !== item.family.type) continue;
      const id = `${item.family.name}\u0000${item.prefix}`;
      if (!groups.has(id)) groups.set(id, { family: item.family, prefix: item.prefix, keys: [] });
      groups.get(id).keys.push(item.key);
    }
    if (groups.size > 0) await project([...groups.values()]);
  }

  let cursor = '0';
  try {
    for (;;) {
      if (clock() >= deadline) {
        scan.truncated = 'time-budget';
        break;
      }
      const remaining = limits.maxKeys - scan.keysSeen;
      if (remaining <= 0) {
        scan.truncated = 'key-budget';
        break;
      }
      const [reply] = await executor.pipeline([['SCAN', cursor, 'MATCH', '*', 'COUNT', String(limits.scanCount)]]);
      if (!reply.ok) {
        recordError('scan', reply.errorClass);
        break;
      }
      const page = parseScanPage(reply.value);
      if (!page) {
        recordError('scan', 'bad-response');
        break;
      }
      scan.pages += 1;
      const fresh = [];
      let overflow = false;
      for (const key of page.keys) {
        if (seenKeys.has(key)) {
          scan.duplicatesSkipped += 1;
          continue;
        }
        if (fresh.length >= remaining) {
          overflow = true;
          break;
        }
        seenKeys.add(key);
        fresh.push(key);
      }
      scan.keysSeen += fresh.length;
      if (fresh.length > 0) await inspectBatch(fresh);
      if (scan.pages % 20 === 0) progress(`inventory: ${scan.keysSeen} keys inspected`);
      cursor = page.cursor;
      if (overflow) {
        scan.truncated = 'key-budget';
        break;
      }
      if (cursor === '0') {
        scan.finished = true;
        break;
      }
    }
  } catch (error) {
    if (!(error instanceof InventoryError) || error.exitCode === EXIT_REFUSED) throw error;
    recordError('transport', error.errorClass);
  }

  try {
    const [after] = await executor.pipeline([['DBSIZE']]);
    scan.dbsizeAfter = after.ok ? toCount(after.value) : null;
  } catch (error) {
    if (!(error instanceof InventoryError) || error.exitCode === EXIT_REFUSED) throw error;
    recordError('dbsize', error.errorClass);
  }

  const elapsedMs = Math.max(0, clock() - startedAt);
  progress(`inventory: ${scan.keysSeen} keys inspected in ${Math.round(elapsedMs / 1000)} s`);
  return buildReport({
    executor, limits, nowMs, elapsedMs, scan, families, unrecognizedPrefixes, records, collections, errors,
    capabilities, unprojected, projectedWrongType,
  });
}

/** @param {unknown} value */
function parseScanPage(value) {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [cursor, keys] = value;
  if ((typeof cursor !== 'string' && typeof cursor !== 'number') || !Array.isArray(keys)) return null;
  if (keys.some((key) => typeof key !== 'string')) return null;
  const text = String(cursor);
  if (!/^\d{1,40}$/.test(text)) return null;
  return { cursor: text, keys: /** @type {string[]} */ (keys) };
}

/** @param {{ maxKeys?: number, maxSeconds?: number, scanCount?: number }} options */
export function resolveLimits(options) {
  const maxKeys = options.maxKeys ?? DEFAULT_LIMITS.maxKeys;
  const maxSeconds = options.maxSeconds ?? DEFAULT_LIMITS.maxSeconds;
  const scanCount = options.scanCount ?? DEFAULT_LIMITS.scanCount;
  if (!Number.isSafeInteger(maxKeys) || maxKeys < 1 || maxKeys > HARD_LIMITS.maxKeys) {
    throw refuse(`--max-keys must be an integer from 1 to ${HARD_LIMITS.maxKeys}`);
  }
  if (!Number.isSafeInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > HARD_LIMITS.maxSeconds) {
    throw refuse(`--max-seconds must be an integer from 1 to ${HARD_LIMITS.maxSeconds}`);
  }
  if (!Number.isSafeInteger(scanCount) || scanCount < HARD_LIMITS.scanCountMin || scanCount > HARD_LIMITS.scanCountMax) {
    throw refuse(`--scan-count must be an integer from ${HARD_LIMITS.scanCountMin} to ${HARD_LIMITS.scanCountMax}`);
  }
  return { maxKeys, maxSeconds, scanCount };
}

/** @param {any} input */
function buildReport(input) {
  const { executor, limits, nowMs, elapsedMs, scan, families, unrecognizedPrefixes, records, collections, errors, capabilities } = input;
  /** @type {Record<string, ReturnType<typeof emptyFamilyStats>>} */
  const familyTable = {};
  for (const family of [...FAMILIES, UNRECOGNIZED]) {
    familyTable[family.name] = families.get(family.name) ?? emptyFamilyStats();
  }
  if (capabilities.memoryUsage !== true) {
    for (const stats of Object.values(familyTable)) delete (/** @type {Partial<typeof stats>} */ (stats)).memoryUsage;
  }
  const projectable = FAMILIES.filter((family) => family.projection)
    .reduce((sum, family) => sum + (familyTable[family.name].count - familyTable[family.name].typeMismatch), 0);

  const interviews = records.interviews;
  const pendingOperations = {
    studyMutationsInFlight: records.mutationGuards.state['in-flight'],
    interviewPersistsUnfinished: records.persistGuards.projected,
    studyPersistingMembers: collections.studyPersistingSets.members,
    createIdempotencyPending: records.createIdempotency.state.pending,
    analysisRunning: interviews.analysis.runningLeaseActive,
    analysisRunningLeaseExpired: interviews.analysis.runningLeaseExpired,
    analysisPendingAfterAttempt: interviews.analysis.pendingAfterAttempt,
  };
  const orphans = {
    interviewsWithoutStudy: interviews.study.missing,
    linksWithoutStudy: records.participantLinks.study.missing,
    aggregatesWithoutStudy: records.aggregates.study.missing,
    consentsWithoutStudy: records.consents.study.missing,
    createdIdempotencyWithoutStudy: records.createIdempotency.createdWithoutStudy,
    persistGuardsWithoutInterview: records.persistGuards.interviewMissing,
    fingerprintsWithoutInterview: records.fingerprints.interviewMissing,
    studyInterviewIndexesWithoutStudy: collections.studyInterviewIndexes.study.missing,
    studyInterviewIndexMembersWithoutInterview: collections.studyInterviewIndexes.missingTargets,
    studyPersistingMembersWithoutGuard: collections.studyPersistingSets.missingTargets,
    allStudiesMembersWithoutStudy: collections.allStudies.missingTargets,
    allInterviewsMembersWithoutInterview: collections.allInterviews.missingTargets,
    invalidStudyReferences: interviews.study['invalid-id'] + records.participantLinks.study['invalid-id']
      + records.consents.study['invalid-id'] + records.createIdempotency.study['invalid-id'],
  };
  const expiredReferences = {
    linksExpiredStillStored: records.participantLinks.state.expired,
    linksRevoked: records.participantLinks.state.revoked,
    linksForSupersededStudyRevision: records.participantLinks.revisionStale,
    consentsForSupersededStudyRevision: records.consents.revisionStale,
    aggregatesForSupersededStudyRevision: records.aggregates.revisionStale,
    linkIndexMembersWithoutLink: collections.participantLinkIndexes.missingTargets,
    createIdempotencyIndexMembersExpired: collections.createIdempotencyIndexes.missingTargets,
  };

  const incompleteReasons = [];
  if (!scan.finished) incompleteReasons.push(scan.truncated ?? 'scan-interrupted');
  if (capabilities.fieldProjection === false) incompleteReasons.push('field-projection-unavailable');
  if (input.unprojected > 0) incompleteReasons.push('records-not-projected');
  const skipped = Object.values(collections).reduce((sum, c) => sum + c.skippedOverBound, 0);
  if (skipped > 0) incompleteReasons.push('collections-over-member-bound');
  if (errors.length > 0) incompleteReasons.push('command-errors');

  const warnings = [];
  if (scan.dbsizeBefore !== null && scan.dbsizeAfter !== null && scan.dbsizeBefore !== scan.dbsizeAfter) {
    warnings.push('key-count-changed-during-scan');
  }
  if (scan.vanishedDuringScan > 0 || input.projectedWrongType > 0) warnings.push('keys-changed-during-scan');
  if (scan.finished && scan.dbsizeAfter !== null && scan.keysSeen < scan.dbsizeAfter) warnings.push('fewer-keys-scanned-than-dbsize');
  const unrecognizedCount = familyTable.unrecognized.count;
  if (unrecognizedCount > 0) warnings.push('unrecognized-keys-present');

  // The summary totals count each operation and each orphan once; the
  // per-category counters above overlap and stay as they are:
  // - an unfinished completion save is its interview persist guard, and its
  //   study-persisting member is the same save (a member without a guard is
  //   an orphan, studyPersistingMembersWithoutGuard);
  // - a study's interview index whose study is missing is counted through its
  //   entries: live interviews as interviewsWithoutStudy, dangling entries as
  //   missing interviews;
  // - a missing interview listed in both all-interviews and its study's index
  //   counts once (only when all-interviews was checked member by member).
  const sum = (/** @type {Record<string, number>} */ counters) => Object.values(counters).reduce((total, n) => total + n, 0);
  const pendingOperationsOnce = sum(pendingOperations) - pendingOperations.studyPersistingMembers;
  const allInterviewsChecked = collections.allInterviews.keys > 0 && collections.allInterviews.skippedOverBound === 0;
  const orphansOnce = sum(orphans) - orphans.studyInterviewIndexesWithoutStudy
    - (allInterviewsChecked ? collections.studyInterviewIndexes.missingTargetsAlsoInAllInterviews : 0);

  const research = {
    studies: familyTable.studies.count,
    interviews: familyTable.interviews.count,
    participantLinks: familyTable.participantLinks.count,
    aggregates: familyTable.aggregates.count,
    consents: familyTable.consents.count,
  };
  return {
    format: REPORT_FORMAT,
    generatedAt: new Date(nowMs).toISOString(),
    target: { storageId: executor.storageId, protocol: 'upstash-rest' },
    complete: incompleteReasons.length === 0,
    incompleteReasons,
    warnings,
    summary: {
      totalKeys: scan.keysSeen - scan.vanishedDuringScan,
      researchRecords: research,
      hasResearchData: research.studies + research.interviews + research.aggregates > 0,
      pendingOperations: pendingOperationsOnce,
      interviewsAwaitingFirstAnalysis: interviews.analysis.importMapping.notScheduled,
      orphanedReferences: orphansOnce,
      unrecognizedKeys: unrecognizedCount,
    },
    budget: {
      maxKeys: limits.maxKeys,
      maxSeconds: limits.maxSeconds,
      scanCount: limits.scanCount,
      elapsedMs,
      requests: executor.stats.requests,
      commands: executor.stats.commands,
    },
    scan,
    capabilities: {
      memoryUsage: capabilities.memoryUsage === true,
      fieldProjection: capabilities.fieldProjection !== false && input.unprojected === 0,
      ...(capabilities.fieldProjectionError ? { fieldProjectionError: capabilities.fieldProjectionError } : {}),
      projectableKeys: projectable,
      unprojectedKeys: input.unprojected,
    },
    families: familyTable,
    unrecognizedPrefixes: Object.fromEntries(
      [...unrecognizedPrefixes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20),
    ),
    records,
    collections,
    pendingOperations,
    orphans,
    expiredReferences,
    errors,
  };
}

// ---------- Credentials (stdin JSON or no-echo prompt; never argv/env) ----------

const URL_NAME = 'KV_REST_API_URL';
const TOKEN_NAMES = ['KV_REST_API_TOKEN', 'KV_REST_API_READ_ONLY_TOKEN'];

async function readAllStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 64 * 1024) throw refuse('stdin is larger than 64 KiB');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** @param {string} label @returns {Promise<string>} */
function promptHidden(label) {
  const stdin = process.stdin;
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
    };
    /** @param {string} chunk */
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\r' || character === '\n' || character === '\u0004') {
          cleanup();
          resolve(value);
          return;
        }
        if (character === '\u0003') {
          cleanup();
          reject(new InventoryError('cancelled', { exitCode: 130, errorClass: 'cancelled' }));
          return;
        }
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else value += character;
      }
    };
    process.stderr.write(`${label} (input hidden): `);
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

/** Parse the stdin JSON credential object. Error messages never contain values. @param {string} text */
export function parseCredentialJson(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw refuse(`stdin must be JSON: {"${URL_NAME}": "https://<db>.upstash.io", "${TOKEN_NAMES[0]}": "…"}`);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw refuse('stdin JSON must be an object');
  const allowed = [URL_NAME, ...TOKEN_NAMES];
  const unexpected = Object.keys(body).filter((name) => !allowed.includes(name));
  if (unexpected.length > 0) {
    const printable = unexpected.every((name) => /^[A-Z][A-Z0-9_]{0,63}$/.test(name)) ? `: ${unexpected.join(', ')}` : '';
    throw refuse(`stdin JSON has unexpected names${printable} (expected ${URL_NAME} and one of ${TOKEN_NAMES.join(', ')})`);
  }
  if (!Object.hasOwn(body, URL_NAME)) throw refuse(`stdin JSON lacks ${URL_NAME}`);
  const supplied = TOKEN_NAMES.filter((name) => Object.hasOwn(body, name));
  if (supplied.length !== 1) throw refuse(`stdin JSON needs exactly one of ${TOKEN_NAMES.join(', ')}`);
  return { url: body[URL_NAME], token: body[supplied[0]] };
}

export async function readCredentials() {
  if (process.stdin.isTTY) {
    if (typeof process.stdin.setRawMode !== 'function') throw refuse('credentials need a no-echo terminal or JSON on stdin');
    const url = await promptHidden(URL_NAME);
    const token = await promptHidden(`${TOKEN_NAMES[0]} (the read-only token is preferred)`);
    return { url, token };
  }
  return parseCredentialJson(await readAllStdin());
}

// ---------- CLI ----------

const OPTIONS = {
  'max-keys': { type: 'string' },
  'max-seconds': { type: 'string' },
  'scan-count': { type: 'string' },
  help: { type: 'boolean' },
};

/** @param {string} name @param {string | undefined} value */
function integerOption(name, value) {
  if (value === undefined) return undefined;
  if (!/^\d{1,9}$/.test(value)) throw refuse(`--${name} must be a positive integer`);
  return Number(value);
}

/**
 * Arguments carry limits only. Errors never echo an argument's value: a
 * credential pasted on the command line must not reach the terminal or logs.
 * @param {string[]} argv
 */
export function parseCliArgs(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: /** @type {any} */ (OPTIONS), allowPositionals: true, strict: true });
  } catch {
    throw refuse(`unknown or malformed option (credentials are read from stdin, never from arguments)\n\n${USAGE}`);
  }
  if (parsed.positionals.length > 0) {
    throw refuse(`positional arguments are not accepted (credentials are read from stdin, never from arguments)\n\n${USAGE}`);
  }
  const values = /** @type {Record<string, string | boolean | undefined>} */ (parsed.values);
  if (values.help) return { help: true };
  return {
    help: false,
    ...resolveLimits({
      maxKeys: integerOption('max-keys', /** @type {string | undefined} */ (values['max-keys'])),
      maxSeconds: integerOption('max-seconds', /** @type {string | undefined} */ (values['max-seconds'])),
      scanCount: integerOption('scan-count', /** @type {string | undefined} */ (values['scan-count'])),
    }),
  };
}

async function main() {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(USAGE);
      process.exitCode = EXIT_OK;
      return;
    }
    const credentials = await readCredentials();
    const executor = createUpstashRestExecutor(credentials);
    process.stderr.write(`inventory: read-only scan of storage ${executor.storageId.slice(0, 12)}…\n`);
    const report = await runInventory(executor, {
      maxKeys: options.maxKeys,
      maxSeconds: options.maxSeconds,
      scanCount: options.scanCount,
      progress: (message) => process.stderr.write(`${message}\n`),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.complete ? EXIT_OK : EXIT_INCOMPLETE;
  } catch (error) {
    if (error instanceof InventoryError) {
      process.stderr.write(`error: ${error.message}\n`);
      process.stdout.write(`${JSON.stringify({ ok: false, error: error.message.split('\n')[0], errorClass: error.errorClass })}\n`);
      process.exitCode = error.exitCode;
      return;
    }
    // Never print an unexpected error's message: it could carry a response body.
    process.stderr.write(`error: unexpected failure (${error instanceof Error ? error.name : 'Error'})\n`);
    process.exitCode = EXIT_FAILED;
  }
}

// import.meta.main, not an argv[1] path comparison: Node runs the real path
// of a symlinked script, so that comparison never matched through a link and
// the tool exited 0 without a report.
if (isMain(import.meta)) {
  await main();
}
