import type { ReactNode } from 'react';
import type { AIProviderType } from '@/types';
import { PROVIDER_OPTIONS } from '@/lib/providerRegistry';
import { ExternalLink } from '@/components/ui';

export interface ValidationState {
  loading: boolean;
  valid: boolean | null;
  error: string | null;
}

export type ProviderProfileField = 'hasGeminiKey' | 'hasAnthropicKey' | 'hasOpenAiKey' | 'hasOpenRouterKey';
export type CredentialField = 'geminiApiKey' | 'anthropicApiKey' | 'openAiApiKey' | 'openRouterApiKey';
export type CredentialTarget = 'gemini' | 'anthropic' | 'openai' | 'openrouter';

export interface ProviderSetup {
  id: AIProviderType;
  /** Full product name, from PROVIDER_OPTIONS. */
  label: string;
  /** Short name for status rows and guide triggers: Gemini · Claude · OpenAI · OpenRouter. */
  shortLabel: string;
  article: 'a' | 'an';
  placeholder: string;
  profileField: ProviderProfileField;
  credentialField: CredentialField;
  clearTarget: CredentialTarget;
  keyUrl: string;
  keyUrlLabel: string;
  steps: string[];
  guidance: ReactNode;
}

const providerLabel = (provider: AIProviderType) =>
  PROVIDER_OPTIONS.find(option => option.id === provider)!.label;

export const AI_PROVIDER_SETUP: ProviderSetup[] = [
  {
    id: 'gemini',
    label: providerLabel('gemini'),
    shortLabel: 'Gemini',
    article: 'a',
    placeholder: 'AIza...',
    profileField: 'hasGeminiKey',
    credentialField: 'geminiApiKey',
    clearTarget: 'gemini',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyUrlLabel: 'Google AI Studio',
    steps: ['Sign in with a Google account', 'Create an API key', 'Copy the new key'],
    guidance: (
      <>
        Pricing, free-tier availability, and rate limits vary by model and account. Check Google&apos;s current{' '}
        <ExternalLink href="https://ai.google.dev/gemini-api/docs/pricing" className="text-action underline underline-offset-2">pricing</ExternalLink>
        {' '}and{' '}
        <ExternalLink href="https://ai.google.dev/gemini-api/docs/rate-limits" className="text-action underline underline-offset-2">rate-limit documentation</ExternalLink>.
      </>
    ),
  },
  {
    id: 'claude',
    label: providerLabel('claude'),
    shortLabel: 'Claude',
    article: 'a',
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
        <ExternalLink href="https://platform.claude.com/docs/en/about-claude/pricing" className="text-action underline underline-offset-2">current pricing documentation</ExternalLink>.
      </>
    ),
  },
  {
    id: 'openai',
    label: providerLabel('openai'),
    shortLabel: 'OpenAI',
    article: 'an',
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
        <ExternalLink href="https://developers.openai.com/api/docs/pricing" className="text-action underline underline-offset-2">API pricing</ExternalLink>.
      </>
    ),
  },
  {
    id: 'openrouter',
    label: providerLabel('openrouter'),
    shortLabel: 'OpenRouter',
    article: 'an',
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
        <ExternalLink href="https://openrouter.ai/docs/guides/features/zdr" className="text-action underline underline-offset-2">privacy and ZDR documentation</ExternalLink>.
      </>
    ),
  },
];

export function providerInputId(surface: 'settings' | 'onboarding', provider: ProviderSetup): string {
  return `${surface}-${provider.id}-key`;
}

export const emptyValidationState = (): ValidationState => ({ loading: false, valid: null, error: null });

export const initialProviderRecord = <T,>(create: () => T): Record<AIProviderType, T> => ({
  gemini: create(),
  claude: create(),
  openai: create(),
  openrouter: create(),
});

export function ValidationBadge({ state, label }: { state: ValidationState; label: string }): ReactNode {
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
}
