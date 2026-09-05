'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { StoredInterview } from '@/types';
import { getInterview, StudyOperationPendingError } from '@/services/storageService';
import ReactMarkdown from 'react-markdown';
import { Button, Coordinate, Label, Tabs, Turn, type TabItem } from '@/components/ui';
import { SynthesisReading, ProvenanceFooter } from '@/components/SynthesisReading';
import { useSetTrailingCrumb } from '@/components/shell/breadcrumb';
import { cn } from '@/lib/cn';

interface InterviewDetailProps {
  interviewId: string;
  studyId?: string;
}

const INTERVIEW_TABS = [
  { id: 'transcript', label: 'Transcript' },
  { id: 'analysis', label: 'Analysis' },
] as const satisfies readonly TabItem<'transcript' | 'analysis'>[];

const InterviewDetail: React.FC<InterviewDetailProps> = ({ interviewId, studyId }) => {
  const router = useRouter();
  const [interview, setInterview] = useState<StoredInterview | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'transcript' | 'analysis'>('transcript');
  const [operationPending, setOperationPending] = useState(false);
  const [tracedTurn, setTracedTurn] = useState<number | null>(null);
  const [openNotes, setOpenNotes] = useState<Record<string, boolean>>({});

  useSetTrailingCrumb(interview?.studyName ?? null);

  const setNoteOpen = (themeIndex: number, refIndex: number, next: boolean) =>
    setOpenNotes((prev) => ({ ...prev, [`${themeIndex}:${refIndex}`]: next }));

  const switchTab = (tab: 'transcript' | 'analysis') => {
    setTracedTurn(null);
    setActiveTab(tab);
  };

  const traceToTurn = (turnIndex: number) => {
    setActiveTab('transcript');
    setTracedTurn(turnIndex);
    requestAnimationFrame(() => {
      document.getElementById(`turn-${turnIndex}`)?.focus();
    });
  };

  const loadInterview = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getInterview(interviewId, studyId);
      setInterview(data);
    } catch (error) {
      if (error instanceof StudyOperationPendingError) {
        setOperationPending(true);
      } else {
        console.error('Error loading interview:', error);
      }
    } finally {
      setLoading(false);
    }
  }, [interviewId, studyId]);

  useEffect(() => {
    void loadInterview();
  }, [loadInterview]);

  // A different interview must not inherit this one's note/trace state: the App
  // Router reconciles param changes in place, so state does not reset by remount.
  useEffect(() => {
    setOpenNotes({});
    setTracedTurn(null);
  }, [interviewId]);

  const handleDownloadJSON = () => {
    if (!interview) return;
    const content = JSON.stringify(interview, null, 2);
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `interview-${interview.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadTranscript = () => {
    if (!interview) return;

    const lines = [
      `# Interview Transcript`,
      `Study: ${interview.studyName}`,
      `Date: ${new Date(interview.createdAt).toLocaleDateString()}`,
      ``
    ];

    // Add participant profile
    if (interview.participantProfile?.fields.length > 0) {
      lines.push(`## Participant Profile`);
      interview.participantProfile.fields.forEach(f => {
        if (f.status === 'extracted' && f.value) {
          lines.push(`- **${f.fieldId}**: ${f.value}`);
        }
      });
      lines.push(``);
    }

    lines.push(`## Conversation`);
    lines.push(``);

    interview.transcript.forEach(msg => {
      const time = new Date(msg.timestamp).toLocaleTimeString();
      const role = msg.role === 'user' ? 'PARTICIPANT' : 'INTERVIEWER';
      lines.push(`[${time}] ${role}:`);
      lines.push(msg.content);
      lines.push('');
    });

    if (interview.synthesis) {
      lines.push(`## Analysis`);
      lines.push(`**Key Insight:** ${interview.synthesis.bottomLine}`);
    }

    const content = lines.join('\n');
    const blob = new Blob([content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transcript-${interview.id}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const formatDuration = (start: number, end: number) => {
    const minutes = Math.round((end - start) / 1000 / 60);
    return `${minutes} minutes`;
  };

  if (loading) {
    return <p className="py-16 font-sans text-[15px] text-ink-500">Loading…</p>;
  }

  if (!interview) {
    return (
      <div className="max-w-measure">
        <h1 className="font-sans text-[24px] font-semibold leading-[32px] text-ink-900">
          {operationPending ? 'Study change pending' : 'Interview Not Found'}
        </h1>
        <p className="mt-2 font-sans text-[15px] text-ink-700">
          {operationPending
            ? 'A study operation is already in progress.'
            : 'This interview may have been deleted.'}
        </p>
        <Button variant="quiet" onClick={() => router.push('/dashboard')} className="mt-4">
          Back to Interviews
        </Button>
      </div>
    );
  }

  const savedAt = Number.isFinite(interview.completedAt)
    ? new Date(interview.completedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : 'time unrecorded';

  return (
    <div>
      {/* Header */}
      <div className="mb-8">
        <h1 className="font-sans text-[24px] font-semibold leading-[32px] text-ink-900">{interview.studyName}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          <Coordinate>{formatDuration(interview.createdAt, interview.completedAt)}</Coordinate>
          <span className="font-sans text-[13px] text-ink-500">{interview.transcript.length} message{interview.transcript.length !== 1 ? 's' : ''}</span>
          <Coordinate>
            {new Date(interview.createdAt).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric'
            })}
          </Coordinate>
        </div>
        <div className="mt-4 flex gap-2">
          <Button variant="quiet" className="text-[13px]" onClick={handleDownloadTranscript}>
            Download transcript
          </Button>
          <Button variant="quiet" className="text-[13px]" onClick={handleDownloadJSON}>
            Download JSON
          </Button>
        </div>
      </div>

      {/* Participant Profile */}
      {interview.participantProfile && interview.participantProfile.fields.length > 0 && (
        <div className="mb-8 border-t border-ink-300 pt-4">
          <Label>Participant profile</Label>
          <div className="mt-2 grid grid-cols-2 gap-3 text-[13px] md:grid-cols-3">
            {interview.participantProfile.fields
              .filter(f => f.status === 'extracted' && f.value)
              .map(f => (
                <div key={f.fieldId}>
                  <span className="text-ink-500">{f.fieldId}:</span>{' '}
                  <span className="text-ink-900">{f.value}</span>
                </div>
              ))}
          </div>
        </div>
      )}

      <Tabs
        items={INTERVIEW_TABS}
        value={activeTab}
        onValueChange={switchTab}
        label="Interview sections"
        className="mb-8 grid-cols-2"
      >
        {activeTab === 'transcript' ? (
          <ol className="space-y-8">
            {interview.transcript.map((msg, i) => (
              <li
                key={i}
                id={`turn-${i + 1}`}
                tabIndex={-1}
                className={cn(
                  'focus:outline-none',
                  tracedTurn === i + 1 && 'ring-2 trace-ring ring-offset-4 ring-offset-paper-0'
                )}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <Label>{msg.role === 'ai' ? 'Interviewer' : 'Participant'}</Label>
                  <Coordinate>{new Date(msg.timestamp).toLocaleTimeString()}</Coordinate>
                </div>
                <Turn
                  speaker={msg.role === 'ai' ? 'interviewer' : 'participant'}
                  turnIndex={i + 1}
                  showCoordinate
                  className="mt-1"
                >
                  <div className="prose-verbatim">
                    <ReactMarkdown>{msg.content}</ReactMarkdown>
                  </div>
                </Turn>
              </li>
            ))}
          </ol>
        ) : (
          <div>
            {interview.synthesis ? (
              <div className="space-y-6">
                <SynthesisReading
                  synthesis={interview.synthesis}
                  transcript={interview.transcript}
                  openNotes={openNotes}
                  onNoteOpenChange={setNoteOpen}
                  onTraceToTurn={traceToTurn}
                />
                <ProvenanceFooter
                  model={interview.aiModel}
                  studyRevision={interview.studyRevision}
                  timestamp={savedAt}
                  verb="saved"
                />
              </div>
            ) : (
              <p className="font-sans text-[15px] text-ink-500">
                No analysis available for this interview.
              </p>
            )}
          </div>
        )}
      </Tabs>
    </div>
  );
};

export default InterviewDetail;
