// Study create/read/edit/link-status/delete (ST-01/03/07, 02-storage.md), plus
// the row helpers the other domain modules share. Every operation validates
// its input, gates, then runs synchronously inside transactionSync with fully
// consumed cursors. Structural corruption refuses without patching the row.

import type * as Port from '../../src/lib/storage/types';
import type { StoredStudy, StudyConfig } from '../../src/types';
import { logRequestEvent, logRequestFailure } from '../../src/lib/requestLog';
import { HEX64, MAX_STUDY_REVISION } from '../../src/lib/wire/types';
import type * as Rpc from './rpcTypes';
import {
  bumpMutationSeq,
  DELETION_FENCE_TTL_MS,
  gate,
  RECEIPT_TTL_MS,
  type WorkspaceContext,
} from './context';

export const STUDY_ID = /^[A-Za-z0-9-]{1,128}$/;
export const INTERVIEW_ID = /^[A-Za-z0-9_-]{1,120}$/;
export const STUDY_CREATE_FAMILY = 'study-create';
/** Unexpired create receipts per workspace (Redis counted a lifetime total). */
export const MAX_STUDY_CREATE_RECEIPTS = 100;
/** Measured ceiling for one assembled SQLite row; the platform limit is 2 MB. */
export const MAX_ROW_BYTES = 1_900_000;

const encoder = new TextEncoder();

export function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

export function isSafeTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_STUDY_REVISION;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isHex64(value: unknown): value is string {
  return typeof value === 'string' && HEX64.test(value);
}

/** Content-free diagnosis of a structurally invalid row; the row is left unchanged. */
export function logCorruptRecord(operation: string): void {
  logRequestEvent({ event: 'workspace.store', reason: 'corrupt-record', operation });
}

export function logStorageFailure(operation: string, error: unknown): void {
  logRequestFailure({ event: 'workspace.store', reason: 'unavailable', operation }, error);
}

// ---------- Study rows ----------

export type StudyRow = {
  id: string;
  config_json: string;
  revision: number;
  created_at: number;
  updated_at: number;
  interview_count: number;
  is_locked: number;
  sample_fixture: number;
};

const STUDY_COLUMNS = 'id, config_json, revision, created_at, updated_at, interview_count, is_locked, sample_fixture';

export function readStudyRow(ws: WorkspaceContext, studyId: string): StudyRow | null {
  const rows = ws.sql.exec<StudyRow>(`SELECT ${STUDY_COLUMNS} FROM studies WHERE id = ?`, studyId).toArray();
  return rows[0] ?? null;
}

/** The public StoredStudy for a row, or null when the row is structurally invalid. */
export function decodeStudyRow(row: StudyRow): StoredStudy | null {
  if (!STUDY_ID.test(row.id) || !isRevision(row.revision)) return null;
  if (!isSafeTime(row.created_at) || !isSafeTime(row.updated_at)) return null;
  if (!Number.isSafeInteger(row.interview_count) || row.interview_count < 0) return null;
  if (row.is_locked !== 0 && row.is_locked !== 1) return null;
  let config: unknown;
  try {
    config = JSON.parse(row.config_json);
  } catch {
    return null;
  }
  if (!isPlainObject(config) || config.id !== row.id) return null;
  return {
    id: row.id,
    config: config as unknown as StudyConfig,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    interviewCount: row.interview_count,
    isLocked: row.is_locked === 1,
    revision: row.revision,
  };
}

// ---------- Deletion fences ----------

export type FenceKind = 'study' | 'interview';

/**
 * Whether a deleted id is still fenced. Sample-workspace fences block every
 * writer except the fixture seed, which passes `ignoreSampleFences`.
 */
export function isFenced(
  ws: WorkspaceContext,
  kind: FenceKind,
  targetId: string,
  now: number,
  options: { ignoreSampleFences?: boolean } = {},
): boolean {
  const rows = ws.sql
    .exec<{ sample_fixture: number }>(
      `SELECT sample_fixture FROM deletion_fences WHERE kind = ? AND target_id = ? AND expires_at > ?`,
      kind,
      targetId,
      now,
    )
    .toArray();
  if (rows.length === 0) return false;
  return !(options.ignoreSampleFences && rows[0].sample_fixture === 1);
}

