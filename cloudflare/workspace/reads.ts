// Interview reads and collections, aggregate read/write and bounded aggregate
// inputs (ST-05/08). Every interview leaves the object through projection.ts,
// so SQL internals never reach UI or export consumers. Collections count
// before loading, page by keyset within a byte budget and never silently
// truncate.

import type * as Port from '../../src/lib/storage/types';
import type { StoredAggregateSynthesis, StoredInterview } from '../../src/types';
import type * as Rpc from './rpcTypes';
import { bumpMutationSeq, gate, type WorkspaceContext } from './context';
import { CorruptRecordError, projectInterview, type AnalysisRow } from './projection';
import {
  INTERVIEW_ID,
  isPlainObject,
  isRevision,
  isSafeTime,
  keysetCursorAfter,
  logCorruptRecord,
  logStorageFailure,
  MAX_COLLECTION_BYTES,
  parseKeysetCursor,
  readStudyRow,
  STUDY_ID,
  utf8Bytes,
  type KeysetCursor,
} from './studies';

/** The existing serialized aggregate ceiling (kv.ts MAX_STORED_AGGREGATE_BYTES). */
export const MAX_STORED_AGGREGATE_BYTES = 256_000;
/** Stored bytes one RPC response may carry (defined with the shared row helpers). */
export { MAX_COLLECTION_BYTES };
const MAX_PAGE_SIZE = 1_000;
/** Budget allowance per row for the projected analysis state and clone framing. */
const PROJECTION_OVERHEAD_BYTES = 1_024;

// ---------- Joined interview rows ----------

type JoinedRow = {
  id: string;
  record_json: string;
  created_at: number;
  a_interview_id: string | null;
  a_status: AnalysisRow['status'] | null;
  a_current_generation: number | null;
  a_attempts: number | null;
  a_last_attempt_at: number | null;
  a_failure_kind: AnalysisRow['failure_kind'];
  a_recovery_required: number | null;
  a_study_revision: number | null;
  a_synthesis_json: string | null;
  a_provenance_json: string | null;
  a_updated_at: number | null;
};

const JOINED_COLUMNS = `i.id AS id, i.record_json AS record_json, i.created_at AS created_at,
  a.interview_id AS a_interview_id, a.status AS a_status, a.current_generation AS a_current_generation,
  a.attempts AS a_attempts, a.last_attempt_at AS a_last_attempt_at, a.failure_kind AS a_failure_kind,
  a.recovery_required AS a_recovery_required, a.study_revision AS a_study_revision,
  a.synthesis_json AS a_synthesis_json, a.provenance_json AS a_provenance_json, a.updated_at AS a_updated_at`;

const JOINED_FROM = `interviews i LEFT JOIN analysis a ON a.interview_id = i.id`;

// octet_length reads the stored size from the record header, so sizing a page
// never loads the content it measures (CAST AS BLOB copies every value).
const ROW_BYTES = `(octet_length(i.record_json)
  + COALESCE(octet_length(a.synthesis_json), 0)
  + COALESCE(octet_length(a.provenance_json), 0))`;

const NEWEST_FIRST = `ORDER BY i.created_at DESC, i.id DESC`;
const KEYSET = `AND (i.created_at < ? OR (i.created_at = ? AND i.id < ?))`;

/**
 * One keyset page over (created_at DESC, id DESC). Sizes are read first so a
 * page never materializes more than its byte budget; a single row larger than
 * the budget is a page by itself, so paging always makes progress. Both
 * queries run in the caller's transaction and see the same rows.
 */
function readJoinedPage(
  ws: WorkspaceContext,
  where: string,
  bindings: SqlStorageValue[],
  cursor: KeysetCursor | null,
  pageSize: number,
  maxPageBytes: number,
): { rows: JoinedRow[]; more: boolean } {
  const keyset = cursor ? KEYSET : '';
  const keysetBindings = cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : [];
  const sizes = ws.sql
    .exec<{ bytes: number }>(
      `SELECT ${ROW_BYTES} AS bytes FROM ${JOINED_FROM} WHERE ${where} ${keyset} ${NEWEST_FIRST} LIMIT ?`,
      ...bindings,
      ...keysetBindings,
      pageSize + 1,
    )
    .toArray();
  let take = 0;
  let bytes = 0;
  while (take < sizes.length && take < pageSize) {
    const next = bytes + sizes[take].bytes + PROJECTION_OVERHEAD_BYTES;
    if (take > 0 && next > maxPageBytes) break;
    bytes = next;
    take += 1;
  }
  if (take === 0) return { rows: [], more: false };
  const rows = ws.sql
    .exec<JoinedRow>(
      `SELECT ${JOINED_COLUMNS} FROM ${JOINED_FROM} WHERE ${where} ${keyset} ${NEWEST_FIRST} LIMIT ?`,
      ...bindings,
      ...keysetBindings,
      take,
    )
    .toArray();
  return { rows, more: sizes.length > take };
}

