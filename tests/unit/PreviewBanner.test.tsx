import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useStore } from '@/store';

const navigation = vi.hoisted(() => ({
  pathname: '/consent',
  push: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ push: navigation.push }),
}));

import PreviewBanner from '@/components/PreviewBanner';

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
});