export function writeFence(ws: WorkspaceContext, kind: FenceKind, targetId: string, now: number, sampleFixture: boolean): void {
  ws.sql.exec(
    `INSERT INTO deletion_fences (kind, target_id, deleted_at, expires_at, sample_fixture)
       VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (kind, target_id) DO UPDATE SET
       deleted_at = excluded.deleted_at,
       expires_at = excluded.expires_at,
       sample_fixture = MIN(deletion_fences.sample_fixture, excluded.sample_fixture)`,
    kind,
    targetId,
    now,
    now + DELETION_FENCE_TTL_MS,
    sampleFixture ? 1 : 0,
  );
}

// ---------- Reads ----------

export async function getStudy(ws: WorkspaceContext, input: Rpc.StudyIdInput): Promise<Port.StudyLoadResult> {
  try {
    if (typeof input?.studyId !== 'string') return { status: 'unavailable' };
    return ws.storage.transactionSync((): Port.StudyLoadResult => {
      if (!gate(ws, 'read').ok) return { status: 'unavailable' };
      if (!STUDY_ID.test(input.studyId)) return { status: 'not-found' };
      const row = readStudyRow(ws, input.studyId);
      if (!row) return { status: 'not-found' };
      const study = decodeStudyRow(row);
      if (!study) {
        // Redis asStoredStudy parity: an undecodable study reads as absent.
        logCorruptRecord('getStudy');
        return { status: 'not-found' };
      }
      return { status: 'found', study };
    });
  } catch (error) {
    logStorageFailure('getStudy', error);
    return { status: 'unavailable' };
  }
}

