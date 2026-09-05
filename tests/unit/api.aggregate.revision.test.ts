// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredInterview, makeStoredStudy } from '../fixtures/models';
// Fixture models standing in for the study's researcher-configured model.
const GEMINI_SYNTHESIS_MODEL = 'gemini-3.7-flash';
const OPENROUTER_SYNTHESIS_MODEL = 'openai/gpt-5.6-terra';

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
  getStudy: vi.fn(),
  getStudyChecked: vi.fn(),
  getStudyInterviewsChecked: vi.fn(),
  isKVAvailable: vi.fn(),
  saveStudyAggregate: vi.fn(),
}));
vi.mock('@/lib/kv', () => kvMock);

const synthesizeAggregate = vi.hoisted(() => vi.fn());
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

const receiptMock = vi.hoisted(() => ({
  aggregateProvenance: vi.fn(() => ({
    aiProvider: 'gemini',
    aiModel: 'gemini-served',
    requestedAiModel: 'gemini-requested',
  })),
}));
vi.mock('@/lib/synthesisReceipt', () => receiptMock);

import { POST } from '@/app/api/synthesis/aggregate/route';

const synthesis = {
  statedPreferences: ['Clear ownership'],
  revealedPreferences: ['Fast feedback'],
  themes: [{ theme: 'Trust', evidence: 'Repeated concern', frequency: 1 }],
  contradictions: [],
  keyInsights: ['Ownership matters'],
  bottomLine: 'Participants need clearer ownership.',
};

