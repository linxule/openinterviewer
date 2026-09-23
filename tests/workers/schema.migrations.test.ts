// ST-09 / OPS-03: schema migrations against the real WorkspaceStore SQLite.
// Covers a fresh ledger, an interrupted migration, tampered and gapped
// ledgers, an unsupported future schema, and the N−1 → N → N−1 rollback
// rehearsal with pending and completed jobs. N−1 is this build; N is a
// synthetic migration applied with the production runner.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS, migrationChecksum } from '../../cloudflare/workspace/schema';
import { applyMigrations, type MigrationSpec } from '../../cloudflare/workspace/migrate';
import { createStudyInput, candidateStudy } from './fixtures';
import { testEnv, workspaceStub } from './helpers';
import {
  analysisRow,
  captureQueue,
  deliver,
  installProviderFixture,
  jobRow,
  resetWorkspace,
  seedJob,
  sqlRows,
  type QueueCapture,
} from './jobFixtures';

const N = CURRENT_SCHEMA_VERSION + 1;

/** An additive N that declares this build (N−1) a compatible reader. */
const ADDITIVE_N: MigrationSpec = {
  version: N,
  name: 'synthetic additive migration',
  minReaderVersion: CURRENT_SCHEMA_VERSION,
  statements: [
    'ALTER TABLE analysis_jobs ADD COLUMN st09_priority INTEGER',
    'CREATE TABLE st09_n_only (id TEXT PRIMARY KEY, note TEXT NOT NULL)',
  ],
};

/** An N that older builds must not serve (default reader compatibility). */
const INCOMPATIBLE_N: MigrationSpec = {
  version: N,
  name: 'synthetic incompatible migration',
  statements: ['CREATE TABLE st09_incompatible (id TEXT PRIMARY KEY)'],
};

type Ledger = { version: number; checksum: string; min_reader_version: number };

function ledger(state: DurableObjectState): Ledger[] {
  return state.storage.sql
    .exec<Ledger>('SELECT version, checksum, min_reader_version FROM schema_migrations ORDER BY version')
    .toArray();
}

function tableExists(state: DurableObjectState, name: string): boolean {
  return state.storage.sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, name).toArray().length > 0;
}

/** A second object of the namespace: migrations run, but it never initializes as the workspace. */
function scratchObject(label: string): DurableObjectStub {
  return testEnv.WORKSPACE_STORE.getByName(`st09-scratch-${label}`);
}

async function removeSyntheticSchema(): Promise<void> {
  await runInDurableObject(workspaceStub(), (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec('DELETE FROM schema_migrations WHERE version > ?', CURRENT_SCHEMA_VERSION);
    sql.exec('DROP TABLE IF EXISTS st09_n_only');
    sql.exec('DROP TABLE IF EXISTS st09_incompatible');
    const columns = sql.exec(`SELECT name FROM pragma_table_info('analysis_jobs') WHERE name = 'st09_priority'`).toArray();
    if (columns.length > 0) sql.exec('ALTER TABLE analysis_jobs DROP COLUMN st09_priority');
  });
  await evictDurableObject(workspaceStub());
}

describe('migration runner (ST-09)', () => {
  it('records every applied migration with its checksum and reader compatibility', async () => {
    const rows = await runInDurableObject(scratchObject('fresh'), (_instance, state) => ledger(state));
    expect(rows).toEqual(MIGRATIONS.map((migration) => ({
      version: migration.version,
      checksum: migrationChecksum(migration),
      min_reader_version: migration.version,
    })));
  });

  it('an interrupted migration leaves no partial schema or ledger row and is retried on the next start', async () => {
    const broken: MigrationSpec = {
      version: N,
      name: 'interrupted migration',
      statements: [
        'CREATE TABLE st09_partial (id TEXT PRIMARY KEY)',
        `INSERT INTO st09_partial (id) VALUES ('first')`,
        `INSERT INTO st09_table_that_does_not_exist (id) VALUES ('boom')`,
      ],
    };
    await runInDurableObject(scratchObject('interrupted'), (_instance, state) => {
      expect(() => applyMigrations(state.storage, [...MIGRATIONS, broken])).toThrow();
      expect(tableExists(state, 'st09_partial')).toBe(false);
      expect(ledger(state).map((row) => row.version)).toEqual([CURRENT_SCHEMA_VERSION]);

      const fixed: MigrationSpec = { ...broken, statements: broken.statements.slice(0, 2) };
      expect(applyMigrations(state.storage, [...MIGRATIONS, fixed])).toEqual({ status: 'ready', storedVersion: N, applied: [N] });
      expect(state.storage.sql.exec('SELECT id FROM st09_partial').toArray()).toEqual([{ id: 'first' }]);
      expect(applyMigrations(state.storage, [...MIGRATIONS, fixed])).toEqual({ status: 'ready', storedVersion: N, applied: [] });
    });
  });

  it('refuses a ledger whose checksum differs from this build and applies nothing', async () => {
    await runInDurableObject(scratchObject('checksum'), (_instance, state) => {
      state.storage.sql.exec(`UPDATE schema_migrations SET checksum = 'fnv1a:00000000' WHERE version = 1`);
      expect(applyMigrations(state.storage, [...MIGRATIONS, ADDITIVE_N]))
        .toEqual({ status: 'schema-unsupported', storedVersion: CURRENT_SCHEMA_VERSION, reason: 'checksum-mismatch' });
      expect(tableExists(state, 'st09_n_only')).toBe(false);
    });
  });

  it('refuses a ledger with a gap, even when every newer row claims compatibility', async () => {
    await runInDurableObject(scratchObject('gap'), (_instance, state) => {
      state.storage.sql.exec(
        'INSERT INTO schema_migrations (version, checksum, applied_at, min_reader_version) VALUES (?, ?, 0, 1)',
        N + 1,
        'fnv1a:00000000',
      );
      expect(applyMigrations(state.storage)).toEqual({ status: 'schema-unsupported', storedVersion: N + 1, reason: 'ledger-gap' });
    });
  });

  it('serves a newer schema only when every unknown migration declares this build a compatible reader', async () => {
    await runInDurableObject(scratchObject('newer'), (_instance, state) => {
      expect(applyMigrations(state.storage, [...MIGRATIONS, ADDITIVE_N])).toMatchObject({ status: 'ready', applied: [N] });
      expect(applyMigrations(state.storage, MIGRATIONS)).toEqual({ status: 'ready', storedVersion: N, applied: [] });
      state.storage.sql.exec('UPDATE schema_migrations SET min_reader_version = ? WHERE version = ?', N, N);
      expect(applyMigrations(state.storage, MIGRATIONS))
        .toEqual({ status: 'schema-unsupported', storedVersion: N, reason: 'newer-incompatible' });
    });
  });
});

