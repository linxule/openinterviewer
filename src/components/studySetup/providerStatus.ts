// Provider-availability status shared by StudySetup's container and
// ProviderSection. Moved verbatim from StudySetup.tsx (C6).

import { AIProviderType } from '@/types';

export type ConfigStatus = {
  mode: 'hosted' | 'standalone';
  /** Present only on the Cloudflare target, whose keys are installer-managed. */
  target?: 'cloudflare';
  aiTransport: 'direct' | 'gateway' | 'cloudflare-gateway';
  hasAnthropicKey: boolean;
  hasGeminiKey: boolean;
  hasOpenAiKey: boolean;
  hasOpenRouterKey: boolean;
};

export const PROVIDER_STATUS_FIELD = {
  gemini: 'hasGeminiKey',
  claude: 'hasAnthropicKey',
  openai: 'hasOpenAiKey',
  openrouter: 'hasOpenRouterKey',
} as const satisfies Record<AIProviderType, keyof Omit<ConfigStatus, 'mode' | 'target' | 'aiTransport'>>;

export const PROVIDER_ENV_NAME = {
  gemini: 'GEMINI_API_KEY',
  claude: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
} as const satisfies Record<AIProviderType, string>;

export const isProviderConfigured = (
  provider: AIProviderType,
  status: ConfigStatus | null
) => Boolean(status?.[PROVIDER_STATUS_FIELD[provider]]);