function analysisOf(row: JoinedRow): AnalysisRow | null {
  if (row.a_interview_id === null) return null;
  return {
    interview_id: row.a_interview_id,
    status: row.a_status as AnalysisRow['status'],
    current_generation: row.a_current_generation as number,
    attempts: row.a_attempts as number,
    last_attempt_at: row.a_last_attempt_at as number,
    failure_kind: row.a_failure_kind,
    recovery_required: row.a_recovery_required as number,
    study_revision: row.a_study_revision,
    synthesis_json: row.a_synthesis_json,
    provenance_json: row.a_provenance_json,
    updated_at: row.a_updated_at as number,
  };
}

/** Throws CorruptRecordError for a malformed record or analysis row. */
function projectJoined(row: JoinedRow): StoredInterview {
  return projectInterview(row.record_json, row.id, analysisOf(row));
}

export async function getInterview(ws: WorkspaceContext, input: Rpc.InterviewIdInput): Promise<Port.InterviewLoadResult> {
  try {
    if (typeof input?.interviewId !== 'string') return { status: 'unavailable' };
    return ws.storage.transactionSync((): Port.InterviewLoadResult => {
      if (!gate(ws, 'read').ok) return { status: 'unavailable' };
      if (!INTERVIEW_ID.test(input.interviewId)) return { status: 'not-found' };
      const row = ws.sql
        .exec<JoinedRow>(`SELECT ${JOINED_COLUMNS} FROM ${JOINED_FROM} WHERE i.id = ?`, input.interviewId)
        .toArray()[0];
      if (!row) return { status: 'not-found' };
      try {
        return { status: 'found', interview: projectJoined(row) };
      } catch (error) {
        if (!(error instanceof CorruptRecordError)) throw error;
        // A single corrupt record is a retryable refusal; the row is never patched.
        logCorruptRecord('getInterview');
        return { status: 'unavailable' };
      }
    });
  } catch (error) {
    logStorageFailure('getInterview', error);
    return { status: 'unavailable' };
  }
}

/**
 * Paged listInterviews request (the durable client always sends `page`).
 * Without `page` the whole collection must fit one response, otherwise it is
 * too-large, so a caller unaware of paging can never receive a partial list.
 */
export type ListInterviewsRequest = Port.ListInterviewsInput & {
  page?: { cursor: string | null; maxPageBytes: number };
};

export type ListInterviewsPage =
  | { status: 'ok'; items: StoredInterview[]; nextCursor: string | null; count: number }
  | { status: 'too-large'; count: number; maximum: number }
  | { status: 'unavailable' };

/**
 * Newest-first interviews of one study or the workspace. Every page re-counts
 * the scope against the route maximum. Pages are separate transactions keyed
 * by immutable (created_at, id), so a row present throughout the listing
 * appears exactly once; a row committed or deleted between pages may or may
 * not appear (the Redis list was not a snapshot either). A malformed
 * immutable record is left out (Redis parity); malformed analysis state
 * refuses the collection, as export and aggregate inputs do, rather than
 * hiding an intact transcript.
 */
