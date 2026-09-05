import { Button, Field, Label, Verbatim } from '@/components/ui';
import { defaultThankYouText, THANK_YOU_TEMPLATE } from '@/lib/thankYouText';
import { Section } from './Section';
import type { StudyDraft } from './useStudyDraft';

export interface ThankYouSectionProps {
  draft: StudyDraft;
  editing: boolean;
  onEdit: () => void;
}

/**
 * The setup-side read sheet doubles as the researcher's own preview: a
 * participant's saved state is unreachable from any researcher-facing mode
 * (P12.1 fact 24), so this is the only place a researcher checks their copy —
 * exactly as they already check consent text.
 */
function ThankYouSheet({ draft }: { draft: StudyDraft }) {
  return (
    <div className="bg-paper-2 p-4">
      <Label>What participants will read after they finish</Label>
      <Verbatim className="mt-2 max-w-measure whitespace-pre-wrap text-[17px] leading-[28px] text-ink-700">
        {draft.thankYouText.trim() || defaultThankYouText(draft.name)}
      </Verbatim>
      {draft.researcherContact ? (
        <p className="mt-3 font-sans text-[13px] leading-[20px] text-ink-700">
          Questions or concerns? Contact: <span className="text-ink-900">{draft.researcherContact}</span>
        </p>
      ) : null}
    </div>
  );
}

export function ThankYouSection({ draft, editing, onEdit }: ThankYouSectionProps) {
  return (
    <Section
      id="thank-you-text"
      label="Thank-You Screen"
      editing={editing}
      onEdit={onEdit}
      read={<ThankYouSheet draft={draft} />}
    >
      <Field
        label="Thank-You Screen"
        htmlFor="study-thank-you-text"
        hint="Leave blank to use a default. Square brackets are not allowed — participants read this text exactly as written."
      >
        <textarea
          value={draft.thankYouText}
          onChange={(e) => draft.setThankYouText(e.target.value)}
          rows={4}
          className="w-full resize-none text-[13px]"
        />
      </Field>
      <Button
        type="button"
        variant="quiet"
        onClick={() => draft.setThankYouText(THANK_YOU_TEMPLATE)}
      >
        Insert a template
      </Button>
      <ThankYouSheet draft={draft} />
    </Section>
  );
}
