// Session token utilities for researcher authentication
// Uses signed JWTs to prevent forgery
// Supports both standalone (password) and hosted (OAuth with researcherId) modes

import * as jose from 'jose';
import { isHostedMode } from './mode';

const SESSION_COOKIE_NAME = 'research-auth';
const SESSION_DURATION = 60 * 60 * 24 * 7; // 7 days in seconds
export const TOKEN_ISSUER = 'openinterviewer';
export const SESSION_AUDIENCE = 'openinterviewer:researcher';
export const SESSION_TOKEN_TYPE = 'session';
export const SESSION_TOKEN_VERSION = 1;
export const PARTICIPANT_AUDIENCE = 'openinterviewer:participant-session';
export const PARTICIPANT_TOKEN_TYPE = 'participant-session';
export const PARTICIPANT_SESSION_COOKIE_NAME = 'participant-session';
export const PARTICIPANT_SESSION_HEADER_NAME = 'x-openinterviewer-participant-session';
const PARTICIPANT_SESSION_DURATION = 60 * 60 * 4;
const PARTICIPANT_SESSION_HANDLE_PATTERN = /^[a-zA-Z0-9_-]{16,128}$/;

export function getParticipantSessionCookieName(sessionHandle?: string | null): string {
  return sessionHandle && PARTICIPANT_SESSION_HANDLE_PATTERN.test(sessionHandle)
    ? `${PARTICIPANT_SESSION_COOKIE_NAME}-${sessionHandle}`
    : PARTICIPANT_SESSION_COOKIE_NAME;
}

// Independent signing secrets. Session tokens and participant tokens must never
// share a secret, and neither may fall back to ADMIN_PASSWORD. Secrets are
// required and must be long enough to be safe; failures are explicit and
// fail closed. Values are never logged.
const MIN_SECRET_LENGTH = 32;

// Read a required signing secret from the environment, failing closed when
// absent or too weak. Only the env var name is ever referenced in errors.
function requireSecret(envName: string): Uint8Array {
  const secret = process.env[envName];
  if (!secret) {
    throw new Error(`${envName} environment variable is required`);
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`${envName} must be at least ${MIN_SECRET_LENGTH} characters long`);
  }
  return new TextEncoder().encode(secret);
}

// Session token signing secret (researcher sessions / admin preview)
function getSecret(): Uint8Array {
  return requireSecret('SESSION_SECRET');
}

// Participant link token signing secret (independent from session secret)
export function getParticipantSigningSecret(): Uint8Array {
  return requireSecret('PARTICIPANT_TOKEN_SECRET');
}

export async function createParticipantSessionToken(link: {
  id: string;
  studyId: string;
  studyRevision: number;
  researcherId: string | null;
  expiresAt: number | null;
}, sessionId = crypto.randomUUID()): Promise<string> {
  const secret = getParticipantSigningSecret();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const linkExpirySeconds = link.expiresAt ? Math.floor(link.expiresAt / 1000) : null;
  const expiresAt = Math.min(
    nowSeconds + PARTICIPANT_SESSION_DURATION,
    linkExpirySeconds ?? Number.MAX_SAFE_INTEGER
  );

  return new jose.SignJWT({
    type: PARTICIPANT_TOKEN_TYPE,
    version: 1,
    studyId: link.studyId,
    studyRevision: link.studyRevision,
    researcherId: link.researcherId ?? undefined,
    linkId: link.id,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(TOKEN_ISSUER)
    .setAudience(PARTICIPANT_AUDIENCE)
    .setSubject(link.studyId)
    .setJti(sessionId)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(expiresAt)
    .sign(secret);
}

export function getParticipantSessionCookieOptions(maxAge = PARTICIPANT_SESSION_DURATION) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    maxAge,
    path: '/',
  };
}

