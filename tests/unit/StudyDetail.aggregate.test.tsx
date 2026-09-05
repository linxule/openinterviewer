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

const aggregateFixture = {
  studyId: 'study-aggregate',
  studyRevision: 4,
  interviewIds: ['interview-a', 'interview-b'],
  interviewCount: 2,
  aiProvider: 'gemini' as const,
  aiModel: 'gemini-2.5-flash',
  commonThemes: [
    {
      theme: 'A common theme', frequency: 2,
      quoteRefs: [
        // Verified: a literal substring of interview-a's own turn 2.
        { quote: 'I keep a written log of every decision I make.', turnIndex: 2, interviewId: 'interview-a' },
        // Unverified: interview-b's turn 2 says something else entirely.
        { quote: 'A quote that was never actually said.', turnIndex: 2, interviewId: 'interview-b' },
      ],
    },
  ],
  divergentViews: [
    { topic: 'A disagreement', viewA: 'One side said this.', viewB: 'The other side said that.' },
  ],
  keyFindings: ['A key finding.'],
  researchImplications: ['Investigate this further.', 'And this too.'],
  bottomLine: 'The aggregate bottom line.',
  generatedAt: new Date('2026-01-02T10:00:00Z').getTime(),
};

beforeEach(() => {
  vi.clearAllMocks();
  const config = makeStudyConfig({ id: 'study-aggregate', name: 'Aggregate Study' });
  storageMock.getStudy.mockResolvedValue(makeStoredStudy({ id: 'study-aggregate', config, revision: 4 }));
  // Distinct createdAt values, chronologically REVERSED from insertion order,
  // so the P-numbering below is exercised rather than accidental: interview-b
  // is older and becomes P01, interview-a is newer and becomes P02.
  storageMock.getStudyInterviews.mockResolvedValue([
    makeStoredInterview({
      id: 'interview-a', studyId: 'study-aggregate', createdAt: 2_000,
      transcript: [
        { id: 'm-1', role: 'ai', content: 'Tell me about your process.', timestamp: 2_000 },
        { id: 'm-2', role: 'user', content: 'I keep a written log of every decision I make.', timestamp: 2_100 },
      ],
    }),
    makeStoredInterview({
      id: 'interview-b', studyId: 'study-aggregate', createdAt: 1_000,
      transcript: [
        { id: 'm-1', role: 'ai', content: 'Tell me about your process.', timestamp: 1_000 },
        { id: 'm-2', role: 'user', content: 'I never write anything down.', timestamp: 1_100 },
      ],
    }),
  ]);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/synthesis/aggregate') && init?.method === 'POST') {
      return new Response(JSON.stringify({ synthesis: aggregateFixture }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/participant-links')) {
      return new Response(JSON.stringify({ links: [], truncated: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }));
});

async function generateAggregate() {
  renderStudyDetail('study-aggregate');
  await screen.findByRole('heading', { name: 'Aggregate Study' });
  fireEvent.click(screen.getByRole('button', { name: 'Analyze All Interviews' }));
  return screen.findByText('The aggregate bottom line.');
}

describe('StudyDetail aggregate reading', () => {
  it('renders the five headings in document order', async () => {
    await generateAggregate();

    const headingTexts = Array.from(document.querySelectorAll('h3, h4'))
      .map((el) => el.textContent)
      .filter((text): text is string => text !== null
        && ['Bottom line', 'Key Findings', 'Common Themes', 'Divergent Views', 'Research Implications'].includes(text));

    expect(headingTexts).toEqual([
      'Key Findings', 'Common Themes', 'Divergent Views', 'Research Implications',
    ]);
    expect(screen.getByText('Bottom line')).toBeInTheDocument();
  });

  it('renders divergent views in sans and representative quotes in serif', async () => {
    await generateAggregate();

    const viewA = screen.getByText('One side said this.');
    const viewB = screen.getByText('The other side said that.');
    const quote = screen.getByText('A quote that was never actually said.');

    expect(viewA.className).not.toMatch(/font-serif/);
    expect(viewB.className).not.toMatch(/font-serif/);
    expect(quote.className).toMatch(/font-serif/);
  });

  it('prints the honest footer with no receipt clause', async () => {
    await generateAggregate();

    const footer = screen.getByText(/^Synthesized by/);
    expect(footer.textContent).toMatch(/^Synthesized by .+ · study rev 4 · generated .+ · not saved — regenerate to refresh$/);
    expect(footer.textContent).not.toMatch(/receipt/i);
    expect(footer.textContent).not.toMatch(/unsigned/i);
  });

  it('omits the Divergent Views heading when divergentViews is empty, while Research Implications still renders', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/synthesis/aggregate') && init?.method === 'POST') {
        return new Response(JSON.stringify({ synthesis: { ...aggregateFixture, divergentViews: [] } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/participant-links')) {
        return new Response(JSON.stringify({ links: [], truncated: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    await generateAggregate();

    expect(screen.queryByRole('heading', { name: 'Divergent Views' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Research Implications' })).toBeInTheDocument();
  });
});
