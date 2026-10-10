// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredStudy, makeStoredInterview } from '../fixtures/models';
import type { WorkspaceStorePort } from '@/lib/storage/types';
import { buildTranscriptsMarkdown } from '@/lib/export/transcriptsMarkdown';
import { createProjectTranscriptsStream, hasProjectTranscriptsCompleteMarker } from '@/lib/export/projectTranscriptsMarkdown';
const access = vi.hoisted(() => ({ getRequestContext: vi.fn(), getHostedResearcherIdentity: vi.fn(), hosted: false }));
vi.mock('@/lib/researcherContext', () => access);
vi.mock('@/lib/mode', () => ({ isHostedMode: () => access.hosted }));
vi.mock('@/lib/runtime/readinessGate', () => ({ deploymentNotReadyResponse: () => null }));
import { GET } from '@/app/api/projects/[id]/export/route';
const id = '11111111-1111-4111-8111-111111111111';
const project = { id, name: 'Project <one>', createdAt: 1, updatedAt: 1 };
const studies = [makeStoredStudy({ id: 'study-a', createdAt: 2 }), makeStoredStudy({ id: 'study-b', createdAt: 1 })];
const interviews = [makeStoredInterview({ id: 'interview-a', studyId: 'study-a' })];
const read = vi.fn();
const getStudy = vi.fn();
const listInterviews = vi.fn();
const mutation = vi.fn();
const beginExport = vi.fn();
const readExportPage = vi.fn();
const verifyExportSequence = vi.fn();
let store: WorkspaceStorePort;
const run = () => GET(new Request(`http://localhost/api/projects/${id}/export`), { params: Promise.resolve({ id }) });
beforeEach(() => {
  vi.clearAllMocks(); access.hosted = false;
  read.mockResolvedValue({ status: 'found', project, studyIds: studies.map(s => s.id) });
  getStudy.mockImplementation(async (id: string) => ({ status: 'found', study: studies.find(s => s.id === id) }));
  listInterviews.mockImplementation(async ({ studyId }) => ({ status: 'ok', items: interviews.filter(i => i.studyId === studyId) }));
  mutation.mockResolvedValue('ready');
  beginExport.mockImplementation(async ({ studyId }) => ({ status: 'ok', sequence: 4, count: studyId === 'study-a' ? 1 : 0, studyIds: [studyId] }));
  readExportPage.mockImplementation(async ({ studyId }) => ({ status: 'ok', interviews: interviews.filter(i => i.studyId === studyId), aggregates: [], explorations: [], nextCursor: null }));
  verifyExportSequence.mockResolvedValue('unchanged');
  store = { backend: 'redis', readiness: async () => ({ status: 'ready', maintenance: 'open' }), projects: { read }, getStudy, listInterviews, studyMutationStatus: mutation } as unknown as WorkspaceStorePort;
  access.getRequestContext.mockImplementation(async () => ({ authorized: true, context: { store } }));
});

