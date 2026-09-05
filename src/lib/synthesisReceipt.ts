import { createHash } from 'crypto';
import * as jose from 'jose';
import { getParticipantSigningSecret } from './auth';
import type { AggregateSynthesisResult, AIProviderType } from '@/types';
import { isKnownProviderModel, PROVIDER_MODELS } from './providerRegistry';
import { gatewayRouteForProvider, isGatewayProvider, toGatewayModelId } from './aiTransport';

const ISSUER = 'openinterviewer';
const AUDIENCE = 'openinterviewer:synthesis-receipt';
const RECEIPT_VERSION = 3;

export interface SynthesisProvenance {
  aiProvider: AIProviderType;
  aiModel: string;
  requestedAiModel: string;
  routedProvider?: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== '_receipt')
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)])
    );
  }
  return value;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

export async function createSynthesisReceipt(options: {
  studyId: string;
  studyRevision: number;
  participantSessionId: string;
  aiProvider: AIProviderType;
  aiModel: string;
  requestedAiModel: string;
  routedProvider?: string;
  transcript: unknown;
  participantProfile: unknown;
  behaviorData: unknown;
  synthesis: unknown;
}): Promise<string> {
  return new jose.SignJWT({
    type: 'synthesis-receipt',
    version: RECEIPT_VERSION,
    studyId: options.studyId,
    studyRevision: options.studyRevision,
    participantSessionId: options.participantSessionId,
    aiProvider: options.aiProvider,
    aiModel: options.aiModel,
    requestedAiModel: options.requestedAiModel,
    ...(options.routedProvider ? { routedProvider: options.routedProvider } : {}),
    dataDigest: digest({
      transcript: options.transcript,
      participantProfile: options.participantProfile,
      behaviorData: options.behaviorData,
      synthesis: options.synthesis,
    }),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(getParticipantSigningSecret());
}

export async function verifySynthesisReceipt(options: {
  receipt: string;
  studyId: string;
  studyRevision: number;
  participantSessionId: string;
  transcript: unknown;
  participantProfile: unknown;
  behaviorData: unknown;
  synthesis: unknown;
}): Promise<SynthesisProvenance | null> {
  try {
    const { payload } = await jose.jwtVerify(options.receipt, getParticipantSigningSecret(), {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    const supportedVersion = payload.version === RECEIPT_VERSION || payload.version === 2;
    const receiptMatches = payload.type === 'synthesis-receipt'
      && supportedVersion
      && payload.studyId === options.studyId
      && payload.studyRevision === options.studyRevision
      && payload.participantSessionId === options.participantSessionId
      && payload.dataDigest === digest({
        transcript: options.transcript,
        participantProfile: options.participantProfile,
        behaviorData: options.behaviorData,
        synthesis: options.synthesis,
      });
    if (!receiptMatches) return null;

    const validProvider = typeof payload.aiProvider === 'string'
      && (payload.aiProvider === 'gemini'
        || payload.aiProvider === 'claude'
        || payload.aiProvider === 'openai'
        || payload.aiProvider === 'openrouter');
    if (
      !validProvider
      || !validBoundedText(payload.aiModel)
    ) {
      return null;
    }

    const provider = payload.aiProvider as AIProviderType;
    if (payload.version === 2) {
      // Version 2 predates requested/resolved/routed provenance. It was only
      // issued by the two original adapters; map its model to both fields for
      // one rollout window without weakening the v3 contract.
      if (provider !== 'gemini' && provider !== 'claude') return null;
      return {
        aiProvider: provider,
        requestedAiModel: payload.aiModel,
        aiModel: payload.aiModel,
      };
    }

    return validateProvenance({
      aiProvider: provider,
      requestedAiModel: payload.requestedAiModel,
      aiModel: payload.aiModel,
      routedProvider: payload.routedProvider,
    });
  } catch {
    return null;
  }
}

function validBoundedText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
}

function validateProvenance(value: {
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
      // Receipts describe generation-time execution, regardless of the current
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
