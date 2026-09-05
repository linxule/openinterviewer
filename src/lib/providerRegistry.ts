import {
  AIProviderType,
  CLAUDE_MODELS,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  GEMINI_MODELS,
  OPENAI_MODELS,
  OPENROUTER_MODELS,
} from '@/types';

export const PROVIDER_OPTIONS: ReadonlyArray<{
  id: AIProviderType;
  label: string;
  desc: string;
}> = [
  { id: 'gemini', label: 'Google Gemini', desc: 'Google GenAI Interactions API' },
  { id: 'claude', label: 'Anthropic Claude', desc: 'Anthropic Messages API' },
  { id: 'openai', label: 'OpenAI', desc: 'OpenAI Responses API' },
  { id: 'openrouter', label: 'OpenRouter', desc: 'Privacy-constrained multi-provider routing' },
];

export const PROVIDER_MODELS = {
  gemini: GEMINI_MODELS,
  claude: CLAUDE_MODELS,
  openai: OPENAI_MODELS,
  openrouter: OPENROUTER_MODELS,
} satisfies Record<AIProviderType, typeof GEMINI_MODELS>;

export const DEFAULT_MODEL_BY_PROVIDER = {
  gemini: DEFAULT_GEMINI_MODEL,
  claude: DEFAULT_CLAUDE_MODEL,
  openai: DEFAULT_OPENAI_MODEL,
  openrouter: DEFAULT_OPENROUTER_MODEL,
} satisfies Record<AIProviderType, string>;

const OPENROUTER_MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._:-]{0,134}$/i;

export function isOpenRouterModelId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 200
    && value !== 'openrouter/auto'
    && OPENROUTER_MODEL_ID.test(value);
}

export function isKnownProviderModel(provider: AIProviderType, model: string): boolean {
  if (provider === 'openrouter') return isOpenRouterModelId(model);
  return PROVIDER_MODELS[provider].some((option) => option.id === model);
}
