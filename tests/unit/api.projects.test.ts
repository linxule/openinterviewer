// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ context: vi.fn(), identity: vi.fn(), hosted: vi.fn(), notReady: vi.fn(), setup: vi.fn() }));
vi.mock('@/lib/researcherContext', () => ({ getRequestContext: mocks.context, getHostedResearcherIdentity: mocks.identity }));
vi.mock('@/lib/mode', () => ({ isHostedMode: mocks.hosted }));
vi.mock('@/lib/runtime/readinessGate', () => ({ deploymentNotReadyResponse: mocks.notReady }));
vi.mock('@/lib/researcherAccess', () => ({ configurationRequiredResponse: mocks.setup }));
import { GET, POST } from '@/app/api/projects/route';
import { PATCH, DELETE } from '@/app/api/projects/[id]/route';
import { NextResponse } from 'next/server';
const id = '00000000-0000-4000-8000-000000000001';
const project = { id, name: 'Test', createdAt: 1, updatedAt: 1 };
const projects = { list: vi.fn(), create: vi.fn(), rename: vi.fn(), delete: vi.fn() };
const readiness = vi.fn();
const params = { params: Promise.resolve({ id }) };
function req(method: string, body?: string) { return new Request('https://example.test/api/projects', { method, body }); }
beforeEach(() => {
  vi.resetAllMocks();
  mocks.hosted.mockReturnValue(false);
  mocks.context.mockResolvedValue({ authorized: true, context: { store: { projects, readiness } } });
  readiness.mockResolvedValue({ status: 'ready', maintenance: 'open' });
  projects.list.mockResolvedValue({ status: 'ok', projects: [], memberships: [], studyIds: [] });
  projects.create.mockResolvedValue({ status: 'created', project });
  projects.rename.mockResolvedValue({ status: 'updated', project });
  projects.delete.mockResolvedValue({ status: 'deleted' });
});
describe('projects API', () => {
  it('lists and creates without an idempotency key; trims the closed name input', async () => {
    expect(await (await GET()).json()).toEqual({ projects: [], memberships: [], studyIds: [] });
    const response = await POST(req('POST', '{"name":" Test "}'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ project });
    expect(projects.create).toHaveBeenCalledWith({ name: 'Test' });
    expect((await PATCH(req('PATCH', '{"name":"Test"}'), params)).status).toBe(200);
  });
  it.each(['{}', 'null', '[]', '{"name":"x","id":"forged"}', '{"name":" "}', '{"name":"x","createdAt":1}'])('rejects closed body violation %s', async body => {
    expect((await POST(req('POST', body))).status).toBe(400);
    expect(projects.create).not.toHaveBeenCalled();
  });
  it('refuses unauthenticated and authenticated-hosted requests before store resolution', async () => {
    mocks.context.mockResolvedValue({ authorized: false });
    expect((await GET()).status).toBe(401);
    mocks.hosted.mockReturnValue(true);
    mocks.identity.mockResolvedValue({ authorized: false });
    expect((await GET()).status).toBe(401);
    mocks.context.mockClear();
    mocks.identity.mockResolvedValue({ authorized: true, researcherId: 'r' });
    for (const action of [GET, () => POST(req('POST', '{"name":"Test"}')), () => PATCH(req('PATCH', '{}'), params),
      () => DELETE(req('DELETE'), params)]) {
      const response = await action();
      expect(response.status).toBe(501);
      expect(await response.json()).toMatchObject({ code: 'PROJECTS_STANDALONE_ONLY', retryable: false });
    }
    expect(mocks.context).not.toHaveBeenCalled();
    expect(projects.list).not.toHaveBeenCalled();
  });
  it('accepts null and empty-stream DELETE; rejects every nonempty body', async () => {
    expect((await DELETE(req('DELETE'), params)).status).toBe(200);
    expect((await DELETE(req('DELETE', ''), params)).status).toBe(200);
    expect((await DELETE(req('DELETE', '{}'), params)).status).toBe(400);
    expect((await DELETE(req('DELETE', ' '.repeat(1025)), params)).status).toBe(413);
    expect(projects.delete).toHaveBeenCalledTimes(2);
  });
  it('bounds actual streamed bytes without a Content-Length', async () => {
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('x'.repeat(128 * 1024 + 1))); c.close(); } });
    const request = new Request('https://example.test', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
    expect((await POST(request)).status).toBe(413);
    expect(projects.create).not.toHaveBeenCalled();
  });
  it('keeps deployment/configuration/readiness holds and allows frozen reads only', async () => {
    mocks.notReady.mockReturnValueOnce(NextResponse.json({}, { status: 503 }));
    expect((await GET()).status).toBe(503);
    expect(mocks.context).not.toHaveBeenCalled();
    mocks.setup.mockReturnValueOnce(NextResponse.json({}, { status: 503 }));
    expect((await GET()).status).toBe(503);
    readiness.mockResolvedValue({ status: 'held', reason: 'schema-unsupported' });
    expect((await GET()).status).toBe(503);
    readiness.mockResolvedValue({ status: 'ready', maintenance: 'frozen' });
    expect((await GET()).status).toBe(200);
    expect((await POST(req('POST', '{"name":"Test"}'))).status).toBe(503);
    expect(projects.create).not.toHaveBeenCalled();
  });
  it.each([['quota', 409], ['conflict', 409], ['unavailable', 503], ['ambiguous', 503]])('maps create %s to %d', async (status, code) => {
    projects.create.mockResolvedValue({ status });
    expect((await POST(req('POST', '{"name":"Test"}'))).status).toBe(code);
  });
  it.each([['persist-guard', 409], ['too-large', 413], ['ambiguous', 503]])('maps delete %s to %d', async (status, code) => {
    projects.delete.mockResolvedValue({ status });
    expect((await DELETE(req('DELETE'), params)).status).toBe(code);
  });
  it('maps missing project, invalid ID and unexpected exceptions without content', async () => {
    projects.rename.mockResolvedValue({ status: 'not-found' });
    expect((await PATCH(req('PATCH', '{"name":"Test"}'), params)).status).toBe(404);
    expect((await DELETE(req('DELETE'), { params: Promise.resolve({ id: 'bad' }) })).status).toBe(400);
    projects.list.mockRejectedValue(new Error('private-content-marker'));
    const response = await GET();
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('private-content-marker');
  });
});
