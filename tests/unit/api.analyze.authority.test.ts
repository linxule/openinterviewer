// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredInterview } from '../fixtures/models';

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

const analysisMock = vi.hoisted(() => ({ runInterviewAnalysis: vi.fn() }));
vi.mock('@/lib/interviewAnalysis', () => analysisMock);

import { POST } from '@/app/api/interviews/[id]/analyze/route';

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
      context: { kvClient: {}, researcherId: 'researcher-b' },
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
      context: { kvClient: {}, researcherId: 'researcher-a' },
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
