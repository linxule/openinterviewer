import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Citation } from '@/components/ui';

describe('Citation', () => {
  it('unfolds in document flow (not a floating overlay), with an accessible name, and closes on Escape', () => {
    render(
      <Citation label="t.4">
        <p>&ldquo;It was confusing at first.&rdquo;</p>
      </Citation>
    );

    const trigger = screen.getByRole('button', { name: 't.4' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region')).not.toBeInTheDocument();

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const region = screen.getByRole('region', { name: 't.4' });
    expect(region).toBeInTheDocument();
    expect(region).toHaveTextContent('It was confusing at first.');
    expect(trigger.getAttribute('aria-controls')).toBe(region.id);
    expect(region.getAttribute('aria-labelledby')).toBe(trigger.id);

    // Footnote grammar, not tooltip grammar: no floating-overlay positioning.
    expect(region.className).not.toMatch(/\babsolute\b/);
    expect(region.className).not.toMatch(/\btop-full\b/);
    expect(region.className).not.toMatch(/\bz-10\b/);
    expect(region.className).toContain('block');

    fireEvent.keyDown(region, { key: 'Escape' });

    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });
});
