// Redis implementation of WorkspaceStorePort (Node target only). Wraps the
// existing kv.ts / participantLinks.ts / participantConsent.ts / rateLimit.ts /
// createIdempotency.ts operations without changing their Lua, wire parsers or
// crash-cut behavior. STUB: implemented by the Redis adapter work package.

import type { RedisPort } from '../redisPort';
import type { WorkspaceStorePort } from './types';

export type RedisWorkspaceStoreOptions = {
  /** Hosted researcher id; null in standalone. */
  researcherId: string | null;
};

export function createRedisWorkspaceStore(client: RedisPort, options: RedisWorkspaceStoreOptions): WorkspaceStorePort {
  void client;
  void options;
  throw new Error('createRedisWorkspaceStore is not implemented');
}
