// Readiness, maintenance modes, operational backup/import and recovery-epoch
// activation (OPS-01, OPS-02, OPS-03, JOB-10, ST-10).
//
// Operator methods check identity and schema only (gate 'read'): they are the
// controlled path out of maintenance and epoch holds, so they cannot depend
// on those holds being clear. Each one enforces its own precondition instead:
//   transitionMaintenance  compare-and-set on {state, version}; leaving for
//                          any state but `recovery` requires the activated
//                          epoch to match the deployment's.
//   exportBackupPage       frozen or recovery; fixed watermark per backup.
//   importBackupChunk      recovery, and an empty workspace when it begins;
//                          bound to one backup file's complete manifest.
//   activateRecoveryEpoch  recovery; compare-and-set on the activated epoch.
//   restoreToBookmark      frozen or recovery at the expected version, and a
//                          configured epoch already rotated away from the
//                          activated one (point-in-time restore, OPS-03).
// Every change appends operator_audit rows with identifiers and counts only,
// never research content. A scheduled restore writes nothing: the restore
// itself would rewind that row, so it is logged as an operator event instead.

import type * as Port from '../../src/lib/storage/types';
import { isRestoreBookmark, RESTORE_WINDOW_MS, type MaintenanceState } from '../../src/lib/storage/types';
import { isValidRecoveryEpoch, isValidWorkspaceId } from '../../src/lib/storage/analysisProtocol';
import {
  BACKUP_FAMILIES,
  BACKUP_FAMILY_NAMES,
  BACKUP_FORMAT_VERSION,
  BACKUP_MAX_CHUNK_ROWS,
  backupFamily,
  backupManifestDigest,
  chunkChecksum,
  isValidBackupRow,
  manifestFromImport,
  type BackupFamily,
  type BackupManifest,
} from '../../src/lib/backup/format';
import { MAX_ATTACHED_SYNTHESIS_BYTES } from '../../src/lib/storage/analysisProtocol';
import { MAX_STORED_AGGREGATE_BYTES } from './reads';
import { MAX_ROW_BYTES } from './studies';
import { logRequestEvent } from '../../src/lib/requestLog';
import type * as Rpc from './rpcTypes';
import {
  armAlarmNoLaterThan,
  bumpMutationSeq,
  gate,
  readMeta,
  type WorkspaceContext,
  type WorkspaceMeta,
} from './context';
import { CorruptRecordError, parseRecord } from './projection';
import { readJob, settleJob, type JobRow } from './analysis';

/** Bounded, write-free readiness: schema, identity, epoch and maintenance state. */
export async function readiness(ws: WorkspaceContext): Promise<Port.StoreReadiness> {
  const meta = readMeta(ws.sql);
  if (!meta) return { status: 'held', reason: 'schema-unsupported' };
  const checked = gate(ws, 'job-settlement');
  if (!checked.ok && checked.reason !== 'maintenance') {
    return { status: 'held', reason: checked.reason, maintenance: meta.maintenanceState };
  }
  return { status: 'ready', maintenance: meta.maintenanceState };
}

// ---------- Shared helpers ----------

const MAINTENANCE_STATES: ReadonlyArray<MaintenanceState> = ['open', 'draining', 'frozen', 'recovery'];
/** Largest backup page the object materializes, whatever pageSize asks for. */
export const BACKUP_MAX_PAGE_BYTES = 8 * 1024 * 1024;
const BACKUP_ROW_OVERHEAD_BYTES = 256;

function isMaintenanceState(value: unknown): value is MaintenanceState {
  return typeof value === 'string' && (MAINTENANCE_STATES as ReadonlyArray<string>).includes(value);
}

function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function epochMatches(ws: WorkspaceContext, meta: WorkspaceMeta): boolean {
  const configured = ws.env.ANALYSIS_RECOVERY_EPOCH;
  return isValidRecoveryEpoch(configured) && configured === meta.activatedEpoch;
}

function storedSchemaVersion(sql: SqlStorage): number {
  const row = sql.exec<{ version: number | null }>(`SELECT MAX(version) AS version FROM schema_migrations`).one();
  return typeof row.version === 'number' ? row.version : 0;
}

function audit(sql: SqlStorage, at: number, action: string, detail: Record<string, unknown>): void {
  sql.exec(`INSERT INTO operator_audit (at, action, detail_json) VALUES (?, ?, ?)`, at, action, JSON.stringify(detail));
}

function logOperator(operation: string, reason?: 'corrupt-record' | 'maintenance-hold' | 'epoch-mismatch' | 'too-large' | 'unavailable'): void {
  logRequestEvent({ event: 'operator.action', operation, ...(reason ? { reason } : {}) });
}

function countRows(sql: SqlStorage, table: string): number {
  // Table names come only from the closed BACKUP_FAMILIES list.
  return sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n;
}

// ---------- Status ----------

