// UI-CF-02: a per-study interview list that cannot be read is never shown as
// "No Interviews Yet". Renders the real Dashboard and storageService; only
// HTTP is scripted.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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
    if (url === '/api/studies') return new Response(JSON.stringify({ studies: [study] }));
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
