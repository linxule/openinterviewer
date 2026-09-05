'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { StoredStudy, StoredInterview, AggregateSynthesisResult } from '@/types';
import type { ParticipantLinkMetadata } from '@/lib/participantLinks';
import {
  getStudy,
  getStudyAggregate,
  getStudyInterviews,
  reconcileStudyOperations,
  ResearcherStorageUnavailableError,
  StudyOperationPendingError,
} from '@/services/storageService';
import { Button, Coordinate, Icon, Label, Notice, Rule, Tabs } from '@/components/ui';
import { AggregateReading, ProvenanceFooter } from '@/components/SynthesisReading';
import { shortInterviewId } from '@/lib/interviewId';
import { buildAggregateInterviewIndex } from '@/lib/evidence';
import { analysisStatus, isAwaitingAnalysis } from '@/lib/analysisState';
import { useSetTrailingCrumb } from '@/components/shell/breadcrumb';

interface StudyDetailProps {
  studyId: string;
}

type TabType = 'overview' | 'interviews' | 'settings';

// The maximum interviews one press of the batch action analyzes. Beyond
// that, the button analyzes the oldest 25 and the count updates (P8.2).
const ANALYSIS_BATCH_LIMIT = 25;

/**
 * The reminder the owner asked about: "do they get to track what model was
 * used for which interview?" Fires only when at least two DISTINCT recorded
 * models appear — legacy interviews alone are not evidence of a switch. One
 * component, reused verbatim on the Overview and Interviews tabs (Ruling 1).
 */
function ConductingModelsNotice({
  conductingModels,
  recordedModelCount,
}: {
  conductingModels: { provider?: string; model?: string; count: number }[];
  recordedModelCount: number;
}) {
  if (recordedModelCount < 2) return null;
  const countsLine = conductingModels
    .map((entry) => `${entry.model ?? 'not recorded'} ×${entry.count}`)
    .join(' · ');
  return (
    <Notice tone="neutral" eyebrow={`Conducted with ${recordedModelCount} models`} className="mb-6">
      <Coordinate className="mt-1 block">{countsLine}</Coordinate>
      <p className="mt-1 text-[13px] text-ink-700">
        Switching models is recorded on each interview, not blocked. Keeping one model across a study
        makes interviews easier to compare.
      </p>
    </Notice>
  );
}

function analysisCellContent(interview: StoredInterview) {
  const status = analysisStatus(interview);
  if (status === 'complete') return <span className="text-ink-500">analyzed</span>;
  if (status === 'failed') return <span className="text-error">analysis failed</span>;
  return <span className="text-ink-900">awaiting analysis</span>;
}

function isStudyOperationPending(response: Response, data: { code?: string }) {
  return response.status === 409 && data.code === 'STUDY_OPERATION_PENDING';
}

