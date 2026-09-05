// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredInterview, makeStoredStudy, makeStudyConfig } from '../fixtures/models';
import type { AggregateSynthesisResult, StoredInterview, SynthesisResult } from '@/types';
import { gatewayRouteForProvider, toGatewayModelId, type GatewayProviderType } from '@/lib/aiTransport';

// Per-provider fixture models the researcher chose for the study — synthesis
// must use exactly this model, not a fixed override (AGENTS.md invariant).
const STUDY_MODEL_BY_PROVIDER: Record<GatewayProviderType, string> = {
  gemini: 'gemini-3.7-flash',
  claude: 'claude-sonnet-5',
  openai: 'gpt-5.6-terra',
};

// Exercise the real routes, provider factory, Gateway adapter, and receipt
// signer/verifiers together. Only external execution and storage/authority
// boundaries are fixtures; no fabricated ProviderResult or receipt can hide a
// mismatch between the adapter's provenance and the save/follow-up consumers.
const generateTextMock = vi.hoisted(() => vi.fn());
vi.mock('ai', () => ({
  generateText: generateTextMock,
  gateway: (modelId: string) => ({ modelId }),
  Output: { object: (options: unknown) => options },
  jsonSchema: (schema: unknown) => schema,
}));

const contextMock = vi.hoisted(() => ({
  resolveParticipantOrPreviewContext: vi.fn(),
  getAuthorizedResearcherStudyContext: vi.fn(),
}));
vi.mock('@/lib/researcherContext', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/researcherContext')>(),
  ...contextMock,
}));

const kvMock = vi.hoisted(() => ({
  getStudy: vi.fn(),
  getStudyChecked: vi.fn(),
  getStudyInterviewsChecked: vi.fn(),
  persistCompletedInterview: vi.fn(),
}));
vi.mock('@/lib/kv', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/kv')>(),
  ...kvMock,
}));

const consentMock = vi.hoisted(() => ({ verifyParticipantConsent: vi.fn() }));
vi.mock('@/lib/participantConsent', () => consentMock);
vi.mock('@/lib/rateLimit', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/rateLimit')>(),
  participantRateLimitResponse: vi.fn(async () => null),
}));
vi.mock('@/lib/platformAiRateLimit', () => ({
  hostedAiRateLimitResponse: vi.fn(async () => null),
}));

import { POST as synthesize } from '@/app/api/synthesis/route';
import { POST as save } from '@/app/api/interviews/save/route';
import { POST as aggregate } from '@/app/api/synthesis/aggregate/route';
import { POST as followup } from '@/app/api/studies/[id]/generate-followup/route';
import { verifySynthesisReceipt } from '@/lib/synthesisReceipt';

// A minimal in-memory RedisPort so the real saveStudyAggregate/
// getStudyAggregateChecked (unmocked above) have somewhere to write the
// aggregate the route persists (Slice N: the aggregate is stored, not
// signed back to the browser).
function fakeKvClient() {
  const store = new Map<string, unknown>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: unknown) => { store.set(key, value); return 'OK'; }),
  };
}

const studyId = 'study-gateway-workflow';
const sessionId = 'participant-fixture';
const transcript = [{ id: 'message-a', role: 'user' as const, content: 'Clear ownership helps.', timestamp: 1 }];
const behaviorData = { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] };
const synthesisOutput = {
  statedPreferences: ['Clear ownership'],
  revealedPreferences: [],
  themes: [],
  contradictions: [],
  keyInsights: ['Clear ownership helps participants.'],
  bottomLine: 'Ownership matters.',
};
const aggregateOutput = {
  commonThemes: [],
  divergentViews: [],
  keyFindings: ['Ownership matters across interviews.'],
  researchImplications: ['Investigate ownership.'],
  bottomLine: 'Explore how ownership shapes trust.',
};
const followupOutput = {
  name: 'Ownership follow-up',
  researchQuestion: 'How does ownership shape trust?',
  coreQuestions: ['When does ownership become unclear?'],
};

function request(path: string, body: unknown) {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.stubEnv('DEPLOYMENT_MODE', 'standalone');
  vi.stubEnv('AI_TRANSPORT', 'gateway');
  vi.stubEnv('VERCEL', '1');
  vi.stubEnv('PARTICIPANT_TOKEN_SECRET', 'gateway-workflow-fixture-secret-1234567890');
  const context = { kvClient: fakeKvClient(), researcherId: undefined };
  contextMock.resolveParticipantOrPreviewContext.mockResolvedValue({
    valid: true, context, studyId, isAdmin: false,
    participantSessionId: sessionId, linkId: 'link-fixture', studyRevision: 1,
  });
  contextMock.getAuthorizedResearcherStudyContext.mockResolvedValue({ authorized: true, context });
  consentMock.verifyParticipantConsent.mockResolvedValue({
    status: 'accepted',
    consent: {
      version: 1, participantSessionId: sessionId, studyId, studyRevision: 1,
      consentHash: 'a'.repeat(64), acceptedAt: 1,
    },
  });
  kvMock.persistCompletedInterview.mockResolvedValue({ status: 'created' });
});

