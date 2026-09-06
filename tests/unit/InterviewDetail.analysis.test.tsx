import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredInterview } from '../fixtures/models';
import type { InterviewAnalysisFailureKind } from '@/types';

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const storageMock = vi.hoisted(() => ({ getInterview: vi.fn() }));
vi.mock('@/services/storageService', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('@/services/storageService');
  return { ...actual, getInterview: storageMock.getInterview };
});

import { BreadcrumbProvider } from '@/components/shell/breadcrumb';
import InterviewDetail from '@/components/InterviewDetail';

function renderInterviewDetail(id = 'interview-analysis') {
  return render(
    <BreadcrumbProvider>
      <InterviewDetail interviewId={id} studyId="study-analysis" />
    </BreadcrumbProvider>
  );
}

const baseInterview = makeStoredInterview({
  id: 'interview-analysis',
  studyId: 'study-analysis',
  studyName: 'Analysis Study',
  transcript: [{ id: 'm-1', role: 'ai' as const, content: 'Hello', timestamp: 1000 }],
  synthesis: null,
});

const FAILURE_KINDS: { kind: InterviewAnalysisFailureKind; body: string }[] = [
  { kind: 'provider', body: 'The model provider did not return an analysis. This is not an analysis — run it again.' },
  { kind: 'invalid-output', body: 'The model returned something this study could not read as an analysis. Run it again.' },
  { kind: 'too-large', body: 'The analysis was too large to store. Run it again, or shorten the study’s topic areas.' },
  { kind: 'timeout', body: 'The analysis did not finish in time. Run it again.' },
  { kind: 'storage', body: 'The analysis could not be saved. Run it again.' },
];

beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'complete' }) });
});

async function openAnalysisTab() {
  await screen.findByText('Hello');
  fireEvent.click(screen.getByRole('tab', { name: 'Analysis' }));
}

describe('InterviewDetail — four-way analysis state switch', () => {
  it('pending: heading, Run analysis button, no SynthesisReading', async () => {
    storageMock.getInterview.mockResolvedValue({
      ...baseInterview,
      analysis: { status: 'pending', attempts: 0, lastAttemptAt: 1 },
    });
    renderInterviewDetail();
    await openAnalysisTab();

    expect(screen.getByText('Analysis pending')).toBeInTheDocument();
    expect(screen.getByText('This interview was saved. Its analysis has not run yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run analysis' })).toBeInTheDocument();
    expect(screen.queryByText('Bottom line')).not.toBeInTheDocument();
  });

  it('running: heading, disabled Run analysis button within the lease, no SynthesisReading', async () => {
    storageMock.getInterview.mockResolvedValue({
      ...baseInterview,
      analysis: { status: 'running', attempts: 1, lastAttemptAt: Date.now(), claimId: 'c1', claimedAt: Date.now() },
    });
    renderInterviewDetail();
    await openAnalysisTab();

    expect(screen.getByText('Analysis running')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run analysis' })).toBeDisabled();
    expect(screen.queryByText('Bottom line')).not.toBeInTheDocument();
  });

  it('running: Run analysis is enabled once the lease has elapsed', async () => {
    storageMock.getInterview.mockResolvedValue({
      ...baseInterview,
      analysis: { status: 'running', attempts: 1, lastAttemptAt: 1, claimId: 'c1', claimedAt: Date.now() - 200_000 },
    });
    renderInterviewDetail();
    await openAnalysisTab();

    expect(screen.getByRole('button', { name: 'Run analysis' })).not.toBeDisabled();
  });

  it.each(FAILURE_KINDS)('failed ($kind): heading, error tone, the documented body, and Run analysis', async ({ kind, body }) => {
    storageMock.getInterview.mockResolvedValue({
      ...baseInterview,
      analysis: { status: 'failed', attempts: 1, lastAttemptAt: 1, failureKind: kind },
    });
    renderInterviewDetail();
    await openAnalysisTab();

    expect(screen.getByText('Analysis failed')).toBeInTheDocument();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(body);
    expect(screen.getAllByText(body)).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Run analysis' })).toBeInTheDocument();
    expect(screen.queryByText('Bottom line')).not.toBeInTheDocument();
  });

  it('complete: renders the SynthesisReading and no Run analysis button', async () => {
    storageMock.getInterview.mockResolvedValue({
      ...baseInterview,
      synthesis: {
        statedPreferences: [], revealedPreferences: [], themes: [],
        contradictions: [], keyInsights: [], bottomLine: 'A finished reading.',
      },
      analysis: { status: 'complete', attempts: 1, lastAttemptAt: 1 },
    });
    renderInterviewDetail();
    await openAnalysisTab();

    expect(await screen.findByText('A finished reading.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run analysis' })).not.toBeInTheDocument();
  });

  it('pressing Run analysis posts to the analyze route and reloads the interview', async () => {
    storageMock.getInterview
      .mockResolvedValueOnce({
        ...baseInterview,
        analysis: { status: 'pending', attempts: 0, lastAttemptAt: 1 },
      })
      .mockResolvedValueOnce({
        ...baseInterview,
        synthesis: {
          statedPreferences: [], revealedPreferences: [], themes: [],
          contradictions: [], keyInsights: [], bottomLine: 'Now analyzed.',
        },
        analysis: { status: 'complete', attempts: 1, lastAttemptAt: 1 },
      });
    renderInterviewDetail();
    await openAnalysisTab();

    fireEvent.click(screen.getByRole('button', { name: 'Run analysis' }));

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/interviews/interview-analysis/analyze?studyId=study-analysis'),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(await screen.findByText('Now analyzed.')).toBeInTheDocument();
  });

  it('uses the loaded record study ID when a standalone detail URL has no study query', async () => {
    storageMock.getInterview.mockResolvedValue(baseInterview);
    render(
      <BreadcrumbProvider>
        <InterviewDetail interviewId={baseInterview.id} />
      </BreadcrumbProvider>,
    );
    await openAnalysisTab();
    fireEvent.click(screen.getByRole('button', { name: 'Run analysis' }));

    await waitFor(() => expect(storageMock.getInterview).toHaveBeenCalledTimes(2));
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/interviews/interview-analysis/analyze?studyId=study-analysis',
      { method: 'POST' },
    );
  });

  it.each<[number, string]>([
    [429, 'The analysis request limit has been reached. Wait before trying again.'],
    [503, 'Analysis is temporarily unavailable. Please try again.'],
  ])('shows a request failure on HTTP %s and leaves the stored analysis state intact', async (status, message) => {
    storageMock.getInterview.mockResolvedValue(baseInterview);
    vi.mocked(global.fetch).mockResolvedValue(new Response(JSON.stringify({ error: 'Private upstream error details' }), { status }));
    renderInterviewDetail();
    await openAnalysisTab();
    fireEvent.click(screen.getByRole('button', { name: 'Run analysis' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.getByText('Analysis pending')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run analysis' })).toBeEnabled();
    expect(screen.queryByText('Private upstream error details')).not.toBeInTheDocument();
    expect(storageMock.getInterview).toHaveBeenCalledTimes(1);
  });

  it('shows a network failure and clears it when the researcher retries successfully', async () => {
    storageMock.getInterview.mockResolvedValue(baseInterview);
    vi.mocked(global.fetch)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'busy' })));
    renderInterviewDetail();
    await openAnalysisTab();
    fireEvent.click(screen.getByRole('button', { name: 'Run analysis' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Check your connection and try again.');
    fireEvent.click(screen.getByRole('button', { name: 'Run analysis' }));

    await waitFor(() => expect(storageMock.getInterview).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
