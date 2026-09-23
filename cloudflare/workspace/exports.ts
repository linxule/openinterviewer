// Researcher export over a snapshot captured at start (RT-09, ST-08; gap
// decision F1 in IMPLEMENTATION.md §7).
//
// beginExport captures, in one synchronous read, the ordered interview key
// set (created_at DESC, id DESC) with each row's fingerprint and analysis
// state, and the identity (byte length, SHA-256) of each exported study's
// aggregate. Pages project exactly the captured rows with the captured
// analysis state: transcripts are immutable and a synthesis is written once,
// so a row captured as complete still carries the same synthesis as long as
// its analysis stays at the captured generation. New interviews, claims,
// settlements, attaches and retries after the start therefore do not reach
// the archive and do not invalidate it. A page or verifyExportSequence
// reports `changed` only when a captured interview was deleted or replaced,
// a captured complete analysis moved off its generation, or a captured
// aggregate was replaced or removed. No SQL cursor is held across an await:
// each call reads and fully consumes its rows synchronously.
//
// The snapshot is kept in the object's synchronous KV storage, keyed by the
// research mutation sequence at capture (the `sequence` the RPCs carry).
// Every exported-content write advances that sequence, so one sequence value
// identifies one state: a snapshot that is gone (TTL or count cap) is
// recaptured while the sequence is unchanged, and otherwise the export
// reports `changed`. Snapshots are export bookkeeping, not research data;
// they are excluded from the operational backup.
//
// Deterministic page scheme (reproduces the Node JSZip entry order):
//   1. Interview pages: the captured order, newest first, bounded by pageSize
//      rows and maxPageBytes (at least one row per page so an oversized
//      record still makes progress). Aggregates are empty.
//   2. Aggregate pages: after the last interview, each captured aggregate in
//      first-seen order (the order of a study's newest interview in step 1),
//      bounded the same way. Interviews are empty.
// Cursor: JSON `["i", createdAt, id]` (after that captured interview) or
// `["a", position]` (from that captured aggregate); null ends the export.
// A malformed stored aggregate is not captured, as the Redis reader treats it
// as absent; a corrupt interview record fails the page (unavailable) rather
// than silently dropping research data from the archive.

import { createHash } from 'node:crypto';
import type { StoredAggregateSynthesis, StoredInterview } from '../../src/types';
import { logRequestEvent } from '../../src/lib/requestLog';
import type * as Rpc from './rpcTypes';
import { gate, type WorkspaceContext, type WorkspaceMeta } from './context';
import { CorruptRecordError, projectInterview, type AnalysisRow } from './projection';

/** Upper bounds on caller-supplied page parameters. */
export const EXPORT_MAX_PAGE_SIZE = 200;
export const EXPORT_MAX_PAGE_BYTES = 16 * 1024 * 1024;
/** Largest `maximum` the object captures; bounds the stored snapshot. */
export const EXPORT_MAX_INTERVIEWS = 1_000;
/** KV key prefix of stored export snapshots. */
export const EXPORT_SNAPSHOT_PREFIX = 'export-snapshot:';
/** A snapshot older than this is discarded (and recaptured only if unchanged). */
export const EXPORT_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
/** Most snapshots kept at once; the oldest beyond this are discarded. */
export const EXPORT_SNAPSHOT_LIMIT = 8;
/** Allowance for the projected analysis state and JSON framing per record. */
const PROJECTION_OVERHEAD_BYTES = 1024;

type CapturedAnalysis = {
  status: AnalysisRow['status'];
  generation: number;
  attempts: number;
  lastAttemptAt: number;
  failureKind: AnalysisRow['failure_kind'];
  recoveryRequired: number;
  studyRevision: number | null;
};

type CapturedInterview = {
  id: string;
  createdAt: number;
  fingerprint: string;
  /** Null for a legacy/imported record without an analysis row. */
  analysis: CapturedAnalysis | null;
};

type CapturedAggregate = { studyId: string; bytes: number; sha256: string };

type ExportSnapshot = {
  v: 1;
  sequence: number;
  capturedAt: number;
  interviews: CapturedInterview[];
  aggregates: CapturedAggregate[];
};

type Cursor = { phase: 'interviews'; createdAt: number; id: string } | { phase: 'aggregates'; position: number };

