// Verbatim copies of the N-1 readers (commit eaa30a2, the release before the
// Cloudflare AI Gateway transport; identical at the provider-keys groundwork) of every record this build extends with an
// optional member: the Durable Object consent record (participants.ts
// parseConsentRecord), the frozen analysis input (analysis.ts isFrozenInput,
// completion.ts isValidFrozen) and synthesis provenance
// (synthesisProvenance.ts validateProvenance). The helpers they call are
// imported from modules this change did not touch. Used only by the
// rollback-reader tests; never update them to match newer code.

import type { AIProviderType } from '../../../src/types';
import type { ParticipantConsentRecord } from '../../../src/lib/participantConsent';
import {
  ANALYSIS_INPUT_SCHEMA_VERSION,
  type FrozenAnalysisInput,
} from '../../../src/lib/storage/analysisProtocol';
import { isProviderType } from '../../../src/lib/providers/synthesisModel';
import { isKnownProviderModel, PROVIDER_MODELS } from '../../../src/lib/providerRegistry';
import { gatewayRouteForProvider, isGatewayProvider, toGatewayModelId } from '../../../src/lib/aiTransport';
import { isHex64, isPlainObject, isRevision, isSafeTime } from '../../../cloudflare/workspace/studies';

// ---- cloudflare/workspace/participants.ts ----
const SESSION_ID = /^[A-Za-z0-9_-]{16,128}$/;
const CONSENT_STUDY_ID = /^[A-Za-z0-9_-]{1,120}$/;

export function parseConsentRecordN1(json: string): ParticipantConsentRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  if (
    parsed.version !== 1
    || typeof parsed.participantSessionId !== 'string'
    || !SESSION_ID.test(parsed.participantSessionId)
    || typeof parsed.studyId !== 'string'
    || !CONSENT_STUDY_ID.test(parsed.studyId)
    || !isRevision(parsed.studyRevision)
    || !isHex64(parsed.consentHash)
    || !isSafeTime(parsed.acceptedAt)
    || parsed.acceptedAt <= 0
  ) {
    return null;
  }
  return parsed as unknown as ParticipantConsentRecord;
}

// ---- cloudflare/workspace/analysis.ts ----
export function isFrozenInputN1(value: unknown): value is FrozenAnalysisInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const config = input.studyConfig as Record<string, unknown> | null | undefined;
  return input.inputSchemaVersion === ANALYSIS_INPUT_SCHEMA_VERSION
    && typeof input.studyRevision === 'number'
    && Number.isSafeInteger(input.studyRevision)
    && input.studyRevision >= 1
    && isProviderType(input.requestedProvider)
    && typeof input.requestedModel === 'string'
    && input.requestedModel.trim().length > 0
    && input.requestedModel.length <= 200
    && !!config
    && typeof config === 'object'
    && !Array.isArray(config)
    && typeof config.id === 'string';
}

// ---- cloudflare/workspace/completion.ts ----
const PROVIDERS = new Set(['gemini', 'claude', 'openai', 'openrouter']);
const MAX_MODEL_LENGTH = 200;

export function isValidFrozenN1(frozen: unknown, studyId: string, revision: number): frozen is FrozenAnalysisInput {
  return isPlainObject(frozen)
    && frozen.inputSchemaVersion === ANALYSIS_INPUT_SCHEMA_VERSION
    && isPlainObject(frozen.studyConfig)
    && frozen.studyConfig.id === studyId
    && frozen.studyRevision === revision
    && typeof frozen.requestedProvider === 'string'
    && PROVIDERS.has(frozen.requestedProvider)
    && typeof frozen.requestedModel === 'string'
    && frozen.requestedModel.length > 0
    && frozen.requestedModel.length <= MAX_MODEL_LENGTH;
}

// ---- src/lib/synthesisProvenance.ts ----
type SynthesisProvenanceN1 = {
  aiProvider: AIProviderType;
  aiModel: string;
  requestedAiModel: string;
  routedProvider?: string;
};

function validBoundedText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
}

export function validateProvenanceN1(value: {
  aiProvider: AIProviderType;
  aiModel: unknown;
  requestedAiModel?: unknown;
  routedProvider?: unknown;
}): SynthesisProvenanceN1 | null {
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