// Create a signed session token
// In hosted mode, embeds researcherId for multi-tenant context resolution
export async function createSessionToken(researcherId?: string): Promise<string> {
  const secret = getSecret();
  const hosted = isHostedMode();

  const payload: Record<string, unknown> = {
    type: SESSION_TOKEN_TYPE,
    version: SESSION_TOKEN_VERSION,
    mode: hosted ? 'hosted' : 'standalone',
  };
  if (hosted) {
    if (!researcherId) {
      throw new Error('researcherId is required to create a hosted session');
    }
    payload.mode = 'hosted';
    payload.researcherId = researcherId;
  }

  const token = await new jose.SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(TOKEN_ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DURATION}s`)
    .sign(secret);

  return token;
}

// Session verification result
export interface SessionVerifyResult {
  valid: boolean;
  researcherId?: string; // Present in hosted mode
  issuedAt?: number;
}

// Verify a session token
// Returns validity and researcherId (hosted mode only)
// Fails closed: an unconfigured or weak SESSION_SECRET yields invalid sessions
export async function verifySessionToken(token: string): Promise<SessionVerifyResult> {
  if (!token) {
    return { valid: false };
  }

  let secret: Uint8Array;
  try {
    secret = getSecret();
  } catch {
    return { valid: false };
  }

  try {
    const { payload } = await jose.jwtVerify(token, secret, {
      algorithms: ['HS256'],
      issuer: TOKEN_ISSUER,
      audience: SESSION_AUDIENCE,
    });

    // Check that it's a session token (not a participant token)
    if (
      payload.type !== SESSION_TOKEN_TYPE
      || payload.version !== SESSION_TOKEN_VERSION
      || typeof payload.iat !== 'number'
    ) {
      return { valid: false };
    }

    // In hosted mode, extract researcherId
    if (isHostedMode()) {
      if (
        payload.mode !== 'hosted'
        || typeof payload.researcherId !== 'string'
        || !payload.researcherId
      ) {
        return { valid: false };
      }
      return {
        valid: true,
        researcherId: payload.researcherId,
        issuedAt: payload.iat,
      };
    }

    if (payload.mode !== 'standalone' || payload.researcherId !== undefined) {
      return { valid: false };
    }

    return { valid: true, issuedAt: payload.iat };
  } catch {
    // Token invalid, expired, or tampered with
    return { valid: false };
  }
}

// Cookie configuration for session token
export function getSessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict' as const, // Strict - no cross-site embedding needed
    maxAge: SESSION_DURATION,
    path: '/',
  };
}

export { SESSION_COOKIE_NAME };

// === Participant Token Verification ===

// Parse cookies from request headers
function getCookieValue(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(';').map(c => c.trim());
  for (const cookie of cookies) {
    const [key, ...valueParts] = cookie.split('=');
    if (key === name) {
      return valueParts.join('=');
    }
  }
  return null;
}

// Check if request has valid admin session cookie
async function hasValidAdminSession(request: Request): Promise<boolean> {
  const sessionToken = getCookieValue(request, SESSION_COOKIE_NAME);
  if (!sessionToken) return false;
  const result = await verifySessionToken(sessionToken);
  return result.valid;
}

// Participant token verification result
export interface ParticipantVerifyResult {
  valid: boolean;
  studyId?: string;
  researcherId?: string; // Present in hosted mode tokens
  isAdmin?: boolean;
  linkId?: string;
  sessionId?: string;
  studyRevision?: number;
  error?: string;
}

// Verify the short-lived HttpOnly participant-session cookie.
// The opaque share-link code is never accepted as an API bearer credential.
// Also accepts a valid researcher session cookie for saved-study preview.
export async function verifyParticipantToken(request: Request): Promise<ParticipantVerifyResult> {
  // Researcher preview is explicit. The marker is honored only together with a
  // valid researcher session, so a stale participant cookie cannot steer a
  // preview while normal participant tabs keep participant authority.
  if (request.headers.get('x-openinterviewer-preview') === '1') {
    const isAdmin = await hasValidAdminSession(request);
    return isAdmin
      ? { valid: true, isAdmin: true }
      : { valid: false, error: 'A valid researcher session is required for preview.' };
  }

  const sessionHandle = request.headers.get(PARTICIPANT_SESSION_HEADER_NAME);
  if (sessionHandle && !PARTICIPANT_SESSION_HANDLE_PATTERN.test(sessionHandle)) {
    return { valid: false, error: 'Invalid participant session selector.' };
  }
  const token = getCookieValue(request, getParticipantSessionCookieName(sessionHandle));

  if (token) {
    let secret: Uint8Array;
    try {
      secret = getParticipantSigningSecret();
    } catch {
      // Fail closed: without a dedicated participant secret we cannot verify
      // participant tokens, and the signer refuses to mint them either.
      return { valid: false, error: 'Participant link verification is not configured on the server.' };
    }

    try {
      const { payload } = await jose.jwtVerify(token, secret, {
        algorithms: ['HS256'],
        issuer: TOKEN_ISSUER,
        audience: PARTICIPANT_AUDIENCE,
      });

      if (
        payload.type !== PARTICIPANT_TOKEN_TYPE
        || payload.version !== 1
        || typeof payload.studyId !== 'string'
        || typeof payload.studyRevision !== 'number'
        || typeof payload.linkId !== 'string'
        || typeof payload.jti !== 'string'
        || (sessionHandle !== null && payload.jti !== sessionHandle)
      ) {
        return { valid: false, error: 'Invalid participant link.' };
      }

      const researcherId = typeof payload.researcherId === 'string'
        ? payload.researcherId
        : undefined;

      return {
        valid: true,
        studyId: payload.studyId,
        studyRevision: payload.studyRevision,
        researcherId,
        linkId: payload.linkId,
        sessionId: payload.jti,
      };
    } catch (error) {
      // Check if it's an expiration error
      if (error instanceof jose.errors.JWTExpired) {
        return { valid: false, error: 'This participant session has expired. Reopen the study link to continue.' };
      }
      return { valid: false, error: 'Invalid participant link.' };
    }
  }

  // No participant session: accept a researcher session for legacy/internal
  // saved-study preview clients.
  const isAdmin = await hasValidAdminSession(request);
  if (isAdmin) {
    return { valid: true, isAdmin: true };
  }

  return { valid: false };
}
