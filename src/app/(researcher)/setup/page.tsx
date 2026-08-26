import { Suspense } from 'react';
import StudySetup from '@/components/StudySetup';
import { enforceResearcherPageSetup } from '@/lib/researcherAccess';

function SetupLoading() {
  return <p className="py-16 font-sans text-[15px] text-ink-500">Loading…</p>;
}

export default async function SetupPage() {
  await enforceResearcherPageSetup();
  return (
    <Suspense fallback={<SetupLoading />}>
      <StudySetup />
    </Suspense>
  );
}
