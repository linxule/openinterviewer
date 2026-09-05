import { describe, expect, it } from 'vitest';
import { BRACKETED_PLACEHOLDER, defaultThankYouText, THANK_YOU_TEMPLATE } from '@/lib/thankYouText';

describe('thankYouText: defaultThankYouText', () => {
  it('names the study and trims it', () => {
    const text = defaultThankYouText('  My Study  ');
    expect(text).toContain('"My Study"');
  });

  it('contains no bracketed placeholder', () => {
    expect(BRACKETED_PLACEHOLDER.test(defaultThankYouText('A Study'))).toBe(false);
  });

  it('says it is safe to close the tab', () => {
    expect(defaultThankYouText('A Study')).not.toContain('close this tab');
  });
});

describe('thankYouText: THANK_YOU_TEMPLATE', () => {
  it('contains a bracketed placeholder', () => {
    expect(BRACKETED_PLACEHOLDER.test(THANK_YOU_TEMPLATE)).toBe(true);
  });

  it('is never equal to the default', () => {
    expect(THANK_YOU_TEMPLATE).not.toBe(defaultThankYouText('Any Study'));
  });
});
