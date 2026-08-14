import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredInterview, makeStoredStudy, makeStudyConfig } from '../fixtures/models';
import StudyDetail from '@/components/StudyDetail';

const router = { push: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const storageMock = vi.hoisted(() => ({
  getStudy: vi.fn(),
  getStudyInterviews: vi.fn(),
}));
vi.mock('@/services/storageService', () => storageMock);

const linkId = 'a'.repeat(64);
const createdAt = new Date('2026-08-14T12:00:00Z').getTime();

beforeEach(() => {
  vi.clearAllMocks();
  const config = makeStudyConfig({ id: 'study-a', name: 'Managed Links Study' });
  storageMock.getStudy.mockResolvedValue(makeStoredStudy({
    id: 'study-a', config, revision: 2,
  }));
  storageMock.getStudyInterviews.mockResolvedValue([]);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(window, 'alert').mockImplementation(() => {});
});

describe('StudyDetail participant-link management', () => {
  it('lists metadata and revokes an individual link without redisplaying its URL', async () => {
    let listCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/studies/study-a/participant-links') && init?.method === 'DELETE') {
        return new Response(JSON.stringify({
          link: { id: linkId, revoked: true, revokedAt: createdAt + 1_000 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/api/studies/study-a/participant-links')) {
        listCalls += 1;
        return new Response(JSON.stringify({
          links: [{
            id: linkId,
            studyRevision: 2,
            createdAt,
            expiresAt: null,
            revokedAt: listCalls > 1 ? createdAt + 1_000 : null,
          }],
          truncated: false,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<StudyDetail studyId="study-a" />);
    const settingsLabel = await screen.findByText('Study settings');
    fireEvent.click(settingsLabel.closest('button') as HTMLButtonElement);

    expect(await screen.findByText('Active')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Participant access' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/link urls cannot be viewed again/i)).toBeInTheDocument();
    expect(screen.queryByDisplayValue(/\/p\//)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /revoke participant link created/i }));

    await waitFor(() => expect(screen.getByText('Revoked')).toBeInTheDocument());
    expect(window.confirm).toHaveBeenCalled();
    const deleteCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE');
    expect(deleteCall?.[1]?.body).toBe(JSON.stringify({ linkId }));
  });

  it('keeps the study workspace compact on mobile and names interview controls', async () => {
    storageMock.getStudyInterviews.mockResolvedValue([
      makeStoredInterview({ id: 'interview-a', studyId: 'study-a' }),
    ]);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/api/studies/study-a/participant-links')) {
        return new Response(JSON.stringify({ links: [], truncated: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    }));

    render(<StudyDetail studyId="study-a" />);

    const heading = await screen.findByRole('heading', { name: 'Managed Links Study' });
    expect(heading.closest('.min-h-screen')).toHaveClass('p-4', 'sm:p-8');
    expect(screen.getByRole('tablist', { name: 'Study sections' })).toHaveClass('grid-cols-3');
    expect(screen.getByRole('group', { name: 'Study summary' })).toHaveClass('grid-cols-1', 'sm:grid-cols-3');

    fireEvent.click(screen.getByRole('tab', { name: 'Interviews' }));
    expect(await screen.findByRole('button', { name: 'View interview 1' })).toBeInTheDocument();
  });
});
