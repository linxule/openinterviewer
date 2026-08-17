// Hosted account-deletion journal / plan / cursor (Revision 12 §13).
// Replaces one-shot deleteResearcherAccount. Never touches BYOS Redis.

import { evictResearcherClients, getPlatformClient } from './kvClient';
import { normalizeEmail } from './email';
import { RedisCommitAmbiguousError, type RedisPort } from './redisPort';
import { ensurePlatformSchemaLineage, platformKey } from './platformSchema';
import { MAX_LIVE_OPS, MAX_STUDIES, isHex64, isResearcherId, isUuid } from './wire/types';
import { MAX_IDEM_MAPPINGS } from './createIdempotency';
import type { ResearcherAccount } from '@/types';

export const MAX_DELETE_JOURNALS = 100;
export const MAX_PLAN_OPS = 4000;
export const MAX_INDEXED_LINKS = 1000;
export const MAX_COLLECTION = 1000;

export const ACCOUNT_DELETE_PLAN_PREFIX = 'oi:adel-plan:';
export const ACCOUNT_DELETE_JOURNAL_PREFIX = 'oi:adel-journal:';

export const ACCOUNT_DELETE_OP_ALLOWLIST = [
  'cad-string',
  'cad-lock',
  'cad-owner',
  'cad-storage',
  'srem',
  'zrem',
  'cad-hash',
  'local-evict',
  'hdel-journal',
] as const;

export type AccountDeleteOpName = (typeof ACCOUNT_DELETE_OP_ALLOWLIST)[number];
export type AccountDeleteDisposition = 'none' | 'scoped' | 'full';

export interface AccountDeletePlan {
  version: 2;
  subject: string;
  cursor: number;
  length: number;
  ops: AccountDeleteOp[];
  journalLast: true;
}

export type AccountDeleteOp =
  | { op: 'cad-string'; key: string; expected: string }
  | { op: 'cad-lock'; key: string; expected: string }
  | { op: 'cad-owner'; key: string; expectedOwner: string; expectedStorageId: string }
  | { op: 'cad-storage'; key: string; expected: string }
  | { op: 'srem'; key: string; member: string }
  | { op: 'zrem'; key: string; member: string }
  | { op: 'cad-hash'; key: string; field: string; expected: string }
  | { op: 'local-evict'; disposition: AccountDeleteDisposition; researcherId: string; storageId: string | null }
  | { op: 'hdel-journal'; field: string };

export interface AccountDeleteJournal {
  version: 2;
  researcherId: string;
  createdAt: number;
  evict: {
    disposition: AccountDeleteDisposition;
    researcherId: string;
    storageId: string | null;
  };
}

export type BeginAccountDeletionResult =
  | { status: 'started' | 'replay'; plan: AccountDeletePlan }
  | { status: 'too-many-records' }
  | { status: 'not-found' }
  | { status: 'hold' }
  | { status: 'unavailable' }
  | { status: 'ambiguous' };

export type ResumeAccountDeletionResult =
  | { status: 'complete' }
  | { status: 'pending'; plan: AccountDeletePlan }
  | { status: 'not-found' }
  | { status: 'unavailable' }
  | { status: 'ambiguous' };

export type DeleteResearcherResult =
  | { status: 'deleted'; detachedStudyCount: number }
  | { status: 'not-found' }
  | { status: 'too-many-records' }
  | { status: 'unavailable' };

export interface AccountDeleteSnapshot {
  researcherId: string;
  accountRaw: string | null;
  oauthKey: string | null;
  oauthRaw: string | null;
  emailKey: string | null;
  emailRaw: string | null;
  storageId: string | null;
  storageRaw: string | null;
  studyIds: string[];
  locks: Array<{ studyId: string; key: string; raw: string }>;
  receipts: Array<{ member: string; key: string; raw: string }>;
  registry: Array<{ field: string; raw: string }>;
  owners: Array<{ studyId: string; key: string; raw: string; storageId: string }>;
  linkIds: string[];
  links: Array<{ id: string; raw: string }>;
  idempHashes: string[];
  idemps: Array<{ hash: string; raw: string }>;
  redisLess: boolean;
}

const PAD = '_';

function platform(): RedisPort {
  return getPlatformClient();
}

function journalKey(): string {
  return platformKey('account-delete-journal');
}

function planKey(researcherId: string): string {
  return platformKey(`account-delete-plan:${researcherId}`);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : value == null ? null : null;
}

function asStringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    out.push(item);
  }
  return out;
}

function mapTransport(error: unknown): 'ambiguous' | 'unavailable' {
  if (error instanceof RedisCommitAmbiguousError) {
    return error.commitState === 'may-have-committed' ? 'ambiguous' : 'unavailable';
  }
  return 'unavailable';
}

function encodePlan(plan: AccountDeletePlan): string {
  return `${ACCOUNT_DELETE_PLAN_PREFIX}${JSON.stringify(plan)}`;
}

function encodeJournal(journal: AccountDeleteJournal): string {
  return `${ACCOUNT_DELETE_JOURNAL_PREFIX}${JSON.stringify(journal)}`;
}

export function parseAccountDeletePlan(value: unknown): AccountDeletePlan | null {
  if (typeof value !== 'string' || !value.startsWith(ACCOUNT_DELETE_PLAN_PREFIX)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.slice(ACCOUNT_DELETE_PLAN_PREFIX.length));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const body = parsed as Record<string, unknown>;
  if (body.version !== 2) return null;
  if (typeof body.subject !== 'string' || !isResearcherId(body.subject)) return null;
  if (!Number.isSafeInteger(body.cursor) || (body.cursor as number) < 0) return null;
  if (!Number.isSafeInteger(body.length) || (body.length as number) < 1) return null;
  if (body.journalLast !== true) return null;
  if (!Array.isArray(body.ops) || body.ops.length !== body.length) return null;
  const ops: AccountDeleteOp[] = [];
  for (const raw of body.ops) {
    const op = parseAccountDeleteOp(raw);
    if (!op) return null;
    ops.push(op);
  }
  return {
    version: 2,
    subject: body.subject,
    cursor: body.cursor as number,
    length: body.length as number,
    ops,
    journalLast: true,
  };
}

