// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoundedFetchError, fetchJsonBounded } from '@/lib/oauthHttp';

describe('fetchJsonBounded', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects oversized responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: (name: string) => name === 'content-length' ? '999999' : null },
      arrayBuffer: async () => new ArrayBuffer(8),
    }));

    await expect(fetchJsonBounded('https://example.com/user')).rejects.toMatchObject({
      code: 'too_large',
    });
  });

  it('times out through AbortError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    }));

    await expect(fetchJsonBounded('https://example.com/user', {}, { timeoutMs: 10 }))
      .rejects.toBeInstanceOf(BoundedFetchError);
  });

  it('parses a small JSON body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      arrayBuffer: async () => new TextEncoder().encode('{"ok":true}'),
    }));

    await expect(fetchJsonBounded<{ ok: boolean }>('https://example.com/user')).resolves.toEqual({
      ok: true,
    });
  });
});
