/**
 * The default consent text a study saves when the researcher leaves the field
 * blank. Generated from the research question at save time so participants
 * never read an unfilled placeholder. The researcher may overwrite it.
 */
export function defaultConsentText(researchQuestion: string): string {
  return [
    'Thank you for participating in this research study. Your responses will be used to answer the following research question:',
    researchQuestion.trim(),
    'You may stop at any time. Do you consent to participate?',
  ].join('\n\n')
}

/**
 * Any square-bracket pair: an unfilled authoring placeholder. Not
 * consent-specific — shared with thankYouText.ts, which is why it lives under
 * this name rather than a consent-scoped one.
 */
export const BRACKETED_PLACEHOLDER = /\[[^\]]*\]/

/** Kept for compatibility: the same pattern, under its original name. */
export const CONSENT_TEXT_PLACEHOLDER = BRACKETED_PLACEHOLDER

export const CONSENT_TEXT_PLACEHOLDER_ERROR =
  'Consent text cannot contain a bracketed placeholder such as [research topic]. Replace it with the words participants should read.'
