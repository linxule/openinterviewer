// Operational backup export/import and restore activation in the real
// WorkspaceStore (OPS-02, OPS-03 local parts, ST-10, JOB-10). Tests in this
// file run in order and share one object: a synthetic source workspace is
// backed up, the object's storage is wiped to a pristine installation, and
// the backup is imported into it.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { reset, runInDurableObject } from 'cloudflare:test';
import {
  BACKUP_FAMILIES,
  BACKUP_FAMILY_NAMES,
  BackupWriter,
  chunkChecksum,
  encodeBackupRecord,
  importManifestOf,
  validateBackupLines,
  type BackupChunkRecord,
  type BackupManifest,
  type BackupRecord,
} from '../../src/lib/backup/format';
import { EXPORT_SNAPSHOT_PREFIX } from '../../cloudflare/workspace/exports';
import { testEnv, workspaceStub } from './helpers';

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const OLD_EPOCH = `ep_${'0'.repeat(31)}e`;
const PAST = NOW - 30 * DAY;
const FUTURE = NOW + 30 * DAY;
const CONTENT_MARKER = 'synthetic-participant-speech-b7e2';

type Sql = SqlStorage;
type Row = Record<string, string | number | null>;

async function withSql<T>(run: (sql: Sql) => T): Promise<T> {
  return runInDurableObject(workspaceStub(), (_instance, state) => run(state.storage.sql));
}

function familyRows(sql: Sql): Record<string, Row[]> {
  const out: Record<string, Row[]> = {};
  for (const family of BACKUP_FAMILIES) {
    out[family.name] = sql
      .exec<Row>(`SELECT ${family.columns.map((column) => column.name).join(', ')} FROM ${family.name} ORDER BY ${family.key.join(', ')}`)
      .toArray();
  }
  return out;
}

function insert(sql: Sql, table: string, row: Row): void {
  const columns = Object.keys(row);
  sql.exec(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, ...columns.map((column) => row[column]));
}

function interviewRecord(id: string, studyId: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id, studyId, studyName: 'Étude — 研究', participantProfile: { id: `p-${id}`, fields: [], rawContext: '', timestamp: NOW },
    transcript: [{ id: 'm-1', role: 'user', content: CONTENT_MARKER, timestamp: NOW }], synthesis: null,
    behaviorData: { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] },
    createdAt: NOW, completedAt: NOW + 1_000, status: 'completed', ...extra,
  });
}

