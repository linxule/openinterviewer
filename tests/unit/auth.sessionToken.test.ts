// @vitest-environment node

import * as jose from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SESSION_AUDIENCE,
  SESSION_TOKEN_TYPE,
  SESSION_TOKEN_VERSION,
  TOKEN_ISSUER,
  createSessionToken,
  verifySessionToken,
} from '@/lib/auth';

const sessionSecret = 'session-test-secret-value-1234567890';
const adminPassword = 'admin-password-should-never-verify-tokens';

describe('researcher session tokens', () => {
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

  it('verifies issuer, audience, algorithm, and type', async () => {
    const token = await createSessionToken();
    const result = await verifySessionToken(token);
    expect(result.valid).toBe(true);
    expect(result.issuedAt).toEqual(expect.any(Number));
  });

  it('rejects legacy, wrong-version, and cross-mode session shapes', async () => {
    const secret = new TextEncoder().encode(sessionSecret);
    const sign = (payload: Record<string, unknown>) => new jose.SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(TOKEN_ISSUER)
      .setAudience(SESSION_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(secret);

    await expect(verifySessionToken(await sign({ type: SESSION_TOKEN_TYPE })))
      .resolves.toEqual({ valid: false });
    await expect(verifySessionToken(await sign({
      type: SESSION_TOKEN_TYPE,
      version: SESSION_TOKEN_VERSION + 1,
      mode: 'standalone',
    }))).resolves.toEqual({ valid: false });
    await expect(verifySessionToken(await sign({
      type: SESSION_TOKEN_TYPE,
      version: SESSION_TOKEN_VERSION,
      mode: 'hosted',
      researcherId: 'researcher-1',
    }))).resolves.toEqual({ valid: false });
  });

  it('never accepts a token signed with ADMIN_PASSWORD', async () => {
    const token = await new jose.SignJWT({ type: SESSION_TOKEN_TYPE })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(TOKEN_ISSUER)
      .setAudience(SESSION_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(adminPassword));

    await expect(verifySessionToken(token)).resolves.toEqual({ valid: false });
  });

  it('requires researcherId in hosted mode', async () => {
    process.env.DEPLOYMENT_MODE = 'hosted';
    await expect(createSessionToken()).rejects.toThrow(/researcherId/);

    const standaloneShaped = await new jose.SignJWT({
      type: SESSION_TOKEN_TYPE,
      version: SESSION_TOKEN_VERSION,
      mode: 'standalone',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(TOKEN_ISSUER)
      .setAudience(SESSION_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(sessionSecret));

    await expect(verifySessionToken(standaloneShaped)).resolves.toEqual({ valid: false });

    const hosted = await createSessionToken('researcher-1');
    const verifiedHosted = await verifySessionToken(hosted);
    expect(verifiedHosted).toMatchObject({
      valid: true,
      researcherId: 'researcher-1',
    });
    expect(verifiedHosted.issuedAt).toEqual(expect.any(Number));
  });
});
