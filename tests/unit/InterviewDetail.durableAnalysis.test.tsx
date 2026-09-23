import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredInterview } from '../fixtures/models';
import type { InterviewAnalysisState, StoredInterview } from '@/types';

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const storageMock = vi.hoisted(() => ({ getInterview: vi.fn() }));
vi.mock('@/services/storageService', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('@/services/storageService');
  return { ...actual, getInterview: storageMock.getInterview };
});

// The deployment's advertised protocol (RT-08), per test. `held` keeps the
// capability read outstanding, as a slow readiness endpoint would.
const execution = vi.hoisted(() => ({
  mode: 'queued-v2' as 'queued-v2' | 'synchronous' | 'unknown',
  held: false,
  asked: 0,
}));
vi.mock('@/services/analysisExecution', () => ({
  loadAnalysisExecution: () => {
    execution.asked += 1;
    return execution.held ? new Promise(() => {}) : Promise.resolve(execution.mode);
  },
}));

import { BreadcrumbProvider } from '@/components/shell/breadcrumb';
import InterviewDetail from '@/components/InterviewDetail';

const INTERVIEW_ID = 'session-durable';
const STUDY_ID = 'study-durable';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const synthesis = {
  statedPreferences: [], revealedPreferences: [], themes: [],
  contradictions: [], keyInsights: [], bottomLine: 'A durable reading.',
};

function record(analysis: InterviewAnalysisState | undefined, overrides: Partial<StoredInterview> = {}): StoredInterview {
  return makeStoredInterview({
    id: INTERVIEW_ID,
    studyId: STUDY_ID,
    studyName: 'Durable Study',
    studyRevision: 1,
    transcript: [{ id: 'm-1', role: 'ai' as const, content: 'Hello there', timestamp: 1000 }],
    synthesis: null,
    ...(analysis ? { analysis } : {}),
    ...overrides,
  });
}

const queued = (generation = 1): InterviewAnalysisState => ({ status: 'pending', attempts: 0, lastAttemptAt: 1, generation });
const running = (generation = 1): InterviewAnalysisState => ({ status: 'running', attempts: 1, lastAttemptAt: 1, generation });
const completed = (generation = 1, studyRevision = 1): StoredInterview => record(
  { status: 'complete', attempts: 1, lastAttemptAt: 1, generation, studyRevision },
  { synthesis, aiModel: 'model-served' },
);

type Reply = () => Response | Promise<Response>;
type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };

const json = (body: unknown, status = 200): Reply => () => new Response(JSON.stringify(body), { status });
const pendingBody = (generation: number, phase: 'queued' | 'running') => ({ status: 'pending', generation, phase, pollAfterMs: 2000 });

let calls: Call[];
let postReplies: Reply[];
let getReplies: Reply[];
let getDefault: Reply | null;

function analyzeCalls(method?: 'GET' | 'POST') {
  return calls.filter((call) => !method || call.method === method);
}

beforeEach(() => {
  vi.useFakeTimers();
  execution.mode = 'queued-v2';
  execution.held = false;
  execution.asked = 0;
  calls = [];
  postReplies = [];
  getReplies = [];
  getDefault = null;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes('/analyze')) throw new Error(`Unexpected fetch: ${url}`);
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const reply = (method === 'POST' ? postReplies : getReplies).shift() ?? (method === 'GET' ? getDefault : null);
    if (!reply) throw new Error(`No scripted ${method} reply`);
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

function detail(interviewId = INTERVIEW_ID, turn?: string) {
  return (
    <BreadcrumbProvider>
      <InterviewDetail interviewId={interviewId} studyId={STUDY_ID} turn={turn} />
    </BreadcrumbProvider>
  );
}

async function renderDetail(interviewId = INTERVIEW_ID) {
  const view = render(detail(interviewId));
  await flush();
  await flush();
  expect(screen.getByText('Hello there')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: 'Analysis' }));
  return view;
}

function liveRegion() {
  const region = screen.getAllByRole('status').find((element) => element.getAttribute('aria-live') === 'polite');
  if (!region) throw new Error('no polite live region');
  return region;
}

