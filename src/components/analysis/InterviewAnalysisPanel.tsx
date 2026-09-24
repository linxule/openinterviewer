'use client';

import React, { useEffect, useId, useState } from 'react';
import type { InterviewAnalysisFailureKind, StoredInterview } from '@/types';
import { Button, Notice } from '@/components/ui';
import { SynthesisReading, ProvenanceFooter } from '@/components/SynthesisReading';
import { analysisStatus } from '@/lib/analysisState';
import type { AnalysisRequestError, InterviewAnalysisController } from './useInterviewAnalysis';

// Mirrors ANALYSIS_CLAIM_LEASE_MS in src/lib/kv.ts — duplicated rather than
// imported because that module pulls in server-only Redis client code that
// must never reach a 'use client' bundle. Legacy synchronous path only: the
// durable backend never lets browser time enable a retry.
const ANALYSIS_CLAIM_LEASE_MS = 180_000;

const FAILURE_COPY: Record<InterviewAnalysisFailureKind, string> = {
  provider: 'The model provider did not return an analysis. This is not an analysis — run it again.',
  'invalid-output': 'The model returned something this study could not read as an analysis. Run it again.',
  'too-large': 'The analysis was too large to store. Run it again, or shorten the study’s topic areas.',
  timeout: 'The analysis did not finish in time. Run it again.',
  storage: 'The analysis could not be saved. Run it again.',
};

const RECOVERY_COPY =
  'This interview is saved, but we could not confirm the analysis result. Running it again may make another paid provider request.';

const STILL_PENDING_COPY = 'Analysis is still pending. You can leave this page and check again later.';

const UNCONFIRMED_START_COPY =
  'The request may still have been accepted. Check the status before running it again. Running it again repeats this request rather than starting another.';

function relativeTimeFrom(ms: number, nowMs: number): string {
  const elapsed = nowMs - ms;
  const minutes = Math.round(elapsed / 60_000);
  if (minutes < 1) return 'less than a minute ago';
  if (minutes === 1) return '1 minute ago';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
}

type ReadingProps = {
  interview: StoredInterview;
  savedAt: string;
  openNotes: Record<string, boolean>;
  onNoteOpenChange: (themeIndex: number, refIndex: number, next: boolean) => void;
  onTraceToTurn: (turnIndex: number) => void;
};

function AnalysisReading({ interview, savedAt, openNotes, onNoteOpenChange, onTraceToTurn }: ReadingProps) {
  if (!interview.synthesis) return null;
  // The revision the analysis actually ran under, when it differs.
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
        onNoteOpenChange={onNoteOpenChange}
        onTraceToTurn={onTraceToTurn}
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

type ActionProps = {
  busy: boolean;
  busyLabel: string;
  onRun: () => void;
};

function RunButton({ busy, busyLabel, onRun, label = 'Run analysis' }: ActionProps & { label?: string }) {
  return (
    <Button variant="primary" className="mt-3 min-h-11" disabled={busy} onClick={onRun}>
      {busy ? busyLabel : label}
    </Button>
  );
}

function NotScheduledNotice(props: ActionProps) {
  return (
    <Notice tone="neutral" eyebrow="Analysis pending">
      <p className="mt-1 text-[13px] text-ink-700">
        This interview was saved. Its analysis has not run yet.
      </p>
      <RunButton {...props} />
    </Notice>
  );
}

function FailureNotice({ failureKind, ...props }: ActionProps & { failureKind?: InterviewAnalysisFailureKind }) {
  return (
    <Notice tone="error" eyebrow="Analysis failed">
      <p className="mt-1 text-[13px] text-ink-700" role="alert">
        {failureKind ? FAILURE_COPY[failureKind] : 'This is not an analysis — run it again.'}
      </p>
      <RunButton {...props} />
    </Notice>
  );
}

function RecoveryNotice(props: ActionProps) {
  return (
    <Notice tone="error" eyebrow="Analysis needs recovery">
      <p className="mt-1 text-[13px] text-ink-700" role="alert">{RECOVERY_COPY}</p>
      <RunButton {...props} label="Run analysis again" />
    </Notice>
  );
}

function CheckStatusButton({ checking, onCheck }: { checking: boolean; onCheck: () => void }) {
  return (
    <Button variant="quiet" className="mt-3 min-h-11" disabled={checking} onClick={onCheck}>
      {checking ? 'Checking…' : 'Check status'}
    </Button>
  );
}

function RequestErrorNotice({ error, controller }: {
  error: AnalysisRequestError;
  controller: InterviewAnalysisController;
}) {
  if (error.kind === 'update-required') {
    return (
      <Notice tone="error" eyebrow="Reload required" role="alert" className="mb-6">
        <p className="mt-1 text-[13px] text-ink-700">{error.message}</p>
        <Button variant="quiet" className="mt-3 min-h-11" onClick={() => window.location.reload()}>
          Reload page
        </Button>
      </Notice>
    );
  }
  if (error.uncertain) {
    // Uncertainty is never shown as a failure (UI-CF-02): a read settles it.
    return (
      <Notice tone="neutral" eyebrow="Analysis request not confirmed" role="alert" className="mb-6">
        <p className="mt-1 text-[13px] text-ink-700">{error.message}</p>
        <p className="mt-1 text-[13px] text-ink-700">{UNCONFIRMED_START_COPY}</p>
        {!controller.statusError && (
          <CheckStatusButton checking={controller.checking} onCheck={controller.checkStatus} />
        )}
      </Notice>
    );
  }
  return (
    <Notice tone="error" eyebrow="Analysis request failed" role="alert" className="mb-6">
      <p className="mt-1 text-[13px] text-ink-700">{error.message}</p>
    </Notice>
  );
}

/** Node synchronous path, unchanged apart from the recovery row. */
function LegacyAnalysisState({ interview, controller, reading }: {
  interview: StoredInterview;
  controller: InterviewAnalysisController;
  reading: React.ReactNode;
}) {
  const status = analysisStatus(interview);
  const leaseNoteId = useId();
  // `Date.now()` is impure and may not be called during render; a running
  // analysis's lease elapsing is exactly the kind of clock-driven UI change
  // that needs its own tick, polled while (and only while) a claim is live.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (status !== 'running') return;
    const interval = setInterval(() => setNowMs(Date.now()), 5_000);
    return () => clearInterval(interval);
  }, [status]);

  const action: ActionProps = { busy: controller.submitting, busyLabel: 'Running…', onRun: controller.run };
  if (status === 'complete' && interview.synthesis) return <>{reading}</>;
  if (status === 'pending') return <NotScheduledNotice {...action} />;
  if (status === 'running') {
    const claimedAt = interview.analysis?.claimedAt;
    const leaseElapsed = claimedAt !== undefined && nowMs - claimedAt >= ANALYSIS_CLAIM_LEASE_MS;
    return (
      <Notice tone="neutral" eyebrow="Analysis running">
        <p id={leaseNoteId} className="mt-1 text-[13px] text-ink-700">
          {claimedAt !== undefined
            ? `An analysis started ${relativeTimeFrom(claimedAt, nowMs)}. Give it a moment, then reload.`
            : 'An analysis is running. Give it a moment, then reload.'}
        </p>
        <Button
          variant="primary"
          className="mt-3 min-h-11"
          disabled={!leaseElapsed || controller.submitting}
          aria-describedby={leaseNoteId}
          onClick={controller.run}
        >
          {controller.submitting ? 'Running…' : 'Run analysis'}
        </Button>
      </Notice>
    );
  }
  if (interview.analysis?.recoveryRequired) return <RecoveryNotice {...action} />;
  return <FailureNotice {...action} failureKind={interview.analysis?.failureKind} />;
}

