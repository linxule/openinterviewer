// UI-CF-02/04: a register that cannot be (re)read is never shown as an empty
// study or a missing one. Renders the real StudyDetail and storageService;
// only HTTP is scripted, so the storage classification is exercised too.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredInterview, makeStoredStudy, makeStudyConfig } from '../fixtures/models';

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const execution = vi.hoisted(() => ({ mode: 'synchronous' as 'synchronous' | 'queued-v2' }));
vi.mock('@/services/analysisExecution', () => ({ loadAnalysisExecution: async () => execution.mode }));

import { BreadcrumbProvider } from '@/components/shell/breadcrumb';
import StudyDetail from '@/components/StudyDetail';

const STUDY_ID = 'study-refresh';
const TOO_LARGE = 'This study has too much interview data to list at once.';

type Reply = () => Response;
const json = (body: unknown, status = 200): Reply => () => new Response(JSON.stringify(body), { status });
const networkError: Reply = () => {
  throw new TypeError('Failed to fetch');
};

const study = makeStoredStudy({
  id: STUDY_ID,
  config: makeStudyConfig({ id: STUDY_ID, name: 'Refresh Study' }),
  revision: 1,
  interviewCount: 1,
});
const awaiting = makeStoredInterview({ id: 'session-1', studyId: STUDY_ID, createdAt: 1_000, studyRevision: 1 });
const analyzed = makeStoredInterview({
  id: 'session-1',
  studyId: STUDY_ID,
  createdAt: 1_000,
  studyRevision: 1,
  synthesis: {
    statedPreferences: [], revealedPreferences: [], themes: [],
    contradictions: [], keyInsights: [], bottomLine: 'Refreshed reading.',
  },
  analysis: { status: 'complete', attempts: 1, lastAttemptAt: 1 },
});

// Replies per read, in call order; the last one repeats.
let studyReplies: Reply[];
let listReplies: Reply[];
let aggregateReplies: Reply[];
let linkReplies: Reply[];
let listCalls: number;

function next(replies: Reply[]): Response {
  const reply = replies.length > 1 ? replies.shift()! : replies[0];
  return reply();
}