// The provider's post-validation return shape: quote *claims*, positioned by
// interviewIndex into the route's own array — never a free-text quote and
// never an interview id (Slice L). interviewIndex 1 is always resolvable
// against these fixtures' two-or-more current-revision interviews.
const aggregate = {
  commonThemes: [{
    theme: 'Trust', frequency: 2,
    quoteRefs: [{ interviewIndex: 1, turnIndex: 1, quote: 'A' }],
  }],
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
      openaiApiKey: null,
      openrouterApiKey: null,
    },
    researcherId: 'researcher-a',
  });
  contextMock.getAuthorizedResearcherStudyContext.mockImplementation(
    () => contextMock.getRequestContext(),
  );
  platformRateLimitMock.hostedAiRateLimitResponse.mockResolvedValue(null);
  kvMock.isKVAvailable.mockResolvedValue(true);
  kvMock.saveStudyAggregate.mockResolvedValue('saved');
  kvMock.getStudyChecked.mockImplementation(async (id: string) => {
    const study = await kvMock.getStudy(id);
    return study ? { status: 'found', study } : { status: 'not-found' };
  });
  getInterviewProvider.mockReturnValue({ synthesizeAggregate });
  synthesizeAggregate.mockResolvedValue({
    value: aggregate,
    execution: {
      provider: 'gemini',
      requestedModel: GEMINI_SYNTHESIS_MODEL,
      model: `${GEMINI_SYNTHESIS_MODEL}-served`,
    },
  });
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
      requestedAiModel: GEMINI_SYNTHESIS_MODEL,
      aiModel: `${GEMINI_SYNTHESIS_MODEL}-served`,
    });
    expect(body.synthesis._receipt).toBeUndefined();
    expect(kvMock.saveStudyAggregate).toHaveBeenCalledTimes(1);
    const [savedAggregate] = kvMock.saveStudyAggregate.mock.calls[0];
    expect(savedAggregate).toMatchObject({
      studyId: study.id,
      studyRevision: 4,
      interviewIds: ['current-a', 'current-b'],
      commonThemes: [expect.objectContaining({
        quoteRefs: [expect.objectContaining({ interviewId: 'current-a' })],
      })],
    });
    expect(Number.isSafeInteger(savedAggregate.savedAt)).toBe(true);
    expect(body.synthesis.savedAt).toBe(savedAggregate.savedAt);
  });

  it('returns the aggregate without savedAt when the write is unavailable', async () => {
    const study = makeStoredStudy({ id: 'study-unavailable-write', revision: 4 });
    study.config.id = study.id;
    kvMock.getStudy.mockResolvedValue(study);
    kvMock.getStudyInterviewsChecked.mockResolvedValue({ status: 'ok', items: [
      makeStoredInterview({ id: 'current-a', studyId: study.id, studyRevision: 4, synthesis }),
      makeStoredInterview({ id: 'current-b', studyId: study.id, studyRevision: 4, synthesis }),
    ] });
    kvMock.saveStudyAggregate.mockResolvedValue('unavailable');

    const response = await POST(new Request('http://localhost/api/synthesis/aggregate', {
      method: 'POST',
      body: JSON.stringify({ studyId: study.id }),
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.synthesis.savedAt).toBeUndefined();
    expect(body.synthesis.studyId).toBe(study.id);
  });

  it('returns the aggregate without savedAt when the write is too large', async () => {
    const study = makeStoredStudy({ id: 'study-too-large-write', revision: 4 });
    study.config.id = study.id;
    kvMock.getStudy.mockResolvedValue(study);
    kvMock.getStudyInterviewsChecked.mockResolvedValue({ status: 'ok', items: [
      makeStoredInterview({ id: 'current-a', studyId: study.id, studyRevision: 4, synthesis }),
      makeStoredInterview({ id: 'current-b', studyId: study.id, studyRevision: 4, synthesis }),
    ] });
    kvMock.saveStudyAggregate.mockResolvedValue('too-large');

    const response = await POST(new Request('http://localhost/api/synthesis/aggregate', {
      method: 'POST',
      body: JSON.stringify({ studyId: study.id }),
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.synthesis.savedAt).toBeUndefined();
    expect(body.synthesis.studyId).toBe(study.id);
  });

  it('records OpenRouter requested, served, and routed provenance from execution', async () => {
    const study = makeStoredStudy({ id: 'study-openrouter', revision: 2 });
    study.config.id = study.id;
    study.config.aiProvider = 'openrouter';
    study.config.aiModel = 'openai/gpt-5.6-terra';
    kvMock.getStudy.mockResolvedValue(study);
    kvMock.getStudyInterviewsChecked.mockResolvedValue({ status: 'ok', items: [
      makeStoredInterview({ id: 'current-a', studyId: study.id, studyRevision: 2, synthesis }),
      makeStoredInterview({ id: 'current-b', studyId: study.id, studyRevision: 2, synthesis }),
    ] });
    synthesizeAggregate.mockResolvedValueOnce({
      value: aggregate,
      execution: {
        provider: 'openrouter',
        requestedModel: OPENROUTER_SYNTHESIS_MODEL,
        model: 'openai/gpt-5.6-sol-2026-08-01',
        routedProvider: 'OpenAI',
      },
    });

    const response = await POST(new Request('http://localhost/api/synthesis/aggregate', {
      method: 'POST',
      body: JSON.stringify({ studyId: study.id }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      synthesis: {
        aiProvider: 'openrouter',
        requestedAiModel: OPENROUTER_SYNTHESIS_MODEL,
        aiModel: 'openai/gpt-5.6-sol-2026-08-01',
        routedProvider: 'OpenAI',
      },
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

  it('returns a safe provider configuration error instead of an internal error', async () => {
    const study = makeStoredStudy({ id: 'study-unconfigured', revision: 1 });
    study.config.id = study.id;
    kvMock.getStudy.mockResolvedValue(study);
    kvMock.getStudyInterviewsChecked.mockResolvedValue({ status: 'ok', items: [
      makeStoredInterview({ id: 'current-a', studyId: study.id, studyRevision: 1, synthesis }),
      makeStoredInterview({ id: 'current-b', studyId: study.id, studyRevision: 1, synthesis }),
    ] });
    getInterviewProvider.mockImplementationOnce(() => {
      throw new Error('missing key');
    });

    const response = await POST(new Request('http://localhost/api/synthesis/aggregate', {
      method: 'POST',
      body: JSON.stringify({ studyId: study.id }),
    }));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: 'AI provider is not configured on the server.',
    });
  });
});
