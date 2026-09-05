import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

import { BreadcrumbProvider } from '@/components/shell/breadcrumb';
import StudyDetail from '@/components/StudyDetail';

function renderStudyDetail(studyId: string) {
  return render(
    <BreadcrumbProvider>
      <StudyDetail studyId={studyId} />
    </BreadcrumbProvider>
  );
}

const analyzedSynthesis = {
  statedPreferences: [], revealedPreferences: [], themes: [],
  contradictions: [], keyInsights: [], bottomLine: 'A finished reading.',
};

beforeEach(() => {
  vi.clearAllMocks();
  const config = makeStudyConfig({ id: 'study-batch', name: 'Batch Study' });
  storageMock.getStudy.mockResolvedValue(
    makeStoredStudy({ id: 'study-batch', config, revision: 1, interviewCount: 3 })
  );
});

describe('StudyDetail — analysis batch action', () => {
  it('shows the awaiting count and issues one POST per pending interview, sequentially, in createdAt order', async () => {
    storageMock.getStudyInterviews.mockResolvedValue([
      makeStoredInterview({
        id: 'interview-pending', studyId: 'study-batch', createdAt: 1_000,
        analysis: { status: 'pending', attempts: 0, lastAttemptAt: 1 },
      }),
      makeStoredInterview({
        id: 'interview-failed', studyId: 'study-batch', createdAt: 2_000,
        analysis: { status: 'failed', attempts: 1, lastAttemptAt: 1, failureKind: 'provider' },
      }),
      makeStoredInterview({
        id: 'interview-complete', studyId: 'study-batch', createdAt: 3_000,
        synthesis: analyzedSynthesis,
        analysis: { status: 'complete', attempts: 1, lastAttemptAt: 1 },
      }),
    ]);

    const callOrder: string[] = [];
    let resolveFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { resolveFirst = resolve; });
    const fetchMock = vi.fn(async (url: string) => {
      if (!url.includes('/analyze')) {
        // The study's aggregate load, unrelated to the batch action under test.
        return { ok: false, json: async () => ({}) };
      }
      callOrder.push(url);
      if (callOrder.length === 1) await firstGate;
      return { ok: true, json: async () => ({ status: 'complete' }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    renderStudyDetail('study-batch');
    await screen.findByRole('heading', { name: 'Batch Study' });
    expect(screen.getByText(/3 interviews · 2 awaiting analysis/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Interviews' }));
    const button = await screen.findByRole('button', { name: 'Analyze 2 pending' });
    fireEvent.click(button);

    // Sequential, not concurrent: the second call has not fired while the
    // first is still in flight.
    await waitFor(() => expect(callOrder).toHaveLength(1));
    expect(callOrder[0]).toContain('interview-pending');
    resolveFirst();

    await waitFor(() => expect(callOrder).toHaveLength(2));
    expect(callOrder[1]).toContain('interview-failed');
  });

  it('renders neither the clause nor the button when every interview is analyzed', async () => {
    storageMock.getStudyInterviews.mockResolvedValue([
      makeStoredInterview({
        id: 'interview-a', studyId: 'study-batch', synthesis: analyzedSynthesis,
        analysis: { status: 'complete', attempts: 1, lastAttemptAt: 1 },
      }),
      makeStoredInterview({
        id: 'interview-b', studyId: 'study-batch', synthesis: analyzedSynthesis,
        analysis: { status: 'complete', attempts: 1, lastAttemptAt: 1 },
      }),
    ]);
    storageMock.getStudy.mockResolvedValue(
      makeStoredStudy({
        id: 'study-batch',
        config: makeStudyConfig({ id: 'study-batch', name: 'Batch Study' }),
        revision: 1, interviewCount: 2,
      }),
    );

    renderStudyDetail('study-batch');
    await screen.findByRole('heading', { name: 'Batch Study' });
    expect(screen.queryByText(/awaiting analysis/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Interviews' }));
    expect(screen.queryByText(/^Analyze \d+ pending$/)).not.toBeInTheDocument();
  });

  it('disables Analyze All Interviews with one analyzed interview and names analyzed interviews in the prompt', async () => {
    storageMock.getStudyInterviews.mockResolvedValue([
      makeStoredInterview({
        id: 'interview-a', studyId: 'study-batch', studyRevision: 1, synthesis: analyzedSynthesis,
        analysis: { status: 'complete', attempts: 1, lastAttemptAt: 1 },
      }),
    ]);
    storageMock.getStudy.mockResolvedValue(
      makeStoredStudy({
        id: 'study-batch',
        config: makeStudyConfig({ id: 'study-batch', name: 'Batch Study' }),
        revision: 1, interviewCount: 1,
      }),
    );

    renderStudyDetail('study-batch');
    await screen.findByRole('heading', { name: 'Batch Study' });

    expect(screen.getByRole('button', { name: 'Analyze All Interviews' })).toBeDisabled();
    expect(screen.getByText('Need at least 2 analyzed interviews to generate aggregate analysis.')).toBeInTheDocument();
  });
});
