import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Verbatim } from '@/components/ui';

describe('Verbatim', () => {
  it('renders a <p> with the serif class by default', () => {
    render(<Verbatim>Consent text</Verbatim>);
    const el = screen.getByText('Consent text');
    expect(el.tagName).toBe('P');
    expect(el).toHaveClass('font-serif');
  });

  it('renders the element named by "as"', () => {
    render(<Verbatim as="h1">Study title</Verbatim>);
    const el = screen.getByText('Study title');
    expect(el.tagName).toBe('H1');
    expect(el).toHaveClass('font-serif');
  });

  it('merges the caller className alongside the serif class', () => {
    render(
      <Verbatim as="blockquote" className="text-[17px] leading-[28px]">
        Quoted text
      </Verbatim>
    );
    const el = screen.getByText('Quoted text');
    expect(el.tagName).toBe('BLOCKQUOTE');
    expect(el).toHaveClass('font-serif');
    expect(el).toHaveClass('text-[17px]');
    expect(el).toHaveClass('leading-[28px]');
  });
});
