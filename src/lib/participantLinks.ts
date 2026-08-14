import { createHash, randomBytes } from 'crypto';
import { Redis } from '@upstash/redis';
import { getKVClient, getPlatformClient } from './kvClient';
import { isHostedMode } from './mode';

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

export type ParticipantLinkLoadResult =
  | { status: 'found'; link: ParticipantLinkRecord }
  | { status: 'not-found' }
  | { status: 'expired' }
  | { status: 'revoked' }
  | { status: 'unavailable' };

export type ParticipantLinkListResult =
  | { status: 'ok'; links: ParticipantLinkMetadata[]; truncated: boolean }
  | { status: 'unavailable' };

export type ParticipantLinkRevokeResult =
  | { status: 'revoked'; revokedAt: number }
  | { status: 'already-revoked' }
  | { status: 'not-found' }
  | { status: 'owner-conflict' }
  | { status: 'unavailable' };

const LINK_ID_PATTERN = /^[a-f0-9]{64}$/;
const MAX_INDEXED_LINKS = 1_000;
const SCAN_BATCH_SIZE = 250;
const READ_BATCH_SIZE = 100;

const platformPrefix = () => process.env.PLATFORM_KEY_PREFIX
  ? `${process.env.PLATFORM_KEY_PREFIX}:participant-link:`
  : 'participant-link:';

function recordKey(id: string): string {
  return `${isHostedMode() ? platformPrefix() : 'participant-link:'}${id}`;
}

function researcherLinkIndexKey(researcherId: string | null): string {
  if (!researcherId) return 'participant-link-index:none';
  const prefix = process.env.PLATFORM_KEY_PREFIX
    ? `${process.env.PLATFORM_KEY_PREFIX}:participant-links:`
    : 'participant-links:';
  return `${prefix}${researcherId}`;
}

function platformStudyOwnerKey(studyId: string): string {
  const prefix = process.env.PLATFORM_KEY_PREFIX
    ? `${process.env.PLATFORM_KEY_PREFIX}:study-owner:`
    : 'study-owner:';
  return `${prefix}${studyId}`;
}

function storage(standaloneClient?: Redis): Redis {
  return isHostedMode() ? getPlatformClient() : (standaloneClient ?? getKVClient());
}

function digest(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

function asParticipantLinkRecord(value: unknown): ParticipantLinkRecord | null {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
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

export async function createParticipantLinkRecord(options: {
  studyId: string;
  studyRevision: number;
  researcherId: string | null;
  expiresAt: number | null;
  standaloneClient?: Redis;
}): Promise<
  | { status: 'created'; code: string; link: ParticipantLinkRecord }
  | { status: 'quota-exceeded' }
  | { status: 'unavailable' }
> {
  try {
    const client = storage(options.standaloneClient);
    const hosted = isHostedMode();
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
      const created = await client.eval<string[], number>(
        CREATE_LINK_SCRIPT,
        [recordKey(id), researcherLinkIndexKey(options.researcherId)],
        [
          JSON.stringify(link),
          // Hosted links are indexed per researcher. Standalone links share a
          // bounded local index so they can also be managed after creation.
          (!hosted || options.researcherId) ? id : '',
          options.expiresAt ? String(options.expiresAt) : '',
          hosted ? platformPrefix() : 'participant-link:',
          String(MAX_INDEXED_LINKS),
        ]
      );
      if (Number(created) === 1) return { status: 'created', code, link };
      if (Number(created) === -1) return { status: 'quota-exceeded' };
    }
    return { status: 'unavailable' };
  } catch (error) {
    console.error('Participant link storage unavailable', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
    return { status: 'unavailable' };
  }
}

async function loadById(id: string, standaloneClient?: Redis): Promise<ParticipantLinkLoadResult> {
  try {
    const raw = await storage(standaloneClient).get<ParticipantLinkRecord | string>(recordKey(id));
    if (!raw) return { status: 'not-found' };
    const link = asParticipantLinkRecord(raw);
    if (!link || link.id !== id) return { status: 'unavailable' };
    if (link.revokedAt !== null) return { status: 'revoked' };
    if (link.expiresAt !== null && link.expiresAt <= Date.now()) return { status: 'expired' };
    return { status: 'found', link };
  } catch (error) {
    console.error('Participant link lookup unavailable', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
    return { status: 'unavailable' };
  }
}

export function getParticipantLinkByCode(
  code: string,
  standaloneClient?: Redis
): Promise<ParticipantLinkLoadResult> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(code)) {
    return Promise.resolve({ status: 'not-found' });
  }
  return loadById(digest(code), standaloneClient);
}

export function getParticipantLinkById(
  id: string,
  standaloneClient?: Redis
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
  standaloneClient?: Redis;
  maximum?: number;
}): Promise<ParticipantLinkListResult> {
  const maximum = Math.max(1, Math.min(options.maximum ?? MAX_INDEXED_LINKS, MAX_INDEXED_LINKS));
  const indexKey = researcherLinkIndexKey(options.researcherId);

  try {
    const client = storage(options.standaloneClient);
    const ids = new Set<string>();
    const invalidIndexMembers = new Set<string>();
    let cursor = '0';

    do {
      const [nextCursor, members] = await client.sscan(indexKey, cursor, { count: SCAN_BATCH_SIZE });
      cursor = String(nextCursor);
      for (const member of members) {
        const id = String(member);
        if (!LINK_ID_PATTERN.test(id)) {
          invalidIndexMembers.add(id);
        } else if (ids.size < MAX_INDEXED_LINKS) {
          ids.add(id);
        }
      }
    } while (cursor !== '0' && ids.size < MAX_INDEXED_LINKS);

    const indexedIds = [...ids];
    const links: ParticipantLinkMetadata[] = [];
    const staleIndexMembers = new Set<string>(invalidIndexMembers);
    const now = Date.now();

    for (let offset = 0; offset < indexedIds.length; offset += READ_BATCH_SIZE) {
      const batch = indexedIds.slice(offset, offset + READ_BATCH_SIZE);
      const values = await client.mget<Array<ParticipantLinkRecord | string | null>>(
        ...batch.map((id) => recordKey(id))
      );
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
      truncated: cursor !== '0' || links.length > maximum,
    };
  } catch (error) {
    console.error('Participant link listing unavailable', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
    return { status: 'unavailable' };
  }
}

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

/** Atomically verifies the study/link owner and revokes one opaque link. */
export async function revokeParticipantLink(options: {
  linkId: string;
  studyId: string;
  researcherId: string | null;
  standaloneClient?: Redis;
}): Promise<ParticipantLinkRevokeResult> {
  if (!LINK_ID_PATTERN.test(options.linkId)) return { status: 'not-found' };

  try {
    const hosted = isHostedMode();
    if (hosted && !options.researcherId) return { status: 'owner-conflict' };
    const revokedAt = Date.now();
    const result = Number(await storage(options.standaloneClient).eval<string[], number>(
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
        hosted ? '1' : '0',
        String(revokedAt),
      ]
    ));
    if (result === 1) return { status: 'revoked', revokedAt };
    if (result === 2) return { status: 'already-revoked' };
    if (result === 0) return { status: 'not-found' };
    if (result === -1) return { status: 'owner-conflict' };
    return { status: 'unavailable' };
  } catch (error) {
    console.error('Participant link revocation unavailable', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
    return { status: 'unavailable' };
  }
}
