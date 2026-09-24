import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useStore } from '@/store';
import { makeStudyConfig } from '../fixtures/models';

// The hand-over never completes: the document navigation stays in flight, as
// it does on a slow network between location.replace() and the new page. The
// page itself never uses the client router: the hand-over chooses between a
// document navigation and the router, so the router mock records any call.
const navigation = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
const handover = vi.hoisted(() => ({ leaveLinkPage: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => navigation,
}));
vi.mock('@/lib/participantLinkHandover', () => handover);

import ParticipantPage from '@/app/p/page';

const ABSENT = Symbol('absent');

// jsdom's Storage, not the Node global of the same name.
const jsdomStorage = () => Object.getPrototypeOf(window.sessionStorage) as Storage;

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
  // The page reads the link code from the address bar: /p/<code> is rewritten
  // to the static /p route, which has no route parameters (next.config.js).
  window.history.replaceState(null, '', '/p/link-code-under-test');
  sessionStorage.clear();
  useStore.setState(useStore.getInitialState(), true);
  navigation.replace.mockReset();
  navigation.push.mockReset();
  handover.leaveLinkPage.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

  it('reports a missing link code without calling the exchange', async () => {
    window.history.replaceState(null, '', '/p');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(<ParticipantPage />);

    expect(await screen.findByText('No participant link code provided')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still hands over when the session cannot be written to sessionStorage (quota)', async () => {
    vi.spyOn(jsdomStorage(), 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resolvedLink()));

    render(<ParticipantPage />);

    await waitFor(() => expect(handover.leaveLinkPage).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Failed to load study configuration')).not.toBeInTheDocument();
    expect(useStore.getState()).toMatchObject({
      participantSessionHandle: 'participant-handle-link-123456',
      currentStep: 'consent',
      viewMode: 'participant',
    });
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
  const persistedState = (handle: string) => ({
    participantSessionHandle: handle,
    studyConfig: makeStudyConfig({ id: 'persisted-study' }),
    aiTransport: 'direct',
  });
  const stored = (entry: unknown) => () => ({
    getItem: (key: string) => (key === 'research-tool-storage' ? JSON.stringify(entry) : null),
  });
  const persisted = (handle: string) => stored({ state: persistedState(handle), version: 6 });

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
    ['an entry without state', stored({ version: 6 })],
    ['no study persisted', stored({ state: { ...persistedState('handle-1'), studyConfig: null }, version: 6 })],
    ['a study without an id', stored({ state: { ...persistedState('handle-1'), studyConfig: {} }, version: 6 })],
    ['no transport persisted', stored({ state: { ...persistedState('handle-1'), aiTransport: null }, version: 6 })],
    ['an unknown transport persisted', stored({ state: { ...persistedState('handle-1'), aiTransport: 'carrier-pigeon' }, version: 6 })],
    ['an older store version', stored({ state: persistedState('handle-1'), version: 5 })],
    ['a newer store version', stored({ state: persistedState('handle-1'), version: 7 })],
    ['no store version', stored({ state: persistedState('handle-1') })],
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
    useStore.getState().beginParticipantSession(makeStudyConfig({ id: 'persisted-study' }), 'persisted-handle', 'cloudflare-gateway');
    expect(sessionSurvivesDocumentLoad('persisted-handle')).toBe(true);
    expect(sessionSurvivesDocumentLoad('another-handle')).toBe(false);
  });

  it('keeps the session in memory with the client router when the store cannot write it (quota)', async () => {
    const { leaveLinkPage } = await actual();
    // An earlier session in this tab was persisted; the new one does not fit.
    useStore.getState().beginParticipantSession(makeStudyConfig({ id: 'earlier-study' }), 'earlier-handle', 'direct');
    vi.spyOn(jsdomStorage(), 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });

    expect(() => useStore.getState().beginParticipantSession(makeStudyConfig({ id: 'new-study' }), 'new-handle', 'direct'))
      .not.toThrow();
    // The stale entry is gone, so no document load could restore the earlier session.
    expect(sessionStorage.getItem('research-tool-storage')).toBeNull();
    const location = { replace: vi.fn() };
    const clientNavigate = vi.fn();
    leaveLinkPage('new-handle', clientNavigate, location);
    expect(location.replace).not.toHaveBeenCalled();
    expect(clientNavigate).toHaveBeenCalledWith('/consent');
    expect(useStore.getState().studyConfig?.id).toBe('new-study');
  });
});
