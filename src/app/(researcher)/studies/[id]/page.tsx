import { Notice } from '@/components/ui';
import StudyDetail from '@/components/StudyDetail';
import { enforceResearcherPageSetup } from '@/lib/researcherAccess';

interface StudyPageProps {
  searchParams: Promise<{ projectAssignmentFailed?: string }>;
  params: Promise<{ id: string }>;
}

export default async function StudyPage({ params, searchParams }: StudyPageProps) {
  await enforceResearcherPageSetup();
  const { id } = await params;
  const { projectAssignmentFailed } = await searchParams;
  return <>
    {projectAssignmentFailed === '1' && <Notice tone="error" role="status" className="mb-6">
      Study saved, but it was not added to the project. Move it from the study list.
    </Notice>}
    <StudyDetail studyId={id} />
  </>;
}
