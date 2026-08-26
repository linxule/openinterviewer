import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Button } from '@/components/ui';

describe('Button', () => {
  it('renders distinct classes per variant', () => {
    const { rerender } = render(<Button variant="primary">Save</Button>);
    const primaryClass = screen.getByRole('button', { name: 'Save' }).className;
    expect(primaryClass).toContain('bg-action');

    rerender(<Button variant="quiet">Save</Button>);
    const quietClass = screen.getByRole('button', { name: 'Save' }).className;
    expect(quietClass).toContain('border-ink-300');

    rerender(<Button variant="destructive">Save</Button>);
    const destructiveClass = screen.getByRole('button', { name: 'Save' }).className;
    expect(destructiveClass).toContain('bg-error');

    expect(primaryClass).not.toBe(quietClass);
    expect(quietClass).not.toBe(destructiveClass);
  });

  it('defaults to the quiet variant and renders native button semantics', () => {
    render(<Button>Cancel</Button>);
    const button = screen.getByRole('button', { name: 'Cancel' });
    expect(button.tagName).toBe('BUTTON');
    expect(button.className).toContain('border-ink-300');
  });

  it('carries the disabled affordance', () => {
    render(<Button disabled>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toBeDisabled();
    expect(button.className).toContain('disabled:opacity-50');
    expect(button.className).toContain('disabled:cursor-not-allowed');
  });

  it('merges className via cn (later classes win, no duplicates)', () => {
    render(
      <Button variant="primary" className="bg-error px-8">
        Delete
      </Button>
    );
    const button = screen.getByRole('button', { name: 'Delete' });
    expect(button.className).toContain('bg-error');
    expect(button.className.split(/\s+/)).not.toContain('bg-action');
    expect(button.className).toContain('px-8');
    expect(button.className).not.toMatch(/px-4.*px-8|px-8.*px-4/);
  });
});
