import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { makeStoredStudy, makeStudyConfig } from '../fixtures/models';
const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
const storage = vi.hoisted(() => ({ getAllStudies: vi.fn(), deleteStudy: vi.fn(), reconcileStudyOperations: vi.fn() }));
vi.mock('@/services/storageService', () => storage);
const projects = vi.hoisted(() => ({ listProjects: vi.fn(), createProject: vi.fn(), renameProject: vi.fn(), deleteProject: vi.fn(), assignStudyProject: vi.fn(), exportProjectTranscriptsChecked: vi.fn() }));
vi.mock('@/services/projectService', () => projects);
import StudyList from '@/components/StudyList';
const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
const studies = ['Alpha', 'Beta'].map((name, i) => makeStoredStudy({ id: `study-${i}`, config: makeStudyConfig({ name }), interviewCount: i }));
let snapshot: { projects: Array<{ id: string; name: string; createdAt: number; updatedAt: number }>; studyIds: string[]; memberships: Array<{ studyId: string; projectId: string }> };
beforeEach(() => {
  vi.clearAllMocks();
  snapshot = { projects: [{ id: a, name: 'First', createdAt: 1, updatedAt: 1 }, { id: b, name: 'Empty', createdAt: 2, updatedAt: 2 }], studyIds: studies.map(s => s.id), memberships: [{ studyId: 'study-0', projectId: a }] };
  projects.listProjects.mockImplementation(async () => ({ status: 'ok', value: snapshot }));
  storage.getAllStudies.mockResolvedValue({ studies, outcome: { status: 'ok' } });
  storage.reconcileStudyOperations.mockResolvedValue({ success: true, completed: 0, rolledBack: 0, stillPending: 0 });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ mode: 'standalone' })));
});
const actions = (name: string) => screen.getByRole('button', { name: `Project actions for ${name}` });
describe('project register', () => {
  it('shows empty projects and Ungrouped; disclosures, row arrows and Escape restore focus', async () => {
    render(<StudyList />);
    const section = await screen.findByRole('region', { name: 'First' });
    expect(within(section).getByRole('button', { name: 'Alpha' })).toBeVisible();
    expect(within(screen.getByRole('region', { name: 'Ungrouped' })).getByRole('button', { name: 'Beta' })).toBeVisible();
    expect(within(screen.getByRole('region', { name: 'Empty' })).getByText('No studies in this section.')).toBeVisible();
    const alpha = screen.getByRole('button', { name: 'Alpha' }), beta = screen.getByRole('button', { name: 'Beta' });
    alpha.focus(); fireEvent.keyDown(alpha, { key: 'ArrowDown' }); expect(beta).toHaveFocus();
    fireEvent.keyDown(beta, { key: 'ArrowUp' }); expect(alpha).toHaveFocus();
    const disclosure = within(section).getByRole('button', { name: 'First 1 study' });
    expect(disclosure).toHaveAttribute('aria-controls', `project-section-${a}`);
    fireEvent.click(disclosure); expect(disclosure).toHaveAttribute('aria-expanded', 'false'); expect(disclosure).toHaveFocus(); expect(alpha).not.toBeVisible();
    fireEvent.click(disclosure); expect(alpha).toBeVisible();
    fireEvent.click(actions('First')); fireEvent.keyDown(screen.getByRole('button', { name: 'Rename' }), { key: 'Escape' }); expect(actions('First')).toHaveFocus();
    const trigger = screen.getByRole('button', { name: 'Open actions for Alpha' });
    fireEvent.click(trigger); fireEvent.click(screen.getByRole('button', { name: 'Move to project…' }));
    fireEvent.keyDown(screen.getByLabelText('Destination project'), { key: 'Escape' }); expect(trigger).toHaveFocus();
    fireEvent.click(within(section).getByRole('button', { name: '+ Study' })); expect(router.push).toHaveBeenCalledWith(`/setup?projectId=${a}`);
  });
  it('creates and renames through explicit actions', async () => {
    projects.createProject.mockResolvedValue({ status: 'ok', value: {} }); projects.renameProject.mockResolvedValue({ status: 'ok', value: {} });
    vi.spyOn(window, 'prompt').mockReturnValue('Renamed');
    render(<StudyList />); await screen.findByRole('region', { name: 'First' });
    fireEvent.click(screen.getByRole('button', { name: 'New project' })); await waitFor(() => expect(projects.createProject).toHaveBeenCalledWith('Renamed'));
    await screen.findByRole('region', { name: 'First' });
    fireEvent.click(actions('First')); fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(projects.renameProject).toHaveBeenCalledWith(a, 'Renamed'));
  });
  it('moves populated studies and ungroups without mutating the study configuration', async () => {
    projects.assignStudyProject.mockImplementation(async (studyId, projectId) => { snapshot = { ...snapshot, memberships: [...snapshot.memberships.filter(m => m.studyId !== studyId), ...(projectId ? [{ studyId, projectId }] : [])] }; return { status: 'ok', value: {} }; });
    render(<StudyList />); await screen.findByRole('region', { name: 'First' });
    fireEvent.click(screen.getByRole('button', { name: 'Open actions for Beta' })); fireEvent.click(screen.getByRole('button', { name: 'Move to project…' }));
    fireEvent.change(screen.getByLabelText('Destination project'), { target: { value: a } });
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'First' })).getByRole('button', { name: 'Beta' })).toBeVisible());
    fireEvent.click(screen.getByRole('button', { name: 'Open actions for Beta' })); fireEvent.click(screen.getByRole('button', { name: 'Ungroup' }));
    await waitFor(() => expect(projects.assignStudyProject).toHaveBeenLastCalledWith('study-1', null));
    expect(storage.deleteStudy).not.toHaveBeenCalled();
  });
  it('uses the precise deletion confirmation and reloads after an ambiguous write without retrying', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    projects.deleteProject.mockResolvedValue({ status: 'error', error: 'Reply lost. Refresh before trying again.', ambiguous: true });
    render(<StudyList />); await screen.findByRole('region', { name: 'First' });
    fireEvent.click(actions('First')); fireEvent.click(screen.getByRole('button', { name: 'Delete project' }));
    expect(confirm).toHaveBeenCalledWith('Delete this project? Its studies will move to Ungrouped. No study or interview will be deleted.');
    await screen.findByText('Reply lost. Refresh before trying again.');
    await waitFor(() => expect(projects.listProjects).toHaveBeenCalledTimes(2)); expect(projects.deleteProject).toHaveBeenCalledTimes(1);
    expect(storage.deleteStudy).not.toHaveBeenCalled();
  });
  it.each(['failure', 'mismatch'])('shows a notice and flat list after project %s, never fictitious Ungrouped', async failure => {
    if (failure === 'failure') projects.listProjects.mockResolvedValue({ status: 'error', error: 'Unavailable' });
    else snapshot.studyIds = ['other'];
    render(<StudyList />); await screen.findByRole('button', { name: 'Alpha' });
    expect(screen.getByText(/flat study list is shown/)).toBeVisible(); expect(screen.queryByRole('region', { name: 'Ungrouped' })).not.toBeInTheDocument();
  });
  it.each(['hosted', 'unknown'])('keeps %s flat without any project requests', async mode => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ mode })));
    render(<StudyList />); await screen.findByRole('button', { name: 'Alpha' });
    expect(projects.listProjects).not.toHaveBeenCalled(); expect(screen.queryByRole('button', { name: 'New project' })).not.toBeInTheDocument();
  });
  it('checks the download through the typed client and surfaces incomplete export errors', async () => {
    projects.exportProjectTranscriptsChecked.mockResolvedValue({ status: 'error', error: 'The project export did not complete. Try the export again.' });
    render(<StudyList />); await screen.findByRole('region', { name: 'First' });
    fireEvent.click(actions('First')); fireEvent.click(screen.getByRole('button', { name: 'Export transcripts' }));
    await screen.findByText('The project export did not complete. Try the export again.'); expect(projects.exportProjectTranscriptsChecked).toHaveBeenCalledWith(a);
  });
});