export async function listStudies(
  ws: WorkspaceContext,
  input: Rpc.MaximumInput,
): Promise<Port.CollectionLoadResult<Rpc.StoredStudy>> {
  try {
    const maximum = input?.maximum;
    if (typeof maximum !== 'number' || !Number.isSafeInteger(maximum) || maximum < 0) return { status: 'unavailable' };
    return ws.storage.transactionSync((): Port.CollectionLoadResult<Rpc.StoredStudy> => {
      if (!gate(ws, 'read').ok) return { status: 'unavailable' };
      const count = ws.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM studies`).one().n;
      if (count > maximum) return { status: 'too-large', count, maximum };
      const rows = ws.sql
        .exec<StudyRow>(`SELECT ${STUDY_COLUMNS} FROM studies ORDER BY created_at DESC, id DESC`)
        .toArray();
      const items: StoredStudy[] = [];
      for (const row of rows) {
        const study = decodeStudyRow(row);
        if (study) items.push(study);
      }
      // Redis parity: undecodable members are dropped from the collection.
      if (items.length !== rows.length) logCorruptRecord('listStudies');
      return { status: 'ok', items };
    });
  } catch (error) {
    logStorageFailure('listStudies', error);
    return { status: 'unavailable' };
  }
}

// ---------- Create (idempotent, receipt-backed) ----------

function isValidCandidate(candidate: unknown): candidate is StoredStudy {
  if (!isPlainObject(candidate)) return false;
  return typeof candidate.id === 'string'
    && STUDY_ID.test(candidate.id)
    && isPlainObject(candidate.config)
    && candidate.config.id === candidate.id
    && candidate.revision === 1
    && candidate.interviewCount === 0
    && candidate.isLocked === false
    && isSafeTime(candidate.createdAt)
    && isSafeTime(candidate.updatedAt);
}

type ReceiptRow = {
  fingerprint: string;
  target_id: string | null;
  disposition: string;
  result_json: string | null;
  expires_at: number;
};

export async function createStudy(ws: WorkspaceContext, input: Port.CreateStudyInput): Promise<Port.CreateStudyOutcome> {
  try {
    if (!isHex64(input?.idempotencyKeyDigest) || !isHex64(input.fingerprint) || !isValidCandidate(input.candidate)) {
      return { status: 'unavailable' };
    }
    const candidate = input.candidate;
    const configJson = JSON.stringify(candidate.config);
    const resultJson = JSON.stringify(candidate);
    if (utf8Bytes(resultJson) + utf8Bytes(configJson) > MAX_ROW_BYTES) return { status: 'unavailable' };
    const now = Date.now();

    return ws.storage.transactionSync((): Port.CreateStudyOutcome => {
      const checked = gate(ws, 'researcher-mutation');
      if (!checked.ok) return { status: 'held', reason: checked.reason };

      const receipt = ws.sql
        .exec<ReceiptRow>(
          `SELECT fingerprint, target_id, disposition, result_json, expires_at
             FROM idempotency_receipts WHERE operation_family = ? AND key_digest = ?`,
          STUDY_CREATE_FAMILY,
          input.idempotencyKeyDigest,
        )
        .toArray()[0];
      if (receipt && receipt.expires_at > now) {
        if (receipt.fingerprint !== input.fingerprint) return { status: 'key-reuse' };
        if (receipt.disposition !== 'created' || receipt.target_id === null) return { status: 'key-consumed' };
        if (!readStudyRow(ws, receipt.target_id)) return { status: 'key-consumed' };
        let original: unknown;
        try {
          original = JSON.parse(receipt.result_json ?? '');
        } catch {
          original = null;
        }
        if (!isValidCandidate(original) || original.id !== receipt.target_id) {
          logCorruptRecord('createStudy');
          return { status: 'unavailable' };
        }
        return { status: 'created', study: original, replayed: true };
      }
      if (receipt) {
        // An expired receipt no longer binds its key; clear it so the key's
        // primary-key slot can hold the new receipt.
        ws.sql.exec(
          `DELETE FROM idempotency_receipts WHERE operation_family = ? AND key_digest = ?`,
          STUDY_CREATE_FAMILY,
          input.idempotencyKeyDigest,
        );
      }

      const live = ws.sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM idempotency_receipts WHERE operation_family = ? AND expires_at > ?`,
          STUDY_CREATE_FAMILY,
          now,
        )
        .one().n;
      if (live >= MAX_STUDY_CREATE_RECEIPTS) return { status: 'quota' };
      if (isFenced(ws, 'study', candidate.id, now)) return { status: 'conflict' };
      if (readStudyRow(ws, candidate.id)) return { status: 'conflict' };

      ws.sql.exec(
        `INSERT INTO studies (id, config_json, revision, created_at, updated_at, interview_count, is_locked, sample_fixture)
         VALUES (?, ?, ?, ?, ?, 0, 0, 0)`,
        candidate.id,
        configJson,
        candidate.revision,
        candidate.createdAt,
        candidate.updatedAt,
      );
      ws.sql.exec(
        `INSERT INTO idempotency_receipts
           (operation_family, key_digest, fingerprint, target_id, disposition, result_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, 'created', ?, ?, ?)`,
        STUDY_CREATE_FAMILY,
        input.idempotencyKeyDigest,
        input.fingerprint,
        candidate.id,
        resultJson,
        now,
        now + RECEIPT_TTL_MS,
      );
      return { status: 'created', study: candidate, replayed: false };
    });
  } catch (error) {
    logStorageFailure('createStudy', error);
    return { status: 'unavailable' };
  }
}

// ---------- Revision-bumping mutations ----------

function mutateStudy(
  ws: WorkspaceContext,
  operation: string,
  studyId: string,
  now: number,
  change: (study: StoredStudy) => { config: StudyConfig } | Port.StudyMutationOutcome,
): Port.StudyMutationOutcome {
  return ws.storage.transactionSync((): Port.StudyMutationOutcome => {
    const checked = gate(ws, 'researcher-mutation');
    if (!checked.ok) return { status: 'held', reason: checked.reason };
    const row = readStudyRow(ws, studyId);
    if (!row) return { status: 'not-found' };
    const study = decodeStudyRow(row);
    if (!study) {
      logCorruptRecord(operation);
      return { status: 'unavailable' };
    }
    const changed = change(study);
    if ('status' in changed) return changed;
    const revision = study.revision + 1;
    if (!isRevision(revision)) return { status: 'unavailable' };
    const configJson = JSON.stringify(changed.config);
    if (utf8Bytes(configJson) > MAX_ROW_BYTES) return { status: 'unavailable' };
    ws.sql.exec(
      `UPDATE studies SET config_json = ?, revision = ?, updated_at = ? WHERE id = ?`,
      configJson,
      revision,
      now,
      studyId,
    );
    return {
      status: 'updated',
      study: { ...study, config: changed.config, revision, updatedAt: now },
    };
  });
}

