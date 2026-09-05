import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ExternalLink, type ExternalLinkProps } from '@/components/ui';

describe('ExternalLink', () => {
  it('opens in a new tab with a safe rel', () => {
    render(<ExternalLink href="https://example.test">Example</ExternalLink>);
    const link = screen.getByRole('link', { name: /^Example/ });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAttribute('href', 'https://example.test');
  });

  it('contains exactly one aria-hidden svg mark', () => {
    render(<ExternalLink href="https://example.test">Example</ExternalLink>);
    const link = screen.getByRole('link', { name: /^Example/ });
    const svgs = link.querySelectorAll('svg');
    expect(svgs).toHaveLength(1);
    expect(svgs[0]).toHaveAttribute('aria-hidden', 'true');
  });

  it('appends "opens in a new tab" to the accessible name', () => {
    render(<ExternalLink href="https://example.test">Example</ExternalLink>);
    const link = screen.getByRole('link');
    expect(link).toHaveAccessibleName(/^Example/);
    expect(link).toHaveAccessibleName(/opens in a new tab/);
  });

  it('merges a caller className rather than replacing the layout classes', () => {
    render(<ExternalLink href="https://example.test" className="text-action underline">Example</ExternalLink>);
    const link = screen.getByRole('link');
    expect(link.className).toMatch(/inline-flex/);
    expect(link.className).toMatch(/items-baseline/);
    expect(link.className).toMatch(/text-action/);
    expect(link.className).toMatch(/underline/);
  });

  it('gives no caller a way to weaken target or rel (type-level guarantee)', () => {
    const props = { href: 'https://example.test', children: 'Example' } as ExternalLinkProps;
    render(<ExternalLink {...props} />);
    const link = screen.getByRole('link', { name: /^Example/ });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });
});
