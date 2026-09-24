// The object's single alarm (JOB-05/06/07/10): outbox dispatch, lease
// watchdog and bounded expiry cleanup. Every state change that needs a later
// wake-up commits together with the alarm before any Queue I/O; the Queue send
// itself happens outside transactions and is recorded conditionally.
//
// Maintenance is re-checked inside every write unit, not only at entry: an
// awaited Queue send lets an operator freeze commit mid-alarm, and frozen or
// recovery must suspend dispatch, watchdog and cleanup (F11).

import type { AnalysisMessageV1 } from '../../src/lib/storage/analysisProtocol';
import {
  ANALYSIS_ALARM_BATCH,
  ANALYSIS_ALARM_FAILURE_RETRY_MS,
  ANALYSIS_MAX_DISPATCH_ATTEMPTS,
  ANALYSIS_MAX_PRESTART_AGE_MS,
  ANALYSIS_TERMINAL_JOB_RETENTION_MS,
  ANALYSIS_WATCHDOG_AFTER_SEND_MS,
  dispatchBackoffMs,
  isNonterminalJobState,
} from '../../src/lib/storage/analysisProtocol';
import type { WorkspaceHoldReason } from '../../src/lib/storage/types';
import type { RequestLogReason } from '../../src/lib/requestLog';
import { logJobEvent } from '../analysis/telemetry';
import {
  armAlarmNoLaterThan,
  bumpMutationSeq,
  gate,
  HELD_ALARM_RETRY_MS,
  RECEIPT_TTL_MS,
  type WorkspaceContext,
  type WorkspaceMeta,
} from './context';
import { lastConsumerContactAt, liveParent, readAnalysisRow, readJob, settleJob, type JobRow } from './analysis';
import { CorruptRecordError } from './projection';

/** Expired links stay listable as expired for this long before cleanup removes them. */
export const LINK_CLEANUP_GRACE_MS = RECEIPT_TTL_MS;
/** Rows deleted per family per alarm. */
export const CLEANUP_BATCH = 100;
/** Cleanup alone never wakes the object more often than this. */
export const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
/** Longest a quarantined due row is skipped before it is tried again. */
export const QUARANTINE_MAX_MS = 60 * 60 * 1000;
/** Quarantine entries kept per object; the least recently failing is dropped first. */
const QUARANTINE_CAPACITY = 256;

type PendingSend = { jobId: string; attempt: number; message: AnalysisMessageV1 };

type Settlement =
  | { kind: 'settled' }
  | { kind: 'send'; send: PendingSend }
  | { kind: 'held'; reason: WorkspaceHoldReason }
  | { kind: 'corrupt' };

function holdReason(reason: WorkspaceHoldReason): RequestLogReason {
  switch (reason) {
    case 'maintenance':
      return 'maintenance-hold';
    case 'recovery-epoch-mismatch':
      return 'epoch-mismatch';
    case 'schema-unsupported':
      return 'schema-unsupported';
    case 'workspace-identity-mismatch':
    case 'workspace-uninitialized':
      return 'workspace-identity-mismatch';
    case 'workspace-unconfigured':
      return 'not-configured';
  }
}

// ---------- Quarantine (F13) ----------

type QuarantineEntry = { until: number; strikes: number };

// Per object instance: a restart forgets it and simply tries each row again.
const quarantines = new WeakMap<DurableObjectStorage, Map<string, QuarantineEntry>>();

function quarantineOf(storage: DurableObjectStorage): Map<string, QuarantineEntry> {
  let entries = quarantines.get(storage);
  if (!entries) {
    entries = new Map();
    quarantines.set(storage, entries);
  }
  return entries;
}

/** Skip before the next try: 30 s doubling per consecutive failure, capped at an hour. */
export function quarantineBackoffMs(strikes: number): number {
  const exponent = Math.max(0, Math.min(strikes - 1, 20));
  return Math.min(ANALYSIS_ALARM_FAILURE_RETRY_MS * 2 ** exponent, QUARANTINE_MAX_MS);
}

/**
 * Take a due row out of the scan without patching it: structural corruption
 * or a settlement that failed. Count-only telemetry; the row is tried again
 * after its backoff so a transient storage fault heals by itself.
 */
