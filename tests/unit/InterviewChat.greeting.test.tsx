import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { makeStudyConfig } from '../fixtures/models';
import { useStore } from '@/store';

/**
 * InterviewChat greeting lifecycle contract (Edy's delayed-greeting path).
 *
 * The greeting promise — success OR rejection — must always settle the
 * "Thinking" state and re-enable the input. While the greeting is in flight
 * the input must be disabled.
 */

const interviewApiMock = vi.hoisted(() => ({
  getInterviewGreeting: vi.fn(),
  generateInterviewResponse: vi.fn(),
}));
const routerMock = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('@/services/interviewApi', () => interviewApiMock);

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
}));

import InterviewChat from '@/components/InterviewChat';

function seedStore() {
  useStore.setState(useStore.getInitialState(), true);
  useStore.setState({
    studyConfig: makeStudyConfig({ id: 'study-g' }),
    participantProfile: null,
    questionProgress: { questionsAsked: [], total: 1, currentPhase: 'background', isComplete: false },
    interviewHistory: [],
    contextEntries: [],
    isAiThinking: false,
  });
}

const input = () => screen.getByPlaceholderText('Take as much space as you need.') as HTMLTextAreaElement;

beforeEach(() => {
  vi.clearAllMocks();
  seedStore();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('InterviewChat greeting lifecycle', () => {
  it('settles thinking and enables the input when the greeting succeeds', async () => {
    interviewApiMock.getInterviewGreeting.mockResolvedValue('Welcome to the study!');
    render(<InterviewChat />);

    expect(await screen.findByText('Welcome to the study!')).toBeInTheDocument();

    await waitFor(() => expect(input()).toBeEnabled());
    expect(useStore.getState().isAiThinking).toBe(false);
  });

  it('gives the response textarea and the send control accessible names', async () => {
    interviewApiMock.getInterviewGreeting.mockResolvedValue('Welcome to the study!');
    render(<InterviewChat />);

    await screen.findByText('Welcome to the study!');
    expect(screen.getByRole('textbox', { name: 'Your response' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  it('settles thinking and enables the input when the greeting rejects', async () => {
    interviewApiMock.getInterviewGreeting.mockRejectedValue(new Error('provider unavailable'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<InterviewChat />);

    await waitFor(() => expect(input()).toBeEnabled());
    expect(useStore.getState().isAiThinking).toBe(false);
    // No half-baked greeting message may be committed
    expect(useStore.getState().interviewHistory).toHaveLength(0);
    consoleError.mockRestore();
  });

  it('keeps the input disabled and shows Thinking while the greeting is pending', async () => {
    let resolveGreeting!: (value: string) => void;
    interviewApiMock.getInterviewGreeting.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveGreeting = resolve;
      })
    );

    render(<InterviewChat />);

    // Delayed greeting (Edy's path): input must be locked and the composing
    // indicator shown
    expect(input()).toBeDisabled();
    expect(screen.getByText('Composing a follow-up…')).toBeInTheDocument();

    await act(async () => {
      resolveGreeting('Greeting arrives late');
    });

    expect(await screen.findByText('Greeting arrives late')).toBeInTheDocument();
    await waitFor(() => expect(input()).toBeEnabled());
    expect(screen.queryByText('Composing a follow-up…')).not.toBeInTheDocument();
  });

  it('renders exactly one greeting message when the effect re-runs', async () => {
    interviewApiMock.getInterviewGreeting.mockResolvedValue('Single greeting');
    render(<InterviewChat />);

    expect(await screen.findByText('Single greeting')).toBeInTheDocument();
    // Effect re-runs when interviewHistory changes; must not double-greet
    expect(interviewApiMock.getInterviewGreeting).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText('Single greeting')).toHaveLength(1);
  });

  it('propagates the tab participant-session selector to greeting and reply requests', async () => {
    useStore.setState({
      viewMode: 'participant',
      participantSessionHandle: 'participant-handle-a-123456',
    });
    interviewApiMock.getInterviewGreeting.mockResolvedValue('Welcome!');
    interviewApiMock.generateInterviewResponse.mockResolvedValue({
      message: 'Tell me more.',
      questionAddressed: null,
      phaseTransition: null,
      profileUpdates: [],
      shouldConclude: false,
    });

    render(<InterviewChat />);
    await screen.findByText('Welcome!');
    expect(interviewApiMock.getInterviewGreeting).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'study-g' }),
      false,
      'participant-handle-a-123456'
    );

    fireEvent.change(input(), { target: { value: 'A participant answer' } });
    fireEvent.keyDown(input(), { key: 'Enter', ctrlKey: true });
    await screen.findByText('Tell me more.');

    expect(interviewApiMock.generateInterviewResponse).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ id: 'study-g' }),
      null,
      expect.any(Object),
      '',
      false,
      'participant-handle-a-123456'
    );
  });

  it('sends a user message and re-enables the input after the reply settles', async () => {
    interviewApiMock.getInterviewGreeting.mockResolvedValue('Welcome!');
    interviewApiMock.generateInterviewResponse.mockResolvedValue({
      message: 'Tell me more about that.',
      questionAddressed: null,
      phaseTransition: null,
      profileUpdates: [],
      shouldConclude: false,
    });

    render(<InterviewChat />);
    await screen.findByText('Welcome!');

    fireEvent.change(input(), { target: { value: 'I work in design.' } });
    fireEvent.keyDown(input(), { key: 'Enter', metaKey: true });

    expect(await screen.findByText('I work in design.')).toBeInTheDocument();
    expect(await screen.findByText('Tell me more about that.')).toBeInTheDocument();
    await waitFor(() => expect(input()).toBeEnabled());
    expect(useStore.getState().isAiThinking).toBe(false);
  });

  it('does not claim participant responses are saved before finalization', () => {
    useStore.setState({
      viewMode: 'participant',
      interviewHistory: [{ id: 'm-1', role: 'user', content: 'My response', timestamp: Date.now() }],
      questionProgress: {
        questionsAsked: [0],
        total: 1,
        currentPhase: 'wrap-up',
        isComplete: true,
      },
    });

    render(<InterviewChat />);

    expect(screen.getByText(/responses have not been saved yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/responses have been saved/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /continue to save interview/i }));

    expect(useStore.getState().currentStep).toBe('synthesis');
    expect(routerMock.push).toHaveBeenCalledWith('/synthesis');
  });

  it('labels researcher preview completion without promising persistence', () => {
    useStore.setState({
      viewMode: 'preview',
      interviewHistory: [{ id: 'm-1', role: 'user', content: 'Preview response', timestamp: Date.now() }],
      questionProgress: {
        questionsAsked: [0],
        total: 1,
        currentPhase: 'wrap-up',
        isComplete: true,
      },
    });

    render(<InterviewChat />);

    expect(screen.getByText('Preview conversation complete')).toBeInTheDocument();
    expect(screen.getByText(/will not be added to study data/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue preview/i })).toBeInTheDocument();
  });
});

