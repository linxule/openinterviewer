import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredInterview, makeStoredStudy, makeStudyConfig } from '../fixtures/models';

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const storageMock = vi.hoisted(() => ({
  readStudy: vi.fn(),
  readStudyInterviews: vi.fn(),
}));
vi.mock('@/services/storageService', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('@/services/storageService');
  return {
    ...actual,
    readStudy: storageMock.readStudy,
    readStudyInterviews: storageMock.readStudyInterviews,
  };
});

// StudyDetail wires useSetTrailingCrumb, which requires a BreadcrumbProvider ancestor.
import { BreadcrumbProvider } from '@/components/shell/breadcrumb';
import StudyDetail from '@/components/StudyDetail';

const ok = <T,>(value: T) => ({ status: 'ok' as const, value });

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
  it.each([undefined, 'Use everyday words.\nDo not comment on answers.'])('shows the configured manner or Default (%s)', async (interviewerInstructions) => {
    const config = makeStudyConfig({ id: 'study-manner', name: 'Manner study', interviewerInstructions });
    storageMock.readStudy.mockResolvedValue(ok(makeStoredStudy({ id: config.id, config })));
    storageMock.readStudyInterviews.mockResolvedValue(ok([]));
    renderStudyDetail(config.id);
    await screen.findByRole('heading', { name: 'Manner study' });
    fireEvent.click(screen.getByRole('tab', { name: 'Study settings' }));
    expect(screen.getByText('Interview Structure')).toBeInTheDocument();
    const row = screen.getByText('Interviewer Manner').closest('dt')!.parentElement!;
    const value = row.querySelector('dd')!;
    expect(value.textContent?.trim()).toBe(interviewerInstructions ?? 'Default');
    expect(value).toHaveClass('font-sans', 'whitespace-pre-wrap');
    if (!interviewerInstructions) expect(value.querySelector('span')).toHaveClass('text-ink-500');
  });

  it('lists interview rows with keyboard-navigable row buttons and no ancestor measure', async () => {
    const config = makeStudyConfig({ id: 'study-b', name: 'Register Study' });
    storageMock.readStudy.mockResolvedValue(ok(makeStoredStudy({ id: 'study-b', config, revision: 1 })));
    const interviewA = makeStoredInterview({ id: 'interview-a', studyId: 'study-b' });
    const interviewB = makeStoredInterview({ id: 'interview-b', studyId: 'study-b' });
    storageMock.readStudyInterviews.mockResolvedValue(ok([interviewA, interviewB]));

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

  it('numbers rows by participant chronology (Ruling 2), not by newest-first array position', async () => {
    const config = makeStudyConfig({ id: 'study-reverse', name: 'Reverse Order Study' });
    storageMock.readStudy.mockResolvedValue(ok(makeStoredStudy({ id: 'study-reverse', config, revision: 1 })));
    // Array order is [newer, older] (newest-first, as the real collection
    // loader returns it) — the reverse of chronological order.
    const newer = makeStoredInterview({ id: 'interview-newer', studyId: 'study-reverse', createdAt: 2_000 });
    const older = makeStoredInterview({ id: 'interview-older', studyId: 'study-reverse', createdAt: 1_000 });
    storageMock.readStudyInterviews.mockResolvedValue(ok([newer, older]));

    renderStudyDetail('study-reverse');
    await screen.findByRole('heading', { name: 'Reverse Order Study' });
    fireEvent.click(screen.getByRole('tab', { name: 'Interviews' }));
    await screen.findByRole('table');

    // The first rendered row is the array's first item (newer), but its
    // number is the OLDER participant's chronological position: Interview 2.
    const rows = screen.getAllByRole('row').slice(1); // drop the header row
    expect(rows[0]).toHaveTextContent('Interview 2');
    expect(rows[1]).toHaveTextContent('Interview 1');
  });

  it('carries no icons on any tab', async () => {
    const config = makeStudyConfig({ id: 'study-c', name: 'Icon-free Study' });
    storageMock.readStudy.mockResolvedValue(ok(makeStoredStudy({ id: 'study-c', config, revision: 1 })));
    storageMock.readStudyInterviews.mockResolvedValue(ok([
      makeStoredInterview({ id: 'interview-c', studyId: 'study-c' }),
    ]));

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

  it('shows a Copy control with one aria-hidden icon that flips to Copied! after copying a generated link', async () => {
    const config = makeStudyConfig({ id: 'study-link', name: 'Link Study' });
    storageMock.readStudy.mockResolvedValue(ok(makeStoredStudy({ id: 'study-link', config, revision: 1 })));
    storageMock.readStudyInterviews.mockResolvedValue(ok([]));

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/generate-link')) {
          return new Response(JSON.stringify({ url: 'https://example.com/p/token123' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ links: [], truncated: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      })
    );
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });

    renderStudyDetail('study-link');
    await screen.findByRole('heading', { name: 'Link Study' });
    fireEvent.click(screen.getByRole('tab', { name: 'Study settings' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Generate New Link' }));

    const copyButton = await screen.findByRole('button', { name: 'Copy' });
    expect(copyButton.querySelectorAll('svg[aria-hidden="true"]').length).toBe(1);

    fireEvent.click(copyButton);
    expect(writeText).toHaveBeenCalledWith('https://example.com/p/token123');
    expect(await screen.findByRole('button', { name: 'Copied!' })).toBeInTheDocument();
  });

  it('renders the participant-access toggle as a switch reading ENABLED', async () => {
    const config = makeStudyConfig({ id: 'study-d', name: 'Toggle Study', linksEnabled: true });
    storageMock.readStudy.mockResolvedValue(ok(makeStoredStudy({ id: 'study-d', config, revision: 1 })));
    storageMock.readStudyInterviews.mockResolvedValue(ok([]));

    renderStudyDetail('study-d');
    await screen.findByRole('heading', { name: 'Toggle Study' });
    fireEvent.click(screen.getByRole('tab', { name: 'Study settings' }));

    const toggle = await screen.findByRole('switch', { name: 'Participant access' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(toggle).toHaveTextContent('ENABLED');
  });

  it('pluralizes a one-interview study header as "1 interview"', async () => {
    const config = makeStudyConfig({ id: 'study-single', name: 'Single Interview Study' });
    storageMock.readStudy.mockResolvedValue(ok(
      makeStoredStudy({ id: 'study-single', config, revision: 1, interviewCount: 1 })
    ));
    storageMock.readStudyInterviews.mockResolvedValue(ok([
      // Analyzed, so the header's "N awaiting analysis" clause (P11.4) does
      // not append to the string this test is actually about: pluralization.
      makeStoredInterview({
        id: 'interview-single', studyId: 'study-single',
        synthesis: {
          statedPreferences: [], revealedPreferences: [], themes: [],
          contradictions: [], keyInsights: [], bottomLine: 'Bottom line',
        },
      }),
    ]));

    renderStudyDetail('study-single');

    await screen.findByRole('heading', { name: 'Single Interview Study' });
    expect(screen.getByText('1 interview')).toBeInTheDocument();
    expect(screen.queryByText('1 interviews')).not.toBeInTheDocument();
  });
});
