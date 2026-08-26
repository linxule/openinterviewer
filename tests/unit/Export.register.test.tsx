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
    studyConfig: makeStudyConfig({ id: 'study-register' }),
    interviewHistory: [{ id: 'm-1', role: 'user', content: 'My response', timestamp: Date.now() }],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Export register styling', () => {
  it('carries no legacy classes or icons in preview mode', () => {
    seedStore('preview');
    const { container } = render(<Export />);

    expect(container.querySelectorAll('svg')).toHaveLength(0);
    container.querySelectorAll('[class]').forEach((el) => {
      expect(el.className).not.toMatch(/stone-|rounded-xl|rounded-full/);
    });
  });

  it('carries no ochre note band of its own in preview mode', () => {
    seedStore('preview');
    render(<Export />);

    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('renders the four summary values as a reachable, mono session summary group', () => {
    seedStore('preview');
    const { container } = render(<Export />);

    const group = screen.getByRole('group', { name: 'Session summary' });
    const monoValues = group.querySelectorAll('.font-mono');
    expect(monoValues.length).toBe(4);
  });

  it('flips the copy label to Copied! and copies the seeded study JSON exactly once', async () => {
    seedStore('preview');
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<Export />);
    fireEvent.click(screen.getByRole('button', { name: /copy to clipboard/i }));

    expect(await screen.findByText('Copied!')).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(writeText.mock.calls[0][0]);
    expect(parsed.study.id).toBe('study-register');
  });

  it('carries no icons in participant mode', () => {
    seedStore('participant');
    const { container } = render(<Export />);

    expect(container.querySelectorAll('svg')).toHaveLength(0);
  });
});
