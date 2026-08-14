// GET /api/auth/oauth/google - Initiate Google OAuth flow
// Redirects user to Google's authorization page
// Only available in hosted mode

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import * as arctic from 'arctic';
import { cookies } from 'next/headers';
import { isHostedMode } from '@/lib/mode';
import { oauthRateLimitResponse } from '@/lib/oauthRateLimit';
import {
  getGoogleOAuthClient,
  isOAuthProviderConfigured,
  normalizeOAuthReturnPath,
  OAUTH_RETURN_COOKIE_NAME,
  oauthRedirectUrl,
} from '@/lib/hostedOAuth';

export async function GET(request: Request) {
  if (!isHostedMode() || !isOAuthProviderConfigured('google')) {
    return NextResponse.json(
      { error: 'OAuth is only available in hosted mode' },
      { status: 404 }
    );
  }

  const rateLimit = await oauthRateLimitResponse(request, 'oauth-google-start', 60);
  if (rateLimit) return rateLimit;

  try {
    const google = getGoogleOAuthClient();
    const state = arctic.generateState();
    const codeVerifier = arctic.generateCodeVerifier();

    const url = google.createAuthorizationURL(state, codeVerifier, [
      'openid',
      'profile',
      'email',
    ]);

    const cookieStore = await cookies();
    cookieStore.set(
      OAUTH_RETURN_COOKIE_NAME,
      normalizeOAuthReturnPath(new URL(request.url).searchParams.get('redirect')),
      {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 600,
        path: '/',
      }
    );
    cookieStore.set('google_oauth_state', state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 600,
      path: '/',
    });
    cookieStore.set('google_oauth_code_verifier', codeVerifier, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 600,
      path: '/',
    });

    return NextResponse.redirect(url);
  } catch (error) {
    console.error('Google OAuth initiation error:', error);
    return NextResponse.redirect(oauthRedirectUrl('oauth_init_failed'));
  }
}
