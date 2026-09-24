import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useStore } from '@/store';
import { makeStudyConfig } from '../fixtures/models';

// The hand-over never completes: the document navigation stays in flight, as
// it does on a slow network between location.replace() and the new page. The
// client router must not be used at all (it would send the link code in its
// Next-Url header), so its mock records any call.
const navigation = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
const handover = vi.hoisted(() => ({ leaveLinkPage: vi.fn() }));

vi.mock('next/navigation', () => ({
  useParams: () => ({ token: 'link-code-under-test' }),
  useRouter: () => navigation,
}));
vi.mock('@/lib/participantLinkHandover', () => handover);

import ParticipantPage from '@/app/p/[token]/page';

const ABSENT = Symbol('absent');

function resolvedLink(aiTransport: unknown = 'direct'): Response {
  return new Response(JSON.stringify({
    valid: true,
    data: {
      studyConfig: makeStudyConfig({ id: 'study-link' }),
      sessionHandle: 'participant-handle-link-123456',
      ...(aiTransport === ABSENT ? {} : { aiTransport }),
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  sessionStorage.clear();
  useStore.setState(useStore.getInitialState(), true);
  navigation.replace.mockReset();
  navigation.push.mockReset();
  handover.leaveLinkPage.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('participant link page during a delayed route change', () => {
  it('does not replace the current session when an abandoned lookup answers late', async () => {
    let answer!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; })));
    const page = render(<ParticipantPage />);
    page.unmount();
    useStore.getState().beginParticipantSession(makeStudyConfig({ id: 'new-session' }), 'new-session-handle');
    await act(async () => { answer(resolvedLink()); });
    expect(handover.leaveLinkPage).not.toHaveBeenCalled();
    expect(useStore.getState().participantSessionHandle).toBe('new-session-handle');
  });

  it('hands over to /consent without rendering any interview step itself', async () => {
    const fetchMock = vi.fn().mockResolvedValue(resolvedLink());
    vi.stubGlobal('fetch', fetchMock);

    render(<ParticipantPage />);

    await waitFor(() => expect(handover.leaveLinkPage).toHaveBeenCalledTimes(1));
    expect(handover.leaveLinkPage).toHaveBeenCalledWith('participant-handle-link-123456', expect.any(Function));
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(navigation.push).not.toHaveBeenCalled();
    // The fallback it is given is the client router's replace.
    handover.leaveLinkPage.mock.calls[0][1]('/consent');
    expect(navigation.replace).toHaveBeenCalledWith('/consent');
    navigation.replace.mockReset();
    expect(useStore.getState()).toMatchObject({ currentStep: 'consent', viewMode: 'participant' });
    expect(screen.getByRole('status')).toHaveTextContent('Loading interview...');
    expect(screen.queryByRole('button', { name: /I consent/i })).not.toBeInTheDocument();

    // A step change while the navigation is pending (as consent recorded
    // elsewhere would make) must not mount a transient chat on this route.
    act(() => useStore.getState().setStep('interview'));
    expect(screen.queryByLabelText('Your response')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading interview...');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/generate-link?token=link-code-under-test', { referrerPolicy: 'no-referrer' });
  });

  it('shows the link error and never navigates when the link does not resolve', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ valid: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));

    render(<ParticipantPage />);

    expect(await screen.findByText('Invalid or expired link')).toBeInTheDocument();
    expect(handover.leaveLinkPage).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('participant link page transport disclosure (RT-11)', () => {
  it.each(['direct', 'gateway', 'cloudflare-gateway'])('carries the exchanged transport %s to the consent page', async (transport) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resolvedLink(transport)));

    render(<ParticipantPage />);

    await waitFor(() => expect(handover.leaveLinkPage).toHaveBeenCalledTimes(1));
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(navigation.push).not.toHaveBeenCalled();
    expect(useStore.getState().aiTransport).toBe(transport);
  });

  it.each([ABSENT, 'carrier-pigeon', null])('fails closed on an unknown transport (%s): no session and no consent page', async (transport) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resolvedLink(transport)));

    render(<ParticipantPage />);

    expect(await screen.findByText('This study could not confirm how your responses are sent')).toBeInTheDocument();
    expect(handover.leaveLinkPage).not.toHaveBeenCalled();
    expect(useStore.getState().participantSessionHandle).toBeNull();
  });
});

describe('participant link hand-over', () => {
  const actual = () => vi.importActual<typeof import('@/lib/participantLinkHandover')>('@/lib/participantLinkHandover');
  const persisted = (handle: string) => () => ({
    getItem: (key: string) => (key === 'research-tool-storage'
      ? JSON.stringify({ state: { participantSessionHandle: handle }, version: 6 })
      : null),
  });

  it('is a document navigation to /consent when the session is persisted', async () => {
    const { leaveLinkPage } = await actual();
    const location = { replace: vi.fn() };
    const clientNavigate = vi.fn();
    leaveLinkPage('handle-1', clientNavigate, location, persisted('handle-1'));
    expect(location.replace).toHaveBeenCalledWith('/consent');
    expect(clientNavigate).not.toHaveBeenCalled();
  });

  it.each([
    ['storage access throws', () => { throw new DOMException('denied', 'SecurityError'); }],
    ['nothing persisted', () => ({ getItem: () => null })],
    ['another session persisted', persisted('handle-other')],
    ['a corrupt entry', () => ({ getItem: () => '{not json' })],
  ])('keeps the in-memory session with the client router when %s', async (_label, storage) => {
    const { leaveLinkPage } = await actual();
    const location = { replace: vi.fn() };
    const clientNavigate = vi.fn();
    leaveLinkPage('handle-1', clientNavigate, location, storage as () => Pick<Storage, 'getItem'>);
    expect(location.replace).not.toHaveBeenCalled();
    expect(clientNavigate).toHaveBeenCalledWith('/consent');
  });

  it('reads back what the store actually persists for a new participant session', async () => {
    const { sessionSurvivesDocumentLoad } = await actual();
    useStore.getState().beginParticipantSession(makeStudyConfig({ id: 'persisted-study' }), 'persisted-handle', 'direct');
    expect(sessionSurvivesDocumentLoad('persisted-handle')).toBe(true);
    expect(sessionSurvivesDocumentLoad('another-handle')).toBe(false);
  });
});
