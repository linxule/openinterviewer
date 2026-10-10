// @vitest-environment node
// In-process SQL/domain regression, not a replacement for the workerd lane.
// Uses production migrations and domain functions; no sockets or credentials.
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
// Runtime imports keep Worker-only ambient types out of the Next TypeScript graph.
const { applyMigrations } = await vi.importActual<{
  applyMigrations(storage: unknown, migrations?: unknown): unknown;
}>('../../cloudflare/workspace/migrate');
import { MIGRATIONS } from '../../cloudflare/workspace/schema';
import type { ProjectsStorePort } from '@/lib/projects/types';
const { createProjectsStore } = await vi.importActual<{
  createProjectsStore(ws: unknown): ProjectsStorePort;
}>('../../cloudflare/workspace/projects');
const { importBackupChunk } = await vi.importActual<{
  importBackupChunk(ws: unknown, input: unknown): Promise<{ status: string }>;
}>('../../cloudflare/workspace/operator');
import { BackupWriter, backupFamiliesForVersion, importManifestOf } from '@/lib/backup/format';

const workspaceId = 'ws_' + 'a'.repeat(32), epoch = 'ep_' + 'b'.repeat(32), oldEpoch = 'ep_' + 'c'.repeat(32);
let db: DatabaseSync;
let ws: ReturnType<typeof fixture>;
function fixture() {
  db = new DatabaseSync(':memory:');
  const sql = { exec(query: string, ...bindings: SQLInputValue[]) {
    const rows = db.prepare(query).all(...bindings);
    const changes = db.prepare('SELECT changes() AS n').get()!.n;
    return { toArray: () => rows, one: () => {
      if (rows.length !== 1) throw new Error('Expected one row');
      return rows[0];
    }, rowsWritten: Number(changes) };
  } };
  const storage = { sql, transactionSync<T>(run: () => T): T {
    db.exec('BEGIN');
    try { const result = run(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  } };
  expect(applyMigrations(storage)).toMatchObject({ status: 'ready', applied: [1, 2, 3] });
  sql.exec('INSERT INTO workspace_meta VALUES (1, ?, ?, ?, 0, 0, 1, 1)', workspaceId, epoch, 'open');
  return { sql, storage, env: { WORKSPACE_ID: workspaceId, ANALYSIS_RECOVERY_EPOCH: epoch }, objectName: workspaceId };
}
beforeEach(() => { ws = fixture(); });
afterEach(() => db.close());
function seedStudy(id = 's') { ws.sql.exec('INSERT INTO studies VALUES (?, ?, 1, 1, 1, 0, 0, 0)', id, JSON.stringify({ id })); }
async function create() {
  const p = await createProjectsStore(ws).create({ name: '  Research 🙂  ' });
  if (p.status !== 'created') throw new Error('create failed');
  return p.project;
}
it('executes project lifecycle against SQLite with study bytes and no-op sequence preserved', async () => {
  seedStudy();
  const store = createProjectsStore(ws), p = await create();
  const before = ws.sql.exec('SELECT * FROM studies').toArray();
  await store.assignStudy({ studyId: 's', projectId: p.id });
  const seq = ws.sql.exec('SELECT mutation_seq FROM workspace_meta').one();
  expect(await store.assignStudy({ studyId: 's', projectId: p.id })).toEqual({ status: 'assigned', studyId: 's', projectId: p.id });
  expect(await store.rename({ projectId: p.id, name: p.name })).toEqual({ status: 'updated', project: p });
  expect(ws.sql.exec('SELECT mutation_seq FROM workspace_meta').one()).toEqual(seq);
  expect(await store.read({ projectId: p.id })).toEqual({ status: 'found', project: p, studyIds: ['s'] });
  expect(await store.delete({ projectId: p.id })).toEqual({ status: 'deleted' });
  expect(await store.delete({ projectId: p.id })).toEqual({ status: 'deleted' });
  expect(ws.sql.exec('SELECT * FROM study_projects').toArray()).toEqual([]);
  expect(ws.sql.exec('SELECT * FROM studies').toArray()).toEqual(before);
});
it('rolls back all project-delete statements and sequence on a mid-transaction error', async () => {
  seedStudy();
  const store = createProjectsStore(ws), p = await create();
  await store.assignStudy({ studyId: 's', projectId: p.id });
  const seq = ws.sql.exec('SELECT mutation_seq FROM workspace_meta').one();
  ws.sql.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT, 'test cut'); END");
  expect(await store.delete({ projectId: p.id })).toEqual({ status: 'unavailable' });
  expect(await store.read({ projectId: p.id })).toEqual({ status: 'found', project: p, studyIds: ['s'] });
  expect(ws.sql.exec('SELECT mutation_seq FROM workspace_meta').one()).toEqual(seq);
});
it('fences assignment and all-member deletion, and enforces maintenance', async () => {
  seedStudy();
  const store = createProjectsStore(ws), p = await create();
  await store.assignStudy({ studyId: 's', projectId: p.id });
  ws.sql.exec("INSERT INTO deletion_fences VALUES ('study', 's', 1, ?, 0)", Date.now() + 100_000);
  expect(await store.assignStudy({ studyId: 's', projectId: null })).toEqual({ status: 'persist-guard' });
  expect(await store.delete({ projectId: p.id })).toEqual({ status: 'persist-guard' });
  ws.sql.exec("UPDATE workspace_meta SET maintenance_state = 'frozen'");
  expect((await store.list()).status).toBe('ok');
  expect(await store.create({ name: 'Held' })).toEqual({ status: 'held', reason: 'maintenance' });
});
it('actual schema3 refuses the schema2 runner; interrupted migration3 leaves neither table nor ledger', () => {
  expect(applyMigrations(ws.storage, MIGRATIONS.slice(0, 2))).toEqual({ status: 'schema-unsupported', storedVersion: 3, reason: 'newer-incompatible' });
  ws.sql.exec('DROP TABLE study_projects'); ws.sql.exec('DROP TABLE projects'); ws.sql.exec('DELETE FROM schema_migrations WHERE version = 3');
  expect(() => applyMigrations(ws.storage, [...MIGRATIONS.slice(0, 2), {
    ...MIGRATIONS[2], statements: [...MIGRATIONS[2].statements, 'INSERT INTO missing_table VALUES (1)'],
  }])).toThrow();
  expect(ws.sql.exec("SELECT name FROM sqlite_master WHERE name IN ('projects', 'study_projects')").toArray()).toEqual([]);
  expect(applyMigrations(ws.storage)).toMatchObject({ status: 'ready', applied: [3] });
});
it.each([1, 2, 3] as const)('imports truthful format%s with exactly the legacy empty-family expectations', async version => {
  ws.sql.exec("UPDATE workspace_meta SET maintenance_state = 'recovery'");
  const watermark = { maintenanceVersion: 0, mutationSeq: 0 };
  const writer = new BackupWriter({ schemaVersion: 3, sourceWorkspaceId: workspaceId, exportedAt: 10, watermark });
  const meta = await writer.chunk('workspace_meta', [{ singleton: 1, workspace_id: workspaceId, activated_epoch: oldEpoch,
    maintenance_state: 'frozen', maintenance_version: 0, mutation_seq: 0, created_at: 1, updated_at: 1 }], watermark);
  const current = (await writer.finish()).manifest.manifest;
  const manifest = { ...current, formatVersion: version, schemaVersion: version,
    families: current.families.filter(f => backupFamiliesForVersion(version)!.includes(f.name)) };
  expect(await importBackupChunk(ws, { manifest: importManifestOf(manifest), chunk: meta, now: 10 })).toMatchObject({ status: 'accepted' });
  expect(await importBackupChunk(ws, { manifest: importManifestOf(manifest), chunk: null, finalize: true, now: 10 })).toMatchObject({ status: 'finalized' });
  expect(ws.sql.exec('SELECT * FROM projects').toArray()).toEqual([]);
  expect(ws.sql.exec('SELECT * FROM study_projects').toArray()).toEqual([]);
});
