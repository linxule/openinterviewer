// @vitest-environment node

import * as jose from 'jose';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SESSION_AUDIENCE,
  SESSION_COOKIE_NAME,
  SESSION_TOKEN_TYPE,
  TOKEN_ISSUER,
  createSessionToken,
} from '@/lib/auth';
import { proxy } from '@/proxy';

const sessionSecret = 'session-test-secret-value-1234567890';
const adminPassword = 'admin-password-must-not-work-in-middleware';

function requestFor(path: string, token?: string) {
  return new NextRequest(new URL(path, 'http://localhost:3000'), {
    headers: token ? { cookie: `${SESSION_COOKIE_NAME}=${token}` } : {},
  });
}

describe('session proxy', () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = sessionSecret;
    process.env.ADMIN_PASSWORD = adminPassword;
    process.env.DEPLOYMENT_MODE = 'standalone';
  });

  afterEach(() => {
    delete process.env.SESSION_SECRET;
    delete process.env.ADMIN_PASSWORD;
    delete process.env.DEPLOYMENT_MODE;
  });

  it('redirects unauthenticated protected requests to login', async () => {
    const response = await proxy(requestFor('/studies'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/login?redirect=%2Fstudies');
  });

  it('protects setup but does not overmatch similarly-prefixed public paths', async () => {
    const setup = await proxy(requestFor('/setup'));
    expect(setup.status).toBe(307);

    const unrelated = await proxy(requestFor('/studies-public'));
    expect(unrelated.status).toBe(200);
    expect(unrelated.headers.get('location')).toBeNull();
  });

  it('keeps participant export public without a researcher session', async () => {
    const response = await proxy(requestFor('/export'));

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('rejects ADMIN_PASSWORD-signed tokens', async () => {
    const token = await new jose.SignJWT({ type: SESSION_TOKEN_TYPE })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(TOKEN_ISSUER)
      .setAudience(SESSION_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(adminPassword));

    const response = await proxy(requestFor('/studies', token));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/login');
  });

  it('allows a valid researcher session', async () => {
    const token = await createSessionToken();
    const response = await proxy(requestFor('/studies', token));
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('enforces the hosted researcherId contract', async () => {
    process.env.DEPLOYMENT_MODE = 'hosted';
    const token = await new jose.SignJWT({ type: SESSION_TOKEN_TYPE })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(TOKEN_ISSUER)
      .setAudience(SESSION_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(sessionSecret));

    const response = await proxy(requestFor('/onboarding', token));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/login');
  });
});
