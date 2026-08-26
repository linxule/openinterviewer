import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Disclosure } from '@/components/ui';

describe('Disclosure', () => {
  it('renders role="note" with title and children text visible', () => {
    render(
      <Disclosure title="AI-generated">This synthesis was drafted by a model.</Disclosure>
    );

    const note = screen.getByRole('note');
    expect(note).toBeInTheDocument();
    expect(note).toHaveTextContent('AI-generated');
    expect(note).toHaveTextContent('This synthesis was drafted by a model.');
  });

  it('renders without a title when none is given', () => {
    render(<Disclosure>Plain notice text.</Disclosure>);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent('Plain notice text.');
  });
});