/** A representative restored-source workspace: every family, Unicode, empty shapes, expired and live lifetimes. */
function seedSource(sql: Sql): void {
  const frozen = JSON.stringify({ inputSchemaVersion: 1, studyConfig: { id: 's-1' }, studyRevision: 2, requestedProvider: 'openai', requestedModel: 'gpt-fixture' });
  for (const id of ['s-1', 's-2']) {
    insert(sql, 'studies', {
      id, config_json: JSON.stringify({ id, name: `Étude ${id} — 研究 🙂`, coreQuestions: [], profileSchema: [], topicAreas: [] }),
      revision: 2, created_at: NOW - DAY, updated_at: NOW, interview_count: id === 's-1' ? 2 : 1, is_locked: 1, sample_fixture: 0,
    });
  }
  insert(sql, 'interviews', { id: 'iv-1', study_id: 's-1', record_json: interviewRecord('iv-1', 's-1', { studyRevision: 2 }), fingerprint: 'a'.repeat(64), created_at: NOW, completed_at: NOW + 1_000, participant_session_id: 'sess-1', link_id: 'l'.repeat(64), sample_fixture: 0, study_revision: 2 });
  insert(sql, 'interviews', { id: 'iv-2', study_id: 's-1', record_json: interviewRecord('iv-2', 's-1', { studyRevision: 2 }), fingerprint: 'b'.repeat(64), created_at: NOW + 1, completed_at: NOW + 1_001, participant_session_id: null, link_id: null, sample_fixture: 0, study_revision: 2 });
  insert(sql, 'interviews', { id: 'iv-3', study_id: 's-2', record_json: interviewRecord('iv-3', 's-2', { synthesis: { statedPreferences: [], revealedPreferences: [], themes: [], contradictions: [], keyInsights: [], bottomLine: 'legacy' } }), fingerprint: 'c'.repeat(64), created_at: NOW + 2, completed_at: NOW + 1_002, participant_session_id: null, link_id: null, sample_fixture: 0, study_revision: null });
  insert(sql, 'analysis', { interview_id: 'iv-1', status: 'complete', current_generation: 1, attempts: 1, last_attempt_at: NOW, failure_kind: null, recovery_required: 0, study_revision: 2, synthesis_json: '{"statedPreferences":[],"revealedPreferences":[],"themes":[],"contradictions":[],"keyInsights":["ü"],"bottomLine":"done"}', provenance_json: '{"aiProvider":"openai","aiModel":"gpt-fixture-2026","requestedAiModel":"gpt-fixture"}', updated_at: NOW });
  insert(sql, 'analysis', { interview_id: 'iv-2', status: 'pending', current_generation: 1, attempts: 0, last_attempt_at: NOW, failure_kind: null, recovery_required: 0, study_revision: null, synthesis_json: null, provenance_json: null, updated_at: NOW });
  const job = { input_json: frozen, requested_provider: 'openai', requested_model: 'gpt-fixture', allocated_at: NOW, updated_at: NOW, recovery_epoch: OLD_EPOCH, generation: 1 };
  insert(sql, 'analysis_jobs', { ...job, job_id: '00000000-0000-4000-8000-000000000001', interview_id: 'iv-1', state: 'complete', dispatch_state: 'none', dispatch_attempts: 1, next_due_at: null, claim_nonce: 'n-1', claimed_at: NOW, claim_expires_at: NOW + 180_000, started_at: NOW, terminal_at: NOW, failure_kind: null, terminal_receipt_json: '{"claimNonce":"n-1","state":"complete","at":1}' });
  insert(sql, 'analysis_jobs', { ...job, job_id: '00000000-0000-4000-8000-000000000002', interview_id: 'iv-2', state: 'pending', dispatch_state: 'sent', dispatch_attempts: 2, next_due_at: PAST, claim_nonce: null, claimed_at: null, claim_expires_at: null, started_at: null, terminal_at: null, failure_kind: null, terminal_receipt_json: null });
  insert(sql, 'aggregates', { study_id: 's-1', aggregate_json: JSON.stringify({ studyId: 's-1', studyRevision: 2, interviewIds: ['iv-1'], interviewCount: 1, aiProvider: 'openai', aiModel: 'gpt-fixture', commonThemes: [], divergentViews: [], keyFindings: [], researchImplications: [], bottomLine: '研究', generatedAt: NOW, savedAt: NOW }), saved_at: NOW });
  insert(sql, 'participant_links', { id: '1'.repeat(64), study_id: 's-1', study_revision: 2, created_at: NOW - 2 * DAY, expires_at: PAST, revoked_at: null });
  insert(sql, 'participant_links', { id: '2'.repeat(64), study_id: 's-1', study_revision: 1, created_at: NOW - 2 * DAY, expires_at: FUTURE, revoked_at: NOW - DAY });
  insert(sql, 'participant_links', { id: '3'.repeat(64), study_id: 's-2', study_revision: 2, created_at: NOW, expires_at: null, revoked_at: null });
  insert(sql, 'consents', { session_digest: 'd'.repeat(64), study_id: 's-1', record_json: '{"version":1,"acceptedAt":1}', expires_at: PAST });
  insert(sql, 'consents', { session_digest: 'e'.repeat(64), study_id: 's-2', record_json: '{"version":1,"acceptedAt":2}', expires_at: FUTURE });
  insert(sql, 'idempotency_receipts', { operation_family: 'study-create', key_digest: 'f'.repeat(64), fingerprint: '0'.repeat(64), target_id: 's-1', disposition: 'created', result_json: '{}', created_at: NOW, expires_at: FUTURE });
  insert(sql, 'idempotency_receipts', { operation_family: 'analysis-retry', key_digest: '9'.repeat(64), fingerprint: '8'.repeat(64), target_id: null, disposition: 'deleted', result_json: null, created_at: PAST, expires_at: PAST + 7 * DAY });
  insert(sql, 'budget_windows', { scope_key: '7'.repeat(64), count: 3, window_seconds: 3600, expires_at: FUTURE });
  for (const member of ['m-1', 'm-2', 'm-3']) insert(sql, 'budget_members', { plan_key: 'plan-a', member, expires_at: FUTURE });
  insert(sql, 'deletion_fences', { kind: 'study', target_id: 's-deleted', deleted_at: NOW - DAY, expires_at: FUTURE, sample_fixture: 0 });
  // The restored source's own deployment epoch, a frozen state and a mutation history.
  sql.exec(`UPDATE workspace_meta SET activated_epoch = ?, maintenance_state = 'frozen', maintenance_version = 5, mutation_seq = 12`, OLD_EPOCH);
}

