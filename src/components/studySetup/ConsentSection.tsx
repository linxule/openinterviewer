import { useState } from 'react';
import { Field, Label, Verbatim } from '@/components/ui';
import { defaultConsentText } from '@/lib/consentText';
import { LANGUAGE_ENGLISH_NAMES, LANGUAGE_TAGS, type InterviewLanguage } from '@/lib/i18n/languages';
import { LanguageTabs, selectedLanguage } from './LanguageTabs';
import { Section } from './Section';
import type { StudyDraft } from './useStudyDraft';

export interface ConsentSectionProps {
  draft: StudyDraft;
  editing: boolean;
  onEdit: () => void;
}

function consentDraftText(draft: StudyDraft, language: InterviewLanguage): string {
  return language === draft.interviewLanguages[0] ? draft.consentText : draft.consentTranslations[language] ?? '';
}

function ConsentSheet({ draft, language }: { draft: StudyDraft; language: InterviewLanguage }) {
  return (
    <div className="bg-paper-2 p-4">
      <Label>What participants will read</Label>
      <Verbatim lang={LANGUAGE_TAGS[language]} className="mt-2 max-w-measure whitespace-pre-wrap text-[17px] leading-[28px] text-ink-700">
        {consentDraftText(draft, language).trim() || defaultConsentText(draft.researchQuestion, language)}
      </Verbatim>
    </div>
  );
}

export function ConsentSection({ draft, editing, onEdit }: ConsentSectionProps) {
  const [tab, setTab] = useState<InterviewLanguage | null>(null);
  const language = selectedLanguage(draft.interviewLanguages, tab);
  const isDefault = language === draft.interviewLanguages[0];
  const tabs = <LanguageTabs languages={draft.interviewLanguages} selected={language} onSelect={setTab} label="Consent text language" />;
  return (
    <Section
      id="consent-text"
      label="Consent Text"
      editing={editing}
      onEdit={onEdit}
      read={<div className="space-y-3">{tabs}<ConsentSheet draft={draft} language={language} /></div>}
    >
      {tabs}
      <Field
        label={draft.interviewLanguages.length > 1 ? `Consent Text (${LANGUAGE_ENGLISH_NAMES[language]})` : 'Consent Text'}
        htmlFor={isDefault ? 'study-consent-text' : `study-consent-text-${language}`}
        hint="Leave blank to generate this from your research question when you save. Square brackets are not allowed — participants read this text exactly as written."
      >
        <textarea
          lang={LANGUAGE_TAGS[language]}
          value={consentDraftText(draft, language)}
          onChange={(e) => (isDefault ? draft.setConsentText(e.target.value) : draft.setConsentTranslation(language, e.target.value))}
          rows={4}
          className="w-full resize-none text-[13px]"
        />
      </Field>
      <ConsentSheet draft={draft} language={language} />
    </Section>
  );
}
