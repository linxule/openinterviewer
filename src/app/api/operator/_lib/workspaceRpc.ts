// Operator calls into the WorkspaceStore Durable Object (Cloudflare target
// only). The object is selected exactly as the durable workspace client
// selects it: the configured WORKSPACE_ID, under the configured jurisdiction,
// from the current Worker invocation. Request input never selects an object.
//
// A thrown RPC is never success: for a mutation the commit may have happened,
// so callers report an unknown outcome and the operator reads status first.

import { durableWorkspaceSettings, WorkspaceStoreUnavailableError } from '@/lib/storage/resolve';

export type OperatorRpcMethod =
  | 'operatorStatus'
  | 'transitionMaintenance'
  | 'exportBackupPage'
  | 'importBackupChunk'
  | 'activateRecoveryEpoch'
  | 'restoreToBookmark';

export type OperatorReply = { status: string } & Record<string, unknown>;

export type OperatorRpcResult =
  | { kind: 'reply'; reply: OperatorReply }
  /** Binding or workspace configuration missing: no call was made. */
  | { kind: 'not-configured' }
  /** The call threw or returned no recognizable outcome. */
  | { kind: 'failed' };

type RpcMethod = (input?: unknown) => Promise<unknown>;
type WorkspaceStub = Record<string, RpcMethod>;
type NamespaceLike = {
  getByName(name: string): WorkspaceStub;
  jurisdiction?(jurisdiction: string): NamespaceLike;
};

function isReply(value: unknown): value is OperatorReply {
  return value !== null && typeof value === 'object' && typeof (value as { status?: unknown }).status === 'string';
}

export async function callOperatorRpc(method: OperatorRpcMethod, input?: unknown): Promise<OperatorRpcResult> {
  let stub: WorkspaceStub;
  try {
    const settings = durableWorkspaceSettings();
    const namespace = settings.namespace as NamespaceLike;
    if (settings.jurisdiction) {
      if (typeof namespace.jurisdiction !== 'function') return { kind: 'not-configured' };
      stub = namespace.jurisdiction(settings.jurisdiction).getByName(settings.workspaceId);
    } else {
      stub = namespace.getByName(settings.workspaceId);
    }
  } catch (error) {
    if (error instanceof WorkspaceStoreUnavailableError) return { kind: 'not-configured' };
    return { kind: 'failed' };
  }
  try {
    // Member call: on an RPC stub, `fn.call(...)` would be sent as a remote method.
    const value = input === undefined ? await stub[method]() : await stub[method](input);
    return isReply(value) ? { kind: 'reply', reply: value } : { kind: 'failed' };
  } catch {
    return { kind: 'failed' };
  }
}
