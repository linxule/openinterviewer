// Fault cuts from tests/workers/faultManifest.ts that no other workers test
// covered: the M0 throw-after-alarm rollback on the production object's own
// storage, the bootstrap metadata write that follows the migrations, and the
// watchdog's per-job epoch fence. Real workerd SQLite and alarms.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { testEnv, workspaceStub } from './helpers';
import {
  analysisRow,
  captureQueue,
  currentAlarm,
  installProviderFixture,
  jobRow,
  resetWorkspace,
  seedJob,
  sqlRun,
  type QueueCapture,
} from './jobFixtures';

const OTHER_EPOCH = 'ep_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

let queue: QueueCapture;

beforeEach(async () => {
  await resetWorkspace();
  queue = captureQueue();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('M0 transaction cut on the WorkspaceStore storage (JOB-05)', () => {
  it('M0: a throw after SQL and an awaited setAlarm inside storage.transaction rolls back both on the WorkspaceStore storage', async () => {
    const observed = await runInDurableObject(workspaceStub(), async (_instance, state) => {
      state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS m0_probe_rows (id TEXT PRIMARY KEY)`);
      const alarmBefore = await state.storage.getAlarm();
      let error: string | null = null;
      try {
        await state.storage.transaction(async () => {
          state.storage.sql.exec(`INSERT INTO m0_probe_rows (id) VALUES ('rolled-back')`);
          await state.storage.setAlarm(Date.now() + 10 * 60_000);
          throw new Error('injected after the alarm write');
        });
      } catch (caught) {
        error = (caught as Error).message;
      }
      return {
        alarmBefore,
        error,
        rows: state.storage.sql.exec(`SELECT id FROM m0_probe_rows`).toArray(),
        alarmAfter: await state.storage.getAlarm(),
      };
    });
    expect(observed.error).toBe('injected after the alarm write');
    expect(observed.rows).toEqual([]);
    expect(observed.alarmBefore).toBeNull();
    expect(observed.alarmAfter).toBeNull();
  });
});

describe('bootstrap metadata after the migrations (ST-09)', () => {
  it('ST-09: an object whose migrations committed but whose metadata insert never ran initializes it on the next start without re-running migrations', async () => {
    const stub = workspaceStub();
    expect(await stub.readiness()).toEqual({ status: 'ready', maintenance: 'open' });
    // The durable state a process death between applyMigrations and the
    // first workspace_meta insert leaves behind: schema and ledger, no metadata.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`DELETE FROM workspace_meta`);
    });
    await evictDurableObject(stub);

    expect(await workspaceStub().readiness()).toEqual({ status: 'ready', maintenance: 'open' });
    const after = await runInDurableObject(workspaceStub(), (_instance, state) => ({
      meta: state.storage.sql.exec(`SELECT workspace_id, activated_epoch, maintenance_state FROM workspace_meta`).toArray(),
      ledger: state.storage.sql.exec(`SELECT version FROM schema_migrations ORDER BY version`).toArray(),
    }));
    expect(after.meta).toEqual([{
      workspace_id: testEnv.WORKSPACE_ID,
      activated_epoch: testEnv.ANALYSIS_RECOVERY_EPOCH,
      maintenance_state: 'open',
    }]);
    expect(after.ledger).toEqual([{ version: 1 }]);
  });
});

describe('watchdog epoch fence (JOB-10)', () => {
  it('JOB-10: a due job still carrying another recovery epoch is settled recovery-required by the alarm, never dispatched', async () => {
    const job = await seedJob();
    const provider = installProviderFixture({ kind: 'success' });
    // A restored row that escaped activation: it may already have executed.
    await sqlRun(`UPDATE analysis_jobs SET recovery_epoch = ?, next_due_at = ? WHERE job_id = ?`, OTHER_EPOCH, Date.now() - 1, job.jobId);
    expect(await currentAlarm()).not.toBeNull();
    expect(await runDurableObjectAlarm(workspaceStub())).toBe(true);

    expect(queue.messages).toEqual([]);
    expect(provider.requests).toHaveLength(0);
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'recovery-required', failure_kind: 'timeout', next_due_at: null });
    expect(await analysisRow(job.interviewId)).toMatchObject({ status: 'failed', failure_kind: 'timeout', recovery_required: 1 });
    expect(await workspaceStub().readAnalysisStatus({ studyId: job.studyId, interviewId: job.interviewId }))
      .toEqual({ status: 'ok', body: { status: 'failed', generation: 1, failureKind: 'timeout', recoveryRequired: true } });
  });
});
