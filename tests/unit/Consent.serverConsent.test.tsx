import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useStore } from '@/store';
import { makeStudyConfig } from '../fixtures/models';

const navigation = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => navigation,
}));

import Consent from '@/components/Consent';

beforeEach(() => {
  sessionStorage.clear();
  useStore.setState(useStore.getInitialState(), true);
  navigation.push.mockReset();
  useStore.getState().beginParticipantSession(
    makeStudyConfig({ id: 'study-a' }),
    'participant-handle-a-123456'
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Consent server recording', () => {
  it('removes consent controls after a researcher chooses Back while setup is still loading', () => {
    useStore.getState().setViewMode('preview');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<Consent />);
    const consent = screen.getByRole('button', { name: /I consent/i });
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(consent);
    expect(screen.getByRole('status')).toHaveTextContent('Returning to study setup');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(navigation.push).toHaveBeenCalledExactlyOnceWith('/setup');
  });

  it('does not reopen an abandoned interview when consent returns after unmount', async () => {
    let answer!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; })));
    const page = render(<Consent />);
    fireEvent.click(screen.getByRole('button', { name: /I consent/i }));
    page.unmount();
    useStore.getState().reset();
    await act(async () => { answer(new Response(JSON.stringify({ acceptedAt: 123 }))); });
    expect(navigation.push).not.toHaveBeenCalled();
    expect(useStore.getState().consentGiven).toBe(false);
    expect(useStore.getState().currentStep).toBe('setup');
  });

  it('names the selected direct provider without exposing credential details', () => {
    render(<Consent />);

    expect(screen.getByText(/Your responses are sent to Google Gemini\./)).toBeInTheDocument();
    expect(screen.getByText(/researcher is the study's data controller/i)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/API key|GEMINI_API_KEY|AIza/i);
  });

  describe('provider commitment in the data notice', () => {
    const begin = (config: Parameters<typeof makeStudyConfig>[0]) => {
      useStore.setState(useStore.getInitialState(), true);
      useStore.getState().beginParticipantSession(makeStudyConfig({ id: 'study-a', ...config }), 'participant-handle-a-123456');
    };

    it('fixed: names the model and says the study does not switch provider or model', () => {
      begin({ aiProvider: 'claude', aiModel: 'claude-sonnet-5', aiProviderCommitment: 'fixed' });
      render(<Consent />);

      expect(screen.getByText(/Your responses are sent to Anthropic Claude\./)).toBeInTheDocument();
      expect(screen.getByText(
        /The interview and any later analysis of your responses use Claude Sonnet 5 \(Anthropic Claude\); the study does not switch them to another AI provider or model\./,
      )).toBeInTheDocument();
    });

    it('fixed: a custom OpenRouter model is named by its id', () => {
      begin({ aiProvider: 'openrouter', aiModel: 'acme/model-x', aiProviderCommitment: 'fixed' });
      render(<Consent />);

      expect(screen.getByText(/use acme\/model-x \(OpenRouter\); the study does not switch/)).toBeInTheDocument();
    });

    it('may-change: says the researcher may later use a different provider or model', () => {
      begin({ aiProvider: 'claude', aiModel: 'claude-sonnet-5', aiProviderCommitment: 'may-change' });
      render(<Consent />);

      expect(screen.getByText(/The researcher may later analyze your responses with a different AI provider or model\./)).toBeInTheDocument();
      expect(document.body).not.toHaveTextContent(/does not switch/);
    });

    it('a study saved before commitments existed keeps the old notice', () => {
      begin({ aiProvider: 'claude', aiModel: 'claude-sonnet-5' });
      render(<Consent />);

      expect(screen.getByText(/Your responses are sent to Anthropic Claude\./)).toBeInTheDocument();
      expect(document.body).not.toHaveTextContent(/does not switch|may later analyze/);
    });
  });

  it('disables the primary consent button until the provider configuration is ready', () => {
    useStore.getState().beginParticipantSession(
      makeStudyConfig({ id: 'study-unconfigured', aiModel: '' }),
      'participant-handle-unconfigured-123456'
    );

    render(<Consent />);

    expect(screen.getByRole('alert')).toHaveTextContent(
      'This interview is unavailable until the researcher reviews and saves its AI provider settings.'
    );
    expect(screen.getByRole('button', { name: /I consent — begin the interview/i })).toBeDisabled();
  });

  it('discloses OpenRouter and its privacy-compatible upstream routing', () => {
    useStore.getState().beginParticipantSession(
      makeStudyConfig({
        id: 'study-openrouter',
        aiProvider: 'openrouter',
        aiModel: 'openai/gpt-5.6-terra',
      }),
      'participant-handle-openrouter-123456'
    );

    render(<Consent />);

    expect(screen.getByText(/sent to OpenRouter and a ZDR-compatible upstream inference provider/i)).toBeInTheDocument();
    expect(screen.getByText(/retention, access, and deletion details/i)).toBeInTheDocument();
  });

  it('discloses Vercel AI Gateway and the pinned upstream provider', () => {
    useStore.getState().beginParticipantSession(
      makeStudyConfig({ id: 'study-gateway', aiProvider: 'openai', aiModel: 'gpt-5.6-terra' }),
      'participant-handle-gateway-123456',
      'gateway',
    );

    render(<Consent />);

    expect(screen.getByText(/sent through Vercel AI Gateway to OpenAI/i)).toBeInTheDocument();
    expect(screen.getByText(/model fallback is disabled/i)).toBeInTheDocument();
  });

  it.each([
    ['gemini', 'gemini-3.7-flash', 'Google Gemini'],
    ['claude', 'claude-sonnet-5', 'Anthropic Claude'],
    ['openai', 'gpt-5.6-terra', 'OpenAI'],
  ] as const)('RT-11: discloses Cloudflare AI Gateway for %s, with no logging or caching and no EU pinning', (provider, model, label) => {
    useStore.getState().beginParticipantSession(
      makeStudyConfig({ id: `study-cf-${provider}`, aiProvider: provider, aiModel: model }),
      `participant-handle-cf-${provider}-123456`,
      'cloudflare-gateway',
    );

    render(<Consent />);

    const notice = screen.getByText(/through Cloudflare AI Gateway/);
    expect(notice).toHaveTextContent(`Your responses are sent to ${label} through Cloudflare AI Gateway, a relay operated by Cloudflare, which also hosts this study.`);
    expect(notice).toHaveTextContent('configured not to log or cache your responses and does not send them to any other provider');
    expect(notice).toHaveTextContent('Cloudflare may process them outside the EU.');
    expect(notice).not.toHaveTextContent(/Vercel/);
    expect(screen.getByRole('button', { name: /I consent — begin the interview/i })).toBeEnabled();
  });

  it('RT-11: discloses Cloudflare AI Gateway before OpenRouter and its upstream routing', () => {
    useStore.getState().beginParticipantSession(
      makeStudyConfig({ id: 'study-cf-openrouter', aiProvider: 'openrouter', aiModel: 'openai/gpt-5.6-terra' }),
      'participant-handle-cf-openrouter-123456',
      'cloudflare-gateway',
    );

    render(<Consent />);

    const notice = screen.getByText(/through Cloudflare AI Gateway/);
    expect(notice).toHaveTextContent('a relay operated by Cloudflare (which also hosts this study), to OpenRouter and a ZDR-compatible upstream inference provider');
    expect(notice).toHaveTextContent('configured not to log or cache your responses');
    expect(notice).toHaveTextContent('Cloudflare may process them outside the EU.');
  });

  it('D9: records consent for the transport it disclosed', async () => {
    useStore.getState().beginParticipantSession(
      makeStudyConfig({ id: 'study-a' }),
      'participant-handle-a-123456',
      'cloudflare-gateway',
    );
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ acceptedAt: 1_700_000_000_000 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<Consent />);
    fireEvent.click(screen.getByRole('button', { name: /I consent — begin the interview/i }));

    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith('/interview'));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ studyId: 'study-a', disclosedTransport: 'cloudflare-gateway' });
  });

  it.each([null, 'carrier-pigeon'])('fails closed on an unknown transport (%s): no disclosure guess and no consent', (transport) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    useStore.setState({ aiTransport: transport as never });

    render(<Consent />);

    expect(screen.getByText(/could not confirm how your responses are sent/i)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/Your responses are sent/);
    expect(screen.getByRole('alert')).toHaveTextContent('This interview is unavailable until you reopen the study link.');
    const button = screen.getByRole('button', { name: /I consent — begin the interview/i });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('submits the tab session selector and uses the server-issued timestamp', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      acceptedAt: 1_700_000_000_000,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    render(<Consent />);
    fireEvent.click(screen.getByRole('button', { name: /I consent — begin the interview/i }));

    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith('/interview'));
    expect(fetchMock).toHaveBeenCalledWith('/api/consent', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        'Content-Type': 'application/json',
        'X-OpenInterviewer-Participant-Session': 'participant-handle-a-123456',
      }),
      body: JSON.stringify({ studyId: 'study-a', disclosedTransport: 'direct' }),
    }));
    expect(useStore.getState()).toMatchObject({
      consentGiven: true,
      consentTimestamp: 1_700_000_000_000,
      currentStep: 'interview',
    });
  });

  it('keeps consent unavailable while the route change to /interview is still in flight', async () => {
    // router.push resolves nothing here: the navigation is deliberately left pending.
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      acceptedAt: 1_700_000_000_000,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    render(<Consent />);
    fireEvent.click(screen.getByRole('button', { name: /I consent — begin the interview/i }));

    const opening = await screen.findByRole('button', { name: 'Opening the interview…' });
    expect(opening).toBeDisabled();
    expect(opening).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(opening);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(navigation.push).toHaveBeenCalledTimes(1);
  });

  it('does not advance or mark consent when the server cannot persist it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'Consent storage is temporarily unavailable. Please try again.',
      retryable: true,
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })));

    render(<Consent />);
    fireEvent.click(screen.getByRole('button', { name: /I consent — begin the interview/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Consent storage is temporarily unavailable');
    expect(navigation.push).not.toHaveBeenCalled();
    expect(useStore.getState().consentGiven).toBe(false);
    expect(useStore.getState().currentStep).toBe('consent');
    expect(screen.getByRole('button', { name: /I consent — begin the interview/i })).toBeEnabled();
  });
});
