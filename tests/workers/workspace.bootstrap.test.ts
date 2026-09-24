import { describe, expect, it } from 'vitest';
import { runInDurableObject, evictDurableObject } from 'cloudflare:test';
import { testEnv, workspaceStub } from './helpers';

describe('WorkspaceStore bootstrap (ST-09)', () => {
  it('migrates a fresh object, adopts the configured identity and epoch, and reports ready', async () => {
    const stub = workspaceStub();
    expect(await stub.readiness()).toEqual({ status: 'ready', maintenance: 'open' });
    const meta = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec('SELECT workspace_id, activated_epoch, maintenance_state FROM workspace_meta').toArray(),
    );
    expect(meta).toEqual([{
      workspace_id: testEnv.WORKSPACE_ID,
      activated_epoch: testEnv.ANALYSIS_RECOVERY_EPOCH,
      maintenance_state: 'open',
    }]);
  });

  it('keeps schema and metadata across an object restart without re-running migrations', async () => {
    const stub = workspaceStub();
    await stub.readiness();
    await evictDurableObject(stub);
    const rows = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec('SELECT version FROM schema_migrations ORDER BY version').toArray(),
    );
    expect(rows).toEqual([{ version: 1 }]);
    expect(await stub.readiness()).toEqual({ status: 'ready', maintenance: 'open' });
  });

  it('refuses an object selected under another name', async () => {
    const other = testEnv.WORKSPACE_STORE.getByName('ws_ffffffffffffffffffffffffffffffff');
    expect(await other.readiness()).toEqual({ status: 'held', reason: 'workspace-identity-mismatch' });
  });

  // Staging finding 2026-09-24: right after the installer's secret upload the
  // object briefly ran the version whose env had no ANALYSIS_RECOVERY_EPOCH.
  // That is a configuration that has not arrived yet, not an identity
  // mismatch, and it must clear by itself once the epoch is bound.
  it('reports a fresh object whose version lacks the epoch as workspace-unconfigured, then initializes once it is bound', async () => {
    const stub = workspaceStub();
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec('DELETE FROM workspace_meta');
      const object = instance as unknown as { env: Record<string, unknown>; initState: unknown };
      const configured = object.env;
      object.env = { ...configured, ANALYSIS_RECOVERY_EPOCH: undefined };
      object.initState = { status: 'unconfigured' };
      expect(await instance.readiness()).toEqual({ status: 'held', reason: 'workspace-unconfigured' });
      expect(state.storage.sql.exec('SELECT COUNT(*) AS n FROM workspace_meta').one().n).toBe(0);

      object.env = { ...configured, WORKSPACE_ID: 'not-a-workspace-id' };
      expect(await instance.readiness()).toEqual({ status: 'held', reason: 'workspace-unconfigured' });

      object.env = configured;
      expect(await instance.readiness()).toEqual({ status: 'ready', maintenance: 'open' });
    });
  });
});
