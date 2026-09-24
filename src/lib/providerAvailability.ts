import type { AIProviderType, StudyConfig } from '@/types';
import type { ResearcherContext } from './researcherContext';
import { resolveProviderType } from './providers';
import {
  isGatewayAuthConfigured,
  isGatewayProvider,
} from './aiTransport';
import { activeAITransport } from './runtime/capabilities';

/** Return the selected provider when the active transport cannot serve it. */
export function missingProviderCredential(
  context: Pick<
    ResearcherContext,
    'geminiApiKey' | 'anthropicApiKey' | 'openaiApiKey' | 'openrouterApiKey'
  >,
  config: StudyConfig,
): AIProviderType | null {
  const provider = resolveProviderType(config);
  // Vercel AI Gateway (Node) serves its three providers with gateway auth.
  // Direct and Cloudflare AI Gateway both send the provider's own key, so
  // availability is key presence.
  if (activeAITransport() === 'gateway') {
    return isGatewayProvider(provider) && isGatewayAuthConfigured() ? null : provider;
  }
  const credential = {
    gemini: context.geminiApiKey,
    claude: context.anthropicApiKey,
    openai: context.openaiApiKey,
    openrouter: context.openrouterApiKey,
  } satisfies Record<AIProviderType, string | null>;
  return credential[provider]?.trim() ? null : provider;
}