export async function replaceStudyConfig(
  ws: WorkspaceContext,
  input: Rpc.ReplaceStudyConfigInput,
): Promise<Port.StudyMutationOutcome> {
  try {
    if (
      typeof input?.studyId !== 'string'
      || !STUDY_ID.test(input.studyId)
      || !isRevision(input.expectedRevision)
      || !isSafeTime(input.now)
      || !isPlainObject(input.config)
      || input.config.id !== input.studyId
    ) {
      return { status: 'unavailable' };
    }
    return mutateStudy(ws, 'replaceStudyConfig', input.studyId, input.now, (study) =>
      study.revision !== input.expectedRevision ? { status: 'conflict' } : { config: input.config },
    );
  } catch (error) {
    logStorageFailure('replaceStudyConfig', error);
    return { status: 'unavailable' };
  }
}

/** Toggling links advances the revision, so existing links and sessions lapse. */
export async function setStudyLinksEnabled(
  ws: WorkspaceContext,
  input: Rpc.SetLinksEnabledInput,
): Promise<Port.StudyMutationOutcome> {
  try {
    if (
      typeof input?.studyId !== 'string'
      || !STUDY_ID.test(input.studyId)
      || typeof input.enabled !== 'boolean'
      || !isSafeTime(input.now)
    ) {
      return { status: 'unavailable' };
    }
    return mutateStudy(ws, 'setStudyLinksEnabled', input.studyId, input.now, (study) => ({
      config: { ...study.config, linksEnabled: input.enabled },
    }));
  } catch (error) {
    logStorageFailure('setStudyLinksEnabled', error);
    return { status: 'unavailable' };
  }
}

// ---------- Delete ----------

export async function deleteStudy(ws: WorkspaceContext, input: Rpc.DeleteStudyInput): Promise<Port.DeleteStudyOutcome> {
  try {
    if (typeof input?.studyId !== 'string' || !STUDY_ID.test(input.studyId) || !isSafeTime(input.now)) {
      return { status: 'unavailable', success: false, error: 'Failed to delete study' };
    }
    const { studyId, now } = input;
    return ws.storage.transactionSync((): Port.DeleteStudyOutcome => {
      const checked = gate(ws, 'researcher-mutation');
      if (!checked.ok) return { status: 'held', reason: checked.reason, success: false };
      // Unlike the Redis script, a refused delete writes nothing, so it can
      // never leave a guard that blocks later saves or edits.
      const interviews = ws.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM interviews WHERE study_id = ?`, studyId)
        .one().n;
      if (interviews > 0) {
        return { status: 'conflict', success: false, error: 'Cannot delete study with existing interviews' };
      }
      // Deleting an unknown id succeeds, as it does on Redis.
      if (!readStudyRow(ws, studyId)) return { status: 'deleted', success: true };

      // With no interviews there are no analysis jobs to cancel: jobs belong
      // to interviews, and populated deletion is refused above.
      ws.sql.exec(`DELETE FROM studies WHERE id = ?`, studyId);
      ws.sql.exec(`DELETE FROM aggregates WHERE study_id = ?`, studyId);
      ws.sql.exec(`DELETE FROM participant_links WHERE study_id = ?`, studyId);
      ws.sql.exec(`DELETE FROM consents WHERE study_id = ?`, studyId);
      writeFence(ws, 'study', studyId, now, false);
      ws.sql.exec(
        `UPDATE idempotency_receipts SET disposition = 'deleted' WHERE operation_family = ? AND target_id = ?`,
        STUDY_CREATE_FAMILY,
        studyId,
      );
      bumpMutationSeq(ws.sql, now);
      return { status: 'deleted', success: true };
    });
  } catch (error) {
    logStorageFailure('deleteStudy', error);
    return { status: 'unavailable', success: false, error: 'Failed to delete study' };
  }
}
