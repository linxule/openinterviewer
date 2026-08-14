import StudyDetail from '@/components/StudyDetail';
import { enforceResearcherPageSetup } from '@/lib/researcherAccess';

interface StudyPageProps {
  params: Promise<{ id: string }>;
}

export default async function StudyPage({ params }: StudyPageProps) {
  await enforceResearcherPageSetup();
  const { id } = await params;
  return <StudyDetail studyId={id} />;
}
