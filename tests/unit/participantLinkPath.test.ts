// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { participantLinkCode } from '@/lib/participantLinkPath';
import nextConfig from '../../next.config.js';

describe('participant link path', () => {
  it('reads the code of /p/<code> and nothing else', () => {
    expect(participantLinkCode('/p/Abc_123-xyz')).toBe('Abc_123-xyz');
    expect(participantLinkCode('/p/a%2Fb')).toBe('a/b');
    for (const path of ['/p', '/p/', '/p/a/b', '/pp/abc', '/consent', '/p/%E0%A4%A']) {
      expect(participantLinkCode(path)).toBeNull();
    }
  });

  it('is served by the static /p route without the code in its query (RT-10)', async () => {
    const rewrites = await nextConfig.rewrites!();
    expect(rewrites).toEqual([{ source: '/p/:code', destination: '/p?code=' }]);
    const headers = await nextConfig.headers!();
    expect(headers).toContainEqual({
      source: '/p/:code*',
      headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }],
    });
  });
});
