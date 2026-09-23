// Immutable completion: transcript + admission + initial job + alarm in one transaction.
// STUB: replaced by the implementing milestone.

import type * as Port from '../../src/lib/storage/types';
import type * as Rpc from './rpcTypes';
import type { WorkspaceContext } from './context';

export async function persistCompletedInterview(ws: WorkspaceContext, input: Rpc.PersistInput): Promise<Port.PersistCompletedInterviewOutcome> {
  void ws; void input;
  throw new Error('WorkspaceStore.persistCompletedInterview is not implemented');
}
