import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStudyConfig } from '../fixtures/models';
import { useStore } from '@/store';
import type { InterviewMessage } from '@/types';

const serviceMocks = vi.hoisted(() => ({
  synthesizeInterview: vi.fn(),
  saveCompletedInterview: vi.fn(),
}));

const routerMock = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('@/services/interviewApi', () => ({
  synthesizeInterview: serviceMocks.synthesizeInterview,
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

function seedStore(overrides: {
  interviewHistory: InterviewMessage[];
  consentTimestamp?: number | null;
  synthesisValue?: typeof synthesis | null;
  researcherContact?: string;
}) {
  useStore.setState(useStore.getInitialState(), true);
  useStore.setState({
    viewMode: 'participant',
    studyConfig: makeStudyConfig({ id: 'study-receipt', researcherContact: overrides.researcherContact }),
    participantProfile: null,
    interviewHistory: overrides.interviewHistory,
    synthesis: 'synthesisValue' in overrides ? overrides.synthesisValue ?? null : synthesis,
    participantSessionHandle: 'session-handle',
    consentTimestamp: overrides.consentTimestamp ?? null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Synthesis receipt — saved state', () => {
  it('renders all three facts when derivable, and nothing else guesses a value', async () => {
    seedStore({
      interviewHistory: [
        { id: 'm-1', role: 'user', content: 'First', timestamp: 1_700_000_000_000 - 252_000 },
        { id: 'm-2', role: 'user', content: 'Second', timestamp: 1_700_000_000_000 },
      ],
      consentTimestamp: 1_700_000_000_000,
    });
    serviceMocks.saveCompletedInterview.mockResolvedValue({ success: true, id: 'interview-1' });

    render(<Synthesis />);

    await screen.findByText('Interview submitted');

    expect(screen.getByText('Turns contributed')).toBeInTheDocument();
    expect(screen.getByText('Elapsed')).toBeInTheDocument();
    expect(screen.getByText('Consent accepted')).toBeInTheDocument();
    expect(screen.getByText('4:12')).toBeInTheDocument();
    expect(screen.getByText('2023-11-14 22:13 UTC')).toBeInTheDocument();

    const dl = document.querySelector('dl');
    expect(dl).not.toBeNull();
    const { getAllByRole } = within(dl as HTMLElement);
    expect(dl!.querySelectorAll('dt')).toHaveLength(3);
    expect(dl!.querySelectorAll('dd')).toHaveLength(3);
    void getAllByRole;
  });

  it('renders a Researcher contact row, not in mono, when the study config carries one (M9.5)', async () => {
    seedStore({
      interviewHistory: [
        { id: 'm-1', role: 'user', content: 'First', timestamp: 1_700_000_000_000 - 252_000 },
        { id: 'm-2', role: 'user', content: 'Second', timestamp: 1_700_000_000_000 },
      ],
      consentTimestamp: 1_700_000_000_000,
      researcherContact: 'Dr. Amara Osei · research@university.edu',
    });
    serviceMocks.saveCompletedInterview.mockResolvedValue({ success: true, id: 'interview-1' });

    render(<Synthesis />);

    await screen.findByText('Interview submitted');

    expect(screen.getByText('Researcher contact')).toBeInTheDocument();
    const value = screen.getByText('Dr. Amara Osei · research@university.edu');
    expect(value.tagName).toBe('SPAN');
    expect(value.className).not.toMatch(/font-mono/);

    const dl = document.querySelector('dl');
    expect(dl!.querySelectorAll('dt')).toHaveLength(4);
    expect(dl!.querySelectorAll('dd')).toHaveLength(4);
  });

  it('omits Elapsed for a one-message transcript, and still shows Turns contributed', async () => {
    seedStore({
      interviewHistory: [{ id: 'm-1', role: 'user', content: 'Only message', timestamp: Date.now() }],
      consentTimestamp: 1_700_000_000_000,
    });
    serviceMocks.saveCompletedInterview.mockResolvedValue({ success: true, id: 'interview-1' });

    render(<Synthesis />);

    await screen.findByText('Interview submitted');

    expect(screen.getByText('Turns contributed')).toBeInTheDocument();
    expect(screen.queryByText('Elapsed')).not.toBeInTheDocument();
  });

  it('omits Consent accepted when consentTimestamp is null, with no placeholder text', async () => {
    seedStore({
      interviewHistory: [
        { id: 'm-1', role: 'user', content: 'First', timestamp: 1000 },
        { id: 'm-2', role: 'user', content: 'Second', timestamp: 5000 },
      ],
      consentTimestamp: null,
    });
    serviceMocks.saveCompletedInterview.mockResolvedValue({ success: true, id: 'interview-1' });

    render(<Synthesis />);

    await screen.findByText('Interview submitted');

    expect(screen.queryByText('Consent accepted')).not.toBeInTheDocument();
    expect(screen.queryByText(/unknown|not recorded|—/)).not.toBeInTheDocument();
  });

  it('keeps the safe-to-close sentence carrying role="status", separate from the fact block', async () => {
    seedStore({
      interviewHistory: [
        { id: 'm-1', role: 'user', content: 'First', timestamp: 1000 },
        { id: 'm-2', role: 'user', content: 'Second', timestamp: 5000 },
      ],
      consentTimestamp: 1_700_000_000_000,
    });
    serviceMocks.saveCompletedInterview.mockResolvedValue({ success: true, id: 'interview-1' });

    render(<Synthesis />);

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Your responses have been saved. It is now safe to close this tab.');
    expect(status.querySelector('dl')).toBeNull();
  });

  it('renders no fact block in finalizing, save-failed, or analysis-failed states', async () => {
    seedStore({
      interviewHistory: [{ id: 'm-1', role: 'user', content: 'Only message', timestamp: Date.now() }],
    });
    serviceMocks.saveCompletedInterview.mockReturnValue(new Promise(() => {}));

    render(<Synthesis />);

    expect(screen.getByText('Finalizing your interview')).toBeInTheDocument();
    expect(document.querySelector('dl')).toBeNull();
    expect(screen.queryByText('Turns contributed')).not.toBeInTheDocument();
  });

  it('renders no fact block in the save-failed state', async () => {
    seedStore({
      interviewHistory: [{ id: 'm-1', role: 'user', content: 'Only message', timestamp: Date.now() }],
    });
    serviceMocks.saveCompletedInterview.mockResolvedValue({ success: false, id: '' });

    render(<Synthesis />);

    await screen.findByText("We couldn't save your interview");
    expect(document.querySelector('dl')).toBeNull();
    expect(screen.queryByText('Turns contributed')).not.toBeInTheDocument();
  });

  it('renders no fact block in the analysis-failed state', async () => {
    seedStore({
      interviewHistory: [{ id: 'm-1', role: 'user', content: 'Only message', timestamp: Date.now() }],
      synthesisValue: null,
    });
    serviceMocks.synthesizeInterview.mockRejectedValue(new Error('synthesis unavailable'));

    render(<Synthesis />);

    await screen.findByText("We couldn't finalize your interview");
    expect(document.querySelector('dl')).toBeNull();
    expect(screen.queryByText('Turns contributed')).not.toBeInTheDocument();
  });

  it('renders no svg and no [role="note"] in the saved state', async () => {
    seedStore({
      interviewHistory: [
        { id: 'm-1', role: 'user', content: 'First', timestamp: 1000 },
        { id: 'm-2', role: 'user', content: 'Second', timestamp: 5000 },
      ],
      consentTimestamp: 1_700_000_000_000,
    });
    serviceMocks.saveCompletedInterview.mockResolvedValue({ success: true, id: 'interview-1' });

    const { container } = render(<Synthesis />);

    await screen.findByText('Interview submitted');

    expect(container.querySelectorAll('svg')).toHaveLength(0);
    expect(container.querySelector('[role="note"]')).toBeNull();
  });
});
