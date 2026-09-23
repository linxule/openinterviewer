// Durable analysis generations (03-analysis-jobs.md): researcher retry and
// status (JOB-04, API-01/02) and the Queue consumer's claim/start/finish
// (JOB-02/03/08). Every entry re-checks workspace identity, recovery epoch,
// maintenance, parent existence, current generation and claim nonce. No
// provider call and no credential ever reaches this module.

import type {
  AIProviderType,
  InterviewAnalysisFailureKind,
  StoredInterview,
} from '../../src/types';
import type * as Protocol from '../../src/lib/storage/analysisProtocol';
import {
  ANALYSIS_CLAIM_LEASE_MS,
  ANALYSIS_INPUT_SCHEMA_VERSION,
  ANALYSIS_MAX_PRESTART_AGE_MS,
  ANALYSIS_POLL_AFTER_MS,
  ANALYSIS_RETRY_RECEIPT_TTL_MS,
  MAX_ATTACHED_SYNTHESIS_BYTES,
  isNonterminalJobState,
} from '../../src/lib/storage/analysisProtocol';
import type { WorkspaceHoldReason } from '../../src/lib/storage/types';
import { isProviderType } from '../../src/lib/providers/synthesisModel';
import { validateSynthesisResult } from '../../src/lib/providerValidation';
import { validateProvenance } from '../../src/lib/synthesisProvenance';
import { serializedByteLength } from '../analysis/policy';
import { logJobEvent, type JobOperation } from '../analysis/telemetry';
import type * as Rpc from './rpcTypes';
import {
  allocateGeneration,
  armAlarmNoLaterThan,
  bumpMutationSeq,
  earliestJobDue,
  gate,
  type WorkspaceContext,
  type WorkspaceMeta,
} from './context';
import {
  ANALYSIS_COLUMNS,
  CorruptRecordError,
  parseRecord,
  projectAnalysisState,
  type AnalysisRow,
} from './projection';

export const RETRY_RECEIPT_FAMILY = 'analysis-retry';

const FAILURE_KINDS: ReadonlyArray<InterviewAnalysisFailureKind> = [
  'provider',
  'invalid-output',
  'too-large',
  'timeout',
  'storage',
];
const NONCE = /^[A-Za-z0-9-]{16,64}$/;
const DIGEST = /^[A-Za-z0-9_+/=-]{16,128}$/;

// ---------- Rows ----------

export type JobRow = {
  job_id: string;
  interview_id: string;
  generation: number;
  recovery_epoch: string;
  state: Protocol.AnalysisJobState;
  input_json: string;
  requested_provider: string;
  requested_model: string;
  allocated_at: number;
  updated_at: number;
  dispatch_state: 'unsent' | 'reserved' | 'sent' | 'none';
  dispatch_attempts: number;
  next_due_at: number | null;
  claim_nonce: string | null;
  claimed_at: number | null;
  claim_expires_at: number | null;
  started_at: number | null;
  terminal_at: number | null;
  failure_kind: string | null;
  terminal_receipt_json: string | null;
};

const JOB_COLUMNS = `job_id, interview_id, generation, recovery_epoch, state, input_json, requested_provider,
  requested_model, allocated_at, updated_at, dispatch_state, dispatch_attempts, next_due_at, claim_nonce,
  claimed_at, claim_expires_at, started_at, terminal_at, failure_kind, terminal_receipt_json`;

type InterviewRow = { id: string; study_id: string; record_json: string };

type TerminalReceipt = { claimNonce: string | null; state: Protocol.AnalysisJobState; at: number };

export function readJob(sql: SqlStorage, jobId: string): JobRow | null {
  return sql.exec<JobRow>(`SELECT ${JOB_COLUMNS} FROM analysis_jobs WHERE job_id = ?`, jobId).toArray()[0] ?? null;
}

function readJobByGeneration(sql: SqlStorage, interviewId: string, generation: number): JobRow | null {
  return sql
    .exec<JobRow>(`SELECT ${JOB_COLUMNS} FROM analysis_jobs WHERE interview_id = ? AND generation = ?`, interviewId, generation)
    .toArray()[0] ?? null;
}

function readActiveJob(sql: SqlStorage, interviewId: string): JobRow | null {
  const rows = sql
    .exec<JobRow>(
      `SELECT ${JOB_COLUMNS} FROM analysis_jobs WHERE interview_id = ? AND state IN ('pending','claimed','started')`,
      interviewId,
    )
    .toArray();
  if (rows.length > 1) throw new CorruptRecordError('analysis');
  return rows[0] ?? null;
}

