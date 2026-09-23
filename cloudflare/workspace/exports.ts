// Researcher export paging fenced by the research mutation sequence (RT-09, ST-08).
// STUB: replaced by the implementing milestone.

import type * as Rpc from './rpcTypes';
import type { WorkspaceContext } from './context';

export async function beginExport(ws: WorkspaceContext, input: Rpc.BeginExportInput): Promise<Rpc.BeginExportOutcome> {
  void ws; void input;
  throw new Error('WorkspaceStore.beginExport is not implemented');
}

export async function readExportPage(ws: WorkspaceContext, input: Rpc.ExportPageInput): Promise<Rpc.ExportPageOutcome> {
  void ws; void input;
  throw new Error('WorkspaceStore.readExportPage is not implemented');
}

export async function verifyExportSequence(ws: WorkspaceContext, input: Rpc.ExportSequenceInput): Promise<Rpc.ExportSequenceOutcome> {
  void ws; void input;
  throw new Error('WorkspaceStore.verifyExportSequence is not implemented');
}
