import Onboarding from '@/components/Onboarding';
import { enforceResearcherPageSetup } from '@/lib/researcherAccess';

export default async function OnboardingPage() {
  await enforceResearcherPageSetup({ onboardingPage: true });
  return <Onboarding />;
}
