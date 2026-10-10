// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { cn } from '@/lib/cn';

describe('Tailwind 4 class overrides', () => {
  it('lets a caller override a theme color or font without dropping the size', () => {
    expect(cn('text-ink-500', 'text-ink-900')).toBe('text-ink-900');
    expect(cn('text-[15px] text-ink-700', 'text-ink-900')).toBe('text-[15px] text-ink-900');
    expect(cn('font-sans', 'font-serif')).toBe('font-serif');
    expect(cn('bg-paper-1', 'bg-paper-2')).toBe('bg-paper-2');
  });

  it('keeps the Tailwind 4 hidden outline separate from an outline width', () => {
    expect(cn('focus:outline-hidden', 'focus:outline-2')).toBe('focus:outline-hidden focus:outline-2');
  });
});
