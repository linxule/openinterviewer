import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeStoredStudy, makeStudyConfig } from '../fixtures/models';
import { standaloneTestContext } from '../helpers/workspaceStoreFixture';
import type { RedisPort } from '@/lib/redisPort';

/**
 * Interview languages on the participant routes (lib/i18n/languages.ts), on
 * the same harness as the canonical-context contract below it.
 *
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
  providerKeysFromContext: vi.fn((context: Record<string, unknown>) => ({
    geminiApiKey: context.geminiApiKey,
    anthropicApiKey: context.anthropicApiKey,
    openaiApiKey: context.openaiApiKey,
    openrouterApiKey: context.openrouterApiKey,
  })),
}));

vi.mock('@/lib/researcherContext', () => contextMock);

const providersMock = vi.hoisted(() => ({
  getInterviewProvider: vi.fn(),
  resolveProviderType: vi.fn((config?: { aiProvider?: string }) => (
    config?.aiProvider === 'claude' ? 'claude' : 'gemini'
  )),
  resolveSynthesisModel: vi.fn((config: { aiProvider?: string; aiModel?: string }) => (
    config?.aiModel ?? (config?.aiProvider === 'claude' ? 'claude-opus-4-5' : 'gemini-3.1-pro-preview')
  )),
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

const rateLimitMock = vi.hoisted(() => ({
  participantStoreAdmissionResponse: vi.fn(),
  participantAdmissionRefusal: vi.fn(() => null),
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

import { POST as interviewPOST } from '@/app/api/interview/route';
import { POST as greetingPOST } from '@/app/api/greeting/route';
import { POST as synthesisPOST } from '@/app/api/synthesis/route';
const canonicalConfig = makeStudyConfig({
  id: 'study-a',
  consentText: 'English consent.',
  interviewLanguages: ['en', 'ja'],
  consentTextTranslations: { ja: '日本語の同意文。' },
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

const sessionContext = standaloneTestContext({} as RedisPort, {
  geminiApiKey: 'canonical-gemini-key',
  researcherId: 'researcher-a',
});

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
  rateLimitMock.participantStoreAdmissionResponse.mockResolvedValue(null);
  platformRateLimitMock.hostedAiRateLimitResponse.mockResolvedValue(null);
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
      value: {
        statedPreferences: ['Clear ownership'],
        revealedPreferences: ['Fast feedback'],
        themes: [{ theme: 'Trust', evidence: 'Repeated concern', frequency: 1 }],
        contradictions: [],
        keyInsights: ['Ownership matters'],
        bottomLine: 'Participants need clearer ownership.',
      },
      execution: {
        provider: 'gemini',
        requestedModel: 'gemini-3.1-pro-preview',
        model: 'gemini-3.1-pro-preview-001',
      },
    }),
  });
});


const turnBody = (extra: Record<string, unknown>) => ({
  history: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }],
  studyConfig: { id: 'study-a' },
  participantProfile: null,
  questionProgress: { questionsAsked: [], total: 1, currentPhase: 'background', isComplete: false },
  currentContext: '',
  ...extra,
});

describe('participant language binding', () => {
  it('verifies consent against the chosen language\'s text and conducts the interview in it', async () => {
    const res = await interviewPOST(makeRequest(turnBody({ language: 'ja' })));
    expect(res.status).toBe(200);
    expect(consentMock.verifyParticipantConsent).toHaveBeenCalledWith(
      expect.objectContaining({ consentText: '日本語の同意文。' }),
      expect.anything(),
    );
    const provider = providersMock.getInterviewProvider.mock.results[0].value;
    expect(provider.generateInterviewResponse.mock.calls[0][1].interviewLanguages).toEqual(['ja']);
  });

  it('uses the study\'s first language when an older client sends none', async () => {
    const res = await greetingPOST(makeRequest({ studyConfig: { id: 'study-a' } }));
    expect(res.status).toBe(200);
    expect(consentMock.verifyParticipantConsent).toHaveBeenCalledWith(
      expect.objectContaining({ consentText: 'English consent.' }),
      expect.anything(),
    );
    const provider = providersMock.getInterviewProvider.mock.results[0].value;
    expect(provider.getInterviewGreeting.mock.calls[0][0].interviewLanguages).toEqual(['en']);
  });

  it('refuses a language the study does not offer before any consent check or provider call', async () => {
    for (const post of [interviewPOST, greetingPOST]) {
      const res = await post(makeRequest(turnBody({ language: 'ko' })));
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('LANGUAGE_NOT_OFFERED');
    }
    expect(consentMock.verifyParticipantConsent).not.toHaveBeenCalled();
    expect(providersMock.getInterviewProvider).not.toHaveBeenCalled();
  });

  it('a switched language fails consent verification instead of reaching the provider', async () => {
    consentMock.verifyParticipantConsent.mockResolvedValue({ status: 'mismatch' });
    const res = await interviewPOST(makeRequest(turnBody({ language: 'en' })));
    expect(res.status).toBe(428);
    expect(providersMock.getInterviewProvider).not.toHaveBeenCalled();
  });
});
