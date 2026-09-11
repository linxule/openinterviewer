import { describe, expect, it } from 'vitest';
import { INTERVIEWER_MANNER_PRESETS, MAX_INTERVIEWER_INSTRUCTIONS_LENGTH } from '@/lib/interviewerManner';
import { BRACKETED_PLACEHOLDER } from '@/lib/thankYouText';

describe('interviewer manner presets', () => {
  it('offers the five named, editable presets in order', () => {
    expect(INTERVIEWER_MANNER_PRESETS.map(preset => preset.label))
      .toEqual(['Neutral', 'Warm', 'Formal', 'Plain language', 'Concrete incidents']);
  });

  it.each(INTERVIEWER_MANNER_PRESETS)('$label is bounded, complete, and non-evaluative', ({ text }) => {
    expect(text.trim().length).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(MAX_INTERVIEWER_INSTRUCTIONS_LENGTH);
    expect(text).not.toMatch(BRACKETED_PLACEHOLDER);
    expect(text).not.toMatch(/\b(great|interesting|for example)\b/i);
  });
});
