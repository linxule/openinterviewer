// Shared state and invariants for WorkspaceStore domain modules.
//
// Every domain function receives a WorkspaceContext. It never receives an
// HTTP request, a Next context or a provider key: the object owns SQL,
// transactions, the outbox and its single alarm; provider execution happens
// in the Queue consumer.

import type {
  AnalysisJobState,
  FrozenAnalysisInput,
} from '../../src/lib/storage/analysisProtocol';
import { isValidRecoveryEpoch, isValidWorkspaceId } from '../../src/lib/storage/analysisProtocol';
import type { MaintenanceState, WorkspaceHoldReason } from '../../src/lib/storage/types';

export type WorkspaceEnv = {
  WORKSPACE_ID?: string;
  ANALYSIS_RECOVERY_EPOCH?: string;
  /** 'open' | 'recovery' only while an installer initializes a fresh object. */
  WORKSPACE_BOOTSTRAP?: string;
  ANALYSIS_QUEUE?: Queue<unknown>;
  [key: string]: unknown;
};

export type WorkspaceMeta = {
  workspaceId: string;
  activatedEpoch: string;
  maintenanceState: MaintenanceState;
  maintenanceVersion: number;
  mutationSeq: number;
};

export type WorkspaceContext = {
  sql: SqlStorage;
  storage: DurableObjectStorage;
  env: WorkspaceEnv;
  /** The object's name as selected by getByName (the configured WORKSPACE_ID). */
  objectName: string | undefined;
};

/**
 * Operation classes for the maintenance matrix (OPS-01).
 * - read: researcher/operator reads; allowed in every state.
 * - participant-entry: link exchange / new collection starts; open only.
 * - participant-session: consent, admission, save by an existing session; open or draining.
 * - researcher-mutation: study/link/aggregate/sample writes and analysis retries; open only.
 * - job-settlement: dispatch, claim, start, finish; open or draining.
 */
export type OperationClass =
  | 'read'
  | 'participant-entry'
  | 'participant-session'
  | 'researcher-mutation'
  | 'job-settlement';

const ALLOWED: Record<OperationClass, ReadonlyArray<MaintenanceState>> = {
  read: ['open', 'draining', 'frozen', 'recovery'],
  'participant-entry': ['open'],
  'participant-session': ['open', 'draining'],
  'researcher-mutation': ['open'],
  'job-settlement': ['open', 'draining'],
};

type MetaRow = {
  workspace_id: string;
  activated_epoch: string;
  maintenance_state: MaintenanceState;
  maintenance_version: number;
  mutation_seq: number;
};

export function readMeta(sql: SqlStorage): WorkspaceMeta | null {
  const rows = sql
    .exec<MetaRow>(
      `SELECT workspace_id, activated_epoch, maintenance_state, maintenance_version, mutation_seq
         FROM workspace_meta WHERE singleton = 1`,
    )
    .toArray();
  if (rows.length !== 1) return null;
  const row = rows[0];
  return {
    workspaceId: row.workspace_id,
    activatedEpoch: row.activated_epoch,
    maintenanceState: row.maintenance_state,
    maintenanceVersion: row.maintenance_version,
    mutationSeq: row.mutation_seq,
  };
}

export type GateResult =
  | { ok: true; meta: WorkspaceMeta }
  | { ok: false; reason: WorkspaceHoldReason };

/**
 * Identity, recovery epoch and maintenance checks performed at every RPC
 * entry. Reads are allowed under an epoch mismatch so an operator can inspect
 * a restored workspace; every write and job operation is refused.
 */
export function gate(ws: WorkspaceContext, operation: OperationClass): GateResult {
  const meta = readMeta(ws.sql);
  if (!meta) return { ok: false, reason: 'schema-unsupported' };
  const configuredId = ws.env.WORKSPACE_ID;
  if (!isValidWorkspaceId(configuredId) || configuredId !== meta.workspaceId) {
    return { ok: false, reason: 'workspace-identity-mismatch' };
  }
  if (ws.objectName !== undefined && ws.objectName !== meta.workspaceId) {
    return { ok: false, reason: 'workspace-identity-mismatch' };
  }
  if (operation !== 'read') {
    const epoch = ws.env.ANALYSIS_RECOVERY_EPOCH;
    if (!isValidRecoveryEpoch(epoch) || epoch !== meta.activatedEpoch) {
      return { ok: false, reason: 'recovery-epoch-mismatch' };
    }
  }
  if (!ALLOWED[operation].includes(meta.maintenanceState)) {
    return { ok: false, reason: 'maintenance' };
  }
  return { ok: true, meta };
}

/** Advance the research mutation sequence (export snapshot fence, ST-08). */
export function bumpMutationSeq(sql: SqlStorage, now: number): void {
  sql.exec(
    `UPDATE workspace_meta SET mutation_seq = mutation_seq + 1, updated_at = ? WHERE singleton = 1`,
    now,
  );
}

/**
 * Keep the object's single alarm at or before `dueAt`. Must be awaited inside
 * `storage.transaction(async () => …)` together with the SQL that made the
 * wake-up necessary, so the commit and its wake-up are one durable unit.
 */
export async function armAlarmNoLaterThan(storage: DurableObjectStorage, dueAt: number): Promise<void> {
  const current = await storage.getAlarm();
  if (current === null || dueAt < current) {
    await storage.setAlarm(dueAt);
  }
}

/** Earliest pending job wake-up, or null when no nonterminal job needs one. */
export function earliestJobDue(sql: SqlStorage): number | null {
  const row = sql
    .exec<{ due: number | null }>(`SELECT MIN(next_due_at) AS due FROM analysis_jobs WHERE next_due_at IS NOT NULL`)
    .one();
  return typeof row.due === 'number' ? row.due : null;
}

export type AllocateGenerationInput = {
  interviewId: string;
  generation: number;
  jobId: string;
  recoveryEpoch: string;
  frozen: FrozenAnalysisInput;
  now: number;
};

/**
 * Insert a pending generation and point the interview's analysis projection
 * at it. Callers run this inside `storage.transaction(async)` after checking
 * that no active generation exists, then arm the alarm for the returned due
 * time before the transaction commits (JOB-01/04/05).
 */
export function allocateGeneration(ws: WorkspaceContext, input: AllocateGenerationInput): number {
  const dueAt = input.now;
  ws.sql.exec(
    `INSERT INTO analysis_jobs (
       job_id, interview_id, generation, recovery_epoch, state, input_json,
       requested_provider, requested_model, allocated_at, updated_at,
       dispatch_state, dispatch_attempts, next_due_at
     ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, 'unsent', 0, ?)`,
    input.jobId,
    input.interviewId,
    input.generation,
    input.recoveryEpoch,
    JSON.stringify(input.frozen),
    input.frozen.requestedProvider,
    input.frozen.requestedModel,
    input.now,
    input.now,
    dueAt,
  );
  ws.sql.exec(
    `UPDATE analysis
        SET status = 'pending', current_generation = ?, failure_kind = NULL,
            recovery_required = 0, updated_at = ?
      WHERE interview_id = ?`,
    input.generation,
    input.now,
    input.interviewId,
  );
  return dueAt;
}

export function jobStateIsActive(state: AnalysisJobState): boolean {
  return state === 'pending' || state === 'claimed' || state === 'started';
}

/**
 * Wake-up interval the alarm keeps while the object is held by a condition a
 * compatible redeploy clears (an unreadable schema, a missing or mismatched
 * workspace identity), so dispatch resumes without waiting for a request.
 */
export const HELD_ALARM_RETRY_MS = 60 * 60 * 1000;

export const RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DELETION_FENCE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
