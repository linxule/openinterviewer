'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useStore } from '@/store';
import { useRouter, usePathname } from 'next/navigation';
import { Disclosure } from '@/components/ui';
import NavigationStatus from '@/components/NavigationStatus';

// Mount only after the outgoing page has unmounted. Its async cleanup must
// run before the shared session is cleared, including an in-flight greeting.
function PreviewExit() {
  const router = useRouter();
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const store = useStore.getState();
    store.resetParticipant();
    store.setViewMode('researcher');
    store.setStep('setup');
    router.push('/setup');
  }, [router]);
  return <NavigationStatus>Returning to study setup…</NavigationStatus>;
}

export default function PreviewBanner({ children }: { children?: ReactNode }) {
  const viewMode = useStore((state) => state.viewMode);
  const pathname = usePathname();
  const rootRef = useRef<HTMLDivElement>(null);
  const [exitFrom, setExitFrom] = useState<string | null>(null);
  if (exitFrom !== null && pathname !== exitFrom) setExitFrom(null);
  const isExiting = exitFrom !== null && pathname === exitFrom;

  // Only show on participant flow pages when in preview mode
  const participantPages = ['/consent', '/interview', '/synthesis', '/export'];
  const isOnParticipantPage = participantPages.some(p => pathname?.startsWith(p));
  const isVisible = !isExiting && viewMode === 'preview' && isOnParticipantPage;

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

  if (isExiting) return <PreviewExit />;

  // `Disclosure` is a plain function component (not `forwardRef`) and is a
  // frozen ui/ contract this slice must not edit, so the height is measured on
  // a wrapper. The wrapper carries the sticky positioning: a sticky element
  // cannot leave its containing block, so sticking the Disclosure inside a
  // wrapper exactly its own height would stop the banner from pinning at all.
  return (
    <>
      {isVisible && (
        <div ref={rootRef} className="sticky top-0 z-50">
          <Disclosure
            title="Preview Mode - Participant View"
            className="flex items-center justify-between gap-3"
          >
            <button
              type="button"
              onClick={() => setExitFrom(pathname)}
              className="min-h-11 shrink-0 font-sans text-[13px] font-medium underline underline-offset-4"
            >
              Exit Preview
            </button>
          </Disclosure>
        </div>
      )}
      {children}
    </>
  );
}