export function parseAccountDeleteJournal(value: unknown): AccountDeleteJournal | null {
  if (typeof value !== 'string' || !value.startsWith(ACCOUNT_DELETE_JOURNAL_PREFIX)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.slice(ACCOUNT_DELETE_JOURNAL_PREFIX.length));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const body = parsed as Record<string, unknown>;
  if (body.version !== 2) return null;
  if (typeof body.researcherId !== 'string' || !isResearcherId(body.researcherId)) return null;
  if (!Number.isSafeInteger(body.createdAt) || (body.createdAt as number) < 0) return null;
  if (!body.evict || typeof body.evict !== 'object' || Array.isArray(body.evict)) return null;
  const evict = body.evict as Record<string, unknown>;
  if (evict.disposition !== 'none' && evict.disposition !== 'scoped' && evict.disposition !== 'full') {
    return null;
  }
  if (typeof evict.researcherId !== 'string' || !isResearcherId(evict.researcherId)) return null;
  if (evict.storageId !== null && (typeof evict.storageId !== 'string' || !isHex64(evict.storageId))) {
    return null;
  }
  return {
    version: 2,
    researcherId: body.researcherId,
    createdAt: body.createdAt as number,
    evict: {
      disposition: evict.disposition,
      researcherId: evict.researcherId,
      storageId: evict.storageId as string | null,
    },
  };
}

function parseAccountDeleteOp(value: unknown): AccountDeleteOp | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const kind = body.op;
  if (kind === 'cad-string' || kind === 'cad-lock' || kind === 'cad-storage') {
    if (typeof body.key !== 'string' || body.key.length === 0) return null;
    if (typeof body.expected !== 'string') return null;
    return { op: kind, key: body.key, expected: body.expected };
  }
  if (kind === 'cad-owner') {
    if (typeof body.key !== 'string' || body.key.length === 0) return null;
    if (typeof body.expectedOwner !== 'string' || !isResearcherId(body.expectedOwner)) return null;
    if (typeof body.expectedStorageId !== 'string' || !isHex64(body.expectedStorageId)) return null;
    return {
      op: 'cad-owner',
      key: body.key,
      expectedOwner: body.expectedOwner,
      expectedStorageId: body.expectedStorageId,
    };
  }
  if (kind === 'srem' || kind === 'zrem') {
    if (typeof body.key !== 'string' || body.key.length === 0) return null;
    if (typeof body.member !== 'string' || body.member.length === 0) return null;
    return { op: kind, key: body.key, member: body.member };
  }
  if (kind === 'cad-hash') {
    if (typeof body.key !== 'string' || body.key.length === 0) return null;
    if (typeof body.field !== 'string' || body.field.length === 0) return null;
    if (typeof body.expected !== 'string') return null;
    return { op: 'cad-hash', key: body.key, field: body.field, expected: body.expected };
  }
  if (kind === 'local-evict') {
    if (body.disposition !== 'none' && body.disposition !== 'scoped' && body.disposition !== 'full') {
      return null;
    }
    if (typeof body.researcherId !== 'string' || !isResearcherId(body.researcherId)) return null;
    if (body.storageId !== null && (typeof body.storageId !== 'string' || !isHex64(body.storageId))) {
      return null;
    }
    return {
      op: 'local-evict',
      disposition: body.disposition,
      researcherId: body.researcherId,
      storageId: body.storageId as string | null,
    };
  }
  if (kind === 'hdel-journal') {
    if (typeof body.field !== 'string' || !isResearcherId(body.field)) return null;
    return { op: 'hdel-journal', field: body.field };
  }
  return null;
}

function unprefix(key: string): string {
  const prefix = process.env.PLATFORM_KEY_PREFIX?.trim();
  if (prefix) {
    const head = `${prefix}:`;
    if (!key.startsWith(head)) return '';
    return key.slice(head.length);
  }
  return key;
}

export function isAllowedAccountDeleteKey(op: AccountDeleteOp): boolean {
  if (op.op === 'local-evict') return true;
  if (op.op === 'hdel-journal') return isResearcherId(op.field);
  const suffix = unprefix(op.key);
  if (!suffix) return false;
  switch (op.op) {
    case 'cad-string':
      return (
        /^oauth:(google|github):.+$/.test(suffix)
        || /^email:[^:]+$/.test(suffix)
        || /^researcher:[A-Za-z0-9-]{1,256}$/.test(suffix)
        || /^participant-link:[a-f0-9]{64}$/.test(suffix)
        || /^create-idemp:[a-f0-9]{64}$/.test(suffix)
        || /^study-op-receipt:[0-9a-f-]+:[0-9]+$/i.test(suffix)
      );
    case 'cad-lock':
      return /^study-op-lock:[0-9a-f-]{36}$/i.test(suffix);
    case 'cad-owner':
      return /^study-owner:[0-9a-f-]{36}$/i.test(suffix);
    case 'cad-storage':
      return /^researcher-storage:[A-Za-z0-9-]{1,256}$/.test(suffix);
    case 'srem':
      return (
        suffix === 'all-researchers'
        || /^storage-researchers:[a-f0-9]{64}$/.test(suffix)
        || /^researcher-studies:[A-Za-z0-9-]{1,256}$/.test(suffix)
        || /^participant-links:[A-Za-z0-9-]{1,256}$/.test(suffix)
      );
    case 'zrem':
      return (
        /^study-op-receipts:[A-Za-z0-9-]{1,256}$/.test(suffix)
        || /^create-idemp-index:[A-Za-z0-9-]{1,256}$/.test(suffix)
      );
    case 'cad-hash':
      return suffix === 'study-ops:v2' && isUuid(op.field);
    default:
      return false;
  }
}

