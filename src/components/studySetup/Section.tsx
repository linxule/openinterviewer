import type { ReactNode } from 'react';

export interface SectionProps {
  id: string;
  label: string;            // equals the <h2> string and the index entry
  description?: ReactNode;
  editing: boolean;
  onEdit: () => void;
  action?: ReactNode;       // the section's own header control, rendered only when editing
  read: ReactNode;
  children: ReactNode;      // edit-mode body
}

export function Section({ id, label, description, editing, onEdit, action, read, children }: SectionProps) {
  return (
    <section id={id} className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-sans text-[15px] font-semibold text-ink-900">{label}</h2>
        {editing ? action ?? null : (
          <button
            type="button"
            onClick={onEdit}
            className="min-h-11 font-sans text-[13px] font-medium text-action underline underline-offset-2"
          >
            Edit <span className="sr-only">{label}</span>
          </button>
        )}
      </div>
      {description ? (
        <p className="max-w-measure font-sans text-[13px] leading-[20px] text-ink-500">{description}</p>
      ) : null}
      {editing ? children : read}
    </section>
  );
}
