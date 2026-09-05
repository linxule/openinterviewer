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

function seedStore(overrides: {
  interviewHistory: InterviewMessage[];
  consentTimestamp?: number | null;
  researcherContact?: string;
  thankYouText?: string;
}) {
  useStore.setState(useStore.getInitialState(), true);
  useStore.setState({
    viewMode: 'participant',
    studyConfig: makeStudyConfig({
      id: 'study-receipt',
      researcherContact: overrides.researcherContact,
      thankYouText: overrides.thankYouText,
    }),
    participantProfile: null,
    interviewHistory: overrides.interviewHistory,
    synthesis: null,
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

    await screen.findByText('Thank you');

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

  it('renders the default thank-you text, with no bracketed placeholder, when the study has none', async () => {
    seedStore({
      interviewHistory: [{ id: 'm-1', role: 'user', content: 'Only message', timestamp: Date.now() }],
      consentTimestamp: 1_700_000_000_000,
    });
    serviceMocks.saveCompletedInterview.mockResolvedValue({ success: true, id: 'interview-1' });

    render(<Synthesis />);

    await screen.findByText('Thank you');
    expect(document.body.textContent).not.toContain('[');
    expect(screen.getByText(/Your responses will be used in the study/)).toBeInTheDocument();
  });

  it('renders the researcher-authored thank-you text verbatim, including line breaks, when the study has one', async () => {
    const thankYouText = 'Line one of thanks.\n\nLine two of thanks.';
    seedStore({
      interviewHistory: [{ id: 'm-1', role: 'user', content: 'Only message', timestamp: Date.now() }],
      consentTimestamp: 1_700_000_000_000,
      thankYouText,
    });
    serviceMocks.saveCompletedInterview.mockResolvedValue({ success: true, id: 'interview-1' });

    render(<Synthesis />);

    await screen.findByText('Thank you');
    expect(screen.getByText((_, node) => node?.textContent === thankYouText)).toBeInTheDocument();
  });

  it('renders the contact sentence exactly once when a researcherContact is present, with no mailto link', async () => {
    seedStore({
      interviewHistory: [{ id: 'm-1', role: 'user', content: 'Only message', timestamp: Date.now() }],
      consentTimestamp: 1_700_000_000_000,
      researcherContact: 'Dr. Amara Osei · research@university.edu',
    });
    serviceMocks.saveCompletedInterview.mockResolvedValue({ success: true, id: 'interview-1' });

    const { container } = render(<Synthesis />);

    await screen.findByText('Thank you');
    expect(screen.getAllByText(/Questions or concerns\? Contact:/)).toHaveLength(1);
    expect(screen.getByText('Dr. Amara Osei · research@university.edu')).toBeInTheDocument();
    expect(container.querySelector('a[href^="mailto:"]')).toBeNull();
    // The <dl> is machine-verifiable facts only — no Researcher contact row.
    expect(screen.queryByText('Researcher contact')).not.toBeInTheDocument();
  });

  it('renders no contact sentence when researcherContact is absent', async () => {
    seedStore({
      interviewHistory: [{ id: 'm-1', role: 'user', content: 'Only message', timestamp: Date.now() }],
      consentTimestamp: 1_700_000_000_000,
    });
    serviceMocks.saveCompletedInterview.mockResolvedValue({ success: true, id: 'interview-1' });

    render(<Synthesis />);

    await screen.findByText('Thank you');
    expect(screen.queryByText(/Questions or concerns\?/)).not.toBeInTheDocument();
  });

  it('omits Elapsed for a one-message transcript, and still shows Turns contributed', async () => {
    seedStore({
      interviewHistory: [{ id: 'm-1', role: 'user', content: 'Only message', timestamp: Date.now() }],
      consentTimestamp: 1_700_000_000_000,
    });
    serviceMocks.saveCompletedInterview.mockResolvedValue({ success: true, id: 'interview-1' });

    render(<Synthesis />);

    await screen.findByText('Thank you');

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

    await screen.findByText('Thank you');

    expect(screen.queryByText('Consent accepted')).not.toBeInTheDocument();
    expect(screen.queryByText(/unknown|not recorded|—/)).not.toBeInTheDocument();
  });

  it('keeps the safe-to-close sentence carrying role="status", as the first line under the heading', async () => {
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
    // Exactly once, per the keep list.
    expect(screen.getAllByText('Your responses have been saved. It is now safe to close this tab.')).toHaveLength(1);
  });

  it('renders no fact block and no thank-you text in the finalizing state', async () => {
    seedStore({
      interviewHistory: [{ id: 'm-1', role: 'user', content: 'Only message', timestamp: Date.now() }],
    });
    serviceMocks.saveCompletedInterview.mockReturnValue(new Promise(() => {}));

    render(<Synthesis />);

    expect(screen.getByText('Finalizing your interview')).toBeInTheDocument();
    expect(document.querySelector('dl')).toBeNull();
    expect(screen.queryByText('Turns contributed')).not.toBeInTheDocument();
    expect(screen.queryByText('Thank you')).not.toBeInTheDocument();
  });

  it('renders no fact block and no thank-you text in the save-failed state', async () => {
    seedStore({
      interviewHistory: [{ id: 'm-1', role: 'user', content: 'Only message', timestamp: Date.now() }],
    });
    serviceMocks.saveCompletedInterview.mockResolvedValue({ success: false, id: '' });

    render(<Synthesis />);

    await screen.findByText("We couldn't save your interview");
    expect(document.querySelector('dl')).toBeNull();
    expect(screen.queryByText('Turns contributed')).not.toBeInTheDocument();
    expect(screen.queryByText('Thank you')).not.toBeInTheDocument();
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

    await screen.findByText('Thank you');

    expect(container.querySelectorAll('svg')).toHaveLength(0);
    expect(container.querySelector('[role="note"]')).toBeNull();
  });
});
