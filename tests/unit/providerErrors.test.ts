// @vitest-environment node

import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  ProviderFailure,
  ProviderTimeoutError,
  classifyProviderError,
  providerCallError,
  providerErrorResponse,
  withProviderDeadline,
} from '@/lib/providerErrors';

afterEach(() => {
  vi.useRealTimers();
});

describe('withProviderDeadline', () => {
  it('resolves when the operation completes before the deadline', async () => {
    const result = await withProviderDeadline(5000, () => Promise.resolve('ok'));
    expect(result).toBe('ok');
  });

  it('propagates non-timeout operation errors unchanged', async () => {
    const boom = new Error('boom');
    await expect(withProviderDeadline(5000, () => Promise.reject(boom))).rejects.toBe(boom);
  });

  it('enforces a hard deadline even when the operation never resolves and ignores abort', async () => {
    vi.useFakeTimers();
    const onAbort = vi.fn();
    const promise = withProviderDeadline(5000, signal => {
      signal.addEventListener('abort', onAbort);
      return new Promise<never>(() => {}); // never settles, ignores the signal
    });
    const rejection = promise.then(
      () => {
        throw new Error('expected rejection');
      },
      err => err
    );

    vi.advanceTimersByTime(4999);
    await Promise.resolve();
    expect(await Promise.race([rejection, Promise.resolve('pending')])).toBe('pending');
    expect(onAbort).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(await rejection).toBeInstanceOf(ProviderTimeoutError);
  });

  it('converts an in-flight operation that fails due to signal abort into ProviderTimeoutError', async () => {
    vi.useFakeTimers();
    const promise = withProviderDeadline(5000, signal =>
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      })
    );
    const rejection = promise.then(
      () => {
        throw new Error('expected rejection');
      },
      err => err
    );

    vi.advanceTimersByTime(5000);
    expect(await rejection).toBeInstanceOf(ProviderTimeoutError);
  });
});

describe('classifyProviderError', () => {
  it.each([
    [400, 'config'],
    [401, 'config'],
    [402, 'config'],
    [403, 'config'],
    [404, 'config'],
    [422, 'config'],
  ])('maps HTTP %s to a non-retryable config failure', (status, kind) => {
    const failure = classifyProviderError('gemini', 'interview', { status });
    expect(failure).toBeInstanceOf(ProviderFailure);
    expect((failure as ProviderFailure).kind).toBe(kind);
  });

  it('maps HTTP 429 to a retryable rate-limited failure', () => {
    const failure = classifyProviderError('gemini', 'interview', { status: 429 }) as ProviderFailure;
    expect(failure.kind).toBe('rate-limited');
  });

  it.each([500, 502, 503, 504])('maps HTTP %s to an unavailable failure', status => {
    const failure = classifyProviderError('gemini', 'interview', { status }) as ProviderFailure;
    expect(failure.kind).toBe('unavailable');
  });

  it('maps a network error without a status to unavailable', () => {
    const failure = classifyProviderError('gemini', 'interview', new Error('fetch failed')) as ProviderFailure;
    expect(failure.kind).toBe('unavailable');
  });

  it('maps SDK-native timeout errors to ProviderTimeoutError', () => {
    const anthropicTimeout = classifyProviderError('claude', 'interview', {
      name: 'APIConnectionTimeoutError',
      status: 408,
    });
    expect(anthropicTimeout).toBeInstanceOf(ProviderTimeoutError);

    const geminiAbort = classifyProviderError('gemini', 'interview', {
      name: 'AbortError',
      code: 'ABORTED',
    });
    expect(geminiAbort).toBeInstanceOf(ProviderTimeoutError);
  });

  it('passes already-typed failures through unchanged', () => {
    const failure = new ProviderFailure('invalid-response', 'already typed');
    expect(classifyProviderError('gemini', 'interview', failure)).toBe(failure);

    const timeout = new ProviderTimeoutError(1000);
    expect(classifyProviderError('gemini', 'interview', timeout)).toBe(timeout);
  });
});

describe('providerCallError', () => {
  it('logs a redacted entry and classifies', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const raw = new (class extends Error {
      status = 429;
      constructor() {
        super('rate limit exceeded, api key sk-abc123, retry after 10s');
      }
    })();

    const failure = providerCallError('gemini', 'interview', raw);

    expect(failure).toBeInstanceOf(ProviderFailure);
    expect((failure as ProviderFailure).kind).toBe('rate-limited');
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(errorSpy.mock.calls[0][0]))).toMatchObject({
      event: 'provider.failure',
      provider: 'gemini',
      operation: 'interview',
      errorType: 'Error',
      status: 429,
    });
    // Never leak SDK error messages, bodies, or keys into logs.
    expect(JSON.stringify(errorSpy.mock.calls[0])).not.toContain('sk-abc123');
  });

  it('does not emit a second log when providerErrorResponse handles the classified failure', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const raw = Object.assign(new Error('secret provider body sk-abc123'), { status: 502 });
    const failure = providerCallError('gemini', 'interview', raw);
    const response = providerErrorResponse(failure);
    expect(response.status).toBe(502);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('sk-abc123');
    errorSpy.mockRestore();
  });
});

describe('providerErrorResponse', () => {
  it.each([
    [new ProviderTimeoutError(1000), 504, true],
    [new ProviderFailure('unavailable', 'x'), 502, true],
    [new ProviderFailure('invalid-response', 'x'), 502, true],
    [new ProviderFailure('rate-limited', 'x'), 503, true],
    [new ProviderFailure('config', 'x'), 502, false],
  ])('maps %o to status %s retryable %s', async (err, status, retryable) => {
    const response = providerErrorResponse(err);
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body.retryable).toBe(retryable);
    expect(typeof body.error).toBe('string');
  });

  it('returns 500 for unexpected errors without echoing their message', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = providerErrorResponse(new Error('secret provider detail'));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe('Failed to generate response');
    expect(JSON.stringify(body)).not.toContain('secret provider detail');
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(errorSpy.mock.calls[0][0])) as { event: string; route: string };
    expect(payload).toMatchObject({ event: 'route.failure', route: 'provider', errorType: 'Error' });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('secret provider detail');
    errorSpy.mockRestore();
  });

  it('keeps all client messages generic', async () => {
    const responses = [
      new ProviderTimeoutError(1000),
      new ProviderFailure('unavailable', 'internal detail'),
      new ProviderFailure('invalid-response', 'internal detail'),
      new ProviderFailure('rate-limited', 'internal detail'),
      new ProviderFailure('config', 'internal detail'),
    ];
    for (const err of responses) {
      const body = await providerErrorResponse(err).json();
      expect(JSON.stringify(body)).not.toContain('internal detail');
    }
  });
});
