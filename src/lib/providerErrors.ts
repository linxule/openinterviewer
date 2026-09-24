// Typed AI provider failures and deadline enforcement
// Provider calls never masquerade as success: routes map these failures to
// explicit non-200 responses (502 unavailable, 504 timeout) without exposing
// provider error bodies, credentials, or request data in responses. The HTTP
// mapping lives in providerErrorResponse.ts so this module stays free of
// Next imports (the Cloudflare Queue consumer bundles it).

import { logRequestFailure } from './requestLog';

// Failure classification (see providerErrorResponse for the wire mapping):
// - 'config': provider rejected the request itself (auth, invalid model, bad
//   request). Non-retryable — the request will keep failing until config changes.
// - 'rate-limited': provider is throttling (HTTP 429). Retryable.
// - 'unavailable': transient network/5xx provider-side failure. Retryable.
// - 'invalid-response': provider returned parseable but malformed output.
//   Retryable — the next attempt may produce well-formed output.
export type ProviderFailureKind =
  | 'unavailable'
  | 'rate-limited'
  | 'config'
  | 'invalid-response';

export class ProviderFailure extends Error {
  constructor(
    public readonly kind: ProviderFailureKind,
    message: string,
    cause?: unknown
  ) {
    super(message);
    this.name = 'ProviderFailure';
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

// Raised when a provider call exceeds its deadline (ours or the SDK's own).
export class ProviderTimeoutError extends Error {
  constructor(ms: number, message?: string) {
    super(message ?? `AI provider request exceeded deadline of ${ms}ms`);
    this.name = 'ProviderTimeoutError';
  }
}

const MAX_GATEWAY_BODY_CHARS = 4_096;

function gatewayErrorName(candidate: unknown): boolean {
  if (typeof candidate === 'string') {
    // A raw error body (OpenRouter keeps it as text). Parsed only to read its
    // `name`; never logged. Bounded so a large provider body is not parsed.
    if (candidate.length > MAX_GATEWAY_BODY_CHARS || !candidate.trimStart().startsWith('{')) return false;
    try {
      return gatewayErrorName(JSON.parse(candidate));
    } catch {
      return false;
    }
  }
  return typeof candidate === 'object'
    && candidate !== null
    && !Array.isArray(candidate)
    && (candidate as { name?: unknown }).name === 'AiGatewayError';
}

/**
 * Whether an SDK error carries a Cloudflare AI Gateway error body
 * (`{"name":"AiGatewayError","internalCode":…}`): the gateway answered
 * itself, before or instead of the provider (D12). Reads only the body's
 * `name`, never the message or any other member. Log-only: classification is
 * unchanged.
 */
export function isAiGatewayError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const record = err as { error?: unknown; body?: unknown; cause?: unknown };
  if (gatewayErrorName(record.error) || gatewayErrorName(record.body)) return true;
  const cause = record.cause;
  if (cause && typeof cause === 'object' && cause !== err) {
    const nested = cause as { error?: unknown; body?: unknown };
    return gatewayErrorName(nested.error) || gatewayErrorName(nested.body);
  }
  return false;
}

// Redacted provider failure logging: never log SDK error bodies, response
// payloads, prompts, keys, or user content — only the error type, status and,
// for an error AI Gateway answered itself, `origin: 'gateway'`.
export function logProviderFailure(provider: string, operation: string, err: unknown): void {
  const safe: {
    event: 'provider.failure';
    provider: string;
    operation: string;
    errorType: string;
    status?: number;
    origin?: 'gateway';
  } = {
    event: 'provider.failure',
    provider,
    operation,
    errorType: err instanceof Error ? err.name : 'UnknownError',
  };
  if (err && typeof err === 'object' && 'status' in err && typeof err.status === 'number') {
    safe.status = err.status;
  } else if (err && typeof err === 'object' && 'statusCode' in err && typeof err.statusCode === 'number') {
    safe.status = err.statusCode;
  }
  if (isAiGatewayError(err)) safe.origin = 'gateway';
  logRequestFailure(safe, err);
}

// HTTP-ish status extracted from any SDK error without reading its message or
// body (both may contain request data that must stay out of logs).
function errorStatus(err: unknown): number | undefined {
  if (err && typeof err === 'object' && 'status' in err && typeof err.status === 'number') {
    return err.status;
  }
  if (err && typeof err === 'object' && 'statusCode' in err && typeof err.statusCode === 'number') {
    return err.statusCode;
  }
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'number') return code;
  }
  return undefined;
}

// Detect SDK-native timeout/abort errors by type name or code only.
function isTimeoutLike(err: unknown): boolean {
  if (err instanceof ProviderTimeoutError) return true;
  if (errorStatus(err) === 408) return true;
  if (err && typeof err === 'object') {
    const name = (err as { name?: unknown }).name;
    if (typeof name === 'string' && /timeout|abort/i.test(name)) return true;
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && /timeout|abort/i.test(code)) return true;
  }
  return false;
}

// Classify a provider SDK error into a typed failure without leaking details.
// The returned messages are server-side only; clients receive generic copy
// built in providerErrorResponse.
export function classifyProviderError(
  provider: string,
  operation: string,
  err: unknown
): ProviderFailure | ProviderTimeoutError {
  if (err instanceof ProviderFailure || err instanceof ProviderTimeoutError) {
    return err;
  }
  if (isTimeoutLike(err)) {
    return new ProviderTimeoutError(0, `${provider} ${operation} timed out`);
  }
  const status = errorStatus(err);
  if (status !== undefined) {
    if (status === 429) {
      return new ProviderFailure('rate-limited', `${provider} ${operation} was rate limited`, err);
    }
    if (status === 400 || status === 401 || status === 402 || status === 403 || status === 404 || status === 422) {
      return new ProviderFailure('config', `${provider} ${operation} was rejected (configuration error)`, err);
    }
    if (status >= 500) {
      return new ProviderFailure('unavailable', `${provider} ${operation} failed`, err);
    }
  }
  return new ProviderFailure('unavailable', `${provider} ${operation} failed`, err);
}

// Log (redacted) then classify — the single entry point provider catch blocks use.
export function providerCallError(
  provider: string,
  operation: string,
  err: unknown
): ProviderFailure | ProviderTimeoutError {
  logProviderFailure(provider, operation, err);
  return classifyProviderError(provider, operation, err);
}

// Run a provider call under a hard deadline.
// The AbortSignal is passed through to the SDK so the in-flight request is
// cancelled where supported (Anthropic: `signal`; Gemini: `abortSignal`).
// SDK-native timeouts are also set where supported so requests cannot hang
// server-side even if the signal is ignored.
export async function withProviderDeadline<T>(
  deadlineMs: number,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ProviderTimeoutError(deadlineMs));
    }, deadlineMs);
  });
  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } catch (err) {
    if (err instanceof ProviderTimeoutError || controller.signal.aborted) {
      throw new ProviderTimeoutError(deadlineMs);
    }
    throw err;
  } finally {
    clearTimeout(timer!);
  }
}
