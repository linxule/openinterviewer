// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredInterview } from '../fixtures/models';
import { hostedTestContext } from '../helpers/workspaceStoreFixture';
import type { RedisPort } from '@/lib/redisPort';

/**
 * The tenancy test for POST /api/interviews/[id]/analyze — the analyze
 * route attacks the same cross-tenant line as the plain GET
 * (interviews/[id]/route.ts:58-60): a researcher authorized for one study
 * must never analyze another study's interview by naming it in the path
 * while asserting a studyId they do own in the query string.
 */

const contextMock = vi.hoisted(() => ({
  getAuthorizedResearcherStudyContext: vi.fn(),
  providerKeysFromContext: vi.fn(() => ({})),
}));
vi.mock('@/lib/researcherContext', () => contextMock);

const kvMock = vi.hoisted(() => ({ getInterviewChecked: vi.fn() }));
vi.mock('@/lib/kv', () => kvMock);

const canonicalMock = vi.hoisted(() => ({ loadCanonicalStudy: vi.fn() }));
vi.mock('@/lib/canonicalStudy', () => canonicalMock);

const rateLimitMock = vi.hoisted(() => ({ hostedAiRateLimitResponse: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/platformAiRateLimit', () => rateLimitMock);
const researcherBudgetMock = vi.hoisted(() => ({ researcherAiBudgetResponse: vi.fn(async () => null) }));
vi.mock('@/lib/researcherAiBudget', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/researcherAiBudget')>()),
  ...researcherBudgetMock,
}));

const analysisMock = vi.hoisted(() => ({ runInterviewAnalysis: vi.fn() }));
vi.mock('@/lib/interviewAnalysis', () => analysisMock);

import { GET, OPTIONS, POST } from '@/app/api/interviews/[id]/analyze/route';

const makeRequest = (id: string, studyId?: string) => {
  const url = new URL(`http://localhost/api/interviews/${id}/analyze`);
  if (studyId !== undefined) url.searchParams.set('studyId', studyId);
  return {
    request: new Request(url, { method: 'POST' }),
    params: Promise.resolve({ id }),
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  rateLimitMock.hostedAiRateLimitResponse.mockResolvedValue(null);
});

describe('POST /api/interviews/[id]/analyze — tenancy', () => {
  it('404s and makes no provider call when the interview belongs to a different study than the one authorized', async () => {
    contextMock.getAuthorizedResearcherStudyContext.mockResolvedValue({
      authorized: true,
      context: hostedTestContext({} as RedisPort, 'researcher-b'),
      researcherId: 'researcher-b',
    });
    kvMock.getInterviewChecked.mockResolvedValue({
      status: 'found',
      interview: makeStoredInterview({ id: 'interview-in-a', studyId: 'study-a' }),
    });

    const { request, params } = makeRequest('interview-in-a', 'study-b');
    const response = await POST(request, { params });

    expect(response.status).toBe(404);
    expect(analysisMock.runInterviewAnalysis).not.toHaveBeenCalled();
    expect(rateLimitMock.hostedAiRateLimitResponse).not.toHaveBeenCalled();
  });

  it('401/403s from getAuthorizedResearcherStudyContext when the researcher is not authorized for the named study, with no provider call', async () => {
    contextMock.getAuthorizedResearcherStudyContext.mockResolvedValue({
      authorized: false,
      context: null,
      error: 'Unauthorized',
      statusCode: 403,
    });

    const { request, params } = makeRequest('interview-in-a', 'study-a');
    const response = await POST(request, { params });

    expect(response.status).toBe(403);
    expect(kvMock.getInterviewChecked).not.toHaveBeenCalled();
    expect(analysisMock.runInterviewAnalysis).not.toHaveBeenCalled();
  });

  it('400s on a missing studyId, required in both modes unlike the plain GET', async () => {
    const { request, params } = makeRequest('interview-in-a');
    const response = await POST(request, { params });

    expect(response.status).toBe(400);
    expect(contextMock.getAuthorizedResearcherStudyContext).not.toHaveBeenCalled();
    expect(analysisMock.runInterviewAnalysis).not.toHaveBeenCalled();
  });

  it('400s on an invalid studyId shape', async () => {
    const { request, params } = makeRequest('interview-in-a', 'not a valid id!!');
    const response = await POST(request, { params });

    expect(response.status).toBe(400);
    expect(contextMock.getAuthorizedResearcherStudyContext).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: 'complete' }, 200, { status: 'complete' }],
    [{ status: 'failed', failureKind: 'provider' }, 200, { status: 'failed', failureKind: 'provider' }],
    [{ status: 'busy' }, 200, { status: 'busy' }],
    [{ status: 'already-complete' }, 200, { status: 'already-complete' }],
    [{ status: 'unavailable' }, 503, {
      error: 'Interview storage is temporarily unavailable. Please try again.', retryable: true,
    }],
  ])('returns the factual analysis outcome %j as HTTP %i for an authorized request', async (outcome, status, body) => {
    contextMock.getAuthorizedResearcherStudyContext.mockResolvedValue({
      authorized: true,
      context: hostedTestContext({} as RedisPort, 'researcher-a'),
      researcherId: 'researcher-a',
    });
    kvMock.getInterviewChecked.mockResolvedValue({
      status: 'found',
      interview: makeStoredInterview({ id: 'interview-in-a', studyId: 'study-a' }),
    });
    canonicalMock.loadCanonicalStudy.mockResolvedValue({
      ok: true,
      study: { id: 'study-a', revision: 1, config: { aiProvider: 'gemini', aiModel: 'gemini-3.7-flash' } },
    });
    analysisMock.runInterviewAnalysis.mockResolvedValue(outcome);

    const { request, params } = makeRequest('interview-in-a', 'study-a');
    const response = await POST(request, { params });

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual(body);
    expect(analysisMock.runInterviewAnalysis).toHaveBeenCalledTimes(1);
  });
});

