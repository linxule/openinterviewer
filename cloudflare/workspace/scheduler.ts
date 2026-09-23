// The object's single alarm: dispatch, lease watchdog and bounded cleanup (JOB-06/07).
// STUB: replaced by the implementing milestone.

import type { WorkspaceContext } from './context';

export async function runAlarm(ws: WorkspaceContext, alarmInfo: AlarmInvocationInfo | undefined): Promise<void> {
  void ws; void alarmInfo;
  throw new Error('WorkspaceStore.runAlarm is not implemented');
}