export async function operatorStatus(ws: WorkspaceContext): Promise<Rpc.OperatorStatusOutcome> {
  try {
    const checked = gate(ws, 'read');
    if (!checked.ok) return { status: 'held', reason: checked.reason };
    const { meta } = checked;
    const now = Date.now();
    const counts: Record<string, number> = {};
    for (const family of BACKUP_FAMILIES) counts[family.name] = countRows(ws.sql, family.name);
    counts.operator_audit = countRows(ws.sql, 'operator_audit');
    const jobs = { pending: 0, claimed: 0, started: 0, recoveryRequired: 0, oldestActiveAgeMs: null as number | null };
    for (const row of ws.sql
      .exec<{ state: string; n: number; oldest: number | null }>(
        `SELECT state, COUNT(*) AS n, MIN(allocated_at) AS oldest FROM analysis_jobs GROUP BY state`,
      )
      .toArray()) {
      if (row.state === 'pending') jobs.pending = row.n;
      else if (row.state === 'claimed') jobs.claimed = row.n;
      else if (row.state === 'started') jobs.started = row.n;
      else if (row.state === 'recovery-required') jobs.recoveryRequired = row.n;
      if ((row.state === 'pending' || row.state === 'claimed' || row.state === 'started') && typeof row.oldest === 'number') {
        const age = Math.max(0, now - row.oldest);
        jobs.oldestActiveAgeMs = jobs.oldestActiveAgeMs === null ? age : Math.max(jobs.oldestActiveAgeMs, age);
      }
    }
    const schemaVersion = storedSchemaVersion(ws.sql);
    const scheduledAt = await ws.storage.getAlarm();
    return {
      status: 'ok',
      workspaceId: meta.workspaceId,
      schemaVersion,
      maintenance: { state: meta.maintenanceState, version: meta.maintenanceVersion },
      epoch: { activated: meta.activatedEpoch, configuredMatches: epochMatches(ws, meta) },
      counts,
      jobs,
      alarm: { scheduledAt: typeof scheduledAt === 'number' ? scheduledAt : null },
    };
  } catch {
    return { status: 'unavailable' };
  }
}

// ---------- Maintenance transitions (OPS-01) ----------

function transitionAllowed(from: MaintenanceState, to: MaintenanceState): boolean {
  if (from === to) return false;
  if (to === 'recovery') return true;
  switch (from) {
    case 'open':
      return to === 'draining';
    case 'draining':
      return to === 'open' || to === 'frozen';
    case 'frozen':
      return to === 'open' || to === 'draining';
    case 'recovery':
      return to === 'frozen' || to === 'open';
  }
}

type ImportProgress =
  | { status: 'none' }
  | { status: 'in-progress'; manifestDigest: string }
  | { status: 'finalized'; manifestDigest: string; counts: Record<string, number> };

function importProgress(sql: SqlStorage): ImportProgress {
  const rows = sql
    .exec<{ action: string; detail_json: string }>(
      `SELECT action, detail_json FROM operator_audit
        WHERE action IN ('import.begin', 'import.finalize')
        ORDER BY seq DESC LIMIT 1`,
    )
    .toArray();
  if (rows.length === 0) return { status: 'none' };
  const detail = JSON.parse(rows[0].detail_json) as { manifestDigest: string; counts?: Record<string, number> };
  return rows[0].action === 'import.finalize'
    ? { status: 'finalized', manifestDigest: detail.manifestDigest, counts: detail.counts ?? {} }
    : { status: 'in-progress', manifestDigest: detail.manifestDigest };
}

/** The transition that produced `version`, if it is recorded. */
function recordedTransition(sql: SqlStorage, version: number): { from: string; to: string } | null {
  const rows = sql
    .exec<{ detail_json: string }>(
      `SELECT detail_json FROM operator_audit
        WHERE action = 'maintenance.transition' AND json_extract(detail_json, '$.version') = ?
        ORDER BY seq DESC LIMIT 1`,
      version,
    )
    .toArray();
  if (rows.length === 0) return null;
  const detail = JSON.parse(rows[0].detail_json) as { from: string; to: string };
  return { from: detail.from, to: detail.to };
}

function inFlightCounts(sql: SqlStorage): { claimed: number; started: number } {
  const counts = { claimed: 0, started: 0 };
  for (const row of sql
    .exec<{ state: string; n: number }>(
      `SELECT state, COUNT(*) AS n FROM analysis_jobs WHERE state IN ('claimed', 'started') GROUP BY state`,
    )
    .toArray()) {
    if (row.state === 'claimed') counts.claimed = row.n;
    else counts.started = row.n;
  }
  return counts;
}

function jobsInStates(sql: SqlStorage, states: ReadonlyArray<'pending' | 'claimed' | 'started'>): JobRow[] {
  return sql
    .exec<{ job_id: string }>(
      `SELECT job_id FROM analysis_jobs WHERE state IN (${states.map(() => '?').join(', ')}) ORDER BY job_id`,
      ...states,
    )
    .toArray()
    .map((row) => readJob(sql, row.job_id))
    .filter((job): job is JobRow => job !== null);
}

/**
 * Terminal recovery-required through the jobs module's settlement (receipt
 * without a claim, projection onto the current generation, mutation
 * sequence), then the claim is cleared so no holder can present it again.
 */
function settleRecoveryRequired(sql: SqlStorage, job: JobRow, now: number): void {
  settleJob(sql, job, { state: 'recovery-required' }, null, now);
  sql.exec(`UPDATE analysis_jobs SET claim_nonce = NULL, claim_expires_at = NULL WHERE job_id = ?`, job.job_id);
}

/**
 * Explicit classification of in-flight attempts before freezing (OPS-01):
 * an unstarted claim returns to pending with its claim cleared (the
 * scheduler's next reservation charges its one dispatch-budget unit); a
 * started attempt's paid outcome is uncertain, so it becomes
 * recovery-required. Nothing is inferred from elapsed time.
 */
