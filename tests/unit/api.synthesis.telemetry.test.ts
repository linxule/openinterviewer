// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeStoredStudy, makeStudyConfig } from '../fixtures/models';
import { standaloneTestContext } from '../helpers/workspaceStoreFixture';
import type { RedisPort } from '@/lib/redisPort';

/**
 * Slice I2d: /api/synthesis emits a counts-only `synthesis.evidence` log event
 * (refs offered vs refs located against the transcript) on the success path.
 * ADR-003: no quote text, turn text, or anything derived from participant
 * speech may reach a log line. All fixture content below is invented.
 *
 * Slice P: this route is researcher-preview-only now (P3.3) — every case
 * here runs as `isAdmin`, and the participant-refund contract it used to
 * pin is deleted along with the refund helper itself. What replaces it: a
 * participant token gets a flat 403 before any provider call.
 */

const contextMock = vi.hoisted(() => ({
  getParticipantRequestContext: vi.fn(),
  resolveParticipantOrPreviewContext: vi.fn((request: Request, options?: unknown) =>
    contextMock.getParticipantRequestContext(request, options)
  ),
  selectedStudyIdFromParticipantBody: vi.fn((body: Record<string, unknown>) => {
    if (typeof body.studyId === 'string' && body.studyId.length > 0) return body.studyId;
    const studyConfig = body.studyConfig;
    if (studyConfig && typeof studyConfig === 'object' && studyConfig !== null && 'id' in studyConfig) {
      const id = (studyConfig as { id?: unknown }).id;
      if (typeof id === 'string' && id.length > 0) return id;
    }
    return undefined;
  }),
  providerKeysFromContext: vi.fn(() => ({
    geminiApiKey: 'test-gemini-key',
    anthropicApiKey: null,
    openaiApiKey: null,
    openrouterApiKey: null,
  })),
}));

vi.mock('@/lib/researcherContext', () => contextMock);

const providersMock = vi.hoisted(() => ({
  getInterviewProvider: vi.fn(),
  resolveProviderType: vi.fn(() => 'gemini'),
  resolveSynthesisModel: vi.fn(() => 'gemini-3.1-pro-preview'),
}));

vi.mock('@/lib/providers', () => providersMock);

// The Redis workspace store reads through getStudyChecked; derive it from the
// getStudy fixture so both see the same record.
const kvMock = vi.hoisted(() => {
  const getStudy = vi.fn();
  return {
    getStudy,
    getStudyChecked: vi.fn(async (id: string) => {
      const study = await getStudy(id);
      return study ? { status: 'found', study } : { status: 'not-found' };
    }),
  };
});
vi.mock('@/lib/kv', () => kvMock);

const platformRateLimitMock = vi.hoisted(() => ({ hostedAiRateLimitResponse: vi.fn() }));
vi.mock('@/lib/platformAiRateLimit', () => platformRateLimitMock);
const researcherBudgetMock = vi.hoisted(() => ({ researcherAiBudgetResponse: vi.fn(async () => null) }));
vi.mock('@/lib/researcherAiBudget', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/researcherAiBudget')>()),
  ...researcherBudgetMock,
}));

const consentMock = vi.hoisted(() => ({ verifyParticipantConsent: vi.fn() }));
vi.mock('@/lib/participantConsent', () => consentMock);

import { POST as synthesisPOST } from '@/app/api/synthesis/route';

const PARTICIPANT_TURN = 'I kept the browser tab pinned all week so I would not lose the draft.';

const history = [
  { id: 'm1', role: 'ai', content: 'How did the week with the tool go?', timestamp: 1 },
  { id: 'm2', role: 'user', content: PARTICIPANT_TURN, timestamp: 2 },
];

const studyConfig = makeStudyConfig({ id: 'study-t', name: 'Telemetry Study', aiProvider: 'gemini' });

function providerReturning(themes: unknown) {
  return {
    generateInterviewResponse: vi.fn(),
    getInterviewGreeting: vi.fn(),
    synthesizeInterview: vi.fn().mockResolvedValue({
      value: {
        statedPreferences: [],
        revealedPreferences: [],
        themes,
        contradictions: [],
        keyInsights: [],
        bottomLine: 'A bottom line.',
      },
      execution: {
        provider: 'gemini',
        requestedModel: 'gemini-3.1-pro-preview',
        model: 'gemini-3.1-pro-preview-001',
      },
    }),
  };
}

const makeRequest = () =>
  new Request('http://localhost/api/synthesis', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      history,
      studyConfig,
      participantProfile: null,
      behaviorData: { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] },
    }),
  });

