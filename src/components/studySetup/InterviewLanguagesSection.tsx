import { Coordinate } from '@/components/ui';
import { INTERVIEW_LANGUAGES, LANGUAGE_ENGLISH_NAMES, LANGUAGE_NATIVE_NAMES, LANGUAGE_TAGS } from '@/lib/i18n/languages';
import { Section } from './Section';
import type { StudyDraft } from './useStudyDraft';

export interface InterviewLanguagesSectionProps {
  draft: StudyDraft;
  editing: boolean;
  onEdit: () => void;
}

function languageName(language: (typeof INTERVIEW_LANGUAGES)[number]) {
  return language === 'en'
    ? 'English'
    : `${LANGUAGE_ENGLISH_NAMES[language]} · ${LANGUAGE_NATIVE_NAMES[language]}`;
}

export function InterviewLanguagesSection({ draft, editing, onEdit }: InterviewLanguagesSectionProps) {
  const [primary, ...others] = draft.interviewLanguages;
  return (
    <Section
      id="interview-languages"
      label="Interview Languages"
      description="Participants choose one of these languages before consent. The consent page, the interviewer and the participant screens then use it. Analysis is written in English, with quotations kept in the participant's language."
      editing={editing}
      onEdit={onEdit}
      read={
        <p className="font-sans text-[15px] text-ink-900">
          {languageName(primary)} <Coordinate>(default)</Coordinate>
          {others.length > 0 ? <>, {others.map(languageName).join(', ')}</> : null}
        </p>
      }
    >
      <fieldset className="space-y-2">
        <legend className="font-sans text-[13px] font-medium text-ink-900">Offered languages</legend>
        {INTERVIEW_LANGUAGES.map((language) => {
          const offered = draft.interviewLanguages.includes(language);
          const isDefault = primary === language;
          return (
            <div key={language} className="flex flex-wrap items-center gap-3 font-sans text-[15px]">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={offered}
                  disabled={offered && draft.interviewLanguages.length === 1}
                  onChange={() => draft.toggleInterviewLanguage(language)}
                />
                <span lang={LANGUAGE_TAGS[language]}>{languageName(language)}</span>
              </label>
              {offered && (isDefault
                ? <Coordinate>default</Coordinate>
                : (
                  <button
                    type="button"
                    onClick={() => draft.makeDefaultLanguage(language)}
                    className="text-[13px] text-action underline underline-offset-2"
                  >
                    Make default <span className="sr-only">{languageName(language)}</span>
                  </button>
                ))}
            </div>
          );
        })}
      </fieldset>
      <p className="max-w-measure font-sans text-[13px] leading-[20px] text-ink-500">
        Write the consent text and thank-you screen for each language in their sections below. Core
        questions, topics and profile fields can stay in one language: the interviewer asks them in
        the participant&apos;s language. The default language is preselected when a participant&apos;s
        browser matches none of the others.
      </p>
    </Section>
  );
}