function classifyInFlight(sql: SqlStorage, now: number, dueAt: number): { claimed: number; started: number } {
  const counts = { claimed: 0, started: 0 };
  for (const job of jobsInStates(sql, ['claimed', 'started'])) {
    if (job.state === 'started') {
      settleRecoveryRequired(sql, job, now);
      counts.started += 1;
      continue;
    }
    sql.exec(
      `UPDATE analysis_jobs
          SET state = 'pending', claim_nonce = NULL, claimed_at = NULL, claim_expires_at = NULL,
              dispatch_state = 'unsent', next_due_at = ?, updated_at = ?
        WHERE job_id = ?`,
      dueAt,
      now,
      job.job_id,
    );
    sql.exec(
      `UPDATE analysis SET status = 'pending', updated_at = ? WHERE interview_id = ? AND current_generation = ?`,
      now,
      job.interview_id,
      job.generation,
    );
    bumpMutationSeq(sql, now);
    counts.claimed += 1;
  }
  return counts;
}

export async function transitionMaintenance(ws: WorkspaceContext, input: Rpc.MaintenanceTransitionInput): Promise<Rpc.MaintenanceTransitionOutcome> {
  try {
    if (
      !isMaintenanceState(input?.expectedState)
      || !isMaintenanceState(input.nextState)
      || !isSafeCount(input.expectedVersion)
      || !isSafeCount(input.now)
    ) {
      return { status: 'invalid-transition' };
    }
    const { expectedState, expectedVersion, nextState, now } = input;
    const checked = gate(ws, 'read');
    if (!checked.ok) return { status: 'held', reason: checked.reason };
    if (!transitionAllowed(expectedState, nextState)) return { status: 'invalid-transition' };
    const meta = checked.meta;
    if (meta.maintenanceState !== expectedState || meta.maintenanceVersion !== expectedVersion) {
      // A lost reply is resolved by reading the recorded transition; a newer
      // operator decision is reported, never undone.
      if (meta.maintenanceState === nextState && meta.maintenanceVersion === expectedVersion + 1) {
        const recorded = recordedTransition(ws.sql, meta.maintenanceVersion);
        if (recorded && recorded.from === expectedState && recorded.to === nextState) {
          return { status: 'already', state: meta.maintenanceState, version: meta.maintenanceVersion };
        }
      }
      return { status: 'conflict', state: meta.maintenanceState, version: meta.maintenanceVersion };
    }
    if (nextState !== 'recovery' && !epochMatches(ws, meta)) {
      logOperator('maintenance.transition', 'epoch-mismatch');
      return { status: 'held', reason: 'recovery-epoch-mismatch' };
    }
    if (expectedState === 'recovery' && importProgress(ws.sql).status === 'in-progress') {
      return { status: 'invalid-transition' };
    }
    if (nextState === 'frozen' && !input.classifyInFlight) {
      const inFlight = inFlightCounts(ws.sql);
      if (inFlight.claimed + inFlight.started > 0) return { status: 'in-flight', ...inFlight };
    }
    const version = expectedVersion + 1;
    const apply = (): Rpc.MaintenanceTransitionOutcome | null => {
      const current = readMeta(ws.sql);
      if (!current || current.maintenanceState !== expectedState || current.maintenanceVersion !== expectedVersion) {
        return current
          ? { status: 'conflict', state: current.maintenanceState, version: current.maintenanceVersion }
          : { status: 'unavailable' };
      }
      const classified = nextState === 'frozen' ? classifyInFlight(ws.sql, now, Date.now()) : { claimed: 0, started: 0 };
      ws.sql.exec(
        `UPDATE workspace_meta SET maintenance_state = ?, maintenance_version = ?, updated_at = ? WHERE singleton = 1`,
        nextState,
        version,
        now,
      );
      audit(ws.sql, now, 'maintenance.transition', {
        from: expectedState,
        to: nextState,
        version,
        classifiedClaimed: classified.claimed,
        classifiedStarted: classified.started,
      });
      return null;
    };
    const resumesWork = (expectedState === 'frozen' || expectedState === 'recovery')
      && (nextState === 'open' || nextState === 'draining');
    let refused: Rpc.MaintenanceTransitionOutcome | null;
    if (resumesWork) {
      // The scheduler stays inert while held and does not re-arm itself.
      // Resuming arms it for the object's own now (caller time is advisory,
      // F14), in the same durable unit as the transition: that is no later
      // than the earliest due job or cleanup, and the scheduler's pass then
      // dispatches, cleans up and computes its own next wake-up.
      refused = await ws.storage.transaction(async () => {
        const outcome = apply();
        if (outcome) return outcome;
        await armAlarmNoLaterThan(ws.storage, Date.now());
        return null;
      });
    } else {
      refused = ws.storage.transactionSync(apply);
    }
    if (refused) return refused;
    logOperator('maintenance.transition');
    return { status: 'transitioned', state: nextState, version };
  } catch {
    return { status: 'unavailable' };
  }
}

// ---------- Operational backup export (OPS-02) ----------

function sameWatermark(a: { maintenanceVersion: number; mutationSeq: number }, b: { maintenanceVersion: number; mutationSeq: number }): boolean {
  return a.maintenanceVersion === b.maintenanceVersion && a.mutationSeq === b.mutationSeq;
}

