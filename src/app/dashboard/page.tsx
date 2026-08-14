import Dashboard from '@/components/Dashboard';
import { enforceResearcherPageSetup } from '@/lib/researcherAccess';

export default async function DashboardPage() {
  await enforceResearcherPageSetup();
  return <Dashboard />;
}
