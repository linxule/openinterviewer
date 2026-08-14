// @vitest-environment node

import * as jose from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PARTICIPANT_AUDIENCE,
  PARTICIPANT_SESSION_HEADER_NAME,
  PARTICIPANT_TOKEN_TYPE,
  SESSION_COOKIE_NAME,
  createSessionToken,
  getParticipantSessionCookieName,
  getParticipantSessionCookieOptions,
  verifyParticipantToken,
} from '@/lib/auth';

const secretText = 'participant-test-secret-value-1234567890';
const secret = new TextEncoder().encode(secretText);

const requestWith = (token: string) => new Request('http://localhost/api/greeting', {
  headers: { Cookie: `participant-session=${token}` },
});

async function sign(
  payload: jose.JWTPayload,
  audience = PARTICIPANT_AUDIENCE,
  sessionId = 'session-a'
) {
  return new jose.SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('openinterviewer')
    .setAudience(audience)
    .setJti(sessionId)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(secret);
}

beforeEach(() => {
  process.env.PARTICIPANT_TOKEN_SECRET = secretText;
  process.env.SESSION_SECRET = 'researcher-session-test-secret-1234567890';
  process.env.DEPLOYMENT_MODE = 'standalone';
});

afterEach(() => {
  delete process.env.PARTICIPANT_TOKEN_SECRET;
  delete process.env.SESSION_SECRET;
  delete process.env.DEPLOYMENT_MODE;
});

describe('participant token claim validation', () => {
  it('accepts only an explicitly typed token with a string study id', async () => {
    const token = await sign({
      type: PARTICIPANT_TOKEN_TYPE,
      version: 1,
      studyId: 'study-a',
      studyRevision: 1,
      linkId: 'a'.repeat(64),
    });

    await expect(verifyParticipantToken(requestWith(token))).resolves.toEqual({
      valid: true,
      studyId: 'study-a',
      studyRevision: 1,
      researcherId: undefined,
      linkId: 'a'.repeat(64),
      sessionId: 'session-a',
    });
  });

  it.each([
    { version: 1, studyId: 'study-a', studyRevision: 1, linkId: 'a'.repeat(64) },
    { type: 'session', version: 1, studyId: 'study-a', studyRevision: 1, linkId: 'a'.repeat(64) },
    { type: PARTICIPANT_TOKEN_TYPE, version: 1, studyRevision: 1, linkId: 'a'.repeat(64) },
    { type: PARTICIPANT_TOKEN_TYPE, version: 1, studyId: 42, studyRevision: 1, linkId: 'a'.repeat(64) },
    { type: PARTICIPANT_TOKEN_TYPE, version: 1, studyId: 'study-a', studyRevision: 1 },
  ])('rejects missing or confused claims: %o', async (payload) => {
    const token = await sign(payload);
    const result = await verifyParticipantToken(requestWith(token));

    expect(result.valid).toBe(false);
  });

  it('rejects a token for a different audience', async () => {
    const token = await sign(
      { type: PARTICIPANT_TOKEN_TYPE, version: 1, studyId: 'study-a', studyRevision: 1, linkId: 'a'.repeat(64) },
      'openinterviewer:researcher'
    );

    expect((await verifyParticipantToken(requestWith(token))).valid).toBe(false);
  });

  it('selects two independent dynamic HttpOnly participant cookies by tab handle', async () => {
    const handleA = 'participant-handle-a-123456';
    const handleB = 'participant-handle-b-123456';
    const tokenA = await sign({
      type: PARTICIPANT_TOKEN_TYPE,
      version: 1,
      studyId: 'study-a',
      studyRevision: 1,
      linkId: 'a'.repeat(64),
    }, PARTICIPANT_AUDIENCE, handleA);
    const tokenB = await sign({
      type: PARTICIPANT_TOKEN_TYPE,
      version: 1,
      studyId: 'study-b',
      studyRevision: 2,
      linkId: 'b'.repeat(64),
    }, PARTICIPANT_AUDIENCE, handleB);
    const cookie = [
      `${getParticipantSessionCookieName(handleA)}=${tokenA}`,
      `${getParticipantSessionCookieName(handleB)}=${tokenB}`,
    ].join('; ');

    const requestFor = (handle: string) => new Request('http://localhost/api/interview', {
      headers: {
        Cookie: cookie,
        [PARTICIPANT_SESSION_HEADER_NAME]: handle,
      },
    });

    await expect(verifyParticipantToken(requestFor(handleA))).resolves.toMatchObject({
      valid: true,
      studyId: 'study-a',
      sessionId: handleA,
    });
    await expect(verifyParticipantToken(requestFor(handleB))).resolves.toMatchObject({
      valid: true,
      studyId: 'study-b',
      sessionId: handleB,
    });
    expect(getParticipantSessionCookieName(handleA)).not.toBe(getParticipantSessionCookieName(handleB));
    expect(getParticipantSessionCookieOptions()).toMatchObject({ httpOnly: true, path: '/' });
  });

  it('prefers the selected participant session over a researcher cookie without an explicit preview marker', async () => {
    const handle = 'participant-handle-a-123456';
    const participantToken = await sign({
      type: PARTICIPANT_TOKEN_TYPE,
      version: 1,
      studyId: 'study-a',
      studyRevision: 1,
      linkId: 'a'.repeat(64),
    }, PARTICIPANT_AUDIENCE, handle);
    const researcherToken = await createSessionToken();
    const request = new Request('http://localhost/api/greeting', {
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${researcherToken}; ${getParticipantSessionCookieName(handle)}=${participantToken}`,
        [PARTICIPANT_SESSION_HEADER_NAME]: handle,
      },
    });

    const result = await verifyParticipantToken(request);
    expect(result).toMatchObject({
      valid: true,
      studyId: 'study-a',
      sessionId: handle,
    });
    expect(result.isAdmin).not.toBe(true);
  });

  it('lets a valid researcher preview marker override a stale participant cookie', async () => {
    const handle = 'participant-handle-a-123456';
    const participantToken = await sign({
      type: PARTICIPANT_TOKEN_TYPE,
      version: 1,
      studyId: 'study-a',
      studyRevision: 1,
      linkId: 'a'.repeat(64),
    }, PARTICIPANT_AUDIENCE, handle);
    const researcherToken = await createSessionToken();
    const request = new Request('http://localhost/api/greeting', {
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${researcherToken}; ${getParticipantSessionCookieName(handle)}=${participantToken}`,
        [PARTICIPANT_SESSION_HEADER_NAME]: handle,
        'X-OpenInterviewer-Preview': '1',
      },
    });

    await expect(verifyParticipantToken(request)).resolves.toEqual({ valid: true, isAdmin: true });
  });

  it('rejects a selected cookie when its signed jti does not match the tab handle', async () => {
    const selectedHandle = 'participant-handle-a-123456';
    const signedHandle = 'participant-handle-b-123456';
    const token = await sign({
      type: PARTICIPANT_TOKEN_TYPE,
      version: 1,
      studyId: 'study-a',
      studyRevision: 1,
      linkId: 'a'.repeat(64),
    }, PARTICIPANT_AUDIENCE, signedHandle);
    const request = new Request('http://localhost/api/interview', {
      headers: {
        Cookie: `${getParticipantSessionCookieName(selectedHandle)}=${token}`,
        [PARTICIPANT_SESSION_HEADER_NAME]: selectedHandle,
      },
    });

    await expect(verifyParticipantToken(request)).resolves.toMatchObject({ valid: false });
  });
});
