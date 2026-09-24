import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useStore } from '@/store';
import { makeStudyConfig } from '../fixtures/models';

// The router never completes a navigation: every route change stays in flight,
// as it does on a slow network between router.replace() and the new page.
const navigation = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));

vi.mock('next/navigation', () => ({
  useParams: () => ({ token: 'link-code-under-test' }),
  useRouter: () => navigation,
}));

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
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(useStore.getState().participantSessionHandle).toBe('new-session-handle');
  });

  it('hands over to /consent without rendering any interview step itself', async () => {
    const fetchMock = vi.fn().mockResolvedValue(resolvedLink());
    vi.stubGlobal('fetch', fetchMock);

    render(<ParticipantPage />);

    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith('/consent'));
    expect(useStore.getState()).toMatchObject({ currentStep: 'consent', viewMode: 'participant' });
    expect(screen.getByRole('status')).toHaveTextContent('Loading interview...');
    expect(screen.queryByRole('button', { name: /I consent/i })).not.toBeInTheDocument();

    // A step change while the navigation is pending (as consent recorded
    // elsewhere would make) must not mount a transient chat on this route.
    act(() => useStore.getState().setStep('interview'));
    expect(screen.queryByLabelText('Your response')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading interview...');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/generate-link?token=link-code-under-test');
  });

  it('shows the link error and never navigates when the link does not resolve', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ valid: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));

    render(<ParticipantPage />);

    expect(await screen.findByText('Invalid or expired link')).toBeInTheDocument();
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('participant link page transport disclosure (RT-11)', () => {
  it.each(['direct', 'gateway', 'cloudflare-gateway'])('carries the exchanged transport %s to the consent page', async (transport) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resolvedLink(transport)));

    render(<ParticipantPage />);

    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith('/consent'));
    expect(useStore.getState().aiTransport).toBe(transport);
  });

  it.each([ABSENT, 'carrier-pigeon', null])('fails closed on an unknown transport (%s): no session and no consent page', async (transport) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resolvedLink(transport)));

    render(<ParticipantPage />);

    expect(await screen.findByText('This study could not confirm how your responses are sent')).toBeInTheDocument();
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(useStore.getState().participantSessionHandle).toBeNull();
  });
});
