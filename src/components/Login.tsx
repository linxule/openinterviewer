'use client';

import React, { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, Field, Label, Notice, Rule } from '@/components/ui';
import OAuthLogin from './OAuthLogin';

const Login: React.FC = () => {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'standalone' | 'hosted' | null>(null);
  const [oauthProviders, setOauthProviders] = useState<{ google: boolean; github: boolean }>({
    google: false,
    github: false,
  });
  const [configReady, setConfigReady] = useState(true);
  const [modeLoaded, setModeLoaded] = useState(false);
  const rawReturnTo = searchParams.get('redirect') || '/studies';
  const returnTo = rawReturnTo.startsWith('/') && !rawReturnTo.startsWith('//')
    ? rawReturnTo
    : '/studies';

  useEffect(() => {
    fetch('/api/config/readiness')
      .then(res => res.json())
      .then(data => {
        if (data.mode === 'hosted' || data.mode === 'standalone') {
          setMode(data.mode);
        } else {
          setMode(null);
        }
        setOauthProviders({
          google: !!data.oauth?.google,
          github: !!data.oauth?.github,
        });
        setConfigReady(data.ready !== false);
      })
      .catch(() => {
        setMode(null);
        setOauthProviders({ google: false, github: false });
        setConfigReady(false);
      })
      .finally(() => setModeLoaded(true));
  }, []);

  // Check for OAuth error in URL params
  useEffect(() => {
    const oauthError = searchParams.get('error');
    if (oauthError) {
      const errorMessages: Record<string, string> = {
        oauth_init_failed: 'Failed to start sign-in. Please try again.',
        oauth_failed: 'Sign-in failed. Please try again.',
        missing_params: 'Invalid callback. Please try again.',
        invalid_state: 'Session expired. Please try again.',
        user_fetch_failed: 'Failed to get your profile. Please try again.',
        no_email: 'Could not get your email. Make sure your GitHub email is verified.',
        email_unverified: 'A verified email is required to sign in.',
        account_conflict: 'This email is already used with a different sign-in method.',
        platform_unavailable: 'Sign-in is temporarily unavailable. Please try again.',
      };
      setError(errorMessages[oauthError] || 'Sign-in failed. Please try again.');
    }
  }, [searchParams]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || 'Authentication failed');
        return;
      }

      // Redirect to studies on success (validate to prevent open redirect)
      const rawRedirect = searchParams.get('redirect') || '/studies';
      const redirect = rawRedirect.startsWith('/') && !rawRedirect.startsWith('//')
        ? rawRedirect
        : '/studies';
      router.push(redirect);
    } catch {
      setError('Connection error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // Loading state while checking mode
  if (!modeLoaded) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-paper-0">
        <p className="font-sans text-[15px] text-ink-500">Loading…</p>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-paper-0 px-4 py-12">
      <div className="w-full max-w-sm">
        <div>
          <Label>Researcher access</Label>
          <h1 className="font-sans text-[24px] font-semibold leading-[32px] text-ink-900">Researcher Login</h1>
          <p className="mt-1 font-sans text-[13px] text-ink-500">
            {mode === 'hosted'
              ? 'Sign in to access your research dashboard'
              : mode === 'standalone'
                ? 'Enter your admin password to access the dashboard'
                : 'Sign-in is unavailable because this server is not configured.'}
          </p>
        </div>
        <Rule className="my-6" />

        {(error || (mode === 'hosted' && !configReady)) && (
          <Notice tone="error" eyebrow="Sign-in failed" className="mb-4">
            <p className="mt-1 font-sans text-[13px] text-ink-700">
              {error || 'This hosted instance is missing required configuration.'}
            </p>
          </Notice>
        )}

        {mode === 'hosted' ? (
          configReady ? (
            <OAuthLogin loading={loading} providers={oauthProviders} returnTo={returnTo} />
          ) : (
            <p className="font-sans text-[13px] text-ink-500">
              Sign-in is disabled until the operator completes server configuration.
            </p>
          )
        ) : mode === 'standalone' ? (
          <form onSubmit={handleSubmit} className="space-y-4">
            <Field label="Password" htmlFor="password">
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter admin password"
                autoFocus
                className="w-full"
              />
            </Field>

            <Button type="submit" variant="primary" disabled={!password.trim() || loading} className="w-full">
              {loading ? 'Logging in...' : 'Login'}
            </Button>
          </form>
        ) : null}

        <Rule className="mt-6" />
        <button
          type="button"
          onClick={() => router.push('/')}
          className="mt-6 block min-h-11 font-sans text-[13px] text-ink-500 hover:text-ink-900"
        >
          Back home
        </button>
      </div>
    </main>
  );
};

export default Login;
