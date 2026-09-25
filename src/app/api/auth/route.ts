// POST /api/auth - Researcher login
// Uses signed JWT session tokens for security
// In hosted mode, password login is disabled (use OAuth instead)
//
// Standalone sign-in, on both targets (gap F5): the body is bounded to 1 KiB
// while it streams in, and a failed-attempt budget (10 per client per 15
// minutes, 200 across all clients per hour) admits the attempt atomically,
// counting it, before the password is compared. A correct password refunds the
// attempt, so only failures stay counted; concurrent guesses cannot outrun the
// count. Limited → 429 with Retry-After; budget storage unavailable or not
// configured → 503 (fail closed). Sign-in is deliberately not gated on
// deployment readiness or maintenance state, so an operator can sign in to a
// held, frozen or recovering workspace.
//
// Cloudflare: ADMIN_PASSWORD comes from the Worker invocation env, the budget
// lives in the WorkspaceStore object and the client is the validated
// CF-Connecting-IP. Node: ADMIN_PASSWORD and RATE_LIMIT_SALT come from
// process.env, the budget lives in the deployment's Redis and the client is
// the first address of the existing forwarding-header chain.

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createHash, timingSafeEqual } from 'crypto';
import {
  createSessionToken,
  verifySessionToken,
  getSessionCookieOptions,
  SESSION_COOKIE_NAME
} from '@/lib/auth';
import { isHostedMode } from '@/lib/mode';
import { createRequestId, logRequestEvent, logRequestFailure } from '@/lib/requestLog';
import { isCloudflareTarget, resolveCapabilities } from '@/lib/runtime/capabilities';
import { nodeAdmissionIdentity } from '@/lib/runtime/clientAddress';
import { currentWorkerInvocation, type AdmissionIdentity } from '@/lib/runtime/workerInvocation';
import { getKVClient } from '@/lib/kvClient';
import { createDurableLoginBudget } from '@/lib/storage/durableObject';
import { createRedisLoginBudget } from '@/lib/storage/redisLoginBudget';
import { durableWorkspaceSettings } from '@/lib/storage/resolve';
import type { LoginAttemptBudgetPort } from '@/lib/storage/types';
import { MAX_CLOUDFLARE_LOGIN_BODY_BYTES } from '@/lib/loginBody';

/** Same floor as standalone readiness and the setup checker. */
const MIN_RATE_LIMIT_SALT_LENGTH = 32;

function noStoreJson(body: Record<string, unknown>, status: number, headers: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

type BudgetEvent = 'workspace.store' | 'kv.unavailable';

function signInUnavailable(
  reason: 'unavailable' | 'binding-missing' | 'not-configured',
  event: BudgetEvent = 'workspace.store',
) {
  logRequestEvent({ event, route: '/api/auth', method: 'POST', operation: 'login', status: 503, reason });
  return noStoreJson(
    { error: 'Sign-in is temporarily unavailable. Please try again later.', retryable: true },
    503,
  );
}

type LoginBody = { ok: true; value: Record<string, unknown> } | { ok: false; status: 400 | 413 };

/**
 * Reads at most MAX_CLOUDFLARE_LOGIN_BODY_BYTES and cancels the stream as soon
 * as it exceeds them, so an unauthenticated upload without Content-Length is
 * never buffered whole.
 */
async function readLoginBody(request: Request): Promise<LoginBody> {
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CLOUDFLARE_LOGIN_BODY_BYTES) {
    return { ok: false, status: 413 };
  }
  if (!request.body) return { ok: false, status: 400 };
  const reader = request.body.getReader();
  const bytes = new Uint8Array(MAX_CLOUDFLARE_LOGIN_BODY_BYTES);
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > MAX_CLOUDFLARE_LOGIN_BODY_BYTES) {
        reader.cancel().catch(() => undefined);
        return { ok: false, status: 413 };
      }
      bytes.set(value, length);
      length += value.byteLength;
    }
  } catch {
    return { ok: false, status: 400 };
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(0, length)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, status: 400 };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, status: 400 };
  }
}

/** Equal-length digests, so neither content nor length leaks through timing. */
function passwordMatches(presented: string, configured: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(presented), digest(configured));
}

async function setSessionCookie(): Promise<void> {
  // Create signed session token (no researcherId in standalone mode)
  const sessionToken = await createSessionToken();
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, sessionToken, getSessionCookieOptions());
}

/** The body's password, or the refusal to send before any budget call. */
async function readPassword(request: Request): Promise<{ ok: true; password: string } | { ok: false; response: NextResponse }> {
  const parsed = await readLoginBody(request);
  if (!parsed.ok) {
    return {
      ok: false,
      response: parsed.status === 413
        ? noStoreJson({ error: 'Request body is too large' }, 413)
        : noStoreJson({ error: 'Password is required' }, 400),
    };
  }
  const password = parsed.value.password;
  if (!password || typeof password !== 'string') {
    return { ok: false, response: noStoreJson({ error: 'Password is required' }, 400) };
  }
  return { ok: true, password };
}

