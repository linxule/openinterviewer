import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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

function seedStore(overrides: Partial<ReturnType<typeof useStore.getState>> = {}) {
  useStore.setState(useStore.getInitialState(), true);
  useStore.setState({
    studyConfig: makeStudyConfig({ id: 'study-page' }),
    participantProfile: null,
    questionProgress: { questionsAsked: [], total: 1, currentPhase: 'background', isComplete: false },
    interviewHistory: [
      { id: 'm-1', role: 'ai', content: 'Hello, tell me about yourself.', timestamp: 1000 },
      { id: 'm-2', role: 'user', content: 'I am a fixture participant.', timestamp: 2000 },
    ],
    contextEntries: [],
    isAiThinking: false,
    ...overrides,
  });
}

function collectClassNames(container: HTMLElement): string[] {
  const classNames: string[] = [];
  container.querySelectorAll('*').forEach((el) => {
    if (typeof el.className === 'string' && el.className) classNames.push(el.className);
  });
  return classNames;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('InterviewChat page layout (A1: the composer is the last block in the document)', () => {
  it('renders exactly one main landmark, with the log inside it', () => {
    seedStore();
    render(<InterviewChat />);

    const mains = screen.getAllByRole('main');
    expect(mains).toHaveLength(1);

    const log = screen.getByRole('log');
    expect(mains[0].contains(log)).toBe(true);
  });

  it('keeps the composer textarea out of the log, while the sr-only speaker prefixes stay inside it', () => {
    seedStore();
    render(<InterviewChat />);

    const log = screen.getByRole('log');
    const textarea = screen.getByLabelText('Your response');
    expect(log.contains(textarea)).toBe(false);

    const prefixes = Array.from(log.querySelectorAll('.sr-only')).map((el) => el.textContent);
    expect(prefixes.some((text) => text?.includes('Interviewer:'))).toBe(true);
    expect(prefixes.some((text) => text?.includes('You:'))).toBe(true);
  });

  it('gives the composer block sticky/bottom-0, and the completion block neither', () => {
    seedStore();
    const { container, rerender } = render(<InterviewChat />);

    const textarea = screen.getByLabelText('Your response');
    let composerBlock: Element | null = textarea;
    while (composerBlock && !(composerBlock.className.includes('sticky') && composerBlock.className.includes('bottom-0'))) {
      composerBlock = composerBlock.parentElement;
    }
    expect(composerBlock).not.toBeNull();

    seedStore({ questionProgress: { questionsAsked: [], total: 1, currentPhase: 'wrap-up', isComplete: true } });
    rerender(<InterviewChat />);

    const completionHeading = screen.getByRole('heading', { name: /conversation complete/ });
    let completionBlock: Element | null = completionHeading;
    let foundStickyBottom = false;
    while (completionBlock) {
      if (completionBlock.className.includes('sticky') && completionBlock.className.includes('bottom-0')) {
        foundStickyBottom = true;
        break;
      }
      completionBlock = completionBlock.parentElement;
    }
    expect(foundStickyBottom).toBe(false);
    void container;
  });

  it('has no overflow- class on any element from the composer up to document.body', () => {
    seedStore();
    render(<InterviewChat />);

    const textarea = screen.getByLabelText('Your response');
    let el: HTMLElement | null = textarea;
    while (el) {
      expect(el.className).not.toMatch(/overflow-/);
      el = el.parentElement;
    }
  });

  it('gives the completion block no text-center, on the inner column or any ancestor of the heading', () => {
    seedStore({ questionProgress: { questionsAsked: [], total: 1, currentPhase: 'wrap-up', isComplete: true } });
    render(<InterviewChat />);

    const heading = screen.getByRole('heading', { name: /conversation complete/ });
    let el: HTMLElement | null = heading;
    while (el) {
      expect(el.className).not.toMatch(/text-center/);
      el = el.parentElement;
    }
  });

  it('renders no h-dvh or h-screen class token anywhere in the tree (min-h-dvh is a distinct, permitted token)', () => {
    seedStore();
    const { container } = render(<InterviewChat />);

    for (const className of collectClassNames(container)) {
      const tokens = className.split(/\s+/);
      expect(tokens).not.toContain('h-dvh');
      expect(tokens).not.toContain('h-screen');
    }
  });

  it('offsets the running head against the preview-banner-height custom property', () => {
    seedStore();
    render(<InterviewChat />);

    const heading = screen.getByRole('heading', { level: 1 });
    const header = heading.closest('header');
    expect(header).not.toBeNull();
    expect(header!.className).toContain('top-[var(--preview-banner-height,0px)]');
  });
});
