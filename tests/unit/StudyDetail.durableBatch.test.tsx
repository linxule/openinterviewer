import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredInterview, makeStoredStudy, makeStudyConfig } from '../fixtures/models';
import type { InterviewAnalysisState, StoredInterview } from '@/types';

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const storageMock = vi.hoisted(() => ({
  getStudy: vi.fn(),
  getStudyInterviews: vi.fn(),
}));
vi.mock('@/services/storageService', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('@/services/storageService');
  return { ...actual, getStudy: storageMock.getStudy, getStudyInterviews: storageMock.getStudyInterviews };
});

const execution = vi.hoisted(() => ({ mode: 'queued-v2' as 'queued-v2' | 'synchronous' | 'unknown' }));
vi.mock('@/services/analysisExecution', () => ({
  loadAnalysisExecution: async () => execution.mode,
}));

import { BreadcrumbProvider } from '@/components/shell/breadcrumb';
import StudyDetail from '@/components/StudyDetail';
import { StudyOperationPendingError } from '@/services/storageService';

const STUDY_ID = 'study-durable-batch';

type Reply = () => Response | Promise<Response>;
type Call = { method: string; interviewId: string; headers: Record<string, string>; body: unknown };

const json = (body: unknown, status = 200): Reply => () => new Response(JSON.stringify(body), { status });
const pending = (generation: number, phase: 'queued' | 'running' = 'queued') => (
  { status: 'pending', generation, phase, pollAfterMs: 2000 }
);

let calls: Call[];
// Scripted replies per interview and method; the last GET reply repeats.
let script: Record<string, { POST?: Reply[]; GET?: Reply[] }>;

function interview(index: number, analysis?: InterviewAnalysisState): StoredInterview {
  return makeStoredInterview({
    id: `session-${index}`,
    studyId: STUDY_ID,
    createdAt: index * 1_000,
    ...(analysis ? { analysis } : {}),
  });
}

function posts(interviewId?: string) {
  return calls.filter((call) => call.method === 'POST' && (!interviewId || call.interviewId === interviewId));
}

function reads(interviewId?: string) {
  return calls.filter((call) => call.method === 'GET' && (!interviewId || call.interviewId === interviewId));
}

