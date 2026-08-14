// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredInterview, makeStoredStudy } from '../fixtures/models';

const contextMock = vi.hoisted(() => ({ getRequestContext: vi.fn() }));
vi.mock('@/lib/researcherContext', () => contextMock);

const kvMock = vi.hoisted(() => ({
  getStudy: vi.fn(),
  getStudyInterviewsChecked: vi.fn(),
  isKVAvailable: vi.fn(),
}));
vi.mock('@/lib/kv', () => kvMock);

const synthesizeAggregate = vi.hoisted(() => vi.fn());
vi.mock('@/lib/providers', () => ({
  getInterviewProvider: () => ({ synthesizeAggregate }),
}));

const platformRateLimitMock = vi.hoisted(() => ({ hostedAiRateLimitResponse: vi.fn() }));
vi.mock('@/lib/platformAiRateLimit', () => platformRateLimitMock);

import { POST } from '@/app/api/synthesis/aggregate/route';

const synthesis = {
  statedPreferences: ['Clear ownership'],
  revealedPreferences: ['Fast feedback'],
  themes: [{ theme: 'Trust', evidence: 'Repeated concern', frequency: 1 }],
  contradictions: [],
  keyInsights: ['Ownership matters'],
  bottomLine: 'Participants need clearer ownership.',
};

const aggregate = {
  commonThemes: [{ theme: 'Trust', frequency: 2, representativeQuotes: ['A', 'B'] }],
  divergentViews: [],
  keyFindings: ['Trust is central'],
  researchImplications: ['Clarify ownership'],
  bottomLine: 'Trust and ownership shape adoption.',
};

beforeEach(() => {
  vi.clearAllMocks();
  contextMock.getRequestContext.mockResolvedValue({
    authorized: true,
    context: {
      kvClient: {},
      geminiApiKey: 'test-key',
      anthropicApiKey: null,
      researcherId: 'researcher-a',
    },
  });
  platformRateLimitMock.hostedAiRateLimitResponse.mockResolvedValue(null);
  kvMock.isKVAvailable.mockResolvedValue(true);
  synthesizeAggregate.mockResolvedValue(aggregate);
});

describe('aggregate synthesis revision provenance', () => {
  it('uses only synthesized interviews from the current study revision', async () => {
    const study = makeStoredStudy({ id: 'study-aggregate', revision: 4 });
    study.config.id = study.id;
    kvMock.getStudy.mockResolvedValue(study);
    kvMock.getStudyInterviewsChecked.mockResolvedValue({ status: 'ok', items: [
      makeStoredInterview({ id: 'current-a', studyId: study.id, studyRevision: 4, synthesis }),
      makeStoredInterview({ id: 'current-b', studyId: study.id, studyRevision: 4, synthesis }),
      makeStoredInterview({ id: 'old', studyId: study.id, studyRevision: 3, synthesis }),
      makeStoredInterview({ id: 'unknown', studyId: study.id, synthesis }),
    ] });

    const response = await POST(new Request('http://localhost/api/synthesis/aggregate', {
      method: 'POST',
      body: JSON.stringify({ studyId: study.id }),
    }));

    expect(response.status).toBe(200);
    expect(synthesizeAggregate).toHaveBeenCalledWith(study.config, [synthesis, synthesis], 2);
    expect(platformRateLimitMock.hostedAiRateLimitResponse).toHaveBeenCalledWith(
      expect.any(Request),
      'aggregate',
      { researcherId: 'researcher-a' }
    );
    const body = await response.json();
    expect(body.synthesis).toMatchObject({
      studyId: study.id,
      studyRevision: 4,
      interviewIds: ['current-a', 'current-b'],
      interviewCount: 2,
      aiProvider: 'gemini',
      aiModel: 'gemini-2.5-flash',
    });
  });

  it('refuses to mix old or unknown revisions to reach the minimum sample', async () => {
    const study = makeStoredStudy({ id: 'study-mixed', revision: 2 });
    study.config.id = study.id;
    kvMock.getStudy.mockResolvedValue(study);
    kvMock.getStudyInterviewsChecked.mockResolvedValue({ status: 'ok', items: [
      makeStoredInterview({ id: 'current', studyId: study.id, studyRevision: 2, synthesis }),
      makeStoredInterview({ id: 'old', studyId: study.id, studyRevision: 1, synthesis }),
      makeStoredInterview({ id: 'unknown', studyId: study.id, synthesis }),
    ] });

    const response = await POST(new Request('http://localhost/api/synthesis/aggregate', {
      method: 'POST',
      body: JSON.stringify({ studyId: study.id }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ studyRevision: 2, eligibleInterviewCount: 1 });
    expect(synthesizeAggregate).not.toHaveBeenCalled();
  });
});
