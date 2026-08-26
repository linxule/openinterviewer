import Settings from '@/components/Settings';
import { enforceResearcherPageSetup } from '@/lib/researcherAccess';

export default async function SettingsPage() {
  await enforceResearcherPageSetup();
  return <Settings />;
}
