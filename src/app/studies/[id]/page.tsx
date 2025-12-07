import StudyDetail from '@/components/StudyDetail';

interface StudyPageProps {
  params: Promise<{ id: string }>;
}

export default async function StudyPage({ params }: StudyPageProps) {
  const { id } = await params;
  return <StudyDetail studyId={id} />;
}
