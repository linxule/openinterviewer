import { Button, Coordinate, Icon } from '@/components/ui';
import { cn } from '@/lib/cn';
import { ProfileField } from '@/types';
import { Section } from './Section';
import type { StudyDraft } from './useStudyDraft';

// Common profile field presets
export const PROFILE_PRESETS: ProfileField[] = [
  { id: 'role', label: 'Current Role', extractionHint: 'Their job title or position', required: true },
  { id: 'industry', label: 'Industry', extractionHint: 'The industry they work in', required: false },
  { id: 'experience', label: 'Years of Experience', extractionHint: 'How many years in their field', required: false },
  { id: 'team_size', label: 'Team Size', extractionHint: 'Size of team they work with', required: false },
  { id: 'location', label: 'Location', extractionHint: 'Where they are based (city/region)', required: false }
];

export interface ProfileFieldsSectionProps {
  draft: StudyDraft;
  editing: boolean;
  onEdit: () => void;
}

export function ProfileFieldsSection({ draft, editing, onEdit }: ProfileFieldsSectionProps) {
  const availablePresets = PROFILE_PRESETS.filter(
    preset => !draft.profileSchema.some(f => f.id === preset.id)
  );

  return (
    <Section
      id="profile-fields"
      label="Profile Fields"
      editing={editing}
      onEdit={onEdit}
      action={
        <Button variant="quiet" onClick={() => draft.addProfileField()} className="text-[13px]">
          Add Custom
        </Button>
      }
      description="Information to gather about participants during the interview"
      read={
        draft.profileSchema.length === 0 ? (
          <p className="text-[13px] text-ink-500">No profile fields.</p>
        ) : (
          <div>
            {draft.profileSchema.map((field) => (
              <div key={field.id} className="border-b border-ink-300 py-3">
                <div className="font-sans text-[15px] text-ink-900">{field.label}</div>
                {field.extractionHint ? (
                  <div className="font-sans text-[13px] text-ink-500">{field.extractionHint}</div>
                ) : null}
                <Coordinate
                  className={cn(
                    'mt-1 inline-block rounded border border-ink-300 px-2 py-1',
                    field.required ? 'border-ink-500 text-ink-900' : 'text-ink-500'
                  )}
                >
                  {field.required ? 'REQ' : 'OPT'}
                </Coordinate>
              </div>
            ))}
          </div>
        )
      }
    >
      {availablePresets.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Coordinate>Quick add:</Coordinate>
          {availablePresets.map(preset => (
            <Button
              key={preset.id}
              variant="quiet"
              onClick={() => draft.addProfileField(preset)}
              className="px-3 py-1 text-[13px]"
            >
              + {preset.label}
            </Button>
          ))}
        </div>
      )}

      <div>
        {draft.profileSchema.map((field) => (
          <div key={field.id} className="border-b border-ink-200 py-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
              <div className="flex-1 space-y-2">
                <input
                  type="text"
                  value={field.label}
                  onChange={(e) => draft.updateProfileField(field.id, { label: e.target.value })}
                  placeholder="Field label (e.g., Current Role)"
                  className="w-full bg-paper-2 border border-ink-300 rounded px-3 py-2 text-ink-900 font-sans text-[13px]"
                />
                <input
                  type="text"
                  value={field.extractionHint}
                  onChange={(e) => draft.updateProfileField(field.id, { extractionHint: e.target.value })}
                  placeholder="Hint for AI (e.g., Their job title or position)"
                  className="w-full bg-paper-2 border border-ink-300 rounded px-3 py-2 text-ink-900 font-sans text-[13px]"
                />
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => draft.toggleFieldRequired(field.id)}
                  title={field.required ? 'Required field' : 'Optional field'}
                >
                  <Coordinate
                    className={cn(
                      'rounded border border-ink-300 px-2 py-1',
                      field.required ? 'border-ink-500 text-ink-900' : 'text-ink-500'
                    )}
                  >
                    {field.required ? 'REQ' : 'OPT'}
                  </Coordinate>
                </button>
                <button
                  type="button"
                  onClick={() => draft.removeProfileField(field.id)}
                  className="min-h-11 min-w-11 inline-flex items-center justify-center text-ink-500 hover:text-error"
                  aria-label={`Remove ${field.label || 'profile field'}`}
                >
                  <Icon name="close" />
                </button>
              </div>
            </div>
          </div>
        ))}

        {draft.profileSchema.length === 0 && (
          <p className="py-4 text-[13px] text-ink-500">
            No profile fields yet. Add some above to gather participant information.
          </p>
        )}
      </div>
    </Section>
  );
}
