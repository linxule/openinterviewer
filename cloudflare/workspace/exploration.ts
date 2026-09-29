// The study-owned notebook. Reservations and settlements are CAS operations;
// no provider I/O and no source transcript copies live in these artifacts.
import type * as E from '../../src/lib/exploration/types';
import { MAX_EXPLORATION_ANSWERS } from '../../src/lib/exploration/types';
import {
  isCompleteExplorationInput, isExplorationAnswer, isExplorationId, isExplorationDigest,
  isExplorationReservation, isFailExplorationInput, parseExplorationAnswer,
} from '../../src/lib/exploration/validation';
import { bumpMutationSeq, gate, type WorkspaceContext } from './context';
import { decodeStudyRow, isPlainObject, logCorruptRecord, logStorageFailure, readStudyRow } from './studies';

type AnswerRow = {
  id: string; study_id: string; record_json: string; request_fingerprint: string;
  created_at: number; updated_at: number; status: string;
};

export function decodeAnswerRow(row: AnswerRow): E.ExplorationAnswer | null {
  try {
    const answer = parseExplorationAnswer(JSON.parse(row.record_json));
    return answer && answer.id === row.id && answer.studyId === row.study_id
      && answer.requestFingerprint === row.request_fingerprint && answer.status === row.status
      && answer.createdAt === row.created_at && answer.updatedAt === row.updated_at ? answer : null;
  } catch { return null; }
}

function readAnswer(ws: WorkspaceContext, studyId: string, id: string): E.ExplorationAnswer | null | 'corrupt' {
  const row = ws.sql.exec<AnswerRow>(`SELECT * FROM exploration_answers WHERE study_id = ? AND id = ?`, studyId, id).toArray()[0];
  if (!row) return null;
  return decodeAnswerRow(row) ?? 'corrupt';
}

function parentReady(ws: WorkspaceContext, studyId: string): 'ready' | 'missing' | 'corrupt' {
  const row = readStudyRow(ws, studyId);
  return !row ? 'missing' : decodeStudyRow(row) ? 'ready' : 'corrupt';
}

function sourcesLive(ws: WorkspaceContext, answer: E.ExplorationAnswer): boolean {
  return answer.scope.sources.every(source => {
    const row = ws.sql.exec<{ study_id: string; study_revision: number | null }>(
      `SELECT study_id, COALESCE(study_revision, CASE WHEN json_valid(record_json)
         THEN json_extract(record_json, '$.studyRevision') END) AS study_revision
       FROM interviews WHERE id = ?`, source.interviewId,
    ).toArray()[0];
    return row && row.study_id === answer.studyId && row.study_revision === source.studyRevision;
  });
}

function save(ws: WorkspaceContext, answer: E.ExplorationAnswer): void {
  ws.sql.exec(`UPDATE exploration_answers SET record_json = ?, updated_at = ?, status = ? WHERE id = ? AND study_id = ?`,
    JSON.stringify(answer), answer.updatedAt, answer.status, answer.id, answer.studyId);
  bumpMutationSeq(ws.sql, answer.updatedAt);
}

function sameJson(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown) => JSON.stringify(value, (_key, member: unknown) => isPlainObject(member)
    ? Object.fromEntries(Object.keys(member).sort().map(key => [key, member[key]])) : member);
  return canonical(left) === canonical(right);
}

export async function lookup(ws: WorkspaceContext, input: { studyId: string; keyDigest: string; requestFingerprint: string }): Promise<E.ExplorationLookupOutcome> {
  try {
    if (!isPlainObject(input) || !isExplorationId(input.studyId) || !isExplorationDigest(input.keyDigest)
      || !isExplorationDigest(input.requestFingerprint)) return { status: 'unavailable' };
    return ws.storage.transactionSync(() => {
      if (!gate(ws, 'read').ok) return { status: 'unavailable' };
      const parent = parentReady(ws, input.studyId);
      if (parent === 'missing') return { status: 'not-found' };
      if (parent !== 'ready') return { status: 'unavailable' };
      const receipt = ws.sql.exec<{ fingerprint: string; target_id: string | null; disposition: string; result_json: string | null }>(
        `SELECT fingerprint, target_id, disposition, result_json FROM idempotency_receipts WHERE operation_family = 'exploration' AND key_digest = ?`, input.keyDigest,
      ).toArray()[0];
      if (!receipt) return { status: 'not-found' };
      if (receipt.fingerprint !== input.requestFingerprint || receipt.target_id !== input.studyId
        || receipt.disposition !== 'reserved' || !receipt.result_json) return { status: 'key-reuse' };
      const answer = readAnswer(ws, input.studyId, receipt.result_json);
      if (!answer || answer === 'corrupt') return { status: 'unavailable' };
      return { status: 'found', answer };
    });
  } catch (error) { logStorageFailure('lookupExploration', error); return { status: 'unavailable' }; }
}

