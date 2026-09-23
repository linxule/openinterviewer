// The one factory that turns resolved capabilities into a WorkspaceStorePort.
// Routes never branch on backend themselves. On the Cloudflare target a
// missing binding or configuration is an error, never a Redis fallback.

import type { RedisPort } from '../redisPort';
import { resolveCapabilities } from '../runtime/capabilities';
import { currentWorkerInvocation } from '../runtime/workerInvocation';
import { isValidWorkspaceId } from './analysisProtocol';
import { createDurableWorkspaceStore } from './durableObject';
import { createRedisWorkspaceStore } from './redis';
import type { WorkspaceStorePort } from './types';

export class WorkspaceStoreUnavailableError extends Error {
  constructor(readonly reason: 'unsupported-configuration' | 'binding-missing' | 'invalid-workspace-config') {
    super(`Workspace store is not available: ${reason}`);
    this.name = 'WorkspaceStoreUnavailableError';
  }
}

type DurableSettings = {
  namespace: unknown;
  workspaceId: string;
  jurisdiction: '' | 'eu' | 'fedramp';
  rateLimitSalt: string;
};

/** Validated Cloudflare workspace settings from the current Worker invocation. */
export function durableWorkspaceSettings(): DurableSettings {
  const invocation = currentWorkerInvocation();
  if (!invocation) throw new WorkspaceStoreUnavailableError('binding-missing');
  const env = invocation.env;
  const namespace = env.WORKSPACE_STORE;
  if (!namespace || typeof namespace !== 'object') throw new WorkspaceStoreUnavailableError('binding-missing');
  const workspaceId = env.WORKSPACE_ID;
  const jurisdiction = env.WORKSPACE_JURISDICTION ?? '';
  const salt = env.RATE_LIMIT_SALT;
  if (
    !isValidWorkspaceId(workspaceId)
    || (jurisdiction !== '' && jurisdiction !== 'eu' && jurisdiction !== 'fedramp')
    || typeof salt !== 'string'
    || salt.length < 32
  ) {
    throw new WorkspaceStoreUnavailableError('invalid-workspace-config');
  }
  return { namespace, workspaceId, jurisdiction, rateLimitSalt: salt };
}

/**
 * Resolve the workspace store for a request. `redisClient` is consulted only
 * on the Node target (standalone Upstash or hosted BYOS client).
 */
export function resolveWorkspaceStore(options: {
  redisClient: () => RedisPort;
  researcherId: string | null;
}): WorkspaceStorePort {
  const resolved = resolveCapabilities();
  if (!resolved.ok) throw new WorkspaceStoreUnavailableError('unsupported-configuration');
  if (resolved.capabilities.storage === 'workspace-do') {
    return createDurableWorkspaceStore(durableWorkspaceSettings());
  }
  return createRedisWorkspaceStore(options.redisClient(), { researcherId: options.researcherId });
}
