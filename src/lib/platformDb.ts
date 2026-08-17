// Platform Database Access Layer (Hosted Mode Only)
// Stores researcher accounts, encrypted credentials, and study ownership
// Uses the platform host's own Upstash Redis instance

import {
  getPlatformClient,
  redisCipherSnapshot,
  type CacheEvictDisposition,
} from './kvClient';
import { ResearcherAccount, ResearcherProfile } from '@/types';
import { normalizeEmail } from './email';
import { RedisCommitAmbiguousError, type RedisPort } from './redisPort';
import { ensurePlatformSchemaLineage, platformKey } from './platformSchema';
import { isHex64, isResearcherId, isUuid, type StudyOpPhase } from './wire/types';
import { parseAuthorityResult } from './wire/parse';
import {
  loadResearcherStorageBinding,
  parseOwnerRecord,
  type OwnerRecord,
} from './platformDb.operations';
import { logRequestFailure } from './requestLog';

export {
  BEGIN_STUDY_OPERATION_SCRIPT,
  RECOVER_RESERVING_STUDY_OPERATION_SCRIPT,
  RESOLVE_STUDY_OPERATION_SCRIPT,
  PUBLISH_STUDY_OPERATION_SCRIPT,
  OP_GRACE_MS,
  RECEIPT_TTL_SECONDS,
  beginCreateStudyOperationV2,
  beginDeleteStudyOperationV2,
  recoverReservingStudyOperation,
  resolveStudyOperationV2,
  publishStudyOperationV2,
  buildPendingStudyOperationV2,
  encodeAccountRecord,
  encodeLockValue,
  encodeOperationReceipt,
  encodeOperationRecord,
  encodeOwnerRecord,
  encodeStorageBinding,
  hostedBeginKeys,
  hostedRecoverKeys,
  hostedResolveKeys,
  hostedPublishKeys,
  parseOperationReceipt,
  parseOwnerRecord,
  parsePendingStudyOperationV2,
  parseStorageBinding,
  loadResearcherStorageBinding,
  studyOperationV2Id,
} from './platformDb.operations';
export {
  ACCOUNT_DELETE_APPLY_SCRIPT,
  ACCOUNT_DELETE_OP_ALLOWLIST,
  ACCOUNT_DELETE_PERSIST_SCRIPT,
  MAX_DELETE_JOURNALS,
  MAX_PLAN_OPS,
  assertChildBeforeIndex,
  beginAccountDeletion,
  buildAccountDeletePlan,
  deleteResearcherAccount,
  hasAccountDeleteJournal,
  interpretAccountDeleteApply,
  interpretAccountDeletePersist,
  loadAccountDeletePlan,
  parseAccountDeleteJournal,
  parseAccountDeletePlan,
  resumeAccountDeletion,
  validateAccountDeletePlan,
} from './platformDb.accountDelete';
export type {
  AccountDeleteJournal,
  AccountDeleteOp,
  AccountDeletePlan,
  AccountDeleteSnapshot,
  BeginAccountDeletionResult,
  ResumeAccountDeletionResult,
} from './platformDb.accountDelete';
export type {
  BeginStudyOperationV2Input,
  BeginStudyOperationV2Result,
  OperationReceipt,
  OwnerRecord,
  PendingStudyOperationV2,
  ResearcherStorageBindingLoadResult,
  PublishStudyOperationV2Input,
  PublishStudyOperationV2Result,
  RecoverReservingStudyOperationInput,
  RecoverReservingStudyOperationResult,
  ResolveStudyOperationV2Input,
  ResolveStudyOperationV2Result,
  StorageBinding,
  StudyOperationResolutionV2,
  StudyOpPhase,
} from './platformDb.operations';

export const AUTHORITY_PURPOSES = [
  'read',
  'mutate-config',
  'link',
  'preview',
  'new-persist',
  'persist-repair',
  'delete',
] as const;

export type AuthorityPurpose = (typeof AUTHORITY_PURPOSES)[number];

export type StudyAuthorityCheckedResult =
  | { status: 'allow'; owner: OwnerRecord }
  | { status: 'live'; phase: StudyOpPhase }
  | {
      status:
        | 'adel'
        | 'hold'
        | 'noacct'
        | 'deny'
        | 'notfound'
        | 'corrupt'
        | 'mismatch'
        | 'unavailable'
        | 'ambiguous'
        | 'invalid';
    };

export interface GetStudyAuthorityCheckedInput {
  client?: RedisPort;
  researcherId: string;
  studyId: string;
  purpose: AuthorityPurpose;
}

// Family `authority` (Revision 12 §10). Read-only. KEYS known before EVAL.
// Order: lineage → journal → account → owner+storage+reverse → registry/lock.
export const AUTHORITY_GATE_LUA = `
-- fault cut authority
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

local caller = ARGV[1]
local studyId = ARGV[2]
local purpose = ARGV[3]
if purpose ~= 'read' and purpose ~= 'mutate-config' and purpose ~= 'link'
  and purpose ~= 'preview' and purpose ~= 'new-persist'
  and purpose ~= 'persist-repair' and purpose ~= 'delete' then
  return {'oi:authz-unavailable'}
end

-- 1. lineage
local lineage = parse_prefixed(redis.call('GET', KEYS[5]), 'oi:lineage:')
if not lineage or lineage.version ~= 2 or lineage.authority ~= 'v2' or lineage.operations ~= 'hash-v2' then
  return {'oi:authz-hold'}
end

-- 2. journal (caller, before account-missing)
if caller ~= '' and redis.call('HEXISTS', KEYS[1], caller) == 1 then
  return {'oi:authz-adel'}
end

-- 3. account
if caller ~= '' then
  local account = parse_prefixed(redis.call('GET', ARGV[4] .. caller), 'oi:account:')
  if not account or account.id ~= caller then
    return {'oi:authz-noacct'}
  end
end

-- 4. owner + storage + reverse
local ownerRaw = redis.call('GET', KEYS[2])
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

-- 5. registry / lock
local field = redis.call('HGET', KEYS[3], studyId)
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
  local lockRaw = redis.call('GET', KEYS[4])
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

return {'oi:authz-allow', ownerRaw}
-- authority (no writes)
`;

export function hostedAuthorityKeys(studyId: string): string[] {
  return [
    platformKey('account-delete-journal'),
    platformKey(`study-owner:${studyId}`),
    platformKey('study-ops:v2'),
    platformKey(`study-op-lock:${studyId}`),
    platformKey('schema-lineage'),
  ];
}

