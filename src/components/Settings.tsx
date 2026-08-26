'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import type { AIProviderType, ResearcherProfile } from '@/types';
import { PROVIDER_OPTIONS } from '@/lib/providerRegistry';
import { Button, Coordinate, Label, Rule } from '@/components/ui';
import { cn } from '@/lib/cn';

interface ValidationState {
  loading: boolean;
  valid: boolean | null;
  error: string | null;
}

type ProviderProfileField = 'hasGeminiKey' | 'hasAnthropicKey' | 'hasOpenAiKey' | 'hasOpenRouterKey';
type CredentialField = 'geminiApiKey' | 'anthropicApiKey' | 'openAiApiKey' | 'openRouterApiKey';
type CredentialTarget = 'gemini' | 'anthropic' | 'openai' | 'openrouter';

type ProviderSetup = {
  id: AIProviderType;
  label: string;
  statusLabel: string;
  inputId: string;
  placeholder: string;
  profileField: ProviderProfileField;
  credentialField: CredentialField;
  clearTarget: CredentialTarget;
  keyUrl: string;
  keyUrlLabel: string;
  steps: string[];
  guidance: React.ReactNode;
};

const providerLabel = (provider: AIProviderType) =>
  PROVIDER_OPTIONS.find(option => option.id === provider)!.label;

const AI_PROVIDER_SETUP: ProviderSetup[] = [
  {
    id: 'gemini',
    label: providerLabel('gemini'),
    statusLabel: 'Gemini Key',
    inputId: 'settings-gemini-key',
    placeholder: 'AIza...',
    profileField: 'hasGeminiKey',
    credentialField: 'geminiApiKey',
    clearTarget: 'gemini',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyUrlLabel: 'Google AI Studio',
    steps: ['Sign in and create an API key', 'Copy the new key'],
    guidance: (
      <>
        Pricing, free-tier availability, and rate limits vary by model and account. Check Google&apos;s current{' '}
        <a href="https://ai.google.dev/gemini-api/docs/pricing" target="_blank" rel="noopener noreferrer" className="text-action underline underline-offset-2">pricing</a>
        {' '}and{' '}
        <a href="https://ai.google.dev/gemini-api/docs/rate-limits" target="_blank" rel="noopener noreferrer" className="text-action underline underline-offset-2">rate-limit documentation</a>.
      </>
    ),
  },
  {
    id: 'claude',
    label: providerLabel('claude'),
    statusLabel: 'Claude Key',
    inputId: 'settings-claude-key',
    placeholder: 'sk-ant-...',
    profileField: 'hasAnthropicKey',
    credentialField: 'anthropicApiKey',
    clearTarget: 'anthropic',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyUrlLabel: 'Anthropic Console',
    steps: ['Sign in or create an account', 'Create an API key', 'Copy the new key'],
    guidance: (
      <>
        Credits, billing requirements, pricing, and usage limits vary. Check the Anthropic console and{' '}
        <a href="https://platform.claude.com/docs/en/about-claude/pricing" target="_blank" rel="noopener noreferrer" className="text-action underline underline-offset-2">current pricing documentation</a>.
      </>
    ),
  },
  {
    id: 'openai',
    label: providerLabel('openai'),
    statusLabel: 'OpenAI Key',
    inputId: 'settings-openai-key',
    placeholder: 'sk-...',
    profileField: 'hasOpenAiKey',
    credentialField: 'openAiApiKey',
    clearTarget: 'openai',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyUrlLabel: 'OpenAI Platform',
    steps: ['Sign in or create an account', 'Create a new secret key', 'Copy the key before leaving the page'],
    guidance: (
      <>
        API billing, model access, and usage limits depend on your account. Check OpenAI&apos;s current{' '}
        <a href="https://developers.openai.com/api/docs/pricing" target="_blank" rel="noopener noreferrer" className="text-action underline underline-offset-2">API pricing</a>.
      </>
    ),
  },
  {
    id: 'openrouter',
    label: providerLabel('openrouter'),
    statusLabel: 'OpenRouter Key',
    inputId: 'settings-openrouter-key',
    placeholder: 'sk-or-v1-...',
    profileField: 'hasOpenRouterKey',
    credentialField: 'openRouterApiKey',
    clearTarget: 'openrouter',
    keyUrl: 'https://openrouter.ai/settings/keys',
    keyUrlLabel: 'OpenRouter Keys',
    steps: ['Sign in or create an account', 'Create an API key', 'Copy the new key'],
    guidance: (
      <>
        OpenRouter routes requests to upstream inference providers. OpenInterviewer requires compatible
        zero-data-retention routes and denies provider data collection; requests fail if those restrictions cannot
        be met. Review OpenRouter&apos;s{' '}
        <a href="https://openrouter.ai/docs/guides/features/zdr" target="_blank" rel="noopener noreferrer" className="text-action underline underline-offset-2">privacy and ZDR documentation</a>.
      </>
    ),
  },
];

