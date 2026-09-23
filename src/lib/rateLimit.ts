import { createHmac } from 'crypto';
import type { RedisPort } from './redisPort';
import { NextResponse } from 'next/server';
import { logRequestEvent, logRequestFailure } from './requestLog';
import { nodeForwardedAddress } from './runtime/clientAddress';
import { resolveDeploymentTarget } from './runtime/target';
import {
  currentWorkerInvocation,
  isWorkerRuntime,
  type AdmissionIdentity,
} from './runtime/workerInvocation';
import type { AdmissionOutcome, WorkspaceStorePort } from './storage/types';

type ParticipantOperation = 'greeting' | 'interview' | 'save';

type ParticipantAuthority = { sessionId?: string; linkId?: string; researcherId?: string | null };

type Limit = {
  scope: 'client' | 'session' | 'link' | 'study' | 'researcher';
  maximum: number;
  windowSeconds: number;
};

export type ParticipantRateLimitCounter = {
  key: string;
  maximum: number;
  windowSeconds: number;
};

export type PersistRatePlanRow = {
  key: string;
  maximum: number;
  windowSeconds: number;
  windowStart: number;
};

const LIMITS: Record<ParticipantOperation, Limit[]> = {
  greeting: [
    { scope: 'session', maximum: 3, windowSeconds: 600 },
    { scope: 'client', maximum: 20, windowSeconds: 60 },
    { scope: 'study', maximum: 2_000, windowSeconds: 86_400 },
  ],
  interview: [
    { scope: 'session', maximum: 60, windowSeconds: 3_600 },
    { scope: 'client', maximum: 60, windowSeconds: 3_600 },
    { scope: 'link', maximum: 2_000, windowSeconds: 86_400 },
    { scope: 'study', maximum: 5_000, windowSeconds: 86_400 },
    { scope: 'researcher', maximum: 10_000, windowSeconds: 86_400 },
  ],
  save: [
    { scope: 'session', maximum: 2, windowSeconds: 86_400 },
    { scope: 'client', maximum: 20, windowSeconds: 3_600 },
    { scope: 'link', maximum: 1_000, windowSeconds: 86_400 },
    { scope: 'study', maximum: 2_000, windowSeconds: 86_400 },
  ],
};

// Check every scope before mutating any of them. Redis executes this script
// atomically, so a rejected request never burns a narrower budget first.
const CONSUME_LIMITS_SCRIPT = `
for i = 1, #KEYS do
  local maximum = tonumber(ARGV[(i - 1) * 2 + 1])
  local count = tonumber(redis.call('GET', KEYS[i]) or '0')
  if count >= maximum then
    local ttl = redis.call('TTL', KEYS[i])
    return {0, i, ttl}
  end
end

for i = 1, #KEYS do
  local window = tonumber(ARGV[(i - 1) * 2 + 2])
  local count = redis.call('INCR', KEYS[i])
  if count == 1 then redis.call('EXPIRE', KEYS[i], window) end
end

return {1, 0, 0}
`;

/** The one client bucket shared by every request without a usable address. */
const UNKNOWN_CLIENT_ADDRESS = 'unknown';

/** Same floor the Cloudflare workspace store applies to RATE_LIMIT_SALT. */
const MIN_CLOUDFLARE_SALT_LENGTH = 32;

/**
 * Participant admission cannot establish a trustworthy client subject.
 * `subrequest`: a Workers subrequest reached a participant limiter (routes
 * refuse these first; this is the fail-closed backstop). `salt-missing`: the
 * Cloudflare target has no usable RATE_LIMIT_SALT. `invalid-target`: the
 * deployment target is not a supported value.
 */
export class ParticipantAdmissionError extends Error {
  constructor(readonly reason: 'subrequest' | 'salt-missing' | 'invalid-target') {
    super(`Participant admission refused: ${reason}`);
    this.name = 'ParticipantAdmissionError';
  }
}