describe('Node target keeps the synchronous analyze contract (API-01 compatibility)', () => {
  function authorizedNodeContext() {
    const context = hostedTestContext({} as RedisPort, 'researcher-a');
    contextMock.getAuthorizedResearcherStudyContext.mockResolvedValue({
      authorized: true,
      context,
      researcherId: 'researcher-a',
    });
    kvMock.getInterviewChecked.mockResolvedValue({
      status: 'found',
      interview: makeStoredInterview({ id: 'interview-in-a', studyId: 'study-a' }),
    });
    canonicalMock.loadCanonicalStudy.mockResolvedValue({
      ok: true,
      study: { id: 'study-a', revision: 1, config: { aiProvider: 'gemini', aiModel: 'gemini-3.7-flash' } },
    });
    return context;
  }

  it('D15: the researcher AI budget is charged on the request store before the analysis runs; a refusal runs nothing', async () => {
    const context = authorizedNodeContext();
    const refusal = new Response(null, { status: 429 });
    researcherBudgetMock.researcherAiBudgetResponse.mockResolvedValueOnce(refusal as never);

    const { request, params } = makeRequest('interview-in-a', 'study-a');
    const response = await POST(request, { params });

    expect(response).toBe(refusal);
    expect(researcherBudgetMock.researcherAiBudgetResponse).toHaveBeenCalledWith(
      request, 'analysis', context.store, '/api/interviews/[id]/analyze',
    );
    expect(rateLimitMock.hostedAiRateLimitResponse).toHaveBeenCalledOnce();
    expect(analysisMock.runInterviewAnalysis).not.toHaveBeenCalled();
  });

  it('API-01 ignores the additive v2 header, key and body and still runs one synchronous analysis', async () => {
    const context = authorizedNodeContext();
    analysisMock.runInterviewAnalysis.mockResolvedValue({ status: 'complete' });

    const url = 'http://localhost/api/interviews/interview-in-a/analyze?studyId=study-a';
    const response = await POST(new Request(url, {
      method: 'POST',
      headers: {
        'X-OpenInterviewer-Analysis-Version': '2',
        'Idempotency-Key': '6f1d8a8e-2d7c-4c1e-9d55-3a2f5b6c7d8e',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expectedGeneration: 0 }),
    }), { params: Promise.resolve({ id: 'interview-in-a' }) });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'complete' });
    expect(analysisMock.runInterviewAnalysis).toHaveBeenCalledTimes(1);
    expect(analysisMock.runInterviewAnalysis.mock.calls[0][0].kvClient).toBe(context.kvClient);
    // The canonical study is read through the request's own workspace store.
    expect(canonicalMock.loadCanonicalStudy).toHaveBeenCalledWith({
      store: context.store,
      tokenStudyId: 'study-a',
      isAdmin: true,
    });
  });

  it('API-01 an unversioned Node request is never refused as an outdated client', async () => {
    authorizedNodeContext();
    analysisMock.runInterviewAnalysis.mockResolvedValue({ status: 'busy' });

    const { request, params } = makeRequest('interview-in-a', 'study-a');
    const response = await POST(request, { params });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'busy' });
  });

  it('API-02 the status GET does not exist on the Node target and touches no authority or storage', async () => {
    const { params } = makeRequest('interview-in-a', 'study-a');
    const response = await GET(
      new Request('http://localhost/api/interviews/interview-in-a/analyze?studyId=study-a'),
      { params },
    );

    // Byte-for-byte Next's automatic 405 for an unimplemented method.
    expect(response.status).toBe(405);
    expect([...response.headers.keys()]).toEqual([]);
    expect(await response.text()).toBe('');
    expect(contextMock.getAuthorizedResearcherStudyContext).not.toHaveBeenCalled();
    expect(kvMock.getInterviewChecked).not.toHaveBeenCalled();
  });

  it('API-02 OPTIONS on the Node target advertises only what Node serves, as before GET was exported', async () => {
    const response = OPTIONS();

    expect(response.status).toBe(204);
    expect(response.headers.get('allow')).toBe('OPTIONS, POST');
  });
});

