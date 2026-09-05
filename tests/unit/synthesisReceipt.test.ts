// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as jose from 'jose';
import {
  createSynthesisReceipt,
  verifySynthesisReceipt,
} from '@/lib/synthesisReceipt';
import { getParticipantSigningSecret } from '@/lib/auth';
// Fixture models standing in for whatever the study's researcher configured;
// synthesis provenance must record exactly this value, not a fixed override.
const GEMINI_SYNTHESIS_MODEL = 'gemini-3.7-flash';
const CLAUDE_SYNTHESIS_MODEL = 'claude-sonnet-5';
const OPENAI_SYNTHESIS_MODEL = 'gpt-5.6-terra';
const OPENROUTER_SYNTHESIS_MODEL = 'openai/gpt-5.6-terra';

const payload = {
  studyId: 'study-a',
  studyRevision: 1,
  participantSessionId: 'session-a',
  aiProvider: 'gemini' as const,
  aiModel: GEMINI_SYNTHESIS_MODEL,
  requestedAiModel: GEMINI_SYNTHESIS_MODEL,
  transcript: [{ id: 'm1', role: 'user', content: 'Hello', timestamp: 1 }],
  participantProfile: null,
  behaviorData: { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] },
  synthesis: {
    statedPreferences: [], revealedPreferences: [], themes: [], contradictions: [],
    keyInsights: ['Insight'], bottomLine: 'Bottom line',
  },
};

beforeEach(() => {
  process.env.PARTICIPANT_TOKEN_SECRET = 'participant-receipt-secret-12345678901234567890';
});

afterEach(() => {
  delete process.env.PARTICIPANT_TOKEN_SECRET;
  vi.unstubAllEnvs();
});

