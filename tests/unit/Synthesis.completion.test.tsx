import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStudyConfig } from '../fixtures/models';
import { useStore } from '@/store';

const serviceMocks = vi.hoisted(() => ({
  synthesizeInterview: vi.fn(),
  saveCompletedInterview: vi.fn(),
}));

const routerMock = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('@/services/geminiService', () => ({
  synthesizeInterview: serviceMocks.synthesizeInterview,
}));

vi.mock('@/services/storageService', () => ({
  saveCompletedInterview: serviceMocks.saveCompletedInterview,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
}));

import Synthesis from '@/components/Synthesis';

const synthesis = {
  statedPreferences: ['A stated preference'],
  revealedPreferences: ['A revealed preference'],
  themes: [{ theme: 'A theme', evidence: 'Some evidence', frequency: 1 }],
  contradictions: [],
  keyInsights: ['An insight'],
  bottomLine: 'A bottom line',
  _receipt: 'test-receipt',
};

function seedStore(viewMode: 'participant' | 'preview') {
  useStore.setState(useStore.getInitialState(), true);
  useStore.setState({
    viewMode,
    studyConfig: makeStudyConfig({ id: 'study-synthesis' }),
    participantProfile: null,
    interviewHistory: [{ id: 'm-1', role: 'user', content: 'My response', timestamp: Date.now() }],
    synthesis,
    participantToken: viewMode === 'participant' ? 'participant-token' : null,
    participantSessionHandle: 'session-handle',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Synthesis completion states', () => {
  it('shows participants a safe-to-close confirmation only after save succeeds', async () => {
    seedStore('participant');
    serviceMocks.saveCompletedInterview.mockResolvedValue({ success: true, id: 'interview-1' });

    render(<Synthesis />);

    expect(screen.getByText('Finalizing your interview')).toBeInTheDocument();
    expect(await screen.findByText('Interview submitted')).toBeInTheDocument();
    expect(screen.getByText(/it is now safe to close this tab/i)).toBeInTheDocument();
    expect(screen.queryByText('A bottom line')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /export/i })).not.toBeInTheDocument();
    expect(serviceMocks.saveCompletedInterview).toHaveBeenCalledTimes(1);
  });

  it('keeps participant data in place and offers retry when save fails', async () => {
    seedStore('participant');
    serviceMocks.saveCompletedInterview
      .mockResolvedValueOnce({ success: false, id: '' })
      .mockResolvedValueOnce({ success: true, id: 'interview-1' });

    render(<Synthesis />);

    expect(await screen.findByText("We couldn't save your interview")).toBeInTheDocument();
    expect(screen.getByText(/keep it open and retry/i)).toBeInTheDocument();
    expect(screen.queryByText(/safe to close/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /retry save/i }));

    expect(await screen.findByText('Interview submitted')).toBeInTheDocument();
    await waitFor(() => expect(serviceMocks.saveCompletedInterview).toHaveBeenCalledTimes(2));
  });

  it('keeps researcher preview analysis and export controls distinct', async () => {
    seedStore('preview');
    serviceMocks.saveCompletedInterview.mockResolvedValue({ success: true, id: '', preview: true });

    render(<Synthesis />);

    expect(screen.getByRole('heading', { name: 'Researcher preview analysis' })).toBeInTheDocument();
    expect(await screen.findByText(/was not added to the study data/i)).toBeInTheDocument();
    expect(screen.getByText('A bottom line')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /export preview data/i })).toBeInTheDocument();
    expect(screen.queryByText(/safe to close/i)).not.toBeInTheDocument();
  });
});