export function validateAccountDeletePlan(plan: AccountDeletePlan): 'ok' | 'invalid' {
  if (plan.version !== 2 || plan.journalLast !== true) return 'invalid';
  if (!isResearcherId(plan.subject)) return 'invalid';
  if (plan.length !== plan.ops.length || plan.length < 2 || plan.length > MAX_PLAN_OPS) return 'invalid';
  if (plan.cursor < 0 || plan.cursor > plan.length) return 'invalid';
  const last = plan.ops[plan.length - 1];
  const evict = plan.ops[plan.length - 2];
  if (!last || last.op !== 'hdel-journal' || last.field !== plan.subject) return 'invalid';
  if (!evict || evict.op !== 'local-evict' || evict.researcherId !== plan.subject) return 'invalid';
  for (const op of plan.ops) {
    if (!ACCOUNT_DELETE_OP_ALLOWLIST.includes(op.op)) return 'invalid';
    if (!isAllowedAccountDeleteKey(op)) return 'invalid';
  }
  const hdelIndex = plan.ops.findIndex((op) => op.op === 'hdel-journal');
  if (hdelIndex !== plan.length - 1) return 'invalid';
  const accountIndex = plan.ops.findIndex(
    (op) => op.op === 'cad-string' && unprefix(op.key).startsWith('researcher:'),
  );
  if (accountIndex >= 0 && accountIndex > plan.length - 3) return 'invalid';
  if (accountIndex >= 0 && accountIndex !== plan.length - 3) return 'invalid';
  return 'ok';
}

export function assertChildBeforeIndex(plan: AccountDeletePlan): boolean {
  for (let i = 0; i < plan.ops.length; i += 1) {
    const op = plan.ops[i];
    if (op.op === 'cad-string' && unprefix(op.key).startsWith('participant-link:')) {
      const next = plan.ops[i + 1];
      if (!next || next.op !== 'srem' || !unprefix(next.key).startsWith('participant-links:')) {
        return false;
      }
    }
    if (op.op === 'cad-string' && unprefix(op.key).startsWith('create-idemp:')) {
      const next = plan.ops[i + 1];
      if (!next || next.op !== 'zrem' || !unprefix(next.key).startsWith('create-idemp-index:')) {
        return false;
      }
    }
    if (op.op === 'cad-string' && unprefix(op.key).startsWith('study-op-receipt:')) {
      const next = plan.ops[i + 1];
      if (!next || next.op !== 'zrem' || !unprefix(next.key).startsWith('study-op-receipts:')) {
        return false;
      }
    }
    if (op.op === 'cad-storage') {
      const laterOwner = plan.ops.slice(i + 1).find((candidate) => candidate.op === 'cad-owner');
      if (laterOwner) {
        const ownerPos = plan.ops.indexOf(laterOwner, i + 1);
        const storageAgain = plan.ops.slice(i + 1, ownerPos).some((candidate) => candidate.op === 'cad-owner');
        if (storageAgain) return false;
      }
    }
  }
  return true;
}

export function buildAccountDeletePlan(snapshot: AccountDeleteSnapshot): AccountDeletePlan | null {
  const researcherId = snapshot.researcherId;
  if (!isResearcherId(researcherId)) return null;
  const ops: AccountDeleteOp[] = [];

  if (!snapshot.redisLess && snapshot.storageId && snapshot.storageRaw) {
    ops.push({
      op: 'srem',
      key: platformKey(`storage-researchers:${snapshot.storageId}`),
      member: researcherId,
    });
  }
  if (snapshot.oauthKey && snapshot.oauthRaw) {
    ops.push({ op: 'cad-string', key: snapshot.oauthKey, expected: snapshot.oauthRaw });
  }
  if (snapshot.emailKey && snapshot.emailRaw) {
    ops.push({ op: 'cad-string', key: snapshot.emailKey, expected: snapshot.emailRaw });
  }
  ops.push({ op: 'srem', key: platformKey('all-researchers'), member: researcherId });

  const studyIds = [...snapshot.studyIds].sort();
  for (const studyId of studyIds) {
    const lock = snapshot.locks.find((item) => item.studyId === studyId);
    if (lock) ops.push({ op: 'cad-lock', key: lock.key, expected: lock.raw });
    const receipts = snapshot.receipts.filter((item) => item.member.startsWith(`${studyId}:`));
    for (const receipt of receipts) {
      ops.push({ op: 'cad-string', key: receipt.key, expected: receipt.raw });
      ops.push({
        op: 'zrem',
        key: platformKey(`study-op-receipts:${researcherId}`),
        member: receipt.member,
      });
    }
    const registry = snapshot.registry.find((item) => item.field === studyId);
    if (registry) {
      ops.push({
        op: 'cad-hash',
        key: platformKey('study-ops:v2'),
        field: studyId,
        expected: registry.raw,
      });
    }
    if (!snapshot.redisLess && snapshot.storageRaw) {
      ops.push({
        op: 'cad-storage',
        key: platformKey(`researcher-storage:${researcherId}`),
        expected: snapshot.storageRaw,
      });
    }
    const owner = snapshot.owners.find((item) => item.studyId === studyId);
    if (owner) {
      ops.push({
        op: 'cad-owner',
        key: owner.key,
        expectedOwner: researcherId,
        expectedStorageId: owner.storageId,
      });
    }
    ops.push({
      op: 'srem',
      key: platformKey(`researcher-studies:${researcherId}`),
      member: studyId,
    });
  }

  if (!snapshot.redisLess && snapshot.storageRaw && studyIds.length === 0) {
    ops.push({
      op: 'cad-storage',
      key: platformKey(`researcher-storage:${researcherId}`),
      expected: snapshot.storageRaw,
    });
  }

  const linkIds = [...snapshot.linkIds].sort();
  for (const linkId of linkIds) {
    const link = snapshot.links.find((item) => item.id === linkId);
    if (link) {
      ops.push({
        op: 'cad-string',
        key: platformKey(`participant-link:${linkId}`),
        expected: link.raw,
      });
    }
    ops.push({
      op: 'srem',
      key: platformKey(`participant-links:${researcherId}`),
      member: linkId,
    });
  }

  const hashes = [...snapshot.idempHashes].sort();
  for (const hash of hashes) {
    const record = snapshot.idemps.find((item) => item.hash === hash);
    if (record) {
      ops.push({
        op: 'cad-string',
        key: platformKey(`create-idemp:${hash}`),
        expected: record.raw,
      });
    }
    ops.push({
      op: 'zrem',
      key: platformKey(`create-idemp-index:${researcherId}`),
      member: hash,
    });
  }

  if (snapshot.accountRaw) {
    ops.push({
      op: 'cad-string',
      key: platformKey(`researcher:${researcherId}`),
      expected: snapshot.accountRaw,
    });
  }

  const disposition: AccountDeleteDisposition = snapshot.redisLess
    ? 'none'
    : snapshot.storageId
      ? 'full'
      : 'none';
  ops.push({
    op: 'local-evict',
    disposition,
    researcherId,
    storageId: snapshot.storageId,
  });
  ops.push({ op: 'hdel-journal', field: researcherId });

  const plan: AccountDeletePlan = {
    version: 2,
    subject: researcherId,
    cursor: 0,
    length: ops.length,
    ops,
    journalLast: true,
  };
  if (validateAccountDeletePlan(plan) !== 'ok') return null;
  if (!assertChildBeforeIndex(plan)) return null;
  return plan;
}

