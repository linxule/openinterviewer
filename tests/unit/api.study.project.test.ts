// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ context: vi.fn(), identity: vi.fn(), hosted: vi.fn() }));
vi.mock('@/lib/researcherContext', () => ({ getRequestContext: mocks.context, getHostedResearcherIdentity: mocks.identity }));
vi.mock('@/lib/mode', () => ({ isHostedMode: mocks.hosted }));
vi.mock('@/lib/runtime/readinessGate', () => ({ deploymentNotReadyResponse: () => null }));
vi.mock('@/lib/researcherAccess', () => ({ configurationRequiredResponse: () => null }));
import { PUT } from '@/app/api/studies/[id]/project/route';
const assignStudy = vi.fn();
const id = '00000000-0000-4000-8000-000000000001';
const params = { params: Promise.resolve({ id: 's' }) };
const call = (body: unknown) => PUT(new Request('https://example.test', { method: 'PUT', body: JSON.stringify(body) }), params);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.hosted.mockReturnValue(false);
  mocks.context.mockResolvedValue({ authorized: true, context: { store: {
    readiness: async () => ({ status: 'ready', maintenance: 'open' }), projects: { assignStudy },
    getStudy: () => { throw new Error('Must use atomic assignment, not a pre-read'); },
    replaceStudyConfig: () => { throw new Error('Study config must not change'); },
    setStudyLinksEnabled: () => { throw new Error('Links must not change'); },
  } } });
});
it.each([id, null])('passes an absolute assignment %s to the atomic store', async projectId => {
  assignStudy.mockResolvedValue({ status: 'assigned', studyId: 's', projectId });
  const response = await call({ projectId });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ studyId: 's', projectId });
  expect(assignStudy).toHaveBeenCalledExactlyOnceWith({ studyId: 's', projectId });
});
it.each([['not-found', 404], ['study-not-found', 404], ['persist-guard', 409], ['unavailable', 503], ['ambiguous', 503]])('honors the final store fence %s', async (status, code) => {
  assignStudy.mockResolvedValue({ status });
  expect((await call({ projectId: id })).status).toBe(code);
});
it.each([{}, { projectId: 'bad' }, { projectId: id, revision: 1 }, { projectId: 1 }])('rejects invalid membership shape %j', async body => {
  expect((await call(body)).status).toBe(400);
  expect(assignStudy).not.toHaveBeenCalled();
});
it('refuses hosted membership before BYOS resolution', async () => {
  mocks.hosted.mockReturnValue(true);
  mocks.identity.mockResolvedValue({ authorized: true, researcherId: 'r' });
  expect((await call({ projectId: id })).status).toBe(501);
  expect(mocks.context).not.toHaveBeenCalled();
  expect(assignStudy).not.toHaveBeenCalled();
});