const emptyValidationState = (): ValidationState => ({ loading: false, valid: null, error: null });

const initialProviderRecord = <T,>(create: () => T): Record<AIProviderType, T> => ({
  gemini: create(),
  claude: create(),
  openai: create(),
  openrouter: create(),
});

const StatusIcon: React.FC<{ configured: boolean }> = ({ configured }) => (
  <span
    aria-hidden="true"
    className={cn('font-sans text-[13px]', configured ? 'text-success' : 'text-ink-500')}
  >
    {configured ? 'Configured' : 'Not configured'}
  </span>
);

const ValidationBadge: React.FC<{ state: ValidationState; label: string }> = ({ state, label }) => {
  if (state.loading) return (
    <span role="status" aria-live="polite">
      <span aria-hidden="true" className="font-sans text-[13px] text-ink-500">Testing…</span>
      <span className="sr-only">Testing {label} key</span>
    </span>
  );
  if (state.valid === true) return (
    <span role="status" aria-live="polite">
      <span aria-hidden="true" className="font-sans text-[13px] text-success">Valid</span>
      <span className="sr-only">{label} key validated</span>
    </span>
  );
  if (state.valid === false) return <span aria-hidden="true" className="font-sans text-[13px] text-error">Invalid</span>;
  return null;
};

const Settings: React.FC = () => {
  const router = useRouter();
  const [profile, setProfile] = useState<ResearcherProfile | null>(null);
  const [mode, setMode] = useState<'hosted' | 'standalone' | null>(null);
  const [loading, setLoading] = useState(true);

  // Form state
  const [providerKeys, setProviderKeys] = useState<Record<AIProviderType, string>>(() => initialProviderRecord(() => ''));
  const [redisUrl, setRedisUrl] = useState('');
  const [redisToken, setRedisToken] = useState('');

  // Validation state
  const [providerValidation, setProviderValidation] = useState<Record<AIProviderType, ValidationState>>(
    () => initialProviderRecord(emptyValidationState)
  );
  const [redisValidation, setRedisValidation] = useState<ValidationState>({ loading: false, valid: null, error: null });

  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lifecycleBusy, setLifecycleBusy] = useState<string | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');

  // Expandable guide state
  const [providerGuideOpen, setProviderGuideOpen] = useState<Record<AIProviderType, boolean>>(
    () => initialProviderRecord(() => false)
  );
  const [redisGuideOpen, setRedisGuideOpen] = useState(false);

  useEffect(() => {
    fetch('/api/config/readiness')
      .then(res => res.json())
      .then(async data => {
        const deploymentMode = data.mode === 'hosted' ? 'hosted' : 'standalone';
        setMode(deploymentMode);
        if (deploymentMode === 'hosted') {
          const profileResponse = await fetch('/api/auth/me');
          const profileData = await profileResponse.json();
          if (profileData.profile) setProfile(profileData.profile);
        }
      })
      .catch(() => setMode(null))
      .finally(() => setLoading(false));
  }, []);

  const refreshProfile = async () => {
    const response = await fetch('/api/auth/me', { cache: 'no-store' });
    const data = await response.json();
    if (data.profile) setProfile(data.profile);
  };

  const validateAiKey = async (provider: AIProviderType, apiKey: string) => {
    setProviderValidation(current => ({
      ...current,
      [provider]: { loading: true, valid: null, error: null },
    }));

    try {
      const res = await fetch('/api/onboarding/validate-ai-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, apiKey }),
      });
      const data = await res.json();
      setProviderValidation(current => ({
        ...current,
        [provider]: { loading: false, valid: data.valid === true, error: data.error || null },
      }));
    } catch {
      setProviderValidation(current => ({
        ...current,
        [provider]: { loading: false, valid: false, error: 'Validation failed' },
      }));
    }
  };

  const validateRedis = async () => {
    setRedisValidation({ loading: true, valid: null, error: null });
    try {
      const res = await fetch('/api/onboarding/validate-redis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redisUrl, redisToken }),
      });
      const data = await res.json();
      setRedisValidation({ loading: false, valid: data.valid, error: data.error || null });
    } catch {
      setRedisValidation({ loading: false, valid: false, error: 'Validation failed' });
    }
  };

  const hasChanges = Object.values(providerKeys).some(Boolean) || Boolean(redisUrl && redisToken);

  const handleSave = async () => {
    setSaving(true);
    setSaveSuccess(false);
    setSaveError(null);

    try {
      const body: Record<string, string> = {};
      for (const provider of AI_PROVIDER_SETUP) {
        const apiKey = providerKeys[provider.id];
        if (apiKey) body[provider.credentialField] = apiKey;
      }
      if (redisUrl && redisToken) {
        body.redisUrl = redisUrl;
        body.redisToken = redisToken;
      }

      if (Object.keys(body).length === 0) {
        setSaving(false);
        return;
      }

      const res = await fetch('/api/onboarding/save-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        setSaveSuccess(true);
        // Refresh profile
        await refreshProfile();
        // Clear form fields
        setProviderKeys(initialProviderRecord(() => ''));
        setProviderValidation(initialProviderRecord(emptyValidationState));
        setRedisUrl('');
        setRedisToken('');
        setTimeout(() => setSaveSuccess(false), 3000);
      } else {
        const data = await res.json().catch(() => ({}));
        setSaveError(data.error || 'Failed to save changes. Please try again.');
      }
    } catch {
      setSaveError('Connection error. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const clearCredential = async (
    target: CredentialTarget | 'redis' | 'all',
    label: string
  ) => {
    if (!window.confirm(`Clear ${label}? Active studies that depend on it may stop working.`)) return;
    setLifecycleBusy(target);
    setSaveError(null);
    setSaveSuccess(false);
    try {
      const response = await fetch('/api/account/credentials', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Failed to clear credential');
      const provider = AI_PROVIDER_SETUP.find(option => option.clearTarget === target);
      if (provider) {
        setProviderKeys(current => ({ ...current, [provider.id]: '' }));
        setProviderValidation(current => ({ ...current, [provider.id]: emptyValidationState() }));
      } else if (target === 'redis') {
        setRedisUrl('');
        setRedisToken('');
        setRedisValidation(emptyValidationState());
      } else if (target === 'all') {
        setProviderKeys(initialProviderRecord(() => ''));
        setProviderValidation(initialProviderRecord(emptyValidationState));
        setRedisUrl('');
        setRedisToken('');
        setRedisValidation(emptyValidationState());
      }
      await refreshProfile();
      setSaveSuccess(true);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Failed to clear credential');
    } finally {
      setLifecycleBusy(null);
    }
  };

  const deleteAccount = async () => {
    if (!profile || deleteConfirmation.trim().toLowerCase() !== profile.email.toLowerCase()) return;
    setLifecycleBusy('account');
    setSaveError(null);
    try {
      const response = await fetch('/api/account', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation: deleteConfirmation }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Failed to delete account');
      router.replace('/');
      router.refresh();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Failed to delete account');
      setLifecycleBusy(null);
    }
  };

  if (loading) {
    return <p className="font-sans text-[15px] text-ink-500">Loading…</p>;
  }

  if (mode === 'standalone') {
    return (
      <div>
        <h1 className="font-sans text-[24px] font-semibold leading-[32px] text-ink-900">Self-hosted settings</h1>
        <p className="mt-1 font-sans text-[13px] text-ink-500">This instance is configured by its operator.</p>

        <div className="mt-6 space-y-4 bg-paper-2 p-5">
          <p className="font-sans text-[15px] leading-[24px] text-ink-700">
            API keys, Redis credentials, and signing secrets are read from this deployment&apos;s
            environment. They cannot be viewed or changed in the browser.
          </p>
          <p className="font-sans text-[13px] text-ink-500">
            Run <code className="font-mono text-ink-900">npm run setup:check</code> from the project directory,
            then update the named variables in your hosting environment and redeploy.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button type="button" variant="quiet" onClick={() => router.push('/self-host')}>
              Open self-host guide
            </Button>
            <a
              href="/api/health/ready"
              target="_blank"
              rel="noreferrer"
              className="rounded border border-ink-300 bg-transparent px-4 py-2 font-sans text-[15px] font-medium text-ink-900 transition-colors hover:bg-paper-2"
            >
              View readiness status
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-8">
        <h1 className="font-sans text-[24px] font-semibold leading-[32px] text-ink-900">Settings</h1>
        {profile && <Coordinate className="mt-1 block">{profile.email}</Coordinate>}
      </div>

      {/* Current Status */}
      {profile && (
        <div className="mb-6 bg-paper-2 p-5">
          <h2 className="mb-4 font-sans text-[15px] font-semibold text-ink-900">Current Status</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
            {AI_PROVIDER_SETUP.map(provider => (
              <div key={provider.id} className="flex items-center gap-2">
                <StatusIcon configured={Boolean(profile[provider.profileField])} />
                <span className="font-sans text-[13px] text-ink-700">
                  {provider.statusLabel}
                  <span className="sr-only">
                    {profile[provider.profileField] ? ': configured' : ': not configured'}
                  </span>
                </span>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <StatusIcon configured={profile.hasRedisConfigured} />
              <span className="font-sans text-[13px] text-ink-700">
                Redis Storage
                <span className="sr-only">
                  {profile.hasRedisConfigured ? ': configured' : ': not configured'}
                </span>
              </span>
            </div>
          </div>
        </div>
      )}

      {profile && !profile.onboardingComplete && (
        <div className="mb-6 border-l-2 border-ink-500 bg-paper-2 px-4 py-3">
          <Label>Setup incomplete</Label>
          <p className="mt-1 text-[13px] text-ink-700">
            Storage and at least one valid AI key are required before studies can run.
          </p>
          <button
            type="button"
            onClick={() => router.push('/onboarding')}
            className="mt-2 font-sans text-[13px] text-action underline underline-offset-2"
          >
            Finish setup
          </button>
        </div>
      )}

      <div className="mb-6 bg-paper-2 p-5">
        <Label>How hosted BYOS credentials are handled</Label>
        <p className="mt-2 max-w-measure font-sans text-[13px] leading-[20px] text-ink-700">
          OpenInterviewer stores your Redis and AI credentials encrypted in the platform database.
          The hosted server decrypts them in memory when connecting on your behalf, and the app operator
          controls the encryption keys and therefore can technically decrypt stored values. The service can
          read and write your supplied Redis database; participant interview content is sent to the AI provider
          selected for a study. OpenRouter also routes that content to an upstream inference provider and is
          constrained to compatible zero-data-retention, no-data-collection routes. Secrets are never returned
          to this page. Rotate a credential by entering its replacement below, clear it here to disconnect the
          app, and rotate it at the provider to revoke access completely.
        </p>
      </div>

      <Rule />

      {/* AI API Keys */}
      <div className="my-6 space-y-4">
        <h2 className="font-sans text-[15px] font-semibold text-ink-900">AI API Keys</h2>
        <p className="font-sans text-[13px] text-ink-500">
          Update your API keys. Leave blank to keep the current key.
        </p>

        <div className="space-y-6">
          {AI_PROVIDER_SETUP.map(provider => {
            const validation = providerValidation[provider.id];
            const configured = Boolean(profile?.[provider.profileField]);
            const guideOpen = providerGuideOpen[provider.id];
            const errorId = `${provider.inputId}-error`;
            return (
              <div key={provider.id}>
                <div className="mb-1 flex items-center justify-between">
                  <label
                    htmlFor={provider.inputId}
                    className="font-sans text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500"
                  >
                    {provider.label} API Key
                  </label>
                  <div className="flex items-center gap-2">
                    <ValidationBadge state={validation} label={provider.label} />
                    {configured ? (
                      <button
                        type="button"
                        onClick={() => clearCredential(provider.clearTarget, `the ${provider.label} key`)}
                        disabled={Boolean(lifecycleBusy)}
                        className="font-sans text-[13px] text-error hover:text-ink-900 disabled:opacity-50"
                      >
                        {lifecycleBusy === provider.clearTarget ? 'Clearing…' : 'Clear'}
                      </button>
                    ) : null}
                  </div>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    id={provider.inputId}
                    type="password"
                    value={providerKeys[provider.id]}
                    onChange={(event) => {
                      setProviderKeys(current => ({ ...current, [provider.id]: event.target.value }));
                      setProviderValidation(current => ({ ...current, [provider.id]: emptyValidationState() }));
                    }}
                    placeholder={configured ? '(currently set)' : provider.placeholder}
                    autoComplete="new-password"
                    aria-describedby={validation.error ? errorId : undefined}
                    className="min-w-0 flex-1 bg-paper-2 border border-ink-300 rounded px-3 py-2 text-ink-900 font-sans text-[13px]"
                  />
                  <Button
                    type="button"
                    variant="quiet"
                    className="text-[13px]"
                    onClick={() => validateAiKey(provider.id, providerKeys[provider.id])}
                    disabled={!providerKeys[provider.id] || validation.loading}
                  >
                    {validation.loading ? 'Testing…' : 'Test'}
                  </Button>
                </div>
                {validation.error ? (
                  <p id={errorId} role="alert" className="mt-1 text-[13px] text-error">
                    {validation.error}
                  </p>
                ) : null}

                <div className="mt-2">
                  <button
                    type="button"
                    aria-expanded={guideOpen}
                    onClick={() => setProviderGuideOpen(current => ({
                      ...current,
                      [provider.id]: !current[provider.id],
                    }))}
                    className="font-sans text-[13px] text-ink-500 hover:text-ink-900"
                  >
                    {provider.label} setup guide
                  </button>

                  {guideOpen ? (
                    <div className="mt-2 space-y-2 bg-paper-2 p-4 text-[13px]">
                      <ol className="list-inside list-decimal space-y-1 text-ink-700">
                        <li>
                          Open{' '}
                          <a href={provider.keyUrl} target="_blank" rel="noopener noreferrer" className="text-action underline underline-offset-2">
                            {provider.keyUrlLabel}
                          </a>
                        </li>
                        {provider.steps.map(instruction => <li key={instruction}>{instruction}</li>)}
                      </ol>
                      <p className="mt-2 text-ink-500">{provider.guidance}</p>
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <Rule />

      {/* Redis Storage */}
      <div className="my-6 space-y-4">
        <div className="flex items-center gap-2">
          <h2 className="font-sans text-[15px] font-semibold text-ink-900">Upstash Redis Storage</h2>
          {profile?.hasRedisConfigured && (
            <button
              type="button"
              onClick={() => clearCredential('redis', 'the Redis connection')}
              disabled={!!lifecycleBusy}
              className="ml-auto font-sans text-[13px] text-error hover:text-ink-900 disabled:opacity-50"
            >
              Clear connection
            </button>
          )}
        </div>
        <p className="font-sans text-[13px] text-ink-500">
          Update your Redis credentials. Leave blank to keep the current connection.
          <span className="text-error"> Warning: changing your Redis URL will disconnect from your current data.</span>
          <span className="mt-1 block">Clearing this connection never deletes data from the external Redis database.</span>
        </p>

        <div className="space-y-4">
          <div>
            <label htmlFor="settings-redis-url" className="mb-1 block font-sans text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500">
              REST API URL
            </label>
            <input
              id="settings-redis-url"
              type="text"
              value={redisUrl}
              onChange={(e) => { setRedisUrl(e.target.value); setRedisValidation({ loading: false, valid: null, error: null }); }}
              placeholder={profile?.hasRedisConfigured ? '(currently set)' : 'https://your-db.upstash.io'}
              aria-describedby={redisValidation.error ? 'settings-redis-error' : undefined}
              className="w-full bg-paper-2 border border-ink-300 rounded px-3 py-2 text-ink-900 font-sans text-[13px]"
            />
          </div>
          <div>
            <label htmlFor="settings-redis-token" className="mb-1 block font-sans text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500">
              REST API Token
            </label>
            <input
              id="settings-redis-token"
              type="password"
              value={redisToken}
              onChange={(e) => { setRedisToken(e.target.value); setRedisValidation({ loading: false, valid: null, error: null }); }}
              placeholder={profile?.hasRedisConfigured ? '(currently set)' : 'AXxx...'}
              aria-describedby={redisValidation.error ? 'settings-redis-error' : undefined}
              className="w-full bg-paper-2 border border-ink-300 rounded px-3 py-2 text-ink-900 font-sans text-[13px]"
            />
          </div>
          <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <ValidationBadge state={redisValidation} label="Redis connection" />
              {redisValidation.valid && <span className="text-[13px] text-success">Connected</span>}
              {redisValidation.error && (
                <span id="settings-redis-error" role="alert" className="text-[13px] text-error">
                  {redisValidation.error}
                </span>
              )}
            </div>
            <Button
              variant="quiet"
              className="text-[13px]"
              onClick={validateRedis}
              disabled={!redisUrl || !redisToken || redisValidation.loading}
            >
              {redisValidation.loading ? 'Testing...' : 'Test Connection'}
            </Button>
          </div>

          {/* Expandable setup guide */}
          <div>
            <button
              onClick={() => setRedisGuideOpen(!redisGuideOpen)}
              className="font-sans text-[13px] text-ink-500 hover:text-ink-900"
            >
              Setup guide
            </button>

            {redisGuideOpen && (
              <div className="mt-2 space-y-2 bg-paper-2 p-4 text-[13px]">
                <ol className="list-inside list-decimal space-y-1 text-ink-700">
                  <li>Go to <a href="https://console.upstash.com" target="_blank" rel="noopener noreferrer" className="text-action underline underline-offset-2">console.upstash.com</a> and sign in</li>
                  <li>Click &quot;+ Create Database&quot; and choose the plan that fits your expected usage</li>
                  <li>After creation, go to database details → REST API section</li>
                  <li>Copy REST URL (https://*.upstash.io) and REST Token</li>
                </ol>
                <div className="mt-2 flex items-start gap-1.5 text-error">
                  <span>⚠</span>
                  <span>Use REST URL (https://), not regular URL (redis://)</span>
                </div>
                <p className="text-ink-500">
                  Plan availability, pricing, and limits vary. Check Upstash&apos;s current{' '}
                  <a href="https://upstash.com/pricing/redis" target="_blank" rel="noopener noreferrer" className="text-action underline underline-offset-2">Redis pricing</a>.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Partial Redis warning */}
      {((redisUrl && !redisToken) || (!redisUrl && redisToken)) && (
        <div className="mb-6 border-l-2 border-error bg-paper-2 px-4 py-3">
          <p className="text-[13px] text-ink-700">
            Both Redis URL and token are required to update storage credentials.
          </p>
        </div>
      )}

      <Rule />

      <div className="my-6 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          {saveSuccess && (
            <span role="status" aria-live="polite" className="text-[13px] text-success">
              Saved successfully
            </span>
          )}
          {saveError && (
            <span role="alert" className="text-[13px] text-error">
              {saveError}
            </span>
          )}
        </div>
        <Button variant="primary" onClick={handleSave} disabled={saving || !hasChanges}>
          {saving ? 'Saving...' : 'Validate & rotate'}
        </Button>
      </div>

      {profile && (
        <div id="account" className="mt-8 border-l-2 border-error bg-paper-2 px-4 py-4">
          <h2 className="mb-2 font-sans text-[15px] font-semibold text-ink-900">Delete platform account</h2>
          <p className="mb-4 font-sans text-[13px] leading-[20px] text-ink-700">
            This removes your hosted account, encrypted credentials, and platform routing metadata.
            It does not delete studies, interviews, or any other data in your external Upstash Redis database.
            Manage or delete that external data directly in Upstash.
          </p>
          <label htmlFor="delete-account-confirmation" className="mb-1 block font-sans text-[13px] text-ink-500">
            Enter {profile.email} to confirm
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id="delete-account-confirmation"
              type="text"
              value={deleteConfirmation}
              onChange={(event) => setDeleteConfirmation(event.target.value)}
              autoComplete="off"
              className="min-w-0 flex-1 bg-paper-2 border border-ink-300 rounded px-3 py-2 text-ink-900 font-sans text-[13px]"
            />
            <Button
              type="button"
              variant="destructive"
              onClick={deleteAccount}
              disabled={
                lifecycleBusy === 'account'
                || deleteConfirmation.trim().toLowerCase() !== profile.email.toLowerCase()
              }
            >
              {lifecycleBusy === 'account' ? 'Deleting…' : 'Delete account'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

export default Settings;
