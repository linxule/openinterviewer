import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import Landing from '@/components/Landing';

describe('Landing specimen', () => {
  it('leads with the specimen, unfolded, before the tagline', () => {
    const { container } = render(<Landing />);

    const quote = screen.getByText(/forgotten which project it was for/i);
    const heading = screen.getByRole('heading', { level: 1, name: /follow the answer, not just the script/i });

    expect(quote).toBeInTheDocument();
    expect(heading).toBeInTheDocument();
    expect(
      quote.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    const trigger = screen.getByRole('button', { name: 't.4' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Scripted demo · Maya · turn 4')).toBeInTheDocument();

    fireEvent.click(trigger);

    expect(screen.queryByText(/forgotten which project it was for/i)).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    const honestyBand = screen.getByRole('note');
    expect(honestyBand).toHaveTextContent(/fictional participant, fixed branches/i);
    expect(honestyBand).toHaveTextContent(/safe to try immediately/i);

    expect(screen.getByRole('link', { name: /try the scripted demo/i })).toHaveAttribute('href', '/demo');
    expect(screen.getAllByRole('link', { name: /self-host/i }).map((link) => link.getAttribute('href'))).toEqual([
      '/self-host',
      '/self-host',
    ]);
    expect(screen.getByRole('link', { name: /researcher sign in/i })).toHaveAttribute('href', '/login');

    expect(container.querySelectorAll('svg')).toHaveLength(0);
  });
});
