// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const provisionMock = vi.fn();
const createSessionMock = vi.fn();

vi.mock('@/lib/platformDb', () => ({
  provisionResearcherByOAuth: (...args: unknown[]) => provisionMock(...args),
}));

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return {
    ...actual,
    createSessionToken: (...args: unknown[]) => createSessionMock(...args),
  };
});

import {
  completeHostedOAuthLogin,
  googleVerifiedEmail,
  oauthCallbackUrl,
  normalizeOAuthReturnPath,
  selectVerifiedGitHubEmail,
} from '@/lib/hostedOAuth';

describe('hosted OAuth identity', () => {
  it('accepts only verified Google emails and normalizes them', () => {
    expect(googleVerifiedEmail({ email: 'Ada@Example.com', verified_email: true }))
      .toBe('ada@example.com');
    expect(googleVerifiedEmail({ email: 'ada@example.com', verified_email: false })).toBeNull();
    expect(googleVerifiedEmail({ email: 'ada@example.com' })).toBeNull();
  });

  it('accepts only GitHub primary verified email', () => {
    expect(selectVerifiedGitHubEmail([
      { email: 'old@example.com', primary: true, verified: false },
      { email: 'Ada@Example.com', primary: false, verified: true },
    ])).toBeNull();

    expect(selectVerifiedGitHubEmail([
      { email: 'Ada@Example.com', primary: true, verified: true },
    ])).toBe('ada@example.com');

    expect(selectVerifiedGitHubEmail([
      { email: 'hidden@example.com', primary: true, verified: false },
    ])).toBeNull();
  });

  it('builds callback URLs from APP_BASE_URL', () => {
    expect(oauthCallbackUrl('google', {
      APP_BASE_URL: 'https://research.example',
      NODE_ENV: 'production',
    })).toBe('https://research.example/api/auth/oauth/google/callback');
  });

  it('allows only researcher workspace return paths', () => {
    expect(normalizeOAuthReturnPath('/setup?from=demo')).toBe('/setup?from=demo');
    expect(normalizeOAuthReturnPath('/dashboard/interview/one')).toBe('/dashboard/interview/one');
    expect(normalizeOAuthReturnPath('//evil.example/setup')).toBe('/studies');
    expect(normalizeOAuthReturnPath('/api/account')).toBe('/studies');
  });
});

describe('completeHostedOAuthLogin', () => {
  const cookieStore = { set: vi.fn() };

  beforeEach(() => {
    provisionMock.mockReset();
    createSessionMock.mockReset();
    cookieStore.set.mockReset();
    process.env.DEPLOYMENT_MODE = 'hosted';
    process.env.SESSION_SECRET = 'session-test-secret-value-1234567890';
  });

  it('does not issue a session on conflict or outage', async () => {
    provisionMock.mockResolvedValue({ status: 'conflict' });
    await expect(completeHostedOAuthLogin({
      provider: 'google',
      oauthId: 'g-1',
      email: 'ada@example.com',
      name: 'Ada',
      avatarUrl: null,
      cookieStore,
    })).resolves.toEqual({ ok: false, error: 'account_conflict' });

    provisionMock.mockResolvedValue({ status: 'unavailable' });
    await expect(completeHostedOAuthLogin({
      provider: 'google',
      oauthId: 'g-1',
      email: 'ada@example.com',
      name: 'Ada',
      avatarUrl: null,
      cookieStore,
    })).resolves.toEqual({ ok: false, error: 'platform_unavailable' });

    expect(createSessionMock).not.toHaveBeenCalled();
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it('issues a session only after persistence succeeds', async () => {
    provisionMock.mockResolvedValue({
      status: 'created',
      researcher: { id: 'r-1', onboardingComplete: false },
    });
    createSessionMock.mockResolvedValue('signed-token');

    await expect(completeHostedOAuthLogin({
      provider: 'github',
      oauthId: 'gh-1',
      email: 'ada@example.com',
      name: 'Ada',
      avatarUrl: null,
      cookieStore,
      requestedRedirectPath: '/setup',
    })).resolves.toEqual({
      ok: true,
      redirectPath: '/onboarding',
      postOnboardingPath: '/setup',
    });

    expect(createSessionMock).toHaveBeenCalledWith('r-1');
    expect(cookieStore.set).toHaveBeenCalled();
  });

  it('returns a validated requested path for an already-onboarded account', async () => {
    provisionMock.mockResolvedValue({
      status: 'existing',
      researcher: { id: 'r-2', onboardingComplete: true },
    });
    createSessionMock.mockResolvedValue('signed-token');

    await expect(completeHostedOAuthLogin({
      provider: 'google',
      oauthId: 'g-2',
      email: 'grace@example.com',
      name: 'Grace',
      avatarUrl: null,
      cookieStore,
      requestedRedirectPath: '//evil.example/setup',
    })).resolves.toEqual({
      ok: true,
      redirectPath: '/studies',
      postOnboardingPath: null,
    });
  });
});