type BackupPage = { status: string; watermark?: { maintenanceVersion: number; mutationSeq: number }; rows?: Row[]; nextCursor?: string | null; schemaVersion?: number; workspaceId?: string };

/** Pages every family the way the operator CLI does, writing format v1 records. */
async function exportBackup(pageSize: number): Promise<{ lines: string[]; records: BackupRecord[] }> {
  const stub = workspaceStub();
  let writer: BackupWriter | null = null;
  let watermark: { maintenanceVersion: number; mutationSeq: number } | null = null;
  const records: BackupRecord[] = [];
  for (const family of BACKUP_FAMILY_NAMES) {
    let cursor: string | null = null;
    do {
      const page = await stub.exportBackupPage({ watermark, family, cursor, pageSize }) as BackupPage;
      if (page.status !== 'ok') throw new Error(`backup page ${page.status}`);
      watermark = page.watermark!;
      writer ??= new BackupWriter({ schemaVersion: page.schemaVersion!, sourceWorkspaceId: page.workspaceId!, exportedAt: NOW, watermark });
      if (page.rows!.length > 0) records.push(await writer.chunk(family, page.rows!, page.watermark!));
      cursor = page.nextCursor ?? null;
    } while (cursor !== null);
  }
  const { manifest, trailer } = await writer!.finish();
  records.push(manifest, trailer);
  return { records, lines: records.map(encodeBackupRecord) };
}

function chunksOf(records: BackupRecord[]): BackupChunkRecord[] {
  return records.filter((record): record is BackupChunkRecord => record.kind === 'chunk');
}

function manifestOf(records: BackupRecord[]): BackupManifest {
  const found = records.find((record) => record.kind === 'manifest');
  if (!found || found.kind !== 'manifest') throw new Error('no manifest');
  return found.manifest;
}

async function importChunk(manifest: BackupManifest, chunk: BackupChunkRecord | null, finalize = false) {
  return workspaceStub().importBackupChunk({
    manifest: importManifestOf(manifest),
    chunk: chunk ? { family: chunk.family, index: chunk.index, sha256: chunk.sha256, rows: chunk.rows } : null,
    finalize,
    now: Date.now(),
  });
}

async function metaRow() {
  return withSql((sql) => sql.exec<Row>(`SELECT * FROM workspace_meta`).one());
}

async function transition(from: string, to: string) {
  const meta = await metaRow();
  return workspaceStub().transitionMaintenance({
    expectedState: from as 'open', expectedVersion: meta.maintenance_version as number, nextState: to as 'open', now: Date.now(),
  });
}

let sourceRows: Record<string, Row[]>;
let backup: { lines: string[]; records: BackupRecord[] };
const queueSends: unknown[] = [];