describe('InterviewDetail — durable analysis states (UI-CF-02)', () => {
  it('UI-CF-02: an unscheduled legacy interview offers Run analysis and is never polled', async () => {
    storageMock.getInterview.mockResolvedValue(record(undefined));
    await renderDetail();

    expect(screen.getByText('Analysis pending')).toBeInTheDocument();
    expect(screen.getByText('This interview was saved. Its analysis has not run yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run analysis' })).toBeEnabled();
    await flush(60_000);
    expect(analyzeCalls()).toHaveLength(0);
  });

  it('UI-CF-02: queued work shows the background copy, offers no new attempt, and is observed by reads only', async () => {
    storageMock.getInterview.mockResolvedValue(record(queued(1)));
    getDefault = json(pendingBody(1, 'queued'));
    await renderDetail();

    expect(screen.getByText('Analysis queued')).toBeInTheDocument();
    expect(screen.getByText('This interview is saved. Its analysis will run in the background.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Run analysis/ })).not.toBeInTheDocument();
    await flush(2_000);
    expect(analyzeCalls('GET')).toHaveLength(1);
    expect(analyzeCalls('POST')).toHaveLength(0);
  });

  it('UI-CF-02: running work has no retry, however old the browser thinks the claim is', async () => {
    storageMock.getInterview.mockResolvedValue(record({ ...running(1), claimedAt: Date.now() - 10 * 60_000 }));
    getDefault = json(pendingBody(1, 'running'));
    await renderDetail();

    expect(screen.getByText('Analysis running')).toBeInTheDocument();
    expect(screen.getByText('This interview is saved. Analysis is in progress.')).toBeInTheDocument();
    await flush(200_000);
    expect(screen.queryByRole('button', { name: /Run analysis/ })).not.toBeInTheDocument();
    expect(analyzeCalls('POST')).toHaveLength(0);
  });

  it('UI-CF-02: an ordinary recorded failure keeps its failure copy and Run analysis', async () => {
    storageMock.getInterview.mockResolvedValue(record({
      status: 'failed', attempts: 1, lastAttemptAt: 1, generation: 2, failureKind: 'invalid-output', recoveryRequired: false,
    }));
    await renderDetail();

    expect(screen.getByText('Analysis failed')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The model returned something this study could not read as an analysis. Run it again.',
    );
    expect(screen.getByRole('button', { name: 'Run analysis' })).toBeEnabled();
  });

  it('UI-CF-02: recovery-required discloses the paid request inline and offers Run analysis again', async () => {
    storageMock.getInterview.mockResolvedValue(record({
      status: 'failed', attempts: 1, lastAttemptAt: 1, generation: 2, failureKind: 'timeout', recoveryRequired: true,
    }));
    postReplies = [json(pendingBody(3, 'queued'), 202)];
    getDefault = json(pendingBody(3, 'queued'));
    await renderDetail();

    expect(screen.getByText('Analysis needs recovery')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This interview is saved, but we could not confirm the analysis result. Running it again may make another paid provider request.',
    );
    expect(screen.queryByText('The analysis did not finish in time. Run it again.')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Run analysis again' }));
    await flush();
    expect(analyzeCalls('POST')).toHaveLength(1);
    expect(analyzeCalls('POST')[0].body).toEqual({ expectedGeneration: 2 });
    expect(screen.getByText('Analysis queued')).toBeInTheDocument();
  });

  it('UI-CF-02: an unreadable status keeps the last confirmed state and offers a read-only refresh', async () => {
    storageMock.getInterview
      .mockResolvedValueOnce(record(running(1)))
      .mockResolvedValue(completed(1));
    getReplies = [json({ error: 'Private upstream details' }, 503), json({ status: 'complete', generation: 1 })];
    await renderDetail();

    await flush(2_000);
    expect(screen.getByText('Status not checked')).toBeInTheDocument();
    expect(screen.getByText(/The analysis status is temporarily unavailable\. Try again shortly\. The last confirmed state is shown below\./)).toBeInTheDocument();
    expect(screen.getByText('Analysis running')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Private upstream details')).not.toBeInTheDocument();
    await flush(60_000);
    expect(analyzeCalls('GET')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Check status' }));
    await flush();
    await flush();
    expect(analyzeCalls('GET')).toHaveLength(2);
    expect(analyzeCalls('POST')).toHaveLength(0);
    expect(screen.getByText('A durable reading.')).toBeInTheDocument();
    expect(screen.queryByText('Status not checked')).not.toBeInTheDocument();
  });

  it('UI-CF-02: when the polling budget ends the work stays pending, with a read-only refresh and no automatic start', async () => {
    storageMock.getInterview.mockResolvedValue(record(queued(1)));
    getDefault = json(pendingBody(1, 'queued'));
    await renderDetail();

    await flush(180_000);
    const stillPending = 'Analysis is still pending. You can leave this page and check again later.';
    expect(screen.getByText('Analysis queued')).toBeInTheDocument();
    // Once on screen in the notice, once announced by the polite live region.
    expect(screen.getAllByText(stillPending)).toHaveLength(2);
    expect(liveRegion()).toHaveTextContent(stillPending);
    const reads = analyzeCalls('GET').length;
    await flush(5 * 60_000);
    expect(analyzeCalls('GET')).toHaveLength(reads);

    fireEvent.click(screen.getByRole('button', { name: 'Check status' }));
    await flush();
    await flush(60_000);
    expect(analyzeCalls('GET')).toHaveLength(reads + 1);
    expect(analyzeCalls('POST')).toHaveLength(0);
    expect(screen.getAllByText(stillPending)).toHaveLength(2);
  });

  it('UI-CF-02: an old client is told to reload before starting analysis', async () => {
    storageMock.getInterview.mockResolvedValue(record(undefined));
    postReplies = [json({ code: 'ANALYSIS_CLIENT_UPDATE_REQUIRED', error: 'Private server text' }, 409)];
    await renderDetail();

    fireEvent.click(screen.getByRole('button', { name: 'Run analysis' }));
    await flush();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Reload required');
    expect(alert).toHaveTextContent('Reload this page to analyze interviews.');
    expect(screen.getByRole('button', { name: 'Reload page' })).toBeInTheDocument();
    expect(screen.queryByText('Private server text')).not.toBeInTheDocument();
    expect(screen.getByText('Analysis pending')).toBeInTheDocument();
  });
});

describe('InterviewDetail — durable analysis actions and polling (UI-CF-03, API-03)', () => {
  it('API-03: pending → running → complete refreshes the record in place and shows the revision used', async () => {
    storageMock.getInterview
      .mockResolvedValueOnce(record(undefined))
      .mockResolvedValue(completed(1, 2));
    postReplies = [json(pendingBody(1, 'queued'), 202)];
    getReplies = [json(pendingBody(1, 'running')), json({ status: 'complete', generation: 1 })];
    await renderDetail();
    expect(liveRegion()).toHaveTextContent('');

    fireEvent.click(screen.getByRole('button', { name: 'Run analysis' }));
    await flush();
    const [post] = analyzeCalls('POST');
    expect(post.url).toBe(`/api/interviews/${INTERVIEW_ID}/analyze?studyId=${STUDY_ID}`);
    expect(post.headers['X-OpenInterviewer-Analysis-Version']).toBe('2');
    expect(post.headers['Idempotency-Key']).toMatch(UUID);
    expect(post.body).toEqual({ expectedGeneration: 0 });
    expect(screen.getByText('Analysis queued')).toBeInTheDocument();
    expect(liveRegion()).toHaveTextContent('Analysis queued.');

    await flush(1_999);
    expect(analyzeCalls('GET')).toHaveLength(0);
    await flush(1);
    expect(screen.getByText('Analysis running')).toBeInTheDocument();
    expect(liveRegion()).toHaveTextContent('Analysis running.');

    await flush(2_000);
    await flush();
    expect(screen.getByText('A durable reading.')).toBeInTheDocument();
    expect(screen.getByText(/analyzed at study rev 2/)).toBeInTheDocument();
    expect(liveRegion()).toHaveTextContent('Analysis complete.');
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    expect(storageMock.getInterview).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('tab', { name: 'Transcript' }));
    expect(screen.getByText('Hello there')).toBeInTheDocument();
    await flush(10 * 60_000);
    expect(analyzeCalls('GET')).toHaveLength(2);
    expect(analyzeCalls('POST')).toHaveLength(1);
  });

  it('API-03: a double press starts one action', async () => {
    storageMock.getInterview.mockResolvedValue(record(undefined));
    let answer!: (response: Response) => void;
    postReplies = [() => new Promise<Response>((resolve) => { answer = resolve; })];
    getDefault = json(pendingBody(1, 'queued'));
    await renderDetail();

    const button = screen.getByRole('button', { name: 'Run analysis' });
    fireEvent.click(button);
    fireEvent.click(button);
    await flush();
    expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled();
    answer(new Response(JSON.stringify(pendingBody(1, 'queued')), { status: 202 }));
    await flush();
    expect(analyzeCalls('POST')).toHaveLength(1);
  });

  it('API-03: an uncertain start is retried with the same key and body; a later action gets a fresh key', async () => {
    storageMock.getInterview
      .mockResolvedValueOnce(record(undefined))
      .mockResolvedValue(record({ status: 'failed', attempts: 1, lastAttemptAt: 1, generation: 1, failureKind: 'provider', recoveryRequired: false }));
    const notScheduled = json({ status: 'pending', generation: 0, phase: 'not-scheduled' });
    postReplies = [
      () => Promise.reject(new TypeError('Failed to fetch')),
      json({ retryable: true }, 503),
      json(pendingBody(1, 'queued'), 202),
      json(pendingBody(2, 'queued'), 202),
    ];
    // One read after each unconfirmed start finds nothing accepted.
    getReplies = [notScheduled, notScheduled, json({ status: 'failed', generation: 1, failureKind: 'provider', recoveryRequired: false })];
    getDefault = json(pendingBody(2, 'queued'));
    await renderDetail();

    fireEvent.click(screen.getByRole('button', { name: 'Run analysis' }));
    await flush();
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent('Check your connection and try again.');
    expect(analyzeCalls('GET')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Run analysis' }));
    await flush();
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent('Analysis is temporarily unavailable. Please try again.');
    expect(analyzeCalls('GET')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Run analysis' }));
    await flush();

    const posts = analyzeCalls('POST');
    expect(posts).toHaveLength(3);
    expect(new Set(posts.map((post) => post.headers['Idempotency-Key'])).size).toBe(1);
    expect(posts.map((post) => post.body)).toEqual([{ expectedGeneration: 0 }, { expectedGeneration: 0 }, { expectedGeneration: 0 }]);
    expect(screen.getByText('Analysis queued')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await flush(2_000);
    await flush();
    expect(screen.getByText('Analysis failed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Run analysis' }));
    await flush();
    const retry = analyzeCalls('POST')[3];
    expect(retry.body).toEqual({ expectedGeneration: 1 });
    expect(retry.headers['Idempotency-Key']).toMatch(UUID);
    expect(retry.headers['Idempotency-Key']).not.toBe(posts[0].headers['Idempotency-Key']);
  });

  it('UI-CF-02: an unconfirmed start is shown as unconfirmed, not failed, with a read-only status check', async () => {
    storageMock.getInterview.mockResolvedValue(record(undefined));
    postReplies = [json({ error: 'Private upstream details' }, 502)];
    getDefault = json({ status: 'pending', generation: 0, phase: 'not-scheduled' });
    await renderDetail();

    fireEvent.click(screen.getByRole('button', { name: 'Run analysis' }));
    await flush();
    await flush();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Analysis request not confirmed');
    expect(alert).toHaveTextContent(
      'The request may still have been accepted. Check the status before running it again. Running it again repeats this request rather than starting another.',
    );
    expect(screen.queryByText('Analysis request failed')).not.toBeInTheDocument();
    expect(screen.queryByText('Private upstream details')).not.toBeInTheDocument();
    expect(analyzeCalls('GET')).toHaveLength(1);

    fireEvent.click(within(alert).getByRole('button', { name: 'Check status' }));
    await flush();
    expect(analyzeCalls('GET')).toHaveLength(2);
    expect(analyzeCalls('POST')).toHaveLength(1);
    expect(screen.getByText('Analysis pending')).toBeInTheDocument();
  });

  it('API-03: an unconfirmed start the server did accept is found by one read and then observed, never restarted', async () => {
    storageMock.getInterview.mockResolvedValue(record(undefined));
    postReplies = [() => Promise.reject(new TypeError('Failed to fetch'))];
    getDefault = json(pendingBody(1, 'queued'));
    await renderDetail();

    fireEvent.click(screen.getByRole('button', { name: 'Run analysis' }));
    await flush();
    await flush();
    expect(analyzeCalls('GET')).toHaveLength(1);
    expect(screen.getByText('Analysis queued')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Run analysis/ })).not.toBeInTheDocument();
    expect(liveRegion()).toHaveTextContent('Analysis queued.');

    await flush(2_000);
    expect(analyzeCalls('GET')).toHaveLength(2);
    expect(analyzeCalls('POST')).toHaveLength(1);
  });

  it('API-01: a changed state is refreshed by a read, not retried', async () => {
    storageMock.getInterview.mockResolvedValue(record({
      status: 'failed', attempts: 1, lastAttemptAt: 1, generation: 2, failureKind: 'provider', recoveryRequired: false,
    }));
    postReplies = [json({ code: 'ANALYSIS_STATE_CHANGED' }, 409)];
    getReplies = [json(pendingBody(3, 'running'))];
    getDefault = json(pendingBody(3, 'running'));
    await renderDetail();

    fireEvent.click(screen.getByRole('button', { name: 'Run analysis' }));
    await flush();
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent('changed since the page loaded');
    expect(analyzeCalls('GET')).toHaveLength(1);
    expect(screen.getByText('Analysis running')).toBeInTheDocument();
    expect(analyzeCalls('POST')).toHaveLength(1);
  });

  it('API-03: a response older than the displayed generation is rejected', async () => {
    storageMock.getInterview.mockResolvedValue(record(queued(3)));
    getReplies = [json({ status: 'complete', generation: 2 })];
    getDefault = json(pendingBody(3, 'queued'));
    await renderDetail();

    await flush(2_000);
    expect(screen.getByText('Analysis queued')).toBeInTheDocument();
    expect(screen.queryByText('Analysis complete')).not.toBeInTheDocument();
    expect(storageMock.getInterview).toHaveBeenCalledTimes(1);
  });

  it('API-03: unmounting stops polling', async () => {
    storageMock.getInterview.mockResolvedValue(record(queued(1)));
    getDefault = json(pendingBody(1, 'queued'));
    const view = await renderDetail();

    await flush(2_000);
    expect(analyzeCalls('GET')).toHaveLength(1);
    view.unmount();
    await flush(5 * 60_000);
    expect(analyzeCalls('GET')).toHaveLength(1);
  });

  it('API-03: switching to another interview stops polling the first', async () => {
    storageMock.getInterview.mockImplementation(async (id: string) => (
      id === INTERVIEW_ID ? record(queued(1)) : record(undefined, { id: 'session-other' })
    ));
    getDefault = json(pendingBody(1, 'queued'));
    const view = await renderDetail();
    await flush(2_000);
    expect(analyzeCalls('GET')).toHaveLength(1);

    view.rerender(
      <BreadcrumbProvider>
        <InterviewDetail interviewId="session-other" studyId={STUDY_ID} />
      </BreadcrumbProvider>,
    );
    await flush();
    await flush(5 * 60_000);
    expect(analyzeCalls('GET')).toHaveLength(1);
  });

  it('API-03: pauses while hidden or offline and reads once on return', async () => {
    storageMock.getInterview.mockResolvedValue(record(queued(1)));
    getDefault = json(pendingBody(1, 'queued'));
    let visibility: DocumentVisibilityState = 'visible';
    let online = true;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
    try {
      await renderDetail();
      await flush(2_000);
      expect(analyzeCalls('GET')).toHaveLength(1);

      visibility = 'hidden';
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
      await flush(20_000);
      expect(analyzeCalls('GET')).toHaveLength(1);
      visibility = 'visible';
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
      await flush();
      expect(analyzeCalls('GET')).toHaveLength(2);

      online = false;
      await act(async () => { window.dispatchEvent(new Event('offline')); });
      await flush(20_000);
      expect(analyzeCalls('GET')).toHaveLength(2);
      online = true;
      await act(async () => { window.dispatchEvent(new Event('online')); });
      await flush();
      expect(analyzeCalls('GET')).toHaveLength(3);
    } finally {
      delete (document as unknown as Record<string, unknown>).visibilityState;
      delete (navigator as unknown as Record<string, unknown>).onLine;
    }
  });

  it('UI-CF-05: unchanged polls neither re-announce nor move focus', async () => {
    storageMock.getInterview.mockResolvedValue(record(undefined));
    postReplies = [json(pendingBody(1, 'running'), 202)];
    getDefault = json(pendingBody(1, 'running'));
    await renderDetail();

    const tab = screen.getByRole('tab', { name: 'Analysis' });
    tab.focus();
    fireEvent.click(screen.getByRole('button', { name: 'Run analysis' }));
    await flush();
    const region = liveRegion();
    expect(region).toHaveTextContent('Analysis running.');
    const observed: string[] = [];
    const observer = new MutationObserver(() => observed.push(region.textContent ?? ''));
    observer.observe(region, { childList: true, characterData: true, subtree: true });

    await flush(20_000);
    observer.disconnect();
    expect(analyzeCalls('GET').length).toBeGreaterThan(5);
    expect(observed).toEqual([]);
    expect(document.activeElement).toBe(tab);
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });
});

describe('InterviewDetail — unknown analysis capability (UI-CF-03)', () => {
  it('UI-CF-03: never polls, and starts the legacy way that a durable server refuses before any work', async () => {
    execution.mode = 'unknown';
    storageMock.getInterview.mockResolvedValue(record(undefined));
    postReplies = [json({ code: 'ANALYSIS_CLIENT_UPDATE_REQUIRED' }, 409)];
    await renderDetail();

    await flush(60_000);
    expect(analyzeCalls('GET')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Run analysis' }));
    await flush();
    const [post] = analyzeCalls('POST');
    expect(post.headers['X-OpenInterviewer-Analysis-Version']).toBeUndefined();
    expect(post.body).toBeUndefined();
    expect(screen.getByRole('alert')).toHaveTextContent('Reload this page to analyze interviews.');
    await flush(60_000);
    expect(analyzeCalls('GET')).toHaveLength(0);
  });

  it('UI-CF-02: active durable work stays queued, with no start action and no status read, until the capability is confirmed', async () => {
    execution.mode = 'unknown';
    storageMock.getInterview.mockResolvedValue(record(queued(1)));
    getDefault = json(pendingBody(1, 'queued'));
    await renderDetail();

    expect(screen.getByText('Analysis queued')).toBeInTheDocument();
    expect(screen.getByText('This interview is saved. Its analysis will run in the background.')).toBeInTheDocument();
    expect(screen.queryByText('This interview was saved. Its analysis has not run yet.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Run analysis/ })).not.toBeInTheDocument();
    expect(screen.getByText('Status not checked')).toBeInTheDocument();
    expect(liveRegion()).toHaveTextContent('');
    await flush(60_000);
    expect(analyzeCalls()).toHaveLength(0);

    // A check asks for the capability again and re-reads the record; while the
    // capability stays unknown it still sends no status read.
    const asked = execution.asked;
    fireEvent.click(screen.getByRole('button', { name: 'Check status' }));
    await flush();
    expect(execution.asked).toBe(asked + 1);
    expect(storageMock.getInterview).toHaveBeenCalledTimes(2);
    expect(analyzeCalls()).toHaveLength(0);

    execution.mode = 'queued-v2';
    fireEvent.click(screen.getByRole('button', { name: 'Check status' }));
    await flush();
    expect(screen.queryByText('Status not checked')).not.toBeInTheDocument();
    await flush(2_000);
    expect(analyzeCalls('GET')).toHaveLength(1);
    expect(analyzeCalls('POST')).toHaveLength(0);
  });
});

describe('InterviewDetail — interview switch, citation landing and reading (UI-CF-01, UI-CF-03, UI-CF-05)', () => {
  const recordFor = (id: string, analysis: InterviewAnalysisState | undefined, overrides: Partial<StoredInterview> = {}) => (
    record(analysis, { id, ...overrides })
  );
  const completeFor = (id: string) => recordFor(
    id,
    { status: 'complete', attempts: 1, lastAttemptAt: 1, generation: 1, studyRevision: 1 },
    { synthesis, aiModel: 'model-served' },
  );

  it.each([
    ['queued → complete', recordFor('session-a', queued(1)), completeFor('session-b')],
    ['complete → queued', completeFor('session-a'), recordFor('session-b', queued(1))],
    ['recovery → running', recordFor('session-a', {
      status: 'failed', attempts: 1, lastAttemptAt: 1, generation: 1, failureKind: 'timeout', recoveryRequired: true,
    }), recordFor('session-b', running(2))],
  ])('UI-CF-05: switching interviews in place (%s) announces nothing and reads each record once', async (_label, first, second) => {
    storageMock.getInterview.mockImplementation(async (id: string) => (id === first.id ? first : second));
    const view = await renderDetail(first.id);
    expect(liveRegion()).toHaveTextContent('');

    view.rerender(detail(second.id));
    await flush();
    await flush();
    await flush();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    expect(liveRegion()).toHaveTextContent('');
    expect(storageMock.getInterview.mock.calls.map((call) => call[0])).toEqual([first.id, second.id]);
  });

  it('UI-CF-05: a polled completion on a cited-turn page keeps the Analysis tab and focus', async () => {
    storageMock.getInterview
      .mockResolvedValueOnce(record(queued(1)))
      .mockResolvedValue(completed(1));
    getReplies = [json({ status: 'complete', generation: 1 })];
    render(detail(INTERVIEW_ID, '1'));
    await flush();
    await flush(16);
    expect(document.activeElement?.id).toBe('turn-1');

    fireEvent.click(screen.getByRole('tab', { name: 'Analysis' }));
    const tab = screen.getByRole('tab', { name: 'Analysis' });
    tab.focus();
    expect(screen.getByText('Analysis queued')).toBeInTheDocument();

    await flush(2_000);
    await flush();
    await flush(16);
    await flush(16);
    expect(storageMock.getInterview).toHaveBeenCalledTimes(2);
    expect(screen.getByText('A durable reading.')).toBeInTheDocument();
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(tab);
  });

  it('UI-CF-01: a finished reading does not wait for the analysis capability', async () => {
    execution.held = true;
    storageMock.getInterview.mockResolvedValue(completed(1));
    await renderDetail();

    expect(screen.getByText('A durable reading.')).toBeInTheDocument();
    expect(screen.queryByText('Checking analysis status…')).not.toBeInTheDocument();
    expect(analyzeCalls()).toHaveLength(0);
  });

  it('UI-CF-01: unfinished work waits for the capability before offering any action', async () => {
    execution.held = true;
    storageMock.getInterview.mockResolvedValue(record(undefined));
    await renderDetail();

    expect(screen.getByText('Checking analysis status…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Run analysis/ })).not.toBeInTheDocument();
    await flush(60_000);
    expect(analyzeCalls()).toHaveLength(0);
  });
});