export function hostedAuthorityArgvPrefixes(): [string, string, string, string] {
  return [
    platformKey('researcher:'),
    platformKey('researcher-studies:'),
    platformKey('researcher-storage:'),
    platformKey('storage-researchers:'),
  ];
}

function isAuthorityPurpose(value: string): value is AuthorityPurpose {
  return (AUTHORITY_PURPOSES as readonly string[]).includes(value);
}

function mapAuthorityTransport(error: unknown): 'ambiguous' | 'unavailable' {
  if (error instanceof RedisCommitAmbiguousError) {
    return error.commitState === 'may-have-committed' ? 'ambiguous' : 'unavailable';
  }
  return 'unavailable';
}

export async function getStudyAuthorityChecked(
  input: GetStudyAuthorityCheckedInput,
): Promise<StudyAuthorityCheckedResult> {
  if (!isUuid(input.studyId) || !isAuthorityPurpose(input.purpose)) {
    return { status: 'invalid' };
  }
  if (input.researcherId !== '' && !isResearcherId(input.researcherId)) {
    return { status: 'invalid' };
  }

  const client = input.client ?? getPlatformClient();
  try {
    const wire = await client.eval(
      AUTHORITY_GATE_LUA,
      hostedAuthorityKeys(input.studyId),
      [input.researcherId, input.studyId, input.purpose, ...hostedAuthorityArgvPrefixes()],
    );
    const parsed = parseAuthorityResult(wire);
    if (parsed.status !== 'ok') return { status: 'unavailable' };
    if (parsed.value.outcome === 'allow') {
      const owner = parseOwnerRecord(parsed.value.value);
      if (!owner) return { status: 'unavailable' };
      return { status: 'allow', owner };
    }
    if (parsed.value.outcome === 'live') {
      return { status: 'live', phase: parsed.value.phase };
    }
    if (parsed.value.outcome === 'account-deleting') return { status: 'adel' };
    return { status: parsed.value.outcome };
  } catch (error) {
    logRequestFailure({ event: 'platform.unavailable' }, error);
    return { status: mapAuthorityTransport(error) };
  }
}

const platform = () => getPlatformClient();

// Key prefix for environment isolation (staging vs production sharing same Redis)
const key = (k: string) => {
  const prefix = process.env.PLATFORM_KEY_PREFIX?.trim() || '';
  if (!prefix) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('PLATFORM_KEY_PREFIX is required');
    }
    return k;
  }
  if (!/^[a-z0-9_-]{1,64}$/.test(prefix)) {
    throw new Error('PLATFORM_KEY_PREFIX is invalid');
  }
  return `${prefix}:${k}`;
};

export type ResearcherLoadResult =
  | { status: 'found'; researcher: ResearcherAccount }
  | { status: 'not-found' }
  | { status: 'unavailable' };

const ACCOUNT_VALUE_PREFIX = 'oi:account:';

