import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredInterview, makeStoredStudy, makeStudyConfig } from '../fixtures/models';

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const storageMock = vi.hoisted(() => ({
  getStudy: vi.fn(),
  getStudyInterviews: vi.fn(),
}));
vi.mock('@/services/storageService', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('@/services/storageService');
  return {
    ...actual,
    getStudy: storageMock.getStudy,
    getStudyInterviews: storageMock.getStudyInterviews,
  };
});

// StudyDetail wires useSetTrailingCrumb, which requires a BreadcrumbProvider ancestor.
import { BreadcrumbProvider } from '@/components/shell/breadcrumb';
import StudyDetail from '@/components/StudyDetail';

function renderStudyDetail(studyId: string) {
  return render(
    <BreadcrumbProvider>
      <StudyDetail studyId={studyId} />
    </BreadcrumbProvider>
  );
}

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
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ links: [], truncated: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
  );
});

describe('StudyDetail register table', () => {
  it('lists interview rows with keyboard-navigable row buttons and no ancestor measure', async () => {
    const config = makeStudyConfig({ id: 'study-b', name: 'Register Study' });
    storageMock.getStudy.mockResolvedValue(makeStoredStudy({ id: 'study-b', config, revision: 1 }));
    const interviewA = makeStoredInterview({ id: 'interview-a', studyId: 'study-b' });
    const interviewB = makeStoredInterview({ id: 'interview-b', studyId: 'study-b' });
    storageMock.getStudyInterviews.mockResolvedValue([interviewA, interviewB]);

    renderStudyDetail('study-b');

    await screen.findByRole('heading', { name: 'Register Study' });
    fireEvent.click(screen.getByRole('tab', { name: 'Interviews' }));

    const table = await screen.findByRole('table');
    expect(screen.getByRole('columnheader', { name: 'ID' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Participant' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Started' })).toBeInTheDocument();
    expect(ancestorHasMeasure(table)).toBe(false);

    const rowAButton = screen.getByRole('button', { name: 'View interview 1' });
    const rowBButton = screen.getByRole('button', { name: 'View interview 2' });

    rowAButton.focus();
    fireEvent.keyDown(rowAButton, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rowBButton);

    fireEvent.keyDown(rowBButton, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rowBButton);

    fireEvent.keyDown(rowBButton, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(rowAButton);

    fireEvent.keyDown(rowAButton, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(rowAButton);

    fireEvent.click(rowAButton);
    expect(router.push).toHaveBeenCalledWith(
      `/dashboard/interview/interview-a?studyId=${encodeURIComponent('study-b')}`
    );
  });

  it('carries no icons on any tab', async () => {
    const config = makeStudyConfig({ id: 'study-c', name: 'Icon-free Study' });
    storageMock.getStudy.mockResolvedValue(makeStoredStudy({ id: 'study-c', config, revision: 1 }));
    storageMock.getStudyInterviews.mockResolvedValue([
      makeStoredInterview({ id: 'interview-c', studyId: 'study-c' }),
    ]);

    const { container } = renderStudyDetail('study-c');
    await screen.findByRole('heading', { name: 'Icon-free Study' });
    expect(container.querySelectorAll('svg').length).toBe(0);

    fireEvent.click(screen.getByRole('tab', { name: 'Interviews' }));
    await screen.findByRole('table');
    expect(container.querySelectorAll('svg').length).toBe(0);

    fireEvent.click(screen.getByRole('tab', { name: 'Study settings' }));
    await screen.findByText('Link Management');
    expect(container.querySelectorAll('svg').length).toBe(0);
  });

  it('renders the participant-access toggle as a switch reading ENABLED', async () => {
    const config = makeStudyConfig({ id: 'study-d', name: 'Toggle Study', linksEnabled: true });
    storageMock.getStudy.mockResolvedValue(makeStoredStudy({ id: 'study-d', config, revision: 1 }));
    storageMock.getStudyInterviews.mockResolvedValue([]);

    renderStudyDetail('study-d');
    await screen.findByRole('heading', { name: 'Toggle Study' });
    fireEvent.click(screen.getByRole('tab', { name: 'Study settings' }));

    const toggle = await screen.findByRole('switch', { name: 'Participant access' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(toggle).toHaveTextContent('ENABLED');
  });
});
