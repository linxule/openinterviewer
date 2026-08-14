// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredInterview, makeStoredStudy } from '../fixtures/models';

const contextMock = vi.hoisted(() => ({ getRequestContext: vi.fn() }));
vi.mock('@/lib/researcherContext', () => contextMock);

const kvMock = vi.hoisted(() => ({
  getStudyChecked: vi.fn(),
  getStudyInterviewsChecked: vi.fn(),
}));
vi.mock('@/lib/kv', () => kvMock);

const generateFollowupStudy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/providers', () => ({
  getInterviewProvider: () => ({ generateFollowupStudy }),
}));

const platformRateLimitMock = vi.hoisted(() => ({ hostedAiRateLimitResponse: vi.fn() }));
vi.mock('@/lib/platformAiRateLimit', () => platformRateLimitMock);

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
};

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
      researcherId: 'researcher-a',
    },
  });
  platformRateLimitMock.hostedAiRateLimitResponse.mockResolvedValue(null);
  const study = makeStoredStudy({ id: 'study-followup', revision: 3 });
  study.config.id = study.id;
  kvMock.getStudyChecked.mockResolvedValue({ status: 'found', study });
  kvMock.getStudyInterviewsChecked.mockResolvedValue({
    status: 'ok',
    items: [
      makeStoredInterview({ id: 'interview-a', studyId: study.id, studyRevision: 3, synthesis: {} as never }),
      makeStoredInterview({ id: 'interview-b', studyId: study.id, studyRevision: 3, synthesis: {} as never }),
      makeStoredInterview({ id: 'old', studyId: study.id, studyRevision: 2, synthesis: {} as never }),
    ],
  });
  generateFollowupStudy.mockResolvedValue({
    name: 'Follow-up',
    researchQuestion: 'What creates trust?',
    coreQuestions: ['When did trust change?'],
  });
});

describe('follow-up synthesis provenance', () => {
  it('accepts only current-revision interview provenance', async () => {
    const response = await POST(request(aggregate), { params: Promise.resolve({ id: 'study-followup' }) });

    expect(response.status).toBe(200);
    expect(generateFollowupStudy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'study-followup' }),
      expect.objectContaining({ interviewIds: ['interview-a', 'interview-b'], studyRevision: 3 })
    );
    expect(platformRateLimitMock.hostedAiRateLimitResponse).toHaveBeenCalledWith(
      expect.any(Request),
      'followup',
      { researcherId: 'researcher-a' }
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
});
