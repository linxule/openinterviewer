// Queued synthesis execution (JOB-02/09). Constructs the frozen generation's
// direct adapter with an explicit key and model, runs exactly one synthesis
// request under the queued-synthesis policy, and classifies the outcome.
// Never consults study defaults, deployment model overrides or env fallbacks.
//
// Adapters load on first use. Each is reached only through a literal dynamic
// import, so the Worker bundle keeps it and its SDK in lazily initialized
// modules: an isolate evaluates one SDK when a queued job for that provider
// executes, never at startup (evidence/MEASUREMENTS.md, option R2).

import type { AIProvider } from '../../src/lib/ai';
import { ProviderFailure, ProviderTimeoutError } from '../../src/lib/providerErrors';
import { isKnownProviderModel } from '../../src/lib/providerRegistry';
import { validateSynthesisResult } from '../../src/lib/providerValidation';
import { validateProvenance } from '../../src/lib/synthesisProvenance';
import type { RequestLogReason } from '../../src/lib/requestLog';
import {
  MAX_ATTACHED_SYNTHESIS_BYTES,
  type ClaimedAnalysisInputs,
  type FinishAnalysisJobInput,
} from '../../src/lib/storage/analysisProtocol';
import type {
  AIProviderType,
  BehaviorData,
  InterviewMessage,
  ParticipantProfile,
  StudyConfig,
} from '../../src/types';
import { PROVIDER_KEY_NAMES, serializedByteLength } from './policy';

export type JobOutcome = FinishAnalysisJobInput['outcome'];
export type ClassifiedOutcome = { outcome: JobOutcome; reason?: RequestLogReason };

type AdapterClass = new (model: string, apiKey: string) => AIProvider;

const ADAPTERS: Readonly<Record<AIProviderType, () => Promise<AdapterClass>>> = {
  claude: async () => (await import('../../src/lib/providers/claude')).ClaudeProvider,
  openai: async () => (await import('../../src/lib/providers/openai')).OpenAIProvider,
  gemini: async () => (await import('../../src/lib/providers/gemini')).GeminiProvider,
  openrouter: async () => (await import('../../src/lib/providers/openrouter')).OpenRouterProvider,
};

/** The frozen adapter could not be loaded or constructed, so no provider request was made. */
export class AdapterLoadError extends Error {
  constructor(readonly provider: AIProviderType, cause: unknown) {
    super(`The ${provider} adapter could not be loaded`, { cause });
    this.name = 'AdapterLoadError';
  }
}

/** Loads the frozen adapter once, when first needed, and delegates to it. */
class DeferredAdapter implements AIProvider {
  private loaded: Promise<AIProvider> | null = null;

  constructor(
    private readonly provider: AIProviderType,
    private readonly model: string,
    private readonly key: string,
  ) {}

  /** Load and construct the adapter; rejects with AdapterLoadError. */
  load(): Promise<AIProvider> {
    this.loaded ??= (async () => {
      try {
        const Adapter = await ADAPTERS[this.provider]();
        return new Adapter(this.model, this.key);
      } catch (error) {
        throw new AdapterLoadError(this.provider, error);
      }
    })();
    return this.loaded;
  }

  private adapter(): Promise<AIProvider> {
    return this.load();
  }

  async generateInterviewResponse(...args: Parameters<AIProvider['generateInterviewResponse']>) {
    return (await this.adapter()).generateInterviewResponse(...args);
  }

  async getInterviewGreeting(...args: Parameters<AIProvider['getInterviewGreeting']>) {
    return (await this.adapter()).getInterviewGreeting(...args);
  }

  async synthesizeInterview(...args: Parameters<AIProvider['synthesizeInterview']>) {
    return (await this.adapter()).synthesizeInterview(...args);
  }

  async synthesizeAggregate(...args: Parameters<AIProvider['synthesizeAggregate']>) {
    return (await this.adapter()).synthesizeAggregate(...args);
  }

  async generateFollowupStudy(...args: Parameters<AIProvider['generateFollowupStudy']>) {
    return (await this.adapter()).generateFollowupStudy(...args);
  }
}

