import { fireEvent, render, screen } from '@testing-library/react';
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

function renderInterviewDetail() {
  return render(
    <BreadcrumbProvider>
      <InterviewDetail interviewId="interview-reading" studyId="study-reading" />
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

const interview = makeStoredInterview({
  id: 'interview-reading',
  studyId: 'study-reading',
  studyName: 'Reading Study',
  transcript: [
    { id: 'm-1', role: 'ai' as const, content: 'What brought you here today?', timestamp: 1000 },
    { id: 'm-2', role: 'user' as const, content: 'I wanted to understand my options.', timestamp: 2000 },
  ],
  aiModel: 'gemini-2.5-flash',
  studyRevision: 3,
  completedAt: Date.now(),
  synthesis: {
    statedPreferences: [],
    revealedPreferences: [],
    themes: [],
    contradictions: [],
    keyInsights: [],
    bottomLine: 'A verified bottom line',
    _receipt: 'a'.repeat(24),
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  storageMock.getInterview.mockResolvedValue(interview);
});

describe('InterviewDetail reading surface', () => {
  it('renders both transcript turns with mono coordinates and serif-only participant speech', async () => {
    const { container } = renderInterviewDetail();

    await screen.findByText('What brought you here today?');
    const interviewerText = screen.getByText('What brought you here today?');
    const participantText = screen.getByText('I wanted to understand my options.');

    expect(screen.getByText('t. 1')).toBeInTheDocument();
    expect(screen.getByText('t. 2')).toBeInTheDocument();
    expect(interviewerText.closest('[class*="font-serif"]')).toBeNull();
    expect(participantText.closest('[class*="font-serif"]')).not.toBeNull();

    expect(container.querySelectorAll('svg').length).toBe(0);
    expect(ancestorHasMeasure(screen.getByRole('list'))).toBe(false);
  });

  it('renders the bottom line and provenance footer on the Analysis tab, with no icons', async () => {
    const { container } = renderInterviewDetail();

    await screen.findByText('What brought you here today?');
    fireEvent.click(screen.getByRole('button', { name: 'Analysis' }));

    const bottomLine = await screen.findByText('A verified bottom line');
    expect(bottomLine.closest('[class*="font-serif"]')).not.toBeNull();

    const footer = screen.getByText(/^Synthesized by/);
    expect(footer.textContent).toMatch(/^Synthesized by .+ · study rev .+ · .+ · receipt /);

    expect(container.querySelectorAll('svg').length).toBe(0);
  });

  it('leaves the page frame to the shell', async () => {
    const { container } = renderInterviewDetail();
    await screen.findByText('What brought you here today?');
    expect(container.querySelector('.min-h-screen')).toBeNull();
    expect(container.querySelector('.min-h-dvh')).toBeNull();
  });
});
