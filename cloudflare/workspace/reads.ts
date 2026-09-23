// Interview reads/collections, aggregate read/write and bounded aggregate inputs.
// STUB: replaced by the implementing milestone.

import type * as Port from '../../src/lib/storage/types';
import type * as Rpc from './rpcTypes';
import type { WorkspaceContext } from './context';

export async function getInterview(ws: WorkspaceContext, input: Rpc.InterviewIdInput): Promise<Port.InterviewLoadResult> {
  void ws; void input;
  throw new Error('WorkspaceStore.getInterview is not implemented');
}

export async function listInterviews(ws: WorkspaceContext, input: Port.ListInterviewsInput): Promise<Port.CollectionLoadResult<Rpc.StoredInterview>> {
  void ws; void input;
  throw new Error('WorkspaceStore.listInterviews is not implemented');
}

export async function getAggregate(ws: WorkspaceContext, input: Rpc.StudyIdInput): Promise<Port.AggregateLoadResult> {
  void ws; void input;
  throw new Error('WorkspaceStore.getAggregate is not implemented');
}

export async function saveAggregate(ws: WorkspaceContext, input: Rpc.SaveAggregateInput): Promise<Port.SaveAggregateOutcome> {
  void ws; void input;
  throw new Error('WorkspaceStore.saveAggregate is not implemented');
}

export async function readAggregateInputs(ws: WorkspaceContext, input: Rpc.AggregateInputsInput): Promise<Rpc.AggregateInputsOutcome> {
  void ws; void input;
  throw new Error('WorkspaceStore.readAggregateInputs is not implemented');
}
