import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { makeStudyConfig } from '../fixtures/models';
import { useStore } from '@/store';

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
    studyConfig: makeStudyConfig({ id: 'study-scroll' }),
    participantProfile: null,
    questionProgress: { questionsAsked: [], total: 1, currentPhase: 'background', isComplete: false },
    interviewHistory: [
      { id: 'm-1', role: 'ai', content: 'Hello.', timestamp: 1000 },
    ],
    contextEntries: [],
    isAiThinking: false,
  });
}

function stubScrollGeometry(remaining: number) {
  Object.defineProperty(document.documentElement, 'scrollHeight', {
    configurable: true,
    value: 800 + remaining,
  });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
}

beforeEach(() => {
  vi.clearAllMocks();
  interviewApiMock.generateInterviewResponse.mockResolvedValue({
    message: 'Follow-up question.',
    profileUpdates: [],
    phaseTransition: null,
    questionAddressed: null,
    shouldConclude: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('InterviewChat auto-scroll: stay pinned, never yank', () => {
  it('scrolls to the end sentinel when a new turn arrives at the live edge', async () => {
    seedStore();
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;

    render(<InterviewChat />);
    const initialCalls = scrollSpy.mock.calls.length;

    const textarea = screen.getByLabelText('Your response') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'My answer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await screen.findByText('Follow-up question.');

    expect(scrollSpy.mock.calls.length).toBeGreaterThan(initialCalls);
  });

  it('does not auto-scroll again when the participant has scrolled away from the bottom', async () => {
    seedStore();
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;

    render(<InterviewChat />);

    stubScrollGeometry(4000);
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });

    const callsAfterScrollAway = scrollSpy.mock.calls.length;

    // A new turn arrives (interviewHistory changes) while the participant is
    // scrolled away, reading higher up.
    act(() => {
      useStore.getState().addMessage({
        id: 'm-arrival',
        role: 'ai',
        content: 'Arrived while scrolled away.',
        timestamp: 9999,
      });
    });

    expect(scrollSpy.mock.calls.length).toBe(callsAfterScrollAway);

    // Sending re-pins: clicking Send calls scrollIntoView again.
    const textarea = screen.getByLabelText('Your response') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Back to the bottom' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await screen.findByText('Follow-up question.');
    expect(scrollSpy.mock.calls.length).toBeGreaterThan(callsAfterScrollAway);
  });

  it('honours prefers-reduced-motion with behavior: auto, and smooth otherwise', async () => {
    seedStore();
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;

    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: query === '(prefers-reduced-motion: reduce)',
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });

    try {
      render(<InterviewChat />);

      const textarea = screen.getByLabelText('Your response') as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: 'My answer' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));

      await screen.findByText('Follow-up question.');

      const lastCall = scrollSpy.mock.calls[scrollSpy.mock.calls.length - 1];
      expect(lastCall[0]).toMatchObject({ behavior: 'auto' });
    } finally {
      Object.defineProperty(window, 'matchMedia', { writable: true, configurable: true, value: originalMatchMedia });
    }
  });

  it('uses smooth behavior with the default matchMedia stub', async () => {
    seedStore();
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;

    render(<InterviewChat />);

    const textarea = screen.getByLabelText('Your response') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'My answer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await screen.findByText('Follow-up question.');

    const lastCall = scrollSpy.mock.calls[scrollSpy.mock.calls.length - 1];
    expect(lastCall[0]).toMatchObject({ behavior: 'smooth' });
  });

  it('removes the scroll listener on unmount', () => {
    seedStore();
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    const { unmount } = render(<InterviewChat />);
    unmount();

    expect(removeSpy).toHaveBeenCalledWith('scroll', expect.any(Function));
  });
});
