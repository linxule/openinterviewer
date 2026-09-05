import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { makeStoredInterview } from '../fixtures/models';

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
}));

const storageMock = vi.hoisted(() => ({
  readAllInterviews: vi.fn(),
  getAllStudies: vi.fn(),
  getStudyInterviews: vi.fn(),
  reconcileStudyOperations: vi.fn(),
  exportAllInterviews: vi.fn(),
}));
vi.mock('@/services/storageService', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('@/services/storageService');
  return {
    ...actual,
    readAllInterviews: storageMock.readAllInterviews,
    getAllStudies: storageMock.getAllStudies,
    getStudyInterviews: storageMock.getStudyInterviews,
    reconcileStudyOperations: storageMock.reconcileStudyOperations,
    exportAllInterviews: storageMock.exportAllInterviews,
  };
});

// Dashboard wires useSetTrailingCrumb, which requires a BreadcrumbProvider ancestor.
import { BreadcrumbProvider } from '@/components/shell/breadcrumb';
import Dashboard from '@/components/Dashboard';

function ancestorHasMeasure(element: HTMLElement): boolean {
  let node: HTMLElement | null = element.parentElement;
  while (node && node !== document.body) {
    if (node.classList.contains('max-w-measure')) return true;
    node = node.parentElement;
  }
  return false;
}

function renderDashboard() {
  return render(
    <BreadcrumbProvider>
      <Dashboard />
    </BreadcrumbProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  router.push.mockReset();
  storageMock.getAllStudies.mockResolvedValue({ studies: [], outcome: { status: 'ok' } });
  storageMock.reconcileStudyOperations.mockResolvedValue({
    success: true,
    completed: 0,
    rolledBack: 0,
    stillPending: 0,
  });
});

describe('Dashboard register table', () => {
  it('renders the "Interviews" heading, not "Interview Dashboard"', async () => {
    storageMock.readAllInterviews.mockResolvedValue({
      status: 'ok',
      value: { interviews: [], pendingStudies: [] },
    });

    renderDashboard();

    expect(await screen.findByRole('heading', { level: 1, name: 'Interviews' })).toBeInTheDocument();
    expect(screen.queryByText('Interview Dashboard')).not.toBeInTheDocument();
  });

  it('renders the expected column headers', async () => {
    const interview = makeStoredInterview({ studyName: 'Study Alpha' });
    storageMock.readAllInterviews.mockResolvedValue({
      status: 'ok',
      value: { interviews: [interview], pendingStudies: [] },
    });

    renderDashboard();

    await screen.findByRole('table');
    expect(screen.getByRole('columnheader', { name: 'ID' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Study' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Started' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Status' })).toBeInTheDocument();
  });

  it('renders Conducted and Synthesized columns, with "not recorded" for absent fields and no cell ever reading "—"', async () => {
    const recorded = makeStoredInterview({
      id: 'interview-recorded', studyName: 'Study Alpha',
      conductedByModel: 'gemini-3.7-flash', aiModel: 'gemini-3.7-flash',
    });
    const legacy = makeStoredInterview({ id: 'interview-legacy', studyName: 'Study Beta' });
    storageMock.readAllInterviews.mockResolvedValue({
      status: 'ok',
      value: { interviews: [recorded, legacy], pendingStudies: [] },
    });

    renderDashboard();

    await screen.findByRole('table');
    expect(screen.getByRole('columnheader', { name: 'Conducted' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Synthesized' })).toBeInTheDocument();
    expect(screen.getAllByText('gemini-3.7-flash')).toHaveLength(2);
    // Once per absent field (Conducted and Synthesized on the legacy row) —
    // the model columns never fall back to the bare-em-dash placeholder that
    // the unrelated Participant column still uses for a different reason.
    expect(screen.getAllByText('not recorded')).toHaveLength(2);
  });

  it('navigates via the row primary button with the encoded studyId', async () => {
    const interview = makeStoredInterview({
      id: 'interview-alpha',
      studyId: 'study-alpha id',
      studyName: 'Study Alpha',
    });
    storageMock.readAllInterviews.mockResolvedValue({
      status: 'ok',
      value: { interviews: [interview], pendingStudies: [] },
    });

    renderDashboard();

    const table = await screen.findByRole('table');
    expect(ancestorHasMeasure(table)).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Study Alpha' }));
    expect(router.push).toHaveBeenCalledWith(
      `/dashboard/interview/interview-alpha?studyId=${encodeURIComponent('study-alpha id')}`
    );
  });

  it('disables Export All while a study operation is pending', async () => {
    const interview = makeStoredInterview({ studyName: 'Study Alpha' });
    storageMock.readAllInterviews.mockResolvedValue({
      status: 'ok',
      value: {
        interviews: [interview],
        pendingStudies: [{ id: 'pending-1', reconciliationPending: true, operationId: 'op-1', phase: 'creating' }],
      },
    });

    renderDashboard();

    const exportButton = await screen.findByRole('button', { name: 'Export All' });
    expect(exportButton).toBeDisabled();
  });

  it('moves focus between row buttons with ArrowDown/ArrowUp without wrapping', async () => {
    const interviewA = makeStoredInterview({ id: 'interview-a', studyName: 'Study Alpha' });
    const interviewB = makeStoredInterview({ id: 'interview-b', studyName: 'Study Beta' });
    storageMock.readAllInterviews.mockResolvedValue({
      status: 'ok',
      value: { interviews: [interviewA, interviewB], pendingStudies: [] },
    });

    renderDashboard();
    await screen.findByRole('table');

    const rowAButton = screen.getByRole('button', { name: 'Study Alpha' });
    const rowBButton = screen.getByRole('button', { name: 'Study Beta' });

    rowAButton.focus();
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
