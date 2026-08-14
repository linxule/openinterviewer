'use client';

import { useStore } from '@/store';
import { useRouter, usePathname } from 'next/navigation';
import { Eye, ArrowLeft } from 'lucide-react';

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
    <div className="preview-banner sticky top-0 z-50 px-4 py-2 flex items-center justify-between">
      <div className="flex items-center gap-2 text-stone-300">
        <Eye size={16} className="preview-banner-pulse" />
        <span className="text-sm font-medium">Preview Mode - Participant View</span>
      </div>
      <button
        onClick={handleExit}
        className="flex items-center gap-1 px-3 py-1.5 text-sm text-stone-400 hover:text-stone-100 bg-stone-700/50 hover:bg-stone-700 rounded-lg transition-colors"
      >
        <ArrowLeft size={14} />
        Exit Preview
      </button>
    </div>
  );
}
