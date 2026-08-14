import { Suspense } from 'react';
import StudySetup from '@/components/StudySetup';
import { Loader2 } from 'lucide-react';
import { enforceResearcherPageSetup } from '@/lib/researcherAccess';

function SetupLoading() {
  return (
    <div className="min-h-screen bg-stone-900 flex items-center justify-center">
      <Loader2 size={48} className="animate-spin text-stone-400" />
    </div>
  );
}

export default async function SetupPage() {
  await enforceResearcherPageSetup();
  return (
    <Suspense fallback={<SetupLoading />}>
      <StudySetup />
    </Suspense>
  );
}