async function zrangeMembers(client: RedisPort, key: string): Promise<string[] | null> {
  try {
    const wire = await client.eval(
      '-- adel-zrange\nreturn redis.call("ZRANGE", KEYS[1], 0, -1)',
      [key],
      [],
    );
    return asStringList(wire);
  } catch (error) {
    if (error instanceof RedisCommitAmbiguousError) throw error;
    return null;
  }
}

async function gatherSnapshot(
  client: RedisPort,
  researcher: ResearcherAccount,
): Promise<{ status: 'ok'; snapshot: AccountDeleteSnapshot } | { status: 'unavailable' }> {
  const researcherId = researcher.id;
  const studiesKey = platformKey(`researcher-studies:${researcherId}`);
  const linksKey = platformKey(`participant-links:${researcherId}`);
  const receiptsKey = platformKey(`study-op-receipts:${researcherId}`);
  const idempKey = platformKey(`create-idemp-index:${researcherId}`);
  const accountKey = platformKey(`researcher:${researcherId}`);
  const storageKey = platformKey(`researcher-storage:${researcherId}`);
  const oauthKey = platformKey(`oauth:${researcher.oauthProvider}:${researcher.oauthId}`);
  const emailNormalized = normalizeEmail(researcher.email);
  const emailKey = emailNormalized ? platformKey(`email:${emailNormalized}`) : null;

  const [
    studyMembers,
    linkMembers,
    receiptMembers,
    idempMembers,
    accountRaw,
    storageRaw,
    oauthRaw,
    emailRaw,
  ] = await Promise.all([
    client.smembers(studiesKey),
    client.smembers(linksKey),
    zrangeMembers(client, receiptsKey),
    zrangeMembers(client, idempKey),
    client.get(accountKey),
    client.get(storageKey),
    client.get(oauthKey),
    emailKey ? client.get(emailKey) : Promise.resolve(null),
  ]);

  const studyIds = asStringList(studyMembers);
  const linkIds = asStringList(linkMembers);
  if (!studyIds || !linkIds || !receiptMembers || !idempMembers) {
    return { status: 'unavailable' };
  }

  const locks: AccountDeleteSnapshot['locks'] = [];
  const owners: AccountDeleteSnapshot['owners'] = [];
  const registry: AccountDeleteSnapshot['registry'] = [];
  for (const studyId of studyIds) {
    if (!isUuid(studyId)) return { status: 'unavailable' };
    const [lockRaw, ownerRaw, registryRaw] = await Promise.all([
      client.get(platformKey(`study-op-lock:${studyId}`)),
      client.get(platformKey(`study-owner:${studyId}`)),
      client.hget(platformKey('study-ops:v2'), studyId),
    ]);
    const lock = asString(lockRaw);
    if (lock) locks.push({ studyId, key: platformKey(`study-op-lock:${studyId}`), raw: lock });
    const owner = asString(ownerRaw);
    if (owner) {
      if (!owner.startsWith('oi:owner:')) return { status: 'unavailable' };
      let parsed: { researcherId?: unknown; storageId?: unknown };
      try {
        parsed = JSON.parse(owner.slice('oi:owner:'.length)) as { researcherId?: unknown; storageId?: unknown };
      } catch {
        return { status: 'unavailable' };
      }
      if (typeof parsed.storageId !== 'string' || !isHex64(parsed.storageId)) {
        return { status: 'unavailable' };
      }
      owners.push({
        studyId,
        key: platformKey(`study-owner:${studyId}`),
        raw: owner,
        storageId: parsed.storageId,
      });
    }
    const field = asString(registryRaw);
    if (field) registry.push({ field: studyId, raw: field });
  }

  const receipts: AccountDeleteSnapshot['receipts'] = [];
  for (const member of receiptMembers) {
    const split = member.lastIndexOf(':');
    if (split <= 0) return { status: 'unavailable' };
    const studyId = member.slice(0, split);
    const generation = member.slice(split + 1);
    if (!isUuid(studyId) || !/^[0-9]+$/.test(generation)) return { status: 'unavailable' };
    const key = platformKey(`study-op-receipt:${studyId}:${generation}`);
    const raw = asString(await client.get(key));
    if (raw) receipts.push({ member, key, raw });
  }

  const links: AccountDeleteSnapshot['links'] = [];
  for (const id of linkIds) {
    if (!isHex64(id)) return { status: 'unavailable' };
    const raw = asString(await client.get(platformKey(`participant-link:${id}`)));
    if (raw) links.push({ id, raw });
  }

  const idemps: AccountDeleteSnapshot['idemps'] = [];
  for (const hash of idempMembers) {
    if (!isHex64(hash)) return { status: 'unavailable' };
    const raw = asString(await client.get(platformKey(`create-idemp:${hash}`)));
    if (raw) idemps.push({ hash, raw });
  }

  const storage = asString(storageRaw);
  let storageId: string | null = null;
  if (storage) {
    if (!storage.startsWith('oi:storage:')) return { status: 'unavailable' };
    try {
      const parsed = JSON.parse(storage.slice('oi:storage:'.length)) as { storageId?: unknown };
      if (typeof parsed.storageId !== 'string' || !isHex64(parsed.storageId)) {
        return { status: 'unavailable' };
      }
      storageId = parsed.storageId;
    } catch {
      return { status: 'unavailable' };
    }
  }

  const redisLess = !storage
    && !researcher.encryptedRedisUrl
    && studyIds.length === 0
    && registry.length === 0;

  return {
    status: 'ok',
    snapshot: {
      researcherId,
      accountRaw: asString(accountRaw),
      oauthKey,
      oauthRaw: asString(oauthRaw),
      emailKey,
      emailRaw: asString(emailRaw),
      storageId,
      storageRaw: storage,
      studyIds,
      locks,
      receipts,
      registry,
      owners,
      linkIds,
      links,
      idempHashes: idempMembers,
      idemps,
      redisLess,
    },
  };
}