beforeEach(() => {
  vi.useFakeTimers();
  execution.mode = 'queued-v2';
  calls = [];
  script = {};
  storageMock.getStudy.mockResolvedValue(makeStoredStudy({
    id: STUDY_ID,
    config: makeStudyConfig({ id: STUDY_ID, name: 'Durable Batch' }),
    revision: 1,
    interviewCount: 3,
  }));
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const match = url.match(/\/api\/interviews\/([^/]+)\/analyze/);
    if (!match) return new Response('{}', { status: 404 });
    const method = init?.method ?? 'GET';
    const interviewId = decodeURIComponent(match[1]);
    calls.push({
      method,
      interviewId,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const queue = script[interviewId]?.[method as 'GET' | 'POST'] ?? [];
    const reply = queue.length > 1 ? queue.shift() : queue[0];
    if (!reply) throw new Error(`No scripted ${method} reply for ${interviewId}`);
    return reply();
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function renderStudy(interviews: StoredInterview[]) {
  storageMock.getStudyInterviews.mockResolvedValue(interviews);
  const view = render(
    <BreadcrumbProvider>
      <StudyDetail studyId={STUDY_ID} />
    </BreadcrumbProvider>,
  );
  await flush();
  await flush();
  fireEvent.click(screen.getByRole('tab', { name: 'Interviews' }));
  return view;
}

function batchStatus() {
  const region = screen.getAllByRole('status').find((element) => element.getAttribute('aria-live') === 'polite');
  if (!region) throw new Error('no polite batch status');
  return region;
}

describe('StudyDetail — durable analysis batch (API-04, UI-CF-04)', () => {
  it('API-04: waits for each persisted outcome before the next, continues after a recorded failure, and never counts accepted work', async () => {
    script['session-1'] = {
      POST: [json(pending(1), 202)],
      GET: [json(pending(1, 'running')), json({ status: 'failed', generation: 1, failureKind: 'provider', recoveryRequired: false })],
    };
    script['session-2'] = {
      POST: [json(pending(1), 202)],
      GET: [json({ status: 'complete', generation: 1 })],
    };
    await renderStudy([interview(1), interview(2)]);

    fireEvent.click(screen.getByRole('button', { name: 'Analyze 2 pending' }));
    await flush();
    expect(posts()).toHaveLength(1);
    expect(posts()[0]).toMatchObject({ interviewId: 'session-1', body: { expectedGeneration: 0 } });
    expect(posts()[0].headers['X-OpenInterviewer-Analysis-Version']).toBe('2');
    expect(screen.getByRole('button', { name: 'Analyzing 0 of 2…' })).toBeDisabled();

    await flush(2_000);
    expect(posts()).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Analyzing 0 of 2…' })).toBeInTheDocument();

    await flush(2_000);
    expect(posts()).toHaveLength(2);
    expect(posts()[1].interviewId).toBe('session-2');
    expect(batchStatus()).toHaveTextContent('1 of 2 finished · 1 failed.');

    await flush(2_000);
    await flush();
    expect(batchStatus()).toHaveTextContent('Batch complete: 2 of 2 finished · 1 failed.');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    expect(storageMock.getStudyInterviews).toHaveBeenCalledTimes(2);
  });

  it('API-04: a request error stops immediately and keeps the loaded register', async () => {
    script['session-1'] = { POST: [json(pending(1), 202)], GET: [json({ status: 'complete', generation: 1 })] };
    script['session-2'] = { POST: [json({ error: 'Private upstream details' }, 429)] };
    await renderStudy([interview(1), interview(2), interview(3)]);

    fireEvent.click(screen.getByRole('button', { name: 'Analyze 3 pending' }));
    await flush();
    await flush(2_000);
    await flush();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Analysis batch stopped');
    expect(alert).toHaveTextContent('The analysis request limit has been reached. Wait before trying again.');
    expect(posts('session-3')).toHaveLength(0);
    expect(storageMock.getStudyInterviews).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('button', { name: /^View interview/ })).toHaveLength(3);
    expect(batchStatus()).toHaveTextContent('Batch stopped: 1 of 3 finished.');
    expect(screen.queryByText('Private upstream details')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Analyze 3 pending' })).toBeEnabled();
  });

  it('API-04: a status read failure while waiting stops the batch without starting the next interview', async () => {
    script['session-1'] = { POST: [json(pending(1), 202)], GET: [json({}, 503)] };
    await renderStudy([interview(1), interview(2)]);

    fireEvent.click(screen.getByRole('button', { name: 'Analyze 2 pending' }));
    await flush();
    await flush(2_000);

    expect(screen.getByRole('alert')).toHaveTextContent('The analysis status is temporarily unavailable. Try again shortly.');
    expect(posts('session-2')).toHaveLength(0);
    await flush(60_000);
    expect(reads('session-1')).toHaveLength(1);
  });

  it('API-04: polling budget exhaustion stops before the rest and names the still-pending interview separately', async () => {
    script['session-1'] = { POST: [json(pending(1), 202)], GET: [json(pending(1, 'running'))] };
    await renderStudy([interview(1), interview(2)]);

    fireEvent.click(screen.getByRole('button', { name: 'Analyze 2 pending' }));
    await flush();
    await flush(180_000);
    await flush();

    expect(screen.getByText('Analysis still pending')).toBeInTheDocument();
    expect(screen.getByText(
      'The analysis of Interview 1 is still pending, so the batch stopped before the remaining interviews. You can leave this page and check again later.',
    )).toBeInTheDocument();
    expect(batchStatus()).toHaveTextContent('Batch stopped: 0 of 2 finished. Interview 1 is still pending.');
    expect(posts('session-2')).toHaveLength(0);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    const readCount = reads().length;
    await flush(10 * 60_000);
    expect(reads()).toHaveLength(readCount);
    expect(posts()).toHaveLength(1);
  });

  it('API-04 (F8): queued and running work is counted separately, never selected, and never blocks eligible interviews', async () => {
    script['session-3'] = { POST: [json(pending(1), 202)], GET: [json({ status: 'complete', generation: 1 })] };
    script['session-4'] = { POST: [json({ status: 'already-complete', generation: 1 })] };
    await renderStudy([
      interview(1, { status: 'pending', attempts: 0, lastAttemptAt: 1, generation: 1 }),
      interview(2, { status: 'running', attempts: 1, lastAttemptAt: 1, generation: 2 }),
      interview(3, { status: 'pending', attempts: 0, lastAttemptAt: 1, generation: 0 }),
      interview(4),
    ]);

    expect(screen.getByRole('button', { name: 'Analyze 2 pending' })).toBeEnabled();
    expect(screen.getByText(
      'Analysis queued or running for 2 interviews. It finishes in the background and is not part of the batch.',
    )).toBeInTheDocument();
    expect(screen.getByText('analysis queued')).toBeInTheDocument();
    expect(screen.getByText('analysis running')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Analyze 2 pending' }));
    await flush();
    expect(posts().map((call) => call.interviewId)).toEqual(['session-3']);
    await flush(2_000);
    await flush();

    expect(posts().map((call) => call.interviewId)).toEqual(['session-3', 'session-4']);
    expect(calls.filter((call) => call.interviewId === 'session-1' || call.interviewId === 'session-2')).toHaveLength(0);
    expect(batchStatus()).toHaveTextContent('Batch complete: 2 of 2 finished.');
  });

  it('API-04 (F8): with only queued or running work left there is no batch action, just the count', async () => {
    await renderStudy([
      interview(1, { status: 'pending', attempts: 0, lastAttemptAt: 1, generation: 1 }),
      interview(2, { status: 'complete', attempts: 1, lastAttemptAt: 1, generation: 1 }),
    ]);

    expect(screen.queryByRole('button', { name: /^Analyze \d+ pending$/ })).not.toBeInTheDocument();
    expect(screen.getByText(
      'Analysis queued or running for 1 interview. It finishes in the background and is not part of the batch.',
    )).toBeInTheDocument();
    await flush(60_000);
    expect(calls).toHaveLength(0);
  });

  it('UI-CF-04: an outcome observed as recovery-required during the batch is counted and never retried by it', async () => {
    script['session-1'] = {
      POST: [json(pending(1), 202)],
      GET: [json({ status: 'failed', generation: 1, failureKind: 'timeout', recoveryRequired: true })],
    };
    script['session-2'] = { POST: [json({ status: 'already-complete', generation: 1 })] };
    await renderStudy([interview(1), interview(2)]);

    fireEvent.click(screen.getByRole('button', { name: 'Analyze 2 pending' }));
    await flush();
    await flush(2_000);
    await flush();

    expect(posts('session-1')).toHaveLength(1);
    expect(posts('session-2')).toHaveLength(1);
    expect(batchStatus()).toHaveTextContent('Batch complete: 2 of 2 finished · 1 failed.');
    await flush(10 * 60_000);
    expect(posts()).toHaveLength(2);
  });

  it('UI-CF-04: a refresh that meets a pending study operation keeps the loaded register', async () => {
    script['session-1'] = { POST: [json({ status: 'already-complete', generation: 1 })] };
    await renderStudy([interview(1), interview(2, { status: 'running', attempts: 1, lastAttemptAt: 1, generation: 1 })]);
    storageMock.getStudyInterviews.mockRejectedValue(new StudyOperationPendingError());

    fireEvent.click(screen.getByRole('button', { name: 'Analyze 1 pending' }));
    await flush();
    await flush();

    expect(storageMock.getStudyInterviews).toHaveBeenCalledTimes(2);
    expect(screen.getAllByRole('button', { name: /^View interview/ })).toHaveLength(2);
    expect(screen.getByText('Pending reconciliation')).toBeInTheDocument();
    expect(batchStatus()).toHaveTextContent('Batch complete: 1 of 1 finished.');
  });

  it('UI-CF-04: recovery-required interviews in the batch disclose the paid request before the action', async () => {
    await renderStudy([
      interview(1, { status: 'failed', attempts: 1, lastAttemptAt: 1, generation: 2, failureKind: 'timeout', recoveryRequired: true }),
      interview(2, { status: 'failed', attempts: 1, lastAttemptAt: 1, generation: 1, failureKind: 'provider', recoveryRequired: false }),
    ]);

    const button = screen.getByRole('button', { name: 'Analyze 2 pending' });
    const disclosureId = button.getAttribute('aria-describedby');
    expect(disclosureId).toBeTruthy();
    const disclosure = document.getElementById(disclosureId!);
    expect(disclosure).toHaveTextContent('Analysis needs recovery');
    expect(disclosure).toHaveTextContent(
      '1 interview in this batch is saved, but we could not confirm its earlier analysis result. Running the batch analyzes it again, which may make another paid provider request.',
    );
    expect(screen.getByText('needs recovery')).toBeInTheDocument();
    expect(screen.getByText('analysis failed')).toBeInTheDocument();
  });

  it('UI-CF-04: no disclosure when nothing in the batch needs recovery', async () => {
    await renderStudy([interview(1)]);

    expect(screen.getByRole('button', { name: 'Analyze 1 pending' })).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByText('Analysis needs recovery')).not.toBeInTheDocument();
  });

  it('API-03: a batch retried after an uncertain start reuses that interview\'s key and body', async () => {
    script['session-1'] = {
      POST: [() => Promise.reject(new TypeError('Failed to fetch')), json({ status: 'complete', generation: 1 })],
    };
    await renderStudy([interview(1)]);

    fireEvent.click(screen.getByRole('button', { name: 'Analyze 1 pending' }));
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent('Check your connection and try again.');
    fireEvent.click(screen.getByRole('button', { name: 'Analyze 1 pending' }));
    await flush();

    const [first, second] = posts('session-1');
    expect(second.headers['Idempotency-Key']).toBe(first.headers['Idempotency-Key']);
    expect(second.body).toEqual(first.body);
  });

  it('API-03: leaving the study stops observing the batch', async () => {
    script['session-1'] = { POST: [json(pending(1), 202)], GET: [json(pending(1, 'running'))] };
    const view = await renderStudy([interview(1), interview(2)]);

    fireEvent.click(screen.getByRole('button', { name: 'Analyze 2 pending' }));
    await flush();
    await flush(2_000);
    expect(reads()).toHaveLength(1);
    view.unmount();
    await flush(10 * 60_000);
    expect(reads()).toHaveLength(1);
    expect(posts()).toHaveLength(1);
  });

  it('UI-CF-03: with an unknown capability the batch starts the legacy way and a durable server refuses it before any work', async () => {
    execution.mode = 'unknown';
    script['session-2'] = { POST: [json({ code: 'ANALYSIS_CLIENT_UPDATE_REQUIRED' }, 409)] };
    await renderStudy([interview(1, { status: 'pending', attempts: 0, lastAttemptAt: 1, generation: 1 }), interview(2)]);

    // Queued durable work stays out of the selection whatever the capability says.
    fireEvent.click(screen.getByRole('button', { name: 'Analyze 1 pending' }));
    await flush();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Reload this page to analyze interviews.');
    expect(within(alert).getByRole('button', { name: 'Reload page' })).toBeInTheDocument();
    expect(posts().map((call) => call.interviewId)).toEqual(['session-2']);
    expect(posts()[0].headers['X-OpenInterviewer-Analysis-Version']).toBeUndefined();
    await flush(60_000);
    expect(reads()).toHaveLength(0);
  });
});