function parseKeyCursor(family: BackupFamily, raw: string | null): Array<string | number> | null | 'invalid' {
  if (raw === null) return null;
  if (typeof raw !== 'string' || raw.length > 4096) return 'invalid';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'invalid';
  }
  if (!Array.isArray(parsed) || parsed.length !== family.key.length) return 'invalid';
  for (let index = 0; index < family.key.length; index += 1) {
    const column = family.columns.find((candidate) => candidate.name === family.key[index]);
    const value = parsed[index];
    if (!column) return 'invalid';
    if (column.type === 'text' ? typeof value !== 'string' : !Number.isSafeInteger(value)) return 'invalid';
  }
  return parsed as Array<string | number>;
}

function readBackupRows(
  sql: SqlStorage,
  family: BackupFamily,
  after: Array<string | number> | null,
  pageSize: number,
): { rows: Array<Record<string, SqlStorageValue>>; more: boolean } {
  const keyList = family.key.join(', ');
  const keyTuple = `(${keyList})`;
  const placeholders = `(${family.key.map(() => '?').join(', ')})`;
  const afterClause = after ? `WHERE ${keyTuple} > ${placeholders}` : '';
  const afterBindings = after ?? [];
  const textColumns = family.columns.filter((column) => column.type === 'text').map((column) => column.name);
  const sizeExpression = textColumns.length > 0
    ? textColumns.map((column) => `COALESCE(length(CAST(${column} AS BLOB)), 0)`).join(' + ')
    : '0';
  // Sizes first, so one page never materializes more than the byte budget.
  const keys = sql
    .exec<Record<string, SqlStorageValue>>(
      `SELECT ${keyList}, ${sizeExpression} AS backup_bytes FROM ${family.name}
        ${afterClause} ORDER BY ${keyList} LIMIT ?`,
      ...afterBindings,
      pageSize + 1,
    )
    .toArray();
  let chosen = 0;
  let budget = 0;
  for (const key of keys.slice(0, pageSize)) {
    const cost = (key.backup_bytes as number) + BACKUP_ROW_OVERHEAD_BYTES;
    if (chosen > 0 && budget + cost > BACKUP_MAX_PAGE_BYTES) break;
    chosen += 1;
    budget += cost;
  }
  if (chosen === 0) return { rows: [], more: false };
  const last = keys[chosen - 1];
  const lastKey = family.key.map((column) => last[column]);
  const rows = sql
    .exec<Record<string, SqlStorageValue>>(
      `SELECT ${family.columns.map((column) => column.name).join(', ')} FROM ${family.name}
        WHERE ${keyTuple} <= ${placeholders} ${after ? `AND ${keyTuple} > ${placeholders}` : ''}
        ORDER BY ${keyList}`,
      ...lastKey,
      ...afterBindings,
    )
    .toArray();
  return { rows, more: keys.length > chosen };
}

export async function exportBackupPage(ws: WorkspaceContext, input: Rpc.BackupPageInput): Promise<Rpc.BackupPageOutcome> {
  try {
    const checked = gate(ws, 'read');
    if (!checked.ok) return { status: 'held', reason: checked.reason };
    const { meta } = checked;
    if (meta.maintenanceState !== 'frozen' && meta.maintenanceState !== 'recovery') return { status: 'not-frozen' };
    const watermark = { maintenanceVersion: meta.maintenanceVersion, mutationSeq: meta.mutationSeq };
    if (input?.watermark !== null) {
      const presented = input?.watermark;
      if (!presented || !isSafeCount(presented.maintenanceVersion) || !isSafeCount(presented.mutationSeq)) {
        return { status: 'unavailable' };
      }
      if (!sameWatermark(presented, watermark)) return { status: 'watermark-changed' };
    }
    const family = backupFamily(input.family);
    if (!family || !Number.isSafeInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > BACKUP_MAX_CHUNK_ROWS) {
      return { status: 'unavailable' };
    }
    const after = parseKeyCursor(family, input.cursor);
    if (after === 'invalid') return { status: 'unavailable' };
    const { rows, more } = readBackupRows(ws.sql, family, after, input.pageSize);
    // A value SQL cannot hand back exactly (for example an integer beyond
    // the safe range) would be silently altered by a copy: refuse instead.
    if (!rows.every((row) => isValidBackupRow(family, row))) {
      logOperator('backup.export', 'corrupt-record');
      return { status: 'unavailable' };
    }
    const last = rows[rows.length - 1];
    return {
      status: 'ok',
      watermark,
      family: family.name,
      rows,
      nextCursor: more && last ? JSON.stringify(family.key.map((column) => last[column])) : null,
      families: [...BACKUP_FAMILY_NAMES],
      schemaVersion: storedSchemaVersion(ws.sql),
      workspaceId: meta.workspaceId,
    };
  } catch {
    return { status: 'unavailable' };
  }
}

// ---------- Operational backup import (OPS-02, ST-10) ----------

type Rejection = { status: 'rejected'; errorClass: string; counts?: Record<string, number> };

function reject(errorClass: string, counts?: Record<string, number>): Rejection {
  logOperator('backup.import');
  return counts ? { status: 'rejected', errorClass, counts } : { status: 'rejected', errorClass };
}