function preflightCaps(snapshot: AccountDeleteSnapshot, journalCount: number, journalPresent: boolean): boolean {
  if (!journalPresent && journalCount >= MAX_DELETE_JOURNALS) return false;
  if (snapshot.studyIds.length > MAX_STUDIES) return false;
  if (snapshot.linkIds.length > MAX_INDEXED_LINKS) return false;
  if (snapshot.receipts.length > MAX_COLLECTION) return false;
  if (snapshot.registry.length > MAX_LIVE_OPS) return false;
  if (snapshot.idempHashes.length > MAX_IDEM_MAPPINGS) return false;
  return true;
}

export const ACCOUNT_DELETE_PERSIST_SCRIPT = `
-- adel-persist
local function parse_prefixed(value, prefix)
  if type(value) ~= 'string' then return nil end
  if string.sub(value, 1, #prefix) ~= prefix then return nil end
  local ok, obj = pcall(cjson.decode, string.sub(value, #prefix + 1))
  if not ok or type(obj) ~= 'table' then return nil end
  return obj
end

if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then
  local existing = redis.call('GET', KEYS[2])
  if type(existing) ~= 'string' then return {'oi:adel-unavailable'} end
  return {'oi:adel-replay', existing}
end

if redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[4]) then
  return {'oi:adel-too-many'}
end
if redis.call('SCARD', KEYS[3]) > tonumber(ARGV[5]) then return {'oi:adel-too-many'} end
if redis.call('SCARD', KEYS[4]) > tonumber(ARGV[6]) then return {'oi:adel-too-many'} end
if redis.call('ZCARD', KEYS[5]) > tonumber(ARGV[7]) then return {'oi:adel-too-many'} end
if redis.call('ZCARD', KEYS[6]) > tonumber(ARGV[8]) then return {'oi:adel-too-many'} end

local plan = parse_prefixed(ARGV[2], 'oi:adel-plan:')
if not plan or plan.version ~= 2 or plan.subject ~= ARGV[1] then
  return {'oi:adel-unavailable'}
end
if plan.cursor ~= 0 or plan.journalLast ~= true then
  return {'oi:adel-unavailable'}
end
if type(plan.ops) ~= 'table' or tonumber(plan.length) ~= #plan.ops then
  return {'oi:adel-unavailable'}
end
if #plan.ops < 2 or #plan.ops > tonumber(ARGV[9]) then
  return {'oi:adel-too-many'}
end
local last = plan.ops[#plan.ops]
if type(last) ~= 'table' or last['op'] ~= 'hdel-journal' or last.field ~= ARGV[1] then
  return {'oi:adel-unavailable'}
end

redis.call('SET', KEYS[2], ARGV[2])
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
return {'oi:adel-started', ARGV[2]}
`;