export async function reserve(ws: WorkspaceContext, input: E.ExplorationReservation): Promise<E.ExplorationReserveOutcome> {
  try {
    if (!isExplorationReservation(input)) return { status: 'unavailable' };
    return ws.storage.transactionSync(() => {
      if (!gate(ws, 'researcher-mutation').ok) return { status: 'held' };
      const { answer } = input;
      const row = readStudyRow(ws, answer.studyId);
      if (!row) return { status: 'study-not-found' };
      const study = decodeStudyRow(row);
      if (!study) return { status: 'unavailable' };
      const receipt = ws.sql.exec<{ fingerprint: string; disposition: string; result_json: string | null; target_id: string | null }>(
        `SELECT fingerprint, disposition, result_json, target_id FROM idempotency_receipts
         WHERE operation_family = 'exploration' AND key_digest = ?`, input.keyDigest,
      ).toArray()[0];
      // Notebook identities are durable for the answer's lifetime. Even if a
      // receipt's cleanup horizon passed, it remains binding while present.
      if (receipt) {
        if (receipt.fingerprint !== answer.requestFingerprint || receipt.target_id !== answer.studyId
          || receipt.disposition !== 'reserved' || !receipt.result_json) return { status: 'key-reuse' };
        const original = readAnswer(ws, answer.studyId, receipt.result_json);
        if (!original || original === 'corrupt') return { status: 'unavailable' };
        return { status: 'replay', answer: original };
      }
      if (study.revision !== input.expectedStudyRevision) return { status: 'revision-stale' };
      if (!sourcesLive(ws, answer)) return { status: 'unavailable' };
      if (answer.parentAnswerId) {
        const parent = readAnswer(ws, answer.studyId, answer.parentAnswerId);
        if (!parent || parent === 'corrupt' || parent.status !== 'complete') return { status: 'unavailable' };
      }
      const count = ws.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM exploration_answers WHERE study_id = ?`, answer.studyId).one().n;
      if (count >= MAX_EXPLORATION_ANSWERS) return { status: 'quota' };
      if (ws.sql.exec(`SELECT 1 FROM exploration_answers WHERE id = ?`, answer.id).toArray().length > 0) return { status: 'key-reuse' };
      ws.sql.exec(`INSERT INTO exploration_answers (id, study_id, record_json, request_fingerprint, created_at, updated_at, status)
        VALUES (?, ?, ?, ?, ?, ?, 'running')`, answer.id, answer.studyId, JSON.stringify(answer), answer.requestFingerprint, answer.createdAt, answer.updatedAt);
      ws.sql.exec(`INSERT INTO idempotency_receipts
        (operation_family, key_digest, fingerprint, target_id, disposition, result_json, created_at, expires_at)
        VALUES ('exploration', ?, ?, ?, 'reserved', ?, ?, ?)`,
      input.keyDigest, answer.requestFingerprint, answer.studyId, answer.id, answer.createdAt, Number.MAX_SAFE_INTEGER);
      bumpMutationSeq(ws.sql, answer.createdAt);
      return { status: 'created', answer };
    });
  } catch (error) { logStorageFailure('reserveExploration', error); return { status: 'unavailable' }; }
}

export async function get(ws: WorkspaceContext, input: { studyId: string; answerId: string }): Promise<E.ExplorationReadOutcome> {
  try {
    if (!isPlainObject(input) || !isExplorationId(input.studyId) || !isExplorationId(input.answerId)) return { status: 'unavailable' };
    return ws.storage.transactionSync(() => {
      if (!gate(ws, 'read').ok) return { status: 'unavailable' };
      const parent = parentReady(ws, input.studyId);
      if (parent === 'missing') return { status: 'not-found' };
      if (parent === 'corrupt') return { status: 'unavailable' };
      const answer = readAnswer(ws, input.studyId, input.answerId);
      if (answer === 'corrupt') { logCorruptRecord('getExploration'); return { status: 'unavailable' }; }
      return answer ? { status: 'found', answer } : { status: 'not-found' };
    });
  } catch (error) { logStorageFailure('getExploration', error); return { status: 'unavailable' }; }
}

export async function list(ws: WorkspaceContext, input: { studyId: string; maximum: number; pageSize?: number; cursor?: string | null }): Promise<E.ExplorationListOutcome> {
  try {
    if (!isPlainObject(input) || !isExplorationId(input.studyId) || !Number.isSafeInteger(input.maximum)
      || input.maximum < 1 || input.maximum > MAX_EXPLORATION_ANSWERS) return { status: 'unavailable' };
    const paged = input.pageSize !== undefined;
    if (paged && (!Number.isSafeInteger(input.pageSize) || input.pageSize! < 1 || input.pageSize! > 25)) return { status: 'unavailable' };
    if (!paged && input.cursor !== undefined && input.cursor !== null) return { status: 'unavailable' };
    let cursor: { at: number; id: string } | null = null;
    if (input.cursor !== undefined && input.cursor !== null) {
      if (typeof input.cursor !== 'string') return { status: 'unavailable' };
      const match = /^([0-9]{1,16}):([A-Za-z0-9_-]{1,120})$/.exec(input.cursor);
      if (!match || !Number.isSafeInteger(Number(match[1]))) return { status: 'unavailable' };
      cursor = { at: Number(match[1]), id: match[2] };
    }
    return ws.storage.transactionSync(() => {
      if (!gate(ws, 'read').ok || parentReady(ws, input.studyId) !== 'ready') return { status: 'unavailable' };
      const size = ws.sql.exec<{ n: number; bytes: number | null }>(
        `SELECT COUNT(*) AS n, SUM(length(CAST(record_json AS BLOB))) AS bytes FROM exploration_answers WHERE study_id = ?`, input.studyId,
      ).one();
      // Refuse oversized RPC assemblies truthfully, never truncate the list.
      if (size.n > input.maximum || (!paged && (size.bytes ?? 0) > 12 * 1024 * 1024)) return { status: 'too-large' };
      const limit = paged ? input.pageSize! : input.maximum;
      // Fetch at most 26 bounded artifacts. Never assemble the whole notebook
      // simply to discover that the RPC response is too large.
      const rows = ws.sql.exec<AnswerRow>(`SELECT * FROM exploration_answers WHERE study_id = ?
        ${cursor ? 'AND (created_at < ? OR (created_at = ? AND id < ?))' : ''}
        ORDER BY created_at DESC, id DESC LIMIT ?`, input.studyId,
      ...(cursor ? [cursor.at, cursor.at, cursor.id] : []), limit + (paged ? 1 : 0)).toArray();
      const answers: E.ExplorationAnswer[] = [];
      for (const row of rows.slice(0, limit)) {
        const answer = decodeAnswerRow(row);
        if (!answer) { logCorruptRecord('listExplorations'); return { status: 'unavailable' }; }
        answers.push(answer);
      }
      const last = answers[answers.length - 1];
      return { status: 'ok', answers, ...(paged ? { nextCursor: rows.length > limit && last ? `${last.createdAt}:${last.id}` : null } : {}) };
    });
  } catch (error) { logStorageFailure('listExplorations', error); return { status: 'unavailable' }; }
}

export async function complete(ws: WorkspaceContext, input: E.CompleteExplorationInput): Promise<E.ExplorationWriteOutcome> {
  try {
    if (!isCompleteExplorationInput(input)) return { status: 'unavailable' };
    return ws.storage.transactionSync(() => {
      if (!gate(ws, 'researcher-mutation').ok) return { status: 'held' };
      const parent = parentReady(ws, input.studyId);
      if (parent === 'missing') return { status: 'study-not-found' };
      if (parent !== 'ready') return { status: 'unavailable' };
      const current = readAnswer(ws, input.studyId, input.answerId);
      if (!current) return { status: 'not-found' };
      if (current === 'corrupt') return { status: 'unavailable' };
      if (current.requestFingerprint !== input.requestFingerprint || !sourcesLive(ws, current)) return { status: 'conflict' };
      if (current.status === 'complete') {
        return sameJson(current.result, input.result) && sameJson(current.execution, input.execution)
          ? { status: 'saved', answer: current } : { status: 'conflict' };
      }
      if (current.status !== 'running' && current.status !== 'recovery-required') return { status: 'conflict' };
      const { failureKind: _failure, ...base } = current;
      const answer: E.ExplorationAnswer = { ...base, status: 'complete', result: input.result, execution: input.execution, updatedAt: input.now };
      if (!isExplorationAnswer(answer)) return { status: 'unavailable' };
      save(ws, answer);
      return { status: 'saved', answer };
    });
  } catch (error) { logStorageFailure('completeExploration', error); return { status: 'unavailable' }; }
}

export async function fail(ws: WorkspaceContext, input: E.FailExplorationInput): Promise<E.ExplorationWriteOutcome> {
  try {
    if (!isFailExplorationInput(input)) return { status: 'unavailable' };
    return ws.storage.transactionSync(() => {
      if (!gate(ws, 'researcher-mutation').ok) return { status: 'held' };
      const parent = parentReady(ws, input.studyId);
      if (parent === 'missing') return { status: 'study-not-found' };
      if (parent !== 'ready') return { status: 'unavailable' };
      const current = readAnswer(ws, input.studyId, input.answerId);
      if (!current) return { status: 'not-found' };
      if (current === 'corrupt') return { status: 'unavailable' };
      if (current.requestFingerprint !== input.requestFingerprint) return { status: 'conflict' };
      if (current.status === input.status && current.failureKind === input.failureKind) return { status: 'saved', answer: current };
      if (current.status !== 'running') return { status: 'conflict' };
      const answer: E.ExplorationAnswer = { ...current, status: input.status, failureKind: input.failureKind, updatedAt: input.now };
      if (!isExplorationAnswer(answer)) return { status: 'unavailable' };
      save(ws, answer);
      return { status: 'saved', answer };
    });
  } catch (error) { logStorageFailure('failExploration', error); return { status: 'unavailable' }; }
}
