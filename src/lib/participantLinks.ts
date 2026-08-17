import { createHash, randomBytes } from 'crypto';
import type { RedisPort } from './redisPort';
import { RedisCommitAmbiguousError } from './redisPort';
import { getKVClient, getPlatformClient } from './kvClient';
import { isHostedMode } from './mode';
import { platformKey } from './platformSchema';
import {
  AUTHORITY_GATE_LUA,
  hostedAuthorityArgvPrefixes,
  hostedAuthorityKeys,
  type StudyAuthorityCheckedResult,
  type StudyOpPhase,
} from './platformDb';
import { parseAuthorityResult } from './wire/parse';
import { isResearcherId, isUuid } from './wire/types';
import { logRequestFailure } from './requestLog';

export interface ParticipantLinkRecord {
  id: string;
  version: 1;
  studyId: string;
  studyRevision: number;
  researcherId: string | null;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
}

// Safe researcher-facing representation. The opaque URL credential is never
// stored and therefore cannot be returned after the creation response.
export interface ParticipantLinkMetadata {
  id: string;
  studyRevision: number;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
}

export type ParticipantLinkAuthorityDenial = Exclude<StudyAuthorityCheckedResult, { status: 'allow' }>;

export type ParticipantLinkLoadResult =
  | { status: 'found'; link: ParticipantLinkRecord }
  | { status: 'not-found' }
  | { status: 'expired' }
  | { status: 'revoked' }
  | ParticipantLinkAuthorityDenial;

export type ParticipantLinkListResult =
  | { status: 'ok'; links: ParticipantLinkMetadata[]; truncated: boolean }
  | ParticipantLinkAuthorityDenial;

export type ParticipantLinkRevokeResult =
  | { status: 'revoked'; revokedAt: number }
  | { status: 'already-revoked' }
  | { status: 'not-found' }
  | { status: 'owner-conflict' }
  | ParticipantLinkAuthorityDenial;

export type ParticipantLinkCreateResult =
  | { status: 'created'; code: string; link: ParticipantLinkRecord }
  | { status: 'quota-exceeded' }
  | ParticipantLinkAuthorityDenial;

const LINK_ID_PATTERN = /^[a-f0-9]{64}$/;
const MAX_INDEXED_LINKS = 1_000;
const READ_BATCH_SIZE = 100;
export const LINK_VALUE_PREFIX = 'oi:link:';

function hostedLinkAuthorityPrefix(): string {
  return AUTHORITY_GATE_LUA
    .replace("return {'oi:authz-allow', ownerRaw}", '-- hosted-link-authority-passed')
    .replace('-- authority (no writes)', '-- hosted-link-authority-embedded');
}

export const HOSTED_CREATE_LINK_SCRIPT = `${hostedLinkAuthorityPrefix()}
-- hosted-link-create
if redis.call('EXISTS', KEYS[6]) == 1 then return {'oi:link-exists'} end
if ARGV[9] ~= '' then
  local current = redis.call('SCARD', KEYS[7])
  if current >= tonumber(ARGV[11]) then
    local ids = redis.call('SMEMBERS', KEYS[7])
    for _, existingId in ipairs(ids) do
      if redis.call('EXISTS', ARGV[10] .. existingId) == 0 then
        redis.call('SREM', KEYS[7], existingId)
      end
    end
    if redis.call('SCARD', KEYS[7]) >= tonumber(ARGV[11]) then return {'oi:link-quota'} end
  end
end
redis.call('SET', KEYS[6], ARGV[8])
if ARGV[9] ~= '' then redis.call('SADD', KEYS[7], ARGV[9]) end
if ARGV[12] ~= '' then redis.call('PEXPIREAT', KEYS[6], ARGV[12]) end
return {'oi:link-created'}
`;

