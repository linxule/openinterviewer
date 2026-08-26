'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import type { AIProviderType, ResearcherProfile } from '@/types';
import { PROVIDER_OPTIONS } from '@/lib/providerRegistry';
import { Button, Coordinate, Label } from '@/components/ui';

type Step = 'welcome' | 'ai-keys' | 'redis' | 'done';
const STEPS: Step[] = ['welcome', 'ai-keys', 'redis', 'done'];
const STEP_LABELS: Record<Step, string> = {
  welcome: 'Welcome',
  'ai-keys': 'AI API Key',
  redis: 'Upstash Redis',
  done: 'Done',
};

interface ValidationState {
  loading: boolean;
  valid: boolean | null;
  error: string | null;
}

type CredentialField = 'geminiApiKey' | 'anthropicApiKey' | 'openAiApiKey' | 'openRouterApiKey';
type ProviderProfileField = 'hasGeminiKey' | 'hasAnthropicKey' | 'hasOpenAiKey' | 'hasOpenRouterKey';

type OnboardingProfile = Partial<Pick<
  ResearcherProfile,
  'name' | 'hasGeminiKey' | 'hasAnthropicKey' | 'hasOpenAiKey' | 'hasOpenRouterKey'
>>;

type ProviderSetup = {
  id: AIProviderType;
  credentialField: CredentialField;
  profileField: ProviderProfileField;
  label: string;
  summaryLabel: string;
  article: 'a' | 'an';
  inputId: string;
  placeholder: string;
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
    credentialField: 'geminiApiKey',
    profileField: 'hasGeminiKey',
    label: providerLabel('gemini'),
    summaryLabel: 'Gemini',
    article: 'a',
    inputId: 'onboarding-gemini-key',
    placeholder: 'AIza...',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyUrlLabel: 'Google AI Studio',
    steps: ['Sign in with a Google account', 'Create an API key', 'Copy the new key'],
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
    credentialField: 'anthropicApiKey',
    profileField: 'hasAnthropicKey',
    label: providerLabel('claude'),
    summaryLabel: 'Claude',
    article: 'a',
    inputId: 'onboarding-claude-key',
    placeholder: 'sk-ant-...',
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
    credentialField: 'openAiApiKey',
    profileField: 'hasOpenAiKey',
    label: providerLabel('openai'),
    summaryLabel: 'OpenAI',
    article: 'an',
    inputId: 'onboarding-openai-key',
    placeholder: 'sk-...',
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
    credentialField: 'openRouterApiKey',
    profileField: 'hasOpenRouterKey',
    label: providerLabel('openrouter'),
    summaryLabel: 'OpenRouter',
    article: 'an',
    inputId: 'onboarding-openrouter-key',
    placeholder: 'sk-or-v1-...',
    keyUrl: 'https://openrouter.ai/settings/keys',
    keyUrlLabel: 'OpenRouter Keys',
    steps: ['Sign in or create an account', 'Create an API key', 'Copy the new key'],
    guidance: (
      <>
        OpenRouter routes requests to upstream inference providers. OpenInterviewer requires compatible
        zero-data-retention routes and denies provider data collection; a request fails if those restrictions
        cannot be met. Review OpenRouter&apos;s{' '}
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

const Onboarding: React.FC = () => {
  const router = useRouter();
  const [currentStep, setCurrentStep] = useState(0);
  const [profile, setProfile] = useState<OnboardingProfile | null>(null);

  // AI keys state
  const [providerKeys, setProviderKeys] = useState<Record<AIProviderType, string>>(() => initialProviderRecord(() => ''));
  const [providerValidation, setProviderValidation] = useState<Record<AIProviderType, ValidationState>>(
    () => initialProviderRecord(emptyValidationState)
  );

  // Redis state
  const [redisUrl, setRedisUrl] = useState('');
  const [redisToken, setRedisToken] = useState('');
  const [redisValidation, setRedisValidation] = useState<ValidationState>({ loading: false, valid: null, error: null });

  const [saving, setSaving] = useState(false);

  // Expandable guide state
  const [providerGuideOpen, setProviderGuideOpen] = useState<Record<AIProviderType, boolean>>(
    () => initialProviderRecord(() => false)
  );
  const [redisGuideOpen, setRedisGuideOpen] = useState(false);

  // Fetch profile on mount
  useEffect(() => {
    fetch('/api/auth/me')
      .then(res => res.json())
      .then(data => {
        if (data.profile) setProfile(data.profile);
      })
      .catch(() => {});
  }, []);

  const step = STEPS[currentStep];

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

  const [saveError, setSaveError] = useState<string | null>(null);

  const saveAndComplete = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      // Save credentials
      const saveRes = await fetch('/api/onboarding/save-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          redisUrl: redisUrl || undefined,
          redisToken: redisToken || undefined,
          ...Object.fromEntries(AI_PROVIDER_SETUP.map(provider => [
            provider.credentialField,
            providerKeys[provider.id] || undefined,
          ])),
        }),
      });

      if (!saveRes.ok) {
        const data = await saveRes.json().catch(() => ({}));
        setSaveError(data.error || 'Failed to save credentials. Please try again.');
        setSaving(false);
        return;
      }

      // Mark onboarding complete
      const completeRes = await fetch('/api/onboarding/complete', { method: 'POST' });
      const completeData = await completeRes.json().catch(() => ({})) as {
        error?: string;
        redirectPath?: string;
      };
      if (!completeRes.ok) {
        setSaveError(completeData.error || 'Failed to complete onboarding. Please try again.');
        setSaving(false);
        return;
      }

      router.push(completeData.redirectPath || '/studies');
    } catch {
      setSaveError('Connection error. Please try again.');
      setSaving(false);
    }
  };

  const availableProviders = AI_PROVIDER_SETUP.filter(provider =>
    providerValidation[provider.id].valid === true || Boolean(profile?.[provider.profileField])
  );
  const canProceedFromAiKeys = availableProviders.length > 0;
  const canProceedFromRedis = redisValidation.valid;

  return (
    <div className="flex min-h-dvh items-center justify-center bg-paper-0 p-4 sm:p-8">
      <div className="w-full max-w-lg">
        <Coordinate className="mb-8 block">{`Step ${currentStep + 1} of ${STEPS.length} · ${STEP_LABELS[step]}`}</Coordinate>

        <div className="border border-ink-300 bg-paper-1 p-5 md:p-8">
          {step === 'welcome' && (
            <div>
              <div className="mb-6">
                <h1 className="font-sans text-[24px] font-semibold leading-[32px] text-ink-900">
                  Welcome{profile?.name ? `, ${profile.name.split(' ')[0]}` : ''}!
                </h1>
                <p className="mt-3 max-w-measure font-sans text-[15px] leading-[24px] text-ink-700">
                  Let&apos;s get you set up. OpenInterviewer uses a <strong>Bring Your Own Storage</strong> model &mdash;
                  your data stays in your own infrastructure, giving you full control over your research data.
                </p>
              </div>

              <ol className="mb-6">
                <li className="grid grid-cols-[2rem_1fr] gap-3 border-t border-ink-300 py-4">
                  <Coordinate>1</Coordinate>
                  <div>
                    <p className="font-sans text-[15px] font-medium text-ink-900">AI API Key</p>
                    <p className="text-[13px] text-ink-500">A Gemini, Claude, OpenAI, or OpenRouter key</p>
                  </div>
                </li>
                <li className="grid grid-cols-[2rem_1fr] gap-3 border-t border-ink-300 py-4">
                  <Coordinate>2</Coordinate>
                  <div>
                    <p className="font-sans text-[15px] font-medium text-ink-900">Upstash Redis</p>
                    <p className="text-[13px] text-ink-500">Your database for studies and interview records</p>
                  </div>
                </li>
              </ol>

              <div className="bg-paper-2 p-4">
                <Label>How these credentials are handled</Label>
                <p className="mt-2 text-[13px] leading-[20px] text-ink-700">
                  The hosted server receives these credentials over its encrypted connection, stores them
                  encrypted, and decrypts them in memory when it connects on your behalf. The app operator
                  controls the encryption keys and can technically decrypt the stored values. The service can
                  read and write the supplied Redis database, and participant interview content is sent to the
                  AI provider you select. When you select OpenRouter, it also routes that content to an upstream
                  inference provider. You can clear the connection here later; rotate the keys or tokens at their
                  providers to revoke access completely.
                </p>
              </div>
            </div>
          )}

          {step === 'ai-keys' && (
            <div>
              <h2 className="font-sans text-[18px] font-semibold text-ink-900">AI API Key</h2>
              <p className="mb-6 text-[13px] text-ink-500">
                Add and test at least one AI provider key. You can connect more providers for flexibility.
              </p>

              <div className="space-y-6">
                {AI_PROVIDER_SETUP.map(provider => {
                  const validation = providerValidation[provider.id];
                  const guideOpen = providerGuideOpen[provider.id];
                  const configured = Boolean(profile?.[provider.profileField]);
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
                          {configured && validation.valid !== true ? (
                            <span className="text-[13px] text-success">Connected</span>
                          ) : null}
                          <ValidationBadge state={validation} label={provider.label} />
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
                          How to get {provider.article} {provider.summaryLabel} API key
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
          )}

          {step === 'redis' && (
            <div>
              <h2 className="font-sans text-[18px] font-semibold text-ink-900">Upstash Redis</h2>
              <p className="mb-6 text-[13px] text-ink-500">
                Your studies and interview data will be stored in your own Upstash Redis database.
                Choose a plan that fits your expected usage.
              </p>

              <div className="space-y-4">
                <div>
                  <label htmlFor="onboarding-redis-url" className="mb-1 block font-sans text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500">
                    REST API URL
                  </label>
                  <input
                    id="onboarding-redis-url"
                    type="text"
                    value={redisUrl}
                    onChange={(e) => { setRedisUrl(e.target.value); setRedisValidation({ loading: false, valid: null, error: null }); }}
                    placeholder="https://your-db.upstash.io"
                    aria-describedby={redisValidation.error ? 'onboarding-redis-error' : undefined}
                    className="w-full bg-paper-2 border border-ink-300 rounded px-3 py-2 text-ink-900 font-sans text-[13px]"
                  />
                </div>

                <div>
                  <label htmlFor="onboarding-redis-token" className="mb-1 block font-sans text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500">
                    REST API Token
                  </label>
                  <input
                    id="onboarding-redis-token"
                    type="password"
                    value={redisToken}
                    onChange={(e) => { setRedisToken(e.target.value); setRedisValidation({ loading: false, valid: null, error: null }); }}
                    placeholder="AXxx..."
                    aria-describedby={redisValidation.error ? 'onboarding-redis-error' : undefined}
                    className="w-full bg-paper-2 border border-ink-300 rounded px-3 py-2 text-ink-900 font-sans text-[13px]"
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <ValidationBadge state={redisValidation} label="Redis connection" />
                    {redisValidation.valid && <span className="text-[13px] text-success">Connected</span>}
                    {redisValidation.error && (
                      <span id="onboarding-redis-error" role="alert" className="text-[13px] text-error">
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
                    How to set up Upstash Redis
                  </button>

                  {redisGuideOpen && (
                    <div className="mt-2 space-y-2 bg-paper-2 p-4 text-[13px]">
                      <ol className="list-inside list-decimal space-y-1 text-ink-700">
                        <li>Go to <a href="https://console.upstash.com" target="_blank" rel="noopener noreferrer" className="text-action underline underline-offset-2">console.upstash.com</a> and sign up with Google/GitHub</li>
                        <li>Click &quot;+ Create Database&quot;</li>
                        <li>Choose Regional (recommended), select nearest region</li>
                        <li>Select the plan that fits your expected usage</li>
                        <li>After creation, go to database details → REST API section</li>
                        <li>Copy REST URL (https://*.upstash.io) and REST Token</li>
                      </ol>
                      <div className="mt-2 flex items-start gap-1.5 text-error">
                        <span>⚠</span>
                        <span>Use the REST URL (https://), not the regular Redis URL (redis://)</span>
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
          )}

          {step === 'done' && (
            <div>
              <h2 className="font-sans text-[18px] font-semibold text-ink-900">You&apos;re all set!</h2>
              <p className="mb-6 text-[13px] text-ink-500">
                Your credentials have been encrypted and stored by the hosted platform.
                You&apos;re ready to create your first study.
              </p>

              <div className="mb-6">
                <div className="border-t border-ink-300 py-2 font-sans text-[13px] text-ink-900">
                  AI: {availableProviders.map(provider => provider.summaryLabel).join(' + ')}
                </div>
                <div className="border-t border-ink-300 py-2 font-sans text-[13px] text-ink-900">
                  Storage: Upstash Redis connected
                </div>
              </div>

              {saveError && (
                <div role="alert" className="mb-4 border-l-2 border-error bg-paper-2 px-4 py-3">
                  <p className="text-[13px] text-ink-700">{saveError}</p>
                </div>
              )}

              <Button
                variant="primary"
                className="w-full"
                onClick={saveAndComplete}
                disabled={saving}
              >
                {saving ? 'Saving...' : 'Create Your First Study'}
              </Button>
            </div>
          )}

          {/* Navigation */}
          {step !== 'done' && (
            <div className="mt-8 flex justify-between border-t border-ink-300 pt-6">
              <button
                onClick={() => setCurrentStep(Math.max(0, currentStep - 1))}
                disabled={currentStep === 0}
                className="min-h-11 font-sans text-[13px] text-ink-500 hover:text-ink-900 disabled:opacity-30"
              >
                Back
              </button>
              <button
                onClick={() => setCurrentStep(currentStep + 1)}
                disabled={
                  (step === 'ai-keys' && !canProceedFromAiKeys) ||
                  (step === 'redis' && !canProceedFromRedis)
                }
                className="min-h-11 font-sans text-[13px] text-action disabled:opacity-30"
              >
                {step === 'welcome' ? 'Get Started' : 'Next'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Onboarding;
