'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { StoredInterview } from '@/types';
import { getInterview, StudyOperationPendingError } from '@/services/storageService';
import ReactMarkdown from 'react-markdown';
import { Button, Citation, Coordinate, Label, Rule, Turn, Verbatim } from '@/components/ui';
import { useSetTrailingCrumb } from '@/components/shell/breadcrumb';
import { cn } from '@/lib/cn';
import { resolveThemeEvidence } from '@/lib/evidence';

interface InterviewDetailProps {
  interviewId: string;
  studyId?: string;
}

const InterviewDetail: React.FC<InterviewDetailProps> = ({ interviewId, studyId }) => {
  const router = useRouter();
  const [interview, setInterview] = useState<StoredInterview | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'transcript' | 'analysis'>('transcript');
  const [operationPending, setOperationPending] = useState(false);
  const [tracedTurn, setTracedTurn] = useState<number | null>(null);
  const [openNotes, setOpenNotes] = useState<Record<string, boolean>>({});

  useSetTrailingCrumb(interview?.studyName ?? null);

  const isNoteOpen = (themeIndex: number, refIndex: number) => openNotes[`${themeIndex}:${refIndex}`] ?? true;
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
          Back to Dashboard
        </Button>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-8">
        <h1 className="font-sans text-[24px] font-semibold leading-[32px] text-ink-900">{interview.studyName}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          <Coordinate>{formatDuration(interview.createdAt, interview.completedAt)}</Coordinate>
          <span className="font-sans text-[13px] text-ink-500">{interview.transcript.length} messages</span>
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

      {/* Tabs */}
      <div className="mb-8 grid grid-cols-2 border-b border-ink-300">
        <button
          type="button"
          onClick={() => switchTab('transcript')}
          className={`min-h-11 border-b-2 px-2 py-3 text-center font-sans text-[15px] font-medium ${
            activeTab === 'transcript'
              ? 'border-action text-action'
              : 'border-transparent text-ink-500 hover:text-ink-900'
          }`}
        >
          Transcript
        </button>
        <button
          type="button"
          onClick={() => switchTab('analysis')}
          className={`min-h-11 border-b-2 px-2 py-3 text-center font-sans text-[15px] font-medium ${
            activeTab === 'analysis'
              ? 'border-action text-action'
              : 'border-transparent text-ink-500 hover:text-ink-900'
          }`}
        >
          Analysis
        </button>
      </div>

      {/* Tab Content */}
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
              {/* Bottom line */}
              <section>
                <Label className="block">Bottom line</Label>
                <Verbatim
                  as="p"
                  className="mt-3 max-w-measure text-[24px] font-normal leading-[36px] text-ink-900 md:text-[28px] md:leading-[40px]"
                >
                  {interview.synthesis.bottomLine}
                </Verbatim>
              </section>
              <Rule className="mt-8" />

              {/* Stated vs Revealed */}
              <section>
                <h3 className="font-sans text-[15px] font-semibold text-ink-900">Stated vs Revealed</h3>
                <div className="mt-4 md:grid md:grid-cols-2 md:gap-10">
                  <div>
                    <Label>What they said</Label>
                    <ul>
                      {interview.synthesis.statedPreferences.map((item, i) => (
                        <li
                          key={i}
                          className="border-t border-ink-300 py-2 font-sans text-[15px] leading-[24px] text-ink-700"
                        >
                          {item}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="mt-6 md:mt-0">
                    <Label>What behavior revealed</Label>
                    <ul>
                      {interview.synthesis.revealedPreferences.map((item, i) => (
                        <li
                          key={i}
                          className="border-t border-ink-300 py-2 font-sans text-[15px] leading-[24px] text-ink-700"
                        >
                          {item}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </section>
              <Rule className="mt-8" />

              {/* Key Themes */}
              <section>
                <h3 className="font-sans text-[15px] font-semibold text-ink-900">Key Themes</h3>
                <ul className="mt-4">
                  {interview.synthesis.themes.map((theme, i) => {
                    const view = resolveThemeEvidence(theme, interview.transcript);
                    return (
                      <li key={i} className="border-t border-ink-300 py-4">
                        <p className="font-sans text-[15px] font-medium text-ink-900">
                          {theme.theme}
                          {view.kind === 'refs'
                            ? view.entries.map((entry, j) =>
                                entry.match.status === 'verified' ? (
                                  <Citation
                                    key={j}
                                    label={`t.${entry.ref.turnIndex}`}
                                    open={isNoteOpen(i, j)}
                                    onOpenChange={(next) => setNoteOpen(i, j, next)}
                                    className="ml-1"
                                  >
                                    <span className="block text-[19px] leading-[31px] text-ink-900">
                                      {`“${entry.quotedFromRecord}”`}
                                    </span>
                                    <Coordinate className="mt-2 block">
                                      {`Participant · turn ${entry.ref.turnIndex}`}
                                    </Coordinate>
                                    <button
                                      type="button"
                                      onClick={() => traceToTurn(entry.ref.turnIndex)}
                                      className="mt-2 block font-sans text-[13px] text-action underline underline-offset-2"
                                    >
                                      Read in full transcript
                                    </button>
                                  </Citation>
                                ) : null
                              )
                            : null}
                        </p>
                        {view.kind === 'legacy' ? (
                          <Verbatim
                            as="p"
                            className="mt-2 max-w-measure border-l border-ink-300 pl-4 text-[17px] leading-[28px] text-ink-700"
                          >
                            {view.text}
                          </Verbatim>
                        ) : null}
                        {view.kind === 'refs'
                          ? view.entries
                              .filter((entry) => entry.match.status !== 'verified')
                              .map((entry, j) => (
                                <Verbatim
                                  key={j}
                                  as="p"
                                  className="mt-2 max-w-measure border-l border-ink-300 pl-4 text-[17px] leading-[28px] text-ink-700"
                                >
                                  {entry.ref.quote}
                                </Verbatim>
                              ))
                          : null}
                      </li>
                    );
                  })}
                </ul>
              </section>

              {/* Contradictions */}
              {interview.synthesis.contradictions.length > 0 && (
                <section className="border-t border-ink-300 pt-5">
                  <h3 className="font-sans text-[15px] font-semibold text-ink-900">Potential Contradictions</h3>
                  <ul className="mt-3 space-y-2">
                    {interview.synthesis.contradictions.map((c, i) => (
                      <li key={i} className="max-w-measure font-sans text-[15px] leading-[24px] text-ink-700">
                        {c}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* Additional Insights */}
              <section>
                <h3 className="font-sans text-[15px] font-semibold text-ink-900">Additional Insights</h3>
                <ul className="mt-4">
                  {interview.synthesis.keyInsights.map((insight, i) => (
                    <li
                      key={i}
                      className="border-t border-ink-300 py-2 font-sans text-[15px] leading-[24px] text-ink-700"
                    >
                      {insight}
                    </li>
                  ))}
                </ul>
              </section>

              {/* Provenance footer */}
              <footer className="mt-10 border-t border-ink-300 pt-4">
                <Coordinate className="block">
                  {`Synthesized by ${interview.aiModel ?? 'unrecorded model'} · study rev ${
                    interview.studyRevision ?? '—'
                  } · ${new Date(interview.completedAt).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric'
                  })} · receipt ${
                    interview.synthesis._receipt ? interview.synthesis._receipt.slice(0, 12) : 'unsigned'
                  }`}
                </Coordinate>
              </footer>
            </div>
          ) : (
            <p className="font-sans text-[15px] text-ink-500">
              No analysis available for this interview.
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export default InterviewDetail;
