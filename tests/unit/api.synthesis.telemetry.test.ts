// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeStoredStudy, makeStudyConfig } from '../fixtures/models';

/**
 * Slice I2d: /api/synthesis emits a counts-only `synthesis.evidence` log event
 * (refs offered vs refs located against the transcript) on the success path.
 * ADR-003: no quote text, turn text, or anything derived from participant
 * speech may reach a log line. All fixture content below is invented.
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

const kvMock = vi.hoisted(() => ({ getStudy: vi.fn() }));
vi.mock('@/lib/kv', () => kvMock);

const rateLimitMock = vi.hoisted(() => ({
  participantRateLimitResponse: vi.fn(),
  refundParticipantRateLimit: vi.fn(),
}));
vi.mock('@/lib/rateLimit', () => rateLimitMock);

const platformRateLimitMock = vi.hoisted(() => ({ hostedAiRateLimitResponse: vi.fn() }));
vi.mock('@/lib/platformAiRateLimit', () => platformRateLimitMock);

const consentMock = vi.hoisted(() => ({ verifyParticipantConsent: vi.fn() }));
vi.mock('@/lib/participantConsent', () => consentMock);

const receiptMock = vi.hoisted(() => ({ createSynthesisReceipt: vi.fn() }));
vi.mock('@/lib/synthesisReceipt', () => receiptMock);

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
    context: {
      kvClient: {} as never,
      geminiApiKey: 'test-gemini-key',
      anthropicApiKey: null,
      openaiApiKey: null,
      openrouterApiKey: null,
      researcherId: 'researcher-t',
      onboardingComplete: true,
    },
    studyId: 'study-t',
    isAdmin: false,
    participantSessionId: 'participant-session-t',
  });
  kvMock.getStudy.mockResolvedValue(makeStoredStudy({ id: 'study-t', config: studyConfig }));
  rateLimitMock.participantRateLimitResponse.mockResolvedValue(null);
  rateLimitMock.refundParticipantRateLimit.mockResolvedValue(undefined);
  platformRateLimitMock.hostedAiRateLimitResponse.mockResolvedValue(null);
  receiptMock.createSynthesisReceipt.mockResolvedValue('synthesis-receipt');
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

describe('POST /api/synthesis evidence telemetry', () => {
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
});

describe('POST /api/synthesis participant rate-limit refund', () => {
  it('refunds the participant synthesis budget when the provider call fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    providersMock.getInterviewProvider.mockReturnValue({
      generateInterviewResponse: vi.fn(),
      getInterviewGreeting: vi.fn(),
      synthesizeInterview: vi.fn().mockRejectedValue(new Error('provider unavailable')),
    });

    const res = await synthesisPOST(makeRequest());
    expect(res.status).toBeGreaterThanOrEqual(500);

    expect(rateLimitMock.refundParticipantRateLimit).toHaveBeenCalledTimes(1);
    const [, studyId, operation, , authority] = rateLimitMock.refundParticipantRateLimit.mock.calls[0];
    expect(studyId).toBe('study-t');
    expect(operation).toBe('synthesis');
    expect(authority).toMatchObject({
      sessionId: 'participant-session-t',
      researcherId: 'researcher-t',
    });
  });

  it('does not refund the participant synthesis budget when synthesis succeeds', async () => {
    providersMock.getInterviewProvider.mockReturnValue(providerReturning([]));

    const res = await synthesisPOST(makeRequest());
    expect(res.status).toBe(200);

    expect(rateLimitMock.refundParticipantRateLimit).not.toHaveBeenCalled();
  });
});
