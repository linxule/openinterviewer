'use client';

import { useEffect } from 'react';
import { useStore } from '@/store';
import { LANGUAGE_TAGS, preferredStudyLanguage, studyLanguages, type InterviewLanguage } from './languages';
import { messagesFor, type Messages } from './messages';

function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages?.length ? navigator.languages : navigator.language ? [navigator.language] : [];
}

/**
 * The participant's language and its messages. Before consent it is the
 * participant's pick, else the study language that best matches the browser;
 * after consent it is the language they consented in. Also sets `<html lang>`
 * so assistive technology and fonts use the right language.
 */
export function useParticipantLanguage(): { language: InterviewLanguage; messages: Messages; languages: InterviewLanguage[] } {
  const studyConfig = useStore((state) => state.studyConfig);
  const chosen = useStore((state) => state.participantLanguage);
  const languages = studyConfig ? studyLanguages(studyConfig) : ['en' as InterviewLanguage];
  const language = chosen && languages.includes(chosen)
    ? chosen
    : studyConfig ? preferredStudyLanguage(studyConfig, browserLanguages()) : 'en';
  useEffect(() => {
    document.documentElement.lang = LANGUAGE_TAGS[language];
  }, [language]);
  return { language, messages: messagesFor(language), languages };
}

/** Before a study is loaded: the browser's language when offered at all, else English. */
export function browserMessages(): Messages {
  const primary = browserLanguages().map((tag) => tag.toLowerCase().split('-')[0]);
  for (const tag of primary) {
    const messages = messagesFor(tag as InterviewLanguage);
    if (messages && tag in LANGUAGE_TAGS) return messages;
  }
  return messagesFor('en');
}
