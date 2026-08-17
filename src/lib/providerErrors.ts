// Typed AI provider failures and deadline enforcement
// Provider calls never masquerade as success: routes map these failures to
// explicit non-200 responses (502 unavailable, 504 timeout) without exposing
// provider error bodies, credentials, or request data in responses.

import { NextResponse } from 'next/server';
import { logRequestFailure, wasErrorLogged } from './requestLog';

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

// Redacted provider failure logging: never log SDK error bodies, response
// payloads, prompts, keys, or user content — only the error type and status.
export function logProviderFailure(provider: string, operation: string, err: unknown): void {
  const safe: {
    event: 'provider.failure';
    provider: string;
    operation: string;
    errorType: string;
    status?: number;
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

// Map a provider failure to a safe, honest JSON error response.
// Messages are generic on purpose: they never echo provider details.
export function providerErrorResponse(err: unknown): NextResponse {
  if (err instanceof ProviderTimeoutError) {
    return NextResponse.json(
      { error: 'The AI provider took too long to respond. Please try again.', retryable: true },
      { status: 504 }
    );
  }
  if (err instanceof ProviderFailure) {
    switch (err.kind) {
      case 'config':
        return NextResponse.json(
          {
            error: 'The AI provider rejected the request. Please check the provider configuration and try again.',
            retryable: false,
          },
          { status: 502 }
        );
      case 'rate-limited':
        return NextResponse.json(
          { error: 'The AI provider is receiving too many requests right now. Please try again shortly.', retryable: true },
          { status: 503 }
        );
      case 'invalid-response':
        return NextResponse.json(
          { error: 'The AI provider returned an invalid response. Please try again.', retryable: true },
          { status: 502 }
        );
      case 'unavailable':
        return NextResponse.json(
          { error: 'The AI provider is temporarily unavailable. Please try again.', retryable: true },
          { status: 502 }
        );
    }
  }
  if (!wasErrorLogged(err)) {
    logRequestFailure({
      event: 'route.failure',
      route: 'provider',
      errorType: err instanceof Error ? err.name : 'UnknownError',
    }, err);
  }
  return NextResponse.json({ error: 'Failed to generate response' }, { status: 500 });
}
