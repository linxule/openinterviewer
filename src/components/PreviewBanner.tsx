'use client';

import { useEffect, useRef } from 'react';
import { useStore } from '@/store';
import { useRouter, usePathname } from 'next/navigation';
import { Disclosure } from '@/components/ui';

export default function PreviewBanner() {
  const { viewMode, setViewMode, setStep, resetParticipant } = useStore();
  const router = useRouter();
  const pathname = usePathname();
  const rootRef = useRef<HTMLDivElement>(null);

  // Only show on participant flow pages when in preview mode
  const participantPages = ['/consent', '/interview', '/synthesis', '/export'];
  const isOnParticipantPage = participantPages.some(p => pathname?.startsWith(p));
  const isVisible = viewMode === 'preview' && isOnParticipantPage;

  // Publishes the banner's rendered height as a custom property so the
  // participant running head (InterviewChat.tsx) can offset its own sticky
  // position below it instead of both pinning at top: 0 and colliding.
  useEffect(() => {
    const el = rootRef.current;
    if (!isVisible || !el) {
      document.documentElement.style.removeProperty('--preview-banner-height');
      return;
    }

    const updateHeight = () => {
      document.documentElement.style.setProperty('--preview-banner-height', `${el.offsetHeight}px`);
    };

    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(el);

    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty('--preview-banner-height');
    };
  }, [isVisible]);

  if (!isVisible) {
    return null;
  }

  const handleExit = () => {
    setViewMode('researcher');
    setStep('setup');
    resetParticipant(); // Clear participant data but keep study config
    router.push('/setup');
  };

  // `Disclosure` is a plain function component (not `forwardRef`) and is a
  // frozen ui/ contract this slice must not edit, so the height is measured on
  // a wrapper. The wrapper carries the sticky positioning: a sticky element
  // cannot leave its containing block, so sticking the Disclosure inside a
  // wrapper exactly its own height would stop the banner from pinning at all.
  return (
    <div ref={rootRef} className="sticky top-0 z-50">
      <Disclosure
        title="Preview Mode - Participant View"
        className="flex items-center justify-between gap-3"
      >
        <button
          type="button"
          onClick={handleExit}
          className="min-h-11 shrink-0 font-sans text-[13px] font-medium underline underline-offset-4"
        >
          Exit Preview
        </button>
      </Disclosure>
    </div>
  );
}
