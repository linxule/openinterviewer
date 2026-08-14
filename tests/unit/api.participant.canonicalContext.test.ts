import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeStoredStudy, makeStudyConfig } from '../fixtures/models';

/**
 * Participant API canonical-context contract.
 *
 * /api/interview and /api/greeting must derive the AI provider/model from the
 * canonical server-side study configuration (resolved from the token's
 * studyId), never from client-supplied request-body provider/model fields.
 *
 * Regression coverage: a client-controlled legacy studyConfig may identify the
 * study, but cannot steer the provider or model.
 */

const contextMock = vi.hoisted(() => ({
  getParticipantRequestContext: vi.fn(),
}));

vi.mock('@/lib/researcherContext', () => contextMock);

const providersMock = vi.hoisted(() => ({
  getInterviewProvider: vi.fn(),
}));

vi.mock('@/lib/providers', () => providersMock);

const kvMock = vi.hoisted(() => ({
  getStudy: vi.fn(),
}));

vi.mock('@/lib/kv', () => kvMock);

const rateLimitMock = vi.hoisted(() => ({
  participantRateLimitResponse: vi.fn(),
}));

vi.mock('@/lib/rateLimit', () => rateLimitMock);

const platformRateLimitMock = vi.hoisted(() => ({
  hostedAiRateLimitResponse: vi.fn(),
}));

vi.mock('@/lib/platformAiRateLimit', () => platformRateLimitMock);

const consentMock = vi.hoisted(() => ({
  verifyParticipantConsent: vi.fn(),
}));

vi.mock('@/lib/participantConsent', () => consentMock);

const receiptMock = vi.hoisted(() => ({
  createSynthesisReceipt: vi.fn(),
}));

vi.mock('@/lib/synthesisReceipt', () => receiptMock);

import { POST as interviewPOST } from '@/app/api/interview/route';
import { POST as greetingPOST } from '@/app/api/greeting/route';
import { POST as synthesisPOST } from '@/app/api/synthesis/route';
const canonicalConfig = makeStudyConfig({
  id: 'study-a',
  name: 'Canonical Study',
  aiProvider: 'gemini',
  aiModel: 'gemini-2.5-flash',
});

// Client-supplied config tries to force a different provider/model
const bodyConfig = makeStudyConfig({
  id: 'study-a',
  name: 'Canonical Study',
  aiProvider: 'claude',
  aiModel: 'claude-haiku-4-5',
});

const makeRequest = (body: unknown) =>
  new Request('http://localhost/api/interview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const sessionContext = {
  kvClient: {} as never,
  geminiApiKey: 'canonical-gemini-key',
  anthropicApiKey: null,
  researcherId: 'researcher-a',
  onboardingComplete: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  contextMock.getParticipantRequestContext.mockResolvedValue({
    valid: true,
    context: sessionContext,
    studyId: 'study-a',
    isAdmin: false,
    participantSessionId: 'participant-session-a',
  });
  kvMock.getStudy.mockResolvedValue(makeStoredStudy({ id: 'study-a', config: canonicalConfig }));
  rateLimitMock.participantRateLimitResponse.mockResolvedValue(null);
  platformRateLimitMock.hostedAiRateLimitResponse.mockResolvedValue(null);
  receiptMock.createSynthesisReceipt.mockResolvedValue('synthesis-receipt');
  consentMock.verifyParticipantConsent.mockResolvedValue({
    status: 'accepted',
    consent: {
      version: 1,
      participantSessionId: 'participant-session-a',
      studyId: 'study-a',
      studyRevision: 1,
      consentHash: 'a'.repeat(64),
      acceptedAt: 1_700_000_000_000,
    },
  });
  providersMock.getInterviewProvider.mockReturnValue({
    generateInterviewResponse: vi.fn().mockResolvedValue({
      message: 'server response',
      questionAddressed: null,
      phaseTransition: null,
      profileUpdates: [],
      shouldConclude: false,
    }),
    getInterviewGreeting: vi.fn().mockResolvedValue('server greeting'),
    synthesizeInterview: vi.fn().mockResolvedValue({
      statedPreferences: ['Clear ownership'],
      revealedPreferences: ['Fast feedback'],
      themes: [{ theme: 'Trust', evidence: 'Repeated concern', frequency: 1 }],
      contradictions: [],
      keyInsights: ['Ownership matters'],
      bottomLine: 'Participants need clearer ownership.',
    }),
  });
});