export const ACCOUNT_DELETE_APPLY_SCRIPT = `
-- adel-apply
-- fault cut adel-plan-ops
-- fault cut adel-cursor
-- fault cut adel-local-evict
-- fault cut adel-final-hdel
local function parse_prefixed(value, prefix)
  if type(value) ~= 'string' then return nil end
  if string.sub(value, 1, #prefix) ~= prefix then return nil end
  local ok, obj = pcall(cjson.decode, string.sub(value, #prefix + 1))
  if not ok or type(obj) ~= 'table' then return nil end
  return obj
end

local function cad_string(key, expected)
  local current = redis.call('GET', key)
  if current == expected then
    redis.call('DEL', key)
  end
  return true
end

local planRaw = redis.call('GET', KEYS[1])
local plan = parse_prefixed(planRaw, 'oi:adel-plan:')
if not plan or plan.subject ~= ARGV[1] or plan.journalLast ~= true then
  return {'oi:adel-unavailable'}
end
if type(plan.ops) ~= 'table' or tonumber(plan.length) ~= #plan.ops then
  return {'oi:adel-unavailable'}
end
local cursor = tonumber(plan.cursor)
if cursor ~= tonumber(ARGV[2]) then
  return {'oi:adel-unavailable'}
end
if cursor >= #plan.ops then
  if redis.call('HEXISTS', KEYS[2], ARGV[1]) == 0 then
    return {'oi:adel-complete'}
  end
  return {'oi:adel-unavailable'}
end

local op = plan.ops[cursor + 1]
if type(op) ~= 'table' or type(op['op']) ~= 'string' then
  return {'oi:adel-unavailable'}
end
local kind = op['op']
if kind ~= 'cad-string' and kind ~= 'cad-lock' and kind ~= 'cad-owner'
  and kind ~= 'cad-storage' and kind ~= 'srem' and kind ~= 'zrem'
  and kind ~= 'cad-hash' and kind ~= 'local-evict' and kind ~= 'hdel-journal' then
  return {'oi:adel-unavailable'}
end

if kind == 'cad-string' or kind == 'cad-lock' or kind == 'cad-storage' then
  if op.key ~= KEYS[3] then return {'oi:adel-unavailable'} end
  cad_string(KEYS[3], op.expected)
elseif kind == 'cad-owner' then
  if op.key ~= KEYS[3] then return {'oi:adel-unavailable'} end
  local raw = redis.call('GET', KEYS[3])
  if type(raw) == 'string' then
    local owner = parse_prefixed(raw, 'oi:owner:')
    if owner and owner.researcherId == op.expectedOwner and owner.storageId == op.expectedStorageId then
      if redis.call('GET', KEYS[3]) == raw then
        redis.call('DEL', KEYS[3])
      end
    end
  end
elseif kind == 'srem' then
  if op.key ~= KEYS[3] then return {'oi:adel-unavailable'} end
  local t = redis.call('TYPE', KEYS[3])
  if type(t) == 'table' then t = t.ok end
  if t == 'zset' then
    redis.call('ZREM', KEYS[3], op.member)
  elseif t == 'set' or t == 'none' then
    redis.call('SREM', KEYS[3], op.member)
  else
    return {'oi:adel-unavailable'}
  end
elseif kind == 'zrem' then
  if op.key ~= KEYS[3] then return {'oi:adel-unavailable'} end
  redis.call('ZREM', KEYS[3], op.member)
elseif kind == 'cad-hash' then
  if op.key ~= KEYS[3] then return {'oi:adel-unavailable'} end
  local field = redis.call('HGET', KEYS[3], op.field)
  if field == op.expected then
    redis.call('HDEL', KEYS[3], op.field)
  end
elseif kind == 'local-evict' then
  -- fault cut adel-local-evict
elseif kind == 'hdel-journal' then
  if op.field ~= ARGV[1] then return {'oi:adel-unavailable'} end
  -- fault cut adel-final-hdel
  redis.call('HDEL', KEYS[2], ARGV[1])
end

-- fault cut adel-plan-ops
plan.cursor = cursor + 1
-- fault cut adel-cursor
redis.call('SET', KEYS[1], 'oi:adel-plan:' .. cjson.encode(plan))
if plan.cursor >= #plan.ops then
  return {'oi:adel-complete'}
end
return {'oi:adel-progress', 'oi:count:' .. tostring(plan.cursor)}
`;

function parseAdelWire(wire: unknown):
  | { status: 'started' | 'replay'; raw: string }
  | { status: 'progress'; cursor: number }
  | { status: 'complete' | 'too-many' | 'unavailable' } {
  if (!Array.isArray(wire) || wire.length === 0 || typeof wire[0] !== 'string') {
    return { status: 'unavailable' };
  }
  const tag = wire[0];
  if (tag === 'oi:adel-complete' && wire.length === 1) return { status: 'complete' };
  if (tag === 'oi:adel-too-many' && wire.length === 1) return { status: 'too-many' };
  if (tag === 'oi:adel-unavailable' && wire.length === 1) return { status: 'unavailable' };
  if ((tag === 'oi:adel-started' || tag === 'oi:adel-replay') && wire.length === 2 && typeof wire[1] === 'string') {
    return { status: tag === 'oi:adel-started' ? 'started' : 'replay', raw: wire[1] };
  }
  if (tag === 'oi:adel-progress' && wire.length === 2 && typeof wire[1] === 'string' && wire[1].startsWith('oi:count:')) {
    const cursor = Number(wire[1].slice('oi:count:'.length));
    if (!Number.isSafeInteger(cursor) || cursor < 0) return { status: 'unavailable' };
    return { status: 'progress', cursor };
  }
  return { status: 'unavailable' };
}

function applyKeys(op: AccountDeleteOp): [string, string] {
  if (op.op === 'local-evict' || op.op === 'hdel-journal') return [PAD, PAD];
  return [op.key, PAD];
}

export async function hasAccountDeleteJournal(
  researcherId: string,
  client: RedisPort = platform(),
): Promise<'yes' | 'no' | 'unavailable'> {
  if (!isResearcherId(researcherId)) return 'unavailable';
  try {
    const exists = await client.hexists(journalKey(), researcherId);
    if (exists === 1) return 'yes';
    if (exists === 0) return 'no';
    return 'unavailable';
  } catch {
    return 'unavailable';
  }
}

export async function loadAccountDeletePlan(
  researcherId: string,
  client: RedisPort = platform(),
): Promise<AccountDeletePlan | null> {
  const raw = await client.get(planKey(researcherId));
  return parseAccountDeletePlan(raw);
}