function acceptedChunk(sql: SqlStorage, family: string, index: number): { sha256: string; rows: number } | null {
  const rows = sql
    .exec<{ detail_json: string }>(
      `SELECT detail_json FROM operator_audit
        WHERE action = 'import.chunk'
          AND json_extract(detail_json, '$.family') = ?
          AND json_extract(detail_json, '$.index') = ?
        ORDER BY seq DESC LIMIT 1`,
      family,
      index,
    )
    .toArray();
  if (rows.length === 0) return null;
  const detail = JSON.parse(rows[0].detail_json) as { sha256: string; rows: number };
  return { sha256: detail.sha256, rows: detail.rows };
}

function acceptedChunks(sql: SqlStorage): Map<string, Array<{ index: number; rows: number }>> {
  const byFamily = new Map<string, Array<{ index: number; rows: number }>>();
  for (const row of sql
    .exec<{ detail_json: string }>(`SELECT detail_json FROM operator_audit WHERE action = 'import.chunk' ORDER BY seq`)
    .toArray()) {
    const detail = JSON.parse(row.detail_json) as { family: string; index: number; rows: number };
    const list = byFamily.get(detail.family) ?? [];
    list.push({ index: detail.index, rows: detail.rows });
    byFamily.set(detail.family, list);
  }
  return byFamily;
}

