// Shared helpers for Workers-runtime tests. The workspace object is selected
// exactly as production selects it: by the configured WORKSPACE_ID name.
import { env } from 'cloudflare:workers';
import type { WorkspaceStore } from '../../cloudflare/workspace/WorkspaceStore';

export type TestEnv = {
  WORKSPACE_STORE: DurableObjectNamespace<WorkspaceStore>;
  ANALYSIS_QUEUE: Queue<unknown>;
  WORKSPACE_ID: string;
  ANALYSIS_RECOVERY_EPOCH: string;
  [key: string]: unknown;
};

export const testEnv = env as unknown as TestEnv;

export function workspaceStub(): DurableObjectStub<WorkspaceStore> {
  return testEnv.WORKSPACE_STORE.getByName(testEnv.WORKSPACE_ID);
}
