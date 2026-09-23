// Study create/read/edit/link-status/delete (ST, 02-storage.md).
// STUB: replaced by the implementing milestone.

import type * as Port from '../../src/lib/storage/types';
import type * as Rpc from './rpcTypes';
import type { WorkspaceContext } from './context';

export async function getStudy(ws: WorkspaceContext, input: Rpc.StudyIdInput): Promise<Port.StudyLoadResult> {
  void ws; void input;
  throw new Error('WorkspaceStore.getStudy is not implemented');
}

export async function listStudies(ws: WorkspaceContext, input: Rpc.MaximumInput): Promise<Port.CollectionLoadResult<Rpc.StoredStudy>> {
  void ws; void input;
  throw new Error('WorkspaceStore.listStudies is not implemented');
}

export async function createStudy(ws: WorkspaceContext, input: Port.CreateStudyInput): Promise<Port.CreateStudyOutcome> {
  void ws; void input;
  throw new Error('WorkspaceStore.createStudy is not implemented');
}

export async function replaceStudyConfig(ws: WorkspaceContext, input: Rpc.ReplaceStudyConfigInput): Promise<Port.StudyMutationOutcome> {
  void ws; void input;
  throw new Error('WorkspaceStore.replaceStudyConfig is not implemented');
}

export async function setStudyLinksEnabled(ws: WorkspaceContext, input: Rpc.SetLinksEnabledInput): Promise<Port.StudyMutationOutcome> {
  void ws; void input;
  throw new Error('WorkspaceStore.setStudyLinksEnabled is not implemented');
}

export async function deleteStudy(ws: WorkspaceContext, input: Rpc.DeleteStudyInput): Promise<Port.DeleteStudyOutcome> {
  void ws; void input;
  throw new Error('WorkspaceStore.deleteStudy is not implemented');
}
