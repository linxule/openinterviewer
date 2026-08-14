// GET /api/auth/oauth/google/callback - Handle Google OAuth callback
// Validates the authorization code, creates/finds researcher, sets session

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getAppBaseUrl } from '@/lib/appBaseUrl';
import { isHostedMode } from '@/lib/mode';
import { fetchJsonBounded } from '@/lib/oauthHttp';
import { oauthRateLimitResponse } from '@/lib/oauthRateLimit';
import {
  completeHostedOAuthLogin,
  getGoogleOAuthClient,
  googleVerifiedEmail,
  isOAuthProviderConfigured,
  OAUTH_RETURN_COOKIE_NAME,
  POST_ONBOARDING_RETURN_COOKIE_NAME,
  oauthRedirectUrl,
} from '@/lib/hostedOAuth';

export async function GET(request: Request) {
  if (!isHostedMode() || !isOAuthProviderConfigured('google')) {
    return NextResponse.json(
      { error: 'OAuth is only available in hosted mode' },
      { status: 404 }
    );
  }

  const baseUrl = getAppBaseUrl();

  const rateLimit = await oauthRateLimitResponse(request, 'oauth-google-callback', 30);
  if (rateLimit) return rateLimit;

  try {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');

    if (!code || !state) {
      return NextResponse.redirect(oauthRedirectUrl('missing_params'));
    }

    const cookieStore = await cookies();
    const storedState = cookieStore.get('google_oauth_state')?.value;
    const codeVerifier = cookieStore.get('google_oauth_code_verifier')?.value;
    const requestedRedirectPath = cookieStore.get(OAUTH_RETURN_COOKIE_NAME)?.value;

    if (!storedState || state !== storedState || !codeVerifier) {
      return NextResponse.redirect(oauthRedirectUrl('invalid_state'));
    }

    cookieStore.delete('google_oauth_state');
    cookieStore.delete('google_oauth_code_verifier');
    cookieStore.delete(OAUTH_RETURN_COOKIE_NAME);

    const google = getGoogleOAuthClient();
    const tokens = await google.validateAuthorizationCode(code, codeVerifier);
    const accessToken = tokens.accessToken();

    const googleUser = await fetchJsonBounded<{
      id?: unknown;
      email?: unknown;
      name?: unknown;
      picture?: unknown;
      verified_email?: unknown;
      email_verified?: unknown;
    }>('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const email = googleVerifiedEmail(googleUser);
    if (!email) {
      return NextResponse.redirect(oauthRedirectUrl('email_unverified'));
    }

    const oauthId = typeof googleUser.id === 'string' ? googleUser.id : '';
    const name = typeof googleUser.name === 'string' && googleUser.name.trim()
      ? googleUser.name
      : email;
    const avatarUrl = typeof googleUser.picture === 'string' ? googleUser.picture : null;

    if (!oauthId) {
      return NextResponse.redirect(oauthRedirectUrl('user_fetch_failed'));
    }

    const result = await completeHostedOAuthLogin({
      provider: 'google',
      oauthId,
      email,
      name,
      avatarUrl,
      cookieStore,
      requestedRedirectPath,
    });

    if (!result.ok) {
      return NextResponse.redirect(oauthRedirectUrl(result.error));
    }

    if (result.postOnboardingPath) {
      cookieStore.set(POST_ONBOARDING_RETURN_COOKIE_NAME, result.postOnboardingPath, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 3_600,
        path: '/',
      });
    }
    return NextResponse.redirect(new URL(result.redirectPath, baseUrl));
  } catch (error) {
    console.error('Google OAuth callback error:', error);
    return NextResponse.redirect(oauthRedirectUrl('oauth_failed'));
  }
}
