'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { StoredInterview } from '@/types';
import { getInterview, StudyOperationPendingError } from '@/services/storageService';
import ReactMarkdown from 'react-markdown';
import { Button, Coordinate, Label, Tabs, Turn, type TabItem } from '@/components/ui';
import { InterviewAnalysisPanel } from '@/components/analysis/InterviewAnalysisPanel';
import { useInterviewAnalysis } from '@/components/analysis/useInterviewAnalysis';
import { useSetTrailingCrumb } from '@/components/shell/breadcrumb';
import { cn } from '@/lib/cn';
import { LANGUAGE_TAGS } from '@/lib/i18n/languages';

interface InterviewDetailProps {
  interviewId: string;
  studyId?: string;
  turn?: string;
}

const INTERVIEW_TABS = [
  { id: 'transcript', label: 'Transcript' },
  { id: 'analysis', label: 'Analysis' },
] as const satisfies readonly TabItem<'transcript' | 'analysis'>[];

function profileEntries(interview: StoredInterview) {
  const saved = interview.participantProfile?.fields ?? [];
  const schema = interview.collectionConfig?.profileSchema;
  const ids = [...new Set([...(schema?.map(field => field.id) ?? []), ...saved.map(field => field.fieldId)])];
  return ids.map(id => {
    const definition = schema?.find(field => field.id === id);
    const field = saved.find(value => value.fieldId === id);
    const value = field?.value?.trim();
    const status = field?.status === 'refused' ? 'Declined to answer'
      : field?.status === 'vague' ? `Vague${value ? `: ${value}` : ''}`
      : field?.status === 'extracted' && value ? value : 'Not recorded';
    return { id, label: definition?.label ?? id, status, definitionKnown: !!definition };
  });
}

const InterviewDetail: React.FC<InterviewDetailProps> = ({ interviewId, studyId, turn }) => {
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

  // A refresh keeps the page (and the last confirmed record) on screen: only
  // a successful read replaces it, and never with a different interview.
  const refreshInterview = useCallback(async () => {
    try {
      const data = await getInterview(interviewId, studyId);
      if (!data) return false;
      setInterview((current) => (current && current.id === data.id ? data : current));
      return true;
    } catch {
      return false;
    }
  }, [interviewId, studyId]);

  const analysis = useInterviewAnalysis({ interview, refreshRecord: refreshInterview });

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
  // should land on the transcript, not on an error. Keyed on the record's
  // identity, not the object: a background refresh of the same record (e.g.
  // after a polled completion) must not move the tab or focus (UI-CF-05).
  const landingRecordId = interview?.id ?? null;
  const landingTranscriptLength = interview?.transcript.length ?? 0;
  useEffect(() => {
    if (!landingRecordId) return;
    const requested = Number(turn);
    if (!Number.isInteger(requested) || requested < 1 || requested > landingTranscriptLength) return;
    setActiveTab('transcript');
    setTracedTurn(requested);
    const frame = requestAnimationFrame(() => {
      document.getElementById(`turn-${requested}`)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [landingRecordId, landingTranscriptLength, turn]);

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

    const profile = profileEntries(interview);
    if (profile.length > 0) {
      lines.push('## Participant Profile');
      profile.forEach(field => lines.push(`- **${field.label}**: ${field.status}${field.definitionKnown ? '' : ' (original field definition unavailable)'}`));
      lines.push('');
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
      <p role="status" aria-live="polite" className="sr-only">{analysis.announcement}</p>
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

      <dl aria-label="Interview conducting provenance" className="mb-8 border-t border-ink-300 pt-4">
        <dt><Label>Conducting provider and model</Label></dt>
        <dd className="mt-2 font-mono text-[13px] text-ink-500 wrap-break-word">
          {interview.conductedByProvider ?? 'not recorded'} · {interview.conductedByModel ?? 'not recorded'}
        </dd>
        <dt className="mt-4"><Label>Instructions at save time</Label></dt>
        <dd className="mt-2 font-sans text-[15px] leading-[24px] text-ink-700 whitespace-pre-wrap max-w-measure wrap-break-word">
          {interview.conductedWithInstructions ?? 'Default manner (none recorded)'}
        </dd>
      </dl>

      {/* Collection-time definitions only; current study labels cannot relabel historical responses. */}
      {profileEntries(interview).length > 0 && (
        <div className="mb-8 border-t border-ink-300 pt-4">
          <Label>Participant profile</Label>
          {!interview.collectionConfig && <p className="mt-2 max-w-measure text-[13px] text-ink-500">Original profile definitions were not recorded for this interview. Field IDs are shown without reconstructing historical labels.</p>}
          <dl className="mt-2 grid grid-cols-1 gap-3 text-[13px] sm:grid-cols-2 md:grid-cols-3">
            {profileEntries(interview).map(field => (
              <div key={field.id} className="wrap-break-word border-t border-ink-300 pt-2">
                <dt className="text-ink-500">{field.label}</dt>
                <dd className="mt-1 text-ink-900">{field.status}</dd>
                {!field.definitionKnown && <p className="mt-1 text-[12px] text-ink-500">Original field definition unavailable</p>}
              </div>
            ))}
          </dl>
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
                  'focus:outline-hidden',
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
                  <div className="prose-verbatim" lang={interview.interviewLanguage ? LANGUAGE_TAGS[interview.interviewLanguage] : undefined}>
                    <ReactMarkdown>{msg.content}</ReactMarkdown>
                  </div>
                </Turn>
              </li>
            ))}
          </ol>
        ) : (
          <InterviewAnalysisPanel
            interview={interview}
            controller={analysis}
            savedAt={savedAt}
            openNotes={openNotes}
            onNoteOpenChange={setNoteOpen}
            onTraceToTurn={traceToTurn}
          />
        )}
      </Tabs>
    </div>
  );
};

export default InterviewDetail;