function parseCursor(raw: string | null): Cursor | null | 'invalid' {
  if (raw === null) return null;
  if (typeof raw !== 'string' || raw.length > 512) return 'invalid';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'invalid';
  }
  if (!Array.isArray(parsed)) return 'invalid';
  if (parsed.length === 3 && parsed[0] === 'i' && Number.isSafeInteger(parsed[1]) && typeof parsed[2] === 'string' && parsed[2].length > 0) {
    return { phase: 'interviews', createdAt: parsed[1] as number, id: parsed[2] };
  }
  if (parsed.length === 2 && parsed[0] === 'a' && Number.isSafeInteger(parsed[1]) && (parsed[1] as number) >= 0) {
    return { phase: 'aggregates', position: parsed[1] as number };
  }
  return 'invalid';
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

/** Portable twin of kv.ts decodeStoredAggregate: a malformed value is absent. */
export function decodeAggregateJson(raw: string, studyId: string): StoredAggregateSynthesis | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  if (rec.studyId !== studyId) return null;
  if ('_receipt' in rec) return null;
  if (!Number.isSafeInteger(rec.studyRevision) || (rec.studyRevision as number) < 0) return null;
  if (!Number.isSafeInteger(rec.savedAt) || !Number.isSafeInteger(rec.generatedAt)) return null;
  if (!Array.isArray(rec.interviewIds) || rec.interviewIds.length === 0) return null;
  if (rec.interviewIds.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 200)) return null;
  if (rec.interviewCount !== rec.interviewIds.length) return null;
  if (!Array.isArray(rec.commonThemes) || !Array.isArray(rec.divergentViews)) return null;
  if (!Array.isArray(rec.keyFindings) || !Array.isArray(rec.researchImplications)) return null;
  if (typeof rec.bottomLine !== 'string') return null;
  if (typeof rec.aiProvider !== 'string' || typeof rec.aiModel !== 'string') return null;
  return parsed as StoredAggregateSynthesis;
}