describe('synthesis receipts', () => {
  it('binds synthesis to the session, study revision, transcript, profile, and behavior', async () => {
    const receipt = await createSynthesisReceipt(payload);

    await expect(verifySynthesisReceipt({ ...payload, receipt })).resolves.toEqual({
      aiProvider: 'gemini',
      aiModel: GEMINI_SYNTHESIS_MODEL,
      requestedAiModel: GEMINI_SYNTHESIS_MODEL,
    });
    await expect(verifySynthesisReceipt({
      ...payload,
      receipt,
      transcript: [{ id: 'm1', role: 'user', content: 'Tampered', timestamp: 1 }],
    })).resolves.toBeNull();
    await expect(verifySynthesisReceipt({
      ...payload,
      receipt,
      participantSessionId: 'other-session',
    })).resolves.toBeNull();
  });

  it('returns the generation-time provider and model from the signed receipt', async () => {
    const receipt = await createSynthesisReceipt({
      ...payload,
      aiProvider: 'claude',
      aiModel: CLAUDE_SYNTHESIS_MODEL,
      requestedAiModel: CLAUDE_SYNTHESIS_MODEL,
    });

    await expect(verifySynthesisReceipt({ ...payload, receipt })).resolves.toEqual({
      aiProvider: 'claude',
      aiModel: CLAUDE_SYNTHESIS_MODEL,
      requestedAiModel: CLAUDE_SYNTHESIS_MODEL,
    });
  });

  it.each([
    'claude-haiku-4.5',
    'claude-sonnet-4.5',
    'claude-opus-4.5',
  ])('retains the Gateway Claude alias %s independently of the current transport', async (alias) => {
    vi.stubEnv('AI_TRANSPORT', 'direct');
    const provenance = {
      aiProvider: 'claude' as const,
      requestedAiModel: `anthropic/${alias}`,
      aiModel: `${alias}-served`,
      routedProvider: 'anthropic',
    };
    const receipt = await createSynthesisReceipt({ ...payload, ...provenance });

    await expect(verifySynthesisReceipt({ ...payload, receipt })).resolves.toEqual(provenance);
  });

  it('continues accepting native receipts after switching to Gateway', async () => {
    const receipt = await createSynthesisReceipt(payload);
    vi.stubEnv('AI_TRANSPORT', 'gateway');

    await expect(verifySynthesisReceipt({ ...payload, receipt })).resolves.toMatchObject({
      requestedAiModel: GEMINI_SYNTHESIS_MODEL,
      aiModel: GEMINI_SYNTHESIS_MODEL,
    });
  });

  it('accepts signed receipts for OpenAI and OpenRouter providers', async () => {
    const openaiReceipt = await createSynthesisReceipt({
      ...payload,
      aiProvider: 'openai',
      aiModel: OPENAI_SYNTHESIS_MODEL,
      requestedAiModel: OPENAI_SYNTHESIS_MODEL,
    });
    const openrouterReceipt = await createSynthesisReceipt({
      ...payload,
      aiProvider: 'openrouter',
      aiModel: 'openai/gpt-5.6-sol-2026-08-01',
      requestedAiModel: OPENROUTER_SYNTHESIS_MODEL,
      routedProvider: 'OpenAI',
    });

    await expect(verifySynthesisReceipt({ ...payload, receipt: openaiReceipt })).resolves.toEqual({
      aiProvider: 'openai',
      aiModel: OPENAI_SYNTHESIS_MODEL,
      requestedAiModel: OPENAI_SYNTHESIS_MODEL,
    });
    await expect(verifySynthesisReceipt({ ...payload, receipt: openrouterReceipt })).resolves.toEqual({
      aiProvider: 'openrouter',
      aiModel: 'openai/gpt-5.6-sol-2026-08-01',
      requestedAiModel: OPENROUTER_SYNTHESIS_MODEL,
      routedProvider: 'OpenAI',
    });
  });

  it('rejects OpenRouter receipts without upstream routing provenance', async () => {
    const receipt = await createSynthesisReceipt({
      ...payload,
      aiProvider: 'openrouter',
      aiModel: 'openai/gpt-5.6-sol-2026-08-01',
      requestedAiModel: OPENROUTER_SYNTHESIS_MODEL,
    });

    await expect(verifySynthesisReceipt({ ...payload, receipt })).resolves.toBeNull();
  });

  it('accepts a valid v2 receipt for one rollout window and maps requested=model', async () => {
    const currentReceipt = await createSynthesisReceipt(payload);
    const decoded = jose.decodeJwt(currentReceipt) as Record<string, unknown>;
    const legacyPayload: Record<string, unknown> = { ...decoded, version: 2 };
    delete legacyPayload.requestedAiModel;
    delete legacyPayload.routedProvider;
    const v2Receipt = await new jose.SignJWT(legacyPayload)
      .setProtectedHeader({ alg: 'HS256' })
      .sign(getParticipantSigningSecret());

    await expect(verifySynthesisReceipt({ ...payload, receipt: v2Receipt })).resolves.toEqual({
      aiProvider: 'gemini',
      aiModel: GEMINI_SYNTHESIS_MODEL,
      requestedAiModel: GEMINI_SYNTHESIS_MODEL,
    });
  });

  it('fails closed when signed provenance is not a supported provider/model pair', async () => {
    const receipt = await createSynthesisReceipt(payload);
    const invalidReceipt = await new jose.SignJWT({
      ...jose.decodeJwt(receipt),
      aiProvider: 'unsupported-provider',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .sign(getParticipantSigningSecret());

    await expect(verifySynthesisReceipt({ ...payload, receipt: invalidReceipt })).resolves.toBeNull();
  });

  it('fails closed on legacy receipts without signed provenance', async () => {
    const legacyReceipt = await new jose.SignJWT({
      type: 'synthesis-receipt',
      version: 1,
      studyId: payload.studyId,
      studyRevision: payload.studyRevision,
      participantSessionId: payload.participantSessionId,
      dataDigest: 'legacy-digest',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('openinterviewer')
      .setAudience('openinterviewer:synthesis-receipt')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(getParticipantSigningSecret());

    await expect(verifySynthesisReceipt({ ...payload, receipt: legacyReceipt })).resolves.toBeNull();
  });

  it.each([
    { name: 'unknown Gateway model', requestedAiModel: 'openai/unknown', routedProvider: 'openai' },
    { name: 'wrong model creator', requestedAiModel: `google/${OPENAI_SYNTHESIS_MODEL}`, routedProvider: 'openai' },
    { name: 'wrong creator route', requestedAiModel: `openai/${OPENAI_SYNTHESIS_MODEL}`, routedProvider: 'anthropic' },
    { name: 'missing Gateway route', requestedAiModel: `openai/${OPENAI_SYNTHESIS_MODEL}`, routedProvider: undefined },
    { name: 'native model with a Gateway route', requestedAiModel: OPENAI_SYNTHESIS_MODEL, routedProvider: 'openai' },
    { name: 'empty Gateway route', requestedAiModel: `openai/${OPENAI_SYNTHESIS_MODEL}`, routedProvider: '' },
    { name: 'unbounded response model', requestedAiModel: `openai/${OPENAI_SYNTHESIS_MODEL}`, routedProvider: 'openai', aiModel: 'x'.repeat(201) },
  ])('rejects $name in signed provenance', async ({ name: _name, ...invalid }) => {
    const provenance = { aiProvider: 'openai' as const, aiModel: 'served-model', ...invalid };
    // The signer is trusted, but verification must reject even signed malformed
    // provenance, not only browser edits that invalidate the JWT signature.
    const participantReceipt = await createSynthesisReceipt({ ...payload, ...provenance });
    await expect(verifySynthesisReceipt({ ...payload, receipt: participantReceipt })).resolves.toBeNull();
  });

  it('rejects altered Gateway provenance without a valid signature', async () => {
    const receipt = await createSynthesisReceipt({
      ...payload,
      aiProvider: 'openai',
      requestedAiModel: `openai/${OPENAI_SYNTHESIS_MODEL}`,
      aiModel: 'served-model',
      routedProvider: 'openai',
    });
    const [header, , signature] = receipt.split('.');
    const tampered = Buffer.from(JSON.stringify({
      ...jose.decodeJwt(receipt), aiModel: 'fabricated-model',
    })).toString('base64url');

    await expect(verifySynthesisReceipt({
      ...payload, receipt: `${header}.${tampered}.${signature}`,
    })).resolves.toBeNull();
  });
});
