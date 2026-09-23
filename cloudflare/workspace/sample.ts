// Authenticated sample-workspace seed/clear (fixture-scoped, atomic).
// STUB: replaced by the implementing milestone.

import type * as Port from '../../src/lib/storage/types';
import type { WorkspaceContext } from './context';

export async function seedSampleWorkspace(ws: WorkspaceContext, input: Port.SeedSampleInput): Promise<Port.SeedSampleOutcome> {
  void ws; void input;
  throw new Error('WorkspaceStore.seedSampleWorkspace is not implemented');
}

export async function clearSampleWorkspace(ws: WorkspaceContext, input: Port.ClearSampleInput & { now: number }): Promise<Port.ClearSampleOutcome> {
  void ws; void input;
  throw new Error('WorkspaceStore.clearSampleWorkspace is not implemented');
}