export async function beginAccountDeletion(
  researcher: ResearcherAccount,
  input: { client?: RedisPort } = {},
): Promise<BeginAccountDeletionResult> {
  if (!isResearcherId(researcher.id)) return { status: 'unavailable' };
  const client = input.client ?? platform();
  try {
    const lineage = await ensurePlatformSchemaLineage(client);
    if (lineage === 'hold') return { status: 'hold' };
  } catch {
    return { status: 'unavailable' };
  }
  try {
    const present = await client.hexists(journalKey(), researcher.id);
    if (present === 1) {
      const plan = await loadAccountDeletePlan(researcher.id, client);
      if (!plan || plan.subject !== researcher.id) return { status: 'unavailable' };
      return { status: 'replay', plan };
    }
    if (present !== 0) return { status: 'unavailable' };

    const journalCount = Number(await client.hlen(journalKey()));
    if (!Number.isSafeInteger(journalCount) || journalCount < 0) return { status: 'unavailable' };

    const gathered = await gatherSnapshot(client, researcher);
    if (gathered.status !== 'ok') return { status: 'unavailable' };
    if (!gathered.snapshot.accountRaw) return { status: 'not-found' };
    if (!preflightCaps(gathered.snapshot, journalCount, false)) {
      return { status: 'too-many-records' };
    }
    const plan = buildAccountDeletePlan(gathered.snapshot);
    if (!plan) return { status: 'unavailable' };
    if (plan.length > MAX_PLAN_OPS) return { status: 'too-many-records' };

    const evictOp = plan.ops[plan.length - 2];
    const journal: AccountDeleteJournal = {
      version: 2,
      researcherId: researcher.id,
      createdAt: Date.now(),
      evict: {
        disposition: evictOp?.op === 'local-evict' ? evictOp.disposition : 'none',
        researcherId: researcher.id,
        storageId: gathered.snapshot.storageId,
      },
    };

    const wire = await client.eval(
      ACCOUNT_DELETE_PERSIST_SCRIPT,
      [
        journalKey(),
        planKey(researcher.id),
        platformKey(`researcher-studies:${researcher.id}`),
        platformKey(`participant-links:${researcher.id}`),
        platformKey(`study-op-receipts:${researcher.id}`),
        platformKey(`create-idemp-index:${researcher.id}`),
        platformKey(`researcher:${researcher.id}`),
        platformKey('study-ops:v2'),
      ],
      [
        researcher.id,
        encodePlan(plan),
        encodeJournal(journal),
        String(MAX_DELETE_JOURNALS),
        String(MAX_STUDIES),
        String(MAX_INDEXED_LINKS),
        String(MAX_COLLECTION),
        String(MAX_IDEM_MAPPINGS),
        String(MAX_PLAN_OPS),
      ],
    );
    const parsed = parseAdelWire(wire);
    if (parsed.status === 'too-many') return { status: 'too-many-records' };
    if (parsed.status === 'started' || parsed.status === 'replay') {
      const stored = parseAccountDeletePlan(parsed.raw);
      if (!stored) return { status: 'unavailable' };
      return { status: parsed.status, plan: stored };
    }
    return { status: 'unavailable' };
  } catch (error) {
    return { status: mapTransport(error) };
  }
}

function evictFromOp(op: Extract<AccountDeleteOp, { op: 'local-evict' }>): void {
  if (op.disposition === 'none') {
    evictResearcherClients({ disposition: 'none' });
    return;
  }
  if (op.disposition === 'scoped' && op.storageId) {
    evictResearcherClients({
      disposition: 'scoped',
      researcherId: op.researcherId,
      storageId: op.storageId,
    });
    return;
  }
  evictResearcherClients({ disposition: 'full', researcherId: op.researcherId });
}

export async function resumeAccountDeletion(
  researcherId: string,
  input: { client?: RedisPort } = {},
): Promise<ResumeAccountDeletionResult> {
  if (!isResearcherId(researcherId)) return { status: 'unavailable' };
  const client = input.client ?? platform();
  try {
    const present = await client.hexists(journalKey(), researcherId);
    if (present === 0) return { status: 'complete' };
    if (present !== 1) return { status: 'unavailable' };

    let plan = await loadAccountDeletePlan(researcherId, client);
    if (!plan || plan.subject !== researcherId) return { status: 'unavailable' };
    if (validateAccountDeletePlan(plan) !== 'ok') return { status: 'unavailable' };

    while (plan.cursor < plan.length) {
      const op = plan.ops[plan.cursor];
      if (!op) return { status: 'unavailable' };
      if (op.op === 'local-evict') {
        evictFromOp(op);
      }
      const [target, aux] = applyKeys(op);
      const wire = await client.eval(
        ACCOUNT_DELETE_APPLY_SCRIPT,
        [planKey(researcherId), journalKey(), target, aux],
        [researcherId, String(plan.cursor)],
      );
      const parsed = parseAdelWire(wire);
      if (parsed.status === 'complete') return { status: 'complete' };
      if (parsed.status !== 'progress') return { status: 'unavailable' };
      const next = await loadAccountDeletePlan(researcherId, client);
      if (!next) {
        plan = { ...plan, cursor: parsed.cursor };
      } else {
        plan = next;
      }
    }
    const leftover = await client.hexists(journalKey(), researcherId);
    return leftover === 0 ? { status: 'complete' } : { status: 'unavailable' };
  } catch (error) {
    const mapped = mapTransport(error);
    if (mapped === 'ambiguous') return { status: 'ambiguous' };
    try {
      const plan = await loadAccountDeletePlan(researcherId, client);
      if (plan && plan.cursor < plan.length) return { status: 'pending', plan };
    } catch {
      // fall through
    }
    return { status: 'unavailable' };
  }
}

export async function deleteResearcherAccount(
  researcher: ResearcherAccount,
  _maximumStudies = 1_000,
  input: { client?: RedisPort } = {},
): Promise<DeleteResearcherResult> {
  const begun = await beginAccountDeletion(researcher, input);
  if (begun.status === 'too-many-records') return { status: 'too-many-records' };
  if (begun.status === 'not-found') return { status: 'not-found' };
  if (begun.status === 'unavailable' || begun.status === 'ambiguous' || begun.status === 'hold') {
    return { status: 'unavailable' };
  }
  const resumed = await resumeAccountDeletion(researcher.id, input);
  if (resumed.status === 'complete') {
    return { status: 'deleted', detachedStudyCount: 0 };
  }
  if (resumed.status === 'pending') return { status: 'unavailable' };
  if (resumed.status === 'not-found') return { status: 'not-found' };
  return { status: 'unavailable' };
}

