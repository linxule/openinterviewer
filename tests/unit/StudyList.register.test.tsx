import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { makeStoredStudy, makeStudyConfig } from '../fixtures/models';

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
}));

const storageMock = vi.hoisted(() => ({
  deleteStudy: vi.fn(),
  getAllStudies: vi.fn(),
  reconcileStudyOperations: vi.fn(),
}));
vi.mock('@/services/storageService', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('@/services/storageService');
  return {
    ...actual,
    deleteStudy: storageMock.deleteStudy,
    getAllStudies: storageMock.getAllStudies,
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
});
