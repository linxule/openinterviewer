// POST /api/auth - Researcher login
// Uses signed JWT session tokens for security
// In hosted mode, password login is disabled (use OAuth instead)

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { timingSafeEqual } from 'crypto';
import {
  createSessionToken,
  verifySessionToken,
  getSessionCookieOptions,
  SESSION_COOKIE_NAME
} from '@/lib/auth';
import { isHostedMode } from '@/lib/mode';
import { createRequestId, logRequestEvent, logRequestFailure } from '@/lib/requestLog';

export async function POST(request: Request) {
  try {
    // In hosted mode, password login is disabled — use OAuth
    if (isHostedMode()) {
      return NextResponse.json(
        { error: 'Password login is not available in hosted mode. Use OAuth to sign in.' },
        { status: 404 }
      );
    }

    const body = await request.json();
    const { password } = body as { password: string };

    // Validate password is provided
    if (!password || typeof password !== 'string') {
      return NextResponse.json(
        { error: 'Password is required' },
        { status: 400 }
      );
    }

    // Get the configured password
    const adminPassword = process.env.ADMIN_PASSWORD;

    if (!adminPassword) {
      // SECURITY: Never allow access without ADMIN_PASSWORD configured
      logRequestEvent({ event: 'route.failure', route: '/api/auth', method: 'POST', status: 500, reason: 'not-configured' });
      return NextResponse.json(
        { error: 'Authentication not configured. Set ADMIN_PASSWORD environment variable.' },
        { status: 500 }
      );
    }

    // Check password (constant-time comparison to prevent timing attacks)
    const passwordBuf = Buffer.from(password);
    const adminBuf = Buffer.from(adminPassword);
    if (passwordBuf.length !== adminBuf.length || !timingSafeEqual(passwordBuf, adminBuf)) {
      return NextResponse.json(
        { error: 'Invalid password' },
        { status: 401 }
      );
    }

    // Create signed session token (no researcherId in standalone mode)
    const sessionToken = await createSessionToken();

    // Set auth cookie with signed token
    const cookieStore = await cookies();
    cookieStore.set(SESSION_COOKIE_NAME, sessionToken, getSessionCookieOptions());

    return NextResponse.json({ success: true });
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