export function interpretAccountDeletePersist(
  store: {
    strings: Map<string, string>;
    hashes: Map<string, Map<string, string>>;
    sets: Map<string, Set<string>>;
    zsets: Map<string, Map<string, number>>;
    writes: string[];
  },
  keys: string[],
  args: string[],
): unknown {
  const journal = store.hashes.get(keys[0]) ?? new Map<string, string>();
  if (journal.has(args[0])) {
    const existing = store.strings.get(keys[1]);
    if (typeof existing !== 'string') return ['oi:adel-unavailable'];
    return ['oi:adel-replay', existing];
  }
  if (journal.size >= Number(args[3])) return ['oi:adel-too-many'];
  if ((store.sets.get(keys[2])?.size ?? 0) > Number(args[4])) return ['oi:adel-too-many'];
  if ((store.sets.get(keys[3])?.size ?? 0) > Number(args[5])) return ['oi:adel-too-many'];
  if ((store.zsets.get(keys[4])?.size ?? 0) > Number(args[6])) return ['oi:adel-too-many'];
  if ((store.zsets.get(keys[5])?.size ?? 0) > Number(args[7])) return ['oi:adel-too-many'];
  const plan = parseAccountDeletePlan(args[1]);
  if (!plan || plan.subject !== args[0] || plan.cursor !== 0) return ['oi:adel-unavailable'];
  store.strings.set(keys[1], args[1]);
  store.writes.push(`SET ${keys[1]}`);
  journal.set(args[0], args[2]);
  store.hashes.set(keys[0], journal);
  store.writes.push(`HSET ${keys[0]} ${args[0]}`);
  return ['oi:adel-started', args[1]];
}

export function interpretAccountDeleteApply(
  store: {
    strings: Map<string, string>;
    hashes: Map<string, Map<string, string>>;
    sets: Map<string, Set<string>>;
    zsets: Map<string, Map<string, number>>;
    writes: string[];
  },
  keys: string[],
  args: string[],
): unknown {
  const plan = parseAccountDeletePlan(store.strings.get(keys[1 - 1]));
  if (!plan || plan.subject !== args[0]) return ['oi:adel-unavailable'];
  const cursor = Number(args[1]);
  if (cursor !== plan.cursor) return ['oi:adel-unavailable'];
  if (cursor >= plan.length) {
    return store.hashes.get(keys[1])?.has(args[0]) ? ['oi:adel-unavailable'] : ['oi:adel-complete'];
  }
  const op = plan.ops[cursor];
  if (!op) return ['oi:adel-unavailable'];
  if (op.op === 'cad-string' || op.op === 'cad-lock' || op.op === 'cad-storage') {
    if (op.key !== keys[2]) return ['oi:adel-unavailable'];
    if (store.strings.get(op.key) === op.expected) {
      store.strings.delete(op.key);
      store.writes.push(`DEL ${op.key}`);
    }
    store.writes.push('adel-plan-ops');
  } else if (op.op === 'cad-owner') {
    if (op.key !== keys[2]) return ['oi:adel-unavailable'];
    const raw = store.strings.get(op.key);
    if (raw?.startsWith('oi:owner:')) {
      try {
        const owner = JSON.parse(raw.slice('oi:owner:'.length)) as {
          researcherId?: unknown;
          storageId?: unknown;
        };
        if (owner.researcherId === op.expectedOwner && owner.storageId === op.expectedStorageId) {
          store.strings.delete(op.key);
          store.writes.push(`DEL ${op.key}`);
        }
      } catch {
        return ['oi:adel-unavailable'];
      }
    }
    store.writes.push('adel-plan-ops');
  } else if (op.op === 'srem') {
    if (op.key !== keys[2]) return ['oi:adel-unavailable'];
    if (store.zsets.has(op.key)) {
      store.zsets.get(op.key)?.delete(op.member);
      store.writes.push(`ZREM ${op.key}`);
    } else {
      store.sets.get(op.key)?.delete(op.member);
      store.writes.push(`SREM ${op.key}`);
    }
    store.writes.push('adel-plan-ops');
  } else if (op.op === 'zrem') {
    if (op.key !== keys[2]) return ['oi:adel-unavailable'];
    store.zsets.get(op.key)?.delete(op.member);
    store.writes.push(`ZREM ${op.key}`);
    store.writes.push('adel-plan-ops');
  } else if (op.op === 'cad-hash') {
    if (op.key !== keys[2]) return ['oi:adel-unavailable'];
    const hash = store.hashes.get(op.key);
    if (hash?.get(op.field) === op.expected) {
      hash.delete(op.field);
      store.writes.push(`HDEL ${op.key} ${op.field}`);
    }
    store.writes.push('adel-plan-ops');
  } else if (op.op === 'local-evict') {
    store.writes.push('adel-local-evict');
  } else if (op.op === 'hdel-journal') {
    store.writes.push('adel-final-hdel');
    store.hashes.get(keys[1])?.delete(args[0]);
    store.writes.push(`HDEL ${keys[1]} ${args[0]}`);
  } else {
    return ['oi:adel-unavailable'];
  }
  plan.cursor = cursor + 1;
  store.strings.set(keys[0], encodePlan(plan));
  store.writes.push('adel-cursor');
  store.writes.push(`SET ${keys[0]}`);
  if (plan.cursor >= plan.length) return ['oi:adel-complete'];
  return ['oi:adel-progress', `oi:count:${plan.cursor}`];
}
