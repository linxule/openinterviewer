import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Notice } from '@/components/ui';

describe('Notice', () => {
  it('always carries the shared frame classes', () => {
    const { container } = render(<Notice>Body</Notice>);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toMatch(/border-l-2/);
    expect(root.className).toMatch(/bg-paper-2/);
    expect(root.className).toMatch(/px-4/);
    expect(root.className).toMatch(/py-3/);
  });

  it.each([
    ['neutral', 'border-ink-500'],
    ['error', 'border-error'],
    ['success', 'border-success'],
  ] as const)('renders the %s tone border class', (tone, expectedClass) => {
    const { container } = render(<Notice tone={tone}>Body</Notice>);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toMatch(new RegExp(expectedClass));
  });

  it('renders an eyebrow as a Label-classed element when provided', () => {
    render(<Notice eyebrow="Pending reconciliation">Body</Notice>);
    const eyebrow = screen.getByText('Pending reconciliation');
    expect(eyebrow.className).toMatch(/uppercase/);
    expect(eyebrow.className).toMatch(/tracking-\[0\.08em\]/);
  });

  it('omits the eyebrow element entirely when not provided', () => {
    render(<Notice>Body only</Notice>);
    expect(screen.queryByText('Pending reconciliation')).not.toBeInTheDocument();
  });

  it('renders children as direct children with no injected wrapper element', () => {
    const { container } = render(
      <Notice>
        <p data-testid="body">Direct child</p>
      </Notice>
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.firstElementChild).toBe(screen.getByTestId('body'));
  });

  it('passes role and a caller className through to the root div', () => {
    const { container } = render(
      <Notice role="status" className="mb-6">
        Body
      </Notice>
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveAttribute('role', 'status');
    expect(root.className).toMatch(/mb-6/);
  });
});