/** Durable (queued) path: every UI-CF-02 row from the last confirmed state. */
function DurableAnalysisState({ interview, controller, reading }: {
  interview: StoredInterview;
  controller: InterviewAnalysisController;
  reading: React.ReactNode;
}) {
  const confirmed = controller.confirmed;
  if (!confirmed) return null;
  const action: ActionProps = { busy: controller.submitting, busyLabel: 'Starting…', onRun: controller.run };

  if (confirmed.status === 'complete') {
    if (analysisStatus(interview) === 'complete' && interview.synthesis) return <>{reading}</>;
    // Confirmed complete, but the refreshed record has not arrived (yet).
    return (
      <Notice tone="neutral" eyebrow="Analysis complete">
        <p className="mt-1 text-[13px] text-ink-700">
          {controller.checking
            ? 'Loading the analysis…'
            : 'The analysis finished, but this page could not load it yet.'}
        </p>
        {!controller.statusError && (
          <CheckStatusButton checking={controller.checking} onCheck={controller.checkStatus} />
        )}
      </Notice>
    );
  }
  if (confirmed.status === 'failed') {
    return confirmed.recoveryRequired
      ? <RecoveryNotice {...action} />
      : <FailureNotice {...action} failureKind={confirmed.failureKind} />;
  }
  if (confirmed.phase === 'not-scheduled') return <NotScheduledNotice {...action} />;

  const running = confirmed.phase === 'running';
  return (
    <Notice tone="neutral" eyebrow={running ? 'Analysis running' : 'Analysis queued'}>
      <p className="mt-1 text-[13px] text-ink-700">
        {controller.pollingEnded
          ? STILL_PENDING_COPY
          : running
            ? 'This interview is saved. Analysis is in progress.'
            : 'This interview is saved. Its analysis will run in the background.'}
      </p>
      {controller.pollingEnded && !controller.statusError && (
        <CheckStatusButton checking={controller.checking} onCheck={controller.checkStatus} />
      )}
    </Notice>
  );
}

export function InterviewAnalysisPanel({ controller, ...readingProps }: ReadingProps & {
  controller: InterviewAnalysisController;
}) {
  const { interview } = readingProps;
  const reading = <AnalysisReading {...readingProps} />;
  const { requestError, statusError } = controller;
  // A finished reading needs nothing but the record, whatever the protocol (UI-CF-01).
  const readingReady = analysisStatus(interview) === 'complete' && Boolean(interview.synthesis);

  return (
    <div>
      {requestError && <RequestErrorNotice error={requestError} controller={controller} />}
      {statusError && (
        <Notice tone="neutral" eyebrow="Status not checked" className="mb-6">
          <p className="mt-1 text-[13px] text-ink-700">
            {statusError} The last confirmed state is shown below.
          </p>
          <CheckStatusButton checking={controller.checking} onCheck={controller.checkStatus} />
        </Notice>
      )}
      {readingReady ? (
        reading
      ) : controller.protocol === null ? (
        <p className="text-[13px] text-ink-500">Checking analysis status…</p>
      ) : controller.protocol === 'queued-v2' ? (
        <DurableAnalysisState interview={interview} controller={controller} reading={reading} />
      ) : (
        <LegacyAnalysisState interview={interview} controller={controller} reading={reading} />
      )}
    </div>
  );
}
