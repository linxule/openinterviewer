// Interview languages: the languages a study offers its participants. Pure and
// dependency-free, so the participant pages, the API routes, the prompts and
// the Durable Object completion check share one definition.

import type { StudyConfig } from '@/types';

export const INTERVIEW_LANGUAGES = ['en', 'zh', 'fr', 'ja', 'ko', 'es'] as const;
export type InterviewLanguage = (typeof INTERVIEW_LANGUAGES)[number];

/** The language every study without a language setting uses. */
export const DEFAULT_INTERVIEW_LANGUAGE: InterviewLanguage = 'en';

/** How the language names itself; shown in the participant's picker. */
export const LANGUAGE_NATIVE_NAMES: Record<InterviewLanguage, string> = {
  en: 'English',
  zh: '简体中文',
  fr: 'Français',
  ja: '日本語',
  ko: '한국어',
  es: 'Español',
};

/** English names, for researcher screens and model instructions. */
export const LANGUAGE_ENGLISH_NAMES: Record<InterviewLanguage, string> = {
  en: 'English',
  zh: 'Simplified Chinese (Mandarin)',
  fr: 'French',
  ja: 'Japanese',
  ko: 'Korean',
  es: 'Spanish',
};

/** BCP 47 tags for `<html lang>` and speech recognition. */
export const LANGUAGE_TAGS: Record<InterviewLanguage, string> = {
  en: 'en',
  zh: 'zh-Hans',
  fr: 'fr',
  ja: 'ja',
  ko: 'ko',
  es: 'es',
};

export function isInterviewLanguage(value: unknown): value is InterviewLanguage {
  return typeof value === 'string' && (INTERVIEW_LANGUAGES as readonly string[]).includes(value);
}

type LanguageConfig = Pick<StudyConfig, 'interviewLanguages' | 'consentText' | 'consentTextTranslations' | 'thankYouText' | 'thankYouTextTranslations'>;

/** The study's languages in the researcher's order; the first is the default. */
export function studyLanguages(config: Pick<StudyConfig, 'interviewLanguages'>): InterviewLanguage[] {
  const languages = config.interviewLanguages;
  return languages && languages.length > 0 ? [...languages] : [DEFAULT_INTERVIEW_LANGUAGE];
}

/** True when the study names its languages (and so tells the interviewer which one to use). */
export function hasLanguageSetting(config: Pick<StudyConfig, 'interviewLanguages'>): boolean {
  return Array.isArray(config.interviewLanguages) && config.interviewLanguages.length > 0;
}

/**
 * The language a request may use: the requested one when the study offers it,
 * otherwise the study's first language (a client from before this setting
 * sends none). Callers never trust the result alone: consent verification
 * hashes that language's consent text, so a switch is refused.
 */
export function resolveStudyLanguage(config: Pick<StudyConfig, 'interviewLanguages'>, requested: unknown): InterviewLanguage | null {
  const languages = studyLanguages(config);
  if (requested === undefined || requested === null) return languages[0];
  return isInterviewLanguage(requested) && languages.includes(requested) ? requested : null;
}

/** The consent text shown and hashed for one language. */
export function consentTextFor(config: LanguageConfig, language: InterviewLanguage): string {
  const languages = studyLanguages(config);
  if (language === languages[0]) return config.consentText || '';
  return config.consentTextTranslations?.[language] ?? '';
}

/** The researcher's thank-you text for one language; undefined means the generated default. */
export function thankYouTextFor(config: LanguageConfig, language: InterviewLanguage): string | undefined {
  const languages = studyLanguages(config);
  if (language === languages[0]) return config.thankYouText;
  return config.thankYouTextTranslations?.[language];
}

/**
 * The configuration as one participant experiences it: only their language.
 * The interview prompts read the conducting language from the first entry,
 * so a provider never needs a separate language argument.
 */
export function configForParticipantLanguage(config: StudyConfig, language: InterviewLanguage): StudyConfig {
  if (!hasLanguageSetting(config)) return config;
  return { ...config, interviewLanguages: [language] };
}

/** The best study language for a browser's preferred languages, else the study default. */
export function preferredStudyLanguage(
  config: Pick<StudyConfig, 'interviewLanguages'>,
  browserLanguages: readonly string[],
): InterviewLanguage {
  const languages = studyLanguages(config);
  for (const tag of browserLanguages) {
    const primary = tag.toLowerCase().split('-')[0];
    const match = languages.find((language) => language === primary);
    if (match) return match;
  }
  return languages[0];
}
