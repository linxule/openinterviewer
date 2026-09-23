import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cookieFrom, startArtifact, SYNTHETIC_SECRETS, type ArtifactHarness } from './harness';

let app: ArtifactHarness;

beforeAll(async () => {
  app = await startArtifact();
});

afterAll(async () => {
  await app?.close();
});

const get = (path: string, init?: RequestInit) => fetch(new URL(path, app.url), { redirect: 'manual', ...init });

describe('production artifact runtime (RT-02, RT-03, RT-06)', () => {
  it('RT-03 serves public pages and static assets from the built artifact', async () => {
    for (const path of ['/', '/demo', '/self-host', '/login']) {
      const response = await get(path);
      expect(response.status, path).toBe(200);
      await response.arrayBuffer();
    }
  });

  it('RT-06 proxy protects researcher pages and clears an invalid session cookie', async () => {
    const anonymous = await get('/dashboard');
    expect(anonymous.status).toBe(307);
    expect(anonymous.headers.get('location')).toContain('/login?redirect=%2Fdashboard');
    const invalid = await get('/studies', { headers: { cookie: 'research-auth=forged' } });
    expect(invalid.status).toBe(307);
    expect(invalid.headers.getSetCookie().some((value) => value.startsWith('research-auth=;'))).toBe(true);
  });

  it('RT-06 signs and verifies the researcher session inside workerd', async () => {
    const login = await get('/api/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: SYNTHETIC_SECRETS.ADMIN_PASSWORD }),
    });
    expect(login.status).toBe(200);
    const cookie = cookieFrom(login, 'research-auth');
    expect(cookie).toBeTruthy();
    expect(login.headers.getSetCookie().join(';')).toMatch(/HttpOnly/i);
    const dashboard = await get('/dashboard', { headers: { cookie: cookie! } });
    expect(dashboard.status).toBe(200);
    await dashboard.arrayBuffer();
    const wrong = await get('/api/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'not-the-password-0000' }),
    });
    expect(wrong.status).toBe(401);
  });

  it('VERIFY-01 made no outbound request beyond registered fixtures', () => {
    expect(app.refused).toEqual([]);
  });
});

describe('Worker target guard (RT-01)', () => {
  it('refuses to serve when the Worker is not declared as the cloudflare target', async () => {
    const other = await startArtifact({ vars: { DEPLOYMENT_TARGET: 'node' } });
    try {
      const response = await fetch(new URL('/api/config/mode', other.url));
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
    } finally {
      await other.close();
    }
  });
});
