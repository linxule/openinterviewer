'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useStore } from '@/store';
import { StudyConfig } from '@/types';
import Consent from '@/components/Consent';
import InterviewChat from '@/components/InterviewChat';
import Synthesis from '@/components/Synthesis';
import Export from '@/components/Export';
import { Loader2 } from 'lucide-react';

export default function ParticipantPage() {
  const params = useParams();
  const router = useRouter();
  const token = params.token as string;

  const {
    currentStep,
    beginParticipantSession,
    studyConfig
  } = useStore();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Verify token and load study config on mount
  useEffect(() => {
    const loadStudyFromToken = async () => {
      if (!token) {
        setError('No token provided');
        setLoading(false);
        return;
      }

      try {
        // Verify and decode the token
        const response = await fetch(`/api/generate-link?token=${encodeURIComponent(token)}`);
        const result = await response.json();

        if (!result.valid || !result.data) {
          setError('Invalid or expired link');
          setLoading(false);
          return;
        }

        const tokenData = result.data as { studyConfig: StudyConfig; sessionHandle?: string };
        if (!tokenData.sessionHandle) {
          setError('The participant session could not be established');
          setLoading(false);
          return;
        }
        beginParticipantSession(tokenData.studyConfig, null, tokenData.sessionHandle);
        setLoading(false);
        router.replace('/consent');
      } catch (err) {
        console.error('Error loading study from token:', err);
        setError('Failed to load study configuration');
        setLoading(false);
      }
    };

    loadStudyFromToken();
  }, [token, beginParticipantSession, router]);

  // Loading state
  if (loading) {
    return (
      <div className="min-h-screen bg-stone-900 flex items-center justify-center">
        <div className="text-center">
          <Loader2 size={48} className="animate-spin text-stone-400 mx-auto mb-4" />
          <p className="text-stone-400">Loading interview...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="min-h-screen bg-stone-900 flex items-center justify-center p-8">
        <div className="max-w-md text-center">
          <div className="w-16 h-16 rounded-full bg-stone-800 flex items-center justify-center mx-auto mb-4">
            <span className="text-2xl">⚠️</span>
          </div>
          <h1 className="text-xl font-semibold text-white mb-2">Unable to Load Interview</h1>
          <p className="text-stone-400 mb-6">{error}</p>
          <p className="text-stone-500 text-sm">
            Please check that you have the correct link or contact the researcher.
          </p>
        </div>
      </div>
    );
  }

  // No study config loaded
  if (!studyConfig) {
    return (
      <div className="min-h-screen bg-stone-900 flex items-center justify-center">
        <p className="text-stone-400">Study configuration not found.</p>
      </div>
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
