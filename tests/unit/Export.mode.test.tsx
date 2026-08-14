import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStudyConfig } from '../fixtures/models';
import { useStore } from '@/store';

const routerMock = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
}));

import Export from '@/components/Export';

function seedStore(viewMode: 'participant' | 'preview') {
  useStore.setState(useStore.getInitialState(), true);
  useStore.setState({
    viewMode,
    studyConfig: makeStudyConfig({ id: 'study-export' }),
    interviewHistory: [{ id: 'm-1', role: 'user', content: 'My response', timestamp: Date.now() }],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Export view-mode boundaries', () => {
  it('does not expose researcher export or reset controls to participants', () => {
    seedStore('participant');
    render(<Export />);

    expect(screen.getByRole('heading', { name: 'Return to interview completion' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /download json/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new participant/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /return to completion status/i }));

    expect(useStore.getState().currentStep).toBe('synthesis');
    expect(routerMock.replace).toHaveBeenCalledWith('/synthesis');
  });

  it('offers researcher-specific next actions after a preview', () => {
    seedStore('preview');
    render(<Export />);

    expect(screen.getByRole('heading', { name: 'Preview complete' })).toBeInTheDocument();
    expect(screen.getByText(/was not added to study data/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /download json/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /run preview again/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /return to study setup/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new participant/i })).not.toBeInTheDocument();
  });
});