function countJobs(sql: SqlStorage, interviewId: string): number {
  return sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM analysis_jobs WHERE interview_id = ?`, interviewId).one().n;
}

function readInterview(sql: SqlStorage, interviewId: string): InterviewRow | null {
  return sql
    .exec<InterviewRow>(`SELECT id, study_id, record_json FROM interviews WHERE id = ?`, interviewId)
    .toArray()[0] ?? null;
}

export function readAnalysisRow(sql: SqlStorage, interviewId: string): AnalysisRow | null {
  return sql
    .exec<AnalysisRow>(`SELECT ${ANALYSIS_COLUMNS} FROM analysis WHERE interview_id = ?`, interviewId)
    .toArray()[0] ?? null;
}

/** A deleted study or interview stays fenced: nothing may recreate or settle it. */
export function isFenced(sql: SqlStorage, studyId: string, interviewId: string): boolean {
  const row = sql
    .exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM deletion_fences
        WHERE (kind = 'study' AND target_id = ?) OR (kind = 'interview' AND target_id = ?)`,
      studyId,
      interviewId,
    )
    .one();
  return row.n > 0;
}

/** The interview a job belongs to, when it still exists and is not fenced. */
export function liveParent(sql: SqlStorage, interviewId: string): InterviewRow | null {
  const interview = readInterview(sql, interviewId);
  if (!interview || isFenced(sql, interview.study_id, interviewId)) return null;
  return interview;
}

function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isFailureKind(value: unknown): value is InterviewAnalysisFailureKind {
  return typeof value === 'string' && (FAILURE_KINDS as ReadonlyArray<string>).includes(value);
}

export function parseFrozenInput(inputJson: string): Protocol.FrozenAnalysisInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputJson);
  } catch {
    throw new CorruptRecordError('analysis');
  }
  if (!isFrozenInput(parsed)) throw new CorruptRecordError('analysis');
  return parsed;
}

function isFrozenInput(value: unknown): value is Protocol.FrozenAnalysisInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const config = input.studyConfig as Record<string, unknown> | null | undefined;
  return input.inputSchemaVersion === ANALYSIS_INPUT_SCHEMA_VERSION
    && typeof input.studyRevision === 'number'
    && Number.isSafeInteger(input.studyRevision)
    && input.studyRevision >= 1
    && isProviderType(input.requestedProvider)
    && typeof input.requestedModel === 'string'
    && input.requestedModel.trim().length > 0
    && input.requestedModel.length <= 200
    && !!config
    && typeof config === 'object'
    && !Array.isArray(config)
    && typeof config.id === 'string';
}

function logCorrupt(operation: JobOperation): void {
  logJobEvent({ operation, reason: 'corrupt-record' });
}

// ---------- Scheduler liveness ----------

/**
 * Last time a consumer invocation reached a job RPC past the workspace and
 * epoch fence (F6). Operational liveness only: kept in the object's key-value
 * storage, outside the research tables, the backup families and the mutation
 * sequence.
 */
export const CONSUMER_CONTACT_KEY = 'analysis.consumerContactAt';

function recordConsumerContact(ws: WorkspaceContext): void {
  try {
    ws.storage.kv.put(CONSUMER_CONTACT_KEY, Date.now());
  } catch (error) {
    // Advisory: without it the watchdog charges the budget as if no consumer ran.
    logJobEvent({ operation: 'consume', reason: 'unavailable', error });
  }
}

