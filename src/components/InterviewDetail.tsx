'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { InterviewAnalysisFailureKind, StoredInterview } from '@/types';
import { getInterview, StudyOperationPendingError } from '@/services/storageService';
import ReactMarkdown from 'react-markdown';
import { Button, Coordinate, Label, Notice, Tabs, Turn, type TabItem } from '@/components/ui';
import { SynthesisReading, ProvenanceFooter } from '@/components/SynthesisReading';
import { analysisStatus } from '@/lib/analysisState';
import { useSetTrailingCrumb } from '@/components/shell/breadcrumb';
import { cn } from '@/lib/cn';

// Mirrors ANALYSIS_CLAIM_LEASE_MS in src/lib/kv.ts — duplicated rather than
// imported because that module pulls in server-only Redis client code that
// must never reach a 'use client' bundle.
const ANALYSIS_CLAIM_LEASE_MS = 180_000;

const FAILURE_COPY: Record<InterviewAnalysisFailureKind, string> = {
  provider: 'The model provider did not return an analysis. This is not an analysis — run it again.',
  'invalid-output': 'The model returned something this study could not read as an analysis. Run it again.',
  'too-large': 'The analysis was too large to store. Run it again, or shorten the study’s topic areas.',
  timeout: 'The analysis did not finish in time. Run it again.',
  storage: 'The analysis could not be saved. Run it again.',
};

function relativeTimeFrom(ms: number, nowMs: number): string {
  const elapsed = nowMs - ms;
  const minutes = Math.round(elapsed / 60_000);
  if (minutes < 1) return 'less than a minute ago';
  if (minutes === 1) return '1 minute ago';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
}

interface InterviewDetailProps {
  interviewId: string;
  studyId?: string;
  turn?: string;
}

const INTERVIEW_TABS = [
  { id: 'transcript', label: 'Transcript' },
  { id: 'analysis', label: 'Analysis' },
] as const satisfies readonly TabItem<'transcript' | 'analysis'>[];

const InterviewDetail: React.FC<InterviewDetailProps> = ({ interviewId, studyId, turn }) => {
  const router = useRouter();
  const [interview, setInterview] = useState<StoredInterview | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'transcript' | 'analysis'>('transcript');
  const [operationPending, setOperationPending] = useState(false);
  const [tracedTurn, setTracedTurn] = useState<number | null>(null);
  const [openNotes, setOpenNotes] = useState<Record<string, boolean>>({});
  const [isRunningAnalysis, setIsRunningAnalysis] = useState(false);
  // `Date.now()` is impure and may not be called during render; a running
  // analysis's lease elapsing is exactly the kind of clock-driven UI change
  // that needs its own tick, polled while (and only while) a claim is live.
  const [nowMs, setNowMs] = useState(() => Date.now());

  useSetTrailingCrumb(interview?.studyName ?? null);

  useEffect(() => {
    if (!interview || analysisStatus(interview) !== 'running') return;
    const interval = setInterval(() => setNowMs(Date.now()), 5_000);
    return () => clearInterval(interval);
  }, [interview]);

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

  // Landing on a cited turn from an aggregate citation's link (L11). Declared
  // after the reset effect above so that on the commit where a record first
  // arrives, the reset runs first and this focus runs second. An absent,
  // non-numeric, or out-of-range `turn` is ignored silently — a stale link
  // should land on the transcript, not on an error.
  useEffect(() => {
    if (!interview) return;
    const requested = Number(turn);
    if (!Number.isInteger(requested) || requested < 1 || requested > interview.transcript.length) return;
    setActiveTab('transcript');
    setTracedTurn(requested);
    const frame = requestAnimationFrame(() => {
      document.getElementById(`turn-${requested}`)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [interview, turn]);

  const handleRunAnalysis = async () => {
    if (!interview || !studyId || isRunningAnalysis) return;
    setIsRunningAnalysis(true);
    try {
      const response = await fetch(
        `/api/interviews/${encodeURIComponent(interview.id)}/analyze?studyId=${encodeURIComponent(studyId)}`,
        { method: 'POST' },
      );
      if (response.ok) {
        await loadInterview();
      }
    } catch (error) {
      console.error('Error running analysis:', error);
    } finally {
      setIsRunningAnalysis(false);
    }
  };

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
            {(() => {
              const status = analysisStatus(interview);
              if (status === 'complete' && interview.synthesis) {
                const analysisRevision = interview.analysis?.studyRevision;
                const note = analysisRevision !== undefined && analysisRevision !== interview.studyRevision
                  ? `analyzed at study rev ${analysisRevision}`
                  : undefined;
                return (
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
                      conductedBy={interview.conductedByModel ?? 'not recorded'}
                      studyRevision={interview.studyRevision}
                      timestamp={savedAt}
                      verb="saved"
                      note={note}
                    />
                  </div>
                );
              }
              if (status === 'pending') {
                return (
                  <Notice tone="neutral" eyebrow="Analysis pending">
                    <p className="mt-1 text-[13px] text-ink-700">
                      This interview was saved. Its analysis has not run yet.
                    </p>
                    <Button
                      variant="primary"
                      className="mt-3 min-h-11"
                      disabled={isRunningAnalysis}
                      onClick={() => void handleRunAnalysis()}
                    >
                      {isRunningAnalysis ? 'Running…' : 'Run analysis'}
                    </Button>
                  </Notice>
                );
              }
              if (status === 'running') {
                const claimedAt = interview.analysis?.claimedAt;
                const leaseElapsed = claimedAt !== undefined
                  && nowMs - claimedAt >= ANALYSIS_CLAIM_LEASE_MS;
                return (
                  <Notice tone="neutral" eyebrow="Analysis running">
                    <p className="mt-1 text-[13px] text-ink-700">
                      {claimedAt !== undefined
                        ? `An analysis started ${relativeTimeFrom(claimedAt, nowMs)}. Give it a moment, then reload.`
                        : 'An analysis is running. Give it a moment, then reload.'}
                    </p>
                    <Button
                      variant="primary"
                      className="mt-3 min-h-11"
                      disabled={!leaseElapsed || isRunningAnalysis}
                      onClick={() => void handleRunAnalysis()}
                    >
                      {isRunningAnalysis ? 'Running…' : 'Run analysis'}
                    </Button>
                  </Notice>
                );
              }
              // 'failed'
              const failureKind = interview.analysis?.failureKind;
              return (
                <Notice tone="error" eyebrow="Analysis failed">
                  <p className="mt-1 text-[13px] text-ink-700" role="alert">
                    {failureKind ? FAILURE_COPY[failureKind] : 'This is not an analysis — run it again.'}
                  </p>
                  <Button
                    variant="primary"
                    className="mt-3 min-h-11"
                    disabled={isRunningAnalysis}
                    onClick={() => void handleRunAnalysis()}
                  >
                    {isRunningAnalysis ? 'Running…' : 'Run analysis'}
                  </Button>
                </Notice>
              );
            })()}
          </div>
        )}
      </Tabs>
    </div>
  );
};

export default InterviewDetail;
