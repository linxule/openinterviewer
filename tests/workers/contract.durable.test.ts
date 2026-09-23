// ST-01: the backend-neutral WorkspaceStore scenarios, run against the real
// WorkspaceStore Durable Object in workerd through the production client
// (the same module Next routes use on the Cloudflare target).
import { env } from 'cloudflare:workers';
import { createDurableWorkspaceStore } from '../../src/lib/storage/durableObject';
import { defineWorkspaceStoreContract } from '../contract/workspaceStoreScenarios';

const workerEnv = env as unknown as Record<string, unknown>;

defineWorkspaceStoreContract('durable object', {
  backend: 'durable-object',
  async createStore() {
    return createDurableWorkspaceStore({
      namespace: workerEnv.WORKSPACE_STORE,
      workspaceId: workerEnv.WORKSPACE_ID as string,
      jurisdiction: '',
      rateLimitSalt: workerEnv.RATE_LIMIT_SALT as string,
    });
  },
  capabilities: { storeBoundaryLinkChecks: true, atomicSaveAdmission: true, sampleClearCascadesLinks: true },
});