function asResearcherAccount(value: unknown): ResearcherAccount | null {
  let parsed = value;
  if (typeof parsed === 'string') {
    const raw = parsed.startsWith(ACCOUNT_VALUE_PREFIX)
      ? parsed.slice(ACCOUNT_VALUE_PREFIX.length)
      : parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const account = parsed as ResearcherAccount;
  if (typeof account.id !== 'string' || typeof account.email !== 'string') return null;
  return account;
}

export async function getResearcherByIdChecked(id: string): Promise<ResearcherLoadResult> {
  try {
    const researcher = asResearcherAccount(
      await platform().get<ResearcherAccount | string>(`${key('researcher')}:${id}`)
    );
    return researcher ? { status: 'found', researcher } : { status: 'not-found' };
  } catch (error) {
    logRequestFailure({ event: 'platform.unavailable' }, error);
    return { status: 'unavailable' };
  }
}

// ============================================
// Researcher Account CRUD
// ============================================

export async function getResearcherById(id: string): Promise<ResearcherAccount | null> {
  const result = await getResearcherByIdChecked(id);
  return result.status === 'found' ? result.researcher : null;
}

export async function getResearcherByOAuth(
  provider: string,
  oauthId: string
): Promise<ResearcherAccount | null> {
  try {
    const researcherId = await platform().get<string>(`${key('oauth')}:${provider}:${oauthId}`);
    if (!researcherId) return null;
    return getResearcherById(researcherId);
  } catch (error) {
    logRequestFailure({ event: 'platform.unavailable' }, error);
    return null;
  }
}

export async function getResearcherByEmail(email: string): Promise<ResearcherAccount | null> {
  try {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;
    const researcherId = await platform().get<string>(`${key('email')}:${normalized}`);
    if (!researcherId) return null;
    return getResearcherById(researcherId);
  } catch (error) {
    logRequestFailure({ event: 'platform.unavailable' }, error);
    return null;
  }
}

export type ProvisionResearcherResult =
  | { status: 'found'; researcher: ResearcherAccount }
  | { status: 'created'; researcher: ResearcherAccount }
  | { status: 'conflict' }
  | { status: 'unavailable' };

// Atomic find-or-create. Existing OAuth identity wins. An email already bound
// to a different OAuth identity is a conservative conflict — never auto-link.
const PROVISION_RESEARCHER_SCRIPT = `
local existingOAuth = redis.call('GET', KEYS[1])
if existingOAuth then
  return 0
end

local existingEmail = redis.call('GET', KEYS[2])
if existingEmail then
  return -1
end

if redis.call('SET', KEYS[1], ARGV[1], 'NX') == false then
  return 0
end

if redis.call('SET', KEYS[2], ARGV[1], 'NX') == false then
  redis.call('DEL', KEYS[1])
  return -1
end

redis.call('SET', KEYS[3], ARGV[2])
redis.call('SADD', KEYS[4], ARGV[1])
return 1
`;

export async function provisionResearcherByOAuth(input: {
  provider: 'google' | 'github';
  oauthId: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}): Promise<ProvisionResearcherResult> {
  const email = normalizeEmail(input.email);
  const oauthId = input.oauthId.trim();
  const name = input.name.trim();
  if (!email || !oauthId || !name) {
    return { status: 'unavailable' };
  }

  const now = Date.now();
  const researcher: ResearcherAccount = {
    id: crypto.randomUUID(),
    email,
    name,
    avatarUrl: input.avatarUrl,
    oauthProvider: input.provider,
    oauthId,
    createdAt: now,
    lastLoginAt: now,
    onboardingComplete: false,
    encryptedRedisUrl: null,
    encryptedRedisToken: null,
    encryptedGeminiApiKey: null,
    encryptedAnthropicApiKey: null,
    encryptedOpenAiApiKey: null,
    encryptedOpenRouterApiKey: null,
    redisConfiguredAt: null,
  };

  try {
    const p = platform();
    const result = await p.eval(
      PROVISION_RESEARCHER_SCRIPT,
      [
        `${key('oauth')}:${input.provider}:${oauthId}`,
        `${key('email')}:${email}`,
        `${key('researcher')}:${researcher.id}`,
        key('all-researchers'),
      ],
      [researcher.id, JSON.stringify(researcher)]
    );

    if (result === 1 || result === '1') {
      return { status: 'created', researcher };
    }

    if (result === -1 || result === '-1') {
      return { status: 'conflict' };
    }

    if (result === 0 || result === '0') {
      const existing = await getResearcherByOAuth(input.provider, oauthId);
      if (!existing) {
        return { status: 'unavailable' };
      }
      updateResearcher(existing.id, { lastLoginAt: Date.now() }).catch(() => {});
      return { status: 'found', researcher: existing };
    }

    return { status: 'unavailable' };
  } catch (error) {
    logRequestFailure({ event: 'platform.unavailable' }, error);
    return { status: 'unavailable' };
  }
}

export async function saveResearcher(researcher: ResearcherAccount): Promise<boolean> {
  try {
    const email = normalizeEmail(researcher.email);
    if (!email) return false;
    const p = platform();
    await p.set(`${key('researcher')}:${researcher.id}`, JSON.stringify({ ...researcher, email }));
    await p.set(`${key('oauth')}:${researcher.oauthProvider}:${researcher.oauthId}`, researcher.id);
    await p.set(`${key('email')}:${email}`, researcher.id);
    await p.sadd(key('all-researchers'), researcher.id);
    return true;
  } catch (error) {
    logRequestFailure({ event: 'platform.unavailable' }, error);
    return false;
  }
}

export async function updateResearcher(
  id: string,
  updates: Partial<ResearcherAccount>
): Promise<boolean> {
  const script = `
    local raw = redis.call('GET', KEYS[1])
    if not raw then return 0 end
    local account = cjson.decode(raw)
    local patch = cjson.decode(ARGV[1])
    for field, value in pairs(patch) do
      if field ~= 'id' then account[field] = value end
    end
    redis.call('SET', KEYS[1], cjson.encode(account))
    return 1
  `;
  try {
    const result = await platform().eval(
      script,
      [`${key('researcher')}:${id}`],
      [JSON.stringify(updates)]
    );
    return Number(result) === 1;
  } catch (error) {
    logRequestFailure({ event: 'platform.unavailable' }, error);
    return false;
  }
}

export type CredentialMutationResult =
  | {
      status: 'updated';
      credentialRevision: number;
      bindingEpoch: number;
      storageId: string | null;
      evict: CacheEvictDisposition;
    }
  | { status: 'not-found' }
  | { status: 'conflict' }
  | { status: 'refused' }
  | { status: 'adel' }
  | { status: 'ambiguous' }
  | { status: 'unavailable' };

export interface CredentialOriginInput {
  storageId: string;
}

export type PlatformRateLimitResult =
  | { status: 'allowed'; remaining: number }
  | { status: 'limited'; retryAfterSeconds: number }
  | { status: 'hold' }
  | { status: 'unavailable' };

export interface PlatformRateLimitCounter {
  operation: string;
  subject: string;
  maximum: number;
  windowSeconds: number;
}

export type PlatformMultiRateLimitResult =
  | { status: 'allowed' }
  | { status: 'limited'; retryAfterSeconds: number }
  | { status: 'unavailable' };

// Atomically enforces every platform-owned scope before incrementing any of
// them. Hosted abuse controls use this instead of researcher-controlled BYOS,
// so a tenant cannot reset the service-protection counters.
export async function consumePlatformRateLimits(
  counters: PlatformRateLimitCounter[]
): Promise<PlatformMultiRateLimitResult> {
  if (
    counters.length < 1
    || counters.length > 8
    || counters.some(counter => (
      !/^[a-z0-9-]{1,40}$/.test(counter.operation)
      || !/^[A-Za-z0-9:_-]{1,256}$/.test(counter.subject)
      || !Number.isSafeInteger(counter.maximum)
      || counter.maximum < 1
      || counter.maximum > 1_000_000
      || !Number.isSafeInteger(counter.windowSeconds)
      || counter.windowSeconds < 1
      || counter.windowSeconds > 604_800
    ))
  ) {
    return { status: 'unavailable' };
  }

  const nowSeconds = Math.floor(Date.now() / 1_000);
  const script = `
    for i = 1, #KEYS do
      local maximum = tonumber(ARGV[(i - 1) * 2 + 1])
      local count = tonumber(redis.call('GET', KEYS[i]) or '0')
      if count >= maximum then return {0, i} end
    end
    for i = 1, #KEYS do
      local expiry = tonumber(ARGV[(i - 1) * 2 + 2])
      local count = redis.call('INCR', KEYS[i])
      if count == 1 then redis.call('EXPIRE', KEYS[i], expiry) end
    end
    return {1, 0}
  `;

  try {
    const result = await platform().eval(
      script,
      counters.map(counter => {
        const bucket = Math.floor(nowSeconds / counter.windowSeconds);
        return `${key('rate-limit')}:${counter.operation}:${bucket}:${counter.subject}`;
      }),
      counters.flatMap(counter => [
        String(counter.maximum),
        String(counter.windowSeconds + 60),
      ])
    );
    const pair = Array.isArray(result) ? result : [];
    const allowed = Number(pair[0]);
    const rejectedIndex = Number(pair[1]);
    if (allowed === 1) return { status: 'allowed' };
    if (allowed !== 0 || !Number.isSafeInteger(rejectedIndex) || rejectedIndex < 1) {
      return { status: 'unavailable' };
    }
    const rejected = counters[rejectedIndex - 1];
    if (!rejected) return { status: 'unavailable' };
    return {
      status: 'limited',
      retryAfterSeconds: rejected.windowSeconds - (nowSeconds % rejected.windowSeconds),
    };
  } catch (error) {
    logRequestFailure({ event: 'platform.unavailable' }, error);
    return { status: 'unavailable' };
  }
}

export async function consumePlatformRateLimit(
  operation: string,
  researcherId: string,
  maximum: number,
  windowSeconds: number
): Promise<PlatformRateLimitResult> {
  if (!/^[a-z0-9-]{1,40}$/.test(operation) || maximum < 1 || windowSeconds < 1) {
    return { status: 'unavailable' };
  }
  try {
    const lineage = await ensurePlatformSchemaLineage(platform());
    if (lineage === 'hold') return { status: 'hold' };
  } catch {
    return { status: 'unavailable' };
  }
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const bucket = Math.floor(nowSeconds / windowSeconds);
  const retryAfterSeconds = windowSeconds - (nowSeconds % windowSeconds);
  const script = `
    local count = redis.call('INCR', KEYS[1])
    if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
    return count
  `;
  try {
    const count = Number(await platform().eval(
      script,
      [`${key('rate-limit')}:${operation}:${bucket}:${researcherId}`],
      [String(windowSeconds + 60)]
    ));
    if (!Number.isSafeInteger(count) || count < 1) return { status: 'unavailable' };
    if (count > maximum) return { status: 'limited', retryAfterSeconds };
    return { status: 'allowed', remaining: maximum - count };
  } catch (error) {
    logRequestFailure({ event: 'platform.unavailable' }, error);
    return { status: 'unavailable' };
  }
}

type CredentialPatch = Partial<Pick<
  ResearcherAccount,
  | 'encryptedRedisUrl'
  | 'encryptedRedisToken'
  | 'encryptedGeminiApiKey'
  | 'encryptedAnthropicApiKey'
  | 'encryptedOpenAiApiKey'
  | 'encryptedOpenRouterApiKey'
  | 'redisConfiguredAt'
  | 'onboardingComplete'
>>;

export const UPDATE_RESEARCHER_CREDENTIALS_SCRIPT = `
-- credential-cas
local function parse_prefixed(value, prefix)
  if type(value) ~= 'string' then return nil end
  if string.sub(value, 1, #prefix) ~= prefix then return nil end
  local ok, obj = pcall(cjson.decode, string.sub(value, #prefix + 1))
  if not ok or type(obj) ~= 'table' then return nil end
  return obj
end

if redis.call('HEXISTS', KEYS[6], ARGV[1]) == 1 then
  return {'oi:cred-adel'}
end

local raw = redis.call('GET', KEYS[1])
if not raw then return {'oi:cred-not-found'} end
local account = parse_prefixed(raw, 'oi:account:')
if not account or account.id ~= ARGV[1] then
  return {'oi:cred-unavailable'}
end

local current = tonumber(account.credentialRevision or 0)
if current ~= tonumber(ARGV[2]) then
  return {'oi:cred-conflict'}
end

local storageRaw = redis.call('GET', KEYS[2])
local storage = nil
if storageRaw then
  storage = parse_prefixed(storageRaw, 'oi:storage:')
  if not storage then return {'oi:cred-unavailable'} end
end

if storage then
  if ARGV[3] == '' or storage.storageId ~= ARGV[3]
    or tonumber(storage.bindingEpoch) ~= tonumber(ARGV[4])
    or storage.cipherSnapshot ~= ARGV[5]
    or storage.researcherId ~= ARGV[1] then
    return {'oi:cred-conflict'}
  end
elseif ARGV[3] ~= '' or ARGV[4] ~= '' or ARGV[5] ~= '' then
  return {'oi:cred-conflict'}
end

local function origin_blocked()
  local count = redis.call('SCARD', KEYS[3])
  if count > tonumber(ARGV[11]) then return 'unavailable' end
  if count > 0 then return 'refused' end
  local members = redis.call('SMEMBERS', KEYS[3])
  for i = 1, #members do
    if redis.call('HGET', KEYS[7], members[i]) then
      return 'refused'
    end
  end
  return nil
end

local intent = ARGV[6]
local patch = cjson.decode(ARGV[10])
if type(patch) ~= 'table' then return {'oi:cred-unavailable'} end
for field, value in pairs(patch) do
  if field ~= 'id' and field ~= 'credentialRevision' then
    account[field] = value
  end
end

local newRevision = current + 1
account.credentialRevision = newRevision
local disposition = 'none'
local resultStorageId = cjson.null
local resultEpoch = 0
if storage then
  resultStorageId = storage.storageId
  resultEpoch = tonumber(storage.bindingEpoch)
end

if intent == 'none' then
  if storage then
    storage.credentialRevision = newRevision
    redis.call('SET', KEYS[2], 'oi:storage:' .. cjson.encode(storage))
  end
elseif intent == 'set' then
  if ARGV[7] == '' or ARGV[8] == '' or ARGV[9] == '' then
    return {'oi:cred-unavailable'}
  end
  if not storage then
    local binding = {
      version = 2,
      researcherId = ARGV[1],
      storageId = ARGV[7],
      originHash = ARGV[8],
      credentialRevision = newRevision,
      bindingEpoch = 0,
      cipherSnapshot = ARGV[9]
    }
    redis.call('SET', KEYS[2], 'oi:storage:' .. cjson.encode(binding))
    redis.call('SADD', KEYS[5], ARGV[1])
    resultStorageId = ARGV[7]
    resultEpoch = 0
    disposition = 'none'
  elseif storage.storageId == ARGV[7] then
    storage.credentialRevision = newRevision
    storage.cipherSnapshot = ARGV[9]
    redis.call('SET', KEYS[2], 'oi:storage:' .. cjson.encode(storage))
    resultStorageId = storage.storageId
    resultEpoch = tonumber(storage.bindingEpoch)
    disposition = 'scoped'
  else
    local blocked = origin_blocked()
    if blocked == 'unavailable' then return {'oi:cred-unavailable'} end
    if blocked == 'refused' then return {'oi:cred-refused'} end
    redis.call('SREM', KEYS[4], ARGV[1])
    local binding = {
      version = 2,
      researcherId = ARGV[1],
      storageId = ARGV[7],
      originHash = ARGV[8],
      credentialRevision = newRevision,
      bindingEpoch = tonumber(storage.bindingEpoch) + 1,
      cipherSnapshot = ARGV[9]
    }
    redis.call('SET', KEYS[2], 'oi:storage:' .. cjson.encode(binding))
    redis.call('SADD', KEYS[5], ARGV[1])
    resultStorageId = storage.storageId
    resultEpoch = binding.bindingEpoch
    disposition = 'scoped'
  end
elseif intent == 'clear' then
  if not storage then
    resultStorageId = cjson.null
    resultEpoch = 0
    disposition = 'none'
  else
    local blocked = origin_blocked()
    if blocked == 'unavailable' then return {'oi:cred-unavailable'} end
    if blocked == 'refused' then return {'oi:cred-refused'} end
    redis.call('SREM', KEYS[4], ARGV[1])
    redis.call('DEL', KEYS[2])
    resultStorageId = storage.storageId
    resultEpoch = tonumber(storage.bindingEpoch)
    disposition = 'scoped'
  end
else
  return {'oi:cred-unavailable'}
end

redis.call('SET', KEYS[1], 'oi:account:' .. cjson.encode(account))
local payload = {
  credentialRevision = newRevision,
  bindingEpoch = resultEpoch,
  storageId = resultStorageId,
  disposition = disposition
}
return {'oi:cred-updated', 'oi:json:' .. cjson.encode(payload)}
`;

function inferCredentialIntent(
  updates: CredentialPatch,
  origin?: CredentialOriginInput,
): 'none' | 'set' | 'clear' | 'unavailable' {
  const clearingRedis = Object.prototype.hasOwnProperty.call(updates, 'encryptedRedisUrl')
    && updates.encryptedRedisUrl === null
    && Object.prototype.hasOwnProperty.call(updates, 'encryptedRedisToken')
    && updates.encryptedRedisToken === null;
  if (origin) {
    if (clearingRedis) return 'unavailable';
    if (!isHex64(origin.storageId)) return 'unavailable';
    return 'set';
  }
  if (clearingRedis) return 'clear';
  return 'none';
}

function parseCredentialCasWire(wire: unknown, researcherId: string): CredentialMutationResult {
  if (!Array.isArray(wire) || wire.length === 0 || typeof wire[0] !== 'string') {
    return { status: 'unavailable' };
  }
  const tag = wire[0];
  if (wire.length === 1) {
    if (tag === 'oi:cred-not-found') return { status: 'not-found' };
    if (tag === 'oi:cred-conflict') return { status: 'conflict' };
    if (tag === 'oi:cred-refused') return { status: 'refused' };
    if (tag === 'oi:cred-adel') return { status: 'adel' };
    if (tag === 'oi:cred-unavailable') return { status: 'unavailable' };
    return { status: 'unavailable' };
  }
  if (tag !== 'oi:cred-updated' || wire.length !== 2 || typeof wire[1] !== 'string') {
    return { status: 'unavailable' };
  }
  if (!wire[1].startsWith('oi:json:')) return { status: 'unavailable' };
  let payload: unknown;
  try {
    payload = JSON.parse(wire[1].slice('oi:json:'.length));
  } catch {
    return { status: 'unavailable' };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { status: 'unavailable' };
  }
  const body = payload as {
    credentialRevision?: unknown;
    bindingEpoch?: unknown;
    storageId?: unknown;
    disposition?: unknown;
  };
  if (!Number.isSafeInteger(body.credentialRevision) || (body.credentialRevision as number) < 1) {
    return { status: 'unavailable' };
  }
  if (!Number.isSafeInteger(body.bindingEpoch) || (body.bindingEpoch as number) < 0) {
    return { status: 'unavailable' };
  }
  const storageId = body.storageId === null || body.storageId === undefined
    ? null
    : typeof body.storageId === 'string' && isHex64(body.storageId)
      ? body.storageId
      : undefined;
  if (storageId === undefined) return { status: 'unavailable' };
  if (body.disposition === 'none') {
    return {
      status: 'updated',
      credentialRevision: body.credentialRevision as number,
      bindingEpoch: body.bindingEpoch as number,
      storageId,
      evict: { disposition: 'none' },
    };
  }
  if (body.disposition === 'full') {
    return {
      status: 'updated',
      credentialRevision: body.credentialRevision as number,
      bindingEpoch: body.bindingEpoch as number,
      storageId,
      evict: { disposition: 'full', researcherId },
    };
  }
  if (body.disposition === 'scoped' && storageId) {
    return {
      status: 'updated',
      credentialRevision: body.credentialRevision as number,
      bindingEpoch: body.bindingEpoch as number,
      storageId,
      evict: { disposition: 'scoped', researcherId, storageId },
    };
  }
  return { status: 'unavailable' };
}

// CAS update used for credentials and onboarding state. It prevents a stale
// validation request from overwriting a credential rotation/clear that won a
// concurrent race. Origin change/clear while studies or live ops exist is a
// definite zero-write refusal. bindingEpoch increments only on origin change.
export async function updateResearcherCredentialsAtomic(
  id: string,
  expectedCredentialRevision: number,
  updates: CredentialPatch,
  origin?: CredentialOriginInput,
): Promise<CredentialMutationResult> {
  if (!isResearcherId(id) || !Number.isSafeInteger(expectedCredentialRevision) || expectedCredentialRevision < 0) {
    return { status: 'unavailable' };
  }
  const intent = inferCredentialIntent(updates, origin);
  if (intent === 'unavailable') return { status: 'unavailable' };

  let proposedStorageId = '';
  let proposedOriginHash = '';
  let proposedCipherSnapshot = '';
  if (intent === 'set') {
    if (!origin || typeof updates.encryptedRedisUrl !== 'string' || typeof updates.encryptedRedisToken !== 'string') {
      return { status: 'unavailable' };
    }
    proposedStorageId = origin.storageId;
    proposedOriginHash = origin.storageId;
    proposedCipherSnapshot = redisCipherSnapshot(updates.encryptedRedisUrl, updates.encryptedRedisToken);
  }

  const loaded = await loadResearcherStorageBinding(id);
  if (loaded.status === 'unavailable') return { status: 'unavailable' };
  const expectedStorageId = loaded.status === 'ok' ? loaded.binding.storageId : '';
  const expectedBindingEpoch = loaded.status === 'ok' ? String(loaded.binding.bindingEpoch) : '';
  const expectedCipherSnapshot = loaded.status === 'ok' ? loaded.binding.cipherSnapshot : '';
  const reverseOld = expectedStorageId || '_';
  const reverseNew = proposedStorageId || '_';

  try {
    const wire = await platform().eval(
      UPDATE_RESEARCHER_CREDENTIALS_SCRIPT,
      [
        `${key('researcher')}:${id}`,
        `${key('researcher-storage')}:${id}`,
        `${key('researcher-studies')}:${id}`,
        `${key('storage-researchers')}:${reverseOld}`,
        `${key('storage-researchers')}:${reverseNew}`,
        key('account-delete-journal'),
        key('study-ops:v2'),
      ],
      [
        id,
        String(expectedCredentialRevision),
        expectedStorageId,
        expectedBindingEpoch,
        expectedCipherSnapshot,
        intent,
        proposedStorageId,
        proposedOriginHash,
        proposedCipherSnapshot,
        JSON.stringify(updates),
        '1000',
      ],
    );
    return parseCredentialCasWire(wire, id);
  } catch (error) {
    if (error instanceof RedisCommitAmbiguousError) {
      return error.commitState === 'may-have-committed'
        ? { status: 'ambiguous' }
        : { status: 'unavailable' };
    }
    logRequestFailure({ event: 'platform.unavailable' }, error);
    return { status: 'unavailable' };
  }
}

// ============================================
// Study Ownership Mapping
// ============================================

export type StudyOperationKind = 'create' | 'delete';

export interface PendingStudyOperation {
  version: 1;
  id: string;
  kind: StudyOperationKind;
  researcherId: string;
  studyId: string;
  createdAt: number;
  updatedAt: number;
  // Phase 2 plumbing: minted create identity is passed through begin. v1 Lua
  // ignores these fields; Phase 3 registry will consume them.
  idempotencyHash?: string | null;
  fingerprint?: string | null;
}

const STUDY_OPERATION_ID_PATTERN = /^(create|delete):[A-Za-z0-9-]{1,128}$/;
const STUDY_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;
const RESEARCHER_ID_PATTERN = /^[A-Za-z0-9-]{1,256}$/;
const DEFAULT_MAXIMUM_PENDING_STUDY_OPERATIONS = 100;

function studyOperationId(kind: StudyOperationKind, studyId: string): string {
  return `${kind}:${studyId}`;
}

function asPendingStudyOperation(value: unknown): PendingStudyOperation | null {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const operation = parsed as PendingStudyOperation;
  if (
    operation.version !== 1
    || (operation.kind !== 'create' && operation.kind !== 'delete')
    || typeof operation.id !== 'string'
    || operation.id !== studyOperationId(operation.kind, operation.studyId)
    || !STUDY_OPERATION_ID_PATTERN.test(operation.id)
    || typeof operation.researcherId !== 'string'
    || !RESEARCHER_ID_PATTERN.test(operation.researcherId)
    || typeof operation.studyId !== 'string'
    || !STUDY_ID_PATTERN.test(operation.studyId)
    || !Number.isSafeInteger(operation.createdAt)
    || !Number.isSafeInteger(operation.updatedAt)
  ) {
    return null;
  }
  return operation;
}

function validStudyOperationIdentity(studyId: string, researcherId: string): boolean {
  return STUDY_ID_PATTERN.test(studyId) && RESEARCHER_ID_PATTERN.test(researcherId);
}

export type BeginCreateStudyOperationResult =
  | { status: 'started' | 'already-pending'; operation: PendingStudyOperation }
  | { status: 'study-quota-exceeded' | 'pending-quota-exceeded' }
  | { status: 'account-not-found' | 'owner-conflict' | 'operation-conflict' }
  | { status: 'invalid' | 'unavailable' };

// Atomically reserves hosted routing authority and records the cross-Redis
// create intent before researcher-controlled storage is touched. An unavailable
// response is deliberately ambiguous: callers must not write BYOS data because
// the platform operation may or may not have committed.
export type BeginCreateStudyOperationArgs = {
  idempotencyHash?: string | null;
  fingerprint?: string | null;
};

export async function beginCreateStudyOperation(
  studyId: string,
  researcherId: string,
  maximumStudies = 1_000,
  maximumPendingOperations = DEFAULT_MAXIMUM_PENDING_STUDY_OPERATIONS,
  beginArgs?: BeginCreateStudyOperationArgs,
): Promise<BeginCreateStudyOperationResult> {
  if (
    !validStudyOperationIdentity(studyId, researcherId)
    || maximumStudies < 1
    || maximumPendingOperations < 1
  ) {
    return { status: 'invalid' };
  }

  const now = Date.now();
  const operation: PendingStudyOperation = {
    version: 1,
    id: studyOperationId('create', studyId),
    kind: 'create',
    researcherId,
    studyId,
    createdAt: now,
    updatedAt: now,
    ...(beginArgs?.idempotencyHash !== undefined
      ? { idempotencyHash: beginArgs.idempotencyHash }
      : {}),
    ...(beginArgs?.fingerprint !== undefined
      ? { fingerprint: beginArgs.fingerprint }
      : {}),
  };
  const script = `
    if redis.call('EXISTS', KEYS[6]) == 0 then return -5 end

    local owner = redis.call('GET', KEYS[1])
    if owner and owner ~= ARGV[1] then return -1 end

    local lock = redis.call('GET', KEYS[5])
    if lock then
      if lock == ARGV[3] and redis.call('EXISTS', KEYS[3]) == 1 then return 0 end
      return -4
    end
    if redis.call('EXISTS', KEYS[3]) == 1 then return -4 end

    if not owner and redis.call('SCARD', KEYS[2]) >= tonumber(ARGV[4]) then return -2 end
    if redis.call('SCARD', KEYS[4]) >= tonumber(ARGV[5]) then return -3 end

    redis.call('SET', KEYS[1], ARGV[1])
    redis.call('SADD', KEYS[2], ARGV[2])
    redis.call('SET', KEYS[3], ARGV[6])
    redis.call('SADD', KEYS[4], ARGV[3])
    redis.call('SET', KEYS[5], ARGV[3])
    return 1
  `;

  try {
    const result = Number(await platform().eval(
      script,
      [
        `${key('study-owner')}:${studyId}`,
        `${key('researcher-studies')}:${researcherId}`,
        `${key('study-operation')}:${operation.id}`,
        `${key('study-operations')}:${researcherId}`,
        `${key('study-operation-lock')}:${studyId}`,
        `${key('researcher')}:${researcherId}`,
      ],
      [
        researcherId,
        studyId,
        operation.id,
        String(maximumStudies),
        String(maximumPendingOperations),
        JSON.stringify(operation),
      ]
    ));
    if (result === 1) return { status: 'started', operation };
    if (result === 0) return { status: 'already-pending', operation };
    if (result === -1) return { status: 'owner-conflict' };
    if (result === -2) return { status: 'study-quota-exceeded' };
    if (result === -3) return { status: 'pending-quota-exceeded' };
    if (result === -4) return { status: 'operation-conflict' };
    if (result === -5) return { status: 'account-not-found' };
    return { status: 'unavailable' };
  } catch (error) {
    logRequestFailure({ event: 'platform.unavailable' }, error);
    return { status: 'unavailable' };
  }
}

export type BeginDeleteStudyOperationResult =
  | { status: 'started' | 'already-pending'; operation: PendingStudyOperation }
  | { status: 'not-found' | 'pending-quota-exceeded' }
  | { status: 'account-not-found' | 'owner-conflict' | 'operation-conflict' }
  | { status: 'invalid' | 'unavailable' };

// Records delete intent while preserving routing authority. Authority is
// removed only after BYOS absence is known, either in the request or by the
// bounded reconciler.
export async function beginDeleteStudyOperation(
  studyId: string,
  researcherId: string,
  maximumPendingOperations = DEFAULT_MAXIMUM_PENDING_STUDY_OPERATIONS
): Promise<BeginDeleteStudyOperationResult> {
  if (!validStudyOperationIdentity(studyId, researcherId) || maximumPendingOperations < 1) {
    return { status: 'invalid' };
  }

  const now = Date.now();
  const operation: PendingStudyOperation = {
    version: 1,
    id: studyOperationId('delete', studyId),
    kind: 'delete',
    researcherId,
    studyId,
    createdAt: now,
    updatedAt: now,
  };
  const script = `
    if redis.call('EXISTS', KEYS[6]) == 0 then return -5 end

    local owner = redis.call('GET', KEYS[1])
    if not owner then return -1 end
    if owner ~= ARGV[1] then return -2 end

    local lock = redis.call('GET', KEYS[4])
    if lock then
      if lock == ARGV[3] and redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
      return -4
    end
    if redis.call('EXISTS', KEYS[2]) == 1 then return -4 end

    if redis.call('SCARD', KEYS[3]) >= tonumber(ARGV[4]) then return -3 end

    redis.call('SADD', KEYS[5], ARGV[2])
    redis.call('SET', KEYS[2], ARGV[5])
    redis.call('SADD', KEYS[3], ARGV[3])
    redis.call('SET', KEYS[4], ARGV[3])
    return 1
  `;

  try {
    const result = Number(await platform().eval(
      script,
      [
        `${key('study-owner')}:${studyId}`,
        `${key('study-operation')}:${operation.id}`,
        `${key('study-operations')}:${researcherId}`,
        `${key('study-operation-lock')}:${studyId}`,
        `${key('researcher-studies')}:${researcherId}`,
        `${key('researcher')}:${researcherId}`,
      ],
      [
        researcherId,
        studyId,
        operation.id,
        String(maximumPendingOperations),
        JSON.stringify(operation),
      ]
    ));
    if (result === 1) return { status: 'started', operation };
    if (result === 0) return { status: 'already-pending', operation };
    if (result === -1) return { status: 'not-found' };
    if (result === -2) return { status: 'owner-conflict' };
    if (result === -3) return { status: 'pending-quota-exceeded' };
    if (result === -4) return { status: 'operation-conflict' };
    if (result === -5) return { status: 'account-not-found' };
    return { status: 'unavailable' };
  } catch (error) {
    logRequestFailure({ event: 'platform.unavailable' }, error);
    return { status: 'unavailable' };
  }
}

export type StudyOperationResolution =
  | 'create-complete'
  | 'create-rollback'
  | 'delete-complete'
  | 'delete-rollback';

export type ResolveStudyOperationResult =
  | 'resolved'
  | 'already-resolved'
  | 'invalid'
  | 'operation-conflict'
  | 'owner-conflict'
  | 'unavailable';

// Applies one terminal transition atomically and removes the pending record.
// The operation record itself is authority for a rollback/finish, but every
// owner mutation still compares the expected researcher.
export async function resolveStudyOperation(
  operation: PendingStudyOperation,
  resolution: StudyOperationResolution
): Promise<ResolveStudyOperationResult> {
  const expectedKind = resolution.startsWith('create') ? 'create' : 'delete';
  if (asPendingStudyOperation(operation) === null || operation.kind !== expectedKind) {
    return 'invalid';
  }

  const script = `
    local raw = redis.call('GET', KEYS[3])
    if not raw then
      redis.call('SREM', KEYS[4], ARGV[3])
      if redis.call('GET', KEYS[5]) == ARGV[3] then redis.call('DEL', KEYS[5]) end
      return 0
    end

    local parsed = cjson.decode(raw)
    if parsed.id ~= ARGV[3]
      or parsed.researcherId ~= ARGV[1]
      or parsed.studyId ~= ARGV[2]
      or parsed.kind ~= ARGV[4] then return -1 end

    local lock = redis.call('GET', KEYS[5])
    if lock and lock ~= ARGV[3] then return -2 end
    local owner = redis.call('GET', KEYS[1])

    if ARGV[5] == 'create-complete' then
      if owner ~= ARGV[1] then return -3 end
      redis.call('SADD', KEYS[2], ARGV[2])
    elseif ARGV[5] == 'create-rollback' then
      if owner and owner ~= ARGV[1] then return -3 end
      if owner == ARGV[1] then
        redis.call('DEL', KEYS[1])
        redis.call('SREM', KEYS[2], ARGV[2])
      end
    elseif ARGV[5] == 'delete-complete' then
      if owner and owner ~= ARGV[1] then return -3 end
      if owner == ARGV[1] then
        redis.call('DEL', KEYS[1])
        redis.call('SREM', KEYS[2], ARGV[2])
      end
    elseif ARGV[5] == 'delete-rollback' then
      if owner ~= ARGV[1] then return -3 end
      redis.call('SADD', KEYS[2], ARGV[2])
    else
      return -1
    end

    redis.call('DEL', KEYS[3])
    redis.call('SREM', KEYS[4], ARGV[3])
    if not lock or lock == ARGV[3] then redis.call('DEL', KEYS[5]) end
    return 1
  `;

  try {
    const result = Number(await platform().eval(
      script,
      [
        `${key('study-owner')}:${operation.studyId}`,
        `${key('researcher-studies')}:${operation.researcherId}`,
        `${key('study-operation')}:${operation.id}`,
        `${key('study-operations')}:${operation.researcherId}`,
        `${key('study-operation-lock')}:${operation.studyId}`,
      ],
      [
        operation.researcherId,
        operation.studyId,
        operation.id,
        operation.kind,
        resolution,
      ]
    ));
    if (result === 1) return 'resolved';
    if (result === 0) return 'already-resolved';
    if (result === -1) return 'invalid';
    if (result === -2) return 'operation-conflict';
    if (result === -3) return 'owner-conflict';
    return 'unavailable';
  } catch (error) {
    logRequestFailure({ event: 'platform.unavailable' }, error);
    return 'unavailable';
  }
}

export type PendingStudyOperationLoadResult =
  | { status: 'ok'; operations: PendingStudyOperation[]; invalidCount: number }
  | { status: 'invalid' | 'unavailable' };

// Selects at most `maximum` pending operation IDs. The atomic cardinality guard
// refuses oversized imported/corrupt indexes, while SRANDMEMBER gives repeated
// bounded reconciliations a chance to progress across the whole set.
export async function getPendingStudyOperations(
  researcherId: string,
  maximum = 25
): Promise<PendingStudyOperationLoadResult> {
  if (!RESEARCHER_ID_PATTERN.test(researcherId) || maximum < 1 || maximum > 100) {
    return { status: 'invalid' };
  }
  try {
    const script = `
      if redis.call('SCARD', KEYS[1]) > tonumber(ARGV[2]) then
        return {'__index_too_large__'}
      end
      return redis.call('SRANDMEMBER', KEYS[1], tonumber(ARGV[1]))
    `;
    const rawIds = await platform().eval(
      script,
      [`${key('study-operations')}:${researcherId}`],
      [String(maximum), String(DEFAULT_MAXIMUM_PENDING_STUDY_OPERATIONS)]
    );
    const idList = Array.isArray(rawIds) ? rawIds.map(String) : [];
    if (idList.length === 1 && idList[0] === '__index_too_large__') {
      return { status: 'invalid' };
    }
    const ids = idList
      .filter(id => STUDY_OPERATION_ID_PATTERN.test(id))
      .slice(0, maximum);
    const rawOperations = await Promise.all(
      ids.map(id => platform().get<PendingStudyOperation | string>(`${key('study-operation')}:${id}`))
    );
    const operations: PendingStudyOperation[] = [];
    let invalidCount = idList.length - ids.length;
    rawOperations.forEach((raw) => {
      const operation = asPendingStudyOperation(raw);
      if (!operation || operation.researcherId !== researcherId) {
        invalidCount += 1;
        return;
      }
      operations.push(operation);
    });
    return { status: 'ok', operations, invalidCount };
  } catch (error) {
    logRequestFailure({ event: 'platform.unavailable' }, error);
    return { status: 'unavailable' };
  }
}

export type RegisterStudyOwnershipResult =
  | 'registered'
  | 'already-registered'
  | 'quota-exceeded'
  | 'owner-conflict'
  | 'unavailable';

export async function registerStudyOwnership(
  studyId: string,
  researcherId: string,
  maximumStudies = 1_000
): Promise<RegisterStudyOwnershipResult> {
  try {
    const script = `
      local existingOwner = redis.call('GET', KEYS[1])
      if existingOwner then
        if existingOwner ~= ARGV[1] then return -1 end
        redis.call('SADD', KEYS[2], ARGV[2])
        return 0
      end
      if redis.call('SCARD', KEYS[2]) >= tonumber(ARGV[3]) then return -2 end
      redis.call('SET', KEYS[1], ARGV[1])
      redis.call('SADD', KEYS[2], ARGV[2])
      return 1
    `;
    const result = Number(await platform().eval(
      script,
      [`${key('study-owner')}:${studyId}`, `${key('researcher-studies')}:${researcherId}`],
      [researcherId, studyId, String(maximumStudies)]
    ));
    if (result === 1) return 'registered';
    if (result === 0) return 'already-registered';
    if (result === -1) return 'owner-conflict';
    if (result === -2) return 'quota-exceeded';
    return 'unavailable';
  } catch (error) {
    logRequestFailure({ event: 'platform.unavailable' }, error);
    return 'unavailable';
  }
}

export async function getStudyOwner(studyId: string): Promise<string | null> {
  const result = await getStudyOwnerChecked(studyId);
  return result.status === 'found' ? result.researcherId : null;
}

export type StudyOwnerLoadResult =
  | { status: 'found'; researcherId: string }
  | { status: 'not-found' }
  | { status: 'unavailable' };

export async function getStudyOwnerChecked(studyId: string): Promise<StudyOwnerLoadResult> {
  try {
    const researcherId = await platform().get<string>(`${key('study-owner')}:${studyId}`);
    return researcherId ? { status: 'found', researcherId } : { status: 'not-found' };
  } catch (error) {
    logRequestFailure({ event: 'platform.unavailable' }, error);
    return { status: 'unavailable' };
  }
}

export type DeleteStudyOwnershipResult =
  | 'deleted'
  | 'not-found'
  | 'owner-conflict'
  | 'unavailable';

export async function deleteStudyOwnership(
  studyId: string,
  expectedResearcherId: string
): Promise<DeleteStudyOwnershipResult> {
  try {
    const script = `
      local owner = redis.call('GET', KEYS[1])
      if not owner then return 0 end
      if owner ~= ARGV[1] then return -1 end
      redis.call('SREM', ARGV[2] .. owner, ARGV[3])
      redis.call('DEL', KEYS[1])
      return 1
    `;
    const result = Number(await platform().eval(
      script,
      [`${key('study-owner')}:${studyId}`],
      [expectedResearcherId, `${key('researcher-studies')}:`, studyId]
    ));
    if (result === 1) return 'deleted';
    if (result === 0) return 'not-found';
    if (result === -1) return 'owner-conflict';
    return 'unavailable';
  } catch (error) {
    logRequestFailure({ event: 'platform.unavailable' }, error);
    return 'unavailable';
  }
}

export type { DeleteResearcherResult } from './platformDb.accountDelete';

// ============================================
// Helpers
// ============================================

// Convert full account to safe client-side profile
export function toResearcherProfile(account: ResearcherAccount): ResearcherProfile {
  return {
    id: account.id,
    email: account.email,
    name: account.name,
    avatarUrl: account.avatarUrl,
    onboardingComplete: account.onboardingComplete,
    hasRedisConfigured: !!account.encryptedRedisUrl,
    hasGeminiKey: !!account.encryptedGeminiApiKey,
    hasAnthropicKey: !!account.encryptedAnthropicApiKey,
    hasOpenAiKey: !!account.encryptedOpenAiApiKey,
    hasOpenRouterKey: !!account.encryptedOpenRouterApiKey,
  };
}
