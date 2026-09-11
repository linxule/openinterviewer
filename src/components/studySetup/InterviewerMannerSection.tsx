import { useState } from 'react';
import { Field, Label } from '@/components/ui';
import { cn } from '@/lib/cn';
import { INTERVIEWER_MANNER_PRESETS, MAX_INTERVIEWER_INSTRUCTIONS_LENGTH } from '@/lib/interviewerManner';
import { Section } from './Section';
import type { StudyDraft } from './useStudyDraft';

export interface InterviewerMannerSectionProps {
  draft: StudyDraft;
  editing: boolean;
  onEdit: () => void;
}

function InterviewerMannerSheet({ draft }: { draft: StudyDraft }) {
  const instructions = draft.interviewerInstructions.trim();
  return (
    <div className="bg-paper-2 p-4">
      <Label>Your instructions to the interviewer</Label>
      <p className={cn(
        'mt-2 font-sans text-[15px] leading-[24px] whitespace-pre-wrap max-w-measure',
        instructions ? 'text-ink-700' : 'text-ink-500'
      )}>
        {instructions || 'Default manner: brief, open, non-leading questions, one at a time.'}
      </p>
    </div>
  );
}

export function InterviewerMannerSection({ draft, editing, onEdit }: InterviewerMannerSectionProps) {
  const [undoText, setUndoText] = useState<string | null>(null);
  const presetClassName = 'text-action underline underline-offset-2 text-[13px] min-h-11';
  return (
    <Section
      id="interviewer-manner"
      label="Interviewer Manner"
      description={<>How the interviewer phrases questions and carries itself. By default it asks brief, open, non-leading questions, one at a time. Start from a preset or write your own.</>}
      editing={editing}
      onEdit={onEdit}
      read={<InterviewerMannerSheet draft={draft} />}
    >
      <Label>Start from a preset</Label>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {INTERVIEWER_MANNER_PRESETS.map(({ id, label, text }) => (
          <button
            key={id}
            type="button"
            className={presetClassName}
            aria-label={`Use the ${label} preset`}
            onClick={() => {
              const current = draft.interviewerInstructions;
              if (current.trim() && !INTERVIEWER_MANNER_PRESETS.some(preset => preset.text === current)) {
                setUndoText(current);
              }
              draft.setInterviewerInstructions(text);
            }}
          >
            {label}
          </button>
        ))}
        {undoText !== null && (
          <button type="button" className={presetClassName} onClick={() => {
            draft.setInterviewerInstructions(undoText);
            setUndoText(null);
          }}>Undo</button>
        )}
      </div>
      <Field
        label="Instructions to the interviewer"
        htmlFor="study-interviewer-instructions"
        hint={`Read by the AI, not by participants. Leave blank for the default manner. ${draft.interviewerInstructions.trim().length} of ${MAX_INTERVIEWER_INSTRUCTIONS_LENGTH} characters.`}
      >
        <textarea
          value={draft.interviewerInstructions}
          onChange={(e) => {
            setUndoText(null);
            draft.setInterviewerInstructions(e.target.value);
          }}
          rows={6}
          className="w-full resize-none font-sans text-[13px]"
          maxLength={MAX_INTERVIEWER_INSTRUCTIONS_LENGTH}
        />
      </Field>
      <p className="text-[13px] text-ink-500">Preview runs the saved study — save first, and tune manner before links go out or on a scratch study.</p>
    </Section>
  );
}
