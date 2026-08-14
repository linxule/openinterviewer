import InterviewDetail from '@/components/InterviewDetail';
import { enforceResearcherPageSetup } from '@/lib/researcherAccess';

interface InterviewDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function InterviewDetailPage({ params }: InterviewDetailPageProps) {
  await enforceResearcherPageSetup();
  const { id } = await params;

  return <InterviewDetail interviewId={id} />;
}