describe('POST /api/interview canonical provider context', () => {
  it('builds the provider from the canonical server study config, not the request body', async () => {
    const res = await interviewPOST(
      makeRequest({
        history: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }],
        studyConfig: bodyConfig,
        participantProfile: null,
        questionProgress: { questionsAsked: [], total: 0, currentPhase: 'background', isComplete: false },
        currentContext: '',
      })
    );

    expect(res.status).toBe(200);

    const providerConfig = providersMock.getInterviewProvider.mock.calls[0][0] as {
      aiProvider: string;
      aiModel: string;
    };
    // Canonical wins: Gemini, never the body's Claude selection.
    expect(providerConfig.aiProvider).toBe('gemini');
    expect(providerConfig.aiModel).toBe('gemini-2.5-flash');
    expect(providerConfig.aiProvider).not.toBe(bodyConfig.aiProvider);
    expect(providerConfig.aiModel).not.toBe(bodyConfig.aiModel);

    // Keys must come from the server context, not the request
    expect(providersMock.getInterviewProvider.mock.calls[0][1]).toMatchObject({
      geminiApiKey: 'canonical-gemini-key',
    });

    const provider = providersMock.getInterviewProvider.mock.results[0].value;
    expect(provider.generateInterviewResponse.mock.calls[0][1]).toMatchObject({
      id: 'study-a',
      aiProvider: 'gemini',
      aiModel: 'gemini-2.5-flash',
    });
    expect(platformRateLimitMock.hostedAiRateLimitResponse).toHaveBeenCalledWith(
      expect.any(Request),
      'interview',
      { researcherId: 'researcher-a', participantSessionId: 'participant-session-a' }
    );
  });

  it('fails closed before provider use when canonical consent is missing', async () => {
    consentMock.verifyParticipantConsent.mockResolvedValue({ status: 'missing' });

    const res = await interviewPOST(
      makeRequest({
        history: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }],
        studyConfig: bodyConfig,
        participantProfile: null,
        questionProgress: { questionsAsked: [], total: 0, currentPhase: 'background', isComplete: false },
        currentContext: '',
      })
    );

    expect(res.status).toBe(428);
    expect(providersMock.getInterviewProvider).not.toHaveBeenCalled();
  });

  it('does not construct a provider when the hosted platform budget is unavailable', async () => {
    platformRateLimitMock.hostedAiRateLimitResponse.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Unable to verify hosted AI request limits.' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const res = await interviewPOST(
      makeRequest({
        history: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }],
        studyConfig: bodyConfig,
        participantProfile: null,
        questionProgress: { questionsAsked: [], total: 0, currentPhase: 'background', isComplete: false },
        currentContext: '',
      })
    );

    expect(res.status).toBe(503);
    expect(providersMock.getInterviewProvider).not.toHaveBeenCalled();
  });
});

describe('POST /api/greeting canonical provider context', () => {
  it('uses the canonical study config for the greeting provider', async () => {
    const res = await greetingPOST(
      new Request('http://localhost/api/greeting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studyConfig: bodyConfig }),
      })
    );

    expect(res.status).toBe(200);

    const providerConfig = providersMock.getInterviewProvider.mock.calls[0][0] as {
      aiProvider: string;
      aiModel: string;
    };
    expect(providerConfig.aiProvider).toBe('gemini');
    expect(providerConfig.aiModel).toBe('gemini-2.5-flash');

    const provider = providersMock.getInterviewProvider.mock.results[0].value;
    expect(provider.getInterviewGreeting.mock.calls[0][0]).toMatchObject({
      id: 'study-a',
      aiModel: 'gemini-2.5-flash',
    });
    expect(platformRateLimitMock.hostedAiRateLimitResponse).toHaveBeenCalledWith(
      expect.any(Request),
      'greeting',
      { researcherId: 'researcher-a', participantSessionId: 'participant-session-a' }
    );
  });
});

describe('POST /api/synthesis hosted platform limits', () => {
  it('enforces the platform-owned participant scope before synthesis', async () => {
    const res = await synthesisPOST(
      new Request('http://localhost/api/synthesis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          history: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }],
          studyConfig: bodyConfig,
          participantProfile: null,
          behaviorData: {
            timePerTopic: {},
            messagesPerTopic: {},
            topicsExplored: [],
            contradictions: [],
          },
        }),
      })
    );

    expect(res.status).toBe(200);
    expect(platformRateLimitMock.hostedAiRateLimitResponse).toHaveBeenCalledWith(
      expect.any(Request),
      'synthesis',
      { researcherId: 'researcher-a', participantSessionId: 'participant-session-a' }
    );
    expect(providersMock.getInterviewProvider.mock.results[0].value.synthesizeInterview)
      .toHaveBeenCalledOnce();
  });
});
