import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStudyConfig } from '../fixtures/models';
import { useStore } from '@/store';

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

function seedStore(viewMode: 'participant' | 'preview', synthesisValue: typeof synthesis | null = synthesis) {
  useStore.setState(useStore.getInitialState(), true);
  useStore.setState({
    viewMode,
    studyConfig: makeStudyConfig({ id: 'study-register' }),
    participantProfile: null,
    interviewHistory: [{ id: 'm-1', role: 'user', content: 'My response', timestamp: Date.now() }],
    synthesis: synthesisValue,
    participantSessionHandle: 'session-handle',
  });
}

function assertNoIconsOrLegacyClasses(container: HTMLElement) {
  expect(container.querySelectorAll('svg').length).toBe(0);
  container.querySelectorAll('*').forEach((el) => {
    const className = typeof el.className === 'string' ? el.className : '';
    expect(className).not.toMatch(/stone-/);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Synthesis register — participant states carry no apparatus', () => {
  it('finalizing: h1 heading, no icons, no stone-* classes, no role="note"', () => {
    seedStore('participant');
    serviceMocks.saveCompletedInterview.mockReturnValue(new Promise(() => {}));

    const { container } = render(<Synthesis />);

    expect(screen.getByRole('heading', { level: 1, name: 'Finalizing your interview' })).toBeInTheDocument();
    assertNoIconsOrLegacyClasses(container);
    expect(container.querySelector('[role="note"]')).toBeNull();
  });

  it('saved: h1 heading, no icons, no stone-* classes, no role="note"', async () => {
    seedStore('participant');
    serviceMocks.saveCompletedInterview.mockResolvedValue({ success: true, id: 'interview-1' });

    const { container } = render(<Synthesis />);

    await screen.findByRole('heading', { level: 1, name: 'Thank you' });
    assertNoIconsOrLegacyClasses(container);
    expect(container.querySelector('[role="note"]')).toBeNull();
  });

  it('save-failed: h1 heading, no icons, no stone-* classes, no role="note"', async () => {
    seedStore('participant');
    serviceMocks.saveCompletedInterview.mockResolvedValue({ success: false, id: '' });

    const { container } = render(<Synthesis />);

    await screen.findByRole('heading', { level: 1, name: "We couldn't save your interview" });
    assertNoIconsOrLegacyClasses(container);
    expect(container.querySelector('[role="note"]')).toBeNull();
  });
});

describe('Synthesis register — preview mode supporting passage (F2 guard)', () => {
  it('renders the theme evidence unquoted, wine-free, and footer-free', async () => {
    seedStore('preview');
    serviceMocks.saveCompletedInterview.mockResolvedValue({ success: true, id: '', preview: true });

    const { container } = render(<Synthesis />);

    await screen.findByText(/was not added to the study data/i);

    const passage = screen.getByText('Some evidence');
    expect(passage.className).toMatch(/font-serif/);
    expect(passage.textContent).not.toMatch(/["“]/);

    expect(container.querySelector('[aria-expanded]')).toBeNull();
    expect(container.innerHTML).not.toMatch(/--evidence/);
    expect(screen.queryByText(/^Synthesized by/)).not.toBeInTheDocument();
  });
});
