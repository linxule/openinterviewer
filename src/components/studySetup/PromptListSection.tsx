import { Button, Coordinate, Icon } from '@/components/ui';
import { Section } from './Section';
import type { StudyDraft } from './useStudyDraft';

export interface PromptListSectionProps {
  draft: StudyDraft;
  editing: boolean;
  onEdit: () => void;
  kind: 'core-questions' | 'topic-areas';
}

const KIND_CONFIG = {
  'core-questions': {
    label: 'Core Questions',
    description: 'Must-ask questions for your interview',
    addLabel: 'Add Question',
    placeholder: (i: number) => `Question ${i + 1}...`,
    removeLabel: (i: number) => `Remove question ${i + 1}`,
    emptyLabel: 'No questions yet.',
    items: (draft: StudyDraft) => draft.coreQuestions,
    add: (draft: StudyDraft) => draft.addQuestion(),
    update: (draft: StudyDraft, i: number, value: string) => draft.updateQuestion(i, value),
    remove: (draft: StudyDraft, i: number) => draft.removeQuestion(i),
  },
  'topic-areas': {
    label: 'Topic Areas',
    description: 'Themes the AI should probe on (e.g., fears, motivations, trade-offs)',
    addLabel: 'Add Topic',
    placeholder: (i: number) => `Topic area ${i + 1}...`,
    removeLabel: (i: number) => `Remove topic ${i + 1}`,
    emptyLabel: 'No topic areas yet.',
    items: (draft: StudyDraft) => draft.topicAreas,
    add: (draft: StudyDraft) => draft.addTopic(),
    update: (draft: StudyDraft, i: number, value: string) => draft.updateTopic(i, value),
    remove: (draft: StudyDraft, i: number) => draft.removeTopic(i),
  },
} as const;

export function PromptListSection({ draft, editing, onEdit, kind }: PromptListSectionProps) {
  const config = KIND_CONFIG[kind];
  const items = config.items(draft);
  const nonBlankItems = items
    .map((value, index) => ({ value, index }))
    .filter((item) => item.value.trim());

  return (
    <Section
      id={kind}
      label={config.label}
      editing={editing}
      onEdit={onEdit}
      action={
        <Button variant="quiet" onClick={() => config.add(draft)} className="text-[13px]">
          {config.addLabel}
        </Button>
      }
      description={config.description}
      read={
        nonBlankItems.length === 0 ? (
          <p className="text-[13px] text-ink-500">{config.emptyLabel}</p>
        ) : (
          <ol className="space-y-2">
            {nonBlankItems.map(({ value, index }) => (
              <li key={index} className="flex items-start gap-2">
                <Coordinate className="w-6 pt-0.5 text-right">{index + 1}.</Coordinate>
                <span className="max-w-measure font-sans text-[15px] leading-[24px] text-ink-700">
                  {value}
                </span>
              </li>
            ))}
          </ol>
        )
      }
    >
      <div className="space-y-2">
        {items.map((value, i) => (
          <div key={i} className="flex items-start gap-2">
            <Coordinate className="w-6 pt-3 text-right">{i + 1}.</Coordinate>
            <textarea
              value={value}
              onChange={(e) => config.update(draft, i, e.target.value)}
              placeholder={config.placeholder(i)}
              rows={2}
              className="flex-1 resize-none bg-paper-2 border border-ink-300 rounded px-3 py-2 text-ink-900 font-sans"
            />
            {items.length > 1 && (
              <button
                type="button"
                onClick={() => config.remove(draft, i)}
                className="min-h-11 min-w-11 inline-flex items-center justify-center text-ink-500 hover:text-error"
                aria-label={config.removeLabel(i)}
              >
                <Icon name="close" />
              </button>
            )}
          </div>
        ))}
      </div>
    </Section>
  );
}
