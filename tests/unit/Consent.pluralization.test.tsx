import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useStore } from '@/store';
import { makeStudyConfig } from '../fixtures/models';

const navigation = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => navigation,
}));

import Consent from '@/components/Consent';

beforeEach(() => {
  sessionStorage.clear();
  useStore.setState(useStore.getInitialState(), true);
  navigation.push.mockReset();
});

describe('Consent pluralization', () => {
  it('reads "1 core question" for a one-question study', () => {
    useStore.getState().beginParticipantSession(
      makeStudyConfig({ id: 'study-one-question' }),
      'participant-handle-one-question-123456'
    );
    render(<Consent />);

    expect(screen.getByText(/1 core question about your experiences/)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/1 core questions/);
  });

  it('reads "2 core questions" for a two-question study', () => {
    useStore.getState().beginParticipantSession(
      makeStudyConfig({ id: 'study-two-questions', coreQuestions: ['First?', 'Second?'] }),
      'participant-handle-two-questions-123456'
    );
    render(<Consent />);

    expect(screen.getByText(/2 core questions about your experiences/)).toBeInTheDocument();
  });
});