const StudyDetail: React.FC<StudyDetailProps> = ({ studyId }) => {
  const router = useRouter();
  const [study, setStudy] = useState<StoredStudy | null>(null);
  const [interviews, setInterviews] = useState<StoredInterview[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabType>('overview');
  const [aggregateSynthesis, setAggregateSynthesis] = useState<AggregateSynthesisResult | null>(null);
  const [aggregateOpenNotes, setAggregateOpenNotes] = useState<Record<string, boolean>>({});
  const [isGeneratingAggregate, setIsGeneratingAggregate] = useState(false);
  const [isGeneratingFollowup, setIsGeneratingFollowup] = useState(false);
  const [isTogglingLinks, setIsTogglingLinks] = useState(false);
  const [participantLink, setParticipantLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [generatingLink, setGeneratingLink] = useState(false);
  const [participantLinks, setParticipantLinks] = useState<ParticipantLinkMetadata[]>([]);
  const [linksLoadedAt, setLinksLoadedAt] = useState(0);
  const [linksLoading, setLinksLoading] = useState(true);
  const [linksError, setLinksError] = useState<string | null>(null);
  const [revokingLinkId, setRevokingLinkId] = useState<string | null>(null);
  const [operationPending, setOperationPending] = useState(false);
  const [storageUnavailable, setStorageUnavailable] = useState<string | null>(null);
  const [isReconciling, setIsReconciling] = useState(false);

  useSetTrailingCrumb(study?.config.name ?? null);

  // Stable participant numbering (ascending createdAt, id tiebreak) — the
  // record every aggregate citation is checked against, and per Ruling 2 the
  // source of the register's row number below (not the newest-first index).
  const interviewIndex = useMemo(() => buildAggregateInterviewIndex(interviews), [interviews]);

  // The same predicate the route filters on (aggregate/route.ts:72-74), so the
  // count in the footer is the count a re-analysis would actually cover.
  const eligibleInterviewCount = useMemo(
    () => (study ? interviews.filter(i => i.studyRevision === study.revision && i.synthesis).length : 0),
    [interviews, study],
  );

  // Counts by (provider, model) pair — two providers could in principle
  // expose the same model id, and the pair is what the record actually
  // stores.
  const conductingModels = useMemo(() => {
    const counts = new Map<string, { provider?: string; model?: string; count: number }>();
    for (const interview of interviews) {
      const key = interview.conductedByModel
        ? `${interview.conductedByProvider ?? ''} ${interview.conductedByModel}`
        : ' ';
      const entry = counts.get(key)
        ?? { provider: interview.conductedByProvider, model: interview.conductedByModel, count: 0 };
      entry.count += 1;
      counts.set(key, entry);
    }
    return [...counts.values()].sort((a, b) => b.count - a.count
      || Number(!a.model) - Number(!b.model)
      || (a.model ?? '').localeCompare(b.model ?? ''));
  }, [interviews]);
  const recordedModelCount = conductingModels.filter(entry => entry.model).length;

  const pendingAnalysisInterviews = useMemo(
    () => interviews.filter(isAwaitingAnalysis).slice().sort((a, b) => a.createdAt - b.createdAt),
    [interviews],
  );
  const [isBatchAnalyzing, setIsBatchAnalyzing] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);

  const handleAnalyzeBatch = async () => {
    if (operationPending || isBatchAnalyzing) return;
    const batch = pendingAnalysisInterviews.slice(0, ANALYSIS_BATCH_LIMIT);
    if (batch.length === 0) return;
    setIsBatchAnalyzing(true);
    setBatchProgress({ done: 0, total: batch.length });
    for (let i = 0; i < batch.length; i++) {
      try {
        await fetch(
          `/api/interviews/${encodeURIComponent(batch[i].id)}/analyze?studyId=${encodeURIComponent(studyId)}`,
          { method: 'POST' },
        );
      } catch (error) {
        console.error('Error analyzing interview:', error);
      }
      setBatchProgress({ done: i + 1, total: batch.length });
    }
    setIsBatchAnalyzing(false);
    setBatchProgress(null);
    await loadStudyData();
  };

  const loadParticipantLinks = useCallback(async () => {
    setLinksLoading(true);
    setLinksError(null);
    try {
      const response = await fetch(`/api/studies/${encodeURIComponent(studyId)}/participant-links`, {
        cache: 'no-store',
      });
      const data = await response.json() as {
        links?: ParticipantLinkMetadata[];
        error?: string;
        code?: string;
      };
      if (isStudyOperationPending(response, data)) {
        setOperationPending(true);
        setParticipantLinks([]);
        return;
      }
      if (!response.ok) {
        throw new Error(data.error || 'Failed to load participant links');
      }
      setParticipantLinks(Array.isArray(data.links) ? data.links : []);
      setLinksLoadedAt(Date.now());
    } catch (error) {
      console.error('Error loading participant links:', error);
      setLinksError(error instanceof Error ? error.message : 'Failed to load participant links');
    } finally {
      setLinksLoading(false);
    }
  }, [studyId]);

  const loadStudyData = useCallback(async () => {
    setLoading(true);
    try {
      const [studyData, interviewData, aggregateData] = await Promise.all([
        getStudy(studyId),
        getStudyInterviews(studyId),
        getStudyAggregate(studyId),
      ]);
      setStudy(studyData);
      setInterviews(interviewData);
      setAggregateSynthesis(aggregateData);
      setAggregateOpenNotes({});
      setStorageUnavailable(null);
    } catch (error) {
      if (error instanceof StudyOperationPendingError) {
        setOperationPending(true);
        setInterviews([]);
      } else if (error instanceof ResearcherStorageUnavailableError) {
        setStorageUnavailable(error.message);
        setLinksError(error.message);
      } else {
        console.error('Error loading study:', error);
      }
    } finally {
      setLoading(false);
    }
  }, [studyId]);

  const runReconciliation = async () => {
    setIsReconciling(true);
    const result = await reconcileStudyOperations();
    setIsReconciling(false);
    if (result.success && result.stillPending === 0) {
      setOperationPending(false);
    }
    await loadStudyData();
    await loadParticipantLinks();
  };

  useEffect(() => {
    void loadStudyData();
  }, [loadStudyData]);

  useEffect(() => {
    void loadParticipantLinks();
  }, [loadParticipantLinks]);

  const handleToggleLinksEnabled = async () => {
    if (!study || operationPending) return;

    const newLinksEnabled = !(study.config.linksEnabled ?? true);
    setIsTogglingLinks(true);

    try {
      const response = await fetch(`/api/studies/${studyId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ linksEnabled: newLinksEnabled })
      });

      const data = await response.json().catch(() => ({})) as { code?: string; error?: string };
      if (isStudyOperationPending(response, data)) {
        setOperationPending(true);
        return;
      }
      if (!response.ok) {
        throw new Error(data.error || 'Failed to update study');
      }

      // Update local state
      setStudy({
        ...study,
        config: {
          ...study.config,
          linksEnabled: newLinksEnabled
        }
      });
    } catch (error) {
      console.error('Error toggling links:', error);
      alert('Failed to update link settings');
    } finally {
      setIsTogglingLinks(false);
    }
  };

  const handleGenerateLink = async () => {
    if (!study || operationPending) return;

    setGeneratingLink(true);
    try {
      const response = await fetch('/api/generate-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studyConfig: study.config })
      });

      const data = await response.json().catch(() => ({})) as { error?: string; code?: string; url?: string };
      if (isStudyOperationPending(response, data)) {
        setOperationPending(true);
        return;
      }
      if (!response.ok) {
        throw new Error(data.error || 'Failed to generate link');
      }
      if (data.url) {
        setParticipantLink(data.url);
        await loadParticipantLinks();
      }
    } catch (error) {
      console.error('Error generating link:', error);
      alert(error instanceof Error ? error.message : 'Failed to generate link');
    } finally {
      setGeneratingLink(false);
    }
  };

  const handleCopyLink = () => {
    if (participantLink) {
      navigator.clipboard.writeText(participantLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleRevokeLink = async (link: ParticipantLinkMetadata) => {
    if (operationPending || link.revokedAt !== null) return;
    if (!window.confirm('Revoke this participant link? Anyone using it will lose access immediately.')) {
      return;
    }

    setRevokingLinkId(link.id);
    try {
      const response = await fetch(`/api/studies/${encodeURIComponent(studyId)}/participant-links`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ linkId: link.id }),
      });
      const data = await response.json() as { error?: string; code?: string };
      if (isStudyOperationPending(response, data)) {
        setOperationPending(true);
        return;
      }
      if (!response.ok) {
        throw new Error(data.error || 'Failed to revoke participant link');
      }
      await loadParticipantLinks();
    } catch (error) {
      console.error('Error revoking participant link:', error);
      alert(error instanceof Error ? error.message : 'Failed to revoke participant link');
    } finally {
      setRevokingLinkId(null);
    }
  };

  const handleGenerateAggregateSynthesis = async () => {
    if (operationPending) return;
    if (eligibleInterviewCount < 2) {
      alert('Need at least 2 analyzed interviews to generate aggregate analysis');
      return;
    }

    setIsGeneratingAggregate(true);
    try {
      const response = await fetch('/api/synthesis/aggregate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studyId })
      });

      const data = await response.json().catch(() => ({})) as {
        error?: string;
        code?: string;
        synthesis?: AggregateSynthesisResult;
      };
      if (isStudyOperationPending(response, data)) {
        setOperationPending(true);
        return;
      }
      if (!response.ok) {
        throw new Error(data.error || 'Failed to generate synthesis');
      }
      if (data.synthesis) {
        setAggregateSynthesis(data.synthesis);
        setAggregateOpenNotes({});
      }
    } catch (error) {
      console.error('Error generating aggregate synthesis:', error);
      alert(error instanceof Error ? error.message : 'Failed to generate synthesis');
    } finally {
      setIsGeneratingAggregate(false);
    }
  };

  const handleGenerateFollowup = async () => {
    if (operationPending || !aggregateSynthesis) {
      alert('Generate aggregate analysis first');
      return;
    }

    setIsGeneratingFollowup(true);
    try {
      const response = await fetch(`/api/studies/${studyId}/generate-followup`, {
        method: 'POST',
      });

      const data = await response.json().catch(() => ({})) as {
        error?: string;
        code?: string;
        followUpConfig?: unknown;
      };
      if (isStudyOperationPending(response, data)) {
        setOperationPending(true);
        return;
      }
      if (!response.ok) {
        throw new Error(data.error || 'Failed to generate follow-up study');
      }

      // Store prefill config in sessionStorage and navigate to setup
      sessionStorage.setItem('prefillStudyConfig', JSON.stringify(data.followUpConfig));
      router.push('/setup?prefill=followup');
    } catch (error) {
      console.error('Error generating follow-up study:', error);
      alert(error instanceof Error ? error.message : 'Failed to generate follow-up study');
    } finally {
      setIsGeneratingFollowup(false);
    }
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const formatDuration = (start: number, end: number) => {
    const minutes = Math.round((end - start) / 1000 / 60);
    return `${minutes} min`;
  };

  const handleTbodyKeyDown = (event: React.KeyboardEvent<HTMLTableSectionElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-row-primary]')
    );
    const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (currentIndex === -1) return;
    const nextIndex = event.key === 'ArrowDown' ? currentIndex + 1 : currentIndex - 1;
    if (nextIndex < 0 || nextIndex >= buttons.length) return;
    event.preventDefault();
    buttons[nextIndex]?.focus();
  };

  if (loading) {
    return <p className="py-16 font-sans text-[15px] text-ink-500">Loading…</p>;
  }

  if (!study) {
    return (
      <div className="max-w-measure">
        {operationPending ? (
          <>
            <h2 className="font-sans text-[18px] font-semibold text-ink-900">Study change pending</h2>
            <p className="mt-2 font-sans text-[15px] text-ink-700">A study operation is already in progress.</p>
            <Button
              type="button"
              variant="quiet"
              onClick={() => void runReconciliation()}
              disabled={isReconciling}
              className="mt-4"
            >
              {isReconciling ? 'Reconciling…' : 'Reconcile'}
            </Button>
          </>
        ) : storageUnavailable ? (
          <>
            <h2 className="font-sans text-[18px] font-semibold text-ink-900">Workspace unavailable</h2>
            <p className="mt-2 font-sans text-[15px] text-ink-700">{storageUnavailable}</p>
          </>
        ) : (
          <>
            <h2 className="font-sans text-[18px] font-semibold text-ink-900">Study Not Found</h2>
            <p className="mt-2 font-sans text-[15px] text-ink-700">The study you&apos;re looking for doesn&apos;t exist.</p>
          </>
        )}
        <Button variant="quiet" onClick={() => router.push('/studies')} className="mt-3">
          Back to Studies
        </Button>
      </div>
    );
  }

  const tabs: { id: TabType; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'interviews', label: 'Interviews' },
    { id: 'settings', label: 'Study settings' }
  ];

  const aggregateSaved = aggregateSynthesis?.savedAt !== undefined;
  const aggregateIsStale = Boolean(
    study && aggregateSynthesis && aggregateSynthesis.studyRevision !== study.revision,
  );
  const aggregateNote = (() => {
    if (!aggregateSynthesis) return undefined;
    if (!aggregateSaved) return 'not saved — regenerate to refresh';
    const facts: string[] = [];
    if (aggregateSynthesis.interviewCount < eligibleInterviewCount) {
      facts.push(`covers ${aggregateSynthesis.interviewCount} of ${eligibleInterviewCount} interviews`);
    }
    if (aggregateIsStale) facts.push(`study is now rev ${study!.revision}`);
    return facts.length > 0 ? facts.join(' · ') : undefined;
  })();

  return (
    <div>
      {/* Header */}
      <div className="mb-8">
        <h1 className="break-words font-sans text-[24px] font-semibold leading-[32px] text-ink-900">
          {study.config.name}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="font-sans text-[13px] text-ink-500">
            {study.interviewCount} interview{study.interviewCount !== 1 ? 's' : ''}
            {pendingAnalysisInterviews.length > 0 ? ` · ${pendingAnalysisInterviews.length} awaiting analysis` : ''}
          </span>
          <Coordinate>Created {formatDate(study.createdAt)}</Coordinate>
          <span className={`font-sans text-[13px] ${study.isLocked ? 'text-ink-500' : 'text-success'}`}>
            {study.isLocked ? 'Locked' : 'Editable'}
          </span>
        </div>
      </div>

      {operationPending && (
        <Notice tone="error" eyebrow="Pending reconciliation" role="status" className="mb-6">
          <p className="mt-1 text-[13px] text-ink-700">A study operation is already in progress.</p>
          <Button
            type="button"
            variant="quiet"
            onClick={() => void runReconciliation()}
            disabled={isReconciling}
            className="mt-2"
          >
            Reconcile
          </Button>
        </Notice>
      )}

      <Tabs items={tabs} value={activeTab} onValueChange={setActiveTab} label="Study sections" className="mb-8 grid-cols-3">
      {activeTab === 'overview' && (
        <div>
          <Label>Research Question</Label>
          <p className="mt-2 max-w-measure font-sans text-[17px] leading-[28px] text-ink-900">
            {study.config.researchQuestion}
          </p>
          <Rule className="my-8" />

          <div
            role="group"
            aria-label="Study summary"
            className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4"
          >
            <div className="border-t border-ink-300 py-4">
              <Coordinate className="block text-[28px] leading-[36px] text-ink-900">
                {study.interviewCount}
              </Coordinate>
              <Label className="mt-1 block">Interviews</Label>
            </div>
            <div className="border-t border-ink-300 py-4">
              <Coordinate className="block text-[28px] leading-[36px] text-ink-900">
                {study.config.coreQuestions.length}
              </Coordinate>
              <Label className="mt-1 block">Core Questions</Label>
            </div>
            <div className="border-t border-ink-300 py-4">
              <Coordinate className="block text-[28px] leading-[36px] text-ink-900">
                {study.config.topicAreas.length}
              </Coordinate>
              <Label className="mt-1 block">Topic Areas</Label>
            </div>
          </div>

          <Rule className="my-8" />

          <ConductingModelsNotice conductingModels={conductingModels} recordedModelCount={recordedModelCount} />

          <section>
            <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
              <h3 className="font-sans text-[15px] font-semibold text-ink-900">Aggregate Analysis</h3>
              <Button
                variant="primary"
                onClick={handleGenerateAggregateSynthesis}
                disabled={operationPending || isGeneratingAggregate || eligibleInterviewCount < 2}
                className="w-full sm:w-auto"
              >
                {isGeneratingAggregate
                  ? 'Analyzing...'
                  : aggregateSynthesis ? 'Re-analyze All Interviews' : 'Analyze All Interviews'}
              </Button>
            </div>

            {aggregateSynthesis ? (
              <div className="mt-6 space-y-6">
                <AggregateReading
                  synthesis={aggregateSynthesis}
                  interviewIndex={interviewIndex}
                  openNotes={aggregateOpenNotes}
                  onNoteOpenChange={(themeIndex, refIndex, next) =>
                    setAggregateOpenNotes((prev) => ({ ...prev, [`${themeIndex}:${refIndex}`]: next }))
                  }
                />

                <div className="border-t border-ink-300 pt-4">
                  <Button
                    variant="quiet"
                    onClick={handleGenerateFollowup}
                    disabled={operationPending || isGeneratingFollowup || aggregateIsStale}
                  >
                    {isGeneratingFollowup ? 'Generating...' : 'Create Follow-up Study'}
                  </Button>
                  <p className="mt-2 text-[13px] text-ink-500">
                    {aggregateIsStale
                      ? `Re-analyze first: this analysis was made at study rev ${aggregateSynthesis.studyRevision} and the study is now at rev ${study!.revision}.`
                      : 'Generate a new study based on gaps and patterns found in this analysis.'}
                  </p>
                </div>

                <ProvenanceFooter
                  model={aggregateSynthesis.aiModel}
                  studyRevision={aggregateSynthesis.studyRevision}
                  timestamp={
                    Number.isFinite(aggregateSaved ? aggregateSynthesis.savedAt : aggregateSynthesis.generatedAt)
                      ? formatDate((aggregateSaved ? aggregateSynthesis.savedAt : aggregateSynthesis.generatedAt)!)
                      : 'time unrecorded'
                  }
                  verb={aggregateSaved ? 'saved' : 'generated'}
                  note={aggregateNote}
                />
              </div>
            ) : eligibleInterviewCount < 2 ? (
              <p className="mt-3 text-[13px] text-ink-500">
                Need at least 2 analyzed interviews to generate aggregate analysis.
              </p>
            ) : (
              <p className="mt-3 text-[13px] text-ink-500">
                Click &quot;Analyze All Interviews&quot; to generate cross-interview insights.
              </p>
            )}
          </section>
        </div>
      )}

      {activeTab === 'interviews' && (
        interviews.length === 0 ? (
          <div className="max-w-measure">
            <h3 className="font-sans text-[18px] font-semibold text-ink-900">No Interviews Yet</h3>
            <p className="mt-2 font-sans text-[15px] text-ink-700">
              Share the participant link to start collecting interviews.
            </p>
          </div>
        ) : (
          <div>
            <ConductingModelsNotice conductingModels={conductingModels} recordedModelCount={recordedModelCount} />

            {pendingAnalysisInterviews.length > 0 && (
              <div className="mb-4">
                <Button
                  type="button"
                  variant="primary"
                  onClick={() => void handleAnalyzeBatch()}
                  disabled={operationPending || isBatchAnalyzing}
                >
                  {isBatchAnalyzing && batchProgress
                    ? `Analyzing ${batchProgress.done} of ${batchProgress.total}…`
                    : `Analyze ${Math.min(pendingAnalysisInterviews.length, ANALYSIS_BATCH_LIMIT)} pending`}
                </Button>
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-ink-300">
                    <th scope="col" className="px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500">
                      ID
                    </th>
                    <th scope="col" className="px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500">
                      Participant
                    </th>
                    <th
                      scope="col"
                      className="hidden px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500 sm:table-cell"
                    >
                      Started
                    </th>
                    <th
                      scope="col"
                      className="hidden px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500 md:table-cell"
                    >
                      Duration
                    </th>
                    <th
                      scope="col"
                      className="hidden px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500 md:table-cell"
                    >
                      Turns
                    </th>
                    <th
                      scope="col"
                      className="hidden px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500 md:table-cell"
                    >
                      Conducted
                    </th>
                    <th
                      scope="col"
                      className="hidden px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500 md:table-cell"
                    >
                      Synthesized
                    </th>
                    <th
                      scope="col"
                      className="hidden px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500 md:table-cell"
                    >
                      Analysis
                    </th>
                  </tr>
                </thead>
                <tbody onKeyDown={handleTbodyKeyDown}>
                  {interviews.map((interview, index) => {
                    const extractedFields = (interview.participantProfile?.fields ?? [])
                      .filter(f => f.status === 'extracted' && f.value)
                      .slice(0, 3)
                      .map(f => f.value)
                      .join(' • ');
                    // Stable under append (Ruling 2): the row's number is the
                    // participant number, not the newest-first array position.
                    const participantNumber = interviewIndex.get(interview.id)?.participantNumber ?? index + 1;
                    return (
                      <tr
                        key={interview.id}
                        className="border-b border-ink-200 hover:bg-paper-1"
                        onClick={() => router.push(`/dashboard/interview/${interview.id}?studyId=${encodeURIComponent(studyId)}`)}
                      >
                        <td className="px-3 py-3 align-top text-[13px] text-ink-700">
                          <Coordinate>{shortInterviewId(interview.id)}</Coordinate>
                        </td>
                        <td className="px-3 py-3 align-top text-[13px] text-ink-700">
                          <button
                            type="button"
                            data-row-primary
                            aria-label={`View interview ${participantNumber}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              router.push(`/dashboard/interview/${interview.id}?studyId=${encodeURIComponent(studyId)}`);
                            }}
                            className="text-left font-sans text-[14px] font-medium text-ink-900 underline-offset-2 hover:text-action hover:underline"
                          >
                            {extractedFields || `Interview ${participantNumber}`}
                          </button>
                          {interview.synthesis?.bottomLine && (
                            <p className="line-clamp-1 text-[13px] text-ink-500">{interview.synthesis.bottomLine}</p>
                          )}
                        </td>
                        <td className="hidden px-3 py-3 align-top text-[13px] text-ink-700 sm:table-cell">
                          <Coordinate>{formatDate(interview.createdAt)}</Coordinate>
                        </td>
                        <td className="hidden px-3 py-3 align-top text-[13px] text-ink-700 md:table-cell">
                          <Coordinate>{formatDuration(interview.createdAt, interview.completedAt)}</Coordinate>
                        </td>
                        <td className="hidden px-3 py-3 align-top text-[13px] text-ink-700 md:table-cell">
                          <Coordinate>{interview.transcript.length}</Coordinate>
                        </td>
                        <td className="hidden px-3 py-3 align-top text-[13px] text-ink-700 md:table-cell">
                          <Coordinate>{interview.conductedByModel ?? 'not recorded'}</Coordinate>
                        </td>
                        <td className="hidden px-3 py-3 align-top text-[13px] text-ink-700 md:table-cell">
                          <Coordinate>{interview.aiModel ?? 'not recorded'}</Coordinate>
                        </td>
                        <td className="hidden px-3 py-3 align-top text-[13px] text-ink-700 md:table-cell">
                          {analysisCellContent(interview)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )
      )}

      {activeTab === 'settings' && (
        <div className="space-y-8">
          {study.interviewCount > 0 && (
            <Notice tone="neutral" eyebrow={`${study.interviewCount} interview${study.interviewCount > 1 ? 's' : ''} collected`}>
              <p className="mt-1 text-[13px] text-ink-700">
                This study has collected data. Editing is allowed but may affect consistency with existing responses.
              </p>
            </Notice>
          )}

          {/* Study Config Display */}
          <dl className="divide-y divide-ink-300 border-t border-ink-300">
            <div className="grid grid-cols-1 gap-1 py-4 md:grid-cols-[12rem_1fr] md:gap-6">
              <dt>
                <Label>Study Name</Label>
              </dt>
              <dd className="font-sans text-[15px] leading-[24px] text-ink-900">{study.config.name}</dd>
            </div>

            <div className="grid grid-cols-1 gap-1 py-4 md:grid-cols-[12rem_1fr] md:gap-6">
              <dt>
                <Label>Description</Label>
              </dt>
              <dd className="font-sans text-[15px] leading-[24px] text-ink-900">
                {study.config.description || 'No description'}
              </dd>
            </div>

            <div className="grid grid-cols-1 gap-1 py-4 md:grid-cols-[12rem_1fr] md:gap-6">
              <dt>
                <Label>Research Question</Label>
              </dt>
              <dd className="font-sans text-[15px] leading-[24px] text-ink-900">{study.config.researchQuestion}</dd>
            </div>

            <div className="grid grid-cols-1 gap-1 py-4 md:grid-cols-[12rem_1fr] md:gap-6">
              <dt>
                <Label>{`Core Questions (${study.config.coreQuestions.length})`}</Label>
              </dt>
              <dd className="font-sans text-[15px] leading-[24px] text-ink-900">
                <ul>
                  {study.config.coreQuestions.map((q, i) => (
                    <li key={i} className="border-l-2 border-ink-300 pl-4">
                      {q}
                    </li>
                  ))}
                </ul>
              </dd>
            </div>

            <div className="grid grid-cols-1 gap-1 py-4 md:grid-cols-[12rem_1fr] md:gap-6">
              <dt>
                <Label>{`Topic Areas (${study.config.topicAreas.length})`}</Label>
              </dt>
              <dd className="font-sans text-[15px] leading-[24px] text-ink-900">
                <ul>
                  {study.config.topicAreas.map((topic, i) => (
                    <li key={i} className="border-t border-ink-300 py-1.5 text-[15px] text-ink-700">
                      {topic}
                    </li>
                  ))}
                </ul>
              </dd>
            </div>

            <div className="grid grid-cols-1 gap-1 py-4 md:grid-cols-[12rem_1fr] md:gap-6">
              <dt>
                <Label>AI Interview Style</Label>
              </dt>
              <dd className="font-sans text-[15px] leading-[24px] capitalize text-ink-900">{study.config.aiBehavior}</dd>
            </div>
          </dl>

          {/* Link Management */}
          <div>
            <h3 className="font-sans text-[15px] font-semibold text-ink-900">Link Management</h3>

            <div className="mt-4 flex flex-col items-start gap-3 border-y border-ink-300 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-sans text-[15px] font-medium text-ink-900">Participant Access</p>
                <p id="participant-access-status" className="text-[13px] text-ink-500">
                  {(study.config.linksEnabled ?? true)
                    ? 'Access enabled - participants can use the link below'
                    : 'Access disabled - the same link will show an error until re-enabled'}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-label="Participant access"
                aria-checked={study.config.linksEnabled ?? true}
                aria-describedby="participant-access-status"
                onClick={handleToggleLinksEnabled}
                disabled={operationPending || isTogglingLinks}
                className="min-h-11 shrink-0 disabled:opacity-50"
              >
                <Coordinate
                  className={`rounded border px-2 py-1 ${
                    (study.config.linksEnabled ?? true) ? 'border-ink-500 text-ink-900' : 'border-ink-300 text-ink-500'
                  }`}
                >
                  {(study.config.linksEnabled ?? true) ? 'ENABLED' : 'DISABLED'}
                </Coordinate>
              </button>
            </div>

            {study.config.linkExpiration && study.config.linkExpiration !== 'never' && (
              <p className="mt-3 text-[13px] text-ink-500">
                Links expire: {study.config.linkExpiration === '7days' ? '7 days' : study.config.linkExpiration === '30days' ? '30 days' : '90 days'} after generation
              </p>
            )}

            {!(study.config.linksEnabled ?? true) && (
              <Notice tone="error" className="mt-3">
                <p className="text-[13px] text-ink-700">
                  Warning: All participant links are currently disabled. Participants trying to access the study will see an error message.
                </p>
              </Notice>
            )}

            <div className="mt-6 border-t border-ink-300 pt-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h4 className="font-sans text-[15px] font-medium text-ink-900">Generated links</h4>
                  <p className="text-[13px] text-ink-500">
                    Only dates and status are retained here. Link URLs cannot be viewed again after creation.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void loadParticipantLinks()}
                  disabled={linksLoading}
                  aria-label="Refresh participant links"
                  className="min-h-11 font-sans text-[13px] text-ink-500 hover:text-ink-900 disabled:opacity-50"
                >
                  Refresh
                </button>
              </div>

              {linksError ? (
                <Notice tone="error" className="mt-3 flex items-center justify-between gap-3">
                  <p className="text-[13px] text-ink-700">{linksError}</p>
                  <button
                    type="button"
                    onClick={() => void loadParticipantLinks()}
                    className="text-[13px] text-error hover:text-ink-900"
                  >
                    Retry
                  </button>
                </Notice>
              ) : linksLoading ? (
                <p className="mt-3 text-[13px] text-ink-500">Loading generated links…</p>
              ) : participantLinks.length === 0 ? (
                <p className="mt-3 text-[13px] text-ink-500">No generated links for this study yet.</p>
              ) : (
                <div>
                  {participantLinks.map((link) => {
                    const expired = link.expiresAt !== null && link.expiresAt <= linksLoadedAt;
                    const replaced = link.studyRevision !== study.revision;
                    const status = link.revokedAt !== null
                      ? 'Revoked'
                      : expired
                        ? 'Expired'
                        : replaced
                          ? 'Replaced by study edit'
                          : (study.config.linksEnabled ?? true)
                            ? 'Active'
                            : 'Globally disabled';
                    const canRevoke = link.revokedAt === null && !expired;

                    return (
                      <div
                        key={link.id}
                        className="flex flex-col gap-2 border-t border-ink-300 py-3 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2 text-[13px]">
                            <span className="text-ink-700">Created {formatDate(link.createdAt)}</span>
                            <span className={status === 'Active' ? 'text-success' : 'text-ink-500'}>{status}</span>
                          </div>
                          <Coordinate className="mt-1 block">
                            {link.expiresAt === null
                              ? 'No scheduled expiry'
                              : `Expires ${formatDate(link.expiresAt)}`}
                            {' · '}Study revision {link.studyRevision}
                          </Coordinate>
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleRevokeLink(link)}
                          disabled={operationPending || !canRevoke || revokingLinkId === link.id}
                          aria-label={`Revoke participant link created ${formatDate(link.createdAt)}`}
                          className="min-h-11 font-sans text-[13px] text-error hover:text-ink-900 disabled:opacity-40"
                        >
                          Revoke
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Participant Link Generator */}
          <div>
            <h3 className="font-sans text-[15px] font-semibold text-ink-900">Participant Link</h3>

            <div className="mt-4 space-y-4">
              <Button
                variant="primary"
                onClick={handleGenerateLink}
                disabled={operationPending || generatingLink || !(study.config.linksEnabled ?? true)}
              >
                Generate New Link
              </Button>

              {participantLink && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={participantLink}
                      readOnly
                      className="min-w-0 flex-1 rounded border border-ink-300 bg-paper-2 px-3 py-2 font-mono text-[13px] text-ink-900"
                    />
                    <Button variant="quiet" onClick={handleCopyLink} className="inline-flex items-center gap-2">
                      <Icon name={copied ? 'check' : 'copy'} />
                      <span>{copied ? 'Copied!' : 'Copy'}</span>
                    </Button>
                  </div>
                  <Notice tone="error">
                    <p className="text-[13px] text-ink-700">
                      Copy this link now. For security, its URL cannot be recovered from the generated-links list.
                    </p>
                  </Notice>
                </div>
              )}

              <p className="text-[13px] text-ink-500">
                Each click generates a new unique link. All links share the same enable/disable toggle above.
                {!(study.config.linksEnabled ?? true) && ' Links are currently disabled - enable access above first.'}
              </p>
            </div>
          </div>
        </div>
      )}
      </Tabs>
    </div>
  );
};

export default StudyDetail;
