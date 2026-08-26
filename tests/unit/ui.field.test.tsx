import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Field } from '@/components/ui';

describe('Field', () => {
  it('labels the control implicitly (nested in <label>) when htmlFor is omitted', () => {
    render(
      <Field label="Study name">
        <input />
      </Field>
    );
    expect(screen.getByLabelText('Study name')).toBeInTheDocument();
  });

  it('also wires an explicit id when htmlFor is given', () => {
    render(
      <Field label="Study name" htmlFor="study-name">
        <input />
      </Field>
    );
    const input = screen.getByLabelText('Study name');
    expect(input).toHaveAttribute('id', 'study-name');
  });

  it('warns and skips cloning when the child is a Fragment', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(
      <Field label="Study name">
        <>
          <input />
        </>
      </Field>
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
