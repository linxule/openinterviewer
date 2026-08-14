// Hosted OAuth helpers: provider clients, verified identity, session issuance.
// A session is minted only after platform persistence reports found/created.

import * as arctic from 'arctic';
import { getAppBaseUrl } from './appBaseUrl';
import { createSessionToken, getSessionCookieOptions, SESSION_COOKIE_NAME } from './auth';
import { normalizeEmail } from './email';
import { getConfiguredOAuthProviders } from './hostedConfig';
import { provisionResearcherByOAuth } from './platformDb';

export type HostedOAuthProvider = 'google' | 'github';

export const OAUTH_RETURN_COOKIE_NAME = 'oauth_return_to';
export const POST_ONBOARDING_RETURN_COOKIE_NAME = 'post_onboarding_return_to';

export type HostedOAuthError =
  | 'oauth_init_failed'
  | 'oauth_failed'
  | 'missing_params'
  | 'invalid_state'
  | 'user_fetch_failed'
  | 'no_email'
  | 'email_unverified'
  | 'account_conflict'
  | 'platform_unavailable';

type CookieStore = {
  set: (name: string, value: string, options: ReturnType<typeof getSessionCookieOptions>) => void;
};

export function oauthRedirectUrl(error: HostedOAuthError, env: NodeJS.ProcessEnv = process.env): URL {
  return new URL(`/login?error=${error}`, getAppBaseUrl(env));
}

export function oauthCallbackUrl(provider: HostedOAuthProvider, env: NodeJS.ProcessEnv = process.env): string {
  return `${getAppBaseUrl(env)}/api/auth/oauth/${provider}/callback`;
}

export function normalizeOAuthReturnPath(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    return '/studies';
  }
  try {
    const parsed = new URL(value, 'https://openinterviewer.invalid');
    const allowedRoots = ['/studies', '/setup', '/dashboard', '/settings'];
    const allowed = allowedRoots.some(root => parsed.pathname === root || parsed.pathname.startsWith(`${root}/`));
    return parsed.origin === 'https://openinterviewer.invalid' && allowed
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : '/studies';
  } catch {
    return '/studies';
  }
}

export function isOAuthProviderConfigured(
  provider: HostedOAuthProvider,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return getConfiguredOAuthProviders(env)[provider];
}

export function getGoogleOAuthClient(env: NodeJS.ProcessEnv = process.env): arctic.Google {
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET required');
  }
  return new arctic.Google(clientId, clientSecret, oauthCallbackUrl('google', env));
}

export function getGitHubOAuthClient(env: NodeJS.ProcessEnv = process.env): arctic.GitHub {
  const clientId = env.GITHUB_CLIENT_ID;
  const clientSecret = env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET required');
  }
  return new arctic.GitHub(clientId, clientSecret, oauthCallbackUrl('github', env));
}

export function googleVerifiedEmail(user: {
  email?: unknown;
  verified_email?: unknown;
  email_verified?: unknown;
}): string | null {
  const verified = user.verified_email === true || user.email_verified === true;
  if (!verified || typeof user.email !== 'string') return null;
  return normalizeEmail(user.email);
}

export function selectVerifiedGitHubEmail(
  emails: Array<{ email?: unknown; primary?: unknown; verified?: unknown }>
): string | null {
  if (!Array.isArray(emails)) return null;

  let primary: string | null = null;

  for (let i = 0; i < emails.length; i++) {
    const entry = emails[i];
    if (!entry || entry.verified !== true || typeof entry.email !== 'string') continue;
    const normalized = normalizeEmail(entry.email);
    if (!normalized) continue;
    if (entry.primary === true && !primary) {
      primary = normalized;
    }
  }

  return primary;
}

export async function completeHostedOAuthLogin(input: {
  provider: HostedOAuthProvider;
  oauthId: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  cookieStore: CookieStore;
  requestedRedirectPath?: string;
}): Promise<
  | { ok: true; redirectPath: string; postOnboardingPath: string | null }
  | { ok: false; error: HostedOAuthError }
> {
  const email = normalizeEmail(input.email);
  const oauthId = input.oauthId.trim();
  const name = input.name.trim();
  if (!email || !oauthId || !name) {
    return { ok: false, error: 'no_email' };
  }

  const provisioned = await provisionResearcherByOAuth({
    provider: input.provider,
    oauthId,
    email,
    name,
    avatarUrl: input.avatarUrl,
  });

  if (provisioned.status === 'conflict') {
    return { ok: false, error: 'account_conflict' };
  }
  if (provisioned.status === 'unavailable') {
    return { ok: false, error: 'platform_unavailable' };
  }

  const sessionToken = await createSessionToken(provisioned.researcher.id);
  input.cookieStore.set(SESSION_COOKIE_NAME, sessionToken, getSessionCookieOptions());

  const requestedRedirectPath = normalizeOAuthReturnPath(input.requestedRedirectPath);
  return {
    ok: true,
    redirectPath: provisioned.researcher.onboardingComplete ? requestedRedirectPath : '/onboarding',
    postOnboardingPath: provisioned.researcher.onboardingComplete ? null : requestedRedirectPath,
  };
}
