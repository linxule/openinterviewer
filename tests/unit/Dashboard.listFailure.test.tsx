// UI-CF-02: a per-study interview list that cannot be read is never shown as
// "No Interviews Yet". Renders the real Dashboard and storageService; only
// HTTP is scripted.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { makeStoredInterview, makeStoredStudy, makeStudyConfig } from '../fixtures/models';

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

import { BreadcrumbProvider } from '@/components/shell/breadcrumb';
import Dashboard from '@/components/Dashboard';

const STUDY_ID = 'study-dashboard';
const TOO_LARGE = 'This study has too much interview data to list at once.';

const study = makeStoredStudy({
  id: STUDY_ID,
  config: makeStudyConfig({ id: STUDY_ID, name: 'Dashboard Study' }),
  interviewCount: 1,
});
const interview = makeStoredInterview({ id: 'session-1', studyId: STUDY_ID, studyName: 'Dashboard Study' });

let studyList: () => Response;

beforeEach(() => {
  studyList = () => new Response(JSON.stringify({ interviews: [interview] }));
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/studies?view=summary') return new Response(JSON.stringify({ studies: [study] }));
    if (url === '/api/interviews') return new Response(JSON.stringify({ interviews: [interview] }));
    if (url === `/api/interviews?studyId=${STUDY_ID}`) return studyList();
    throw new Error(`Unexpected fetch: ${url}`);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function selectStudy() {
  render(
    <BreadcrumbProvider>
      <Dashboard />
    </BreadcrumbProvider>,
  );
  await screen.findByRole('table');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: STUDY_ID } });
}

describe('Dashboard per-study list (UI-CF-02)', () => {
  it('lists the study\'s interviews when the read succeeds', async () => {
    await selectStudy();

    expect(await screen.findByRole('button', { name: 'Dashboard Study' })).toBeInTheDocument();
  });

  it('shows the empty state for a confirmed empty list', async () => {
    studyList = () => new Response(JSON.stringify({ interviews: [] }));
    await selectStudy();

    expect(await screen.findByText('No Interviews Yet')).toBeInTheDocument();
  });

  it.each<[string, () => Response, string]>([
    ['413', () => new Response(JSON.stringify({ error: TOO_LARGE }), { status: 413 }), 'Interviews could not be loaded'],
    ['500', () => new Response(JSON.stringify({ error: 'Failed to fetch interviews' }), { status: 500 }), 'Interviews could not be loaded'],
    ['a network error', () => {
      throw new TypeError('Failed to fetch');
    }, 'Workspace unavailable'],
  ])('shows a list that fails with %s as that failure, not as an empty study', async (_label, failure, heading) => {
    studyList = failure;
    await selectStudy();

    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
    expect(screen.queryByText('No Interviews Yet')).not.toBeInTheDocument();
  });

  it('shows the server message for a list over the size ceiling', async () => {
    studyList = () => new Response(JSON.stringify({ error: TOO_LARGE }), { status: 413 });
    await selectStudy();

    expect(await screen.findByText(TOO_LARGE)).toBeInTheDocument();
  });
});

describe('Dashboard selection ownership', () => {
  const SECOND = 'study-second';
  const secondStudy = makeStoredStudy({ id: SECOND, config: makeStudyConfig({ id: SECOND, name: 'Second study' }) });
  const secondInterview = makeStoredInterview({ id: 'second-result', studyId: SECOND, studyName: 'Second study' });

  it('a delayed old read cannot stop the newest loading state or overwrite its result', async () => {
    let answerOld!: (response: Response) => void;
    let answerNew!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/studies?view=summary') return new Response(JSON.stringify({ studies: [study, secondStudy] }));
      if (url === '/api/interviews') return new Response(JSON.stringify({ interviews: [] }));
      if (url === `/api/interviews?studyId=${STUDY_ID}`) return new Promise<Response>(resolve => { answerOld = resolve; });
      if (url === `/api/interviews?studyId=${SECOND}`) return new Promise<Response>(resolve => { answerNew = resolve; });
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    render(<BreadcrumbProvider><Dashboard /></BreadcrumbProvider>);
    const filter = await screen.findByRole('combobox');
    fireEvent.change(filter, { target: { value: STUDY_ID } });
    fireEvent.change(filter, { target: { value: SECOND } });
    await act(async () => { answerOld(new Response(JSON.stringify({ error: 'Old read failed' }), { status: 500 })); });
    expect(screen.getByText('Loading interviews…')).toBeInTheDocument();
    expect(screen.queryByText('Old read failed')).not.toBeInTheDocument();
    await act(async () => { answerNew(new Response(JSON.stringify({ interviews: [secondInterview] }))); });
    expect(await screen.findByRole('button', { name: 'Second study' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dashboard Study' })).not.toBeInTheDocument();
  });

  it('late older rows cannot replace the selected dataset after the latest read finished', async () => {
    let answerOld!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/studies?view=summary') return new Response(JSON.stringify({ studies: [study, secondStudy] }));
      if (url === '/api/interviews') return new Response(JSON.stringify({ interviews: [] }));
      if (url === `/api/interviews?studyId=${STUDY_ID}`) return new Promise<Response>(resolve => { answerOld = resolve; });
      if (url === `/api/interviews?studyId=${SECOND}`) return new Response(JSON.stringify({ interviews: [secondInterview] }));
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    render(<BreadcrumbProvider><Dashboard /></BreadcrumbProvider>);
    const filter = await screen.findByRole('combobox');
    fireEvent.change(filter, { target: { value: STUDY_ID } });
    fireEvent.change(filter, { target: { value: SECOND } });
    expect(await screen.findByRole('button', { name: 'Second study' })).toBeInTheDocument();
    await act(async () => { answerOld(new Response(JSON.stringify({ interviews: [interview] }))); });
    expect(screen.getByRole('button', { name: 'Second study' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dashboard Study' })).not.toBeInTheDocument();
  });

  it('a successful empty selection clears the prior selection\'s outage', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/studies?view=summary') return new Response(JSON.stringify({ studies: [study, secondStudy] }));
      if (url === '/api/interviews') return new Response(JSON.stringify({ interviews: [] }));
      if (url === `/api/interviews?studyId=${STUDY_ID}`) throw new TypeError('Failed to fetch');
      if (url === `/api/interviews?studyId=${SECOND}`) return new Response(JSON.stringify({ interviews: [] }));
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    render(<BreadcrumbProvider><Dashboard /></BreadcrumbProvider>);
    const filter = await screen.findByRole('combobox');
    fireEvent.change(filter, { target: { value: STUDY_ID } });
    expect(await screen.findByRole('heading', { name: 'Workspace unavailable' })).toBeInTheDocument();
    fireEvent.change(filter, { target: { value: SECOND } });
    expect(await screen.findByText('No Interviews Yet')).toBeInTheDocument();
    expect(screen.queryByText('Interview storage is temporarily unavailable.')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Workspace unavailable' })).not.toBeInTheDocument();
  });
});
