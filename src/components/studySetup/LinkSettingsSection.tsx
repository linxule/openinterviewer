import { Coordinate, Field } from '@/components/ui';
import { LinkExpirationOption } from '@/types';
import { Section } from './Section';
import type { StudyDraft } from './useStudyDraft';

const EXPIRATION_LABEL: Record<LinkExpirationOption, string> = {
  never: 'Never expire',
  '7days': 'Expire after 7 days',
  '30days': 'Expire after 30 days',
  '90days': 'Expire after 90 days',
};

export interface LinkSettingsSectionProps {
  draft: StudyDraft;
  editing: boolean;
  onEdit: () => void;
}

export function LinkSettingsSection({ draft, editing, onEdit }: LinkSettingsSectionProps) {
  return (
    <Section
      id="link-settings"
      label="Link Settings"
      editing={editing}
      onEdit={onEdit}
      description="Configure when participant links expire. You can also revoke links from the study detail page."
      read={<Coordinate className="block">{EXPIRATION_LABEL[draft.linkExpiration]}</Coordinate>}
    >
      <Field
        label="Link Expiration"
        htmlFor="study-link-expiration"
        hint="Expired links will show an error message when participants try to access them."
      >
        <select
          value={draft.linkExpiration}
          onChange={(e) => draft.setLinkExpiration(e.target.value as LinkExpirationOption)}
          className="w-full"
        >
          <option value="never">Never expire</option>
          <option value="7days">Expire after 7 days</option>
          <option value="30days">Expire after 30 days</option>
          <option value="90days">Expire after 90 days</option>
        </select>
      </Field>
    </Section>
  );
}
