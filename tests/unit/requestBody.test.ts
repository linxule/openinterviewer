import { describe, expect, it } from 'vitest';
import { readBoundedJsonObject } from '@/lib/requestBody';

describe('readBoundedJsonObject', () => {
  it('accepts an object within the byte limit', async () => {
    const request = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ target: 'all' }) });
    await expect(readBoundedJsonObject(request, 100)).resolves.toEqual({
      ok: true,
      value: { target: 'all' },
    });
  });

  it('rejects oversized bodies before parsing', async () => {
    const request = new Request('http://localhost', {
      method: 'POST',
      headers: { 'Content-Length': '1000' },
      body: '{}',
    });
    await expect(readBoundedJsonObject(request, 100)).resolves.toEqual({ ok: false, status: 413 });
  });
});