export async function listInterviews(
  ws: WorkspaceContext,
  input: ListInterviewsRequest,
): Promise<Port.CollectionLoadResult<Rpc.StoredInterview> | ListInterviewsPage> {
  try {
    const maximum = input?.maximum;
    if (typeof maximum !== 'number' || !Number.isSafeInteger(maximum) || maximum < 0) return { status: 'unavailable' };
    if (input.scope !== 'all' && (input.scope !== 'study' || typeof input.studyId !== 'string')) {
      return { status: 'unavailable' };
    }
    const page = input.page;
    let cursor: KeysetCursor | null = null;
    if (page !== undefined) {
      if (
        !isPlainObject(page)
        || typeof page.maxPageBytes !== 'number'
        || !Number.isSafeInteger(page.maxPageBytes)
        || page.maxPageBytes < 1
        || (page.cursor !== null && typeof page.cursor !== 'string')
      ) {
        return { status: 'unavailable' };
      }
      cursor = page.cursor === null ? null : parseKeysetCursor(page.cursor);
      if (page.cursor !== null && !cursor) return { status: 'unavailable' };
    }
    const maxPageBytes = page ? Math.min(page.maxPageBytes, MAX_COLLECTION_BYTES) : MAX_COLLECTION_BYTES;
    const studyId = input.scope === 'study' ? input.studyId : null;
    const where = studyId !== null ? 'i.study_id = ?' : '1 = 1';
    const bindings = studyId !== null ? [studyId] : [];

    return ws.storage.transactionSync((): Port.CollectionLoadResult<Rpc.StoredInterview> | ListInterviewsPage => {
      if (!gate(ws, 'read').ok) return { status: 'unavailable' };
      if (studyId !== null && !STUDY_ID.test(studyId)) {
        return page ? { status: 'ok', items: [], nextCursor: null, count: 0 } : { status: 'ok', items: [] };
      }
      // Count first: an oversized collection is refused before any content is read.
      const count = ws.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM interviews i WHERE ${where}`, ...bindings)
        .one().n;
      if (count > maximum) return { status: 'too-large', count, maximum };
      const pageSize = page ? MAX_PAGE_SIZE : Math.max(1, count);
      const { rows, more } = readJoinedPage(ws, where, bindings, cursor, pageSize, maxPageBytes);
      if (!page && more) return { status: 'too-large', count, maximum };
      const items: StoredInterview[] = [];
      let skipped = false;
      for (const row of rows) {
        try {
          items.push(projectJoined(row));
        } catch (error) {
          if (!(error instanceof CorruptRecordError)) throw error;
          if (error.where === 'analysis') {
            logCorruptRecord('listInterviews');
            return { status: 'unavailable' };
          }
          skipped = true;
        }
      }
      if (skipped) logCorruptRecord('listInterviews');
      if (!page) return { status: 'ok', items };
      return { status: 'ok', items, nextCursor: more ? keysetCursorAfter(rows[rows.length - 1]) : null, count };
    });
  } catch (error) {
    logStorageFailure('listInterviews', error);
    return { status: 'unavailable' };
  }
}

// ---------- Aggregate ----------

/** kv.ts decodeStoredAggregate: anything that does not decode is absent. */
function decodeAggregate(json: string, studyId: string): StoredAggregateSynthesis | null {
  let rec: unknown;
  try {
    rec = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isPlainObject(rec)) return null;
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
  return rec as unknown as StoredAggregateSynthesis;
}

export async function getAggregate(ws: WorkspaceContext, input: Rpc.StudyIdInput): Promise<Port.AggregateLoadResult> {
  try {
    if (typeof input?.studyId !== 'string') return { status: 'unavailable' };
    return ws.storage.transactionSync((): Port.AggregateLoadResult => {
      if (!gate(ws, 'read').ok) return { status: 'unavailable' };
      if (!STUDY_ID.test(input.studyId)) return { status: 'not-found' };
      const row = ws.sql
        .exec<{ aggregate_json: string }>(`SELECT aggregate_json FROM aggregates WHERE study_id = ?`, input.studyId)
        .toArray()[0];
      if (!row) return { status: 'not-found' };
      const aggregate = decodeAggregate(row.aggregate_json, input.studyId);
      if (!aggregate) {
        logCorruptRecord('getAggregate');
        return { status: 'not-found' };
      }
      return { status: 'found', aggregate };
    });
  } catch (error) {
    logStorageFailure('getAggregate', error);
    return { status: 'unavailable' };
  }
}

/**
 * Latest-value replacement (no history, no revision CAS), refused for a
 * missing or deleted study so a concurrent deletion cannot leave an orphan.
 */
export async function saveAggregate(ws: WorkspaceContext, input: Rpc.SaveAggregateInput): Promise<Port.SaveAggregateOutcome> {
  try {
    const aggregate = input?.aggregate;
    if (!isPlainObject(aggregate) || typeof aggregate.studyId !== 'string' || !STUDY_ID.test(aggregate.studyId)) {
      return 'unavailable';
    }
    if (!isSafeTime(input.now)) return 'unavailable';
    const serialized = JSON.stringify(aggregate);
    if (utf8Bytes(serialized) > MAX_STORED_AGGREGATE_BYTES) return 'too-large';
    // Never store a value the reader would discard as absent.
    if (!decodeAggregate(serialized, aggregate.studyId)) return 'unavailable';
    const studyId = aggregate.studyId;
    return ws.storage.transactionSync((): Port.SaveAggregateOutcome => {
      if (!gate(ws, 'researcher-mutation').ok) return 'held';
      if (!readStudyRow(ws, studyId)) return 'study-not-found';
      ws.sql.exec(
        `INSERT INTO aggregates (study_id, aggregate_json, saved_at) VALUES (?, ?, ?)
         ON CONFLICT (study_id) DO UPDATE SET aggregate_json = excluded.aggregate_json, saved_at = excluded.saved_at`,
        studyId,
        serialized,
        input.now,
      );
      bumpMutationSeq(ws.sql, input.now);
      return 'saved';
    });
  } catch (error) {
    logStorageFailure('saveAggregate', error);
    return 'unavailable';
  }
}

// ---------- Aggregate/follow-up inputs (keyset pages) ----------

// Eligibility matches the aggregate and follow-up routes: the record's own
// studyRevision equals the study's current revision and a synthesis exists.
// Legacy records without an analysis row carry their synthesis in the record.
const ELIGIBLE = `i.study_id = ?
  AND COALESCE(
    i.study_revision,
    CASE WHEN json_valid(i.record_json) THEN json_extract(i.record_json, '$.studyRevision') END
  ) = ?
  AND (
    (a.interview_id IS NOT NULL AND a.status = 'complete')
    OR (a.interview_id IS NULL
      AND CASE WHEN json_valid(i.record_json) THEN json_type(i.record_json, '$.synthesis') END = 'object')
  )`;

/**
 * Inputs for one paid aggregate or follow-up call. They exist only to feed a
 * provider, so they are fenced like the route they feed rather than like a
 * read: follow-up generation is a paid call without a write, served while open
 * or draining (F26); aggregate synthesis ends in a researcher mutation, so it
 * is served only while open and refused before the provider is paid. A request
 * without a purpose gets the stricter aggregate fence. Both refuse a
 * recovery-epoch mismatch.
 */
export async function readAggregateInputs(
  ws: WorkspaceContext,
  input: Rpc.AggregateInputsInput,
): Promise<Rpc.AggregateInputsOutcome> {
  try {
    if (
      typeof input?.studyId !== 'string'
      || !STUDY_ID.test(input.studyId)
      || !isRevision(input.studyRevision)
      || (input.cursor !== null && typeof input.cursor !== 'string')
      || typeof input.pageSize !== 'number'
      || !Number.isSafeInteger(input.pageSize)
      || input.pageSize < 1
      || typeof input.maxPageBytes !== 'number'
      || !Number.isSafeInteger(input.maxPageBytes)
      || input.maxPageBytes < 1
      || (input.purpose !== undefined && input.purpose !== 'aggregate' && input.purpose !== 'follow-up')
    ) {
      return { status: 'unavailable' };
    }
    const cursor = input.cursor === null ? null : parseKeysetCursor(input.cursor);
    if (input.cursor !== null && !cursor) return { status: 'unavailable' };
    const pageSize = Math.min(input.pageSize, MAX_PAGE_SIZE);
    const maxPageBytes = Math.min(input.maxPageBytes, MAX_COLLECTION_BYTES);
    const base = [input.studyId, input.studyRevision];
    const operation = input.purpose === 'follow-up' ? 'job-settlement' : 'researcher-mutation';

    return ws.storage.transactionSync((): Rpc.AggregateInputsOutcome => {
      if (!gate(ws, operation).ok) return { status: 'unavailable' };
      const totalEligible = ws.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${JOINED_FROM} WHERE ${ELIGIBLE}`, ...base)
        .one().n;
      const { rows, more } = readJoinedPage(ws, ELIGIBLE, base, cursor, pageSize, maxPageBytes);
      if (rows.length === 0) return { status: 'ok', interviews: [], nextCursor: null, totalEligible };
      const interviews: StoredInterview[] = [];
      for (const row of rows) {
        try {
          interviews.push(projectJoined(row));
        } catch (error) {
          if (!(error instanceof CorruptRecordError)) throw error;
          // An aggregate's interview set is provenance: fail rather than omit.
          logCorruptRecord('readAggregateInputs');
          return { status: 'unavailable' };
        }
      }
      const nextCursor = more ? keysetCursorAfter(rows[rows.length - 1]) : null;
      return { status: 'ok', interviews, nextCursor, totalEligible };
    });
  } catch (error) {
    logStorageFailure('readAggregateInputs', error);
    return { status: 'unavailable' };
  }
}
