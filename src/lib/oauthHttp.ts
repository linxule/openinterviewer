// Bounded upstream fetches for OAuth identity endpoints.
// Timeouts, size caps, and refused redirects keep callbacks fail-closed.

export const OAUTH_FETCH_TIMEOUT_MS = 8_000;
export const OAUTH_FETCH_MAX_BYTES = 64 * 1024;

export type BoundedFetchErrorCode = 'timeout' | 'too_large' | 'http' | 'network' | 'invalid_json';

export class BoundedFetchError extends Error {
  readonly code: BoundedFetchErrorCode;

  constructor(code: BoundedFetchErrorCode, message = 'Bounded fetch failed') {
    super(message);
    this.name = 'BoundedFetchError';
    this.code = code;
  }
}

export async function fetchJsonBounded<T>(
  url: string,
  init: RequestInit = {},
  limits: { timeoutMs?: number; maxBytes?: number } = {}
): Promise<T> {
  const timeoutMs = limits.timeoutMs ?? OAUTH_FETCH_TIMEOUT_MS;
  const maxBytes = limits.maxBytes ?? OAUTH_FETCH_MAX_BYTES;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      redirect: 'error',
    });

    if (!response.ok) {
      throw new BoundedFetchError('http', 'Upstream identity request failed');
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength && Number(contentLength) > maxBytes) {
      throw new BoundedFetchError('too_large', 'Upstream identity response is too large');
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw new BoundedFetchError('too_large', 'Upstream identity response is too large');
    }

    try {
      return JSON.parse(new TextDecoder().decode(buffer)) as T;
    } catch {
      throw new BoundedFetchError('invalid_json', 'Upstream identity response is not JSON');
    }
  } catch (error) {
    if (error instanceof BoundedFetchError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new BoundedFetchError('timeout', 'Upstream identity request timed out');
    }
    throw new BoundedFetchError('network', 'Upstream identity request failed');
  } finally {
    clearTimeout(timeout);
  }
}