beforeAll(() => {
  vi.spyOn(testEnv.ANALYSIS_QUEUE, 'send').mockImplementation(async (body: unknown) => {
    queueSends.push(body);
    return { metadata: {} } as QueueSendResponse;
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('network is not available to backup tests');
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe('operational backup export (OPS-02)', () => {
  it('OPS-02: the closed family list covers every authoritative table and column of the live schema', async () => {
    const schema = await withSql((sql) => {
      const tables = sql
        .exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
        .toArray()
        .map((row) => row.name)
        // Platform-internal tables (_cf_*, and __cf_kv behind the KV API).
        .filter((name) => !name.startsWith('sqlite_') && !name.startsWith('_cf_') && !name.startsWith('__cf_'));
      const columns: Record<string, Array<{ name: string; type: string; required: number; pk: number }>> = {};
      for (const table of tables) {
        columns[table] = sql.exec<{ name: string; type: string; required: number; pk: number }>(
          `SELECT name, type, "notnull" AS required, pk FROM pragma_table_info(?) ORDER BY cid`, table,
        ).toArray();
      }
      return { tables, columns };
    });
    // operator_audit belongs to each object; schema_migrations travels as schemaVersion.
    expect(schema.tables.filter((table) => table !== 'operator_audit' && table !== 'schema_migrations').sort())
      .toEqual([...BACKUP_FAMILY_NAMES].sort());
    for (const family of BACKUP_FAMILIES) {
      const live = schema.columns[family.name];
      expect(live.map((column) => column.name), family.name).toEqual(family.columns.map((column) => column.name));
      for (const column of family.columns) {
        const actual = live.find((candidate) => candidate.name === column.name)!;
        expect(actual.type.toLowerCase(), `${family.name}.${column.name}`).toBe(column.type);
        const nullable = actual.required === 0 && actual.pk === 0;
        expect(nullable, `${family.name}.${column.name}`).toBe(column.nullable);
      }
      expect(live.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name)).toEqual([...family.key]);
    }
  });

  it('OPS-02: backup export is refused while the workspace is open or draining', async () => {
    const stub = workspaceStub();
    expect(await stub.exportBackupPage({ watermark: null, family: 'studies', cursor: null, pageSize: 10 })).toEqual({ status: 'not-frozen' });
    await withSql((sql) => sql.exec(`UPDATE workspace_meta SET maintenance_state = 'draining'`));
    expect(await stub.exportBackupPage({ watermark: null, family: 'studies', cursor: null, pageSize: 10 })).toEqual({ status: 'not-frozen' });
    await withSql((sql) => sql.exec(`UPDATE workspace_meta SET maintenance_state = 'open'`));
  });

  it('OPS-02: a frozen workspace exports every family in bounded pages under one watermark, preserving JSON types and absolute expiries', async () => {
    await withSql(seedSource);
    sourceRows = await withSql(familyRows);
    // A researcher export's snapshot bookkeeping lives outside the SQL
    // families (KV) and leaves the backup watermark alone.
    expect(await workspaceStub().beginExport({ maximum: 500 })).toMatchObject({ status: 'ok', count: 3 });
    const kvKeys = await runInDurableObject(workspaceStub(), (_instance, state) => [...state.storage.kv.list()].map(([key]) => key));
    expect(kvKeys.length).toBeGreaterThan(0);
    expect(kvKeys.every((key) => key.startsWith(EXPORT_SNAPSHOT_PREFIX))).toBe(true);
    backup = await exportBackup(2);
    const validation = await validateBackupLines(backup.lines);
    expect(validation.status).toBe('valid');
    if (validation.status !== 'valid') return;
    for (const family of BACKUP_FAMILY_NAMES) {
      expect(validation.counts[family], family).toBe(sourceRows[family].length);
    }
    expect(validation.manifest).toMatchObject({ schemaVersion: 1, sourceWorkspaceId: testEnv.WORKSPACE_ID, watermark: { maintenanceVersion: 5, mutationSeq: 12 } });
    expect(manifestOf(backup.records).families.find((family) => family.name === 'budget_members')!.chunks).toHaveLength(2);
    const links = chunksOf(backup.records).filter((chunk) => chunk.family === 'participant_links').flatMap((chunk) => chunk.rows);
    expect(links.map((row) => row.expires_at)).toEqual([PAST, FUTURE, null]);
    const text = backup.lines.join('\n');
    expect(text).not.toMatch(/SESSION_SECRET|ADMIN_PASSWORD|sk-synthetic|synthetic-session-secret|synthetic-rate-limit-salt/);
  });

  it('OPS-02: a watermark change between pages is detected (mutation sequence or maintenance version)', async () => {
    const stub = workspaceStub();
    const first = await stub.exportBackupPage({ watermark: null, family: 'studies', cursor: null, pageSize: 1 }) as BackupPage;
    expect(first).toMatchObject({ status: 'ok', watermark: { maintenanceVersion: 5, mutationSeq: 12 } });
    await withSql((sql) => sql.exec(`UPDATE workspace_meta SET mutation_seq = mutation_seq + 1`));
    expect(await stub.exportBackupPage({ watermark: first.watermark!, family: 'studies', cursor: first.nextCursor!, pageSize: 1 }))
      .toEqual({ status: 'watermark-changed' });
    await withSql((sql) => sql.exec(`UPDATE workspace_meta SET mutation_seq = 12`));

    // Entering recovery (the only transition under the source's old epoch) moves the maintenance version.
    expect(await transition('frozen', 'recovery')).toMatchObject({ status: 'transitioned', state: 'recovery', version: 6 });
    expect(await stub.exportBackupPage({ watermark: first.watermark!, family: 'studies', cursor: first.nextCursor!, pageSize: 1 }))
      .toEqual({ status: 'watermark-changed' });
    // A new backup under recovery captures the new watermark.
    expect(await stub.exportBackupPage({ watermark: null, family: 'studies', cursor: null, pageSize: 1 }))
      .toMatchObject({ status: 'ok', watermark: { maintenanceVersion: 6, mutationSeq: 12 } });
  });
});

describe('operational backup import (ST-10, OPS-02)', () => {
  it('ST-10: import refuses a populated workspace and a workspace outside recovery', async () => {
    const manifest = manifestOf(backup.records);
    const meta = chunksOf(backup.records)[0];
    expect(await importChunk(manifest, meta)).toEqual({ status: 'not-empty' });

    // A pristine installation of the same deployment (bootstrap: open).
    await reset();
    expect(await workspaceStub().readiness()).toEqual({ status: 'ready', maintenance: 'open' });
    expect(await importChunk(manifest, meta)).toEqual({ status: 'not-recovery' });
    expect(await transition('open', 'recovery')).toMatchObject({ status: 'transitioned', state: 'recovery' });
  });

  it('ST-10: import rejects out-of-order, corrupt and malformed chunks with counts and an error class only', async () => {
    const manifest = manifestOf(backup.records);
    const chunks = chunksOf(backup.records);
    const studies = chunks.find((chunk) => chunk.family === 'studies')!;
    expect(await importChunk(manifest, studies)).toEqual({ status: 'rejected', errorClass: 'family-order' });

    expect(await importChunk(manifest, chunks[0])).toEqual({ status: 'accepted', family: 'workspace_meta', index: 0, duplicate: false });
    expect(await importChunk(manifest, chunks[0])).toEqual({ status: 'accepted', family: 'workspace_meta', index: 0, duplicate: true });

    const tampered = { ...studies, rows: studies.rows.map((row, index) => (index === 0 ? { ...row, revision: 3 } : row)) };
    const corrupt = await importChunk(manifest, tampered);
    expect(corrupt).toEqual({ status: 'rejected', errorClass: 'checksum-mismatch', counts: { rows: studies.rows.length } });

    const extraRows = studies.rows.map((row) => ({ ...row, api_key: 'x' }));
    const extra = await importChunk(manifest, { ...studies, rows: extraRows, sha256: await chunkChecksum(extraRows) });
    expect(extra).toEqual({ status: 'rejected', errorClass: 'row-invalid', counts: { rows: studies.rows.length, invalid: studies.rows.length } });

    const misidentified = studies.rows.map((row, index) => (index === 0 ? { ...row, config_json: JSON.stringify({ id: 'someone-else' }) } : row));
    expect(await importChunk(manifest, { ...studies, rows: misidentified, sha256: await chunkChecksum(misidentified) }))
      .toEqual({ status: 'rejected', errorClass: 'row-invalid', counts: { rows: studies.rows.length, invalid: 1 } });

    // Valid rows the manifest does not describe at (family, index) are refused.
    const undescribed = studies.rows.map((row, index) => (index === 1 ? { ...row, revision: 7 } : row));
    expect(await importChunk(manifest, { ...studies, rows: undescribed, sha256: await chunkChecksum(undescribed) }))
      .toEqual({ status: 'rejected', errorClass: 'checksum-mismatch', counts: { rows: studies.rows.length } });
    expect(await importChunk(manifest, { ...studies, index: 5 }))
      .toEqual({ status: 'rejected', errorClass: 'chunk-unexpected', counts: { rows: studies.rows.length } });

    // A different backup (here: another export time) is a different import identity.
    expect(await importChunk({ ...manifest, exportedAt: manifest.exportedAt + 1 }, studies)).toEqual({ status: 'rejected', errorClass: 'manifest-mismatch' });
    // The request must carry the complete manifest, not a subset of it.
    const { families: _families, watermark: _watermark, exportedAt: _exportedAt, ...subset } = importManifestOf(manifest);
    expect(await workspaceStub().importBackupChunk({ manifest: subset, chunk: null, finalize: true, now: Date.now() }))
      .toEqual({ status: 'rejected', errorClass: 'manifest-invalid' });

    const early = await importChunk(manifest, null, true);
    expect(early).toEqual({ status: 'rejected', errorClass: 'chunk-missing', counts: { 'studies.chunks': 0, 'studies.expected': 1 } });
    for (const outcome of [corrupt, extra, early]) expect(JSON.stringify(outcome)).not.toMatch(/Étude|研究|s-1|CONTENT|speech/);

    // Nothing from the rejected chunks was written; activation waits for the import.
    expect(await withSql((sql) => sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM studies`).one().n)).toBe(0);
    expect(await workspaceStub().activateRecoveryEpoch({ expectedActivatedEpoch: OLD_EPOCH, now: Date.now() })).toEqual({ status: 'conflict' });
  });

  it('ST-10: import reproduces counts, checksums, references and original expiries; duplicate chunks are idempotent', async () => {
    const manifest = manifestOf(backup.records);
    for (const chunk of chunksOf(backup.records).slice(1)) {
      expect(await importChunk(manifest, chunk)).toEqual({ status: 'accepted', family: chunk.family, index: chunk.index, duplicate: false });
    }
    // A resumed import replays chunks it already sent.
    for (const chunk of chunksOf(backup.records)) {
      expect(await importChunk(manifest, chunk)).toMatchObject({ status: 'accepted', duplicate: true });
    }
    const counts = Object.fromEntries(manifest.families.map((family) => [family.name, family.count]));
    expect(await importChunk(manifest, null, true)).toEqual({ status: 'finalized', counts });
    expect(await importChunk(manifest, null, true)).toEqual({ status: 'finalized', counts });

    const restored = await withSql(familyRows);
    for (const family of BACKUP_FAMILY_NAMES.filter((name) => name !== 'workspace_meta')) {
      expect(restored[family], family).toEqual(sourceRows[family]);
    }
    // Lifetimes are copied, never renewed: the expired consent and link stay expired.
    expect(restored.consents.map((row) => row.expires_at)).toEqual([PAST, FUTURE]);
    expect(restored.participant_links.map((row) => row.expires_at)).toEqual([PAST, FUTURE, null]);
    const meta = restored.workspace_meta[0];
    expect(meta).toMatchObject({ workspace_id: testEnv.WORKSPACE_ID, activated_epoch: OLD_EPOCH, maintenance_state: 'recovery' });
    expect(meta.mutation_seq as number).toBeGreaterThan(12);

    // Re-exporting the restored workspace reproduces every family checksum.
    const again = await exportBackup(2);
    expect((await validateBackupLines(again.lines)).status).toBe('valid');
    const original = manifestOf(backup.records).families.filter((family) => family.name !== 'workspace_meta');
    const reproduced = manifestOf(again.records).families.filter((family) => family.name !== 'workspace_meta');
    expect(reproduced).toEqual(original);

    const conflicting = chunksOf(backup.records).find((chunk) => chunk.family === 'consents')!;
    const changedRows = conflicting.rows.map((row) => ({ ...row, expires_at: FUTURE + 1 }));
    expect(await importChunk(manifest, { ...conflicting, rows: changedRows, sha256: await chunkChecksum(changedRows) }))
      .toEqual({ status: 'rejected', errorClass: 'chunk-conflict', counts: { rows: changedRows.length } });
  });

  it('JOB-10/ST-10: imported nonterminal jobs stay held until activation reconciles them to recovery-required', async () => {
    const stub = workspaceStub();
    const envelope = { workspaceId: testEnv.WORKSPACE_ID, interviewId: 'iv-2', jobId: '00000000-0000-4000-8000-000000000002', generation: 1, claimNonce: 'claim-nonce-0123456789', now: Date.now() };
    expect(await stub.claimAnalysisJob({ ...envelope, recoveryEpoch: OLD_EPOCH })).not.toMatchObject({ status: 'claimed' });
    expect(await transition('recovery', 'open')).toEqual({ status: 'held', reason: 'recovery-epoch-mismatch' });
    expect(await withSql((sql) => sql.exec<{ state: string }>(`SELECT state FROM analysis_jobs WHERE interview_id = 'iv-2'`).one().state)).toBe('pending');

    expect(await stub.activateRecoveryEpoch({ expectedActivatedEpoch: OLD_EPOCH, now: Date.now() })).toEqual({ status: 'activated', reconciledJobs: 1 });
    expect(await withSql((sql) => sql
      .exec<Row>(`SELECT state, next_due_at, failure_kind FROM analysis_jobs WHERE interview_id = 'iv-2'`).one()))
      .toEqual({ state: 'recovery-required', next_due_at: null, failure_kind: 'timeout' });
    expect(await stub.readAnalysisStatus({ studyId: 's-1', interviewId: 'iv-2' }))
      .toEqual({ status: 'ok', body: { status: 'failed', generation: 1, failureKind: 'timeout', recoveryRequired: true } });
    expect(await transition('recovery', 'open')).toMatchObject({ status: 'transitioned', state: 'open' });
    for (const epoch of [OLD_EPOCH, testEnv.ANALYSIS_RECOVERY_EPOCH]) {
      expect(await stub.claimAnalysisJob({ ...envelope, recoveryEpoch: epoch, now: Date.now() })).not.toMatchObject({ status: 'claimed' });
    }
    expect(queueSends).toEqual([]);
  });

  it('ST-10: import refuses a backup whose epoch was not rotated, and finalize refuses dangling references', async () => {
    await reset();
    expect(await transition('open', 'recovery')).toMatchObject({ status: 'transitioned' });
    const watermark = { maintenanceVersion: 1, mutationSeq: 1 };
    const metaFor = (epoch: string): Row => ({
      singleton: 1, workspace_id: testEnv.WORKSPACE_ID, activated_epoch: epoch, maintenance_state: 'frozen',
      maintenance_version: 1, mutation_seq: 1, created_at: NOW, updated_at: NOW,
    });

    const sameEpoch = new BackupWriter({ schemaVersion: 1, sourceWorkspaceId: testEnv.WORKSPACE_ID, exportedAt: NOW, watermark });
    const sameEpochMeta = await sameEpoch.chunk('workspace_meta', [metaFor(testEnv.ANALYSIS_RECOVERY_EPOCH)], watermark);
    const sameEpochManifest = (await sameEpoch.finish()).manifest.manifest;
    expect(await importChunk(sameEpochManifest, sameEpochMeta)).toEqual({ status: 'rejected', errorClass: 'epoch-not-rotated' });

    const dangling = new BackupWriter({ schemaVersion: 1, sourceWorkspaceId: testEnv.WORKSPACE_ID, exportedAt: NOW, watermark });
    const danglingMeta = await dangling.chunk('workspace_meta', [metaFor(OLD_EPOCH)], watermark);
    const orphan = await dangling.chunk('interviews', [{
      id: 'iv-orphan', study_id: 's-missing', record_json: interviewRecord('iv-orphan', 's-missing'), fingerprint: 'a'.repeat(64),
      created_at: NOW, completed_at: NOW, participant_session_id: null, link_id: null, sample_fixture: 0, study_revision: null,
    }], watermark);
    const danglingManifest = (await dangling.finish()).manifest.manifest;
    expect(await importChunk(danglingManifest, danglingMeta)).toMatchObject({ status: 'accepted' });
    expect(await importChunk(danglingManifest, orphan)).toMatchObject({ status: 'accepted' });
    expect(await importChunk(danglingManifest, null, true))
      .toEqual({ status: 'rejected', errorClass: 'reference-invalid', counts: { 'interviews.study_id': 1 } });
    expect(await transition('recovery', 'open')).toEqual({ status: 'held', reason: 'recovery-epoch-mismatch' });
  });
  it('OPS-02/ST-10: an import is bound to one backup file; a second backup of the same source cannot be mixed in', async () => {
    await reset();
    expect(await transition('open', 'recovery')).toMatchObject({ status: 'transitioned' });
    const study = { id: 's-mix', config_json: JSON.stringify({ id: 's-mix', name: 'Mix' }), revision: 1, created_at: NOW, updated_at: NOW, interview_count: 0, is_locked: 0, sample_fixture: 0 };
    async function backupAt(mutationSeq: number, consentExpiry: number) {
      const watermark = { maintenanceVersion: 1, mutationSeq };
      const writer = new BackupWriter({ schemaVersion: 1, sourceWorkspaceId: testEnv.WORKSPACE_ID, exportedAt: NOW, watermark });
      const meta = await writer.chunk('workspace_meta', [{
        singleton: 1, workspace_id: testEnv.WORKSPACE_ID, activated_epoch: OLD_EPOCH, maintenance_state: 'frozen',
        maintenance_version: 1, mutation_seq: mutationSeq, created_at: NOW, updated_at: NOW,
      }], watermark);
      const studies = await writer.chunk('studies', [study], watermark);
      const consents = await writer.chunk('consents', [{ session_digest: 'd'.repeat(64), study_id: 's-mix', record_json: '{"version":1}', expires_at: consentExpiry }], watermark);
      return { manifest: (await writer.finish()).manifest.manifest, meta, studies, consents };
    }
    // Equal family counts, different watermarks and consent lifetimes.
    const a = await backupAt(1, PAST);
    const b = await backupAt(2, FUTURE);
    expect(await importChunk(a.manifest, a.meta)).toMatchObject({ status: 'accepted', duplicate: false });

    // Imported rows move the watermark a backup taken in recovery pages under.
    const before = await workspaceStub().exportBackupPage({ watermark: null, family: 'studies', cursor: null, pageSize: 10 }) as BackupPage;
    expect(before.status).toBe('ok');
    expect(await importChunk(a.manifest, a.studies)).toMatchObject({ status: 'accepted', duplicate: false });
    expect(await workspaceStub().exportBackupPage({ watermark: before.watermark!, family: 'studies', cursor: null, pageSize: 10 }))
      .toEqual({ status: 'watermark-changed' });

    // Resuming with the other file: its identity differs, and its chunk is not the one A describes.
    expect(await importChunk(b.manifest, b.consents)).toEqual({ status: 'rejected', errorClass: 'manifest-mismatch' });
    expect(await importChunk(a.manifest, b.consents)).toEqual({ status: 'rejected', errorClass: 'checksum-mismatch', counts: { rows: 1 } });
    expect(await importChunk(a.manifest, null, true))
      .toEqual({ status: 'rejected', errorClass: 'chunk-missing', counts: { 'consents.chunks': 0, 'consents.expected': 1 } });
    expect(await importChunk(a.manifest, a.consents)).toMatchObject({ status: 'accepted', duplicate: false });
    expect(await importChunk(a.manifest, null, true)).toMatchObject({ status: 'finalized' });
    expect(await withSql((sql) => sql.exec<{ expires_at: number }>(`SELECT expires_at FROM consents`).one().expires_at)).toBe(PAST);

    // Activation also moves the watermark, even with no job to reconcile.
    const activated = await workspaceStub().exportBackupPage({ watermark: null, family: 'studies', cursor: null, pageSize: 10 }) as BackupPage;
    expect(await workspaceStub().activateRecoveryEpoch({ expectedActivatedEpoch: OLD_EPOCH, now: Date.now() })).toEqual({ status: 'activated', reconciledJobs: 0 });
    expect(await workspaceStub().exportBackupPage({ watermark: activated.watermark!, family: 'studies', cursor: null, pageSize: 10 }))
      .toEqual({ status: 'watermark-changed' });
  });

  it('ST-10: the source metadata row must match the manifest watermark; oversized rows and SQL constraint violations are refused with counts only', async () => {
    await reset();
    expect(await transition('open', 'recovery')).toMatchObject({ status: 'transitioned' });
    const watermark = { maintenanceVersion: 1, mutationSeq: 1 };
    const metaRow: Row = {
      singleton: 1, workspace_id: testEnv.WORKSPACE_ID, activated_epoch: OLD_EPOCH, maintenance_state: 'frozen',
      maintenance_version: 1, mutation_seq: 1, created_at: NOW, updated_at: NOW,
    };
    const study = (id: string, revision = 1): Row => ({ id, config_json: JSON.stringify({ id, name: 'Size' }), revision, created_at: NOW, updated_at: NOW, interview_count: 0, is_locked: 0, sample_fixture: 0 });
    const writer = new BackupWriter({ schemaVersion: 1, sourceWorkspaceId: testEnv.WORKSPACE_ID, exportedAt: NOW, watermark });
    const meta = await writer.chunk('workspace_meta', [metaRow], watermark);
    const studies = await writer.chunk('studies', [study('s-size')], watermark);
    const zeroRevision = await writer.chunk('studies', [study('s-zero', 0)], watermark);
    const huge = await writer.chunk('interviews', [{
      id: 'iv-huge', study_id: 's-size', record_json: interviewRecord('iv-huge', 's-size', { padding: 'x'.repeat(2_200_000) }),
      fingerprint: 'a'.repeat(64), created_at: NOW, completed_at: NOW, participant_session_id: null, link_id: null, sample_fixture: 0, study_revision: null,
    }], watermark);
    const manifest = (await writer.finish()).manifest.manifest;

    // A metadata row read under another watermark than the manifest declares.
    const drifted = [{ ...metaRow, mutation_seq: 2 }];
    const driftedManifest = structuredClone(manifest);
    driftedManifest.families[0].chunks[0].sha256 = await chunkChecksum(drifted);
    expect(await importChunk(driftedManifest, { ...meta, rows: drifted, sha256: driftedManifest.families[0].chunks[0].sha256 }))
      .toEqual({ status: 'rejected', errorClass: 'watermark-changed' });

    expect(await importChunk(manifest, meta)).toMatchObject({ status: 'accepted' });
    expect(await importChunk(manifest, studies)).toMatchObject({ status: 'accepted' });
    // Rejected by a SQL constraint (revision >= 1): the whole chunk rolls back.
    expect(await importChunk(manifest, zeroRevision)).toEqual({ status: 'rejected', errorClass: 'row-invalid' });
    expect(await withSql((sql) => sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM studies`).one().n)).toBe(1);
    const oversized = await importChunk(manifest, huge);
    expect(oversized).toEqual({ status: 'rejected', errorClass: 'row-too-large', counts: { rows: 1, oversized: 1 } });
    expect(JSON.stringify(oversized)).not.toMatch(/iv-huge|s-size|xxxx/);
    expect(await withSql((sql) => sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM interviews`).one().n)).toBe(0);
  });
});