export const HOSTED_LIST_LINK_SCRIPT = `${hostedLinkAuthorityPrefix()}
-- hosted-link-list
local members = redis.call('SMEMBERS', KEYS[6])
local links = {}
local stale = {}
for _, member in ipairs(members) do
  local id = tostring(member)
  if type(id) ~= 'string' or not string.match(id, '^[0-9a-f]+$') or #id ~= 64 then
    table.insert(stale, id)
  else
    local raw = redis.call('GET', ARGV[8] .. id)
    if not raw then
      table.insert(stale, id)
    else
      local link = parse_prefixed(raw, 'oi:link:')
      if not link then
        local ok, decoded = pcall(cjson.decode, raw)
        if not ok or type(decoded) ~= 'table' then return {'oi:link-unavailable'} end
        link = decoded
      end
      if type(link.id) ~= 'string' or link.id ~= id then return {'oi:link-unavailable'} end
      if link.expiresAt and link.expiresAt ~= cjson.null and tonumber(link.expiresAt) <= tonumber(ARGV[10]) then
        table.insert(stale, id)
      elseif link.studyId == ARGV[2] then
        if ARGV[1] ~= '' and link.researcherId ~= ARGV[1] then
          table.insert(stale, id)
        else
          table.insert(links, raw)
        end
      end
    end
  end
end
for i = 1, #stale do
  redis.call('SREM', KEYS[6], stale[i])
end
return {'oi:link-list', cjson.encode(links)}
`;

export const HOSTED_REVOKE_LINK_SCRIPT = `${hostedLinkAuthorityPrefix()}
-- hosted-link-revoke
local raw = redis.call('GET', KEYS[6])
if not raw then
  redis.call('SREM', KEYS[7], ARGV[8])
  return {'oi:link-missing'}
end
local link = parse_prefixed(raw, 'oi:link:')
if not link then
  local ok, decoded = pcall(cjson.decode, raw)
  if not ok or type(decoded) ~= 'table' then return {'oi:link-unavailable'} end
  link = decoded
end
if link.studyId ~= ARGV[2] then return {'oi:link-owner'} end
if ARGV[1] ~= '' and link.researcherId ~= ARGV[1] then return {'oi:link-owner'} end
if link.expiresAt and link.expiresAt ~= cjson.null and tonumber(link.expiresAt) <= tonumber(ARGV[9]) then
  redis.call('SREM', KEYS[7], ARGV[8])
  return {'oi:link-missing'}
end
if link.revokedAt and link.revokedAt ~= cjson.null then return {'oi:link-already'} end
local ttl = redis.call('PTTL', KEYS[6])
link.revokedAt = tonumber(ARGV[9])
redis.call('SET', KEYS[6], 'oi:link:' .. cjson.encode(link))
if ttl > 0 then redis.call('PEXPIRE', KEYS[6], ttl) end
return {'oi:link-revoked'}
`;

