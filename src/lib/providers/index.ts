// AI Provider Factory
// Returns the appropriate provider based on study or environment configuration

import { AIProvider } from '../ai';
import { GeminiProvider } from './gemini';
import { ClaudeProvider } from './claude';
import { OpenAIProvider } from './openai';
import { OpenRouterProvider } from './openrouter';
import { GatewayProvider } from './gateway';
import { StudyConfig } from '@/types';
import { isHostedMode } from '../mode';
import {
  isProviderType,
  PROVIDER_TYPES,
  ProviderType,
  resolveSynthesisModel,
} from './synthesisModel';
import { isGatewayProvider, resolveAITransport } from '../aiTransport';
import { isCloudflareTarget } from '../runtime/capabilities';
import { providerEndpoint, type ProviderRoute } from './endpoint';

export type { ProviderType } from './synthesisModel';
export { PROVIDER_TYPES, isProviderType, resolveSynthesisModel } from './synthesisModel';

// Optional per-request API keys (for hosted/BYOK mode)
export interface AIProviderKeys {
  geminiApiKey?: string | null;
  anthropicApiKey?: string | null;
  openaiApiKey?: string | null;
  openrouterApiKey?: string | null;
  /**
   * Cloudflare target only: the provider route resolved from the Worker env
   * (resolveProviderRoute). Required there; the factory refuses without it.
   */
  route?: ProviderRoute;
}

/**
 * Resolve the provider exactly as the provider factory does.
 *
 * Keep this normalization centralized so provenance cannot claim an invalid
 * environment value while the factory silently falls back to Gemini.
 */
export function resolveProviderType(studyConfig?: StudyConfig): ProviderType {
  if (studyConfig && !studyConfig.aiProvider) {
    throw new Error('Canonical study is missing an explicit AI provider');
  }
  const configuredProvider = studyConfig?.aiProvider || process.env.AI_PROVIDER;
  if (configuredProvider === undefined || configuredProvider === '') return 'gemini';
  if (!isProviderType(configuredProvider)) {
    throw new Error(`Unsupported AI provider: ${configuredProvider}`);
  }
  return configuredProvider;
}

// Get the interview AI provider based on configuration
// Provider priority: studyConfig.aiProvider > env.AI_PROVIDER > 'gemini'
// Model priority: studyConfig.aiModel > provider MODEL env > env.AI_MODEL > default
// In hosted mode, pass keys from ResearcherContext; in standalone, keys are null and env vars are used
export function getInterviewProvider(studyConfig?: StudyConfig, keys?: AIProviderKeys): AIProvider {
  const providerType = resolveProviderType(studyConfig);

  if (studyConfig && !studyConfig.aiModel) {
    throw new Error('Canonical study is missing an explicit AI model');
  }

  // Pass model from studyConfig (if set) to provider constructor
  const model = studyConfig?.aiModel;

  // In hosted mode, use ONLY researcher-provided keys (no env var fallback)
  // Pass a special sentinel ('') to prevent providers from falling back to env vars
  const hosted = isHostedMode();

  if (isCloudflareTarget()) return cloudflareProvider(providerType, model, keys);

  if (!hosted && resolveAITransport() === 'gateway') {
    if (!isGatewayProvider(providerType)) {
      throw new Error('OpenRouter is available only with the direct AI transport');
    }
    if (!model) {
      throw new Error('Vercel AI Gateway requires an explicit model');
    }
    return new GatewayProvider(providerType, model);
  }

  switch (providerType) {
    case 'claude': {
      const key = hosted ? (keys?.anthropicApiKey || '') : (keys?.anthropicApiKey ?? undefined);
      return new ClaudeProvider(model, key);
    }
    case 'openai': {
      const key = hosted ? (keys?.openaiApiKey || '') : (keys?.openaiApiKey ?? undefined);
      return new OpenAIProvider(model, key);
    }
    case 'openrouter': {
      const key = hosted ? (keys?.openrouterApiKey || '') : (keys?.openrouterApiKey ?? undefined);
      return new OpenRouterProvider(model, key);
    }
    case 'gemini': {
      const key = hosted ? (keys?.geminiApiKey || '') : (keys?.geminiApiKey ?? undefined);
      return new GeminiProvider(model, key);
    }
  }
}

/**
 * Cloudflare target (RT-05): the Worker env is the only key source. A missing
 * key is passed as '' so the adapter refuses instead of reading process.env,
 * and every adapter gets an explicit endpoint from the resolved route.
 */
function cloudflareProvider(providerType: ProviderType, model: string | undefined, keys?: AIProviderKeys): AIProvider {
  const route = keys?.route;
  if (!route) throw new Error('The provider route is not configured for this deployment');
  const endpoint = providerEndpoint(providerType, route);
  switch (providerType) {
    case 'claude':
      return new ClaudeProvider(model, keys?.anthropicApiKey || '', endpoint);
    case 'openai':
      return new OpenAIProvider(model, keys?.openaiApiKey || '', endpoint);
    case 'openrouter':
      return new OpenRouterProvider(model, keys?.openrouterApiKey || '', endpoint);
    case 'gemini':
      return new GeminiProvider(model, keys?.geminiApiKey || '', endpoint);
  }
}

export { GeminiProvider } from './gemini';
export { ClaudeProvider } from './claude';
export { OpenAIProvider } from './openai';
export { OpenRouterProvider } from './openrouter';
export { GatewayProvider } from './gateway';