beforeEach(() => {
  vi.useFakeTimers();
  router.push.mockReset();
  execution.mode = 'synchronous';
  studyReplies = [json({ study })];
  listReplies = [json({ interviews: [awaiting] })];
  aggregateReplies = [json({ aggregate: null })];
  linkReplies = [json({ links: [], truncated: false })];
  listCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.startsWith('/api/interviews?studyId=')) {
      listCalls += 1;
      return next(listReplies);
    }
    if (url.includes('/analyze')) {
      if (execution.mode === 'synchronous') return json({ status: 'complete' })();
      return method === 'POST'
        ? json({ status: 'pending', generation: 1, phase: 'queued', pollAfterMs: 2000 }, 202)()
        : json({ status: 'complete', generation: 1 })();
    }
    if (url === `/api/studies/${STUDY_ID}/aggregate`) return next(aggregateReplies);
    if (url === `/api/studies/${STUDY_ID}/participant-links`) return next(linkReplies);
    if (url === `/api/studies/${STUDY_ID}`) return next(studyReplies);
    throw new Error(`Unexpected fetch: ${method} ${url}`);
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

async function renderStudy() {
  const rendered = render(
    <BreadcrumbProvider>
      <StudyDetail studyId={STUDY_ID} />
    </BreadcrumbProvider>,
  );
  await flush();
  await flush();
  return rendered;
}

// What hosted mode answers another researcher on every study-scoped read
// (src/lib/researcherContext.ts 'deny'; statuses pinned by
// tests/unit/hosted.sharedByos.adversarial.test.ts).
const HOSTED_FOREIGN_STUDY = json({ error: 'Forbidden' }, 403);

async function runBatchToCompletion() {
  await renderStudy();
  fireEvent.click(screen.getByRole('tab', { name: 'Interviews' }));
  expect(screen.getAllByRole('button', { name: /^View interview/ })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Analyze 1 pending' }));
  for (let step = 0; step < 4; step += 1) await flush(2_000);
}

function expectRegisterKept() {
  expect(screen.getAllByRole('button', { name: /^View interview/ })).toHaveLength(1);
  expect(screen.queryByText('No Interviews Yet')).not.toBeInTheDocument();
  expect(screen.queryByText('Study Not Found')).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Refresh Study' })).toBeInTheDocument();
  expect(screen.getByText('Batch complete: 1 of 1 finished.')).toBeInTheDocument();
}

function refreshNotice() {
  return screen.getByText('Not refreshed').closest('div')!;
}

describe.each(['synchronous', 'queued-v2'] as const)('StudyDetail post-batch refresh (%s protocol)', (mode) => {
  beforeEach(() => {
    execution.mode = mode;
  });

  it('a successful refresh replaces the register in place with no notice', async () => {
    listReplies = [json({ interviews: [awaiting] }), json({ interviews: [analyzed] })];
    await runBatchToCompletion();

    expect(listCalls).toBe(2);
    expect(screen.getByText('Refreshed reading.')).toBeInTheDocument();
    expect(screen.queryByText('Not refreshed')).not.toBeInTheDocument();
    expectRegisterKept();
  });

  it('UI-CF-04: a list over the size ceiling (413) keeps the register and shows the server message', async () => {
    listReplies = [json({ interviews: [awaiting] }), json({ error: TOO_LARGE }, 413)];
    await runBatchToCompletion();

    expect(listCalls).toBe(2);
    expectRegisterKept();
    expect(refreshNotice()).toHaveTextContent(TOO_LARGE);
  });

  it.each<[string, Reply]>([
    ['401', json({ error: 'Unauthorized' }, 401)],
    ['a network error', networkError],
  ])('UI-CF-04: a list refresh that fails with %s keeps the register', async (_label, failure) => {
    listReplies = [json({ interviews: [awaiting] }), failure];
    await runBatchToCompletion();

    expect(listCalls).toBe(2);
    expectRegisterKept();
    expect(refreshNotice()).toBeInTheDocument();
  });

  it.each<[string, Reply]>([
    ['500', json({ error: 'Failed to fetch study' }, 500)],
    ['a network error', networkError],
  ])('UI-CF-04: a study refresh that fails with %s keeps the page and the register', async (_label, failure) => {
    studyReplies = [json({ study }), failure];
    listReplies = [json({ interviews: [awaiting] }), json({ interviews: [analyzed] })];
    await runBatchToCompletion();

    expectRegisterKept();
    // Nothing from the partial refresh is committed.
    expect(screen.queryByText('Refreshed reading.')).not.toBeInTheDocument();
    expect(refreshNotice()).toBeInTheDocument();
  });

  it('UI-CF-04: a hosted 403 on the study refresh gives the notice a 404 gives, never the server\'s Forbidden', async () => {
    studyReplies = [json({ study }), HOSTED_FOREIGN_STUDY];
    listReplies = [json({ interviews: [awaiting] }), json({ interviews: [analyzed] })];
    await runBatchToCompletion();

    expectRegisterKept();
    expect(refreshNotice()).toHaveTextContent('Study not found');
    expect(refreshNotice()).not.toHaveTextContent('Forbidden');
  });
});

describe('StudyDetail initial load (UI-CF-02)', () => {
  it('shows the empty state only for a confirmed empty list', async () => {
    listReplies = [json({ interviews: [] })];
    await renderStudy();
    fireEvent.click(screen.getByRole('tab', { name: 'Interviews' }));

    expect(screen.getByText('No Interviews Yet')).toBeInTheDocument();
  });

  it('shows a list over the size ceiling as that failure, not as an empty study', async () => {
    listReplies = [json({ error: TOO_LARGE }, 413)];
    await renderStudy();
    expect(screen.getByRole('heading', { name: 'Refresh Study' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Interviews' }));

    expect(screen.queryByText('No Interviews Yet')).not.toBeInTheDocument();
    expect(screen.getByText('Interviews could not be loaded')).toBeInTheDocument();
    expect(screen.getByText(TOO_LARGE)).toBeInTheDocument();
  });

  it('shows a list that could not be read (network) as that failure', async () => {
    listReplies = [networkError];
    await renderStudy();
    fireEvent.click(screen.getByRole('tab', { name: 'Interviews' }));

    expect(screen.queryByText('No Interviews Yet')).not.toBeInTheDocument();
    expect(screen.getByText('Interviews could not be loaded')).toBeInTheDocument();
  });

  it('reports Study Not Found only for a 404', async () => {
    studyReplies = [json({ error: 'Study not found' }, 404)];
    await renderStudy();

    expect(screen.getByText('Study Not Found')).toBeInTheDocument();
  });

  it('hosted: shows another researcher\'s study (403 on every study-scoped read) exactly as a missing one', async () => {
    studyReplies = [json({ error: 'Study not found' }, 404)];
    const missing = await renderStudy();
    const missingPage = missing.container.innerHTML;
    missing.unmount();

    studyReplies = [HOSTED_FOREIGN_STUDY];
    listReplies = [HOSTED_FOREIGN_STUDY];
    aggregateReplies = [HOSTED_FOREIGN_STUDY];
    linkReplies = [HOSTED_FOREIGN_STUDY];
    const foreign = await renderStudy();

    expect(screen.getByText('Study Not Found')).toBeInTheDocument();
    expect(screen.queryByText('Workspace unavailable')).not.toBeInTheDocument();
    expect(screen.queryByText(/Forbidden/)).not.toBeInTheDocument();
    expect(foreign.container.innerHTML).toBe(missingPage);
  });

  it.each<[string, Reply]>([
    ['503', json({ error: 'Study storage is temporarily unavailable.' }, 503)],
    ['500', json({ error: 'Failed to fetch study' }, 500)],
    ['a network error', networkError],
  ])('shows a study read that fails with %s as unavailable, not as missing', async (_label, failure) => {
    studyReplies = [failure];
    await renderStudy();

    expect(screen.getByText('Workspace unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Study Not Found')).not.toBeInTheDocument();
  });

  it('asks an expired session to sign in again instead of reporting the study missing', async () => {
    studyReplies = [json({ error: 'Unauthorized' }, 401)];
    await renderStudy();

    expect(screen.queryByText('Study Not Found')).not.toBeInTheDocument();
    expect(screen.getByText('Sign in required')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(router.push).toHaveBeenCalledWith(`/login?redirect=${encodeURIComponent(`/studies/${STUDY_ID}`)}`);
  });

  it('keeps the study and register when only the aggregate read fails, and says so', async () => {
    aggregateReplies = [json({ error: 'Analysis storage is temporarily unavailable.' }, 503)];
    await renderStudy();

    expect(screen.getByRole('heading', { name: 'Refresh Study' })).toBeInTheDocument();
    expect(screen.getByText(/The saved aggregate analysis could not be loaded/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Interviews' }));
    expect(screen.getAllByRole('button', { name: /^View interview/ })).toHaveLength(1);
  });
});
