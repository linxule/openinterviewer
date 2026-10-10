'use client';

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { StoredStudy, StoredInterview, AggregateSynthesisResult } from '@/types';
import type { ParticipantLinkMetadata } from '@/lib/participantLinks';
import {
  readStudy,
  readStudyAggregate,
  readStudyInterviews,
  deleteStudy,
  exportAllInterviewsChecked,
  exportStudyTranscriptsChecked,
  reconcileStudyOperations,
  type ResearcherStorageFailure,
} from '@/services/storageService';
import type { DatasetDescription, DatasetSelection } from '@/lib/exploration/types';
import { StudyDatasetSelector, DatasetCoverage } from '@/components/StudyDatasetSelector';
import { StudyExploration } from '@/components/StudyExploration';
import { loadAnalysisExecution } from '@/services/analysisExecution';
import { Button, Coordinate, Icon, Label, Notice, Rule, Tabs } from '@/components/ui';
import { AggregateReading, ProvenanceFooter } from '@/components/SynthesisReading';
import { shortInterviewId } from '@/lib/interviewId';
import { buildAggregateInterviewIndex } from '@/lib/evidence';
import {
  analysisStatus,
  confirmedAnalysisFromRecord,
  hasScheduledAnalysis,
  isAwaitingAnalysis,
  needsAnalysisRecovery,
} from '@/lib/analysisState';
import { useSetTrailingCrumb } from '@/components/shell/breadcrumb';
import { AnalysisActionKeys } from '@/components/analysis/actionKeys';
import {
  runAnalysisBatch,
  type AnalysisBatchProgress,
  type AnalysisBatchStopReason,
} from '@/components/analysis/analysisBatch';

interface StudyDetailProps {
  studyId: string;
}

type TabType = 'overview' | 'explore' | 'interviews' | 'settings';

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
  if (needsAnalysisRecovery(interview)) return <span className="text-error">needs recovery</span>;
  if (status === 'failed') return <span className="text-error">analysis failed</span>;
  if (hasScheduledAnalysis(interview)) {
    return <span className="text-ink-700">{status === 'running' ? 'analysis running' : 'analysis queued'}</span>;
  }
  return <span className="text-ink-900">awaiting analysis</span>;
}

function batchCounts(progress: AnalysisBatchProgress) {
  const failed = progress.failed > 0 ? ` · ${progress.failed} failed` : '';
  return `${progress.finished} of ${progress.total} finished${failed}`;
}

function scheduledCount(count: number) {
  return `Analysis queued or running for ${count} interview${count === 1 ? '' : 's'}. It finishes in the background and is not part of the batch.`;
}

function recoveryDisclosure(count: number) {
  return count === 1
    ? '1 interview in this batch is saved, but we could not confirm its earlier analysis result. Running the batch analyzes it again, which may make another paid provider request.'
    : `${count} interviews in this batch are saved, but we could not confirm their earlier analysis results. Running the batch analyzes them again, which may make another paid provider request for each.`;
}

function isStudyOperationPending(response: Response, data: { code?: string }) {
  return response.status === 409 && (data.code === 'STUDY_OPERATION_PENDING' || data.code === 'STUDY_DELETION_PENDING');
}

