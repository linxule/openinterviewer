import InterviewDetail from '@/components/InterviewDetail';
import { enforceResearcherPageSetup } from '@/lib/researcherAccess';

interface InterviewDetailPageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ studyId?: string }>;
}

export default async function InterviewDetailPage({ params, searchParams }: InterviewDetailPageProps) {
  await enforceResearcherPageSetup();
  const { id } = await params;
  const query = await searchParams;

  return <InterviewDetail interviewId={id} studyId={query.studyId} />;
}
