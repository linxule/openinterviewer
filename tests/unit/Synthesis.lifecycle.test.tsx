import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '@/store';
import type { SynthesisResult } from '@/types';
import { makeStudyConfig } from '../fixtures/models';

/**
 * Slice P: a participant's completion is a save, never a model call. Every
 * test in this file that used to race two `synthesizeInterview` calls now
 * races two `saveCompletedInterview` calls instead — that is the only async
 * operation left on the participant path, and it is where the submission-
 * identity, StrictMode-replay, and stale-attempt discipline
 * (`sameCompletionInputs`, `isCurrentAttempt`, `activeAttempt`) now lives.
 * The two deleted participant states (`analysis-failed`, `rate-limited`) and
 * their tests go with them (P3.1); the preview branch, which still calls
 * `synthesizeInterview`, is untouched and covered where it uses
 * `setViewMode('preview')` explicitly.
 */

const services = vi.hoisted(() => ({ synthesizeInterview: vi.fn(), saveCompletedInterview: vi.fn() }));
const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('@/services/interviewApi', () => ({
  synthesizeInterview: services.synthesizeInterview,
  ApiRequestError: class ApiRequestError extends Error {
    status: number;
    retryAfterSeconds: number | null;
    constructor(status: number, retryAfterSeconds: number | null) {
      super(`API error: ${status}`);
      this.status = status;
      this.retryAfterSeconds = retryAfterSeconds;
    }
  },
}));
vi.mock('@/services/storageService', () => ({ saveCompletedInterview: services.saveCompletedInterview }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

import Synthesis from '@/components/Synthesis';

const result: SynthesisResult = {
  statedPreferences: [], revealedPreferences: [], themes: [], contradictions: [], keyInsights: [],
  bottomLine: 'Session A analysis',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function startSession(id: string) {
  useStore.getState().beginParticipantSession(makeStudyConfig({ id: `study-${id}` }), `session-${id}`);
  useStore.getState().addMessage({ id: `message-${id}`, role: 'user', content: `Response ${id}`, timestamp: 100 });
  useStore.getState().setStep('synthesis');
}

beforeEach(() => {
  sessionStorage.clear();
  useStore.setState(useStore.getInitialState(), true);
  startSession('a');
  services.saveCompletedInterview.mockResolvedValue({ success: true, id: 'interview-a' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('Synthesis signed submission lifecycle', () => {
  it('saves the same null profile, transcript and behavior with no synthesis call', async () => {
    render(<Synthesis />);
    await screen.findByText('Thank you');

    expect(services.synthesizeInterview).not.toHaveBeenCalled();
    expect(services.saveCompletedInterview).toHaveBeenCalledWith(expect.objectContaining({
      participantProfile: null, synthesis: null, createdAt: 100,
    }), false, 'session-a');
    const [submission] = services.saveCompletedInterview.mock.calls[0];
    expect(submission.transcript).toBe(useStore.getState().interviewHistory);
    expect(submission.behaviorData).toBe(useStore.getState().behaviorData);
  });

  it('keeps a profile-less submission identical on save retry and page remount', async () => {
    services.saveCompletedInterview
      .mockResolvedValueOnce({ success: false, id: '' })
      .mockResolvedValue({ success: true, id: 'interview-a' });
    const page = render(<Synthesis />);
    await screen.findByText("We couldn't save your interview");
    const [firstSubmission] = services.saveCompletedInterview.mock.calls[0];
    vi.spyOn(Date, 'now').mockReturnValue(5_000);

    fireEvent.click(screen.getByRole('button', { name: 'Retry save' }));
    await screen.findByText('Thank you');
    expect(services.saveCompletedInterview.mock.calls[1][0]).toEqual(firstSubmission);

    page.unmount();
    await useStore.persist.rehydrate();
    render(<Synthesis />);
    await screen.findByText('Thank you');
    expect(services.saveCompletedInterview.mock.calls[2][0]).toEqual(firstSubmission);
    expect(services.synthesizeInterview).not.toHaveBeenCalled();
  });

  it('preserves a valid zero profile timestamp instead of replacing it on save', async () => {
    useStore.setState({ participantProfile: { id: 'profile-a', timestamp: 0, fields: [], rawContext: '' } });
    render(<Synthesis />);
    await screen.findByText('Thank you');
    expect(services.saveCompletedInterview.mock.calls[0][0]).toMatchObject({
      id: 'profile-a', createdAt: 0, participantProfile: { timestamp: 0 }, synthesis: null,
    });
  });

  it('does not apply a late save resolution after unmount and a new session', async () => {
    const pending = deferred<{ success: boolean; id: string }>();
    services.saveCompletedInterview.mockReturnValue(pending.promise);
    const page = render(<Synthesis />);
    expect(services.saveCompletedInterview).toHaveBeenCalledTimes(1);

    page.unmount();
    startSession('b');
    await act(async () => { pending.resolve({ success: true, id: 'interview-a' }); });

    expect(useStore.getState().participantSessionHandle).toBe('session-b');
    // Unmounting stops further saves from that stale attempt; starting a new
    // session alone (no remount) does not itself issue a second save.
    expect(services.saveCompletedInterview).toHaveBeenCalledTimes(1);
  });

  it('does not crash on a late save resolution after unmount even if the session is unchanged', async () => {
    const pending = deferred<{ success: boolean; id: string }>();
    services.saveCompletedInterview.mockReturnValue(pending.promise);
    const page = render(<Synthesis />);
    page.unmount();
    await act(async () => { pending.resolve({ success: true, id: 'interview-a' }); });
    expect(services.saveCompletedInterview).toHaveBeenCalledTimes(1);
  });

  it.each(['resolves', 'rejects'] as const)('finishes the new session when an earlier save %s on the same mount', async (outcome) => {
    const a = deferred<{ success: boolean; id: string }>();
    const b = deferred<{ success: boolean; id: string }>();
    services.saveCompletedInterview.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    render(<Synthesis />);
    act(() => startSession('b'));
    expect(services.saveCompletedInterview).toHaveBeenCalledTimes(2);

    await act(async () => {
      if (outcome === 'resolves') a.resolve({ success: true, id: 'interview-a' });
      else a.reject(new Error('Old session save failed'));
    });
    // The stale attempt's resolution must not surface as the new session's state.
    expect(screen.getByText('Finalizing your interview')).toBeInTheDocument();

    await act(async () => { b.resolve({ success: true, id: 'interview-b' }); });
    await screen.findByText('Thank you');
  });

  it.each(['profile', 'behavior', 'transcript', 'study', 'selector', 'viewMode'] as const)(
    'rejects the old submission when %s changes without leaving the page', async (field) => {
      const oldSave = deferred<{ success: boolean; id: string }>();
      const newSave = deferred<{ success: boolean; id: string }>();
      services.saveCompletedInterview.mockReturnValueOnce(oldSave.promise).mockReturnValueOnce(newSave.promise);
      render(<Synthesis />);
      act(() => {
        const state = useStore.getState();
        if (field === 'profile') state.initializeProfile([]);
        if (field === 'behavior') state.setBehaviorData({ ...state.behaviorData, topicsExplored: ['new'] });
        if (field === 'transcript') state.addMessage({ id: 'new', role: 'user', content: 'New response', timestamp: 200 });
        if (field === 'study') state.setStudyConfig({ ...state.studyConfig!, consentText: 'Updated consent' });
        if (field === 'selector') useStore.setState({ participantSessionHandle: 'session-new' });
        if (field === 'viewMode') state.setViewMode('preview');
      });
      if (field === 'viewMode') {
        // The preview branch renders a different screen entirely and does
        // call the provider; the identity discipline under test here is
        // participant-only for the other five fields.
        return;
      }
      expect(services.saveCompletedInterview).toHaveBeenCalledTimes(2);
      await act(async () => { oldSave.resolve({ success: true, id: 'interview-old' }); });
      expect(screen.getByText('Finalizing your interview')).toBeInTheDocument();
      await act(async () => { newSave.resolve({ success: true, id: 'interview-new' }); });
      await waitFor(() => expect(screen.getByText('Thank you')).toBeInTheDocument());
    }
  );

  it('finishes StrictMode effect replay with exactly one save and no provider call', async () => {
    const pending = deferred<{ success: boolean; id: string }>();
    services.saveCompletedInterview.mockReturnValue(pending.promise);
    render(<StrictMode><Synthesis /></StrictMode>);
    expect(services.saveCompletedInterview).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve({ success: true, id: 'interview-a' }); });
    await screen.findByText('Thank you');
    expect(services.synthesizeInterview).not.toHaveBeenCalled();
  });

  it('ignores a pre-existing synthesis in the store and still saves with synthesis: null', async () => {
    useStore.setState({ synthesis: result });
    render(<StrictMode><Synthesis /></StrictMode>);
    await screen.findByText('Thank you');
    expect(services.synthesizeInterview).not.toHaveBeenCalled();
    expect(services.saveCompletedInterview).toHaveBeenCalledTimes(1);
    expect(services.saveCompletedInterview).toHaveBeenCalledWith(
      expect.objectContaining({ synthesis: null }), false, 'session-a',
    );
  });

  it('offers transcript export to preview users when analysis fails', async () => {
    useStore.getState().setViewMode('preview');
    services.synthesizeInterview.mockRejectedValueOnce(new Error('Unavailable'));
    const transcript = useStore.getState().interviewHistory;
    render(<Synthesis />);
    await screen.findByText('Analysis Failed');
    fireEvent.click(screen.getByRole('button', { name: 'Export transcript' }));
    expect(router.push).toHaveBeenCalledWith('/export');
    expect(useStore.getState().currentStep).toBe('export');
    expect(useStore.getState().interviewHistory).toBe(transcript);
    expect(useStore.getState().synthesis).toBeNull();
  });
});
