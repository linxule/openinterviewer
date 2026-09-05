import { BRACKETED_PLACEHOLDER } from './consentText';

/**
 * What a participant reads when the researcher wrote nothing: complete prose,
 * interpolated from the study, containing no placeholder — `defaultConsentText`'s
 * rule, for `defaultConsentText`'s reason.
 */
export function defaultThankYouText(studyName: string): string {
  return [
    'Thank you for taking part.',
    `Your responses will be used in the study "${studyName.trim()}".`,
  ].join('\n\n');
}

/**
 * A starting point the researcher presses once and then edits: the only path
 * by which brackets enter a draft, and saving it unedited is refused.
 */
export const THANK_YOU_TEMPLATE = [
  'Thank you for taking part in [study name].',
  '[Say what happens next: when the study closes, whether you will share findings, how long the data is kept.]',
].join('\n\n');

export const THANK_YOU_TEXT_PLACEHOLDER_ERROR =
  'The thank-you screen cannot contain a bracketed placeholder such as [study name]. Replace it with the words participants should read.';

export { BRACKETED_PLACEHOLDER };
