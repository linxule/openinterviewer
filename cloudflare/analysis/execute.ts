// Queued synthesis execution (JOB-02/09). Constructs the frozen generation's
// direct adapter with an explicit key and model, runs exactly one synthesis
// request under the queued-synthesis policy, and classifies the outcome.
// Never consults study defaults, deployment model overrides or env fallbacks.

import type { AIProvider } from '../../src/lib/ai';
import { ClaudeProvider } from '../../src/lib/providers/claude';
import { GeminiProvider } from '../../src/lib/providers/gemini';
import { OpenAIProvider } from '../../src/lib/providers/openai';
import { OpenRouterProvider } from '../../src/lib/providers/openrouter';
import { ProviderFailure, ProviderTimeoutError } from '../../src/lib/providerErrors';
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

/** The frozen provider's key from the current Worker env, or null when absent. */
export function providerKeyFromEnv(env: Readonly<Record<string, unknown>>, provider: AIProviderType): string | null {
  const value = env[PROVIDER_KEY_NAMES[provider]];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Direct adapter with an explicit model and key; throws for an unsupported model. */
export function createQueuedSynthesisProvider(provider: AIProviderType, model: string, key: string): AIProvider {
  switch (provider) {
    case 'claude':
      return new ClaudeProvider(model, key);
    case 'openai':
      return new OpenAIProvider(model, key);
    case 'gemini':
      return new GeminiProvider(model, key);
    case 'openrouter':
      return new OpenRouterProvider(model, key);
  }
}

/**
 * Classify a provider exception raised after the start marker committed.
 * Only rejections made before generation (configuration, rate limit) and
 * returned output are known failures. Timeout, abort, transport failure, 5xx
 * and anything unrecognized leave the paid outcome uncertain.
 */
export function classifyProviderException(error: unknown): ClassifiedOutcome {
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

/** Run one synthesis for the claimed generation. Never throws. */
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
