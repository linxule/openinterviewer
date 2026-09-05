import { AIBehavior } from '@/types';
import { cn } from '@/lib/cn';
import { Section } from './Section';
import type { StudyDraft } from './useStudyDraft';

const behaviorOptions: { id: AIBehavior; label: string; desc: string }[] = [
  {
    id: 'structured',
    label: 'Focus on covering all questions (Structured)',
    desc: 'Prioritize completion. Minimal follow-ups, redirect tangents.'
  },
  {
    id: 'standard',
    label: 'Balance coverage and depth (Standard)',
    desc: 'Default mode. Follow up on key insights, then move on.'
  },
  {
    id: 'exploratory',
    label: 'Focus on uncovering new insights (Exploratory)',
    desc: 'Prioritize depth. Chase interesting threads, probe emotions.'
  }
];

export interface InterviewStyleSectionProps {
  draft: StudyDraft;
  editing: boolean;
  onEdit: () => void;
}

export function InterviewStyleSection({ draft, editing, onEdit }: InterviewStyleSectionProps) {
  const selectedOption = behaviorOptions.find(option => option.id === draft.aiBehavior);

  return (
    <Section
      id="ai-interview-style"
      label="AI Interview Style"
      editing={editing}
      onEdit={onEdit}
      read={
        selectedOption ? (
          <div>
            <div className="font-sans text-[15px] font-medium text-ink-900">{selectedOption.label}</div>
            <div className="font-sans text-[13px] text-ink-500">{selectedOption.desc}</div>
          </div>
        ) : null
      }
    >
      <div className="space-y-2">
        {behaviorOptions.map((option) => {
          const selected = draft.aiBehavior === option.id;
          return (
            <label
              key={option.id}
              className={cn(
                'flex cursor-pointer items-start gap-3 border-l-2 py-3 pl-4',
                selected ? 'border-l-action bg-paper-2' : 'border-l-transparent hover:bg-paper-2/50'
              )}
            >
              <input
                type="radio"
                name="aiBehavior"
                checked={selected}
                onChange={() => draft.setAiBehavior(option.id)}
                className="mt-1 accent-action"
              />
              <div>
                <div className="font-sans text-[15px] font-medium text-ink-900">{option.label}</div>
                <div className="font-sans text-[13px] text-ink-500">{option.desc}</div>
              </div>
            </label>
          );
        })}
      </div>
    </Section>
  );
}
