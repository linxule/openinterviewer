// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredInterview, makeStoredStudy, makeStudyConfig } from '../fixtures/models';
import type { AggregateSynthesisResult, StoredInterview } from '@/types';
import { gatewayRouteForProvider, toGatewayModelId, type GatewayProviderType } from '@/lib/aiTransport';

// Per-provider fixture models the researcher chose for the study — synthesis
// must use exactly this model, not a fixed override (AGENTS.md invariant).
const STUDY_MODEL_BY_PROVIDER: Record<GatewayProviderType, string> = {
  gemini: 'gemini-3.7-flash',
  claude: 'claude-sonnet-5',
  openai: 'gpt-5.6-terra',
};

/**
 * Exercises the real routes, the real provider factory, and the real Gateway
 * adapter together — proving Gateway execution provenance survives the trip
 * from `generateText`'s response through `runInterviewAnalysis` into the
 * stored record and out through the aggregate/follow-up routes.
 *
 * Slice P: the participant save carries no synthesis and no receipt (the
 * `/api/synthesis` route it used to call is now researcher-preview-only).
 * The deferred analysis is exercised directly here via `runInterviewAnalysis`
 * — the same function `after()` schedules from the save route and the
 * researcher-triggered analyze route call — rather than by simulating
 * `after()` itself, which this file does not stand up a real Next request
 * scope for.
 */
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
  getInterviewChecked: vi.fn(),
  claimInterviewAnalysis: vi.fn(),
  attachInterviewAnalysis: vi.fn(),
  recordInterviewAnalysisFailure: vi.fn(),
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

// The save route schedules the deferred analysis via `after()`; this file
// exercises that analysis explicitly (see `runInterviewAnalysis` below)
// rather than through the real `after()` request-scope machinery.
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return { ...actual, after: vi.fn() };
});

import { POST as save } from '@/app/api/interviews/save/route';
import { POST as aggregate } from '@/app/api/synthesis/aggregate/route';
import { POST as followup } from '@/app/api/studies/[id]/generate-followup/route';
import { runInterviewAnalysis } from '@/lib/interviewAnalysis';

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

let sharedContext: { kvClient: ReturnType<typeof fakeKvClient>; researcherId: undefined };

beforeEach(() => {
  vi.stubEnv('DEPLOYMENT_MODE', 'standalone');
  vi.stubEnv('AI_TRANSPORT', 'gateway');
  vi.stubEnv('VERCEL', '1');
  vi.stubEnv('PARTICIPANT_TOKEN_SECRET', 'gateway-workflow-fixture-secret-1234567890');
  const context = { kvClient: fakeKvClient(), researcherId: undefined };
  sharedContext = context;
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
    'saves %s with no synthesis, then analyzes and aggregates without losing execution provenance',
    async (provider) => {
      const nativeModel = STUDY_MODEL_BY_PROVIDER[provider];
      const requestedModel = toGatewayModelId(provider, nativeModel);
      // An execution's actual model may differ from its requested alias. Keep
      // the exact value returned by the SDK in the stored record.
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

      // The participant save carries no synthesis at all — a body that
      // includes one is silently discarded, never a validation error.
      const submission = {
        id: 'browser-id', studyId, transcript, participantProfile: null, behaviorData,
        synthesis: { ...synthesisOutput, bottomLine: 'Invented finding a participant body cannot assert.' },
      };
      const saveResponse = await save(request('/api/interviews/save', submission));
      expect(saveResponse.status).toBe(200);
      await expect(saveResponse.json()).resolves.toMatchObject({ success: true, created: true });
      const stored = kvMock.persistCompletedInterview.mock.calls[0][0] as StoredInterview;
      expect(stored).toMatchObject({
        id: `session-${sessionId}`, transcript, synthesis: null,
        conductedByProvider: provider, conductedByModel: nativeModel,
        analysis: { status: 'pending', attempts: 0 },
      });
      expect(JSON.stringify(stored)).not.toContain('Invented finding');

      // The deferred analysis — the same function `after()` schedules from
      // the save route — runs the REAL provider factory and Gateway adapter.
      kvMock.getInterviewChecked.mockResolvedValue({ status: 'found', interview: stored });
      kvMock.claimInterviewAnalysis.mockResolvedValue({ status: 'claimed', claimId: 'claim-1', attempts: 1 });
      kvMock.attachInterviewAnalysis.mockResolvedValue({ status: 'written' });

      const outcome = await runInterviewAnalysis({
        interviewId: stored.id,
        study,
        kvClient: sharedContext.kvClient as never,
        providerKeys: {},
      });
      expect(outcome).toEqual({ status: 'complete' });
      expect(kvMock.attachInterviewAnalysis).toHaveBeenCalledWith(
        expect.objectContaining({
          interviewId: stored.id,
          claimId: 'claim-1',
          synthesis: synthesisOutput,
          provenance,
          studyRevision: study.revision,
        }),
        expect.anything(),
      );

      // Downstream routes read the record as it stands after a successful
      // attach — construct it here since attachInterviewAnalysis is mocked
      // above rather than actually mutating the fake store.
      const analyzed: StoredInterview = {
        ...stored,
        synthesis: synthesisOutput,
        aiProvider: provenance.aiProvider,
        aiModel: provenance.aiModel,
        requestedAiModel: provenance.requestedAiModel,
        routedProvider: provenance.routedProvider,
        analysis: { status: 'complete', attempts: 1, lastAttemptAt: Date.now(), studyRevision: study.revision },
      };

      kvMock.getStudyInterviewsChecked.mockResolvedValue({
        status: 'ok', items: [analyzed, makeStoredInterview({ ...analyzed, id: 'second-interview' })],
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
