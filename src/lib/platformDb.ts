// Platform Database Access Layer (Hosted Mode Only)
// Stores researcher accounts, encrypted credentials, and study ownership
// Uses the platform host's own Upstash Redis instance

import { getPlatformClient } from './kvClient';
import { ResearcherAccount, ResearcherProfile } from '@/types';
import { normalizeEmail } from './email';

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

function asResearcherAccount(value: unknown): ResearcherAccount | null {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
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
    console.error('Error getting researcher:', error);
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
    console.error('Error getting researcher by OAuth:', error);
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
    console.error('Error getting researcher by email:', error);
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
    console.error('Error provisioning researcher:', error);
    return { status: 'unavailable' };
  }
}

export async function saveResearcher(researcher: ResearcherAccount): Promise<boolean> {
  try {
    const email = normalizeEmail(researcher.email);
    if (!email) return false;
    const p = platform();
    await p.set(`${key('researcher')}:${researcher.id}`, { ...researcher, email });
    await p.set(`${key('oauth')}:${researcher.oauthProvider}:${researcher.oauthId}`, researcher.id);
    await p.set(`${key('email')}:${email}`, researcher.id);
    await p.sadd(key('all-researchers'), researcher.id);
    return true;
  } catch (error) {
    console.error('Error saving researcher:', error);
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
    const result = await platform().eval<string[], number>(
      script,
      [`${key('researcher')}:${id}`],
      [JSON.stringify(updates)]
    );
    return Number(result) === 1;
  } catch (error) {
    console.error('Error updating researcher:', error);
    return false;
  }
}

export type CredentialMutationResult =
  | { status: 'updated'; credentialRevision: number }
  | { status: 'not-found' }
  | { status: 'conflict' }
  | { status: 'unavailable' };

