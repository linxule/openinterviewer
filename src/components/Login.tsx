'use client';

import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { useRouter, useSearchParams } from 'next/navigation';
import { Lock, Loader2, AlertCircle } from 'lucide-react';
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
      <div className="min-h-screen bg-stone-900 flex items-center justify-center">
        <Loader2 size={24} className="animate-spin text-stone-400" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-stone-900 flex items-center justify-center p-8">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="max-w-sm w-full"
      >
        <div className="bg-stone-800/50 rounded-xl border border-stone-700 p-8">
          <div className="text-center mb-6">
            <div className="w-12 h-12 rounded-full bg-stone-700 flex items-center justify-center mx-auto mb-4">
              <Lock size={24} className="text-stone-300" />
            </div>
            <h1 className="text-xl font-bold text-white">Researcher Login</h1>
            <p className="text-stone-400 text-sm mt-1">
              {mode === 'hosted'
                ? 'Sign in to access your research dashboard'
                : mode === 'standalone'
                  ? 'Enter your admin password to access the dashboard'
                  : 'Sign-in is unavailable because this server is not configured.'}
            </p>
          </div>

          {(error || (mode === 'hosted' && !configReady)) && (
            <div className="flex items-center gap-2 p-3 mb-4 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
              <AlertCircle size={16} className="flex-shrink-0" />
              {error || 'This hosted instance is missing required configuration.'}
            </div>
          )}

          {mode === 'hosted' ? (
            configReady ? (
              <OAuthLogin loading={loading} providers={oauthProviders} returnTo={returnTo} />
            ) : (
              <p className="text-sm text-stone-400 text-center">
                Sign-in is disabled until the operator completes server configuration.
              </p>
            )
          ) : mode === 'standalone' ? (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="password" className="block text-sm font-medium text-stone-300 mb-1">
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter admin password"
                  className="w-full px-4 py-3 rounded-xl bg-stone-800 border border-stone-600 text-stone-100 placeholder-stone-500 focus:outline-none focus:ring-2 focus:ring-stone-500 focus:border-stone-500"
                  autoFocus
                />
              </div>

              <button
                type="submit"
                disabled={!password.trim() || loading}
                className="w-full py-3 bg-stone-600 hover:bg-stone-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-colors flex items-center justify-center gap-2"
              >
                {loading ? (
                  <>
                    <Loader2 size={18} className="animate-spin" />
                    Logging in...
                  </>
                ) : (
                  'Login'
                )}
              </button>
            </form>
          ) : null}

          <div className="mt-6 pt-6 border-t border-stone-700 text-center">
            <button
              onClick={() => router.push('/')}
              className="text-sm text-stone-400 hover:text-stone-300 transition-colors"
            >
              Back home
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
};

export default Login;
