'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { StoredInterview } from '@/types';
import {
  analyzeInterview,
  getInterviewAnalysisStatus,
  startInterviewAnalysisV2,
  type AnalysisRequestFailureKind,
} from '@/services/analysisApi';
import { loadAnalysisExecution, type AnalysisExecutionMode } from '@/services/analysisExecution';
import {
  analysisStatus,
  confirmedAnalysisFromRecord,
  confirmedAnalysisFromStatus,
  isActiveAnalysis,
  isDurableAnalysisRecord,
  isTerminalAnalysis,
  sameConfirmedAnalysis,
  type ConfirmedAnalysis,
} from '@/lib/analysisState';
import { AnalysisActionKeys } from './actionKeys';
import { AnalysisStatusPoller, type PollerSnapshot } from './statusPoller';

export type AnalysisRequestError = {
  kind: AnalysisRequestFailureKind;
  message: string;
  /** The server may have accepted the start; only a read can tell (API-03). */
  uncertain: boolean;
};

export type AnalysisProtocol = 'synchronous' | 'queued-v2';

export type InterviewAnalysisController = {
  /**
   * How the state is presented; null until the deployment's protocol is known.
   * A durable record is presented durably even when the capability could not
   * be read, so active work is never offered a new start.
   */
  protocol: AnalysisProtocol | null;
  /** Durable presentation only: the last confirmed state, merged monotonically. */
  confirmed: ConfirmedAnalysis | null;
  /** Durable protocol only: automatic polling ended while work is still pending. */
  pollingEnded: boolean;
  submitting: boolean;
  checking: boolean;
  requestError: AnalysisRequestError | null;
  /** The latest status could not be checked; the last confirmed state stands. */
  statusError: string | null;
  /** Text for the polite live region; changes only when the state does. */
  announcement: string;
  run: () => void;
  checkStatus: () => void;
};

const STATUS_NOT_CHECKED = 'The latest analysis status could not be checked.';

type AnnouncedKind = 'queued' | 'running' | 'still-pending' | 'complete' | 'status-error' | 'quiet';

const ANNOUNCEMENTS: Record<AnnouncedKind, string> = {
  queued: 'Analysis queued.',
  running: 'Analysis running.',
  'still-pending': 'Analysis is still pending. You can leave this page and check again later.',
  complete: 'Analysis complete.',
  'status-error': STATUS_NOT_CHECKED,
  // Not-scheduled work says nothing; failures use the alert pattern instead.
  quiet: '',
};

function announcedKind(
  protocol: AnalysisProtocol,
  interview: StoredInterview,
  confirmed: ConfirmedAnalysis | null,
  pollingEnded: boolean,
  statusError: string | null,
): { kind: AnnouncedKind; generation: number } {
  if (statusError) return { kind: 'status-error', generation: confirmed?.generation ?? 0 };
  if (protocol === 'synchronous') {
    const status = analysisStatus(interview);
    return { kind: status === 'running' || status === 'complete' ? status : 'quiet', generation: 0 };
  }
  if (!confirmed) return { kind: 'quiet', generation: 0 };
  if (confirmed.status === 'complete') return { kind: 'complete', generation: confirmed.generation };
  if (confirmed.status === 'pending' && confirmed.phase !== 'not-scheduled') {
    return { kind: pollingEnded ? 'still-pending' : confirmed.phase, generation: confirmed.generation };
  }
  return { kind: 'quiet', generation: confirmed.generation };
}

function scopeOf(record: Pick<StoredInterview, 'id' | 'studyId'>): string {
  return `${record.studyId}/${record.id}`;
}

type ScopedRequestError = AnalysisRequestError & {
  scope: string;
  /** The generation the action was taken on (durable starts only). */
  generation?: number;
};

/**
 * Researcher analysis state for one interview (UI-CF-02/03). Chooses the
 * legacy synchronous or the durable queued protocol from the deployment's
 * public capability, and never lets browser time or a read start paid work.
 *
 * Everything that arrives asynchronously is tagged with the interview it
 * belongs to. The App Router keeps this component mounted across interviews,
 * so an untagged value would describe the previous interview for a render.
 */
