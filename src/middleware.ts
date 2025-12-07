import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import * as jose from 'jose';

const SESSION_COOKIE_NAME = 'research-auth';

// Routes that require authentication
const protectedRoutes = ['/dashboard', '/studies'];

// Verify session token in edge middleware
async function verifySession(token: string, request: NextRequest): Promise<boolean> {
  if (!token) {
    return false;
  }

  // Use SESSION_SECRET if available, fall back to ADMIN_PASSWORD
  // This must match the secret used in src/lib/auth.ts
  const secret = process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD;
  if (!secret) {
    return false;
  }

  try {
    const secretKey = new TextEncoder().encode(secret);
    const { payload } = await jose.jwtVerify(token, secretKey);

    // Check that it's a session token
    if (payload.type !== 'session') {
      return false;
    }

    return true;
  } catch (error) {
    // Token invalid, expired, or tampered with
    return false;
  }
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Check if this is a protected route
  const isProtectedRoute = protectedRoutes.some(route => pathname.startsWith(route));

  if (!isProtectedRoute) {
    return NextResponse.next();
  }

  // Get auth cookie
  const authCookie = request.cookies.get(SESSION_COOKIE_NAME);

  if (!authCookie?.value) {
    // No cookie - redirect to login
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Verify the token is valid (not just that it exists)
  const isValid = await verifySession(authCookie.value, request);

  if (!isValid) {
    // Invalid token - clear cookie and redirect to login
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', pathname);
    const response = NextResponse.redirect(loginUrl);
    response.cookies.delete(SESSION_COOKIE_NAME);
    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api (API routes)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    '/((?!api|_next/static|_next/image|favicon.ico).*)',
  ],
};