// A fixed provider commitment (lib/providerCommitment.ts): a retry sends the
// transcript only to the provider and model its participant's consent named.
describe('provider commitment on the Node retry', () => {
  const run = async (interview: Partial<import('@/types').StoredInterview>, config: Record<string, unknown>) => {
    contextMock.getAuthorizedResearcherStudyContext.mockResolvedValue({
      authorized: true,
      context: hostedTestContext({} as RedisPort, 'researcher-a'),
      researcherId: 'researcher-a',
    });
    kvMock.getInterviewChecked.mockResolvedValue({
      status: 'found',
      interview: makeStoredInterview({ id: 'interview-in-a', studyId: 'study-a', ...interview }),
    });
    canonicalMock.loadCanonicalStudy.mockResolvedValue({ ok: true, study: { id: 'study-a', revision: 2, config } });
    analysisMock.runInterviewAnalysis.mockResolvedValue({ status: 'complete' });
    const { request, params } = makeRequest('interview-in-a', 'study-a');
    return POST(request, { params });
  };
  const fixedOnGemini = { providerCommitment: 'fixed' as const, conductedByProvider: 'gemini' as const, conductedByModel: 'gemini-3.7-flash' };

  it.each([
    ['another provider', { aiProvider: 'claude', aiModel: 'claude-sonnet-5' }],
    ['another model of the same provider', { aiProvider: 'gemini', aiModel: 'gemini-2.5-pro' }],
  ])('refuses a fixed interview when the study now uses %s, before any provider call or rate charge', async (_label, config) => {
    const response = await run(fixedOnGemini, config);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'PROVIDER_NOT_DISCLOSED' });
    expect(analysisMock.runInterviewAnalysis).not.toHaveBeenCalled();
    expect(rateLimitMock.hostedAiRateLimitResponse).not.toHaveBeenCalled();
  });

  it.each([
    ['a fixed interview on its own provider and model', fixedOnGemini, { aiProvider: 'gemini', aiModel: 'gemini-3.7-flash' }],
    ['a may-change interview after a switch', { ...fixedOnGemini, providerCommitment: 'may-change' as const }, { aiProvider: 'claude', aiModel: 'claude-sonnet-5' }],
    ['an interview saved before commitments existed', { conductedByProvider: 'gemini' as const, conductedByModel: 'gemini-3.7-flash' }, { aiProvider: 'claude', aiModel: 'claude-sonnet-5' }],
  ])('runs %s', async (_label, interview, config) => {
    const response = await run(interview, config);

    expect(response.status).toBe(200);
    expect(analysisMock.runInterviewAnalysis).toHaveBeenCalledTimes(1);
  });
});