function isCloudflareAdmission(): boolean {
  if (isWorkerRuntime()) return true;
  const target = resolveDeploymentTarget();
  if (!target.ok) throw new ParticipantAdmissionError('invalid-target');
  return target.target === 'cloudflare';
}

function nodeRateLimitSalt(): string {
  return process.env.RATE_LIMIT_SALT
    || process.env.PARTICIPANT_TOKEN_SECRET
    || 'openinterviewer-rate-limit';
}

// Cloudflare has no fallback chain: a missing salt fails closed rather than
// keying budgets with another secret or a public constant.
function cloudflareRateLimitSalt(): string {
  const fromInvocation = currentWorkerInvocation()?.env.RATE_LIMIT_SALT;
  const salt = typeof fromInvocation === 'string' ? fromInvocation : process.env.RATE_LIMIT_SALT;
  if (typeof salt !== 'string' || salt.length < MIN_CLOUDFLARE_SALT_LENGTH) {
    throw new ParticipantAdmissionError('salt-missing');
  }
  return salt;
}

const reportedInvocations = new WeakSet<object>();

function reportUnusableIdentity(
  invocation: object | null,
  identity: AdmissionIdentity | null,
  operation: ParticipantOperation,
): void {
  if (invocation) {
    if (reportedInvocations.has(invocation)) return;
    reportedInvocations.add(invocation);
  }
  logRequestEvent({
    event: 'admission.identity',
    reason: identity?.kind === 'unknown' && identity.reason === 'invalid'
      ? 'identity-invalid'
      : 'identity-missing',
    operation,
  });
}

type AdmissionSubject = { salt: string; address: string };

function admissionSubject(request: Request, operation: ParticipantOperation): AdmissionSubject {
  if (!isCloudflareAdmission()) {
    return { salt: nodeRateLimitSalt(), address: nodeForwardedAddress(request.headers) };
  }
  const salt = cloudflareRateLimitSalt();
  const invocation = currentWorkerInvocation();
  const identity = invocation?.identity ?? null;
  if (identity?.kind === 'address') return { salt, address: identity.address };
  if (identity?.kind === 'subrequest') throw new ParticipantAdmissionError('subrequest');
  reportUnusableIdentity(invocation, identity, operation);
  return { salt, address: UNKNOWN_CLIENT_ADDRESS };
}

function clientIdentity(subject: AdmissionSubject): string {
  return createHmac('sha256', subject.salt).update(subject.address).digest('hex').slice(0, 24);
}

/**
 * True when the current Cloudflare invocation arrived as a Workers
 * subrequest. Participant greeting/interview/save refuse these before any
 * provider use or persistence. Always false on Node.
 */
export function isSubrequestAdmission(): boolean {
  return currentWorkerInvocation()?.identity?.kind === 'subrequest';
}

function subrequestRefusalResponse(operation?: ParticipantOperation): NextResponse {
  logRequestEvent({
    event: 'admission.identity',
    reason: 'subrequest-rejected',
    ...(operation ? { operation } : {}),
  });
  return NextResponse.json(
    { error: 'Participant requests must come directly from a browser.', retryable: false },
    { status: 403 }
  );
}

/** The 403 a participant route returns for a subrequest, or null to proceed. */
export function participantAdmissionRefusal(operation?: ParticipantOperation): NextResponse | null {
  return isSubrequestAdmission() ? subrequestRefusalResponse(operation) : null;
}

function saveLimitSubject(
  limit: Limit,
  studyId: string,
  identity: string,
  authority: ParticipantAuthority
): string | null {
  if (limit.scope === 'client') return `${studyId}:${identity}`;
  if (limit.scope === 'session') return authority.sessionId ?? null;
  if (limit.scope === 'link') return authority.linkId ?? null;
  if (limit.scope === 'researcher') return authority.researcherId ?? studyId;
  return studyId;
}

/**
 * Frozen save-admission plan rows. Finish ZADDs `interviewId` on
 * `interview-rate:{planId}:{windowStart}` with score 1 and EXPIRE window+60.
 * planId is HMAC-SHA-256 of the salted scope subject so client IPs never appear
 * in Redis keys. Salt is unchanged from the request limiter.
 */
