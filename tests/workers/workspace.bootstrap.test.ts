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
});
