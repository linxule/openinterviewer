// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { cn } from '@/lib/cn';

describe('Tailwind 3 class overrides', () => {
  it('lets callers restore a focus outline after a base outline-none class', () => {
    expect(cn('focus:outline-none', { 'focus:outline': true })).toBe('focus:outline');
    expect(cn('focus:outline', 'focus:outline-none')).toBe('focus:outline-none');
  });
});
