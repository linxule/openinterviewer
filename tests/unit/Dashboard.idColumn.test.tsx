import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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

describe('Dashboard ID column', () => {
  it('renders eight characters of entropy after the session- prefix, never the literal prefix', async () => {
    const interview = makeStoredInterview({
      id: 'session-9f1c2b7a-0000-4000-8000-000000000000',
      studyName: 'Study Alpha',
    });
    storageMock.readAllInterviews.mockResolvedValue({
      status: 'ok',
      value: { interviews: [interview], pendingStudies: [] },
    });

    renderDashboard();

    const table = await screen.findByRole('table');
    expect(within(table).getByText('9f1c2b7a')).toBeInTheDocument();
    expect(table).not.toHaveTextContent('session-');
  });
});