export const HOSTED_EXCHANGE_LINK_SCRIPT = `
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

local raw = redis.call('GET', KEYS[4])
if not raw then return {'oi:link-missing'} end
local link = parse_prefixed(raw, 'oi:link:')
if not link then
  local ok, decoded = pcall(cjson.decode, raw)
  if not ok or type(decoded) ~= 'table' then return {'oi:link-unavailable'} end
  link = decoded
end
if type(link.studyId) ~= 'string' or link.studyId == '' then return {'oi:link-unavailable'} end

local caller = ARGV[1]
local studyId = link.studyId
local purpose = ARGV[3]
if purpose ~= 'read' and purpose ~= 'mutate-config' and purpose ~= 'link'
  and purpose ~= 'preview' and purpose ~= 'new-persist'
  and purpose ~= 'persist-repair' and purpose ~= 'delete' then
  return {'oi:authz-unavailable'}
end

local lineage = parse_prefixed(redis.call('GET', KEYS[3]), 'oi:lineage:')
if not lineage or lineage.version ~= 2 or lineage.authority ~= 'v2' or lineage.operations ~= 'hash-v2' then
  return {'oi:authz-hold'}
end

if caller ~= '' and redis.call('HEXISTS', KEYS[1], caller) == 1 then
  return {'oi:authz-adel'}
end

if caller ~= '' then
  local account = parse_prefixed(redis.call('GET', ARGV[4] .. caller), 'oi:account:')
  if not account or account.id ~= caller then
    return {'oi:authz-noacct'}
  end
end

local ownerKey = ARGV[8] .. studyId
local ownerRaw = redis.call('GET', ownerKey)
local owner = nil
if ownerRaw then
  owner = parse_prefixed(ownerRaw, 'oi:owner:')
  if not owner or type(owner.researcherId) ~= 'string' or type(owner.storageId) ~= 'string' then
    return {'oi:authz-unavailable'}
  end
  if redis.call('HEXISTS', KEYS[1], owner.researcherId) == 1 then
    return {'oi:authz-adel'}
  end
  if redis.call('SISMEMBER', ARGV[5] .. owner.researcherId, studyId) ~= 1 then
    return {'oi:authz-corrupt'}
  end
  local storage = parse_prefixed(redis.call('GET', ARGV[6] .. owner.researcherId), 'oi:storage:')
  if not storage then
    return {'oi:authz-unavailable'}
  end
  if storage.researcherId ~= owner.researcherId or storage.storageId ~= owner.storageId then
    return {'oi:authz-mismatch'}
  end
  if redis.call('SISMEMBER', ARGV[7] .. owner.storageId, owner.researcherId) ~= 1 then
    return {'oi:authz-corrupt'}
  end
  if caller ~= '' and owner.researcherId ~= caller then
    return {'oi:authz-deny'}
  end
end

local field = redis.call('HGET', KEYS[2], studyId)
local liveKind = nil
local livePhase = nil
if field then
  local op = parse_prefixed(field, 'oi:op:')
  if not op then return {'oi:authz-unavailable'} end
  if op.phase ~= 'reserving' and op.phase ~= 'pending' and op.phase ~= 'resolving' and op.phase ~= 'publishing' then
    return {'oi:authz-unavailable'}
  end
  if op.studyId ~= studyId then return {'oi:authz-corrupt'} end
  if op.kind ~= 'create' and op.kind ~= 'delete' then return {'oi:authz-unavailable'} end
  liveKind = op.kind
  livePhase = op.phase
else
  local lockRaw = redis.call('GET', ARGV[9] .. studyId)
  if lockRaw then
    local lock = parse_lock(lockRaw)
    if not lock then return {'oi:authz-unavailable'} end
    liveKind = lock.kind
    livePhase = 'reserving'
  end
end

if liveKind then
  local allowLiveDelete = (liveKind == 'delete' and (purpose == 'persist-repair' or purpose == 'delete'))
  if liveKind == 'create' or not allowLiveDelete then
    return {'oi:authz-live', livePhase}
  end
end

if not owner then
  return {'oi:authz-notfound'}
end

if link.revokedAt and link.revokedAt ~= cjson.null then return {'oi:link-revoked'} end
if link.expiresAt and link.expiresAt ~= cjson.null and tonumber(link.expiresAt) <= tonumber(ARGV[10]) then
  return {'oi:link-expired'}
end
if type(link.id) ~= 'string' then return {'oi:link-unavailable'} end
return {'oi:link-found', raw}
-- hosted-link-exchange
`;

const CREATE_LINK_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
if ARGV[2] ~= '' then
  local current = redis.call('SCARD', KEYS[2])
  if current >= tonumber(ARGV[5]) then
    local ids = redis.call('SMEMBERS', KEYS[2])
    for _, existingId in ipairs(ids) do
      if redis.call('EXISTS', ARGV[4] .. existingId) == 0 then
        redis.call('SREM', KEYS[2], existingId)
      end
    end
    if redis.call('SCARD', KEYS[2]) >= tonumber(ARGV[5]) then return -1 end
  end
end
redis.call('SET', KEYS[1], ARGV[1])
if ARGV[2] ~= '' then redis.call('SADD', KEYS[2], ARGV[2]) end
if ARGV[3] ~= '' then redis.call('PEXPIREAT', KEYS[1], ARGV[3]) end
return 1
`;

const REVOKE_LINK_SCRIPT = `
if ARGV[4] == '1' and redis.call('GET', KEYS[3]) ~= ARGV[2] then return -1 end
local raw = redis.call('GET', KEYS[1])
if not raw then
  redis.call('SREM', KEYS[2], ARGV[1])
  return 0
end
local link = cjson.decode(raw)
if link.studyId ~= ARGV[3] then return -1 end
if ARGV[4] == '1' and link.researcherId ~= ARGV[2] then return -1 end
if link.expiresAt and link.expiresAt ~= cjson.null and tonumber(link.expiresAt) <= tonumber(ARGV[5]) then
  redis.call('SREM', KEYS[2], ARGV[1])
  return 0