function evidenceEvents(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  return spy.mock.calls
    .map((call: unknown[]): string => String(call[0]))
    .filter((line: string) => line.includes('synthesis.evidence'))
    .map((line: string) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
  vi.clearAllMocks();
  contextMock.getParticipantRequestContext.mockResolvedValue({
    valid: true,
    context: standaloneTestContext({} as RedisPort, {
      geminiApiKey: 'test-gemini-key',
      researcherId: 'researcher-t',
    }),
    studyId: 'study-t',
    isAdmin: true,
    participantSessionId: undefined,
  });
  kvMock.getStudy.mockResolvedValue(makeStoredStudy({ id: 'study-t', config: studyConfig }));
  platformRateLimitMock.hostedAiRateLimitResponse.mockResolvedValue(null);
  consentMock.verifyParticipantConsent.mockResolvedValue({
    status: 'accepted',
    consent: {
      version: 1,
      participantSessionId: 'participant-session-t',
      studyId: 'study-t',
      studyRevision: 1,
      consentHash: 'a'.repeat(64),
      acceptedAt: 1_700_000_000_000,
    },
  });
});

describe('POST /api/synthesis evidence telemetry (researcher preview)', () => {
  it('emits counts-only synthesis.evidence with offered vs located refs, never quote text', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    providersMock.getInterviewProvider.mockReturnValue(
      providerReturning([
        {
          theme: 'Persistence',
          frequency: 2,
          evidenceRefs: [{ quote: 'kept the browser tab pinned', turnIndex: 2 }],
        },
        {
          theme: 'Drift',
          frequency: 1,
          evidenceRefs: [
            { quote: 'a phrase the participant never said', turnIndex: 2 },
            { quote: 'anything at all', turnIndex: 9 },
          ],
        },
      ])
    );

    const res = await synthesisPOST(makeRequest());
    expect(res.status).toBe(200);

    const events = evidenceEvents(spy);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('synthesis.evidence');
    expect(events[0].refsOffered).toBe(3);
    expect(events[0].refsLocated).toBe(1);
    expect(events[0].route).toBe('/api/synthesis');
    expect(typeof events[0].requestId).toBe('string');

    // ADR-003: nothing derived from participant speech in any logged line.
    const allLogged = JSON.stringify(spy.mock.calls);
    expect(allLogged).not.toContain('browser tab');
    expect(allLogged).not.toContain('pinned');
    expect(allLogged).not.toContain('never said');
  });

  it('emits zero counts for a legacy-shaped synthesis and still returns the result', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    providersMock.getInterviewProvider.mockReturnValue(
      providerReturning([{ theme: 'Trust', evidence: 'Repeated concern about drift.', frequency: 1 }])
    );

    const res = await synthesisPOST(makeRequest());
    expect(res.status).toBe(200);

    const events = evidenceEvents(spy);
    expect(events).toHaveLength(1);
    expect(events[0].refsOffered).toBe(0);
    expect(events[0].refsLocated).toBe(0);
    expect(JSON.stringify(spy.mock.calls)).not.toContain('Repeated concern');
  });

  it('returns the bare synthesis with no _receipt field', async () => {
    providersMock.getInterviewProvider.mockReturnValue(providerReturning([]));

    const res = await synthesisPOST(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).not.toHaveProperty('_receipt');
  });
});

describe('POST /api/synthesis — researcher AI budget (D15)', () => {
  it('D15: a preview is charged on the request store before the provider; a refusal constructs no provider', async () => {
    const refusal = new Response(null, { status: 429 });
    researcherBudgetMock.researcherAiBudgetResponse.mockResolvedValueOnce(refusal as never);

    const res = await synthesisPOST(makeRequest());

    expect(res).toBe(refusal);
    const { context } = await contextMock.getParticipantRequestContext();
    expect(researcherBudgetMock.researcherAiBudgetResponse).toHaveBeenCalledWith(
      expect.any(Request), 'synthesis', context.store, '/api/synthesis',
    );
    expect(providersMock.getInterviewProvider).not.toHaveBeenCalled();
  });
});

describe('POST /api/synthesis — participant tokens are refused', () => {
  it('returns 403 for a participant token, with no provider call', async () => {
    contextMock.getParticipantRequestContext.mockResolvedValue({
      valid: true,
      context: standaloneTestContext({} as RedisPort, { geminiApiKey: 'test-gemini-key' }),
      studyId: 'study-t',
      isAdmin: false,
      participantSessionId: 'participant-session-t',
    });
    const provider = providerReturning([]);
    providersMock.getInterviewProvider.mockReturnValue(provider);

    const res = await synthesisPOST(makeRequest());

    expect(res.status).toBe(403);
    expect(provider.synthesizeInterview).not.toHaveBeenCalled();
    expect(platformRateLimitMock.hostedAiRateLimitResponse).not.toHaveBeenCalled();
    expect(researcherBudgetMock.researcherAiBudgetResponse).not.toHaveBeenCalled();
  });
});
