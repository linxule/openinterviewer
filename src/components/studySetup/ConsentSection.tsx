import { Field, Label, Verbatim } from '@/components/ui';
import { defaultConsentText } from '@/lib/consentText';
import { Section } from './Section';
import type { StudyDraft } from './useStudyDraft';

export interface ConsentSectionProps {
  draft: StudyDraft;
  editing: boolean;
  onEdit: () => void;
}

function ConsentSheet({ draft }: { draft: StudyDraft }) {
  return (
    <div className="bg-paper-2 p-4">
      <Label>What participants will read</Label>
      <Verbatim className="mt-2 max-w-measure whitespace-pre-wrap text-[17px] leading-[28px] text-ink-700">
        {draft.consentText.trim() || defaultConsentText(draft.researchQuestion)}
      </Verbatim>
    </div>
  );
}

export function ConsentSection({ draft, editing, onEdit }: ConsentSectionProps) {
  return (
    <Section
      id="consent-text"
      label="Consent Text"
      editing={editing}
      onEdit={onEdit}
      read={<ConsentSheet draft={draft} />}
    >
      <Field
        label="Consent Text"
        htmlFor="study-consent-text"
        hint="Leave blank to generate this from your research question when you save. Square brackets are not allowed — participants read this text exactly as written."
      >
        <textarea
          value={draft.consentText}
          onChange={(e) => draft.setConsentText(e.target.value)}
          rows={4}
          className="w-full resize-none text-[13px]"
        />
      </Field>
      <ConsentSheet draft={draft} />
    </Section>
  );
}
