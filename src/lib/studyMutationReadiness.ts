import type { WorkspaceStorePort } from './storage/types';

export const STUDY_DELETION_PENDING_CODE = 'STUDY_DELETION_PENDING';
export const STUDY_DELETION_PENDING_MESSAGE = 'This study is being permanently deleted. Retry deletion to finish removing its data.';

/** Older fixture adapters may omit the capability; production stores fence reads. */
export async function studyMutationReadiness(
  store: Pick<WorkspaceStorePort, 'studyMutationStatus'>,
  studyId: string,
): Promise<'ready' | 'deleting' | 'missing' | 'unavailable'> {
  if (!store.studyMutationStatus) return 'ready';
  try {
    const status = await store.studyMutationStatus(studyId);
    return status === 'ready' || status === 'deleting' || status === 'missing' ? status : 'unavailable';
  } catch {
    return 'unavailable';
  }
}
