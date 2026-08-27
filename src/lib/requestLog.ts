// Allowlisted structured request logging (ADR-003).
// Stdout JSON only. Never print prompts, bodies, cookies, tokens, handles,
// keys, Redis URLs, error messages, stacks, or provider payloads.

export const REQUEST_LOG_ALLOWLIST = [
  'ts',
  'event',
  'requestId',
  'route',
  'method',
  'mode',
  'status',
  'errorType',
  'provider',
  'operation',
  'retryable',
  'reason',
  'durationMs',
  'refsOffered',
  'refsLocated',
] as const;

export const REQUEST_LOG_EVENT_ALLOWLIST = [
  'provider.failure',
  'kv.unavailable',
  'platform.unavailable',
  'route.failure',
  'synthesis.evidence',
] as const;

export const REQUEST_LOG_REASON_ALLOWLIST = [
  'schema-hold',
  'unavailable',
  'not-configured',
  'STUDY_OPERATION_PENDING',
  'ambiguous',
  'not-found',
  'expired',
  'revoked',
  'owner-conflict',
  'mutation-cancelled',
  'too-large',
  'invalid',
] as const;

export type RequestLogField = (typeof REQUEST_LOG_ALLOWLIST)[number];
export type RequestLogEventName = (typeof REQUEST_LOG_EVENT_ALLOWLIST)[number];
export type RequestLogReason = (typeof REQUEST_LOG_REASON_ALLOWLIST)[number];
export type RequestLogEvent = Partial<Record<RequestLogField, string | number | boolean>> & {
  event: string;
};

const FIELD_ALLOWLIST = new Set<string>(REQUEST_LOG_ALLOWLIST);
const EVENT_ALLOWLIST = new Set<string>(REQUEST_LOG_EVENT_ALLOWLIST);
const REASON_ALLOWLIST = new Set<string>(REQUEST_LOG_REASON_ALLOWLIST);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const loggedErrors = new WeakSet<object>();

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'boolean' || isFiniteNumber(value);
}

export function createRequestId(presented?: string | null): string {
  const candidate = typeof presented === 'string' ? presented.trim() : '';
  if (candidate && UUID_V4.test(candidate)) return candidate;
  return crypto.randomUUID();
}

export function markErrorLogged(err: unknown): void {
  if (isObject(err)) loggedErrors.add(err);
}

export function wasErrorLogged(err: unknown): boolean {
  return isObject(err) && loggedErrors.has(err);
}

export function errorTypeOf(err: unknown): string {
  return err instanceof Error ? err.name : 'UnknownError';
}

function sanitizeField(field: string, value: unknown): string | number | boolean | undefined {
  if (!FIELD_ALLOWLIST.has(field) || !isPrimitive(value)) return undefined;
  if (field === 'event') {
    return typeof value === 'string' && EVENT_ALLOWLIST.has(value) ? value : undefined;
  }
  if (field === 'reason') {
    return typeof value === 'string' && REASON_ALLOWLIST.has(value) ? value : undefined;
  }
  if (field === 'requestId') {
    return typeof value === 'string' && UUID_V4.test(value) ? value : undefined;
  }
  if (field === 'status' || field === 'durationMs' || field === 'ts') {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }
  if (field === 'refsOffered' || field === 'refsLocated') {
    // Counts only, ever (ADR-003): a string here could carry participant speech.
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }
  return value;
}

export function logRequestEvent(event: RequestLogEvent): boolean {
  const payload: Partial<Record<RequestLogField, string | number | boolean>> = {};
  for (const field of REQUEST_LOG_ALLOWLIST) {
    if (field === 'ts') continue;
    if (!Object.prototype.hasOwnProperty.call(event, field)) continue;
    const sanitized = sanitizeField(field, event[field]);
    if (sanitized !== undefined) payload[field] = sanitized;
  }
  if (typeof payload.event !== 'string') return false;
  const ts = sanitizeField('ts', event.ts);
  payload.ts = ts ?? Date.now();
  console.error(JSON.stringify(payload));
  return true;
}

export function logRequestFailure(event: RequestLogEvent, err?: unknown): boolean {
  if (err !== undefined && wasErrorLogged(err)) return false;
  const emitted = logRequestEvent({
    ...event,
    errorType: event.errorType ?? (err !== undefined ? errorTypeOf(err) : undefined),
  });
  if (emitted && err !== undefined) markErrorLogged(err);
  return emitted;
}