describe('InterviewChat composer and transcript', () => {
  it('never sends on Enter alone, sends on Cmd/Ctrl+Enter, and sends via the Send button', async () => {
    interviewApiMock.getInterviewGreeting.mockResolvedValue('Welcome!');
    interviewApiMock.generateInterviewResponse.mockResolvedValue({
      message: 'Reply one.',
      questionAddressed: null,
      phaseTransition: null,
      profileUpdates: [],
      shouldConclude: false,
    });

    render(<InterviewChat />);
    await screen.findByText('Welcome!');

    // Plain Enter inserts a newline; it must never send.
    fireEvent.change(input(), { target: { value: 'First line' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(interviewApiMock.generateInterviewResponse).not.toHaveBeenCalled();
    expect(useStore.getState().interviewHistory).toHaveLength(1); // greeting only

    // Cmd/Ctrl+Enter sends.
    fireEvent.keyDown(input(), { key: 'Enter', ctrlKey: true });
    await screen.findByText('Reply one.');
    expect(interviewApiMock.generateInterviewResponse).toHaveBeenCalledTimes(1);

    // The Send button also sends.
    interviewApiMock.generateInterviewResponse.mockResolvedValueOnce({
      message: 'Reply two.',
      questionAddressed: null,
      phaseTransition: null,
      profileUpdates: [],
      shouldConclude: false,
    });
    fireEvent.change(input(), { target: { value: 'Second message' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Reply two.');
    expect(interviewApiMock.generateInterviewResponse).toHaveBeenCalledTimes(2);
  });

  it('disables the textarea while thinking and disables Send on empty input', async () => {
    interviewApiMock.getInterviewGreeting.mockResolvedValue('Welcome!');
    render(<InterviewChat />);
    await screen.findByText('Welcome!');

    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    fireEvent.change(input(), { target: { value: 'Something' } });
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();

    let resolveReply!: (value: unknown) => void;
    interviewApiMock.generateInterviewResponse.mockReturnValue(
      new Promise((resolve) => {
        resolveReply = resolve;
      })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(input()).toBeDisabled();

    await act(async () => {
      resolveReply({
        message: 'Reply.',
        questionAddressed: null,
        phaseTransition: null,
        profileUpdates: [],
        shouldConclude: false,
      });
    });
    await waitFor(() => expect(input()).toBeEnabled());
  });

  it('renders the transcript as a live log with sr-only speaker prefixes', async () => {
    interviewApiMock.getInterviewGreeting.mockResolvedValue('Welcome!');
    interviewApiMock.generateInterviewResponse.mockResolvedValue({
      message: 'Understood.',
      questionAddressed: null,
      phaseTransition: null,
      profileUpdates: [],
      shouldConclude: false,
    });

    render(<InterviewChat />);
    await screen.findByText('Welcome!');

    const log = screen.getByRole('log');
    expect(log).toHaveAttribute('aria-live', 'polite');

    fireEvent.change(input(), { target: { value: 'My answer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Understood.');

    const srOnlyLabels = Array.from(log.querySelectorAll('.sr-only'));
    expect(srOnlyLabels.some((el) => el.textContent?.trim() === 'You:')).toBe(true);
    expect(srOnlyLabels.some((el) => el.textContent?.trim() === 'Interviewer:')).toBe(true);
  });
});