function notConfigured() {
  // SECURITY: Never allow access without ADMIN_PASSWORD configured
  logRequestEvent({ event: 'route.failure', route: '/api/auth', method: 'POST', status: 500, reason: 'not-configured' });
  return noStoreJson(
    { error: 'Authentication not configured. Set ADMIN_PASSWORD environment variable.' },
    500,
  );
}

async function budgetedSignIn(
  password: string,
  adminPassword: string,
  budget: LoginAttemptBudgetPort,
  identity: AdmissionIdentity | null,
  event: BudgetEvent,
) {
  // Counts this attempt before the comparison, atomically with the limit check.
  const admission = await budget.admitLoginAttempt({ identity, now: Date.now() });
  if (admission.status === 'limited') {
    logRequestEvent({ event: 'route.failure', route: '/api/auth', method: 'POST', operation: 'login', status: 429 });
    return noStoreJson(
      { error: 'Too many sign-in attempts. Please wait before trying again.', retryable: true },
      429,
      { 'Retry-After': String(admission.retryAfterSeconds) },
    );
  }
  if (admission.status !== 'admitted') return signInUnavailable('unavailable', event);

  // A wrong password keeps its admitted attempt counted: no further call.
  if (!passwordMatches(password, adminPassword)) return noStoreJson({ error: 'Invalid password' }, 401);

  // A lost refund leaves the attempt counted (fail closed); sign-in still succeeds.
  const refund = await budget.refundLoginAttempt({ identity, now: Date.now() });
  if (refund.status !== 'refunded') {
    logRequestEvent({ event, route: '/api/auth', method: 'POST', operation: 'login.refund', status: 200, reason: 'unavailable' });
  }
  await setSessionCookie();
  return noStoreJson({ success: true }, 200);
}

async function cloudflareLogin(request: Request) {
  const capabilities = resolveCapabilities();
  if (!capabilities.ok) return signInUnavailable('not-configured');

  const read = await readPassword(request);
  if (!read.ok) return read.response;

  const invocation = currentWorkerInvocation();
  const adminPassword = invocation?.env.ADMIN_PASSWORD;
  if (typeof adminPassword !== 'string' || adminPassword.length === 0) return notConfigured();

  let budget: LoginAttemptBudgetPort;
  try {
    budget = createDurableLoginBudget(durableWorkspaceSettings());
  } catch {
    return signInUnavailable('binding-missing');
  }
  return budgetedSignIn(read.password, adminPassword, budget, invocation?.identity ?? null, 'workspace.store');
}

/**
 * Node standalone. RATE_LIMIT_SALT is required here, as standalone readiness
 * and the setup checker already require it: without it (or without the Redis
 * REST variables) there is no budget, and sign-in fails closed with 503
 * rather than falling back to another secret or to no limit.
 */
async function nodeLogin(request: Request) {
  const read = await readPassword(request);
  if (!read.ok) return read.response;

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) return notConfigured();

  const salt = process.env.RATE_LIMIT_SALT;
  if (
    !salt
    || salt.length < MIN_RATE_LIMIT_SALT_LENGTH
    || !process.env.KV_REST_API_URL
    || !process.env.KV_REST_API_TOKEN
  ) {
    return signInUnavailable('not-configured', 'kv.unavailable');
  }
  const budget = createRedisLoginBudget(getKVClient(), salt);
  return budgetedSignIn(read.password, adminPassword, budget, nodeAdmissionIdentity(request.headers), 'kv.unavailable');
}

export async function POST(request: Request) {
  try {
    if (isCloudflareTarget()) return await cloudflareLogin(request);

    // In hosted mode, password login is disabled — use OAuth
    if (isHostedMode()) {
      return NextResponse.json(
        { error: 'Password login is not available in hosted mode. Use OAuth to sign in.' },
        { status: 404 }
      );
    }

    return await nodeLogin(request);
  } catch (error) {
    logRequestFailure({
      event: 'route.failure',
      route: '/api/auth',
      method: 'POST',
      status: 500,
      requestId: createRequestId(request.headers.get('x-request-id')),
    }, error);
    return NextResponse.json(
      { error: 'Authentication failed' },
      { status: 500 }
    );
  }
}

// GET /api/auth - Check authentication status
export async function GET() {
  try {
    const cookieStore = await cookies();
    const authCookie = cookieStore.get(SESSION_COOKIE_NAME);

    if (!authCookie?.value) {
      return NextResponse.json({ authenticated: false });
    }

    // Verify the token is valid (not just that it exists)
    const session = await verifySessionToken(authCookie.value);

    return NextResponse.json({
      authenticated: session.valid,
      ...(session.researcherId && { researcherId: session.researcherId }),
    });
  } catch {
    return NextResponse.json({ authenticated: false });
  }
}

// DELETE /api/auth - Logout
export async function DELETE() {
  try {
    const cookieStore = await cookies();
    cookieStore.delete(SESSION_COOKIE_NAME);
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: 'Logout failed' },
      { status: 500 }
    );
  }
}
