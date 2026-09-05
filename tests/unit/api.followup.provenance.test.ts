// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredInterview, makeStoredStudy } from '../fixtures/models';
import { GEMINI_SYNTHESIS_MODEL, StoredStudy } from '@/types';
import { ProviderFailure } from '@/lib/providerErrors';

const contextMock = vi.hoisted(() => ({
  getRequestContext: vi.fn(),
  getAuthorizedResearcherStudyContext: vi.fn(),
  providerKeysFromContext: vi.fn((context: Record<string, unknown>) => ({
    geminiApiKey: context.geminiApiKey,
    anthropicApiKey: context.anthropicApiKey,
    openaiApiKey: context.openaiApiKey,
    openrouterApiKey: context.openrouterApiKey,
  })),
}));
vi.mock('@/lib/researcherContext', () => contextMock);

const kvMock = vi.hoisted(() => ({
  getStudyChecked: vi.fn(),
  getStudyInterviewsChecked: vi.fn(),
}));
vi.mock('@/lib/kv', () => kvMock);

const generateFollowupStudy = vi.hoisted(() => vi.fn());
const getInterviewProvider = vi.hoisted(() => vi.fn());
vi.mock('@/lib/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/providers')>();
  return {
    ...actual,
    getInterviewProvider,
  };
});

const platformRateLimitMock = vi.hoisted(() => ({ hostedAiRateLimitResponse: vi.fn() }));
vi.mock('@/lib/platformAiRateLimit', () => platformRateLimitMock);

const receiptMock = vi.hoisted(() => ({ verifyAggregateSynthesisReceipt: vi.fn() }));
vi.mock('@/lib/synthesisReceipt', () => receiptMock);

import { POST } from '@/app/api/studies/[id]/generate-followup/route';

const aggregate = {
  studyId: 'study-followup',
  studyRevision: 3,
  interviewIds: ['interview-a', 'interview-b'],
  interviewCount: 2,
  aiProvider: 'gemini',
  aiModel: 'gemini-2.5-flash',
  commonThemes: [{ theme: 'Trust', frequency: 2, representativeQuotes: ['A'] }],
  divergentViews: [],
  keyFindings: ['Trust matters'],
  researchImplications: ['Study ownership'],
  bottomLine: 'Trust shapes adoption.',
  generatedAt: Date.now(),
  _receipt: 'aggregate-receipt',
};

let parentStudy: StoredStudy;