describe('WorkspaceStore across schema versions (ST-09, OPS-03)', () => {
  let queue: QueueCapture;

  beforeEach(async () => {
    await resetWorkspace();
    queue = captureQueue();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await removeSyntheticSchema();
    expect(await workspaceStub().readiness()).toEqual({ status: 'ready', maintenance: 'open' });
  });

  it('an unsupported future schema refuses readiness, reads, mutations and dispatch, and keeps a wake-up', async () => {
    const job = await seedJob({ provider: 'openai' });
    await runInDurableObject(workspaceStub(), (_instance, state) => {
      expect(applyMigrations(state.storage, [...MIGRATIONS, INCOMPATIBLE_N])).toMatchObject({ status: 'ready', applied: [N] });
    });
    await evictDurableObject(workspaceStub());

    const stub = workspaceStub();
    expect(await stub.readiness()).toEqual({ status: 'held', reason: 'schema-unsupported' });
    expect(await stub.getStudy({ studyId: job.studyId })).toEqual({ status: 'unavailable' });
    expect(await stub.createStudy(await createStudyInput(candidateStudy())))
      .toEqual({ status: 'held', reason: 'schema-unsupported' });
    expect(await stub.readAnalysisStatus({ studyId: job.studyId, interviewId: job.interviewId })).toEqual({ status: 'unavailable' });

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(queue.messages).toEqual([]);
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'pending' });
    // The held alarm re-arms itself, so a later compatible build resumes dispatch without a researcher request.
    const alarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
    expect(await sqlRows('SELECT COUNT(*) AS n FROM studies')).toEqual([{ n: 1 }]);
  });

  it('N−1 → N → N−1 → N keeps serving pending and completed jobs and N\'s data', async () => {
    const stub = workspaceStub();
    const provider = installProviderFixture({ kind: 'success' });

    // N−1 (this build): one generation completed, one pending.
    const completed = await seedJob({ provider: 'openai' });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(queue.messages).toHaveLength(1);
    expect((await deliver([queue.messages[0]])).explicitAcks).toHaveLength(1);
    expect(await jobRow(completed.jobId)).toMatchObject({ state: 'complete' });
    const pending = await seedJob({ provider: 'openai' });

    // Upgrade to N with the production runner; N writes its own data.
    await runInDurableObject(stub, (_instance, state) => {
      expect(applyMigrations(state.storage, [...MIGRATIONS, ADDITIVE_N])).toEqual({ status: 'ready', storedVersion: N, applied: [N] });
      state.storage.sql.exec(`INSERT INTO st09_n_only (id, note) VALUES ('n-row', 'written by N')`);
      state.storage.sql.exec('UPDATE analysis_jobs SET st09_priority = 5 WHERE job_id = ?', pending.jobId);
    });

    // Roll back to N−1: a restarted object running this build.
    await evictDurableObject(stub);
    expect(await stub.readiness()).toEqual({ status: 'ready', maintenance: 'open' });
    expect(await stub.readAnalysisStatus({ studyId: completed.studyId, interviewId: completed.interviewId }))
      .toEqual({ status: 'ok', body: { status: 'complete', generation: 1 } });

    // N−1 dispatches, claims and finishes N's pending job, and allocates new work.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(queue.messages).toHaveLength(2);
    expect((await deliver([queue.messages[1]])).explicitAcks).toHaveLength(1);
    expect(await jobRow(pending.jobId)).toMatchObject({ state: 'complete' });
    expect(await analysisRow(pending.interviewId)).toMatchObject({ status: 'complete', current_generation: 1 });
    const later = await seedJob({ provider: 'openai' });
    expect(await jobRow(later.jobId)).toMatchObject({ state: 'pending' });
    expect(provider.requests).toHaveLength(2);
    expect(provider.unexpected).toEqual([]);

    // N's data survived N−1.
    expect(await sqlRows('SELECT st09_priority AS priority FROM analysis_jobs WHERE job_id = ?', pending.jobId)).toEqual([{ priority: 5 }]);
    expect(await sqlRows('SELECT id, note FROM st09_n_only')).toEqual([{ id: 'n-row', note: 'written by N' }]);

    // Forward to N again: nothing to apply, the ledger still verifies.
    await runInDurableObject(stub, (_instance, state) => {
      expect(applyMigrations(state.storage, [...MIGRATIONS, ADDITIVE_N])).toEqual({ status: 'ready', storedVersion: N, applied: [] });
    });
  });
});
