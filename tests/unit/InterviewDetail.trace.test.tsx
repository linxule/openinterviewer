import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredInterview } from '../fixtures/models';

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const storageMock = vi.hoisted(() => ({ getInterview: vi.fn() }));
vi.mock('@/services/storageService', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('@/services/storageService');
  return {
    ...actual,
    getInterview: storageMock.getInterview,
  };
});

// InterviewDetail wires useSetTrailingCrumb, which requires a BreadcrumbProvider ancestor.
import { BreadcrumbProvider } from '@/components/shell/breadcrumb';
import InterviewDetail from '@/components/InterviewDetail';

function renderInterviewDetail(turn?: string) {
  return render(
    <BreadcrumbProvider>
      <InterviewDetail interviewId="interview-trace" studyId="study-trace" turn={turn} />
    </BreadcrumbProvider>
  );
}

// turn 1: interviewer · turn 2: participant, carries a curly-quoted capitalized
// word the verified ref cites straight and lowercase (span-fidelity, B9.1) ·
// turn 3: interviewer, carries text a wrong-speaker ref will (wrongly) cite ·
// turn 4: participant filler, keeping the transcript at four messages.
const interview = makeStoredInterview({
  id: 'interview-trace',
  studyId: 'study-trace',
  studyName: 'Trace Study',
  transcript: [
    { id: 'm-1', role: 'ai' as const, content: 'What made you decide to open it today?', timestamp: 1000 },
    {
      id: 'm-2',
      role: 'user' as const,
      content: 'I called it “Work” long before I ever opened the folder, and that made it heavier to start.',
      timestamp: 2000,
    },
    {
      id: 'm-3',
      role: 'ai' as const,
      content: 'It sounds like you wanted a quiet space to think it through before starting.',
      timestamp: 3000,
    },
    { id: 'm-4', role: 'user' as const, content: 'By the time I got to it, the moment had passed.', timestamp: 4000 },
  ],
  completedAt: Date.now(),
  synthesis: {
    statedPreferences: [],
    revealedPreferences: [],
    themes: [
      { theme: 'Verified theme', frequency: 1, evidenceRefs: [{ quote: '"work"', turnIndex: 2 }] },
      {
        theme: 'Unlocatable theme',
        frequency: 1,
        evidenceRefs: [{ quote: 'a phrase that was never actually said in this turn at all', turnIndex: 2 }],
      },
      { theme: 'Empty theme', frequency: 1, evidenceRefs: [] },
      {
        theme: 'Wrong speaker theme',
        frequency: 1,
        evidenceRefs: [{ quote: 'quiet space to think it through', turnIndex: 3 }],
      },
      { theme: 'Out of range theme', frequency: 1, evidenceRefs: [{ quote: 'anything', turnIndex: 99 }] },
      {
        theme: 'Legacy theme',
        frequency: 1,
        evidence: 'Participant framed the change as a relief rather than a disruption.',
      },
    ],
    contradictions: [],
    keyInsights: [],
    bottomLine: 'A verified bottom line',
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  storageMock.getInterview.mockResolvedValue(interview);
});

async function openAnalysisTab() {
  const view = renderInterviewDetail();
  await screen.findByText('What made you decide to open it today?');
  fireEvent.click(screen.getByRole('tab', { name: 'Analysis' }));
  return view;
}

describe('InterviewDetail trace surface', () => {
  it('span fidelity: the note shows the record\'s own characters for a verified ref', async () => {
    await openAnalysisTab();

    const trigger = screen.getByRole('button', { name: 't.2' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    // The record's own substring — capital W, no straight quotes — not the
    // model's straight-lowercase "work".
    const noteText = screen.getByText('“Work”');
    expect(noteText).toBeInTheDocument();
    expect(interview.transcript[1].content).toContain('Work');

    expect(screen.getByText('Participant · turn 2')).toBeInTheDocument();
  });

  it('the trigger toggles aria-expanded and the note visibility', async () => {
    await openAnalysisTab();

    const trigger = screen.getByRole('button', { name: 't.2' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('“Work”')).toBeInTheDocument();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('“Work”')).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('“Work”')).toBeInTheDocument();
  });

  it('the unlocatable ref renders serif, unquoted, with no trigger', async () => {
    await openAnalysisTab();

    const passage = screen.getByText('a phrase that was never actually said in this turn at all');
    expect(passage.className).toMatch(/font-serif/);
    expect(passage.textContent).not.toMatch(/["“”]/);

    const li = passage.closest('li');
    expect(li?.querySelector('[aria-expanded]')).toBeNull();
  });

  it('an old-shape theme renders its evidence as a Slice F supporting passage: serif, unquoted, no trigger, no wine', async () => {
    await openAnalysisTab();

    const passage = screen.getByText('Participant framed the change as a relief rather than a disruption.');
    expect(passage.className).toMatch(/font-serif/);
    expect(passage.className).toMatch(/border-l/);
    expect(passage.textContent).not.toMatch(/["“”]/);

    const li = passage.closest('li');
    expect(li?.querySelector('[aria-expanded]')).toBeNull();
    expect(li?.innerHTML).not.toMatch(/--evidence/);
    expect(li?.textContent).not.toMatch(/\bt\.\d/);
  });

  it('the empty-refs theme renders its name and no supporting passage', async () => {
    await openAnalysisTab();

    const heading = screen.getByText('Empty theme');
    const li = heading.closest('li');
    expect(li?.querySelector('.border-l')).toBeNull();
    expect(li?.querySelector('[aria-expanded]')).toBeNull();
  });

  it('a ref citing an interviewer turn renders unverified (wrong-speaker)', async () => {
    await openAnalysisTab();

    expect(screen.queryByRole('button', { name: 't.3' })).not.toBeInTheDocument();
    const passage = screen.getByText('quiet space to think it through');
    expect(passage.className).toMatch(/font-serif/);
    expect(passage.textContent).not.toMatch(/["“”]/);
  });

  it('a ref with turnIndex 99 renders unverified', async () => {
    await openAnalysisTab();

    expect(screen.queryByRole('button', { name: 't.99' })).not.toBeInTheDocument();
    const passage = screen.getByText('anything');
    expect(passage.className).toMatch(/font-serif/);
  });

  it('"Read in full transcript" switches tabs, focuses the turn, and rings it', async () => {
    await openAnalysisTab();

    fireEvent.click(screen.getByRole('button', { name: 'Read in full transcript' }));

    // Switched back to the Transcript tab.
    expect(await screen.findByText('What made you decide to open it today?')).toBeInTheDocument();

    await waitFor(() => {
      expect(document.activeElement?.id).toBe('turn-2');
    });
    expect(document.activeElement?.classList.contains('ring-2')).toBe(true);
  });

  it('renders no svg on either tab', async () => {
    const { container } = renderInterviewDetail();
    await screen.findByText('What made you decide to open it today?');
    expect(container.querySelectorAll('svg').length).toBe(0);

    fireEvent.click(screen.getByRole('tab', { name: 'Analysis' }));
    expect(container.querySelectorAll('svg').length).toBe(0);
  });

  it('rendering with turn="2" (L11) puts the Transcript tab in view, focuses turn 2, and rings it', async () => {
    renderInterviewDetail('2');
    await screen.findByText('What made you decide to open it today?');

    await waitFor(() => {
      expect(document.activeElement?.id).toBe('turn-2');
    });
    expect(document.activeElement?.classList.contains('ring-2')).toBe(true);
  });

  it('an out-of-range, non-numeric, or absent turn focuses nothing and sets no ring', async () => {
    for (const turn of ['99', 'abc', undefined]) {
      const { unmount } = renderInterviewDetail(turn);
      await screen.findByText('What made you decide to open it today?');

      expect(document.activeElement?.id ?? '').not.toMatch(/^turn-/);
      expect(document.querySelector('.ring-2')).toBeNull();
      unmount();
    }
  });
});