function request(synthesis: unknown) {
  return new Request('http://localhost/api/studies/study-followup/generate-followup', {
    method: 'POST',
    body: JSON.stringify({ synthesis }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  contextMock.getRequestContext.mockResolvedValue({
    authorized: true,
    context: {
      kvClient: {},
      geminiApiKey: 'key',
      anthropicApiKey: null,
      openaiApiKey: null,
      openrouterApiKey: null,
    },
    researcherId: 'researcher-a',
  });
  contextMock.getAuthorizedResearcherStudyContext.mockImplementation(
    () => contextMock.getRequestContext(),
  );
  platformRateLimitMock.hostedAiRateLimitResponse.mockResolvedValue(null);
  receiptMock.verifyAggregateSynthesisReceipt.mockResolvedValue({
    aiProvider: 'gemini',
    aiModel: GEMINI_SYNTHESIS_MODEL,
    requestedAiModel: GEMINI_SYNTHESIS_MODEL,
  });
  getInterviewProvider.mockReturnValue({ generateFollowupStudy });
  parentStudy = makeStoredStudy({ id: 'study-followup', revision: 3 });
  parentStudy.config.id = parentStudy.id;
  kvMock.getStudyChecked.mockResolvedValue({ status: 'found', study: parentStudy });
  kvMock.getStudyInterviewsChecked.mockResolvedValue({
    status: 'ok',
    items: [
      makeStoredInterview({ id: 'interview-a', studyId: parentStudy.id, studyRevision: 3, synthesis: {} as never }),
      makeStoredInterview({ id: 'interview-b', studyId: parentStudy.id, studyRevision: 3, synthesis: {} as never }),
      makeStoredInterview({ id: 'old', studyId: parentStudy.id, studyRevision: 2, synthesis: {} as never }),
    ],
  });
  generateFollowupStudy.mockResolvedValue({
    value: {
      name: 'Follow-up',
      researchQuestion: 'What creates trust?',
      coreQuestions: ['When did trust change?'],
    },
    execution: {
      provider: 'gemini',
      requestedModel: GEMINI_SYNTHESIS_MODEL,
      model: `${GEMINI_SYNTHESIS_MODEL}-served`,
    },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('follow-up synthesis provenance', () => {
  it('accepts only current-revision interview provenance', async () => {
    const response = await POST(request(aggregate), { params: Promise.resolve({ id: 'study-followup' }) });

    expect(response.status).toBe(200);
    expect(generateFollowupStudy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'study-followup' }),
      expect.objectContaining({
        interviewIds: ['interview-a', 'interview-b'],
        studyRevision: 3,
        aiProvider: 'gemini',
        aiModel: GEMINI_SYNTHESIS_MODEL,
      })
    );
    expect(platformRateLimitMock.hostedAiRateLimitResponse).toHaveBeenCalledWith(
      expect.any(Request),
      'followup',
      { researcherId: 'researcher-a' }
    );
    await expect(response.json()).resolves.toMatchObject({
      generation: {
        provider: 'gemini',
        requestedModel: GEMINI_SYNTHESIS_MODEL,
        model: `${GEMINI_SYNTHESIS_MODEL}-served`,
      },
    });
  });

  it('accepts a resolved aggregate whose refs carry a server-stamped interviewId (Slice L)', async () => {
    const resolvedAggregate = {
      ...aggregate,
      commonThemes: [{
        theme: 'Trust', frequency: 2,
        quoteRefs: [{ quote: 'A trusted answer.', turnIndex: 2, interviewId: 'interview-a' }],
      }],
    };

    const response = await POST(request(resolvedAggregate), { params: Promise.resolve({ id: 'study-followup' }) });

    expect(response.status).toBe(200);
    expect(generateFollowupStudy).toHaveBeenCalled();
  });

  it('rejects an unresolved aggregate carrying interviewIndex instead of interviewId before calling a provider', async () => {
    const unresolvedAggregate = {
      ...aggregate,
      commonThemes: [{
        theme: 'Trust', frequency: 2,
        quoteRefs: [{ quote: 'A trusted answer.', turnIndex: 2, interviewIndex: 1 }],
      }],
    };

    const response = await POST(request(unresolvedAggregate), { params: Promise.resolve({ id: 'study-followup' }) });

    expect(response.status).toBe(400);
    expect(generateFollowupStudy).not.toHaveBeenCalled();
  });

  it('preserves signed aggregate provenance when a study has no explicit provider', async () => {
    delete parentStudy.config.aiProvider;
    delete parentStudy.config.aiModel;

    const response = await POST(request(aggregate), { params: Promise.resolve({ id: 'study-followup' }) });

    expect(response.status).toBe(200);
    expect(generateFollowupStudy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'study-followup' }),
      expect.objectContaining({
        aiProvider: 'gemini',
        aiModel: GEMINI_SYNTHESIS_MODEL,
      })
    );
  });

  it('rejects stale or invented interview provenance before calling a provider', async () => {
    const response = await POST(
      request({ ...aggregate, interviewIds: ['interview-a', 'old'], interviewCount: 2 }),
      { params: Promise.resolve({ id: 'study-followup' }) }
    );

    expect(response.status).toBe(409);
    expect(generateFollowupStudy).not.toHaveBeenCalled();
  });

  it('rejects browser-tampered aggregate content before calling a provider', async () => {
    receiptMock.verifyAggregateSynthesisReceipt.mockResolvedValueOnce(null);

    const response = await POST(request({ ...aggregate, bottomLine: 'Fabricated finding.' }), {
      params: Promise.resolve({ id: 'study-followup' }),
    });

    expect(response.status).toBe(403);
    expect(generateFollowupStudy).not.toHaveBeenCalled();
  });

  it('returns a safe provider configuration error instead of an internal error', async () => {
    getInterviewProvider.mockImplementationOnce(() => {
      throw new Error('missing key');
    });

    const response = await POST(request(aggregate), {
      params: Promise.resolve({ id: 'study-followup' }),
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: 'AI provider is not configured on the server.',
    });
  });

  it('maps follow-up provider failures without exposing provider details', async () => {
    generateFollowupStudy.mockRejectedValueOnce(
      new ProviderFailure('rate-limited', 'secret upstream response')
    );

    const response = await POST(request(aggregate), {
      params: Promise.resolve({ id: 'study-followup' }),
    });

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({
      error: 'The AI provider is receiving too many requests right now. Please try again shortly.',
      retryable: true,
    });
    expect(JSON.stringify(body)).not.toContain('secret upstream response');
  });
});