function logCorrupt(): void {
  logRequestEvent({ event: 'workspace.store', operation: 'export', reason: 'corrupt-record' });
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------- Capture ----------

type CaptureRow = {
  id: string;
  study_id: string;
  created_at: number;
  fingerprint: string;
  a_id: string | null;
  a_status: AnalysisRow['status'] | null;
  a_generation: number | null;
  a_attempts: number | null;
  a_last_attempt_at: number | null;
  a_failure_kind: AnalysisRow['failure_kind'];
  a_recovery_required: number | null;
  a_study_revision: number | null;
};

function interviewCount(sql: SqlStorage): number {
  return sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM interviews`).one().n;
}

/**
 * The export state at the current sequence. Callers read the count (and
 * refuse over-ceiling exports) first, in the same synchronous section.
 */
function captureSnapshot(sql: SqlStorage, sequence: number): ExportSnapshot {
  const rows = sql
    .exec<CaptureRow>(
      `SELECT i.id, i.study_id, i.created_at, i.fingerprint,
              a.interview_id AS a_id, a.status AS a_status, a.current_generation AS a_generation,
              a.attempts AS a_attempts, a.last_attempt_at AS a_last_attempt_at, a.failure_kind AS a_failure_kind,
              a.recovery_required AS a_recovery_required, a.study_revision AS a_study_revision
         FROM interviews i LEFT JOIN analysis a ON a.interview_id = i.id
        ORDER BY i.created_at DESC, i.id DESC`,
    )
    .toArray();
  const interviews: CapturedInterview[] = [];
  const studyOrder: string[] = [];
  const seenStudies = new Set<string>();
  for (const row of rows) {
    interviews.push({
      id: row.id,
      createdAt: row.created_at,
      fingerprint: row.fingerprint,
      analysis: row.a_id === null
        ? null
        : {
            status: row.a_status as AnalysisRow['status'],
            generation: row.a_generation as number,
            attempts: row.a_attempts as number,
            lastAttemptAt: row.a_last_attempt_at as number,
            failureKind: row.a_failure_kind,
            recoveryRequired: row.a_recovery_required as number,
            studyRevision: row.a_study_revision,
          },
    });
    if (!seenStudies.has(row.study_id)) {
      seenStudies.add(row.study_id);
      studyOrder.push(row.study_id);
    }
  }
  const aggregates: CapturedAggregate[] = [];
  // One aggregate in memory at a time; each is at most MAX_STORED_AGGREGATE_BYTES.
  for (const studyId of studyOrder) {
    const stored = readAggregateRow(sql, studyId);
    if (!stored) continue;
    if (!decodeAggregateJson(stored, studyId)) {
      logCorrupt();
      continue;
    }
    aggregates.push({ studyId, bytes: new TextEncoder().encode(stored).byteLength, sha256: sha256Hex(stored) });
  }
  return { v: 1, sequence, capturedAt: Date.now(), interviews, aggregates };
}

function readAggregateRow(sql: SqlStorage, studyId: string): string | null {
  const rows = sql
    .exec<{ aggregate_json: string }>(`SELECT aggregate_json FROM aggregates WHERE study_id = ?`, studyId)
    .toArray();
  return rows.length === 1 ? rows[0].aggregate_json : null;
}

// ---------- Snapshot storage ----------

function snapshotKey(sequence: number): string {
  return `${EXPORT_SNAPSHOT_PREFIX}${sequence}`;
}

function isSnapshot(value: unknown, sequence: number): value is ExportSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<ExportSnapshot>;
  return snapshot.v === 1
    && snapshot.sequence === sequence
    && typeof snapshot.capturedAt === 'number'
    && Array.isArray(snapshot.interviews)
    && Array.isArray(snapshot.aggregates);
}

/** Discard expired snapshots and keep at most EXPORT_SNAPSHOT_LIMIT - 1 others. */
function pruneSnapshots(storage: DurableObjectStorage, now: number): void {
  const kept: Array<{ key: string; capturedAt: number }> = [];
  for (const [key, value] of storage.kv.list<ExportSnapshot>({ prefix: EXPORT_SNAPSHOT_PREFIX })) {
    const capturedAt = value && typeof value === 'object' && typeof value.capturedAt === 'number' ? value.capturedAt : null;
    if (capturedAt === null || now - capturedAt > EXPORT_SNAPSHOT_TTL_MS) storage.kv.delete(key);
    else kept.push({ key, capturedAt });
  }
  kept.sort((a, b) => b.capturedAt - a.capturedAt);
  for (const stale of kept.slice(EXPORT_SNAPSHOT_LIMIT - 1)) storage.kv.delete(stale.key);
}

function storeSnapshot(storage: DurableObjectStorage, snapshot: ExportSnapshot): void {
  pruneSnapshots(storage, snapshot.capturedAt);
  storage.kv.put(snapshotKey(snapshot.sequence), snapshot);
}

type Loaded = { status: 'ok'; snapshot: ExportSnapshot } | { status: 'changed' } | { status: 'unavailable' };

/**
 * The snapshot for `sequence`: stored, or recaptured when the workspace is
 * still at that sequence (the identical state). Synchronous.
 */
function loadSnapshot(ws: WorkspaceContext, meta: WorkspaceMeta, sequence: number): Loaded {
  const stored = ws.storage.kv.get(snapshotKey(sequence));
  if (isSnapshot(stored, sequence) && Date.now() - stored.capturedAt <= EXPORT_SNAPSHOT_TTL_MS) {
    return { status: 'ok', snapshot: stored };
  }
  if (meta.mutationSeq !== sequence) return { status: 'changed' };
  if (interviewCount(ws.sql) > EXPORT_MAX_INTERVIEWS) return { status: 'unavailable' };
  const snapshot = captureSnapshot(ws.sql, sequence);
  storeSnapshot(ws.storage, snapshot);
  return { status: 'ok', snapshot };
}

// ---------- Captured-row checks ----------

type LiveInterview = { bytes: number };

/**
 * The captured interview's current row, or null when it no longer
 * reproduces the captured state (deleted, replaced, or a captured complete
 * analysis no longer at its generation).
 */
function liveInterview(sql: SqlStorage, captured: CapturedInterview): LiveInterview | null {
  const rows = sql
    .exec<{ fingerprint: string; created_at: number; bytes: number }>(
      `SELECT fingerprint, created_at, length(CAST(record_json AS BLOB)) AS bytes FROM interviews WHERE id = ?`,
      captured.id,
    )
    .toArray();
  if (rows.length !== 1 || rows[0].fingerprint !== captured.fingerprint || rows[0].created_at !== captured.createdAt) return null;
  let bytes = rows[0].bytes;
  if (captured.analysis?.status === 'complete') {
    const analysis = sql
      .exec<{ status: string; current_generation: number; bytes: number | null }>(
        `SELECT status, current_generation,
                length(CAST(synthesis_json AS BLOB)) + length(CAST(provenance_json AS BLOB)) AS bytes
           FROM analysis WHERE interview_id = ?`,
        captured.id,
      )
      .toArray();
    if (analysis.length !== 1 || analysis[0].status !== 'complete' || analysis[0].current_generation !== captured.analysis.generation) {
      return null;
    }
    bytes += analysis[0].bytes ?? 0;
  }
  return { bytes };
}

/** The captured aggregate's current text, or null when it was replaced or removed. */
function liveAggregate(sql: SqlStorage, captured: CapturedAggregate): string | null {
  const stored = readAggregateRow(sql, captured.studyId);
  return stored !== null && sha256Hex(stored) === captured.sha256 ? stored : null;
}

function capturedRow(sql: SqlStorage, captured: CapturedInterview): AnalysisRow | null {
  const state = captured.analysis;
  if (!state) return null;
  let synthesisJson: string | null = null;
  let provenanceJson: string | null = null;
  if (state.status === 'complete') {
    const current = sql
      .exec<{ synthesis_json: string | null; provenance_json: string | null }>(
        `SELECT synthesis_json, provenance_json FROM analysis WHERE interview_id = ?`,
        captured.id,
      )
      .one();
    synthesisJson = current.synthesis_json;
    provenanceJson = current.provenance_json;
  }
  return {
    interview_id: captured.id,
    status: state.status,
    current_generation: state.generation,
    attempts: state.attempts,
    last_attempt_at: state.lastAttemptAt,
    failure_kind: state.failureKind,
    recovery_required: state.recoveryRequired,
    study_revision: state.studyRevision,
    synthesis_json: synthesisJson,
    provenance_json: provenanceJson,
    updated_at: state.lastAttemptAt,
  };
}

function afterInterviews(snapshot: ExportSnapshot): string | null {
  return snapshot.aggregates.length > 0 ? JSON.stringify(['a', 0]) : null;
}

// ---------- Pages ----------

function readInterviewPage(
  sql: SqlStorage,
  snapshot: ExportSnapshot,
  start: number,
  pageSize: number,
  maxPageBytes: number,
): Rpc.ExportPageOutcome {
  const chosen: CapturedInterview[] = [];
  let budget = 0;
  // Sizes first, so a page never materializes more than its byte budget.
  for (const captured of snapshot.interviews.slice(start, start + pageSize)) {
    const live = liveInterview(sql, captured);
    if (!live) return { status: 'changed' };
    const cost = live.bytes + PROJECTION_OVERHEAD_BYTES;
    if (chosen.length > 0 && budget + cost > maxPageBytes) break;
    chosen.push(captured);
    budget += cost;
  }
  if (chosen.length === 0) return { status: 'ok', interviews: [], aggregates: [], nextCursor: afterInterviews(snapshot) };
  const interviews: StoredInterview[] = chosen.map((captured) => {
    const record = sql
      .exec<{ record_json: string }>(`SELECT record_json FROM interviews WHERE id = ?`, captured.id)
      .one().record_json;
    return projectInterview(record, captured.id, capturedRow(sql, captured));
  });
  const last = chosen[chosen.length - 1];
  const nextCursor = start + chosen.length < snapshot.interviews.length
    ? JSON.stringify(['i', last.createdAt, last.id])
    : afterInterviews(snapshot);
  return { status: 'ok', interviews, aggregates: [], nextCursor };
}

function readAggregatePage(
  sql: SqlStorage,
  snapshot: ExportSnapshot,
  position: number,
  pageSize: number,
  maxPageBytes: number,
): Rpc.ExportPageOutcome {
  const slots = snapshot.aggregates;
  const aggregates: StoredAggregateSynthesis[] = [];
  let budget = 0;
  let next = position;
  while (next < slots.length && next - position < pageSize) {
    const cost = slots[next].bytes + PROJECTION_OVERHEAD_BYTES;
    if (next > position && budget + cost > maxPageBytes) break;
    budget += cost;
    const stored = liveAggregate(sql, slots[next]);
    if (stored === null) return { status: 'changed' };
    const decoded = decodeAggregateJson(stored, slots[next].studyId);
    if (!decoded) throw new CorruptRecordError('record');
    aggregates.push(decoded);
    next += 1;
  }
  return {
    status: 'ok',
    interviews: [],
    aggregates,
    nextCursor: next < slots.length ? JSON.stringify(['a', next]) : null,
  };
}

// ---------- RPCs ----------

export async function beginExport(ws: WorkspaceContext, input: Rpc.BeginExportInput): Promise<Rpc.BeginExportOutcome> {
  try {
    const checked = gate(ws, 'read');
    if (!checked.ok) return { status: 'unavailable' };
    if (!isBoundedInteger(input?.maximum, 1, EXPORT_MAX_INTERVIEWS)) return { status: 'unavailable' };
    const count = interviewCount(ws.sql);
    if (count === 0) return { status: 'empty' };
    if (count > input.maximum) return { status: 'too-large', count, maximum: input.maximum };
    const sequence = checked.meta.mutationSeq;
    const snapshot = captureSnapshot(ws.sql, sequence);
    storeSnapshot(ws.storage, snapshot);
    return { status: 'ok', sequence, count, studyIds: snapshot.aggregates.map((aggregate) => aggregate.studyId) };
  } catch {
    return { status: 'unavailable' };
  }
}

export async function readExportPage(ws: WorkspaceContext, input: Rpc.ExportPageInput): Promise<Rpc.ExportPageOutcome> {
  try {
    const checked = gate(ws, 'read');
    if (!checked.ok) return { status: 'unavailable' };
    if (
      !isBoundedInteger(input?.sequence, 0, Number.MAX_SAFE_INTEGER)
      || !isBoundedInteger(input.pageSize, 1, EXPORT_MAX_PAGE_SIZE)
      || !isBoundedInteger(input.maxPageBytes, 1, EXPORT_MAX_PAGE_BYTES)
    ) {
      return { status: 'unavailable' };
    }
    const cursor = parseCursor(input.cursor);
    if (cursor === 'invalid') return { status: 'unavailable' };
    const loaded = loadSnapshot(ws, checked.meta, input.sequence);
    if (loaded.status !== 'ok') return loaded;
    const { snapshot } = loaded;
    if (cursor?.phase === 'aggregates') {
      if (cursor.position > snapshot.aggregates.length) return { status: 'unavailable' };
      return readAggregatePage(ws.sql, snapshot, cursor.position, input.pageSize, input.maxPageBytes);
    }
    let start = 0;
    if (cursor) {
      const index = snapshot.interviews.findIndex((captured) => captured.id === cursor.id && captured.createdAt === cursor.createdAt);
      if (index < 0) return { status: 'unavailable' };
      start = index + 1;
    }
    return readInterviewPage(ws.sql, snapshot, start, input.pageSize, input.maxPageBytes);
  } catch (error) {
    if (error instanceof CorruptRecordError) logCorrupt();
    return { status: 'unavailable' };
  }
}

/**
 * The final check before the archive is finalized: every captured interview
 * and aggregate must still reproduce the captured state.
 */
export async function verifyExportSequence(ws: WorkspaceContext, input: Rpc.ExportSequenceInput): Promise<Rpc.ExportSequenceOutcome> {
  try {
    const checked = gate(ws, 'read');
    if (!checked.ok) return { status: 'unavailable' };
    if (!isBoundedInteger(input?.sequence, 0, Number.MAX_SAFE_INTEGER)) return { status: 'unavailable' };
    const loaded = loadSnapshot(ws, checked.meta, input.sequence);
    if (loaded.status !== 'ok') return loaded;
    const { snapshot } = loaded;
    if (snapshot.interviews.some((captured) => liveInterview(ws.sql, captured) === null)) return { status: 'changed' };
    if (snapshot.aggregates.some((captured) => liveAggregate(ws.sql, captured) === null)) return { status: 'changed' };
    return { status: 'unchanged' };
  } catch {
    return { status: 'unavailable' };
  }
}
