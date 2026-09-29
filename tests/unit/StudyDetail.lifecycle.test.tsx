import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredInterview, makeStoredStudy, makeStudyConfig } from '../fixtures/models';
import { BreadcrumbProvider } from '@/components/shell/breadcrumb';
import StudyDetail from '@/components/StudyDetail';

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
const storage = vi.hoisted(() => ({ readStudy: vi.fn(), readStudyInterviews: vi.fn(), readStudyAggregate: vi.fn(), deleteStudy: vi.fn(), exportAllInterviewsChecked: vi.fn(), reconcileStudyOperations: vi.fn() }));
vi.mock('@/services/storageService', async importOriginal => ({ ...await importOriginal<typeof import('@/services/storageService')>(), ...storage }));

const study = makeStoredStudy({ id: 'study-controls', config: makeStudyConfig({ id: 'study-controls', name: 'Retained research', linksEnabled: true }), revision: 3, interviewCount: 2 });
const ok = <T,>(value: T) => ({ status: 'ok' as const, value });
const renderStudy = () => render(<BreadcrumbProvider><StudyDetail studyId={study.id} /></BreadcrumbProvider>);

beforeEach(() => {
  vi.clearAllMocks(); window.history.replaceState({}, '', '/');
  storage.readStudy.mockResolvedValue(ok(study)); storage.readStudyAggregate.mockResolvedValue(ok(null));
  storage.readStudyInterviews.mockResolvedValue(ok([makeStoredInterview({ id: 'current', studyId: study.id, studyRevision: 3 }), makeStoredInterview({ id: 'older', studyId: study.id, studyRevision: 2 })]));
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ links: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
});

describe('study-local lifecycle controls', () => {
  it('opens a populated study danger zone from its list link and requires both confirmations', async () => {
    window.history.replaceState({}, '', `/studies/${study.id}?tab=settings#danger-zone`);
    storage.deleteStudy.mockResolvedValueOnce({ success: false, pending: true, error: 'Purge pending.' }).mockResolvedValueOnce({ success: true });
    renderStudy();
    expect(await screen.findByRole('button', { name: 'Edit study' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Study settings' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Delete study' }));
    expect(storage.deleteStudy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Continue to permanent deletion' }));
    const permanent = screen.getByRole('button', { name: 'Permanently delete study and data' });
    expect(permanent).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /I understand that this permanently removes/ }));
    fireEvent.click(permanent);
    expect(await screen.findByText('Deletion is pending. This page will not claim permanent completion until the server confirms it.')).toBeInTheDocument();
    expect(storage.deleteStudy).toHaveBeenCalledWith(study.id, { deleteInterviews: true, confirmStudyId: study.id, expectedRevision: 3 });
    expect(router.push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Check deletion progress' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/studies'));
  });

  it('applies the whole canonical access response and keeps protocol revision visible', async () => {
    const canonical = { ...study, config: { ...study.config, name: 'Canonical study', linksEnabled: false }, updatedAt: study.updatedAt + 1 };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify(init?.method === 'PUT' ? { study: canonical } : { links: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    renderStudy(); await screen.findByRole('heading', { name: 'Retained research' });
    fireEvent.click(screen.getByRole('tab', { name: 'Study settings' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Participant access' }));
    await screen.findByRole('heading', { name: 'Canonical study' });
    expect(screen.getByRole('switch', { name: 'Participant access' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Collection revision 3')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(`/api/studies/${study.id}`, expect.objectContaining({ body: JSON.stringify({ linksEnabled: false }) }));
  });

  it('targets canonical edit and a study-only checked export', async () => {
    storage.exportAllInterviewsChecked.mockResolvedValue({ status: 'too-large', error: 'This study exceeds the archive limit.' });
    renderStudy(); await screen.findByRole('heading', { name: 'Retained research' });
    fireEvent.click(screen.getByRole('tab', { name: 'Study settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit study' }));
    expect(router.push).toHaveBeenCalledWith(`/setup?prefill=edit&studyId=${study.id}`);
    fireEvent.click(screen.getByRole('button', { name: 'Export this study' }));
    await screen.findByText('This study exceeds the archive limit.');
    expect(storage.exportAllInterviewsChecked).toHaveBeenCalledWith(study.id);
  });

  it('names the real default aggregate subset rather than claiming every retained interview', async () => {
    renderStudy(); await screen.findByRole('heading', { name: 'Retained research' });
    expect(screen.getByText('0 analyzed interviews from current revision 3 are eligible by default. 2 interviews are retained; 1 are from other or unrecorded revisions.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Analyze selected interviews' })).toBeDisabled();
  });

  it('does not let an old study read overwrite a newly selected study', async () => {
    let finishOld: (value: ReturnType<typeof ok<typeof study>>) => void = () => undefined;
    const slowOld = new Promise<ReturnType<typeof ok<typeof study>>>(resolve => { finishOld = resolve; });
    const next = { ...study, id: 'study-next', config: { ...study.config, id: 'study-next', name: 'Newly selected study' } };
    storage.readStudy.mockImplementation((id: string) => id === study.id ? slowOld : Promise.resolve(ok(next)));
    const view = renderStudy();
    view.rerender(<BreadcrumbProvider><StudyDetail studyId={next.id} /></BreadcrumbProvider>);
    await screen.findByRole('heading', { name: 'Newly selected study' });
    await act(async () => finishOld(ok(study)));
    expect(screen.getByRole('heading', { name: 'Newly selected study' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Retained research' })).not.toBeInTheDocument();
  });

  it('resumes a previously confirmed partial purge after reload without displaying partial data or running hosted reconciliation', async () => {
    const pending = { status: 'pending', code: 'STUDY_DELETION_PENDING', error: 'Deletion pending.' };
    storage.readStudy.mockResolvedValue(pending); storage.readStudyInterviews.mockResolvedValue(pending); storage.readStudyAggregate.mockResolvedValue(pending);
    storage.deleteStudy.mockResolvedValueOnce({ success: false, pending: true }).mockResolvedValueOnce({ success: true });
    renderStudy();
    await screen.findByRole('heading', { name: 'Permanent deletion pending' });
    expect(screen.queryByRole('tab', { name: 'Interviews' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry deletion' }));
    await waitFor(() => expect(storage.deleteStudy).toHaveBeenCalledWith(study.id, undefined));
    await screen.findByRole('button', { name: 'Retry deletion' });
    expect(router.push).not.toHaveBeenCalled(); expect(storage.reconcileStudyOperations).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry deletion' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/studies'));
  });
});
