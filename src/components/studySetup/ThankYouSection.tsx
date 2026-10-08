import { useState } from 'react';
import { Button, Field, Label, Verbatim } from '@/components/ui';
import { defaultThankYouText, THANK_YOU_TEMPLATE } from '@/lib/thankYouText';
import { LANGUAGE_ENGLISH_NAMES, LANGUAGE_TAGS, type InterviewLanguage } from '@/lib/i18n/languages';
import { messagesFor } from '@/lib/i18n/messages';
import { LanguageTabs, selectedLanguage } from './LanguageTabs';
import { Section } from './Section';
import type { StudyDraft } from './useStudyDraft';

export interface ThankYouSectionProps {
  draft: StudyDraft;
  editing: boolean;
  onEdit: () => void;
}

function thankYouDraftText(draft: StudyDraft, language: InterviewLanguage): string {
  return language === draft.interviewLanguages[0] ? draft.thankYouText : draft.thankYouTranslations[language] ?? '';
}

/**
 * The setup-side read sheet doubles as the researcher's own preview: a
 * participant's saved state is unreachable from any researcher-facing mode
 * (P12.1 fact 24), so this is the only place a researcher checks their copy —
 * exactly as they already check consent text.
 */
function ThankYouSheet({ draft, language }: { draft: StudyDraft; language: InterviewLanguage }) {
  return (
    <div className="bg-paper-2 p-4">
      <Label>What participants will read after they finish</Label>
      <Verbatim lang={LANGUAGE_TAGS[language]} className="mt-2 max-w-measure whitespace-pre-wrap text-[17px] leading-[28px] text-ink-700">
        {thankYouDraftText(draft, language).trim() || defaultThankYouText(draft.name, language)}
      </Verbatim>
      {draft.researcherContact ? (
        <p lang={LANGUAGE_TAGS[language]} className="mt-3 font-sans text-[13px] leading-[20px] text-ink-700">
          {messagesFor(language).finish.contact} <span className="text-ink-900">{draft.researcherContact}</span>
        </p>
      ) : null}
    </div>
  );
}

export function ThankYouSection({ draft, editing, onEdit }: ThankYouSectionProps) {
  const [tab, setTab] = useState<InterviewLanguage | null>(null);
  const language = selectedLanguage(draft.interviewLanguages, tab);
  const isDefault = language === draft.interviewLanguages[0];
  const setText = (value: string) => (isDefault ? draft.setThankYouText(value) : draft.setThankYouTranslation(language, value));
  const tabs = <LanguageTabs languages={draft.interviewLanguages} selected={language} onSelect={setTab} label="Thank-you screen language" />;
  return (
    <Section
      id="thank-you-text"
      label="Thank-You Screen"
      editing={editing}
      onEdit={onEdit}
      read={<div className="space-y-3">{tabs}<ThankYouSheet draft={draft} language={language} /></div>}
    >
      {tabs}
      <Field
        label={draft.interviewLanguages.length > 1 ? `Thank-You Screen (${LANGUAGE_ENGLISH_NAMES[language]})` : 'Thank-You Screen'}
        htmlFor={isDefault ? 'study-thank-you-text' : `study-thank-you-text-${language}`}
        hint="Leave blank to use a default. Square brackets are not allowed — participants read this text exactly as written."
      >
        <textarea
          lang={LANGUAGE_TAGS[language]}
          value={thankYouDraftText(draft, language)}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          className="w-full resize-none text-[13px]"
        />
      </Field>
      <Button
        type="button"
        variant="quiet"
        onClick={() => setText(THANK_YOU_TEMPLATE)}
      >
        Insert a template
      </Button>
      <ThankYouSheet draft={draft} language={language} />
    </Section>
  );
}
