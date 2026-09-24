import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useStore } from '@/store';
import { makeStudyConfig } from '../fixtures/models';

const navigation = vi.hoisted(() => ({
  pathname: '/consent',
  push: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ push: navigation.push }),
}));
const api = vi.hoisted(() => ({ getInterviewGreeting: vi.fn(), generateInterviewResponse: vi.fn() }));
vi.mock('@/services/interviewApi', () => api);

import PreviewBanner from '@/components/PreviewBanner';
import InterviewChat from '@/components/InterviewChat';

beforeEach(() => {
  navigation.pathname = '/consent';
  navigation.push.mockReset();
  sessionStorage.clear();
  useStore.setState(useStore.getInitialState(), true);
});

describe('PreviewBanner mode isolation', () => {
  it('does not label a real participant session as preview', () => {
    useStore.setState({ viewMode: 'participant' });

    render(<PreviewBanner />);

    expect(screen.queryByText(/Preview Mode/i)).not.toBeInTheDocument();
  });

  it('renders only for explicit researcher preview mode on participant-flow pages', () => {
    useStore.setState({ viewMode: 'preview' });
    const { rerender } = render(<PreviewBanner />);

    expect(screen.getByText('Preview Mode - Participant View')).toBeInTheDocument();

    navigation.pathname = '/setup';
    rerender(<PreviewBanner />);
    expect(screen.queryByText(/Preview Mode/i)).not.toBeInTheDocument();
  });

  it('exits preview back to researcher setup and clears participant state', () => {
    useStore.setState({
      viewMode: 'preview',
      participantSessionHandle: 'participant-handle-a-123456',
    });
    render(<PreviewBanner />);

    fireEvent.click(screen.getByRole('button', { name: 'Exit Preview' }));

    expect(useStore.getState().viewMode).toBe('researcher');
    expect(useStore.getState().participantSessionHandle).toBeNull();
    expect(navigation.push).toHaveBeenCalledWith('/setup');
  });

  it('unmounts a preview before clearing it and ignores a greeting that arrives during the route change', async () => {
    navigation.pathname = '/interview';
    let answer!: (text: string) => void;
    api.getInterviewGreeting.mockReturnValue(new Promise<string>((resolve) => { answer = resolve; }));
    useStore.setState({ viewMode: 'preview', studyConfig: makeStudyConfig() });
    const view = render(<PreviewBanner><InterviewChat /></PreviewBanner>);
    expect(api.getInterviewGreeting).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Exit Preview' }));
    expect(screen.getByRole('status')).toHaveTextContent('Returning to study setup');
    expect(screen.queryByLabelText('Your response')).not.toBeInTheDocument();
    await act(async () => { answer('A greeting from the abandoned preview'); });
    expect(useStore.getState().interviewHistory).toEqual([]);
    expect(api.getInterviewGreeting).toHaveBeenCalledTimes(1);
    expect(navigation.push).toHaveBeenCalledTimes(1);

    navigation.pathname = '/setup';
    view.rerender(<PreviewBanner><p>Study setup destination</p></PreviewBanner>);
    expect(screen.getByText('Study setup destination')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
