import type { AggregateSynthesisResult, AIProviderType } from '@/types';
import { isKnownProviderModel, PROVIDER_MODELS } from './providerRegistry';
import { gatewayRouteForProvider, isGatewayProvider, toGatewayModelId } from './aiTransport';

/**
 * Shared provenance validation. Originally paired with a per-interview
 * signing/verification receipt that bound a browser-carried synthesis to the
 * study, revision and participant session before the save route would accept
 * it (slice K). Slice P removed that boundary entirely: `runInterviewAnalysis`
 * calls the provider and writes the result in the same function, holding the
 * canonical study it loaded itself, so no synthesis ever crosses a trust
 * boundary that needs a signature to close. What remains is the honesty
 * check every provenance-carrying record still needs: a result that does not
 * name a known provider and the model that actually produced it is not
 * storable (AGENTS.md). `validateProvenance`/`aggregateProvenance` are called
 * by `runInterviewAnalysis`, `synthesis/aggregate/route.ts`, and
 * `generate-followup/route.ts`.
 */
export interface SynthesisProvenance {
  aiProvider: AIProviderType;
  aiModel: string;
  requestedAiModel: string;
  routedProvider?: string;
}

export function validBoundedText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
}

export function validateProvenance(value: {
  aiProvider: AIProviderType;
  aiModel: unknown;
  requestedAiModel?: unknown;
  routedProvider?: unknown;
}): SynthesisProvenance | null {
  if (!validBoundedText(value.aiModel)
    || !validBoundedText(value.requestedAiModel)) {
    return null;
  }
  if (value.aiProvider === 'openrouter') {
    if (!isKnownProviderModel(value.aiProvider, value.requestedAiModel)
      || !validBoundedText(value.routedProvider)) return null;
  } else if (isGatewayProvider(value.aiProvider)) {
    if (value.routedProvider === undefined) {
      if (!isKnownProviderModel(value.aiProvider, value.requestedAiModel)) return null;
    } else {
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