/** The frozen provider's key from the current Worker env, or null when absent. */
export function providerKeyFromEnv(env: Readonly<Record<string, unknown>>, provider: AIProviderType): string | null {
  const value = env[PROVIDER_KEY_NAMES[provider]];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Direct adapter with an explicit model and key. Throws synchronously, before
 * any start marker or provider request, for an unknown provider, a missing
 * key or an unsupported model, as the adapter constructors do.
 */
export function createQueuedSynthesisProvider(provider: AIProviderType, model: string, key: string): AIProvider {
  if (!Object.hasOwn(ADAPTERS, provider)) throw new Error(`Unsupported provider: ${provider}`);
  if (!key) throw new Error(`A ${provider} key is required`);
  if (!isKnownProviderModel(provider, model)) throw new Error(`Unsupported ${provider} model: ${model}`);
  return new DeferredAdapter(provider, model, key);
}

/**
 * createQueuedSynthesisProvider, then load and construct the frozen adapter,
 * so the consumer can do both before the start marker: a missing or broken
 * adapter is then a known failure with no started attempt and no request.
 */
export async function loadQueuedSynthesisProvider(provider: AIProviderType, model: string, key: string): Promise<AIProvider> {
  const deferred = createQueuedSynthesisProvider(provider, model, key) as DeferredAdapter;
  await deferred.load();
  return deferred;
}

/**
 * Classify a provider exception raised after the start marker committed.
 * Only rejections made before generation (configuration, rate limit) and
 * returned output are known failures. Timeout, abort, transport failure, 5xx
 * and anything unrecognized leave the paid outcome uncertain.
 */
export function classifyProviderException(error: unknown): ClassifiedOutcome {
  if (error instanceof AdapterLoadError) {
    // No adapter, so no request: a known configuration failure, never uncertain.
    return { outcome: { kind: 'failed', failureKind: 'provider' }, reason: 'provider-failure' };
  }
  if (error instanceof ProviderTimeoutError) {
    return { outcome: { kind: 'uncertain' }, reason: 'timeout' };
  }
  if (error instanceof ProviderFailure) {
    switch (error.kind) {
      case 'config':
      case 'rate-limited':
        return { outcome: { kind: 'failed', failureKind: 'provider' }, reason: 'provider-failure' };
      case 'invalid-response':
        return { outcome: { kind: 'failed', failureKind: 'invalid-output' }, reason: 'invalid' };
      case 'unavailable':
        return { outcome: { kind: 'uncertain' }, reason: 'unknown-outcome' };
    }
  }
  return { outcome: { kind: 'uncertain' }, reason: 'unknown-outcome' };
}

/**
 * Run one synthesis for the claimed generation. Never throws. The deadline
 * bounds the provider request; the consumer loads the adapter before the
 * start marker (loadQueuedSynthesisProvider).
 */
export async function executeQueuedSynthesis(
  provider: AIProvider,
  inputs: ClaimedAnalysisInputs,
  deadlineMs: number,
): Promise<ClassifiedOutcome> {
  const { frozen, interview } = inputs;
  const studyConfig: StudyConfig = {
    ...frozen.studyConfig,
    aiProvider: frozen.requestedProvider,
    aiModel: frozen.requestedModel,
  };
  let result;
  try {
    result = await provider.synthesizeInterview(
      interview.transcript as InterviewMessage[],
      studyConfig,
      interview.behaviorData as BehaviorData,
      interview.participantProfile as ParticipantProfile | null,
      { kind: 'queued-synthesis', deadlineMs },
    );
  } catch (error) {
    return classifyProviderException(error);
  }
  const provenance = validateProvenance({
    aiProvider: result.execution.provider,
    aiModel: result.execution.model,
    requestedAiModel: result.execution.requestedModel,
    routedProvider: result.execution.routedProvider,
  });
  if (
    !provenance
    || provenance.aiProvider !== frozen.requestedProvider
    || provenance.requestedAiModel !== frozen.requestedModel
  ) {
    return { outcome: { kind: 'failed', failureKind: 'invalid-output' }, reason: 'invalid' };
  }
  let synthesis;
  try {
    synthesis = validateSynthesisResult(result.value);
  } catch {
    return { outcome: { kind: 'failed', failureKind: 'invalid-output' }, reason: 'invalid' };
  }
  if (serializedByteLength(synthesis) > MAX_ATTACHED_SYNTHESIS_BYTES) {
    return { outcome: { kind: 'failed', failureKind: 'too-large' }, reason: 'too-large' };
  }
  return { outcome: { kind: 'complete', synthesis, provenance } };
}
