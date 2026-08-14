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

const geminiServiceMock = vi.hoisted(() => ({
  getInterviewGreeting: vi.fn(),
  generateInterviewResponse: vi.fn(),
}));
const routerMock = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('@/services/geminiService', () => geminiServiceMock);

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
    participantToken: null,
  });
}

const input = () => screen.getByPlaceholderText('Type your response...') as HTMLInputElement;

beforeEach(() => {
  vi.clearAllMocks();
  seedStore();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('InterviewChat greeting lifecycle', () => {
  it('settles thinking and enables the input when the greeting succeeds', async () => {
    geminiServiceMock.getInterviewGreeting.mockResolvedValue('Welcome to the study!');
    render(<InterviewChat />);

    expect(await screen.findByText('Welcome to the study!')).toBeInTheDocument();

    await waitFor(() => expect(input()).toBeEnabled());
    expect(useStore.getState().isAiThinking).toBe(false);
  });

  it('gives the response input and icon-only send control accessible names', async () => {
    geminiServiceMock.getInterviewGreeting.mockResolvedValue('Welcome to the study!');
    render(<InterviewChat />);

    await screen.findByText('Welcome to the study!');
    expect(screen.getByRole('textbox', { name: 'Your response' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send response' })).toBeInTheDocument();
  });

  it('settles thinking and enables the input when the greeting rejects', async () => {
    geminiServiceMock.getInterviewGreeting.mockRejectedValue(new Error('provider unavailable'));
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
    geminiServiceMock.getInterviewGreeting.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveGreeting = resolve;
      })
    );

    render(<InterviewChat />);

    // Delayed greeting (Edy's path): input must be locked and Thinking shown
    expect(input()).toBeDisabled();
    expect(screen.getByText('Thinking...')).toBeInTheDocument();

    await act(async () => {
      resolveGreeting('Greeting arrives late');
    });

    expect(await screen.findByText('Greeting arrives late')).toBeInTheDocument();
    await waitFor(() => expect(input()).toBeEnabled());
    expect(screen.queryByText('Thinking...')).not.toBeInTheDocument();
  });

  it('renders exactly one greeting message when the effect re-runs', async () => {
    geminiServiceMock.getInterviewGreeting.mockResolvedValue('Single greeting');
    render(<InterviewChat />);

    expect(await screen.findByText('Single greeting')).toBeInTheDocument();
    // Effect re-runs when interviewHistory changes; must not double-greet
    expect(geminiServiceMock.getInterviewGreeting).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText('Single greeting')).toHaveLength(1);
  });

  it('propagates the tab participant-session selector to greeting and reply requests', async () => {
    useStore.setState({
      viewMode: 'participant',
      participantSessionHandle: 'participant-handle-a-123456',
    });
    geminiServiceMock.getInterviewGreeting.mockResolvedValue('Welcome!');
    geminiServiceMock.generateInterviewResponse.mockResolvedValue({
      message: 'Tell me more.',
      questionAddressed: null,
      phaseTransition: null,
      profileUpdates: [],
      shouldConclude: false,
    });

    render(<InterviewChat />);
    await screen.findByText('Welcome!');
    expect(geminiServiceMock.getInterviewGreeting).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'study-g' }),
      null,
      false,
      'participant-handle-a-123456'
    );

    fireEvent.change(input(), { target: { value: 'A participant answer' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    await screen.findByText('Tell me more.');

    expect(geminiServiceMock.generateInterviewResponse).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ id: 'study-g' }),
      null,
      expect.any(Object),
      '',
      null,
      false,
      'participant-handle-a-123456'
    );
  });

  it('sends a user message and re-enables the input after the reply settles', async () => {
    geminiServiceMock.getInterviewGreeting.mockResolvedValue('Welcome!');
    geminiServiceMock.generateInterviewResponse.mockResolvedValue({
      message: 'Tell me more about that.',
      questionAddressed: null,
      phaseTransition: null,
      profileUpdates: [],
      shouldConclude: false,
    });

    render(<InterviewChat />);
    await screen.findByText('Welcome!');

    fireEvent.change(input(), { target: { value: 'I work in design.' } });
    fireEvent.keyDown(input(), { key: 'Enter' });

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