export function getSavePersistRatePlan(
  request: Request,
  studyId: string,
  authority: ParticipantAuthority = {},
  nowMs: number = Date.now()
): PersistRatePlanRow[] | null {
  const subject = admissionSubject(request, 'save');
  const identity = clientIdentity(subject);
  const nowSeconds = Math.floor(nowMs / 1000);
  const rows: PersistRatePlanRow[] = [];

  for (const limit of LIMITS.save) {
    const scopeSubject = saveLimitSubject(limit, studyId, identity, authority);
    if (!scopeSubject) return null;
    const planId = createHmac('sha256', subject.salt)
      .update(`save:${limit.scope}:${limit.windowSeconds}:${scopeSubject}`)
      .digest('hex');
    const windowStart = Math.floor(nowSeconds / limit.windowSeconds) * limit.windowSeconds;
    rows.push({
      key: `interview-rate:${planId}:${windowStart}`,
      maximum: limit.maximum,
      windowSeconds: limit.windowSeconds,
      windowStart,
    });
  }

  return rows;
}

export type ParticipantLimitDecision =
  | { allowed: true }
  | { allowed: false; rejectedIndex: number; retryAfterSeconds: number };

/**
 * Check every counter, then charge every counter, in one Redis script.
 * `rejectedIndex` is the 0-based position of the first exhausted counter.
 * Throws on transport failure or a malformed reply (callers fail closed).
 */
export async function consumeParticipantRateLimits(
  client: RedisPort,
  counters: ParticipantRateLimitCounter[]
): Promise<ParticipantLimitDecision> {
  const keys = counters.map(counter => counter.key);
  const args = counters.flatMap(counter => [String(counter.maximum), String(counter.windowSeconds)]);
  const reply = await client.eval(CONSUME_LIMITS_SCRIPT, keys, args);
  if (!Array.isArray(reply)) throw new Error('Malformed participant limiter reply');
  const [allowed, rejectedIndex, ttl] = reply as unknown[];
  if (allowed === 1) return { allowed: true };
  if (
    typeof rejectedIndex !== 'number'
    || !Number.isInteger(rejectedIndex)
    || rejectedIndex < 1
    || rejectedIndex > counters.length
  ) {
    throw new Error('Malformed participant limiter reply');
  }
  const rejected = counters[rejectedIndex - 1];
  const retryAfterSeconds = Math.max(
    1,
    typeof ttl === 'number' && ttl > 0 ? ttl : rejected.windowSeconds
  );
  return { allowed: false, rejectedIndex: rejectedIndex - 1, retryAfterSeconds };
}

function limiterUnavailableResponse(): NextResponse {
  return NextResponse.json(
    { error: 'Unable to verify request limits. Please try again later.', retryable: true },
    { status: 503 }
  );
}

/** HTTP mapping shared by every participant admission path (Redis or durable). */
export function participantAdmissionResponse(outcome: AdmissionOutcome): NextResponse | null {
  if (outcome.status === 'admitted') return null;
  if (outcome.status === 'limited') {
    return NextResponse.json(
      { error: 'Too many AI requests. Please wait before trying again.', retryable: true },
      { status: 429, headers: { 'Retry-After': String(outcome.retryAfterSeconds) } }
    );
  }
  return limiterUnavailableResponse();
}

function incompleteAuthorityResponse(): NextResponse {
  return NextResponse.json(
    { error: 'Participant request authority is incomplete.' },
    { status: 401 }
  );
}

function admissionErrorResponse(
  error: unknown,
  operation: ParticipantOperation,
  failureEvent: 'kv.unavailable' | 'workspace.store' = 'kv.unavailable',
): NextResponse {
  if (error instanceof ParticipantAdmissionError) {
    if (error.reason === 'subrequest') return subrequestRefusalResponse(operation);
    logRequestEvent({ event: 'route.failure', reason: 'not-configured', operation, status: 503 });
  } else {
    logRequestFailure({ event: failureEvent, operation }, error);
  }
  return limiterUnavailableResponse();
}

