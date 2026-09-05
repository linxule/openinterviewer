// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const contextMock = vi.hoisted(() => ({
  getAuthorizedResearcherStudyContext: vi.fn(),
}));
vi.mock('@/lib/researcherContext', () => contextMock);

const kvMock = vi.hoisted(() => ({
  getStudyAggregateChecked: vi.fn(),
}));
vi.mock('@/lib/kv', () => kvMock);

import { GET } from '@/app/api/studies/[id]/aggregate/route';

const STUDY_ID = '11111111-1111-4111-8111-111111111111';
const routeParams = { params: Promise.resolve({ id: STUDY_ID }) };
const kvClient = { marker: 'gated-client' };

function request() {
  return new Request(`http://localhost/api/studies/${STUDY_ID}/aggregate`);
}

beforeEach(() => {
  vi.clearAllMocks();
  contextMock.getAuthorizedResearcherStudyContext.mockResolvedValue({
    authorized: true,
    context: { kvClient },
  });
});

describe('GET /api/studies/[id]/aggregate', () => {
  it('returns the stored aggregate with 200 when one exists', async () => {
    const aggregate = { studyId: STUDY_ID, studyRevision: 1, savedAt: 123 };
    kvMock.getStudyAggregateChecked.mockResolvedValue({ status: 'found', aggregate });

    const response = await GET(request(), routeParams);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ aggregate });
    expect(kvMock.getStudyAggregateChecked).toHaveBeenCalledWith(STUDY_ID, kvClient);
  });

  it('returns { aggregate: null } with 200, not 404, when none exists', async () => {
    kvMock.getStudyAggregateChecked.mockResolvedValue({ status: 'not-found' });

    const response = await GET(request(), routeParams);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ aggregate: null });
  });

  it('returns 503 retryable when storage is unavailable', async () => {
    kvMock.getStudyAggregateChecked.mockResolvedValue({ status: 'unavailable' });

    const response = await GET(request(), routeParams);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ retryable: true });
  });

  it('returns the gate status with no kv call when unauthorized', async () => {
    contextMock.getAuthorizedResearcherStudyContext.mockResolvedValue({
      authorized: false,
      error: 'Unauthorized',
      statusCode: 403,
    });

    const response = await GET(request(), routeParams);

    expect(response.status).toBe(403);
    expect(kvMock.getStudyAggregateChecked).not.toHaveBeenCalled();
  });

  it('never falls back to a default client', async () => {
    kvMock.getStudyAggregateChecked.mockResolvedValue({ status: 'not-found' });

    await GET(request(), routeParams);

    expect(kvMock.getStudyAggregateChecked).toHaveBeenCalledTimes(1);
    const [, clientArg] = kvMock.getStudyAggregateChecked.mock.calls[0];
    expect(clientArg).toBe(kvClient);
  });
});
