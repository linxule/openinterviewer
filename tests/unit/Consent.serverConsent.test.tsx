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
    null,
    'participant-handle-a-123456'
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Consent server recording', () => {
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
    fireEvent.click(screen.getByRole('button', { name: /I Consent - Begin Interview/i }));

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
    fireEvent.click(screen.getByRole('button', { name: /I Consent - Begin Interview/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Consent storage is temporarily unavailable');
    expect(navigation.push).not.toHaveBeenCalled();
    expect(useStore.getState().consentGiven).toBe(false);
    expect(useStore.getState().currentStep).toBe('consent');
  });
});
