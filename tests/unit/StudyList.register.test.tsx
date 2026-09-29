import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { makeStoredStudy, makeStudyConfig } from '../fixtures/models';
import { toStudyListItem } from '@/types';

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
}));

const storageMock = vi.hoisted(() => ({
  deleteStudy: vi.fn(),
  getAllStudies: vi.fn(),
  readStudy: vi.fn(),
  reconcileStudyOperations: vi.fn(),
}));
vi.mock('@/services/storageService', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('@/services/storageService');
  return {
    ...actual,
    deleteStudy: storageMock.deleteStudy,
    getAllStudies: storageMock.getAllStudies,
    readStudy: storageMock.readStudy,
    reconcileStudyOperations: storageMock.reconcileStudyOperations,
  };
});

import StudyList from '@/components/StudyList';

function ancestorHasMeasure(element: HTMLElement): boolean {
  let node: HTMLElement | null = element.parentElement;
  while (node && node !== document.body) {
    if (node.classList.contains('max-w-measure')) return true;
    node = node.parentElement;
  }
  return false;
}

beforeEach(() => {
  vi.clearAllMocks();
  router.push.mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ mode: 'standalone' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
  );
  storageMock.reconcileStudyOperations.mockResolvedValue({
    success: true,
    completed: 0,
    rolledBack: 0,
    stillPending: 0,
  });
});

describe('StudyList register table', () => {
  it('renders a table with a row button per study and navigates on click', async () => {
    const studyA = makeStoredStudy({ config: makeStudyConfig({ name: 'Study Alpha' }) });
    const studyB = makeStoredStudy({ config: makeStudyConfig({ name: 'Study Beta' }) });
    storageMock.getAllStudies.mockResolvedValue({ studies: [studyA, studyB], outcome: { status: 'ok' } });

    render(<StudyList />);

    const table = await screen.findByRole('table');
    expect(screen.getByRole('button', { name: 'Study Alpha' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Study Beta' })).toBeInTheDocument();
    expect(ancestorHasMeasure(table)).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Study Alpha' }));
    expect(router.push).toHaveBeenCalledWith(`/studies/${studyA.id}`);
  });

  it('moves focus between row buttons with ArrowDown/ArrowUp without wrapping', async () => {
    const studyA = makeStoredStudy({ config: makeStudyConfig({ name: 'Study Alpha' }) });
    const studyB = makeStoredStudy({ config: makeStudyConfig({ name: 'Study Beta' }) });
    storageMock.getAllStudies.mockResolvedValue({ studies: [studyA, studyB], outcome: { status: 'ok' } });

    render(<StudyList />);
    await screen.findByRole('table');

    const rowAButton = screen.getByRole('button', { name: 'Study Alpha' });
    const rowBButton = screen.getByRole('button', { name: 'Study Beta' });

    rowAButton.focus();
    expect(document.activeElement).toBe(rowAButton);

    fireEvent.keyDown(rowAButton, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rowBButton);

    fireEvent.keyDown(rowBButton, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rowBButton);

    fireEvent.keyDown(rowBButton, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(rowAButton);

    fireEvent.keyDown(rowAButton, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(rowAButton);
  });

  it('opens an explicit edit URL without relying on a consumed session prefill', async () => {
    const study = makeStoredStudy({
      config: makeStudyConfig({ name: 'Study Alpha', coreQuestions: ['One?', 'Two?', 'Three?'] }),
    });
    storageMock.getAllStudies.mockResolvedValue({ studies: [toStudyListItem(study)], outcome: { status: 'ok' } });
    storageMock.readStudy.mockResolvedValue({ status: 'ok', value: study });
    sessionStorage.clear();

    render(<StudyList />);
    const table = await screen.findByRole('table');
    const row = within(table).getByRole('button', { name: 'Study Alpha' }).closest('tr')!;
    expect(within(row).getByText('3')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open actions for Study Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit & Generate Link' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/setup?prefill=edit&studyId=${study.id}`));
    expect(storageMock.readStudy).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('prefillStudyConfig')).toBeNull();
  });

  it.each([true, false])('calls a populated study Collected data and leaves canonical edit available (legacy flag %s)', async isLocked => {
    const study = makeStoredStudy({ config: makeStudyConfig({ name: 'Collected study' }), interviewCount: 2, isLocked });
    storageMock.getAllStudies.mockResolvedValue({ studies: [toStudyListItem(study)], outcome: { status: 'ok' } });
    render(<StudyList />); await screen.findByRole('table');
    expect(screen.getByText('Collected data')).toBeInTheDocument();
    expect(screen.queryByText('Locked')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open actions for Collected study' }));
    const edit = screen.getByRole('button', { name: 'Edit & Generate Link' });
    expect(edit).toBeEnabled(); fireEvent.click(edit);
    expect(router.push).toHaveBeenCalledWith(`/setup?prefill=edit&studyId=${study.id}`);
  });

  it('ST-08: whole studies from a server that ignores ?view=summary still render their question count', async () => {
    const actual = await vi.importActual<typeof import('@/services/storageService')>('@/services/storageService');
    storageMock.getAllStudies.mockImplementation(actual.getAllStudies);
    const study = makeStoredStudy({
      config: makeStudyConfig({ name: 'Study Alpha', coreQuestions: ['One?', 'Two?', 'Three?', 'Four?'] }),
    });
    const fetchMock = vi.fn(async (url: string) => new Response(
      JSON.stringify(url.startsWith('/api/studies') ? { studies: [study] } : { mode: 'standalone' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    render(<StudyList />);
    const table = await screen.findByRole('table');
    const row = within(table).getByRole('button', { name: 'Study Alpha' }).closest('tr')!;
    expect(within(row).getByText('4')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/studies?view=summary');
  });

  it('populated deletion opens the study Settings danger zone without a delete request', async () => {
    const study = makeStoredStudy({ config: makeStudyConfig({ name: 'Study Alpha' }), interviewCount: 3 });
    storageMock.getAllStudies.mockResolvedValue({ studies: [toStudyListItem(study)], outcome: { status: 'ok' } });
    render(<StudyList />);
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Open actions for Study Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(router.push).toHaveBeenCalledWith(`/studies/${study.id}?tab=settings#danger-zone`);
    expect(storageMock.deleteStudy).not.toHaveBeenCalled();
  });

  it('duplicates through an explicit new-study intent without reading or mutating source records', async () => {
    const study = makeStoredStudy({ config: makeStudyConfig({ name: 'Study Alpha' }), interviewCount: 3 });
    storageMock.getAllStudies.mockResolvedValue({ studies: [toStudyListItem(study)], outcome: { status: 'ok' } });
    render(<StudyList />);
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Open actions for Study Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate as test study' }));
    expect(router.push).toHaveBeenCalledWith(`/setup?prefill=duplicate&studyId=${study.id}`);
    expect(storageMock.deleteStudy).not.toHaveBeenCalled();
    expect(storageMock.readStudy).not.toHaveBeenCalled();
  });
});
