import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { useStore } from '@/store';
import { makeStudyConfig } from '../fixtures/models';

const serviceMocks = vi.hoisted(() => ({
  synthesizeInterview: vi.fn(),
  saveCompletedInterview: vi.fn(),
}));

vi.mock('@/services/geminiService', () => ({
  synthesizeInterview: serviceMocks.synthesizeInterview,
}));
vi.mock('@/services/storageService', () => ({
  saveCompletedInterview: serviceMocks.saveCompletedInterview,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import Synthesis from '@/components/Synthesis';

const synthesis = {
  statedPreferences: [],
  revealedPreferences: [],
  themes: [],
  contradictions: [],
  keyInsights: [],
  bottomLine: 'A verified result',
  _receipt: 'receipt-a',
};

beforeEach(() => {
  sessionStorage.clear();
  useStore.setState(useStore.getInitialState(), true);
  serviceMocks.synthesizeInterview.mockResolvedValue(synthesis);
  serviceMocks.saveCompletedInterview.mockResolvedValue({ success: true, id: 'interview-a' });
  useStore.setState({
    studyConfig: makeStudyConfig({ id: 'study-a' }),
    interviewHistory: [{ id: 'message-a', role: 'user', content: 'Hello', timestamp: 1 }],
    behaviorData: {
      timePerTopic: {},
      messagesPerTopic: {},
      topicsExplored: [],
      contradictions: [],
    },
    participantProfile: null,
    participantToken: null,
    participantSessionHandle: 'participant-handle-a-123456',
    viewMode: 'participant',
    synthesis: null,
  });
});

describe('Synthesis participant-session propagation', () => {
  it('uses the tab selector for synthesis and persistence', async () => {
    render(<Synthesis />);

    await waitFor(() => expect(serviceMocks.saveCompletedInterview).toHaveBeenCalled());
    expect(serviceMocks.synthesizeInterview).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ id: 'study-a' }),
      expect.any(Object),
      null,
      null,
      false,
      'participant-handle-a-123456'
    );
    expect(serviceMocks.saveCompletedInterview).toHaveBeenCalledWith(
      expect.objectContaining({ studyId: 'study-a', synthesis }),
      null,
      false,
      'participant-handle-a-123456'
    );
  });
});
