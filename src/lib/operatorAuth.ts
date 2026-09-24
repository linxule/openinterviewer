// Operator authority for /api/operator/* (OPS-01, OPS-02, OPS-03; gap F5).
//
// An operator request is accepted only when all of these hold, checked in
// this order so every refusal happens before any storage call:
//  1. the deployment target is Cloudflare (404 otherwise: the Node target has
//     no operator surface);
//  2. the OPERATOR_TOKEN secret is present in the current Worker invocation's
//     env and is at least 32 characters (503 otherwise: never open);
//  3. `Authorization: Bearer <token>` matches it in constant time
//     (timingSafeEqual over equal-length SHA-256 digests, so neither content
//     nor length leaks through timing) (401 otherwise);
//  4. a valid standalone researcher session cookie (401 otherwise)
//  5. issued within the last 15 minutes (403 otherwise).
// Every decision, accepted or refused, is logged as one allowlisted
// `operator.action` event without content.

import { createHash, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { SESSION_COOKIE_NAME, verifySessionToken } from './auth';
import { logRequestEvent, type RequestLogReason } from './requestLog';
import { hasRecentResearcherSession } from './researcherContext';
import { isCloudflareTarget } from './runtime/capabilities';
import { currentWorkerInvocation } from './runtime/workerInvocation';

export const OPERATOR_SESSION_MAX_AGE_SECONDS = 15 * 60;
export const MIN_OPERATOR_TOKEN_LENGTH = 32;
/** Longest Authorization header value considered; anything longer is refused unread. */
const MAX_AUTHORIZATION_LENGTH = 1024;
// Same template-value pattern as hostedConfig and scripts/check-setup.mjs.
const SECRET_PLACEHOLDERS = /^(?:change[-_ ]?me|replace[-_ ]?me|your[-_ ]|example|todo|secret$)/i;

export type OperatorOperation =
  | 'status'
  | 'maintenance'
  | 'backup.export'
  | 'backup.import'
  | 'recovery.activate'
  | 'recovery.restore';

export type OperatorRequestLabel = {
  route: string;
  method: 'GET' | 'POST';
  operation: OperatorOperation;
};

export function logOperatorAction(
  label: OperatorRequestLabel,
  status: number,
  reason?: RequestLogReason,
): void {
  logRequestEvent({
    event: 'operator.action',
    route: label.route,
    method: label.method,
    operation: label.operation,
    status,
    ...(reason ? { reason } : {}),
  });
}

/** JSON with `Cache-Control: no-store`, the only response shape operator routes use. */
export function operatorJson(body: Record<string, unknown>, status: number, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

/** A refusal: logged, then returned. */
export function operatorRefusal(
  label: OperatorRequestLabel,
  status: number,
  body: Record<string, unknown>,
  reason?: RequestLogReason,
  headers?: Record<string, string>,
): NextResponse {
  logOperatorAction(label, status, reason);
  return operatorJson(body, status, headers);
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Constant-time token comparison. Both sides are hashed first so the compared
 * buffers always have equal length, whatever was presented.
 */
export function operatorTokensMatch(presented: string, configured: string): boolean {
  return timingSafeEqual(digest(presented), digest(configured));
}

function configuredOperatorToken(): string | null {
  const value = currentWorkerInvocation()?.env.OPERATOR_TOKEN;
  if (typeof value !== 'string') return null;
  if (value.length < MIN_OPERATOR_TOKEN_LENGTH || value.trim() !== value || SECRET_PLACEHOLDERS.test(value)) return null;
  return value;
}

function presentedBearerToken(header: string | null): string | null {
  if (header === null || header.length > MAX_AUTHORIZATION_LENGTH) return null;
  const match = /^Bearer ([\x21-\x7e]+)$/.exec(header);
  return match ? match[1] : null;
}

/**
 * Null when the request carries operator authority, otherwise the refusal
 * response to return unchanged.
 */
export async function operatorAuthorityRefusal(
  request: Request,
  label: OperatorRequestLabel,
): Promise<NextResponse | null> {
  if (!isCloudflareTarget()) {
    return operatorRefusal(label, 404, { error: 'Not found' });
  }

  const configured = configuredOperatorToken();
  if (!configured) {
    return operatorRefusal(
      label,
      503,
      {
        error: 'Operator access is not configured for this deployment.',
        code: 'OPERATOR_NOT_CONFIGURED',
        retryable: false,
      },
      'not-configured',
    );
  }

  const presented = presentedBearerToken(request.headers.get('authorization'));
  // Compare even when nothing usable was presented, so a missing and a wrong
  // token take the same path.
  const tokenMatches = operatorTokensMatch(presented ?? '', configured) && presented !== null;
  if (!tokenMatches) {
    return operatorRefusal(
      label,
      401,
      { error: 'Operator authorization required.', code: 'OPERATOR_UNAUTHORIZED' },
      'invalid',
      { 'WWW-Authenticate': 'Bearer' },
    );
  }

  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const session = sessionCookie ? await verifySessionToken(sessionCookie) : { valid: false as const };
  if (!session.valid) {
    return operatorRefusal(
      label,
      401,
      { error: 'Researcher sign-in required.', code: 'SIGN_IN_REQUIRED' },
      'invalid',
    );
  }
  const recent = hasRecentResearcherSession(
    { authorized: true, issuedAt: session.issuedAt },
    OPERATOR_SESSION_MAX_AGE_SECONDS,
  );
  if (!recent) {
    return operatorRefusal(
      label,
      403,
      {
        error: 'Sign in again: operator actions need a researcher sign-in from the last 15 minutes.',
        code: 'RECENT_SIGN_IN_REQUIRED',
      },
      'expired',
    );
  }
  return null;
}