function quarantineRow(
  entries: Map<string, QuarantineEntry>,
  jobId: string,
  reason: 'corrupt-record' | 'unavailable',
  error?: unknown,
): void {
  const strikes = (entries.get(jobId)?.strikes ?? 0) + 1;
  entries.delete(jobId);
  entries.set(jobId, { until: Date.now() + quarantineBackoffMs(strikes), strikes });
  while (entries.size > QUARANTINE_CAPACITY) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
  logJobEvent({ operation: 'alarm', reason, error });
}

function activeQuarantine(entries: Map<string, QuarantineEntry>, now: number): Set<string> {
  const active = new Set<string>();
  for (const [jobId, entry] of entries) if (entry.until > now) active.add(jobId);
  return active;
}

// ---------- Alarm ----------

/**
 * Alarm entry. Any failure first tries to persist a retry alarm, then returns
 * normally: platform alarm retries are finite and are not the recovery path.
 */
export async function runAlarm(ws: WorkspaceContext, alarmInfo: AlarmInvocationInfo | undefined): Promise<void> {
  void alarmInfo;
  try {
    await runScheduler(ws);
  } catch (error) {
    logJobEvent({ operation: 'alarm', reason: 'unavailable', error });
    try {
      await ws.storage.setAlarm(Date.now() + ANALYSIS_ALARM_FAILURE_RETRY_MS);
    } catch (armError) {
      logJobEvent({ operation: 'alarm', reason: 'unavailable', error: armError });
    }
  }
}

async function runScheduler(ws: WorkspaceContext): Promise<void> {
  // Held workspaces stay inert: no dispatch and no cleanup. An identity
  // mismatch (the deployment's WORKSPACE_ID no longer names this object) keeps
  // an hourly wake-up, so correcting the binding resumes dispatch by itself
  // (ST-09). A restored workspace (epoch mismatch) and maintenance consume the
  // alarm: activation or leaving maintenance re-arms it, and any other cleared
  // hold is healed by the next job-capable RPC that finds due work without one.
  const gated = gate(ws, 'job-settlement');
  if (!gated.ok) {
    logJobEvent({ operation: 'alarm', reason: holdReason(gated.reason) });
    if (gated.reason === 'workspace-identity-mismatch') {
      await ws.storage.setAlarm(Date.now() + HELD_ALARM_RETRY_MS);
    }
    return;
  }
  const quarantine = quarantineOf(ws.storage);
  const scanAt = Date.now();
  const skipped = activeQuarantine(quarantine, scanAt);
  const due = ws.sql
    .exec<{ job_id: string }>(
      `SELECT job_id FROM analysis_jobs
        WHERE next_due_at IS NOT NULL AND next_due_at <= ?
        ORDER BY next_due_at, job_id LIMIT ?`,
      scanAt,
      ANALYSIS_ALARM_BATCH + 1 + skipped.size,
    )
    .toArray()
    .map((row) => row.job_id)
    .filter((jobId) => !skipped.has(jobId));
  for (const jobId of due.slice(0, ANALYSIS_ALARM_BATCH)) {
    let settlement: Settlement;
    try {
      settlement = await settleDueJob(ws, jobId);
    } catch (error) {
      quarantineRow(quarantine, jobId, error instanceof CorruptRecordError ? 'corrupt-record' : 'unavailable', error);
      continue;
    }
    if (settlement.kind === 'held') {
      logJobEvent({ operation: 'alarm', reason: holdReason(settlement.reason) });
      return;
    }
    if (settlement.kind === 'corrupt') {
      quarantineRow(quarantine, jobId, 'corrupt-record');
      continue;
    }
    quarantine.delete(jobId);
    if (settlement.kind === 'send') {
      const sent = await dispatch(ws, settlement.send);
      if (sent !== 'ok') {
        logJobEvent({ operation: 'alarm', reason: holdReason(sent) });
        return;
      }
    }
  }
  const cleaned = cleanup(ws);
  if (!cleaned.ok) {
    logJobEvent({ operation: 'cleanup', reason: holdReason(cleaned.reason) });
    return;
  }
  await rearm(ws, due.length > ANALYSIS_ALARM_BATCH, cleaned.remains, quarantine);
}

