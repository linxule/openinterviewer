// WorkspaceStorePort client for the WorkspaceStore Durable Object (Cloudflare
// target). Portable module: it never imports Workers modules; it receives the
// namespace binding as an opaque structural value. Link codes, consent text
// and budget scope keys are digested here, so raw codes never reach storage.
// STUB: implemented by the Durable Object work package.

import type { WorkspaceStorePort } from './types';

export type DurableWorkspaceConfig = {
  /** env.WORKSPACE_STORE (DurableObjectNamespace). */
  namespace: unknown;
  workspaceId: string;
  /** Empty means no jurisdiction restriction (required locally). */
  jurisdiction: '' | 'eu' | 'fedramp';
  /** RATE_LIMIT_SALT: salts budget scope keys before they reach storage. */
  rateLimitSalt: string;
};

export function createDurableWorkspaceStore(config: DurableWorkspaceConfig): WorkspaceStorePort {
  void config;
  throw new Error('createDurableWorkspaceStore is not implemented');
}
