import { Coordinate, Field } from '@/components/ui';
import { Section } from './Section';
import type { StudyDraft } from './useStudyDraft';

export interface StudyDetailsSectionProps {
  draft: StudyDraft;
  editing: boolean;
  onEdit: () => void;
}

export function StudyDetailsSection({ draft, editing, onEdit }: StudyDetailsSectionProps) {
  return (
    <Section
      id="study-details"
      label="Study Details"
      editing={editing}
      onEdit={onEdit}
      read={
        <div className="space-y-2">
          <div className="font-sans text-[15px] font-medium text-ink-900">{draft.name}</div>
          <p className="max-w-measure font-sans text-[15px] leading-[24px] text-ink-700">
            {draft.researchQuestion}
          </p>
          {draft.description ? (
            <p className="max-w-measure font-sans text-[13px] leading-[20px] text-ink-500">
              {draft.description}
            </p>
          ) : null}
          {draft.researcherContact ? (
            <Coordinate className="block">{draft.researcherContact}</Coordinate>
          ) : null}
        </div>
      }
    >
      <Field label="Study Name *" htmlFor="study-name">
        <input
          type="text"
          value={draft.name}
          onChange={(e) => draft.setName(e.target.value)}
          placeholder="e.g., AI Adoption in Healthcare"
          className="w-full"
        />
      </Field>

      <Field label="Research Question *" htmlFor="study-research-question">
        <textarea
          value={draft.researchQuestion}
          onChange={(e) => draft.setResearchQuestion(e.target.value)}
          placeholder="What are you trying to understand?"
          rows={2}
          className="w-full resize-none"
        />
      </Field>

      <Field label="Description (optional)" htmlFor="study-description">
        <textarea
          value={draft.description}
          onChange={(e) => draft.setDescription(e.target.value)}
          placeholder="Brief context about the study..."
          rows={2}
          className="w-full resize-none"
        />
      </Field>

      <Field
        label="Researcher Contact (optional)"
        htmlFor="study-researcher-contact"
        hint="Shown to participants on their submission receipt — how to reach you about retention, access, or deletion."
      >
        <input
          type="text"
          value={draft.researcherContact}
          onChange={(e) => draft.setResearcherContact(e.target.value)}
          placeholder="e.g., Dr. Amara Osei · research@university.edu"
          maxLength={200}
          className="w-full"
        />
      </Field>
    </Section>
  );
}