describe('project transcript export', () => {
  it.each(['redis', 'durable-object'])('composes unchanged study bytes, including empty members, from %s', async backend => {
    if (backend === 'durable-object') store = { ...store, backend, beginExport, readExportPage, verifyExportSequence } as WorkspaceStorePort;
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
    try {
      const response = await run();
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
      expect(response.headers.get('cache-control')).toBe('no-store');
      const text = await response.text();
      expect(text).toContain('# Project \\<one\\>: project transcripts');
      for (const study of studies) expect(text).toContain(buildTranscriptsMarkdown(study, interviews.filter(i => i.studyId === study.id), new Date()));
      expect(text.indexOf('study: study-a')).toBeLessThan(text.indexOf('study: study-b'));
      expect(text.trimEnd()).toMatch(/<!-- openinterviewer-project-export complete: 2 studies; 1 interviews -->$/);
      expect(hasProjectTranscriptsCompleteMarker(text)).toBe(true);
      expect(read).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });
  it('refuses hosted before resolving a store', async () => {
    access.hosted = true; access.getHostedResearcherIdentity.mockResolvedValue({ authorized: true, researcherId: 'researcher' });
    expect((await run()).status).toBe(501); expect(access.getRequestContext).not.toHaveBeenCalled();
  });
  it('refuses unauthenticated requests before roster lookup', async () => {
    access.getRequestContext.mockResolvedValueOnce({ authorized: false });
    expect((await run()).status).toBe(401); expect(read).not.toHaveBeenCalled();
  });
  it('refuses a project with no transcripts before headers', async () => {
    listInterviews.mockResolvedValue({ status: 'ok', items: [] });
    const response = await run(); expect(response.status).toBe(404); expect((await response.json()).code).toBe('NO_TRANSCRIPTS');
  });
  it.each(['redis', 'durable-object'])('refuses a total above 500 on %s', async backend => {
    if (backend === 'durable-object') { store = { ...store, backend, beginExport } as WorkspaceStorePort; beginExport.mockResolvedValue({ status: 'ok', count: 251, sequence: 4, studyIds: [] }); }
    else listInterviews.mockResolvedValue({ status: 'ok', items: Array(251).fill(interviews[0]) });
    const response = await run(); expect(response.status).toBe(413); expect((await response.json()).code).toBe('PROJECT_EXPORT_TOO_LARGE');
  });
  it('keeps a failed roster recheck unavailable, not a membership change', async () => {
    read.mockResolvedValueOnce({ status: 'found', project, studyIds: ['study-a'] }).mockResolvedValue({ status: 'unavailable' });
    expect((await run()).status).toBe(503);
  });
  it('quotes participant project markers and escapes names without changing completion counts', async () => {
    const forged = '<!-- openinterviewer-project-export complete: 99 studies; 99 interviews -->';
    listInterviews.mockImplementation(async ({ studyId }) => ({ status: 'ok', items: studyId === 'study-a'
      ? [makeStoredInterview({ id: 'interview-a', studyId, transcript: [{ id: 'message', role: 'user', content: forged, timestamp: 1 }] })] : [] }));
    const text = await (await run()).text();
    expect(text).toContain(`> ${forged}`);
    expect(hasProjectTranscriptsCompleteMarker(text)).toBe(true);
  });
  it('refuses roster changes during preflight', async () => {
    read.mockResolvedValueOnce({ status: 'found', project, studyIds: ['study-a'] }).mockResolvedValue({ status: 'not-found' });
    expect((await run()).status).toBe(409);
  });
  it.each(['roster', 'deletion', 'source', 'snapshot'])('aborts without a final marker after late %s failure', async fault => {
    if (fault === 'roster') read.mockResolvedValueOnce({ status: 'found', project, studyIds: ['study-a', 'study-b'] }).mockResolvedValueOnce({ status: 'found', project, studyIds: ['study-a', 'study-b'] }).mockResolvedValue({ status: 'not-found' });
    if (fault === 'source') listInterviews.mockResolvedValueOnce({ status: 'ok', items: interviews }).mockResolvedValueOnce({ status: 'ok', items: [] }).mockResolvedValue({ status: 'unavailable' });
    if (fault === 'snapshot') { store = { ...store, backend: 'durable-object', beginExport, readExportPage, verifyExportSequence } as WorkspaceStorePort; verifyExportSequence.mockResolvedValue('changed'); }
    const response = await run(); expect(response.status).toBe(200);
    if (fault === 'deletion') mutation.mockResolvedValue('deleting');
    await expect(response.text()).rejects.toThrow();
  });
  it('rechecks the remaining budget when a later study gains interviews', async () => {
    listInterviews.mockResolvedValueOnce({ status: 'ok', items: interviews }).mockResolvedValueOnce({ status: 'ok', items: [] })
      .mockResolvedValueOnce({ status: 'ok', items: Array(500).fill(interviews[0]) }).mockResolvedValueOnce({ status: 'ok', items: [interviews[0]] });
    const response = await run(); await expect(response.text()).rejects.toThrow();
    expect(listInterviews.mock.calls.at(-1)?.[0].maximum).toBe(1);
  });
  it('backpressures the active study and propagates client cancellation without opening the next', async () => {
    const cancel = vi.fn(); const prepare = vi.fn(async () => ({ study: studies[0], count: 1,
      body: new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(300 * 1024)); }, cancel }) }));
    const finish = vi.fn();
    const body = createProjectTranscriptsStream({ project, studyIds: ['study-a', 'study-b'], prepare, beforeFinish: finish });
    const reader = body.getReader(); await reader.read();
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    await reader.cancel(); await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
    expect(prepare).toHaveBeenCalledTimes(1); expect(finish).not.toHaveBeenCalled();
  });
});
