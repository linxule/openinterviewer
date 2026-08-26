import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  it('names the selected direct provider without exposing credential details', () => {
    render(<Consent />);

    expect(screen.getByText(/Your responses are sent to Google Gemini\./)).toBeInTheDocument();
    expect(screen.getByText(/researcher is the study's data controller/i)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/API key|GEMINI_API_KEY|AIza/i);
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
      body: JSON.stringify({ studyId: 'study-a' }),
    }));
    expect(useStore.getState()).toMatchObject({
      consentGiven: true,
      consentTimestamp: 1_700_000_000_000,
      currentStep: 'interview',
    });
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
  });
});