end
if link.revokedAt and link.revokedAt ~= cjson.null then return 2 end
local ttl = redis.call('PTTL', KEYS[1])
link.revokedAt = tonumber(ARGV[5])
redis.call('SET', KEYS[1], cjson.encode(link))
if ttl > 0 then redis.call('PEXPIRE', KEYS[1], ttl) end
return 1
`;

function recordKey(id: string): string {
  return `${isHostedMode() ? `${platformKey('participant-link')}:` : 'participant-link:'}${id}`;
}

function researcherLinkIndexKey(researcherId: string | null): string {
  if (!researcherId) return 'participant-link-index:none';
  return `${platformKey('participant-links')}:${researcherId}`;
}

function platformStudyOwnerKey(studyId: string): string {
  return platformKey(`study-owner:${studyId}`);
}

function storage(standaloneClient?: RedisPort): RedisPort {
  return isHostedMode() ? getPlatformClient() : (standaloneClient ?? getKVClient());
}

function digest(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

function encodeLink(link: ParticipantLinkRecord): string {
  return `${LINK_VALUE_PREFIX}${JSON.stringify(link)}`;
}

function asParticipantLinkRecord(value: unknown): ParticipantLinkRecord | null {
  let parsed = value;
  if (typeof parsed === 'string') {
    const raw = parsed.startsWith(LINK_VALUE_PREFIX)
      ? parsed.slice(LINK_VALUE_PREFIX.length)
      : parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const link = parsed as Partial<ParticipantLinkRecord>;
  if (
    typeof link.id !== 'string'
    || !LINK_ID_PATTERN.test(link.id)
    || link.version !== 1
    || typeof link.studyId !== 'string'
    || !link.studyId
    || !Number.isSafeInteger(link.studyRevision)
    || (link.studyRevision ?? 0) < 1
    || (link.researcherId !== null && typeof link.researcherId !== 'string')
    || !Number.isSafeInteger(link.createdAt)
    || (link.expiresAt !== null && !Number.isSafeInteger(link.expiresAt))
    || (link.revokedAt !== null && !Number.isSafeInteger(link.revokedAt))
  ) {
    return null;
  }
  return link as ParticipantLinkRecord;
}

function toMetadata(link: ParticipantLinkRecord): ParticipantLinkMetadata {
  return {
    id: link.id,
    studyRevision: link.studyRevision,
    createdAt: link.createdAt,
    expiresAt: link.expiresAt,
    revokedAt: link.revokedAt,
  };
}

function mapAuthorityTransport(error: unknown): 'ambiguous' | 'unavailable' {
  if (error instanceof RedisCommitAmbiguousError) {
    return error.commitState === 'may-have-committed' ? 'ambiguous' : 'unavailable';
  }
  return 'unavailable';
}

function denialFromWire(wire: unknown): ParticipantLinkAuthorityDenial | null {
  if (!Array.isArray(wire) || typeof wire[0] !== 'string' || !wire[0].startsWith('oi:authz-')) {
    return null;
  }
  const parsed = parseAuthorityResult(wire);
  if (parsed.status !== 'ok') return { status: 'unavailable' };
  if (parsed.value.outcome === 'allow') return { status: 'unavailable' };
  if (parsed.value.outcome === 'live') return { status: 'live', phase: parsed.value.phase };
  if (parsed.value.outcome === 'account-deleting') return { status: 'adel' };
  return { status: parsed.value.outcome };
}

function hostedIdentityDenial(
  studyId: string,
  researcherId: string | null,
  allowEmptyResearcher = false,
): ParticipantLinkAuthorityDenial | null {
  if (!isUuid(studyId)) return { status: 'invalid' };
  if (researcherId === '' && allowEmptyResearcher) return null;
  if (!researcherId || !isResearcherId(researcherId)) return { status: 'invalid' };
  return null;
}

function firstTag(wire: unknown): string | null {
  return Array.isArray(wire) && typeof wire[0] === 'string' ? wire[0] : null;
}

export function hostedLinkRecordPrefix(): string {
  return `${platformKey('participant-link')}:`;
}

export async function createParticipantLinkRecord(options: {
  studyId: string;
  studyRevision: number;
  researcherId: string | null;
  expiresAt: number | null;
  standaloneClient?: RedisPort;
}): Promise<ParticipantLinkCreateResult> {
  try {
    const client = storage(options.standaloneClient);
    const hosted = isHostedMode();
    if (hosted) {
      const identity = hostedIdentityDenial(options.studyId, options.researcherId);
      if (identity) return identity;
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const code = randomBytes(32).toString('base64url');
      const id = digest(code);
      const link: ParticipantLinkRecord = {
        id,
        version: 1,
        studyId: options.studyId,
        studyRevision: options.studyRevision,
        researcherId: options.researcherId,
        createdAt: Date.now(),
        expiresAt: options.expiresAt,
        revokedAt: null,
      };
      if (hosted) {
        const wire = await client.eval(
          HOSTED_CREATE_LINK_SCRIPT,
          [...hostedAuthorityKeys(options.studyId), recordKey(id), researcherLinkIndexKey(options.researcherId)],
          [
            options.researcherId ?? '',
            options.studyId,
            'link',
            ...hostedAuthorityArgvPrefixes(),
            encodeLink(link),
            options.researcherId ? id : '',
            hostedLinkRecordPrefix(),
            String(MAX_INDEXED_LINKS),
            options.expiresAt ? String(options.expiresAt) : '',
          ],
        );
        const denial = denialFromWire(wire);
        if (denial) return denial;
        const tag = firstTag(wire);
        if (tag === 'oi:link-created') return { status: 'created', code, link };
        if (tag === 'oi:link-quota') return { status: 'quota-exceeded' };
        if (tag === 'oi:link-exists') continue;
        return { status: 'unavailable' };
      }
      const created = await client.eval(
        CREATE_LINK_SCRIPT,
        [recordKey(id), researcherLinkIndexKey(options.researcherId)],
        [
          JSON.stringify(link),
          // Hosted links are indexed per researcher. Standalone links share a
          // bounded local index so they can also be managed after creation.
          (!hosted || options.researcherId) ? id : '',
          options.expiresAt ? String(options.expiresAt) : '',
          'participant-link:',
          String(MAX_INDEXED_LINKS),
        ],
      );
      if (Number(created) === 1) return { status: 'created', code, link };
      if (Number(created) === -1) return { status: 'quota-exceeded' };
    }
    return { status: 'unavailable' };
  } catch (error) {
    logRequestFailure({ event: 'kv.unavailable' }, error);
    return { status: mapAuthorityTransport(error) };
  }
}

async function loadById(id: string, standaloneClient?: RedisPort): Promise<ParticipantLinkLoadResult> {
  try {
    const raw = await storage(standaloneClient).get(recordKey(id));
    if (!raw) return { status: 'not-found' };
    const link = asParticipantLinkRecord(raw);
    if (!link || link.id !== id) return { status: 'unavailable' };
    if (link.revokedAt !== null) return { status: 'revoked' };
    if (link.expiresAt !== null && link.expiresAt <= Date.now()) return { status: 'expired' };
    return { status: 'found', link };
  } catch (error) {
    logRequestFailure({ event: 'kv.unavailable' }, error);
    return { status: mapAuthorityTransport(error) };
  }
}

async function exchangeHostedLinkById(id: string): Promise<ParticipantLinkLoadResult> {
  try {
    const wire = await storage().eval(
      HOSTED_EXCHANGE_LINK_SCRIPT,
      [
        platformKey('account-delete-journal'),
        platformKey('study-ops:v2'),
        platformKey('schema-lineage'),
        recordKey(id),
      ],
      [
        '',
        '',
        'read',
        ...hostedAuthorityArgvPrefixes(),
        `${platformKey('study-owner')}:`,
        `${platformKey('study-op-lock')}:`,
        String(Date.now()),
      ],
    );
    const denial = denialFromWire(wire);
    if (denial) return denial;
    const tag = firstTag(wire);
    if (tag === 'oi:link-missing') return { status: 'not-found' };
    if (tag === 'oi:link-expired') return { status: 'expired' };
    if (tag === 'oi:link-revoked') return { status: 'revoked' };
    if (tag === 'oi:link-found' && Array.isArray(wire)) {
      const link = asParticipantLinkRecord(wire[1]);
      if (!link || link.id !== id) return { status: 'unavailable' };
      return { status: 'found', link };
    }
    return { status: 'unavailable' };
  } catch (error) {
    logRequestFailure({ event: 'kv.unavailable' }, error);
    return { status: mapAuthorityTransport(error) };
  }
}

export function getParticipantLinkByCode(
  code: string,
  standaloneClient?: RedisPort,
): Promise<ParticipantLinkLoadResult> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(code)) {
    return Promise.resolve({ status: 'not-found' });
  }
  if (isHostedMode()) return exchangeHostedLinkById(digest(code));
  return loadById(digest(code), standaloneClient);
}

export function getParticipantLinkById(
  id: string,
  standaloneClient?: RedisPort,
): Promise<ParticipantLinkLoadResult> {
  if (!LINK_ID_PATTERN.test(id)) {
    return Promise.resolve({ status: 'not-found' });
  }
  return loadById(id, standaloneClient);
}

/**
 * Lists only non-secret metadata for a canonical study. Authorization and
 * canonical study ownership/existence are enforced by the API route; this
 * storage helper additionally filters the per-researcher index defensively.
 */
export async function listParticipantLinksForStudy(options: {
  studyId: string;
  researcherId: string | null;
  standaloneClient?: RedisPort;
  maximum?: number;
}): Promise<ParticipantLinkListResult> {
  const maximum = Math.max(1, Math.min(options.maximum ?? MAX_INDEXED_LINKS, MAX_INDEXED_LINKS));
  const indexKey = researcherLinkIndexKey(options.researcherId);

  try {
    const client = storage(options.standaloneClient);
    if (isHostedMode()) {
      const identity = hostedIdentityDenial(options.studyId, options.researcherId);
      if (identity) return identity;
      const wire = await client.eval(
        HOSTED_LIST_LINK_SCRIPT,
        [...hostedAuthorityKeys(options.studyId), indexKey],
        [
          options.researcherId ?? '',
          options.studyId,
          'link',
          ...hostedAuthorityArgvPrefixes(),
          hostedLinkRecordPrefix(),
          '',
          String(Date.now()),
          String(maximum),
        ],
      );
      const denial = denialFromWire(wire);
      if (denial) return denial;
      if (firstTag(wire) !== 'oi:link-list' || !Array.isArray(wire) || typeof wire[1] !== 'string') {
        return { status: 'unavailable' };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(wire[1]);
      } catch {
        return { status: 'unavailable' };
      }
      if (!Array.isArray(parsed)) return { status: 'unavailable' };
      const links: ParticipantLinkMetadata[] = [];
      for (const raw of parsed) {
        const link = asParticipantLinkRecord(raw);
        if (!link) return { status: 'unavailable' };
        links.push(toMetadata(link));
      }
      links.sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));
      return {
        status: 'ok',
        links: links.slice(0, maximum),
        truncated: links.length > maximum,
      };
    }

    const ids = new Set<string>();
    const invalidIndexMembers = new Set<string>();

    // v1 port surface has no SCAN: the index is Lua-capped at MAX_INDEXED_LINKS,
    // so SMEMBERS is bounded here and equivalent for legitimate state.
    const members = (await client.smembers(indexKey)) as string[];
    for (const member of members) {
      const id = String(member);
      if (!LINK_ID_PATTERN.test(id)) {
        invalidIndexMembers.add(id);
      } else if (ids.size < MAX_INDEXED_LINKS) {
        ids.add(id);
      }
    }

    const indexedIds = [...ids];
    const links: ParticipantLinkMetadata[] = [];
    const staleIndexMembers = new Set<string>(invalidIndexMembers);
    const now = Date.now();

    for (let offset = 0; offset < indexedIds.length; offset += READ_BATCH_SIZE) {
      const batch = indexedIds.slice(offset, offset + READ_BATCH_SIZE);
      const values = await Promise.all(batch.map((id) => client.get(recordKey(id))));
      if (!Array.isArray(values) || values.length !== batch.length) {
        return { status: 'unavailable' };
      }

      for (let index = 0; index < batch.length; index += 1) {
        const indexedId = batch[index];
        const raw = values[index];
        if (!raw) {
          staleIndexMembers.add(indexedId);
          continue;
        }
        const link = asParticipantLinkRecord(raw);
        if (!link || link.id !== indexedId) {
          return { status: 'unavailable' };
        }
        if (link.expiresAt !== null && link.expiresAt <= now) {
          staleIndexMembers.add(indexedId);
          continue;
        }
        if (link.studyId !== options.studyId) continue;
        if (options.researcherId && link.researcherId !== options.researcherId) {
          staleIndexMembers.add(indexedId);
          continue;
        }
        links.push(toMetadata(link));
      }
    }

    if (staleIndexMembers.size > 0) {
      await client.srem(indexKey, ...staleIndexMembers);
    }

    links.sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));
    return {
      status: 'ok',
      links: links.slice(0, maximum),
      truncated: links.length > maximum,
    };
  } catch (error) {
    logRequestFailure({ event: 'kv.unavailable' }, error);
    return { status: mapAuthorityTransport(error) };
  }
}

/** Atomically verifies the study/link owner and revokes one opaque link. */
export async function revokeParticipantLink(options: {
  linkId: string;
  studyId: string;
  researcherId: string | null;
  standaloneClient?: RedisPort;
}): Promise<ParticipantLinkRevokeResult> {
  if (!LINK_ID_PATTERN.test(options.linkId)) return { status: 'not-found' };

  try {
    const hosted = isHostedMode();
    if (hosted && !options.researcherId) return { status: 'owner-conflict' };
    if (hosted) {
      const identity = hostedIdentityDenial(options.studyId, options.researcherId);
      if (identity) return identity;
    }
    const revokedAt = Date.now();
    if (hosted) {
      const wire = await storage(options.standaloneClient).eval(
        HOSTED_REVOKE_LINK_SCRIPT,
        [
          ...hostedAuthorityKeys(options.studyId),
          recordKey(options.linkId),
          researcherLinkIndexKey(options.researcherId),
        ],
        [
          options.researcherId ?? '',
          options.studyId,
          'link',
          ...hostedAuthorityArgvPrefixes(),
          options.linkId,
          String(revokedAt),
        ],
      );
      const denial = denialFromWire(wire);
      if (denial) return denial;
      const tag = firstTag(wire);
      if (tag === 'oi:link-revoked') return { status: 'revoked', revokedAt };
      if (tag === 'oi:link-already') return { status: 'already-revoked' };
      if (tag === 'oi:link-missing') return { status: 'not-found' };
      if (tag === 'oi:link-owner') return { status: 'owner-conflict' };
      return { status: 'unavailable' };
    }
    const result = Number(await storage(options.standaloneClient).eval(
      REVOKE_LINK_SCRIPT,
      [
        recordKey(options.linkId),
        researcherLinkIndexKey(options.researcherId),
        platformStudyOwnerKey(options.studyId),
      ],
      [
        options.linkId,
        options.researcherId ?? '',
        options.studyId,
        '0',
        String(revokedAt),
      ],
    ));
    if (result === 1) return { status: 'revoked', revokedAt };
    if (result === 2) return { status: 'already-revoked' };
    if (result === 0) return { status: 'not-found' };
    if (result === -1) return { status: 'owner-conflict' };
    return { status: 'unavailable' };
  } catch (error) {
    logRequestFailure({ event: 'kv.unavailable' }, error);
    return { status: mapAuthorityTransport(error) };
  }
}

export function asStudyAuthorityFromLink(
  result: { status: string; phase?: StudyOpPhase },
): StudyAuthorityCheckedResult | null {
  if (result.status === 'live' && result.phase) {
    return { status: 'live', phase: result.phase };
  }
  if (
    result.status === 'adel'
    || result.status === 'hold'
    || result.status === 'noacct'
    || result.status === 'deny'
    || result.status === 'notfound'
    || result.status === 'corrupt'
    || result.status === 'mismatch'
    || result.status === 'unavailable'
    || result.status === 'ambiguous'
    || result.status === 'invalid'
  ) {
    return { status: result.status };
  }
  return null;
}