function storageFailureCopy(failure: ResearcherStorageFailure): string {
  return failure.status === 'unauthorized'
    ? 'Your researcher session has ended. Sign in again to continue.'
    : failure.error;
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
  // Why a read did not confirm what the page shows (UI-CF-02/04): the study
  // itself, the interview list (nothing listed), the aggregate, or a refresh
  // that kept the state already on screen.
  const [studyFailure, setStudyFailure] = useState<ResearcherStorageFailure | null>(null);
  const [listFailure, setListFailure] = useState<string | null>(null);
  const [aggregateFailure, setAggregateFailure] = useState<string | null>(null);
  const [refreshFailure, setRefreshFailure] = useState<string | null>(null);
  const [isReconciling, setIsReconciling] = useState(false);
  const [datasetSelection, setDatasetSelection] = useState<DatasetSelection | undefined>();
  const [selectedDataset, setSelectedDataset] = useState<DatasetDescription | null>(null);
  const [choosingDataset, setChoosingDataset] = useState(false);
  const [explorationVisited, setExplorationVisited] = useState(false);
  useEffect(() => { if (activeTab === 'explore') setExplorationVisited(true); }, [activeTab]);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [isExportingTranscripts, setIsExportingTranscripts] = useState(false);
  const [deleteStep, setDeleteStep] = useState<0 | 1 | 2>(0);
  const [deleteRevision, setDeleteRevision] = useState<number | null>(null);
  const [deleteAcknowledged, setDeleteAcknowledged] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const activeStudyId = useRef(studyId);
  useEffect(() => { activeStudyId.current = studyId; }, [studyId]);
  const readGeneration = useRef(0);
  const linkGeneration = useRef(0);

  useEffect(() => {
    const syncLocation = () => {
      const tab = new URLSearchParams(window.location.search).get('tab');
      if (tab === 'settings' || tab === 'overview' || tab === 'interviews' || tab === 'explore') setActiveTab(tab);
    };
    syncLocation();
    window.addEventListener('popstate', syncLocation);
    window.addEventListener('hashchange', syncLocation);
    return () => { window.removeEventListener('popstate', syncLocation); window.removeEventListener('hashchange', syncLocation); };
  }, [studyId]);

  useEffect(() => {
    if (activeTab === 'settings' && study && window.location.hash === '#danger-zone') {
      const element = document.getElementById('danger-zone');
      element?.scrollIntoView?.({ block: 'start' });
      element?.focus({ preventScroll: true });
    }
  }, [activeTab, study]);

  useSetTrailingCrumb(study?.config.name ?? null);

  // Stable participant numbering (ascending createdAt, id tiebreak) — the
  // record every aggregate citation is checked against, and per Ruling 2 the
  // source of the register's row number below (not the newest-first index).
  const interviewIndex = useMemo(() => buildAggregateInterviewIndex(interviews), [interviews]);

  const currentRevisionAnalyzedCount = useMemo(
    () => study ? interviews.filter(interview => interview.studyRevision === study.revision && interview.synthesis).length : 0,
    [interviews, study],
  );
  const olderInterviewCount = study ? interviews.filter(interview => interview.studyRevision !== study.revision).length : 0;
  const eligibleInterviewCount = selectedDataset
    ? interviews.filter(interview => interview.synthesis && selectedDataset.manifest.sources.some(source => source.interviewId === interview.id)).length
    : currentRevisionAnalyzedCount;
  const applyDataset = (selection: DatasetSelection, description: DatasetDescription) => {
    setDatasetSelection(selection); setSelectedDataset(description);
  };

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
  // Durable work already queued or running is only counted: a batch requests
  // unscheduled, failed and recovery-required interviews (F8). Node records
  // never carry a generation, so their selection is unchanged.
  const scheduledAnalysisCount = useMemo(
    () => pendingAnalysisInterviews.filter(hasScheduledAnalysis).length,
    [pendingAnalysisInterviews],
  );
  const batchSelection = useMemo(
    () => pendingAnalysisInterviews.filter((interview) => !hasScheduledAnalysis(interview)).slice(0, ANALYSIS_BATCH_LIMIT),
    [pendingAnalysisInterviews],
  );
  // Recovery-required interviews may cost another paid request; the batch
  // action must disclose that before it is pressed (UI-CF-04).
  const recoveryInBatch = batchSelection.filter(needsAnalysisRecovery).length;
  const recoveryDisclosureId = useId();
  const aggregateRequirementId = useId();
  const [isBatchAnalyzing, setIsBatchAnalyzing] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);
  const [batchError, setBatchError] = useState<{ message: string; reason: AnalysisBatchStopReason } | null>(null);
  const [batchStillPending, setBatchStillPending] = useState<string | null>(null);
  const [batchStatus, setBatchStatus] = useState('');
  const [batchKeys] = useState(() => new AnalysisActionKeys());
  const batchAbortRef = useRef<AbortController | null>(null);

  // Leaving the study (or the page) stops observing; server work carries on.
  useEffect(() => {
    const batches = batchAbortRef;
    batchKeys.clear();
    setIsBatchAnalyzing(false);
    setBatchProgress(null);
    setBatchError(null);
    setBatchStillPending(null);
    setBatchStatus('');
    return () => {
      batches.current?.abort();
      batches.current = null;
    };
  }, [studyId, batchKeys]);

  const loadParticipantLinks = useCallback(async () => {
    const generation = ++linkGeneration.current;
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
      if (generation !== linkGeneration.current) return;
      if (isStudyOperationPending(response, data)) {
        setOperationPending(true);
        if (data.code === 'STUDY_DELETION_PENDING') setDeletePending(true);
        setParticipantLinks([]);
        return;
      }
      if (!response.ok) {
        throw new Error(data.error || 'Failed to load participant links');
      }
      setParticipantLinks(Array.isArray(data.links) ? data.links : []);
      setLinksLoadedAt(Date.now());
    } catch (error) {
      if (generation !== linkGeneration.current) return;
      console.error('Error loading participant links:', error);
      setLinksError(error instanceof Error ? error.message : 'Failed to load participant links');
    } finally {
      if (generation === linkGeneration.current) setLinksLoading(false);
    }
  }, [studyId]);

  // A full load commits each read that succeeded and names each one that did
  // not. A quiet reload (after a batch) commits the study and its register only
  // when both reads succeed; otherwise it keeps everything on screen and says
  // it could not refresh (UI-CF-04). A pending study operation commits nothing.
  const loadStudyData = useCallback(async (options?: { quiet?: boolean }) => {
    const generation = ++readGeneration.current;
    const quiet = options?.quiet === true;
    if (!quiet) setLoading(true);
    try {
      const [studyRead, listRead, aggregateRead] = await Promise.all([
        readStudy(studyId),
        readStudyInterviews(studyId),
        readStudyAggregate(studyId),
      ]);
      if (generation !== readGeneration.current) return;
      const pending = [studyRead, listRead, aggregateRead].some((read) => read.status === 'pending');
      if (pending) setOperationPending(true);
      if ([studyRead, listRead, aggregateRead].some(read => read.status === 'pending' && (read as { code?: string }).code === 'STUDY_DELETION_PENDING')) setDeletePending(true);
      if (pending) return;

      if (quiet) {
        if (studyRead.status !== 'ok' || listRead.status !== 'ok') {
          const failure = studyRead.status !== 'ok' ? studyRead : listRead;
          if (failure.status !== 'ok' && failure.status !== 'pending') setRefreshFailure(storageFailureCopy(failure));
          return;
        }
        setStudy(studyRead.value);
        setInterviews(listRead.value);
        setListFailure(null);
        setRefreshFailure(null);
        if (aggregateRead.status === 'ok') {
          setAggregateSynthesis(aggregateRead.value);
          setAggregateOpenNotes({});
          setAggregateFailure(null);
        }
        return;
      }

      setRefreshFailure(null);
      if (studyRead.status !== 'ok') {
        setStudy(null);
        setStudyFailure(studyRead);
        return;
      }
      setStudy(studyRead.value);
      setStudyFailure(null);
      setInterviews(listRead.status === 'ok' ? listRead.value : []);
      setListFailure(listRead.status === 'ok' ? null : storageFailureCopy(listRead));
      setAggregateSynthesis(aggregateRead.status === 'ok' ? aggregateRead.value : null);
      setAggregateFailure(aggregateRead.status === 'ok' ? null : storageFailureCopy(aggregateRead));
      setAggregateOpenNotes({});
    } finally {
      if (!quiet && generation === readGeneration.current) setLoading(false);
    }
  }, [studyId]);

  const handleAnalyzeBatch = async () => {
    if (operationPending || isBatchAnalyzing) return;
    const batch = batchSelection;
    if (batch.length === 0) return;
    const controller = new AbortController();
    batchAbortRef.current = controller;
    setIsBatchAnalyzing(true);
    setBatchError(null);
    setBatchStillPending(null);
    setBatchProgress({ done: 0, total: batch.length });
    setBatchStatus(`Analyzing ${batch.length} interview${batch.length === 1 ? '' : 's'}.`);
    try {
      const mode = await loadAnalysisExecution();
      if (controller.signal.aborted) return;
      const items = batch.map((interview, index) => ({
        interviewId: interview.id,
        label: `Interview ${interviewIndex.get(interview.id)?.participantNumber ?? index + 1}`,
        confirmed: confirmedAnalysisFromRecord(interview),
      }));
      const onProgress = (progress: AnalysisBatchProgress) => {
        setBatchProgress({ done: progress.finished, total: progress.total });
        setBatchStatus(`${batchCounts(progress)}.`);
      };
      // `unknown` runs the legacy way: a durable server refuses it before any work.
      const result = mode === 'queued-v2'
        ? await runAnalysisBatch({ protocol: 'queued-v2', keys: batchKeys, studyId, items, signal: controller.signal, onProgress })
        : await runAnalysisBatch({ protocol: 'synchronous', studyId, items, signal: controller.signal, onProgress });
      if (result.kind === 'cancelled' || controller.signal.aborted) return;

      if (result.kind === 'stopped') {
        setBatchError({ message: result.error, reason: result.reason });
        setBatchStatus(`Batch stopped: ${batchCounts(result.progress)}.`);
        if (result.reason === 'pending') setOperationPending(true);
        // Retain the loaded register and its error during an outage: a
        // follow-up read could fail too. Only a changed state is re-read.
        if (result.reason === 'state-changed') await loadStudyData({ quiet: true });
        return;
      }
      if (result.kind === 'awaiting') {
        // Accepted work is never counted as analyzed, and nothing after it was requested.
        setBatchStillPending(result.item.label);
        setBatchStatus(`Batch stopped: ${batchCounts(result.progress)}. ${result.item.label} is still pending.`);
      } else {
        setBatchStatus(`Batch complete: ${batchCounts(result.progress)}.`);
      }
      await loadStudyData({ quiet: true });
    } finally {
      if (batchAbortRef.current === controller) batchAbortRef.current = null;
      if (!controller.signal.aborted) {
        setIsBatchAnalyzing(false);
        setBatchProgress(null);
      }
    }
  };

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
    setOperationPending(false); setDeletePending(false); setDeleteStep(0); setExplorationVisited(false);
    setIsTogglingLinks(false); setIsGeneratingAggregate(false); setIsGeneratingFollowup(false);
    setIsExporting(false); setIsDeleting(false); setGeneratingLink(false); setParticipantLink(null); setCopied(false);
    setSelectedDataset(null); setDatasetSelection(undefined); setLifecycleError(null);
    void loadStudyData();
    return () => { readGeneration.current += 1; };
  }, [loadStudyData]);

  useEffect(() => {
    setParticipantLinks([]);
    void loadParticipantLinks();
    return () => { linkGeneration.current += 1; };
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

      const data = await response.json().catch(() => ({})) as { code?: string; error?: string; study?: StoredStudy };
      if (activeStudyId.current !== studyId) return;
      if (isStudyOperationPending(response, data)) {
        setOperationPending(true);
        if (data.code === 'STUDY_DELETION_PENDING') setDeletePending(true);
        return;
      }
      if (!response.ok) {
        throw new Error(data.error || 'Failed to update study');
      }

      if (!data.study || data.study.id !== studyId || !data.study.config || !Number.isSafeInteger(data.study.revision)) {
        throw new Error('The updated study could not be confirmed. Refresh before changing access again.');
      }
      setStudy(data.study);
      setLifecycleError(null);
    } catch (error) {
      if (activeStudyId.current !== studyId) return;
      console.error('Error toggling links:', error);
      setLifecycleError(error instanceof Error ? error.message : 'Failed to update participant access.');
    } finally {
      if (activeStudyId.current === studyId) setIsTogglingLinks(false);
    }
  };

  const handleGenerateLink = async () => {
    if (!study || operationPending) return;

    setGeneratingLink(true);
    try {
      // The server mints links for the saved study it loads itself; only the
      // id identifies it (the route ignores every other field).
      const response = await fetch('/api/generate-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studyConfig: { id: study.config.id } })
      });

      const data = await response.json().catch(() => ({})) as { error?: string; code?: string; url?: string };
      if (activeStudyId.current !== studyId) return;
      if (isStudyOperationPending(response, data)) {
        setOperationPending(true);
        if (data.code === 'STUDY_DELETION_PENDING') setDeletePending(true);
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
      if (activeStudyId.current !== studyId) return;
      console.error('Error generating link:', error);
      alert(error instanceof Error ? error.message : 'Failed to generate link');
    } finally {
      if (activeStudyId.current === studyId) setGeneratingLink(false);
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
      if (activeStudyId.current !== studyId) return;
      if (isStudyOperationPending(response, data)) {
        setOperationPending(true);
        if (data.code === 'STUDY_DELETION_PENDING') setDeletePending(true);
        return;
      }
      if (!response.ok) {
        throw new Error(data.error || 'Failed to revoke participant link');
      }
      await loadParticipantLinks();
    } catch (error) {
      if (activeStudyId.current !== studyId) return;
      console.error('Error revoking participant link:', error);
      alert(error instanceof Error ? error.message : 'Failed to revoke participant link');
    } finally {
      if (activeStudyId.current === studyId) setRevokingLinkId(null);
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
        body: JSON.stringify({ studyId, ...(datasetSelection ? { selection: datasetSelection } : {}) })
      });

      const data = await response.json().catch(() => ({})) as {
        error?: string;
        code?: string;
        synthesis?: AggregateSynthesisResult;
      };
      if (activeStudyId.current !== studyId) return;
      if (isStudyOperationPending(response, data)) {
        setOperationPending(true);
        if (data.code === 'STUDY_DELETION_PENDING') setDeletePending(true);
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
      if (activeStudyId.current !== studyId) return;
      console.error('Error generating aggregate synthesis:', error);
      alert(error instanceof Error ? error.message : 'Failed to generate synthesis');
    } finally {
      if (activeStudyId.current === studyId) setIsGeneratingAggregate(false);
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
      if (activeStudyId.current !== studyId) return;
      if (isStudyOperationPending(response, data)) {
        setOperationPending(true);
        if (data.code === 'STUDY_DELETION_PENDING') setDeletePending(true);
        return;
      }
      if (!response.ok) {
        throw new Error(data.error || 'Failed to generate follow-up study');
      }

      // Store prefill config in sessionStorage and navigate to setup
      sessionStorage.setItem('prefillStudyConfig', JSON.stringify(data.followUpConfig));
      router.push(`/setup?prefill=followup&studyId=${encodeURIComponent(studyId)}`);
    } catch (error) {
      if (activeStudyId.current !== studyId) return;
      console.error('Error generating follow-up study:', error);
      alert(error instanceof Error ? error.message : 'Failed to generate follow-up study');
    } finally {
      if (activeStudyId.current === studyId) setIsGeneratingFollowup(false);
    }
  };

  const handleExportStudy = async () => {
    setIsExporting(true); setLifecycleError(null);
    try {
      const outcome = await exportAllInterviewsChecked(studyId);
      if (activeStudyId.current !== studyId) return;
      if (outcome.status !== 'ok') { setLifecycleError(storageFailureCopy(outcome)); return; }
      const url = URL.createObjectURL(outcome.value);
      const link = document.createElement('a'); link.href = url; link.download = `study-${studyId}.zip`; link.click(); URL.revokeObjectURL(url);
    } catch { if (activeStudyId.current === studyId) setLifecycleError('The study export could not be confirmed.'); }
    finally { if (activeStudyId.current === studyId) setIsExporting(false); }
  };

  const handleExportTranscripts = async () => {
    setIsExportingTranscripts(true); setLifecycleError(null);
    try {
      const outcome = await exportStudyTranscriptsChecked(studyId);
      if (activeStudyId.current !== studyId) return;
      if (outcome.status !== 'ok') { setLifecycleError(storageFailureCopy(outcome)); return; }
      const url = URL.createObjectURL(outcome.value.file);
      const link = document.createElement('a'); link.href = url; link.download = outcome.value.filename; link.click(); URL.revokeObjectURL(url);
    } catch { if (activeStudyId.current === studyId) setLifecycleError('The transcript export could not be confirmed.'); }
    finally { if (activeStudyId.current === studyId) setIsExportingTranscripts(false); }
  };

  const handleDeleteStudy = async () => {
    if (isDeleting) return;
    const confirmation = study && deleteRevision !== null ? { deleteInterviews: true as const, confirmStudyId: studyId, expectedRevision: deleteRevision } : undefined;
    // A deletion-pending read is persisted proof of the earlier confirmation.
    // The bodyless retry can only resume it; otherwise legacy empty-only refusal applies.
    if (!confirmation && !deletePending) return;
    setIsDeleting(true); setLifecycleError(null);
    const result = await deleteStudy(studyId, confirmation);
    if (activeStudyId.current !== studyId) return;
    setIsDeleting(false);
    if (result.pending) { setDeletePending(true); setOperationPending(true); setLifecycleError(result.error ?? 'Deletion is pending. The study is not yet confirmed permanently deleted.'); return; }
    if (result.success) { router.push('/studies'); return; }
    setLifecycleError(result.error ?? 'The study could not be deleted. No permanent deletion was confirmed.');
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

  if (loading || (study && study.id !== studyId)) {
    return <p className="py-16 font-sans text-[15px] text-ink-500">Loading…</p>;
  }

  if (!study) {
    return (
      <div className="max-w-measure">
        {operationPending ? (
          <>
            <h2 className="font-sans text-[18px] font-semibold text-ink-900">{deletePending ? 'Permanent deletion pending' : 'Study change pending'}</h2>
            <p className="mt-2 font-sans text-[15px] text-ink-700">{deletePending ? 'A previously confirmed deletion is still in progress. Partial research data is not shown. Retrying resumes that deletion; completion has not yet been confirmed.' : 'A study operation is already in progress.'}</p>
            {lifecycleError && <Notice tone="error" role="status" className="mt-3"><p className="text-[13px]">{lifecycleError}</p></Notice>}
            <Button
              type="button"
              variant="quiet"
              onClick={() => void (deletePending ? handleDeleteStudy() : runReconciliation())}
              disabled={isReconciling || isDeleting}
              className="mt-4"
            >
              {deletePending ? isDeleting ? 'Confirming deletion…' : 'Retry deletion' : isReconciling ? 'Reconciling…' : 'Reconcile'}
            </Button>
          </>
        ) : studyFailure?.status === 'unauthorized' ? (
          <>
            <h2 className="font-sans text-[18px] font-semibold text-ink-900">Sign in required</h2>
            <p className="mt-2 font-sans text-[15px] text-ink-700">{storageFailureCopy(studyFailure)}</p>
            <Button
              type="button"
              variant="primary"
              onClick={() => router.push(`/login?redirect=${encodeURIComponent(`/studies/${studyId}`)}`)}
              className="mt-4"
            >
              Sign in
            </Button>
          </>
        ) : studyFailure && studyFailure.status !== 'not-found' ? (
          <>
            <h2 className="font-sans text-[18px] font-semibold text-ink-900">Workspace unavailable</h2>
            <p className="mt-2 font-sans text-[15px] text-ink-700">{storageFailureCopy(studyFailure)}</p>
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

  const hasCollectedData = study.isLocked || study.interviewCount > 0;
  const tabs: { id: TabType; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'explore', label: 'Explore' },
    { id: 'interviews', label: 'Interviews' },
    { id: 'settings', label: 'Study settings' }
  ];

  const aggregateSaved = aggregateSynthesis?.savedAt !== undefined;
  const aggregateIsStale = Boolean(
    study && aggregateSynthesis && !aggregateSynthesis.scope && aggregateSynthesis.studyRevision !== study.revision,
  );
  const aggregateNote = (() => {
    if (!aggregateSynthesis) return undefined;
    if (!aggregateSaved) return 'not saved — regenerate to refresh';
    const facts: string[] = [];
    if (aggregateSynthesis.interviewCount < eligibleInterviewCount) {
      facts.push(`covers ${aggregateSynthesis.interviewCount} of ${eligibleInterviewCount} interviews`);
    }
    if (aggregateSynthesis.scope) facts.push(`historical selected scope: ${aggregateSynthesis.scope.selectedCount} interviews across revisions ${[...new Set(aggregateSynthesis.scope.sources.map(source => source.studyRevision ?? 'unrecorded'))].join(', ')}`);
    if (aggregateSynthesis.studyRevision !== study.revision) facts.push(`study is now rev ${study!.revision}`);
    return facts.length > 0 ? facts.join(' · ') : undefined;
  })();

  return (
    <div>
      {/* Header */}
      <div className="mb-8">
        <h1 className="wrap-break-word font-sans text-[24px] font-semibold leading-[32px] text-ink-900">
          {study.config.name}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="font-sans text-[13px] text-ink-500">
            {study.interviewCount} interview{study.interviewCount !== 1 ? 's' : ''}
            {pendingAnalysisInterviews.length > 0 ? ` · ${pendingAnalysisInterviews.length} awaiting analysis` : ''}
          </span>
          <Coordinate>Created {formatDate(study.createdAt)}</Coordinate>
          <span className={`font-sans text-[13px] ${hasCollectedData ? 'text-ink-500' : 'text-success'}`}>
            {hasCollectedData ? 'Collected data' : 'Editable'}
          </span>
        </div>
      </div>

      {operationPending && (
        <Notice tone="error" eyebrow={deletePending ? 'Deletion pending' : 'Pending reconciliation'} role="status" className="mb-6">
          <p className="mt-1 text-[13px] text-ink-700">{deletePending ? 'Permanent deletion has not yet been confirmed. Check its progress in Study settings.' : 'A study operation is already in progress.'}</p>
          <Button
            type="button"
            variant="quiet"
            onClick={() => deletePending ? setActiveTab('settings') : void runReconciliation()}
            disabled={isReconciling}
            className="mt-2"
          >
            {deletePending ? 'View deletion status' : 'Reconcile'}
          </Button>
        </Notice>
      )}

      {refreshFailure && (
        <Notice tone="error" eyebrow="Not refreshed" role="status" className="mb-6">
          <p className="mt-1 text-[13px] text-ink-700">
            {`The study could not be refreshed, so what is shown may be out of date. ${refreshFailure}`}
          </p>
          <Button type="button" variant="quiet" onClick={() => void loadStudyData({ quiet: true })} className="mt-2">
            Try again
          </Button>
        </Notice>
      )}

      <Tabs items={tabs} value={activeTab} onValueChange={setActiveTab} label="Study sections" className="mb-8 grid-cols-2 sm:grid-cols-4">
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
                disabled={operationPending || isGeneratingAggregate || eligibleInterviewCount < 2 || !!selectedDataset?.manifest.pendingAnalysisCount}
                aria-describedby={[
                  ...(eligibleInterviewCount < 2 ? [`${aggregateRequirementId}-minimum`] : []),
                  ...(selectedDataset?.manifest.pendingAnalysisCount ? [`${aggregateRequirementId}-pending`] : []),
                ].join(' ') || undefined}
                className="w-full sm:w-auto"
              >
                {isGeneratingAggregate
                  ? 'Analyzing...'
                  : aggregateSynthesis ? 'Re-analyze selected interviews' : 'Analyze selected interviews'}
              </Button>
            </div>

            {eligibleInterviewCount < 2 && <p id={`${aggregateRequirementId}-minimum`} className="mt-3 text-[13px] text-ink-500">Need at least 2 analyzed interviews in this dataset to generate aggregate analysis.</p>}
            {!!selectedDataset?.manifest.pendingAnalysisCount && <p id={`${aggregateRequirementId}-pending`} className="mt-3 text-[13px] text-ink-500">{`All selected interviews need complete individual analyses before generating this overview. ${selectedDataset.manifest.pendingAnalysisCount} selected interview${selectedDataset.manifest.pendingAnalysisCount === 1 ? ' still needs' : 's still need'} analysis; Explore can read their saved transcripts now.`}</p>}
            <p className="mt-3 text-[13px] text-ink-700">{selectedDataset
              ? `${selectedDataset.manifest.selectedCount} interviews are selected; ${selectedDataset.manifest.pendingAnalysisCount} need individual analysis before the overview can use this whole dataset. Exploration can read those pending and failed-analysis transcripts directly.`
              : `${currentRevisionAnalyzedCount} analyzed interviews from current revision ${study.revision} are eligible by default. ${interviews.length} interviews are retained; ${olderInterviewCount} are from other or unrecorded revisions.`}</p>
            <Button variant="quiet" className="mt-2" onClick={() => setChoosingDataset(previous => !previous)}>{choosingDataset ? 'Close dataset selection' : 'Choose analysis dataset'}</Button>
            {selectedDataset && <div className="mt-3"><DatasetCoverage dataset={selectedDataset} /></div>}
            {choosingDataset && <div className="mt-4"><StudyDatasetSelector studyId={studyId} interviews={interviews} initialSelection={datasetSelection} disabled={operationPending || isGeneratingAggregate} onApply={applyDataset} /></div>}
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
                      : aggregateSynthesis.scope ? 'Generate a new study from the exact historical dataset saved with this analysis, not from newer interviews.' : 'Generate a new study based on gaps and patterns found in this analysis.'}
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
            ) : (
              <>
                {aggregateFailure && (
                  <Notice tone="error" className="mt-3">
                    <p className="text-[13px] text-ink-700">
                      {`The saved aggregate analysis could not be loaded. ${aggregateFailure}`}
                    </p>
                  </Notice>
                )}
                {eligibleInterviewCount >= 2 && !selectedDataset?.manifest.pendingAnalysisCount && !aggregateFailure && (
                  <p className="mt-3 text-[13px] text-ink-500">
                    Analyze the selected, eligible interviews to generate cross-interview insights.
                  </p>
                )}
              </>
            )}
          </section>
        </div>
      )}

      {(activeTab === 'explore' || explorationVisited) && <div hidden={activeTab !== 'explore'}><StudyExploration key={studyId} study={study} interviews={interviews} disabled={operationPending} initialSelection={datasetSelection} initialDataset={selectedDataset} onDatasetApply={applyDataset} /></div>}

      {activeTab === 'interviews' && (
        interviews.length === 0 && listFailure ? (
          <div className="max-w-measure">
            <h3 className="font-sans text-[18px] font-semibold text-ink-900">Interviews could not be loaded</h3>
            <p className="mt-2 font-sans text-[15px] text-ink-700">{listFailure}</p>
            <Button type="button" variant="quiet" onClick={() => void loadStudyData()} className="mt-3">
              Try again
            </Button>
          </div>
        ) : interviews.length === 0 ? (
          <div className="max-w-measure">
            <h3 className="font-sans text-[18px] font-semibold text-ink-900">No Interviews Yet</h3>
            <p className="mt-2 font-sans text-[15px] text-ink-700">
              Share the participant link to start collecting interviews.
            </p>
          </div>
        ) : (
          <div>
            <ConductingModelsNotice conductingModels={conductingModels} recordedModelCount={recordedModelCount} />

            {batchError && (
              <Notice tone="error" eyebrow="Analysis batch stopped" role="alert" className="mb-4">
                <p className="mt-1 text-[13px] text-ink-700">{batchError.message}</p>
                {batchError.reason === 'update-required' && (
                  <Button type="button" variant="quiet" className="mt-3 min-h-11" onClick={() => window.location.reload()}>
                    Reload page
                  </Button>
                )}
              </Notice>
            )}

            {batchStillPending && (
              <Notice tone="neutral" eyebrow="Analysis still pending" className="mb-4">
                <p className="mt-1 text-[13px] text-ink-700">
                  {`The analysis of ${batchStillPending} is still pending, so the batch stopped before the remaining interviews. You can leave this page and check again later.`}
                </p>
              </Notice>
            )}

            {pendingAnalysisInterviews.length > 0 && (
              <div className="mb-4">
                {recoveryInBatch > 0 && (
                  <Notice tone="neutral" eyebrow="Analysis needs recovery" id={recoveryDisclosureId} className="mb-3">
                    <p className="mt-1 text-[13px] text-ink-700">{recoveryDisclosure(recoveryInBatch)}</p>
                  </Notice>
                )}
                {(batchSelection.length > 0 || isBatchAnalyzing) && (
                  <Button
                    type="button"
                    variant="primary"
                    className="min-h-11"
                    onClick={() => void handleAnalyzeBatch()}
                    disabled={operationPending || isBatchAnalyzing}
                    aria-describedby={recoveryInBatch > 0 ? recoveryDisclosureId : undefined}
                  >
                    {isBatchAnalyzing && batchProgress
                      ? `Analyzing ${batchProgress.done} of ${batchProgress.total}…`
                      : `Analyze ${batchSelection.length} pending`}
                  </Button>
                )}
                {scheduledAnalysisCount > 0 && (
                  <p className="mt-2 text-[13px] text-ink-500">{scheduledCount(scheduledAnalysisCount)}</p>
                )}
              </div>
            )}

            <p
              role="status"
              aria-live="polite"
              className={batchStatus ? 'mb-4 text-[13px] text-ink-500' : 'sr-only'}
            >
              {batchStatus}
            </p>

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
          <section className="border-y border-ink-300 py-4">
            <h3 className="font-sans text-[15px] font-semibold text-ink-900">Study controls</h3>
            <Coordinate className="mt-2 block">{`Collection revision ${study.revision}`}</Coordinate>
            <p className="mt-2 max-w-measure text-[13px] text-ink-700">A collection-configuration edit advances the revision and invalidates earlier participant authority. Retained interviews remain available; choose their revisions explicitly for analysis. Pausing access does not change the protocol revision.</p>
            <div className="mt-3 flex flex-wrap gap-3">
              <Button variant="primary" disabled={operationPending} onClick={() => router.push(`/setup?prefill=edit&studyId=${encodeURIComponent(studyId)}`)}>Edit study</Button>
              <Button variant="quiet" disabled={operationPending || isExporting} onClick={() => void handleExportStudy()} title="ZIP with raw records, transcripts, saved analyses, and analysis JSONL/CSV files with a data dictionary">{isExporting ? 'Preparing study export…' : 'Export this study'}</Button>
              <Button variant="quiet" disabled={operationPending || isExportingTranscripts || study.interviewCount === 0} onClick={() => void handleExportTranscripts()} title="All transcripts in one Markdown file, with what each participant was told about the AI">{isExportingTranscripts ? 'Preparing transcripts…' : 'Export transcripts (.md)'}</Button>
            </div>
          </section>
          {lifecycleError && <Notice tone="error" role="status"><p className="text-[13px]">{lifecycleError}</p></Notice>}
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
                <Label>Interview Structure</Label>
              </dt>
              <dd className="font-sans text-[15px] leading-[24px] capitalize text-ink-900">{study.config.aiBehavior}</dd>
            </div>

            <div className="grid grid-cols-1 gap-1 py-4 md:grid-cols-[12rem_1fr] md:gap-6">
              <dt><Label>Interviewer Manner</Label></dt>
              <dd className="font-sans text-[15px] leading-[24px] text-ink-700 whitespace-pre-wrap">
                {study.config.interviewerInstructions || <span className="text-ink-500">Default</span>}
              </dd>
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
                    ? 'Collection is open. Pause access without changing the collection revision.'
                    : 'Collection is paused. Resume restores still-valid links, not revoked, expired or older-revision authority.'}
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
                  {(study.config.linksEnabled ?? true) ? 'OPEN · PAUSE' : 'PAUSED · RESUME'}
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
                      className="min-w-0 flex-1 rounded-sm border border-ink-300 bg-paper-2 px-3 py-2 font-mono text-[13px] text-ink-900"
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
          <section id="danger-zone" tabIndex={-1} className="scroll-mt-8 border-t border-ink-300 pt-5">
            <h3 className="font-sans text-[17px] font-semibold text-error">Danger Zone</h3>
            <p className="mt-2 max-w-measure text-[13px] text-ink-700">Permanently delete this study, all associated interviews, analyses, participant links and notebook answers from the application’s live store. Downloaded exports, external backups and already-started provider requests cannot be recalled.</p>
            {deleteStep === 0 && <Button variant="quiet" disabled={operationPending} className="mt-3" onClick={() => { setDeleteStep(1); setDeleteRevision(study.revision); setDeleteAcknowledged(false); }}>Delete study</Button>}
            {deleteStep === 1 && <div className="mt-4 border-t border-ink-300 pt-4"><p className="text-[15px] text-ink-900">{`Delete “${study.config.name}” and ${study.interviewCount} associated interviews?`}</p><p className="mt-2 text-[13px] text-ink-700">Export this study first if you want a copy. Deletion cannot be undone.</p><div className="mt-3 flex flex-wrap gap-3"><Button variant="quiet" disabled={isExporting} onClick={() => void handleExportStudy()}>Export before deletion</Button><Button variant="primary" onClick={() => setDeleteStep(2)}>Continue to permanent deletion</Button><Button variant="quiet" onClick={() => setDeleteStep(0)}>Cancel deletion</Button></div></div>}
            {deleteStep === 2 && <div className="mt-4 border-t border-ink-300 pt-4"><Coordinate className="block">{`Study ${studyId} · confirmed revision ${deleteRevision}`}</Coordinate><label className="mt-3 flex min-h-11 items-start gap-2 text-[13px] text-ink-900"><input type="checkbox" checked={deleteAcknowledged} disabled={deletePending || isDeleting} onChange={event => setDeleteAcknowledged(event.target.checked)} className="mt-1" />I understand that this permanently removes the study and all its live research data.</label><div className="mt-3 flex flex-wrap gap-3"><Button variant="primary" disabled={!deleteAcknowledged || isDeleting || deletePending} onClick={() => void handleDeleteStudy()}>{isDeleting ? 'Confirming deletion…' : 'Permanently delete study and data'}</Button>{!deletePending && <Button variant="quiet" disabled={isDeleting} onClick={() => setDeleteStep(0)}>Cancel deletion</Button>}</div></div>}
            {deletePending && <Notice tone="error" role="status" className="mt-4"><p className="text-[13px]">Deletion is pending. This page will not claim permanent completion until the server confirms it.</p><Button variant="quiet" disabled={isDeleting} onClick={() => void handleDeleteStudy()}>Check deletion progress</Button></Notice>}
          </section>
        </div>
      )}
      </Tabs>
    </div>
  );
};

export default StudyDetail;
