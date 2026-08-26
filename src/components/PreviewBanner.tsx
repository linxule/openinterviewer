'use client';

import { useStore } from '@/store';
import { useRouter, usePathname } from 'next/navigation';
import { Disclosure } from '@/components/ui';

export default function PreviewBanner() {
  const { viewMode, setViewMode, setStep, resetParticipant } = useStore();
  const router = useRouter();
  const pathname = usePathname();

  // Only show on participant flow pages when in preview mode
  const participantPages = ['/consent', '/interview', '/synthesis', '/export'];
  const isOnParticipantPage = participantPages.some(p => pathname?.startsWith(p));

  if (viewMode !== 'preview' || !isOnParticipantPage) {
    return null;
  }

  const handleExit = () => {
    setViewMode('researcher');
    setStep('setup');
    resetParticipant(); // Clear participant data but keep study config
    router.push('/setup');
  };

  return (
    <Disclosure
      title="Preview Mode - Participant View"
      className="sticky top-0 z-50 flex items-center justify-between gap-3"
    >
      <button
        type="button"
        onClick={handleExit}
        className="min-h-11 shrink-0 font-sans text-[13px] font-medium underline underline-offset-4"
      >
        Exit Preview
      </button>
    </Disclosure>
  );
}