export function useInterviewAnalysis({
  interview,
  refreshRecord,
}: {
  interview: StoredInterview | null;
  /** Reload the record in place; resolves false when it could not be read. */
  refreshRecord: () => Promise<boolean>;
}): InterviewAnalysisController {
  const scope = interview ? scopeOf(interview) : null;
  const [mode, setMode] = useState<AnalysisExecutionMode | null>(null);
  const [polled, setPolled] = useState<{ scope: string; snapshot: PollerSnapshot } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [refreshingScope, setRefreshingScope] = useState<string | null>(null);
  const [refreshFailedScope, setRefreshFailedScope] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<ScopedRequestError | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [keys] = useState(() => new AnalysisActionKeys());
  const pollerRef = useRef<AnalysisStatusPoller | null>(null);
  const recordRef = useRef(interview);
  const refreshRecordRef = useRef(refreshRecord);
  const busyRef = useRef(false);
  const reloadedForRef = useRef<string | null>(null);
  const announcedRef = useRef<{ scope: string; key: string } | null>(null);

  // Opening another interview starts from its own record: nothing the last
  // one reported may carry over, not even for the render before effects run.
  const [openedScope, setOpenedScope] = useState(scope);
  if (openedScope !== scope) {
    setOpenedScope(scope);
    setRequestError(null);
    setRefreshFailedScope(null);
  }

  useEffect(() => {
    recordRef.current = interview;
    refreshRecordRef.current = refreshRecord;
  });

  useEffect(() => {
    let live = true;
    void loadAnalysisExecution().then((resolved) => {
      if (live) setMode(resolved);
    });
    return () => {
      live = false;
    };
  }, []);

  const polling = mode === 'queued-v2';
  const durableRecord = interview ? isDurableAnalysisRecord(interview) : false;
  // `unknown` starts work the legacy way and never polls (analysisExecution.ts);
  // a record only a durable server writes is still presented durably.
  const protocol: AnalysisProtocol | null = mode === null
    ? null
    : polling || (mode === 'unknown' && durableRecord) ? 'queued-v2' : 'synchronous';
  const durableView = protocol === 'queued-v2';
  const interviewId = interview?.id ?? null;
  const studyId = interview?.studyId ?? null;

  useEffect(() => {
    if (!polling || !interviewId || !studyId) return;
    const pollerScope = scopeOf({ id: interviewId, studyId });
    const poller = new AnalysisStatusPoller({
      read: (signal) => getInterviewAnalysisStatus({ studyId, interviewId, signal }),
      onChange: (snapshot) => setPolled({ scope: pollerScope, snapshot }),
    });
    pollerRef.current = poller;
    const record = recordRef.current;
    if (record?.id === interviewId) {
      poller.seed(confirmedAnalysisFromRecord(record));
      // Opening active work observes it; it never starts anything.
      if (isActiveAnalysis(poller.snapshot().status)) poller.start();
    }
    return () => {
      poller.dispose();
      if (pollerRef.current === poller) pollerRef.current = null;
      setPolled((current) => (current?.scope === pollerScope ? null : current));
    };
  }, [polling, interviewId, studyId]);

  useEffect(() => {
    const poller = pollerRef.current;
    if (!poller || !interview) return;
    poller.seed(confirmedAnalysisFromRecord(interview));
    if (!poller.hasSession && isActiveAnalysis(poller.snapshot().status)) poller.start();
  }, [interview]);

  const reloadRecord = useCallback(async () => {
    const record = recordRef.current;
    if (!record) return;
    const target = scopeOf(record);
    setRefreshingScope(target);
    const ok = await refreshRecordRef.current();
    setRefreshingScope((current) => (current === target ? null : current));
    setRefreshFailedScope((current) => (ok ? (current === target ? null : current) : target));
  }, []);

  const snapshot = polled && polled.scope === scope ? polled.snapshot : null;
  const recordConfirmed = interview ? confirmedAnalysisFromRecord(interview) : null;
  const confirmed = durableView ? snapshot?.status ?? recordConfirmed : null;
  // A persisted outcome the loaded record does not show yet: reload it once.
  const recordLagKey = durableView && confirmed && isTerminalAnalysis(confirmed)
    && !(recordConfirmed && sameConfirmedAnalysis(recordConfirmed, confirmed))
    ? `${scope}:${confirmed.status}:${confirmed.generation}`
    : null;

  useEffect(() => {
    if (!recordLagKey || reloadedForRef.current === recordLagKey) return;
    reloadedForRef.current = recordLagKey;
    void reloadRecord();
  }, [recordLagKey, reloadRecord]);

  const pollingEnded = Boolean(polling && snapshot?.budgetEnded && isActiveAnalysis(confirmed));
  // Without the capability no status read is sent, so unfinished durable work
  // is shown as last confirmed, never as current.
  const statusUnchecked = mode === 'unknown' && durableView && confirmed?.status !== 'complete';
  const statusError = (polling ? snapshot?.error?.error : undefined)
    ?? (refreshFailedScope !== null && refreshFailedScope === scope ? STATUS_NOT_CHECKED : null)
    ?? (statusUnchecked ? STATUS_NOT_CHECKED : null);
  const checking = (refreshingScope !== null && refreshingScope === scope) || (polling && snapshot?.phase === 'reading');

  const scopedError = requestError && requestError.scope === scope ? requestError : null;
  // A read showing a later generation answers an unconfirmed start.
  const answered = Boolean(
    scopedError?.uncertain
    && scopedError.generation !== undefined
    && confirmed
    && confirmed.generation > scopedError.generation,
  );
  const visibleError: AnalysisRequestError | null = scopedError && !answered
    ? { kind: scopedError.kind, message: scopedError.message, uncertain: scopedError.uncertain }
    : null;

  const announced = protocol && interview
    ? announcedKind(protocol, interview, confirmed, pollingEnded, statusError)
    : null;
  const announcedKey = announced ? `${announced.kind}:${announced.generation}` : null;
  const announcedText = announced ? ANNOUNCEMENTS[announced.kind] : '';

  useEffect(() => {
    if (!scope || !announcedKey) return;
    const previous = announcedRef.current;
    announcedRef.current = { scope, key: announcedKey };
    // The state a page opens on is on screen already; announce changes only.
    if (!previous || previous.scope !== scope) {
      setAnnouncement('');
      return;
    }
    if (previous.key !== announcedKey) setAnnouncement(announcedText);
  }, [announcedKey, announcedText, scope]);

  const run = useCallback(() => {
    const record = recordRef.current;
    if (!record || busyRef.current || mode === null) return;
    const runScope = scopeOf(record);
    busyRef.current = true;
    setSubmitting(true);
    setRequestError(null);
    void (async () => {
      try {
        if (mode !== 'queued-v2') {
          // `unknown` included: a durable server refuses this before any work.
          const result = await analyzeInterview(record.id, record.studyId);
          if (recordRef.current?.id !== record.id) return;
          if (result.ok) await reloadRecord();
          else setRequestError({ scope: runScope, kind: result.kind, message: result.error, uncertain: false });
          return;
        }
        const current = pollerRef.current?.snapshot().status ?? confirmedAnalysisFromRecord(record);
        if (isActiveAnalysis(current)) return;
        const action = keys.actionFor(record.id, current.generation);
        const result = await startInterviewAnalysisV2({
          studyId: record.studyId,
          interviewId: record.id,
          expectedGeneration: action.expectedGeneration,
          idempotencyKey: action.key,
        });
        if (recordRef.current?.id !== record.id) return;
        keys.settle(record.id, result);
        const poller = pollerRef.current;
        if (!result.ok) {
          setRequestError({
            scope: runScope,
            kind: result.kind,
            message: result.error,
            uncertain: result.uncertain,
            generation: action.expectedGeneration,
          });
          // The server moved on without this action, or may have accepted it:
          // one read shows what it holds now. A read never starts anything.
          if (result.kind === 'state-changed' || result.uncertain) poller?.refresh();
          return;
        }
        if (!poller) return;
        const outcome = result.outcome;
        poller.seed(confirmedAnalysisFromStatus(outcome), outcome.status === 'pending' ? outcome.pollAfterMs : undefined);
        if (outcome.status === 'pending') poller.start();
      } finally {
        busyRef.current = false;
        setSubmitting(false);
      }
    })();
  }, [keys, mode, reloadRecord]);

  const recordRefreshFailed = refreshFailedScope !== null && refreshFailedScope === scope;
  const checkStatus = useCallback(() => {
    const poller = pollerRef.current;
    if (polling && poller) {
      poller.refresh();
      if (recordRefreshFailed || recordLagKey) void reloadRecord();
      return;
    }
    if (mode === 'unknown') {
      // Ask again: a confirmed answer moves this page onto its real protocol.
      void loadAnalysisExecution().then(setMode);
    }
    void reloadRecord();
  }, [mode, polling, recordLagKey, recordRefreshFailed, reloadRecord]);

  return {
    protocol,
    confirmed,
    pollingEnded,
    submitting,
    checking,
    requestError: visibleError,
    statusError,
    announcement,
    run,
    checkStatus,
  };
}