/** Decide one due row. Commits its new state and wake-up before any send. */
async function settleDueJob(ws: WorkspaceContext, jobId: string): Promise<Settlement> {
  const { sql, storage } = ws;
  const now = Date.now();
  return storage.transaction(async (): Promise<Settlement> => {
    const gated = gate(ws, 'job-settlement');
    if (!gated.ok) return { kind: 'held', reason: gated.reason };
    const meta = gated.meta;
    const job = readJob(sql, jobId);
    if (!job || job.next_due_at === null || job.next_due_at > now) return { kind: 'settled' };
    if (!isNonterminalJobState(job.state)) {
      sql.exec(`UPDATE analysis_jobs SET next_due_at = NULL, updated_at = ? WHERE job_id = ?`, now, jobId);
      return { kind: 'settled' };
    }
    // A nonterminal job whose parent was deleted can never be attached.
    const parent = liveParent(sql, job.interview_id);
    if (!parent) {
      settleJob(sql, job, { state: 'cancelled' }, null, now);
      return { kind: 'settled' };
    }
    // Allocation always makes the active job current: anything else is
    // structural corruption, quarantined without a write (JOB-04, F13).
    const row = readAnalysisRow(sql, job.interview_id);
    if (!row || row.current_generation !== job.generation) return { kind: 'corrupt' };
    // Activation reconciles restored work; anything still carrying another
    // epoch may have executed and is never dispatched again.
    if (job.recovery_epoch !== meta.activatedEpoch) {
      settleJob(sql, job, { state: 'recovery-required' }, null, now);
      logJobEvent({ operation: 'watchdog', reason: 'epoch-mismatch' });
      return { kind: 'settled' };
    }
    if ((job.state === 'claimed' || job.state === 'started') && job.claim_expires_at !== null && job.claim_expires_at > now) {
      sql.exec(`UPDATE analysis_jobs SET next_due_at = ?, updated_at = ? WHERE job_id = ?`, job.claim_expires_at, now, jobId);
      await armAlarmNoLaterThan(storage, job.claim_expires_at);
      return { kind: 'settled' };
    }
    if (job.state === 'started') {
      // The paid call may have run: never reopen it automatically.
      settleJob(sql, job, { state: 'recovery-required' }, null, now);
      logJobEvent({ operation: 'watchdog', reason: 'lease-expired' });
      return { kind: 'settled' };
    }
    if (now - job.allocated_at >= ANALYSIS_MAX_PRESTART_AGE_MS) return exhaust(sql, job, now);
    if (job.state === 'pending' && job.dispatch_state === 'sent' && consumerContactSince(ws, job.updated_at)) {
      // F6: a consumer has been working since this delivery was acknowledged
      // (or last deferred), so it is queued behind a live backlog. Wait
      // another watchdog interval without charging the budget or re-sending.
      const dueAt = now + ANALYSIS_WATCHDOG_AFTER_SEND_MS;
      sql.exec(`UPDATE analysis_jobs SET next_due_at = ?, updated_at = ? WHERE job_id = ?`, dueAt, now, jobId);
      await armAlarmNoLaterThan(storage, dueAt);
      return { kind: 'settled' };
    }
    if (job.dispatch_attempts >= ANALYSIS_MAX_DISPATCH_ATTEMPTS) return exhaust(sql, job, now);
    const send = reserveDispatch(sql, job, meta, now);
    await armAlarmNoLaterThan(storage, now + dispatchBackoffMs(send.attempt));
    return { kind: 'send', send };
  });
}

function consumerContactSince(ws: WorkspaceContext, since: number): boolean {
  const contactAt = lastConsumerContactAt(ws);
  return contactAt !== null && contactAt > since;
}

/** JOB-07 exhaustion: the pre-start budget or age cap is spent. */
function exhaust(sql: SqlStorage, job: JobRow, now: number): Settlement {
  settleJob(sql, job, { state: 'failed', failureKind: 'storage' }, null, now);
  logJobEvent({ operation: 'dispatch', reason: 'dispatch-exhausted' });
  return { kind: 'settled' };
}

/**
 * One dispatch budget unit: a send reservation for an unsent, unacknowledged
 * or unclaimed delivery, or the recovery of an expired unstarted claim.
 */