async function participantAdmission(
  request: Request,
  studyId: string,
  operation: ParticipantOperation,
  authority: ParticipantAuthority,
  admit: (counters: ParticipantRateLimitCounter[]) => Promise<AdmissionOutcome>,
  failureEvent: 'kv.unavailable' | 'workspace.store',
): Promise<NextResponse | null> {
  try {
    const counters = getParticipantRateLimitCounters(request, studyId, operation, authority);
    if (!counters) return incompleteAuthorityResponse();
    return participantAdmissionResponse(await admit(counters));
  } catch (error) {
    return admissionErrorResponse(error, operation, failureEvent);
  }
}

export async function participantRateLimitResponse(
  request: Request,
  studyId: string,
  operation: ParticipantOperation,
  client: RedisPort,
  authority: ParticipantAuthority = {}
): Promise<NextResponse | null> {
  return participantAdmission(request, studyId, operation, authority, async (counters) => {
    const decision = await consumeParticipantRateLimits(client, counters);
    return decision.allowed
      ? { status: 'admitted' }
      : { status: 'limited', rejectedIndex: decision.rejectedIndex, retryAfterSeconds: decision.retryAfterSeconds };
  }, 'kv.unavailable');
}

/**
 * Greeting/interview admission through a workspace store (the durable store on
 * Cloudflare). Same responses as participantRateLimitResponse: 401 incomplete
 * authority, 403 subrequest, 503 missing salt or unusable store, 429 limited.
 */
export async function participantStoreAdmissionResponse(
  request: Request,
  studyId: string,
  operation: 'greeting' | 'interview',
  store: Pick<WorkspaceStorePort, 'admitParticipantRequest'>,
  authority: ParticipantAuthority = {},
  now: number = Date.now(),
): Promise<NextResponse | null> {
  return participantAdmission(
    request,
    studyId,
    operation,
    authority,
    (counters) => store.admitParticipantRequest({ operation, counters, now }),
    'workspace.store',
  );
}

export type SavePersistRatePlanDecision =
  | { status: 'planned'; rows: PersistRatePlanRow[] }
  | { status: 'refused'; response: NextResponse };

/**
 * getSavePersistRatePlan with the participant admission refusals mapped to
 * responses (401 incomplete authority, 403 subrequest, 503 missing salt or
 * unsupported target) instead of thrown, for routes that persist through a
 * workspace store.
 */
export function savePersistRatePlanOrResponse(
  request: Request,
  studyId: string,
  authority: ParticipantAuthority = {},
  nowMs: number = Date.now()
): SavePersistRatePlanDecision {
  let rows: PersistRatePlanRow[] | null;
  try {
    rows = getSavePersistRatePlan(request, studyId, authority, nowMs);
  } catch (error) {
    if (!(error instanceof ParticipantAdmissionError)) throw error;
    return { status: 'refused', response: admissionErrorResponse(error, 'save') };
  }
  if (!rows) return { status: 'refused', response: incompleteAuthorityResponse() };
  return { status: 'planned', rows };
}

export function getParticipantRateLimitCounters(
  request: Request,
  studyId: string,
  operation: ParticipantOperation,
  authority: ParticipantAuthority = {}
): ParticipantRateLimitCounter[] | null {
  const identity = clientIdentity(admissionSubject(request, operation));
  const counters: ParticipantRateLimitCounter[] = [];

  for (const limit of LIMITS[operation]) {
    const subject = limit.scope === 'client'
      ? `${studyId}:${identity}`
      : limit.scope === 'session'
        ? authority.sessionId
        : limit.scope === 'link'
          ? authority.linkId
          : limit.scope === 'researcher'
            ? authority.researcherId ?? studyId
            : studyId;
    if (!subject) return null;
    counters.push({
      key: `rate-limit:${operation}:${limit.scope}:${limit.windowSeconds}:${subject}`,
      maximum: limit.maximum,
      windowSeconds: limit.windowSeconds,
    });
  }

  return counters;
}
