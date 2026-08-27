import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStudyConfig } from '../fixtures/models';
import { useStore } from '@/store';
import type { SynthesisResult } from '@/types';

const serviceMocks = vi.hoisted(() => ({
  synthesizeInterview: vi.fn(),
  saveCompletedInterview: vi.fn(),
}));

const routerMock = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('@/services/interviewApi', () => ({
  synthesizeInterview: serviceMocks.synthesizeInterview,
}));

vi.mock('@/services/storageService', () => ({
  saveCompletedInterview: serviceMocks.saveCompletedInterview,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
}));

import Synthesis from '@/components/Synthesis';

const synthesisWithRefs: SynthesisResult = {
  statedPreferences: ['A stated preference'],
  revealedPreferences: ['A revealed preference'],
  themes: [
    {
      theme: 'A theme',
      frequency: 1,
      evidenceRefs: [{ quote: 'wanted to understand my options', turnIndex: 1 }],
    },
  ],
  contradictions: [],
  keyInsights: ['An insight'],
  bottomLine: 'A bottom line',
  _receipt: 'test-receipt',
};

const interviewHistoryFixture = [
  { id: 'm-1', role: 'user' as const, content: 'I really wanted to understand my options before deciding.', timestamp: Date.now() },
];

function seedStore(
  viewMode: 'participant' | 'preview',
  synthesisValue: SynthesisResult | null = synthesisWithRefs
) {
  useStore.setState(useStore.getInitialState(), true);
  useStore.setState({
    viewMode,
    studyConfig: makeStudyConfig({ id: 'study-trace' }),
    participantProfile: null,
    interviewHistory: interviewHistoryFixture,
    synthesis: synthesisValue,
    participantSessionHandle: 'session-handle',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Synthesis trace — participant branch gains nothing (A1)', () => {
  const assertNoTrace = (container: HTMLElement) => {
    expect(container.querySelector('[aria-expanded]')).toBeNull();
    expect(screen.queryByRole('region')).toBeNull();
    expect(container.innerHTML).not.toMatch(/\bt\.\d/);
    expect(container.innerHTML).not.toContain('tabular-nums');
    expect(container.innerHTML).not.toContain('--evidence');
  };

  it('finalizing', () => {
    seedStore('participant');
    serviceMocks.saveCompletedInterview.mockReturnValue(new Promise(() => {}));

    const { container } = render(<Synthesis />);

    expect(screen.getByRole('heading', { level: 1, name: 'Finalizing your interview' })).toBeInTheDocument();
    assertNoTrace(container);
  });

  it('saved', async () => {
    seedStore('participant');
    serviceMocks.saveCompletedInterview.mockResolvedValue({ success: true, id: 'interview-1' });

    const { container } = render(<Synthesis />);

    await screen.findByRole('heading', { level: 1, name: 'Interview submitted' });
    assertNoTrace(container);
  });

  it('save-failed', async () => {
    seedStore('participant');
    serviceMocks.saveCompletedInterview.mockResolvedValue({ success: false, id: '' });

    const { container } = render(<Synthesis />);

    await screen.findByRole('heading', { level: 1, name: "We couldn't save your interview" });
    assertNoTrace(container);
  });

  it('analysis-failed', async () => {
    seedStore('participant', null);
    serviceMocks.synthesizeInterview.mockRejectedValue(new Error('synthesis unavailable'));

    const { container } = render(<Synthesis />);

    await screen.findByRole('heading', { level: 1, name: "We couldn't finalize your interview" });
    assertNoTrace(container);
  });
});

describe('Synthesis trace — preview branch renders the citation', () => {
  it('renders the trigger, the quote, and the coordinate, with no footer and no trace control', async () => {
    seedStore('preview');
    serviceMocks.saveCompletedInterview.mockResolvedValue({ success: true, id: '', preview: true });

    render(<Synthesis />);

    await screen.findByText(/was not added to the study data/i);

    const trigger = screen.getByRole('button', { name: 't.1' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    expect(screen.getByText(/wanted to understand my options/)).toBeInTheDocument();
    expect(screen.getByText('Participant · turn 1')).toBeInTheDocument();

    expect(screen.queryByText(/^Synthesized by/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /read in full transcript/i })).not.toBeInTheDocument();
  });
});
