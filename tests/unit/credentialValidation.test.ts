import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateAiCredential, validateRedisCredentials } from '@/lib/credentialValidation';

afterEach(() => vi.unstubAllGlobals());

describe('credential validation', () => {
  it('validates Redis through its bounded REST ping without exposing the token in the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ result: 'PONG' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await validateRedisCredentials('https://owner.upstash.io', 'secret-token');
    expect(result).toEqual({ valid: true });
    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://owner.upstash.io/ping');
    expect(String(url)).not.toContain('secret-token');
    expect(options.headers.Authorization).toBe('Bearer secret-token');
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('classifies provider authentication errors as invalid without returning provider bodies', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('secret provider body', { status: 401 })));
    await expect(validateAiCredential('claude', 'sk-ant-secret')).resolves.toEqual({
      valid: false,
      reason: 'invalid',
    });
  });
});