function workspaceIsEmpty(sql: SqlStorage): boolean {
  return BACKUP_FAMILIES.every((family) => family.name === 'workspace_meta' || countRows(sql, family.name) === 0);
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Per-row byte ceilings shared with the writers: every assembled row within
 * the measured SQLite row ceiling, and the attached synthesis and stored
 * aggregate within their write limits. Integers count as 8 bytes.
 */
function rowWithinLimits(family: BackupFamily, row: Record<string, string | number | null>): boolean {
  let total = 0;
  for (const column of family.columns) {
    const value = row[column.name];
    total += typeof value === 'string' ? utf8Length(value) : 8;
  }
  if (total > MAX_ROW_BYTES) return false;
  if (family.name === 'analysis' && typeof row.synthesis_json === 'string') {
    return utf8Length(row.synthesis_json) <= MAX_ATTACHED_SYNTHESIS_BYTES;
  }
  if (family.name === 'aggregates') return utf8Length(row.aggregate_json as string) <= MAX_STORED_AGGREGATE_BYTES;
  return true;
}

/** Cross-row identity checks the SQL constraints cannot express. */
function rowIdentityValid(family: BackupFamily, row: Record<string, string | number | null>): boolean {
  try {
    if (family.name === 'studies') {
      const config = JSON.parse(row.config_json as string) as { id?: unknown } | null;
      return !!config && typeof config === 'object' && config.id === row.id;
    }
    if (family.name === 'interviews') {
      return parseRecord(row.record_json as string, row.id as string).studyId === row.study_id;
    }
    if (family.name === 'aggregates') {
      const aggregate = JSON.parse(row.aggregate_json as string) as { studyId?: unknown } | null;
      return !!aggregate && aggregate.studyId === row.study_id;
    }
    return true;
  } catch (error) {
    if (error instanceof CorruptRecordError || error instanceof SyntaxError) return false;
    throw error;
  }
}

function keyExists(sql: SqlStorage, family: BackupFamily, row: Record<string, string | number | null>): boolean {
  const clause = family.key.map((column) => `${column} = ?`).join(' AND ');
  return sql
    .exec(`SELECT 1 AS present FROM ${family.name} WHERE ${clause} LIMIT 1`, ...family.key.map((column) => row[column]))
    .toArray().length > 0;
}

const REFERENCE_CHECKS: ReadonlyArray<{ name: string; query: string }> = [
  { name: 'interviews.study_id', query: `SELECT COUNT(*) AS n FROM interviews c WHERE NOT EXISTS (SELECT 1 FROM studies p WHERE p.id = c.study_id)` },
  { name: 'analysis.interview_id', query: `SELECT COUNT(*) AS n FROM analysis c WHERE NOT EXISTS (SELECT 1 FROM interviews p WHERE p.id = c.interview_id)` },
  { name: 'analysis_jobs.interview_id', query: `SELECT COUNT(*) AS n FROM analysis_jobs c WHERE NOT EXISTS (SELECT 1 FROM interviews p WHERE p.id = c.interview_id)` },
  { name: 'aggregates.study_id', query: `SELECT COUNT(*) AS n FROM aggregates c WHERE NOT EXISTS (SELECT 1 FROM studies p WHERE p.id = c.study_id)` },
  { name: 'participant_links.study_id', query: `SELECT COUNT(*) AS n FROM participant_links c WHERE NOT EXISTS (SELECT 1 FROM studies p WHERE p.id = c.study_id)` },
];

function finalizeImport(ws: WorkspaceContext, manifest: BackupManifest, manifestDigest: string, now: number): Rpc.BackupImportOutcome {
  const accepted = acceptedChunks(ws.sql);
  for (const family of BACKUP_FAMILIES) {
    const described = manifest.families.find((candidate) => candidate.name === family.name)!;
    const chunks = (accepted.get(family.name) ?? []).slice().sort((a, b) => a.index - b.index);
    if (chunks.length !== described.chunks.length || chunks.some((chunk, position) => chunk.index !== position)) {
      return reject('chunk-missing', { [`${family.name}.chunks`]: chunks.length, [`${family.name}.expected`]: described.chunks.length });
    }
    const imported = chunks.reduce((sum, chunk) => sum + chunk.rows, 0);
    const expected = described.count;
    if (imported !== expected) return reject('count-mismatch', { [`${family.name}.expected`]: expected, [`${family.name}.imported`]: imported });
    const stored = family.name === 'workspace_meta' ? imported : countRows(ws.sql, family.name);
    if (stored !== expected) return reject('count-mismatch', { [`${family.name}.expected`]: expected, [`${family.name}.stored`]: stored });
  }
  const dangling: Record<string, number> = {};
  for (const check of REFERENCE_CHECKS) {
    const count = ws.sql.exec<{ n: number }>(check.query).one().n;
    if (count > 0) dangling[check.name] = count;
  }
  if (Object.keys(dangling).length > 0) return reject('reference-invalid', dangling);
  const counts = Object.fromEntries(manifest.families.map((family) => [family.name, family.count]));
  audit(ws.sql, now, 'import.finalize', { manifestDigest, counts });
  logOperator('backup.import');
  return { status: 'finalized', counts };
}

export async function importBackupChunk(ws: WorkspaceContext, input: Rpc.BackupImportInput): Promise<Rpc.BackupImportOutcome> {
  try {
    const checked = gate(ws, 'read');
    if (!checked.ok) return { status: 'held', reason: checked.reason };
    if (checked.meta.maintenanceState !== 'recovery') return { status: 'not-recovery' };
    if (!isSafeCount(input?.now)) return reject('request-invalid');
    const presented = input.manifest as unknown;
    if (!presented || typeof presented !== 'object') return reject('manifest-invalid');
    const presentedVersion = (presented as { formatVersion?: unknown }).formatVersion;
    if (presentedVersion !== BACKUP_FORMAT_VERSION) return reject('format-unsupported');
    // The complete manifest (watermark, export time and every chunk
    // descriptor): an import is bound to exactly one backup file.
    const manifest = manifestFromImport(presented);
    if (!manifest) return reject('manifest-invalid');
    if (manifest.schemaVersion !== storedSchemaVersion(ws.sql)) return reject('schema-unsupported');
    if (!isValidWorkspaceId(manifest.sourceWorkspaceId)) return reject('manifest-invalid');
    const chunk = input.chunk;
    if ((chunk === null || chunk === undefined) === !input.finalize) return reject('request-invalid');

    // Asynchronous digests first; everything after this is synchronous SQL.
    const manifestDigest = await backupManifestDigest(manifest);
    let family: BackupFamily | null = null;
    let computed: string | null = null;
    if (chunk) {
      family = backupFamily(chunk.family);
      if (!family) return reject('family-unknown');
      if (!isSafeCount(chunk.index) || !Array.isArray(chunk.rows) || typeof chunk.sha256 !== 'string') {
        return reject('chunk-invalid');
      }
      if (chunk.rows.length === 0 || chunk.rows.length > BACKUP_MAX_CHUNK_ROWS) {
        return reject('chunk-invalid', { rows: chunk.rows.length });
      }
      computed = await chunkChecksum(chunk.rows);
    }

    return ws.storage.transactionSync((): Rpc.BackupImportOutcome => {
      const meta = readMeta(ws.sql);
      if (!meta) return { status: 'unavailable' };
      if (meta.maintenanceState !== 'recovery') return { status: 'not-recovery' };
      const progress = importProgress(ws.sql);
      if (progress.status !== 'none' && progress.manifestDigest !== manifestDigest) return reject('manifest-mismatch');

      if (input.finalize) {
        if (progress.status === 'none') return reject('chunk-missing', { chunks: 0 });
        if (progress.status === 'finalized') return { status: 'finalized', counts: progress.counts };
        return finalizeImport(ws, manifest, manifestDigest, input.now);
      }
      if (!chunk || !family || computed === null) return reject('request-invalid');

      const previous = acceptedChunk(ws.sql, family.name, chunk.index);
      if (previous) {
        return previous.sha256 === chunk.sha256 && computed === chunk.sha256
          ? { status: 'accepted', family: family.name, index: chunk.index, duplicate: true }
          : reject('chunk-conflict', { rows: chunk.rows.length });
      }
      if (progress.status === 'finalized') return reject('import-finalized');
      if (progress.status === 'none') {
        if (!workspaceIsEmpty(ws.sql)) return { status: 'not-empty' };
        // The source identity and epoch arrive first; nothing else may precede them.
        if (family.name !== 'workspace_meta') return reject('family-order');
      }
      if (computed !== chunk.sha256) return reject('checksum-mismatch', { rows: chunk.rows.length });
      const invalidRows = chunk.rows.filter((row) => !isValidBackupRow(family, row) || !rowIdentityValid(family, row)).length;
      if (invalidRows > 0) return reject('row-invalid', { rows: chunk.rows.length, invalid: invalidRows });
      const rows = chunk.rows as Array<Record<string, string | number | null>>;
      const oversized = rows.filter((row) => !rowWithinLimits(family, row)).length;
      if (oversized > 0) {
        logOperator('backup.import', 'too-large');
        return { status: 'rejected', errorClass: 'row-too-large', counts: { rows: rows.length, oversized } };
      }
      // Every chunk must be the one the manifest describes at (family, index).
      const descriptor = manifest.families.find((candidate) => candidate.name === family.name)!.chunks[chunk.index];
      if (!descriptor) return reject('chunk-unexpected', { rows: rows.length });
      if (descriptor.sha256 !== chunk.sha256) return reject('checksum-mismatch', { rows: rows.length });
      if (descriptor.rows !== rows.length) return reject('count-mismatch', { rows: rows.length, expected: descriptor.rows });

      // Every refusal happens before the first write: a returned rejection
      // still commits the surrounding transaction.
      if (family.name === 'workspace_meta') {
        const source = rows[0];
        if (rows.length !== 1 || chunk.index !== 0) return reject('chunk-invalid', { rows: rows.length });
        if (source.workspace_id !== manifest.sourceWorkspaceId) return reject('identity-mismatch');
        if (source.maintenance_version !== manifest.watermark.maintenanceVersion || source.mutation_seq !== manifest.watermark.mutationSeq) {
          return reject('watermark-changed');
        }
        if (!isValidRecoveryEpoch(source.activated_epoch) || !isMaintenanceState(source.maintenance_state)) {
          return reject('row-invalid', { rows: 1, invalid: 1 });
        }
        // Restored jobs must stay inert until a controlled activation
        // reconciles them, which requires a newly deployed external epoch.
        if (source.activated_epoch === ws.env.ANALYSIS_RECOVERY_EPOCH) return reject('epoch-not-rotated');
      } else {
        const keys = new Set<string>();
        for (const row of rows) {
          const key = JSON.stringify(family.key.map((column) => row[column]));
          if (keys.has(key) || keyExists(ws.sql, family, row)) return reject('duplicate-identity', { rows: rows.length });
          keys.add(key);
        }
      }

      if (progress.status === 'none') {
        audit(ws.sql, input.now, 'import.begin', {
          manifestDigest,
          formatVersion: manifest.formatVersion,
          schemaVersion: manifest.schemaVersion,
          sourceWorkspaceId: manifest.sourceWorkspaceId,
          counts: Object.fromEntries(manifest.families.map((described) => [described.name, described.count])),
        });
      }
      if (family.name === 'workspace_meta') {
        // Keep this object's identity and held state; adopt the source epoch so
        // the deployment's new epoch mismatches until activation.
        ws.sql.exec(
          `UPDATE workspace_meta
              SET activated_epoch = ?, mutation_seq = MAX(mutation_seq, ?) + 1, updated_at = ?
            WHERE singleton = 1`,
          rows[0].activated_epoch,
          rows[0].mutation_seq,
          input.now,
        );
      } else {
        const columns = family.columns.map((column) => column.name);
        const statement = `INSERT INTO ${family.name} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
        for (const row of rows) ws.sql.exec(statement, ...columns.map((column) => row[column]));
        // Imported rows change what a backup or researcher export taken in
        // recovery would read: the watermark must move with them.
        bumpMutationSeq(ws.sql, input.now);
      }
      audit(ws.sql, input.now, 'import.chunk', { family: family.name, index: chunk.index, sha256: chunk.sha256, rows: rows.length });
      return { status: 'accepted', family: family.name, index: chunk.index, duplicate: false };
    });
  } catch (error) {
    // The chunk's transaction rolled back. A constraint violation is a
    // property of the rows; anything else leaves the outcome unknown, and a
    // replay of the same (family, index) is safe either way.
    if (error instanceof Error && error.message.includes('SQLITE_CONSTRAINT')) return reject('row-invalid');
    return { status: 'unavailable' };
  }
}

// ---------- Recovery-epoch activation (JOB-10, OPS-03) ----------

function epochSuperseded(sql: SqlStorage, epoch: string): boolean {
  return sql
    .exec(
      `SELECT 1 AS superseded FROM operator_audit
        WHERE action = 'epoch.activate' AND json_extract(detail_json, '$.from') = ? LIMIT 1`,
      epoch,
    )
    .toArray().length > 0;
}

export async function activateRecoveryEpoch(ws: WorkspaceContext, input: Rpc.ActivateEpochInput): Promise<Rpc.ActivateEpochOutcome> {
  try {
    // Identity only: activation is the one path that runs while gate()
    // reports recovery-epoch-mismatch.
    const checked = gate(ws, 'read');
    if (!checked.ok) return { status: 'held', reason: checked.reason };
    const configured = ws.env.ANALYSIS_RECOVERY_EPOCH;
    if (!isValidRecoveryEpoch(configured)) return { status: 'held', reason: 'recovery-epoch-mismatch' };
    if (!isSafeCount(input?.now) || typeof input.expectedActivatedEpoch !== 'string') return { status: 'conflict' };
    const now = input.now;
    return ws.storage.transactionSync((): Rpc.ActivateEpochOutcome => {
      const meta = readMeta(ws.sql);
      if (!meta) return { status: 'unavailable' };
      if (meta.activatedEpoch === configured) return { status: 'already-active' };
      if (meta.maintenanceState !== 'recovery') return { status: 'not-recovery' };
      if (input.expectedActivatedEpoch !== meta.activatedEpoch) return { status: 'conflict' };
      // A half-imported workspace could still receive restored jobs after
      // activation; activation waits for the import to finalize.
      if (importProgress(ws.sql).status === 'in-progress') return { status: 'conflict' };
      // Rolling the configured epoch back to one this object already replaced
      // is forbidden (JOB-10). Defense in depth: a point-in-time restore also
      // rewinds this audit history.
      if (epochSuperseded(ws.sql, configured)) {
        logOperator('epoch.activate', 'epoch-mismatch');
        return { status: 'conflict' };
      }
      // Restored start markers may have been rewound: every nonterminal
      // generation's paid outcome is uncertain, so none resumes automatically.
      const restored = jobsInStates(ws.sql, ['pending', 'claimed', 'started']);
      for (const job of restored) settleRecoveryRequired(ws.sql, job, now);
      const reconciledJobs = restored.length;
      ws.sql.exec(`UPDATE workspace_meta SET activated_epoch = ?, updated_at = ? WHERE singleton = 1`, configured, now);
      // workspace_meta changed: a backup taken in recovery must see a new watermark.
      bumpMutationSeq(ws.sql, now);
      audit(ws.sql, now, 'epoch.activate', { from: meta.activatedEpoch, to: configured, reconciledJobs });
      logOperator('epoch.activate');
      return { status: 'activated', reconciledJobs };
    });
  } catch {
    return { status: 'unavailable' };
  }
}

// ---------- Point-in-time restore (OPS-03) ----------

/** The storage methods a point-in-time restore uses: the object's own storage in production. */
export type PointInTimeStorage = Pick<DurableObjectStorage, 'getBookmarkForTime' | 'onNextSessionRestoreBookmark'>;

function restoreRefusal(ws: WorkspaceContext, input: Rpc.RestoreBookmarkInput): Rpc.RestoreBookmarkOutcome | null {
  const meta = readMeta(ws.sql);
  if (!meta) return { status: 'unavailable' };
  if (meta.maintenanceState !== input.expectedState || meta.maintenanceVersion !== input.expectedVersion) {
    return { status: 'conflict', state: meta.maintenanceState, version: meta.maintenanceVersion };
  }
  if (meta.maintenanceState !== 'frozen' && meta.maintenanceState !== 'recovery') {
    return { status: 'not-held', state: meta.maintenanceState, version: meta.maintenanceVersion };
  }
  // The restored database carries an older activated epoch. Only a
  // deployment already bound to a new, never-activated epoch keeps its
  // writes, alarms and consumer callbacks inert until controlled activation.
  const configured = ws.env.ANALYSIS_RECOVERY_EPOCH;
  if (!isValidRecoveryEpoch(configured) || configured === meta.activatedEpoch || epochSuperseded(ws.sql, configured)) {
    logOperator('restore.schedule', 'epoch-mismatch');
    return { status: 'epoch-not-rotated' };
  }
  return null;
}

/**
 * Schedules a point-in-time restore of this object's storage for its next
 * session (OPS-03 step 4); the caller restarts the object after replying.
 * Every refusal happens before any point-in-time storage call: the request
 * names exactly one bookmark or one time inside the platform's 30-day window
 * (never ahead of the object's clock), the workspace is `frozen` or
 * `recovery` at exactly the expected state and version (a replay after the
 * restore meets the restored version and conflicts), and the configured epoch
 * was rotated first (restoreRefusal).
 */
export async function restoreToBookmark(
  ws: WorkspaceContext,
  input: Rpc.RestoreBookmarkInput,
  pitr: PointInTimeStorage,
): Promise<Rpc.RestoreBookmarkOutcome> {
  try {
    if (!isMaintenanceState(input?.expectedState) || !isSafeCount(input.expectedVersion) || !isSafeCount(input.now)) {
      return { status: 'invalid-request' };
    }
    const byBookmark = input.bookmark !== null && input.bookmark !== undefined;
    const byTime = input.at !== null && input.at !== undefined;
    if (byBookmark === byTime) return { status: 'invalid-request' };
    if (byBookmark && !isRestoreBookmark(input.bookmark)) return { status: 'invalid-request' };
    if (byTime) {
      const objectNow = Date.now();
      if (!isSafeCount(input.at) || input.at > objectNow || input.at < objectNow - RESTORE_WINDOW_MS) {
        return { status: 'invalid-request' };
      }
    }
    const checked = gate(ws, 'read');
    if (!checked.ok) return { status: 'held', reason: checked.reason };
    const refused = restoreRefusal(ws, input);
    if (refused) return refused;

    let bookmark: string;
    try {
      bookmark = byTime ? await pitr.getBookmarkForTime(input.at as number) : (input.bookmark as string);
    } catch {
      logOperator('restore.schedule', 'unavailable');
      return { status: 'bookmark-refused' };
    }
    if (!isRestoreBookmark(bookmark)) {
      logOperator('restore.schedule', 'unavailable');
      return { status: 'bookmark-refused' };
    }
    // The lookup yielded to the runtime: the preconditions must still hold.
    const changed = restoreRefusal(ws, input);
    if (changed) return changed;

    let undoBookmark: string;
    try {
      undoBookmark = await pitr.onNextSessionRestoreBookmark(bookmark);
    } catch {
      logOperator('restore.schedule', 'unavailable');
      return { status: 'bookmark-refused' };
    }
    logOperator('restore.schedule');
    return { status: 'scheduled', bookmark, undoBookmark: String(undoBookmark) };
  } catch {
    return { status: 'unavailable' };
  }
}
