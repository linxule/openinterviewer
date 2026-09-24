import type { AggregateSynthesisResult, AIProviderType } from '@/types';
import { isKnownProviderModel, PROVIDER_MODELS } from './providerRegistry';
import { gatewayRouteForProvider, isGatewayProvider, toGatewayModelId } from './aiTransport';

/**
 * Shared validation for server-generated interview, aggregate, and follow-up
 * provenance. Stored results must name a known requested provider/model and
 * the model that actually produced the output, including its route when used.
 */
export interface SynthesisProvenance {
  aiProvider: AIProviderType;
  aiModel: string;
  requestedAiModel: string;
  routedProvider?: string;
  /**
   * Present only when the request went through Cloudflare AI Gateway (RT-11).
   * It names the transport, not a provider: the model is still the one the
   * provider reported and `routedProvider` keeps its meaning.
   */
  aiTransport?: 'cloudflare-gateway';
}

export function validBoundedText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
}

export function validateProvenance(value: {
  aiProvider: AIProviderType;
  aiModel: unknown;
  requestedAiModel?: unknown;
  routedProvider?: unknown;
  aiTransport?: unknown;
}): SynthesisProvenance | null {
  if (!validBoundedText(value.aiModel)
    || !validBoundedText(value.requestedAiModel)) {
    return null;
  }
  // Absent (direct, Vercel AI Gateway, every older record) or the exact literal.
  if (value.aiTransport !== undefined && value.aiTransport !== 'cloudflare-gateway') return null;
  if (value.aiProvider === 'openrouter') {
    if (!isKnownProviderModel(value.aiProvider, value.requestedAiModel)
      || !validBoundedText(value.routedProvider)) return null;
  } else if (isGatewayProvider(value.aiProvider)) {
    if (value.routedProvider === undefined) {
      if (!isKnownProviderModel(value.aiProvider, value.requestedAiModel)) return null;
    } else {
      // A Vercel AI Gateway route never runs through Cloudflare AI Gateway.
      if (value.aiTransport !== undefined) return null;
      // Describes generation-time execution, regardless of the current
      // transport setting. Gateway requests use mapped model IDs and one exact
      // creator route; actual response model IDs remain provider-reported.
      const provider = value.aiProvider;
      if (value.routedProvider !== gatewayRouteForProvider(provider)
        || !PROVIDER_MODELS[provider].some(
          model => toGatewayModelId(provider, model.id) === value.requestedAiModel,
        )) return null;
    }
  } else {
    return null;
  }
  return {
    aiProvider: value.aiProvider,
    aiModel: value.aiModel,
    requestedAiModel: value.requestedAiModel,
    ...(typeof value.routedProvider === 'string' ? { routedProvider: value.routedProvider } : {}),
    ...(value.aiTransport === 'cloudflare-gateway' ? { aiTransport: 'cloudflare-gateway' as const } : {}),
  };
}

/**
 * The aggregate provenance gate: null when the record does not name a known
 * provider and the model that actually ran.
 */
export function aggregateProvenance(
  synthesis: AggregateSynthesisResult,
): SynthesisProvenance | null {
  return validateProvenance(synthesis);
}
