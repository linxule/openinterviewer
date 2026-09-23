// Durable analysis generations: researcher retry/status and consumer claim/start/finish (03-analysis-jobs.md).
// STUB: replaced by the implementing milestone.

import type * as Protocol from '../../src/lib/storage/analysisProtocol';
import type * as Rpc from './rpcTypes';
import type { WorkspaceContext } from './context';

export async function acceptAnalysisRetry(ws: WorkspaceContext, input: Protocol.AcceptAnalysisRetryInput): Promise<Protocol.AcceptAnalysisRetryOutcome> {
  void ws; void input;
  throw new Error('WorkspaceStore.acceptAnalysisRetry is not implemented');
}

export async function readAnalysisStatus(ws: WorkspaceContext, input: Rpc.AnalysisStatusInput): Promise<Protocol.ReadAnalysisStatusOutcome> {
  void ws; void input;
  throw new Error('WorkspaceStore.readAnalysisStatus is not implemented');
}

export async function claimAnalysisJob(ws: WorkspaceContext, input: Protocol.ClaimAnalysisJobInput): Promise<Protocol.ClaimAnalysisJobOutcome> {
  void ws; void input;
  throw new Error('WorkspaceStore.claimAnalysisJob is not implemented');
}

export async function markAnalysisStarted(ws: WorkspaceContext, input: Protocol.MarkStartedInput): Promise<Protocol.MarkStartedOutcome> {
  void ws; void input;
  throw new Error('WorkspaceStore.markAnalysisStarted is not implemented');
}

export async function finishAnalysisJob(ws: WorkspaceContext, input: Protocol.FinishAnalysisJobInput): Promise<Protocol.FinishAnalysisJobOutcome> {
  void ws; void input;
  throw new Error('WorkspaceStore.finishAnalysisJob is not implemented');
}
