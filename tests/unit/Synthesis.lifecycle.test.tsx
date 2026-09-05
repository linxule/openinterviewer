import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '@/store';
import type { SynthesisResult } from '@/types';
import { makeStudyConfig } from '../fixtures/models';

const services = vi.hoisted(() => ({ synthesizeInterview: vi.fn(), saveCompletedInterview: vi.fn() }));
const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('@/services/interviewApi', () => ({ synthesizeInterview: services.synthesizeInterview }));
vi.mock('@/services/storageService', () => ({ saveCompletedInterview: services.saveCompletedInterview }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

import Synthesis from '@/components/Synthesis';

const result: SynthesisResult = {
  statedPreferences: [], revealedPreferences: [], themes: [], contradictions: [], keyInsights: [],
  bottomLine: 'Session A analysis', _receipt: 'receipt-a',
};
const resultB: SynthesisResult = { ...result, bottomLine: 'Session B analysis', _receipt: 'receipt-b' };

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
  services.synthesizeInterview.mockResolvedValue(result);
  services.saveCompletedInterview.mockResolvedValue({ success: true, id: 'interview-a' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('Synthesis signed submission lifecycle', () => {
  it('saves the same null profile, transcript and behavior sent for synthesis', async () => {
    render(<Synthesis />);
    await screen.findByText('Interview submitted');

    const [history, , behavior, profile] = services.synthesizeInterview.mock.calls[0];
    expect(profile).toBeNull();
    expect(services.saveCompletedInterview).toHaveBeenCalledWith(expect.objectContaining({
      participantProfile: null, transcript: history, behaviorData: behavior, synthesis: result,
      createdAt: 100,
    }), false, 'session-a');
    const [submission] = services.saveCompletedInterview.mock.calls[0];
    expect(submission.transcript).toBe(history);
    expect(submission.behaviorData).toBe(behavior);
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
    await screen.findByText('Interview submitted');
    expect(services.saveCompletedInterview.mock.calls[1][0]).toEqual(firstSubmission);

    page.unmount();
    await useStore.persist.rehydrate();
    render(<Synthesis />);
    await screen.findByText('Interview submitted');
    expect(services.saveCompletedInterview.mock.calls[2][0]).toEqual(firstSubmission);
    expect(services.synthesizeInterview).toHaveBeenCalledTimes(1);
  });

  it('preserves a valid zero profile timestamp instead of replacing it on save', async () => {
    useStore.setState({ participantProfile: { id: 'profile-a', timestamp: 0, fields: [], rawContext: '' } });
    render(<Synthesis />);
    await screen.findByText('Interview submitted');
    expect(services.saveCompletedInterview.mock.calls[0][0]).toMatchObject({
      id: 'profile-a', createdAt: 0, participantProfile: { timestamp: 0 },
    });
  });

  it('does not apply or save a response after unmount and a new session', async () => {
    const pending = deferred<SynthesisResult>();
    services.synthesizeInterview.mockReturnValue(pending.promise);
    const page = render(<Synthesis />);
    expect(services.synthesizeInterview).toHaveBeenCalledTimes(1);

    page.unmount();
    startSession('b');
    await act(async () => { pending.resolve(result); });

    expect(useStore.getState().synthesis).toBeNull();
    expect(useStore.getState().participantSessionHandle).toBe('session-b');
    expect(services.saveCompletedInterview).not.toHaveBeenCalled();
  });

  it('does not apply or save a response after unmount even if the session is unchanged', async () => {
    const pending = deferred<SynthesisResult>();
    services.synthesizeInterview.mockReturnValue(pending.promise);
    const page = render(<Synthesis />);
    page.unmount();
    await act(async () => { pending.resolve(result); });
    expect(useStore.getState().synthesis).toBeNull();
    expect(services.saveCompletedInterview).not.toHaveBeenCalled();
  });

  it.each(['resolves', 'rejects'] as const)('finishes the new session when an earlier analysis %s on the same mount', async (outcome) => {
    const a = deferred<SynthesisResult>();
    const b = deferred<SynthesisResult>();
    services.synthesizeInterview.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    render(<Synthesis />);
    act(() => startSession('b'));
    expect(services.synthesizeInterview).toHaveBeenCalledTimes(2);

    await act(async () => {
      if (outcome === 'resolves') a.resolve(result);
      else a.reject(new Error('Old session failed'));
    });
    expect(useStore.getState().synthesis).toBeNull();
    expect(services.saveCompletedInterview).not.toHaveBeenCalled();

    await act(async () => { b.resolve(resultB); });
    await screen.findByText('Interview submitted');
    expect(useStore.getState().synthesis).toEqual(resultB);
    expect(services.saveCompletedInterview).toHaveBeenCalledTimes(1);
    expect(services.saveCompletedInterview).toHaveBeenCalledWith(expect.objectContaining({
      studyId: 'study-b', synthesis: resultB,
    }), false, 'session-b');
  });

  it.each(['profile', 'behavior', 'transcript', 'study', 'selector', 'viewMode'] as const)(
    'rejects the old response when %s changes without leaving the page', async (field) => {
      const oldResponse = deferred<SynthesisResult>();
      const newResponse = deferred<SynthesisResult>();
      services.synthesizeInterview.mockReturnValueOnce(oldResponse.promise).mockReturnValueOnce(newResponse.promise);
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
      expect(services.synthesizeInterview).toHaveBeenCalledTimes(2);
      await act(async () => { oldResponse.resolve(result); });
      expect(useStore.getState().synthesis).toBeNull();
      expect(services.saveCompletedInterview).not.toHaveBeenCalled();
      await act(async () => { newResponse.resolve(resultB); });
      await waitFor(() => expect(services.saveCompletedInterview).toHaveBeenCalledTimes(1));
      expect(useStore.getState().synthesis).toEqual(resultB);
    }
  );

  it('does not display an old save acknowledgement as a new session submission', async () => {
    const saveA = deferred<{ success: boolean; id: string }>();
    const analysisB = deferred<SynthesisResult>();
    services.saveCompletedInterview.mockReturnValueOnce(saveA.promise);
    services.synthesizeInterview.mockResolvedValueOnce(result).mockReturnValueOnce(analysisB.promise);
    render(<Synthesis />);
    await waitFor(() => expect(services.saveCompletedInterview).toHaveBeenCalledTimes(1));
    act(() => startSession('b'));
    await act(async () => { saveA.resolve({ success: true, id: 'interview-a' }); });
    expect(screen.getByText('Finalizing your interview')).toBeInTheDocument();
    expect(screen.queryByText('Interview submitted')).not.toBeInTheDocument();
    expect(useStore.getState().synthesis).toBeNull();
    await act(async () => { analysisB.resolve(resultB); });
    await screen.findByText('Interview submitted');
  });

  it('re-analyzes changed signed inputs instead of reusing an earlier synthesis receipt', async () => {
    render(<Synthesis />);
    await screen.findByText('Interview submitted');
    services.synthesizeInterview.mockRejectedValueOnce(new Error('Unavailable'));
    act(() => useStore.getState().setBehaviorData({
      ...useStore.getState().behaviorData, topicsExplored: ['Changed after synthesis'],
    }));
    await screen.findByText("We couldn't finalize your interview");
    expect(useStore.getState().synthesis).toBeNull();
    expect(services.saveCompletedInterview).toHaveBeenCalledTimes(1);
  });

  it('finishes StrictMode effect replay with one provider request and one save', async () => {
    const pending = deferred<SynthesisResult>();
    services.synthesizeInterview.mockReturnValue(pending.promise);
    render(<StrictMode><Synthesis /></StrictMode>);
    expect(services.synthesizeInterview).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve(result); });
    await screen.findByText('Interview submitted');
    expect(services.saveCompletedInterview).toHaveBeenCalledTimes(1);
  });

  it('saves an existing synthesis once during StrictMode effect replay', async () => {
    useStore.setState({ synthesis: result });
    render(<StrictMode><Synthesis /></StrictMode>);
    await screen.findByText('Interview submitted');
    expect(services.synthesizeInterview).not.toHaveBeenCalled();
    expect(services.saveCompletedInterview).toHaveBeenCalledTimes(1);
  });

  it('allows manual analysis retry after failure, including a second failure', async () => {
    services.synthesizeInterview
      .mockRejectedValueOnce(new Error('Unavailable'))
      .mockRejectedValueOnce(new Error('Still unavailable'))
      .mockResolvedValueOnce(result);
    render(<StrictMode><Synthesis /></StrictMode>);
    await screen.findByText("We couldn't finalize your interview");
    expect(services.synthesizeInterview).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Retry finalization' }));
    await screen.findByText("We couldn't finalize your interview");
    expect(services.synthesizeInterview).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Retry finalization' }));
    await screen.findByText('Interview submitted');
    expect(services.synthesizeInterview).toHaveBeenCalledTimes(3);
    expect(services.saveCompletedInterview).toHaveBeenCalledTimes(1);
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

  it('does not offer participant export when analysis fails', async () => {
    services.synthesizeInterview.mockRejectedValueOnce(new Error('Unavailable'));
    render(<Synthesis />);
    await screen.findByText("We couldn't finalize your interview");
    expect(screen.queryByRole('button', { name: /export/i })).not.toBeInTheDocument();
    expect(services.saveCompletedInterview).not.toHaveBeenCalled();
  });
});