function reserveDispatch(sql: SqlStorage, job: JobRow, meta: WorkspaceMeta, now: number): PendingSend {
  const attempt = job.dispatch_attempts + 1;
  sql.exec(
    `UPDATE analysis_jobs
        SET state = 'pending', claim_nonce = NULL, claimed_at = NULL, claim_expires_at = NULL,
            dispatch_state = 'reserved', dispatch_attempts = ?, next_due_at = ?, updated_at = ?
      WHERE job_id = ?`,
    attempt,
    now + dispatchBackoffMs(attempt),
    now,
    job.job_id,
  );
  if (job.state === 'claimed') {
    sql.exec(
      `UPDATE analysis SET status = 'pending', updated_at = ? WHERE interview_id = ? AND current_generation = ?`,
      now,
      job.interview_id,
      job.generation,
    );
    bumpMutationSeq(sql, now);
    logJobEvent({ operation: 'watchdog', reason: 'claim-lost' });
  }
  return {
    jobId: job.job_id,
    attempt,
    message: {
      v: 1,
      workspaceId: meta.workspaceId,
      interviewId: job.interview_id,
      jobId: job.job_id,
      generation: job.generation,
      recoveryEpoch: job.recovery_epoch,
    },
  };
}

/** Send one reserved envelope, then record it. Returns the hold that stopped the record, if any. */
async function dispatch(ws: WorkspaceContext, send: PendingSend): Promise<'ok' | WorkspaceHoldReason> {
  const queue = ws.env.ANALYSIS_QUEUE;
  if (!queue || typeof queue.send !== 'function') {
    logJobEvent({ operation: 'dispatch', reason: 'binding-missing' });
    return 'ok';
  }
  try {
    await queue.send(send.message, { contentType: 'json' });
  } catch (error) {
    // The reservation and its backoff wake-up are already durable.
    logJobEvent({ operation: 'dispatch', reason: 'queue-send-failed', error });
    return 'ok';
  }
  return ws.storage.transaction(async (): Promise<'ok' | WorkspaceHoldReason> => {
    // A freeze that committed during the send leaves the reservation as it
    // is; the delivery is refused while held and re-sent after resume.
    const gated = gate(ws, 'job-settlement');
    if (!gated.ok) return gated.reason;
    const now = Date.now();
    const dueAt = now + ANALYSIS_WATCHDOG_AFTER_SEND_MS;
    // Only the reservation that was sent may be acknowledged; a claim or a
    // newer reservation that raced this send keeps its own state.
    const cursor = ws.sql.exec(
      `UPDATE analysis_jobs SET dispatch_state = 'sent', next_due_at = ?, updated_at = ?
        WHERE job_id = ? AND state = 'pending' AND dispatch_state = 'reserved' AND dispatch_attempts = ?`,
      dueAt,
      now,
      send.jobId,
      send.attempt,
    );
    cursor.toArray();
    // A long backoff may have armed later than the watchdog check (JOB-06).
    if (cursor.rowsWritten > 0) await armAlarmNoLaterThan(ws.storage, dueAt);
    return 'ok';
  });
}

// ---------- Bounded cleanup ----------

type CleanupStep = { sql: string; bindings: unknown[] };

function cleanupSteps(now: number): CleanupStep[] {
  const bounded = (table: string, predicate: string, ...bindings: unknown[]): CleanupStep => ({
    sql: `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${predicate} LIMIT ?)`,
    bindings: [...bindings, CLEANUP_BATCH],
  });
  return [
    bounded('consents', 'expires_at <= ?', now),
    bounded('participant_links', 'expires_at IS NOT NULL AND expires_at <= ?', now - LINK_CLEANUP_GRACE_MS),
    bounded('idempotency_receipts', 'expires_at <= ?', now),
    bounded('budget_windows', 'expires_at <= ?', now),
    bounded('budget_members', 'expires_at <= ?', now),
    bounded('deletion_fences', 'expires_at <= ?', now),
    // Terminal detail only; the current generation of every interview is kept
    // for the interview's lifetime and nonterminal jobs never expire.
    bounded(
      'analysis_jobs',
      `terminal_at IS NOT NULL AND terminal_at <= ?
         AND state IN ('complete','failed','recovery-required','cancelled')
         AND NOT EXISTS (SELECT 1 FROM analysis a
                          WHERE a.interview_id = analysis_jobs.interview_id
                            AND a.current_generation = analysis_jobs.generation)`,
      now - ANALYSIS_TERMINAL_JOB_RETENTION_MS,
    ),
  ];
}

