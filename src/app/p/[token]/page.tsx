'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useStore } from '@/store';
import { StudyConfig } from '@/types';
import Consent from '@/components/Consent';
import InterviewChat from '@/components/InterviewChat';
import Synthesis from '@/components/Synthesis';
import Export from '@/components/Export';
import { Verbatim } from '@/components/ui';
import type { AITransport } from '@/lib/aiTransport';

export default function ParticipantPage() {
  const params = useParams();
  const router = useRouter();
  const linkCode = params.token as string;

  const {
    currentStep,
    beginParticipantSession,
    studyConfig
  } = useStore();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Resolve the opaque link code and establish a cookie-backed participant session.
  useEffect(() => {
    const loadStudyFromLink = async () => {
      if (!linkCode) {
        setError('No participant link code provided');
        setLoading(false);
        return;
      }

      try {
        const response = await fetch(`/api/generate-link?token=${encodeURIComponent(linkCode)}`);
        const result = await response.json();

        if (!result.valid || !result.data) {
          setError('Invalid or expired link');
          setLoading(false);
          return;
        }

        const resolvedLink = result.data as {
          studyConfig: StudyConfig;
          sessionHandle?: string;
          aiTransport?: AITransport;
        };
        if (!resolvedLink.sessionHandle) {
          setError('The participant session could not be established');
          setLoading(false);
          return;
        }
        beginParticipantSession(
          resolvedLink.studyConfig,
          resolvedLink.sessionHandle,
          resolvedLink.aiTransport === 'gateway' ? 'gateway' : 'direct',
        );
        setLoading(false);
        router.replace('/consent');
      } catch (err) {
        console.error('Error loading study from participant link:', err);
        setError('Failed to load study configuration');
        setLoading(false);
      }
    };

    loadStudyFromLink();
  }, [linkCode, beginParticipantSession, router]);

  // Loading state
  if (loading) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-paper-0 px-4 py-12">
        <div className="w-full max-w-measure">
          <p className="font-sans text-[15px] text-ink-500">Loading interview...</p>
        </div>
      </main>
    );
  }

  // Error state
  if (error) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-paper-0 px-4 py-12">
        <div className="w-full max-w-measure">
          <Verbatim as="h1" className="text-[28px] font-normal leading-[36px] text-ink-900">
            Unable to Load Interview
          </Verbatim>
          <p className="mt-4 font-sans text-[15px] text-ink-700">{error}</p>
          <p className="mt-2 font-sans text-[13px] text-ink-500">
            Please check that you have the correct link or contact the researcher.
          </p>
        </div>
      </main>
    );
  }

  // No study config loaded
  if (!studyConfig) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-paper-0 px-4 py-12">
        <div className="w-full max-w-measure">
          <p className="font-sans text-[15px] text-ink-500">Study configuration not found.</p>
        </div>
      </main>
    );
  }

  // Render the appropriate step
  switch (currentStep) {
    case 'consent':
      return <Consent />;
    case 'interview':
      return <InterviewChat />;
    case 'synthesis':
      return <Synthesis />;
    case 'export':
      return <Export />;
    default:
      return <Consent />;
  }
}
