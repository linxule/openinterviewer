// GET /api/auth/oauth/github/callback - Handle GitHub OAuth callback
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
  getGitHubOAuthClient,
  isOAuthProviderConfigured,
  OAUTH_RETURN_COOKIE_NAME,
  POST_ONBOARDING_RETURN_COOKIE_NAME,
  oauthRedirectUrl,
  selectVerifiedGitHubEmail,
} from '@/lib/hostedOAuth';

export async function GET(request: Request) {
  if (!isHostedMode() || !isOAuthProviderConfigured('github')) {
    return NextResponse.json(
      { error: 'OAuth is only available in hosted mode' },
      { status: 404 }
    );
  }

  const baseUrl = getAppBaseUrl();

  const rateLimit = await oauthRateLimitResponse(request, 'oauth-github-callback', 30);
  if (rateLimit) return rateLimit;

  try {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');

    if (!code || !state) {
      return NextResponse.redirect(oauthRedirectUrl('missing_params'));
    }

    const cookieStore = await cookies();
    const storedState = cookieStore.get('github_oauth_state')?.value;
    const requestedRedirectPath = cookieStore.get(OAUTH_RETURN_COOKIE_NAME)?.value;

    if (!storedState || state !== storedState) {
      return NextResponse.redirect(oauthRedirectUrl('invalid_state'));
    }

    cookieStore.delete('github_oauth_state');
    cookieStore.delete(OAUTH_RETURN_COOKIE_NAME);

    const github = getGitHubOAuthClient();
    const tokens = await github.validateAuthorizationCode(code);
    const accessToken = tokens.accessToken();

    const githubUser = await fetchJsonBounded<{
      id?: unknown;
      login?: unknown;
      name?: unknown;
      avatar_url?: unknown;
    }>('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });

    const emails = await fetchJsonBounded<Array<{
      email?: unknown;
      primary?: unknown;
      verified?: unknown;
    }>>('https://api.github.com/user/emails', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });

    const email = selectVerifiedGitHubEmail(emails);
    if (!email) {
      return NextResponse.redirect(oauthRedirectUrl('email_unverified'));
    }

    const oauthId = typeof githubUser.id === 'number' || typeof githubUser.id === 'string'
      ? String(githubUser.id)
      : '';
    const login = typeof githubUser.login === 'string' ? githubUser.login : '';
    const name = typeof githubUser.name === 'string' && githubUser.name.trim()
      ? githubUser.name
      : login || email;
    const avatarUrl = typeof githubUser.avatar_url === 'string' ? githubUser.avatar_url : null;

    if (!oauthId) {
      return NextResponse.redirect(oauthRedirectUrl('user_fetch_failed'));
    }

    const result = await completeHostedOAuthLogin({
      provider: 'github',
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
    console.error('GitHub OAuth callback error:', error);
    return NextResponse.redirect(oauthRedirectUrl('oauth_failed'));
  }
}
