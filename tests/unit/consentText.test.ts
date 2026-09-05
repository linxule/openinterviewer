import { describe, expect, it } from 'vitest';
import { CONSENT_TEXT_PLACEHOLDER, defaultConsentText } from '@/lib/consentText';

describe('defaultConsentText', () => {
  it('contains no square brackets', () => {
    const text = defaultConsentText('How do people resume research?');
    expect(text).not.toContain('[');
    expect(text).not.toContain(']');
  });

  it('embeds the trimmed research question on its own paragraph', () => {
    const text = defaultConsentText('  How do people resume research?  ');
    expect(text.split('\n\n')).toContain('How do people resume research?');
  });

  it('keeps the two closing sentences verbatim', () => {
    const text = defaultConsentText('How do people resume research?');
    expect(text).toContain(
      'Thank you for participating in this research study. Your responses will be used to answer the following research question:'
    );
    expect(text).toContain('You may stop at any time. Do you consent to participate?');
  });
});

describe('CONSENT_TEXT_PLACEHOLDER', () => {
  it('matches a bracketed placeholder', () => {
    expect(CONSENT_TEXT_PLACEHOLDER.test('Understand [research topic] better.')).toBe(true);
  });

  it('does not match generated consent text', () => {
    const text = defaultConsentText('How do people resume research?');
    expect(CONSENT_TEXT_PLACEHOLDER.test(text)).toBe(false);
  });
});