/** Delete one bounded batch per family; `remains` when a batch was full. */
function cleanup(ws: WorkspaceContext): { ok: true; remains: boolean } | { ok: false; reason: WorkspaceHoldReason } {
  const now = Date.now();
  return ws.storage.transactionSync(() => {
    const gated = gate(ws, 'job-settlement');
    if (!gated.ok) return { ok: false as const, reason: gated.reason };
    let remains = false;
    for (const step of cleanupSteps(now)) {
      const cursor = ws.sql.exec(step.sql, ...step.bindings);
      cursor.toArray();
      if (cursor.rowsWritten >= CLEANUP_BATCH) remains = true;
    }
    return { ok: true as const, remains };
  });
}

function minimum(values: ReadonlyArray<number | null>): number | null {
  const present = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return present.length > 0 ? Math.min(...present) : null;
}

/** Earliest expiry that cleanup will act on, never sooner than the cleanup interval. */
function nextCleanupAt(sql: SqlStorage, now: number): number | null {
  const earliest = (query: string): number | null => {
    const row = sql.exec<{ at: number | null }>(query).toArray()[0];
    return row && typeof row.at === 'number' ? row.at : null;
  };
  const links = earliest(`SELECT MIN(expires_at) AS at FROM participant_links WHERE expires_at IS NOT NULL`);
  const jobs = earliest(
    `SELECT MIN(j.terminal_at) AS at FROM analysis_jobs j
      WHERE j.terminal_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM analysis a WHERE a.interview_id = j.interview_id AND a.current_generation = j.generation)`,
  );
  const next = minimum([
    earliest(`SELECT MIN(expires_at) AS at FROM consents`),
    links === null ? null : links + LINK_CLEANUP_GRACE_MS,
    earliest(`SELECT MIN(expires_at) AS at FROM idempotency_receipts`),
    earliest(`SELECT MIN(expires_at) AS at FROM budget_windows`),
    earliest(`SELECT MIN(expires_at) AS at FROM budget_members`),
    earliest(`SELECT MIN(expires_at) AS at FROM deletion_fences`),
    jobs === null ? null : jobs + ANALYSIS_TERMINAL_JOB_RETENTION_MS,
  ]);
  return next === null ? null : Math.max(next, now + CLEANUP_INTERVAL_MS);
}

/**
 * Earliest job wake-up: a quarantined row counts at its release, any other
 * row at its due time. Every quarantined row that could come first is within
 * the first `skipped + 1` rows, and entries for rows no longer due are ignored.
 */
function nextJobWakeAt(sql: SqlStorage, quarantine: Map<string, QuarantineEntry>, now: number): number | null {
  const skipped = activeQuarantine(quarantine, now);
  const rows = sql
    .exec<{ job_id: string; next_due_at: number }>(
      `SELECT job_id, next_due_at FROM analysis_jobs WHERE next_due_at IS NOT NULL
        ORDER BY next_due_at, job_id LIMIT ?`,
      skipped.size + 1,
    )
    .toArray();
  const candidates: number[] = [];
  for (const row of rows) {
    const entry = skipped.has(row.job_id) ? quarantine.get(row.job_id) : undefined;
    if (!entry) {
      candidates.push(row.next_due_at);
      break;
    }
    candidates.push(Math.max(row.next_due_at, entry.until));
  }
  return minimum(candidates);
}

/** Keep one wake-up at the earliest due job or cleanup; immediately when a batch was cut short. */
async function rearm(
  ws: WorkspaceContext,
  jobsRemain: boolean,
  cleanupRemains: boolean,
  quarantine: Map<string, QuarantineEntry>,
): Promise<void> {
  await ws.storage.transaction(async () => {
    const now = Date.now();
    const next = minimum([
      jobsRemain ? now : nextJobWakeAt(ws.sql, quarantine, now),
      cleanupRemains ? now : nextCleanupAt(ws.sql, now),
    ]);
    if (next !== null) await armAlarmNoLaterThan(ws.storage, next);
  });
}
