import StudyList from '@/components/StudyList';
import { enforceResearcherPageSetup } from '@/lib/researcherAccess';

export default async function StudiesPage() {
  await enforceResearcherPageSetup();
  return <StudyList />;
}
