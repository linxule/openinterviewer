// Session token utilities for researcher authentication
// Uses signed JWTs to prevent forgery

import * as jose from 'jose';

const SESSION_COOKIE_NAME = 'research-auth';
const SESSION_DURATION = 60 * 60 * 24 * 7; // 7 days in seconds

interface SessionPayload {
  type: 'session';
  iat: number;
  exp: number;
}

// Get the signing secret from environment
// Uses SESSION_SECRET if available, falls back to ADMIN_PASSWORD
function getSecret(): Uint8Array {
  const secret = process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD;
  if (!secret) {
    throw new Error('SESSION_SECRET or ADMIN_PASSWORD environment variable is required');
  }

  // Warn if using ADMIN_PASSWORD as session secret (less secure)
  if (!process.env.SESSION_SECRET && process.env.NODE_ENV === 'production') {
    console.warn(
      '[Security] SESSION_SECRET not set - falling back to ADMIN_PASSWORD. ' +
      'For better security, set a dedicated SESSION_SECRET environment variable.'
    );
  }

  return new TextEncoder().encode(secret);
}

// Create a signed session token
export async function createSessionToken(): Promise<string> {
  const secret = getSecret();

  const token = await new jose.SignJWT({ type: 'session' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DURATION}s`)
    .sign(secret);

  return token;
}

// Verify a session token - returns true if valid
export async function verifySessionToken(token: string): Promise<boolean> {
  if (!token) {
    return false;
  }

  try {
    const secret = getSecret();
    const { payload } = await jose.jwtVerify(token, secret);

    // Check that it's a session token (not a participant token)
    if (payload.type !== 'session') {
      return false;
    }

    return true;
  } catch (error) {
    // Token invalid, expired, or tampered with
    return false;
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

// Get participant token secret (separate from session secret)
function getParticipantSecret(): Uint8Array | null {
  const secret = process.env.PARTICIPANT_TOKEN_SECRET || process.env.ADMIN_PASSWORD;
  if (!secret) return null;
  return new TextEncoder().encode(secret);
}

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
  return verifySessionToken(sessionToken);
}

// Verify participant token from Authorization header
// Also accepts valid admin session cookies (for researcher preview)
// Returns studyId if from participant token, undefined if from admin session
// Checks if links are enabled for the study (unless admin)
export async function verifyParticipantToken(request: Request): Promise<{ valid: boolean; studyId?: string; isAdmin?: boolean; error?: string }> {
  // First, check for participant token in Authorization header
  const authHeader = request.headers.get('Authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (token) {
    const secret = getParticipantSecret();
    if (secret) {
      try {
        const { payload } = await jose.jwtVerify(token, secret);
        const studyId = payload.studyId as string;

        // Check if links are enabled for this study
        // Import dynamically to avoid circular dependencies
        const { getStudy } = await import('@/services/storageService');
        const study = await getStudy(studyId);

        if (study && study.config.linksEnabled === false) {
          return { valid: false, error: 'Participant links have been disabled for this study.' };
        }

        return { valid: true, studyId };
      } catch (error) {
        // Check if it's an expiration error
        if (error instanceof jose.errors.JWTExpired) {
          return { valid: false, error: 'This link has expired. Please request a new participant link from the researcher.' };
        }
        // Token invalid, fall through to check admin session
      }
    }
  }

  // No valid participant token - check for admin session (researcher preview)
  const isAdmin = await hasValidAdminSession(request);
  if (isAdmin) {
    return { valid: true, isAdmin: true };
  }

  return { valid: false };
}