export type PlatformRateLimitResult =
  | { status: 'allowed'; remaining: number }
  | { status: 'limited'; retryAfterSeconds: number }
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
    const result = await platform().eval<string[], [number, number]>(
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
    const allowed = Number(result?.[0]);
    const rejectedIndex = Number(result?.[1]);
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
    console.error('Error enforcing platform rate limits:', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
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
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const bucket = Math.floor(nowSeconds / windowSeconds);
  const retryAfterSeconds = windowSeconds - (nowSeconds % windowSeconds);
  const script = `
    local count = redis.call('INCR', KEYS[1])
    if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
    return count
  `;
  try {
    const count = Number(await platform().eval<string[], number>(
      script,
      [`${key('rate-limit')}:${operation}:${bucket}:${researcherId}`],
      [String(windowSeconds + 60)]
    ));
    if (!Number.isSafeInteger(count) || count < 1) return { status: 'unavailable' };
    if (count > maximum) return { status: 'limited', retryAfterSeconds };
    return { status: 'allowed', remaining: maximum - count };
  } catch (error) {
    console.error('Error enforcing platform rate limit:', error);
    return { status: 'unavailable' };
  }
}

type CredentialPatch = Partial<Pick<
  ResearcherAccount,
  | 'encryptedRedisUrl'
  | 'encryptedRedisToken'
  | 'encryptedGeminiApiKey'
  | 'encryptedAnthropicApiKey'
  | 'redisConfiguredAt'
  | 'onboardingComplete'
>>;

// CAS update used for credentials and onboarding state. It prevents a stale
// validation request from overwriting a credential rotation/clear that won a
// concurrent race.
export async function updateResearcherCredentialsAtomic(
  id: string,
  expectedCredentialRevision: number,
  updates: CredentialPatch
): Promise<CredentialMutationResult> {
  const script = `
    local raw = redis.call('GET', KEYS[1])
    if not raw then return -1 end
    local account = cjson.decode(raw)
    local current = tonumber(account.credentialRevision or 0)
    if current ~= tonumber(ARGV[1]) then return -2 end
    local patch = cjson.decode(ARGV[2])
    for field, value in pairs(patch) do
      account[field] = value
    end
    account.credentialRevision = current + 1
    redis.call('SET', KEYS[1], cjson.encode(account))
    return current + 1
  `;

  try {
    const result = Number(await platform().eval(
      script,
      [`${key('researcher')}:${id}`],
      [String(expectedCredentialRevision), JSON.stringify(updates)]
    ));
    if (result === -1) return { status: 'not-found' };
    if (result === -2) return { status: 'conflict' };
    if (!Number.isSafeInteger(result) || result < 1) return { status: 'unavailable' };
    return { status: 'updated', credentialRevision: result };
  } catch (error) {
    console.error('Error updating researcher credentials:', error);
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
export async function beginCreateStudyOperation(
  studyId: string,
  researcherId: string,
  maximumStudies = 1_000,
  maximumPendingOperations = DEFAULT_MAXIMUM_PENDING_STUDY_OPERATIONS
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
    console.error('Error beginning study create operation:', error);
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
    console.error('Error beginning study delete operation:', error);
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
    console.error('Error resolving study operation:', error);
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
    const rawIds = await platform().eval<string[], string[]>(
      script,
      [`${key('study-operations')}:${researcherId}`],
      [String(maximum), String(DEFAULT_MAXIMUM_PENDING_STUDY_OPERATIONS)]
    );
    if (rawIds.length === 1 && rawIds[0] === '__index_too_large__') {
      return { status: 'invalid' };
    }
    const ids = rawIds
      .map(String)
      .filter(id => STUDY_OPERATION_ID_PATTERN.test(id))
      .slice(0, maximum);
    const rawOperations = await Promise.all(
      ids.map(id => platform().get<PendingStudyOperation | string>(`${key('study-operation')}:${id}`))
    );
    const operations: PendingStudyOperation[] = [];
    let invalidCount = rawIds.length - ids.length;
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
    console.error('Error loading pending study operations:', error);
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
    console.error('Error registering study ownership:', error);
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
    console.error('Error getting study owner:', error);
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
    console.error('Error deleting study ownership:', error);
    return 'unavailable';
  }
}

export type DeleteResearcherResult =
  | { status: 'deleted'; detachedStudyCount: number }
  | { status: 'not-found' }
  | { status: 'too-many-records' }
  | { status: 'unavailable' };

// Deletes only platform-owned identity, indexes, encrypted credential records,
// and study-owner routing metadata. It intentionally never connects to or
// mutates the researcher's BYOS Redis database.
export async function deleteResearcherAccount(
  researcher: ResearcherAccount,
  maximumStudies = 1_000
): Promise<DeleteResearcherResult> {
  const script = `
    local raw = redis.call('GET', KEYS[1])
    if not raw then return {-1, 0} end
    local count = redis.call('SCARD', KEYS[5])
    local linkCount = redis.call('SCARD', KEYS[6])
    local operationCount = redis.call('SCARD', KEYS[7])
    if count > tonumber(ARGV[2])
      or linkCount > tonumber(ARGV[2])
      or operationCount > tonumber(ARGV[2]) then
      return {-2, count + linkCount + operationCount}
    end
    local studyIds = redis.call('SMEMBERS', KEYS[5])
    for _, studyId in ipairs(studyIds) do
      local ownerKey = ARGV[1] .. studyId
      if redis.call('GET', ownerKey) == ARGV[3] then
        redis.call('DEL', ownerKey)
      end
    end
    local participantLinkIds = redis.call('SMEMBERS', KEYS[6])
    for _, linkId in ipairs(participantLinkIds) do
      redis.call('DEL', ARGV[4] .. linkId)
    end
    local operationIds = redis.call('SMEMBERS', KEYS[7])
    for _, operationId in ipairs(operationIds) do
      local separator = string.find(operationId, ':', 1, true)
      if separator then
        local studyId = string.sub(operationId, separator + 1)
        local lockKey = ARGV[6] .. studyId
        if redis.call('GET', lockKey) == operationId then redis.call('DEL', lockKey) end
      end
      redis.call('DEL', ARGV[5] .. operationId)
    end
    if redis.call('GET', KEYS[2]) == ARGV[3] then redis.call('DEL', KEYS[2]) end
    if redis.call('GET', KEYS[3]) == ARGV[3] then redis.call('DEL', KEYS[3]) end
    redis.call('SREM', KEYS[4], ARGV[3])
    redis.call('DEL', KEYS[5])
    redis.call('DEL', KEYS[6])
    redis.call('DEL', KEYS[7])
    redis.call('DEL', KEYS[1])
    return {1, count}
  `;

  try {
    const result = await platform().eval<string[], [number, number]>(
      script,
      [
        `${key('researcher')}:${researcher.id}`,
        `${key('oauth')}:${researcher.oauthProvider}:${researcher.oauthId}`,
        `${key('email')}:${researcher.email}`,
        key('all-researchers'),
        `${key('researcher-studies')}:${researcher.id}`,
        `${key('participant-links')}:${researcher.id}`,
        `${key('study-operations')}:${researcher.id}`,
      ],
      [
        `${key('study-owner')}:`,
        String(maximumStudies),
        researcher.id,
        `${key('participant-link')}:`,
        `${key('study-operation')}:`,
        `${key('study-operation-lock')}:`,
      ]
    );
    const status = Number(result?.[0]);
    const count = Number(result?.[1] ?? 0);
    if (status === 1) return { status: 'deleted', detachedStudyCount: count };
    if (status === -1) return { status: 'not-found' };
    if (status === -2) return { status: 'too-many-records' };
    return { status: 'unavailable' };
  } catch (error) {
    console.error('Error deleting researcher account:', error);
    return { status: 'unavailable' };
  }
}

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
  };
}