afterEach(() => vi.unstubAllEnvs());

describe('Gateway synthesis completion and researcher follow-up', () => {
  it.each<GatewayProviderType>(['gemini', 'claude', 'openai'])(
    'saves %s synthesis and consumes its signed aggregate without losing execution provenance',
    async (provider) => {
      const nativeModel = STUDY_MODEL_BY_PROVIDER[provider];
      const requestedModel = toGatewayModelId(provider, nativeModel);
      // An execution's actual model may differ from its requested alias. Keep
      // the exact value returned by the SDK in the receipt and stored record.
      const actualModel = `${requestedModel}-served-revision`;
      const provenance = {
        aiProvider: provider,
        requestedAiModel: requestedModel,
        aiModel: actualModel,
        routedProvider: gatewayRouteForProvider(provider),
      };
      const study = makeStoredStudy({
        id: studyId,
        config: makeStudyConfig({ id: studyId, aiProvider: provider, aiModel: nativeModel }),
      });
      kvMock.getStudy.mockResolvedValue(study);
      kvMock.getStudyChecked.mockResolvedValue({ status: 'found', study });
      for (const output of [synthesisOutput, aggregateOutput, followupOutput]) {
        generateTextMock.mockResolvedValueOnce({ output, text: '', response: { modelId: actualModel } });
      }

      const synthesisResponse = await synthesize(request('/api/synthesis', {
        history: transcript, participantProfile: null, behaviorData,
      }));
      expect(synthesisResponse.status).toBe(200);
      const signedSynthesis: SynthesisResult & { _receipt: string } = await synthesisResponse.json();
      await expect(verifySynthesisReceipt({
        receipt: signedSynthesis._receipt,
        studyId, studyRevision: 1, participantSessionId: sessionId,
        transcript, participantProfile: null, behaviorData, synthesis: signedSynthesis,
      })).resolves.toEqual(provenance);

      const submission = {
        id: 'browser-id', studyId, transcript, participantProfile: null,
        behaviorData, synthesis: signedSynthesis,
      };
      const saveResponse = await save(request('/api/interviews/save', submission));
      expect(saveResponse.status).toBe(200);
      await expect(saveResponse.json()).resolves.toMatchObject({ success: true, created: true });
      const stored = kvMock.persistCompletedInterview.mock.calls[0][0] as StoredInterview;
      expect(stored).toMatchObject({
        ...provenance, id: `session-${sessionId}`, transcript, synthesis: synthesisOutput,
      });

      // Browser edits must remain rejected before storage even with a valid
      // Gateway receipt issued by the preceding synthesis endpoint.
      const tamperedSave = await save(request('/api/interviews/save', {
        ...submission, synthesis: { ...signedSynthesis, bottomLine: 'Invented finding.' },
      }));
      expect(tamperedSave.status).toBe(403);
      expect(kvMock.persistCompletedInterview).toHaveBeenCalledTimes(1);

      kvMock.getStudyInterviewsChecked.mockResolvedValue({
        status: 'ok', items: [stored, makeStoredInterview({ ...stored, id: 'second-interview' })],
      });
      const aggregateResponse = await aggregate(request('/api/synthesis/aggregate', { studyId }));
      expect(aggregateResponse.status).toBe(200);
      const { synthesis: storedAggregate }: { synthesis: AggregateSynthesisResult & { savedAt?: number } } =
        await aggregateResponse.json();
      expect(storedAggregate).toMatchObject(provenance);
      // Slice N: the route persists what it just verified; the browser is
      // handed the stored copy (savedAt present) rather than a signature.
      expect(Number.isSafeInteger(storedAggregate.savedAt)).toBe(true);

      // generate-followup now reads the server's own stored copy — the
      // browser posts no body at all (N9.4) — so its provenance revalidation
      // (aggregateProvenance) runs over the stored record, not a signature.
      const followupPath = `/api/studies/${studyId}/generate-followup`;
      const params = { params: Promise.resolve({ id: studyId }) };
      const followupResponse = await followup(new Request(`http://localhost${followupPath}`, { method: 'POST' }), params);
      expect(followupResponse.status).toBe(200);
      await expect(followupResponse.json()).resolves.toMatchObject({
        followUpConfig: followupOutput,
        generation: {
          provider, requestedModel, model: actualModel,
          routedProvider: gatewayRouteForProvider(provider),
        },
      });
      expect(generateTextMock).toHaveBeenCalledTimes(3);
    },
  );
});
