import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { makeStudyConfig } from '../fixtures/models';
const routing = vi.hoisted(() => ({ push: vi.fn(), params: new URLSearchParams() }));
vi.mock('next/navigation', () => ({ useRouter: () => routing, useSearchParams: () => routing.params }));
const state = vi.hoisted(() => ({ studyConfig: null, setStudyConfig: vi.fn(), setStep: vi.fn(), loadExampleStudy: vi.fn(), setViewMode: vi.fn(), setAiTransport: vi.fn(), resetParticipant: vi.fn() }));
vi.mock('@/store', () => ({ useStore: Object.assign(() => state, { getState: () => state }) }));
import StudySetup from '@/components/StudySetup';
const projectId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const studyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let mode: string, assignmentFails: boolean;
let writes: Array<{ url: string; body: Record<string, unknown>; method: string }>;
const fetchMock = vi.fn();
beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear(); mode = 'standalone'; assignmentFails = false; writes = [];
  routing.params = new URLSearchParams({ projectId });
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/auth') return Response.json({ authenticated: true });
    if (url === '/api/config/status') return Response.json({ mode, aiTransport: 'direct', hasAnthropicKey: true, hasGeminiKey: true, hasOpenAiKey: true, hasOpenRouterKey: true });
    if (url === '/api/projects') return Response.json({ projects: [{ id: projectId, name: 'Project One', createdAt: 1, updatedAt: 1 }], memberships: [], studyIds: [studyId] });
    if (init?.method && init.method !== 'GET') writes.push({ url, body: JSON.parse(String(init.body)), method: init.method });
    if (url === `/api/studies/${studyId}/project`) return assignmentFails ? Response.json({ reason: 'ambiguous' }, { status: 503 }) : Response.json({ studyId, projectId });
    if (url === '/api/studies') return Response.json({ study: { id: studyId, config: makeStudyConfig({ id: studyId, name: 'Created study' }), revision: 1 } });
    return Response.json({}, { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
async function save() {
  await waitFor(() => expect(screen.queryByText(/Checking configured AI providers/)).not.toBeInTheDocument());
  fireEvent.change(screen.getByLabelText('Study Name *'), { target: { value: 'Created study' } });
  fireEvent.change(screen.getByLabelText('Research Question *'), { target: { value: 'What changed?' } });
  const button = screen.getByRole('button', { name: 'Save Study' });
  await waitFor(() => expect(button).toBeEnabled()); fireEvent.click(button);
}
describe('new study project intent', () => {
  it('creates as before, then PUTs membership, keeping the target out of configuration', async () => {
    render(<StudySetup />); await save();
    await waitFor(() => expect(routing.push).toHaveBeenCalledWith(`/studies/${studyId}`));
    expect(writes.map(w => w.method)).toEqual(['POST', 'PUT']);
    expect(writes[0].body.config).not.toHaveProperty('projectId'); expect(writes[1].body).toEqual({ projectId });
  });
  it('navigates to the saved study with the failure notice after failed assignment, without a second POST or pending record', async () => {
    assignmentFails = true; render(<StudySetup />); await save();
    await waitFor(() => expect(routing.push).toHaveBeenCalledWith(`/studies/${studyId}?projectAssignmentFailed=1`));
    expect(writes.map(w => w.method)).toEqual(['POST', 'PUT']);
    expect(sessionStorage.getItem('oi:create-idempotency-state')).toBeNull();
    expect(Object.keys(sessionStorage).some(key => /assignment/.test(key))).toBe(false);
  });
  it('does not issue project requests in hosted mode even with a target URL', async () => {
    mode = 'hosted'; render(<StudySetup />); await save();
    await waitFor(() => expect(routing.push).toHaveBeenCalledWith(`/studies/${studyId}`));
    expect(writes).toHaveLength(1); expect(fetchMock.mock.calls.some(([url]) => url === '/api/projects')).toBe(false);
  });
  it('discards a stale create response after switching project intent', async () => {
    let release!: (response: Response) => void;
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url === '/api/studies' ? new Promise<Response>(resolve => { release = resolve; }) : original(url, init));
    const view = render(<StudySetup />); await save(); await waitFor(() => expect(release).toBeDefined());
    routing.params = new URLSearchParams({ projectId: otherId }); view.rerender(<StudySetup />);
    release(Response.json({ study: { id: studyId, config: makeStudyConfig({ id: studyId }) } }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save Study' })).toBeEnabled());
    expect(routing.push).not.toHaveBeenCalled(); expect(writes).toHaveLength(0);
  });
});