/** Null when none was recorded or it cannot be read: the watchdog then charges as specified. */
export function lastConsumerContactAt(ws: WorkspaceContext): number | null {
  try {
    const value = ws.storage.kv.get<unknown>(CONSUMER_CONTACT_KEY);
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * JOB-05: the scheduler stays inert and does not re-arm itself while the
 * workspace is held. Maintenance resume re-arms; a hold cleared any other way
 * (a corrected epoch or identity binding) is healed by the next job-capable
 * entry that finds due work without an alarm.
 */
async function restoreLostWakeUp(ws: WorkspaceContext): Promise<void> {
  try {
    if (!gate(ws, 'job-settlement').ok) return;
    if ((await ws.storage.getAlarm()) !== null) return;
    const due = earliestJobDue(ws.sql);
    if (due !== null) await ws.storage.setAlarm(due);
  } catch (error) {
    logJobEvent({ operation: 'alarm', reason: 'unavailable', error });
  }
}

// ---------- Public projection (API-02) ----------

function pendingBody(job: JobRow): Protocol.AnalysisStatusBody {
  return {
    status: 'pending',
    generation: job.generation,
    phase: job.state === 'pending' ? 'queued' : 'running',
    pollAfterMs: ANALYSIS_POLL_AFTER_MS,
  };
}

const RECOVERY_BODY = (generation: number): Protocol.AnalysisStatusBody => ({
  status: 'failed',
  generation,
  failureKind: 'timeout',
  recoveryRequired: true,
});

/**
 * The closed status body for an interview. Nonterminal analysis state without
 * an active job can only come from a restore or import: it projects
 * recovery-required, never an eligible not-scheduled record, except a
 * generation-0 record that never had a job.
 */
function statusBody(
  record: StoredInterview,
  row: AnalysisRow | null,
  active: JobRow | null,
  jobCount: number,
): Protocol.AnalysisStatusBody {
  if (active) return pendingBody(active);
  if (row) {
    projectAnalysisState(row);
    const generation = row.current_generation;
    if (row.status === 'complete') return { status: 'complete', generation };
    if (row.status === 'failed') {
      if (row.recovery_required === 1) return RECOVERY_BODY(generation);
      if (!isFailureKind(row.failure_kind)) throw new CorruptRecordError('analysis');
      return { status: 'failed', generation, failureKind: row.failure_kind, recoveryRequired: false };
    }
    // An attempted generation-0 record may have executed (F7): never schedulable.
    if (row.status === 'pending' && generation === 0 && jobCount === 0 && !record.synthesis && row.attempts === 0) {
      return { status: 'pending', generation: 0, phase: 'not-scheduled' };
    }
    return RECOVERY_BODY(generation);
  }
  if (jobCount > 0) throw new CorruptRecordError('analysis');
  if (record.synthesis) return { status: 'complete', generation: 0 };
  const legacy = record.analysis;
  if (!legacy) return { status: 'pending', generation: 0, phase: 'not-scheduled' };
  if (legacy.status === 'pending') {
    return legacyAttempts(record).attempts === 0 ? { status: 'pending', generation: 0, phase: 'not-scheduled' } : RECOVERY_BODY(0);
  }
  if (legacy.status === 'running') return RECOVERY_BODY(0);
  if (legacy.status === 'failed' && isFailureKind(legacy.failureKind)) {
    return legacy.failureKind === 'timeout' && legacy.recoveryRequired
      ? RECOVERY_BODY(0)
      : { status: 'failed', generation: 0, failureKind: legacy.failureKind, recoveryRequired: false };
  }
  throw new CorruptRecordError('record');
}

function jobBody(job: JobRow): Protocol.AnalysisStatusBody | null {
  if (isNonterminalJobState(job.state)) return pendingBody(job);
  if (job.state === 'complete') return { status: 'complete', generation: job.generation };
  if (job.state === 'recovery-required') return RECOVERY_BODY(job.generation);
  if (job.state === 'failed' && isFailureKind(job.failure_kind)) {
    return { status: 'failed', generation: job.generation, failureKind: job.failure_kind, recoveryRequired: false };
  }
  return null;
}

type InterviewState = {
  record: StoredInterview;
  row: AnalysisRow | null;
  active: JobRow | null;
  jobCount: number;
};

/** Null when the record is not an analyzable (completed) interview, as the Redis attach script refuses it. */
function readInterviewState(sql: SqlStorage, interview: InterviewRow): InterviewState | null {
  const record = parseRecord(interview.record_json, interview.id);
  if (record.studyId !== interview.study_id) throw new CorruptRecordError('record');
  if (record.status !== 'completed') return null;
  return {
    record,
    row: readAnalysisRow(sql, interview.id),
    active: readActiveJob(sql, interview.id),
    jobCount: countJobs(sql, interview.id),
  };
}

// ---------- Researcher: status (API-02) ----------

export async function readAnalysisStatus(
  ws: WorkspaceContext,
  input: Rpc.AnalysisStatusInput,
): Promise<Protocol.ReadAnalysisStatusOutcome> {
  const gated = gate(ws, 'read');
  if (!gated.ok) return { status: 'unavailable' };
  try {
    const interview = liveParent(ws.sql, input.interviewId);
    if (!interview || interview.study_id !== input.studyId) return { status: 'not-found' };
    const state = readInterviewState(ws.sql, interview);
    if (!state) return { status: 'not-found' };
    const body = statusBody(state.record, state.row, state.active, state.jobCount);
    if (body.status === 'pending' && body.phase !== 'not-scheduled') await restoreLostWakeUp(ws);
    return { status: 'ok', body };
  } catch (error) {
    if (error instanceof CorruptRecordError) {
      logCorrupt('status');
      return { status: 'corrupt' };
    }
    return { status: 'unavailable' };
  }
}

// ---------- Researcher: explicit retry (JOB-04, API-01) ----------

type RetryReceiptRow = {
  fingerprint: string;
  target_id: string | null;
  disposition: string;
  result_json: string | null;
  expires_at: number;
};

function storeRetryReceipt(
  sql: SqlStorage,
  input: Protocol.AcceptAnalysisRetryInput,
  disposition: 'accepted' | 'existing',
  generation: number,
): void {
  sql.exec(
    `INSERT INTO idempotency_receipts
       (operation_family, key_digest, fingerprint, target_id, disposition, result_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (operation_family, key_digest) DO UPDATE SET
       fingerprint = excluded.fingerprint, target_id = excluded.target_id,
       disposition = excluded.disposition, result_json = excluded.result_json,
       created_at = excluded.created_at, expires_at = excluded.expires_at`,
    RETRY_RECEIPT_FAMILY,
    input.requestKeyDigest,
    input.requestFingerprint,
    input.interviewId,
    disposition,
    JSON.stringify({ generation }),
    input.now,
    input.now + ANALYSIS_RETRY_RECEIPT_TTL_MS,
  );
}

function receiptGeneration(receipt: RetryReceiptRow): number {
  let parsed: unknown;
  try {
    parsed = receipt.result_json === null ? null : JSON.parse(receipt.result_json);
  } catch {
    throw new CorruptRecordError('analysis');
  }
  const generation = (parsed as { generation?: unknown } | null)?.generation;
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1) {
    throw new CorruptRecordError('analysis');
  }
  return generation;
}

function validRetryInput(input: Protocol.AcceptAnalysisRetryInput): boolean {
  return typeof input.studyId === 'string'
    && typeof input.interviewId === 'string'
    && typeof input.requestKeyDigest === 'string' && DIGEST.test(input.requestKeyDigest)
    && typeof input.requestFingerprint === 'string' && DIGEST.test(input.requestFingerprint)
    && Number.isSafeInteger(input.expectedGeneration) && input.expectedGeneration >= 0
    && Number.isSafeInteger(input.now) && input.now > 0
    && isFrozenInput(input.input)
    && input.input.studyConfig.id === input.studyId;
}

function legacyAttempts(record: StoredInterview): { attempts: number; lastAttemptAt: number | null } {
  const legacy = record.analysis;
  return {
    attempts: legacy && isSafeCount(legacy.attempts) ? legacy.attempts : 0,
    lastAttemptAt: legacy && isSafeCount(legacy.lastAttemptAt) ? legacy.lastAttemptAt : null,
  };
}

export async function acceptAnalysisRetry(
  ws: WorkspaceContext,
  input: Protocol.AcceptAnalysisRetryInput,
): Promise<Protocol.AcceptAnalysisRetryOutcome> {
  const gated = gate(ws, 'researcher-mutation');
  if (!gated.ok) return { status: 'held', reason: gated.reason };
  if (!validRetryInput(input)) return { status: 'unavailable' };
  const meta = gated.meta;
  // Minted outside the transaction callback so a retried callback reuses it.
  const jobId = crypto.randomUUID();
  const { sql } = ws;
  try {
    return await ws.storage.transaction(async (): Promise<Protocol.AcceptAnalysisRetryOutcome> => {
      const interview = liveParent(sql, input.interviewId);
      if (!interview || interview.study_id !== input.studyId) return { status: 'not-found' };
      const study = sql
        .exec<{ revision: number }>(`SELECT revision FROM studies WHERE id = ?`, input.studyId)
        .toArray()[0];
      if (!study) return { status: 'not-found' };
      const state = readInterviewState(sql, interview);
      if (!state) return { status: 'not-found' };
      const currentGeneration = state.active?.generation ?? state.row?.current_generation ?? 0;

      const receipt = sql
        .exec<RetryReceiptRow>(
          `SELECT fingerprint, target_id, disposition, result_json, expires_at FROM idempotency_receipts
            WHERE operation_family = ? AND key_digest = ?`,
          RETRY_RECEIPT_FAMILY,
          input.requestKeyDigest,
        )
        .toArray()[0];
      // An expired receipt is ignored; the generation check below still stops
      // it from allocating over a different expectedGeneration.
      if (receipt && receipt.expires_at > input.now) {
        if (receipt.fingerprint !== input.requestFingerprint || receipt.target_id !== input.interviewId) {
          return { status: 'key-conflict' };
        }
        const generation = receiptGeneration(receipt);
        if (generation > currentGeneration) throw new CorruptRecordError('analysis');
        const status = receipt.disposition === 'existing' ? 'existing' : 'accepted';
        if (generation === currentGeneration) {
          return { status, body: statusBody(state.record, state.row, state.active, state.jobCount) };
        }
        const job = readJobByGeneration(sql, input.interviewId, generation);
        const body = job ? jobBody(job) : null;
        return body ? { status, body } : { status: 'state-changed' };
      }

      const body = statusBody(state.record, state.row, state.active, state.jobCount);
      if (body.status === 'complete') {
        return { status: 'already-complete', body: { status: 'already-complete', generation: body.generation } };
      }
      if (state.active) {
        storeRetryReceipt(sql, input, 'existing', state.active.generation);
        await restoreLostWakeUp(ws);
        return { status: 'existing', body: pendingBody(state.active) };
      }
      if (input.expectedGeneration !== currentGeneration) return { status: 'state-changed' };
      // Acceptance-time configuration must be the study's current revision.
      if (study.revision !== input.input.studyRevision) return { status: 'state-changed' };
      const generation = currentGeneration + 1;
      if (!Number.isSafeInteger(generation)) return { status: 'unavailable' };

      if (!state.row) {
        const legacy = legacyAttempts(state.record);
        sql.exec(
          `INSERT INTO analysis (interview_id, status, current_generation, attempts, last_attempt_at,
             failure_kind, recovery_required, study_revision, synthesis_json, provenance_json, updated_at)
           VALUES (?, 'pending', 0, ?, ?, NULL, 0, NULL, NULL, NULL, ?)`,
          input.interviewId,
          legacy.attempts,
          legacy.lastAttemptAt ?? input.now,
          input.now,
        );
      }
      const dueAt = allocateGeneration(ws, {
        interviewId: input.interviewId,
        generation,
        jobId,
        recoveryEpoch: meta.activatedEpoch,
        frozen: input.input,
        now: input.now,
      });
      storeRetryReceipt(sql, input, 'accepted', generation);
      bumpMutationSeq(sql, input.now);
      await armAlarmNoLaterThan(ws.storage, dueAt);
      return {
        status: 'accepted',
        body: { status: 'pending', generation, phase: 'queued', pollAfterMs: ANALYSIS_POLL_AFTER_MS },
      };
    });
  } catch (error) {
    if (error instanceof CorruptRecordError) {
      logCorrupt('retry');
      return { status: 'corrupt' };
    }
    return { status: 'unavailable' };
  }
}

// ---------- Queue consumer RPCs (JOB-04/08) ----------

type FenceFailure = 'stale' | 'held';

/** Workspace, epoch and maintenance gate for consumer RPCs. */
function settlementGate(ws: WorkspaceContext, fence: Protocol.JobFence): { ok: true; meta: WorkspaceMeta } | { ok: false; status: FenceFailure } {
  const gated = gate(ws, 'job-settlement');
  if (!gated.ok) return { ok: false, status: gateFailure(gated.reason) };
  if (fence.workspaceId !== gated.meta.workspaceId || fence.recoveryEpoch !== gated.meta.activatedEpoch) {
    return { ok: false, status: 'stale' };
  }
  return { ok: true, meta: gated.meta };
}

function gateFailure(reason: WorkspaceHoldReason): FenceFailure {
  return reason === 'recovery-epoch-mismatch' ? 'stale' : 'held';
}

/**
 * Claim, start and finish decisions use the object's own clock (F14). The
 * caller's `now` is advisory and never moves a lease in either direction.
 */
function objectNow(): number {
  return Date.now();
}

/** JOB-07: past this age an unstarted generation may no longer reach the provider. */
function pastPrestartCap(job: JobRow, now: number): boolean {
  return now - job.allocated_at >= ANALYSIS_MAX_PRESTART_AGE_MS;
}

type CurrentJob =
  | { status: 'current'; job: JobRow; interview: InterviewRow; row: AnalysisRow }
  | { status: 'not-found' | 'cancelled' | 'stale' };

/** The job named by the fence, if it is still the current generation of a live interview. */
function currentJob(sql: SqlStorage, fence: Protocol.JobFence): CurrentJob {
  const job = readJob(sql, fence.jobId);
  if (!job) return { status: 'not-found' };
  if (
    job.interview_id !== fence.interviewId
    || job.generation !== fence.generation
    || job.recovery_epoch !== fence.recoveryEpoch
  ) {
    return { status: 'stale' };
  }
  if (job.state === 'cancelled') return { status: 'cancelled' };
  const interview = liveParent(sql, job.interview_id);
  if (!interview) return { status: 'cancelled' };
  const row = readAnalysisRow(sql, job.interview_id);
  if (!row) throw new CorruptRecordError('analysis');
  if (row.current_generation !== job.generation) return { status: 'stale' };
  return { status: 'current', job, interview, row };
}

function claimedInputs(job: JobRow, interview: InterviewRow, leaseExpiresAt: number): Protocol.ClaimedAnalysisInputs {
  const frozen = parseFrozenInput(job.input_json);
  if (frozen.requestedProvider !== job.requested_provider || frozen.requestedModel !== job.requested_model) {
    throw new CorruptRecordError('analysis');
  }
  const record = parseRecord(interview.record_json, interview.id);
  // A job can only have been allocated for a completed interview.
  if (record.status !== 'completed') throw new CorruptRecordError('record');
  if (
    !Array.isArray(record.transcript)
    || !record.behaviorData || typeof record.behaviorData !== 'object'
    || (record.participantProfile != null && typeof record.participantProfile !== 'object')
  ) {
    throw new CorruptRecordError('record');
  }
  return {
    frozen,
    interview: {
      id: record.id,
      studyId: record.studyId,
      transcript: record.transcript,
      participantProfile: record.participantProfile ?? null,
      behaviorData: record.behaviorData,
    },
    leaseExpiresAt,
  };
}

export async function claimAnalysisJob(
  ws: WorkspaceContext,
  input: Protocol.ClaimAnalysisJobInput,
): Promise<Protocol.ClaimAnalysisJobOutcome> {
  const entry = settlementGate(ws, input);
  if (!entry.ok) return { status: entry.status };
  recordConsumerContact(ws);
  if (typeof input.claimNonce !== 'string' || !NONCE.test(input.claimNonce)) return { status: 'stale' };
  const now = objectNow();
  const { sql } = ws;
  try {
    return await ws.storage.transaction(async (): Promise<Protocol.ClaimAnalysisJobOutcome> => {
      const current = currentJob(sql, input);
      if (current.status !== 'current') return { status: current.status };
      const { job, interview, row } = current;
      switch (job.state) {
        case 'complete':
        case 'failed':
        case 'recovery-required':
          return { status: 'terminal' };
        case 'cancelled':
          return { status: 'cancelled' };
        case 'started':
          return { status: 'busy' };
        case 'claimed':
          // Only the invocation that owns the claim may recover its lost reply.
          if (job.claim_nonce !== input.claimNonce || job.claim_expires_at === null) return { status: 'busy' };
          return { status: 'claimed', replayed: true, inputs: claimedInputs(job, interview, job.claim_expires_at) };
        case 'pending':
          break;
      }
      // A late delivery cannot bypass the pre-start cap the watchdog enforces.
      if (pastPrestartCap(job, now)) {
        settleJob(sql, job, { state: 'failed', failureKind: 'storage' }, null, now);
        logJobEvent({ operation: 'claim', reason: 'dispatch-exhausted' });
        return { status: 'terminal' };
      }
      if (!isSafeCount(row.attempts)) throw new CorruptRecordError('analysis');
      // A valid exhausted counter refuses further attempts without relabeling corruption.
      if (row.attempts >= Number.MAX_SAFE_INTEGER) return { status: 'unavailable' };
      const leaseExpiresAt = now + ANALYSIS_CLAIM_LEASE_MS;
      const inputs = claimedInputs(job, interview, leaseExpiresAt);
      sql.exec(
        `UPDATE analysis_jobs
            SET state = 'claimed', claim_nonce = ?, claimed_at = ?, claim_expires_at = ?,
                next_due_at = ?, updated_at = ?
          WHERE job_id = ?`,
        input.claimNonce,
        now,
        leaseExpiresAt,
        leaseExpiresAt,
        now,
        job.job_id,
      );
      sql.exec(
        `UPDATE analysis SET status = 'running', attempts = attempts + 1, last_attempt_at = ?, updated_at = ?
          WHERE interview_id = ?`,
        now,
        now,
        job.interview_id,
      );
      bumpMutationSeq(sql, now);
      await armAlarmNoLaterThan(ws.storage, leaseExpiresAt);
      return { status: 'claimed', replayed: false, inputs };
    });
  } catch (error) {
    if (error instanceof CorruptRecordError) {
      logCorrupt('claim');
      return { status: 'corrupt' };
    }
    return { status: 'unavailable' };
  }
}

export async function markAnalysisStarted(
  ws: WorkspaceContext,
  input: Protocol.MarkStartedInput,
): Promise<Protocol.MarkStartedOutcome> {
  const entry = settlementGate(ws, input);
  if (!entry.ok) return { status: entry.status };
  recordConsumerContact(ws);
  if (!Number.isSafeInteger(input.requiredRemainingMs) || input.requiredRemainingMs <= 0) {
    return { status: 'unavailable' };
  }
  const now = objectNow();
  const { sql } = ws;
  try {
    return await ws.storage.transaction(async (): Promise<Protocol.MarkStartedOutcome> => {
      const current = currentJob(sql, input);
      if (current.status !== 'current') return { status: 'stale' };
      const { job } = current;
      if (
        (job.state !== 'claimed' && job.state !== 'started')
        || job.claim_nonce !== input.claimNonce
        || job.claim_expires_at === null
      ) {
        return { status: 'stale' };
      }
      if (job.claim_expires_at - now < input.requiredRemainingMs) return { status: 'lease-insufficient' };
      if (job.state === 'started') {
        return { status: 'started', replayed: true, leaseExpiresAt: job.claim_expires_at };
      }
      if (pastPrestartCap(job, now)) {
        settleJob(sql, job, { state: 'failed', failureKind: 'storage' }, null, now);
        logJobEvent({ operation: 'start', reason: 'dispatch-exhausted' });
        return { status: 'stale' };
      }
      sql.exec(
        `UPDATE analysis_jobs SET state = 'started', started_at = ?, updated_at = ? WHERE job_id = ?`,
        now,
        now,
        job.job_id,
      );
      // The claim already armed the lease watchdog; keep it no later than that.
      await armAlarmNoLaterThan(ws.storage, job.claim_expires_at);
      return { status: 'started', replayed: false, leaseExpiresAt: job.claim_expires_at };
    });
  } catch (error) {
    if (error instanceof CorruptRecordError) logCorrupt('start');
    return { status: 'unavailable' };
  }
}

// ---------- Terminal settlement (shared with the scheduler) ----------

export type TerminalSettlement =
  | { state: 'failed'; failureKind: Exclude<InterviewAnalysisFailureKind, 'timeout'> }
  | { state: 'recovery-required' }
  | { state: 'cancelled' };

/**
 * Move a nonterminal job to a terminal state and project it onto the
 * interview's analysis row when the job is still its current generation.
 * Synchronous SQL: callers run it inside a transaction.
 */
export function settleJob(
  sql: SqlStorage,
  job: JobRow,
  settlement: TerminalSettlement,
  claimNonce: string | null,
  now: number,
): void {
  const receipt: TerminalReceipt = { claimNonce, state: settlement.state, at: now };
  const failureKind = settlement.state === 'failed'
    ? settlement.failureKind
    : settlement.state === 'recovery-required' ? 'timeout' : null;
  sql.exec(
    `UPDATE analysis_jobs
        SET state = ?, failure_kind = ?, terminal_at = ?, terminal_receipt_json = ?, next_due_at = NULL,
            dispatch_state = 'none', updated_at = ?
      WHERE job_id = ?`,
    settlement.state,
    failureKind,
    now,
    JSON.stringify(receipt),
    now,
    job.job_id,
  );
  if (settlement.state === 'cancelled') return;
  sql.exec(
    `UPDATE analysis SET status = 'failed', failure_kind = ?, recovery_required = ?, updated_at = ?
      WHERE interview_id = ? AND current_generation = ?`,
    failureKind,
    settlement.state === 'recovery-required' ? 1 : 0,
    now,
    job.interview_id,
    job.generation,
  );
  bumpMutationSeq(sql, now);
}

function terminalReceiptNonce(job: JobRow): string | null {
  if (!job.terminal_receipt_json) return null;
  try {
    const receipt = JSON.parse(job.terminal_receipt_json) as Partial<TerminalReceipt>;
    return typeof receipt.claimNonce === 'string' ? receipt.claimNonce : null;
  } catch {
    return null;
  }
}

type PreparedComplete =
  | { valid: true; synthesisJson: string; provenanceJson: string }
  | { valid: false; failureKind: 'invalid-output' | 'too-large' };

function prepareComplete(
  outcome: Extract<Protocol.FinishAnalysisJobInput['outcome'], { kind: 'complete' }>,
  requestedProvider: string,
  requestedModel: string,
): PreparedComplete {
  let synthesis;
  try {
    synthesis = validateSynthesisResult(outcome.synthesis);
  } catch {
    return { valid: false, failureKind: 'invalid-output' };
  }
  const provided = outcome.provenance;
  const provenance = provided && isProviderType(provided.aiProvider)
    ? validateProvenance({
        aiProvider: provided.aiProvider as AIProviderType,
        aiModel: provided.aiModel,
        requestedAiModel: provided.requestedAiModel,
        routedProvider: provided.routedProvider,
      })
    : null;
  if (!provenance || provenance.aiProvider !== requestedProvider || provenance.requestedAiModel !== requestedModel) {
    return { valid: false, failureKind: 'invalid-output' };
  }
  if (serializedByteLength(synthesis) > MAX_ATTACHED_SYNTHESIS_BYTES) return { valid: false, failureKind: 'too-large' };
  return { valid: true, synthesisJson: JSON.stringify(synthesis), provenanceJson: JSON.stringify(provenance) };
}

function validOutcome(outcome: Protocol.FinishAnalysisJobInput['outcome'] | undefined): boolean {
  if (!outcome || typeof outcome !== 'object') return false;
  if (outcome.kind === 'complete') return !!outcome.synthesis && !!outcome.provenance;
  if (outcome.kind === 'failed') return isFailureKind(outcome.failureKind) && (outcome.failureKind as string) !== 'timeout';
  return outcome.kind === 'uncertain';
}

export async function finishAnalysisJob(
  ws: WorkspaceContext,
  input: Protocol.FinishAnalysisJobInput,
): Promise<Protocol.FinishAnalysisJobOutcome> {
  const entry = settlementGate(ws, input);
  if (!entry.ok) return { status: entry.status };
  recordConsumerContact(ws);
  if (!validOutcome(input.outcome)) return { status: 'stale' };
  const now = objectNow();
  const { sql } = ws;
  try {
    return ws.storage.transactionSync((): Protocol.FinishAnalysisJobOutcome => {
      const current = currentJob(sql, input);
      if (current.status !== 'current') return { status: 'stale' };
      const { job } = current;
      if (job.state === 'complete' || job.state === 'failed' || job.state === 'recovery-required') {
        // Response loss: the same invocation reads its committed receipt; nobody else can.
        return terminalReceiptNonce(job) === input.claimNonce
          ? { status: 'written', replayed: true }
          : { status: 'stale' };
      }
      if (job.claim_nonce !== input.claimNonce || job.claim_expires_at === null) return { status: 'stale' };
      const outcome = input.outcome;
      const startedRequired = outcome.kind !== 'failed';
      if (startedRequired ? job.state !== 'started' : job.state !== 'claimed' && job.state !== 'started') {
        return { status: 'stale' };
      }
      if (now >= job.claim_expires_at) return { status: 'lease-expired' };

      if (outcome.kind === 'failed') {
        settleJob(sql, job, { state: 'failed', failureKind: outcome.failureKind }, input.claimNonce, now);
        return { status: 'written', replayed: false };
      }
      if (outcome.kind === 'uncertain') {
        settleJob(sql, job, { state: 'recovery-required' }, input.claimNonce, now);
        return { status: 'written', replayed: false };
      }
      const frozen = parseFrozenInput(job.input_json);
      const prepared = prepareComplete(outcome, job.requested_provider, job.requested_model);
      if (!prepared.valid) {
        settleJob(sql, job, { state: 'failed', failureKind: prepared.failureKind }, input.claimNonce, now);
        return prepared.failureKind === 'too-large' ? { status: 'too-large' } : { status: 'written', replayed: false };
      }
      const receipt: TerminalReceipt = { claimNonce: input.claimNonce, state: 'complete', at: now };
      sql.exec(
        `UPDATE analysis
            SET status = 'complete', synthesis_json = ?, provenance_json = ?, study_revision = ?,
                failure_kind = NULL, recovery_required = 0, updated_at = ?
          WHERE interview_id = ? AND current_generation = ?`,
        prepared.synthesisJson,
        prepared.provenanceJson,
        frozen.studyRevision,
        now,
        job.interview_id,
        job.generation,
      );
      sql.exec(
        `UPDATE analysis_jobs
            SET state = 'complete', failure_kind = NULL, terminal_at = ?, terminal_receipt_json = ?,
                next_due_at = NULL, dispatch_state = 'none', updated_at = ?
          WHERE job_id = ?`,
        now,
        JSON.stringify(receipt),
        now,
        job.job_id,
      );
      bumpMutationSeq(sql, now);
      return { status: 'written', replayed: false };
    });
  } catch (error) {
    if (error instanceof CorruptRecordError) {
      logCorrupt('finish');
      return { status: 'corrupt' };
    }
    return { status: 'unavailable' };
  }
}
