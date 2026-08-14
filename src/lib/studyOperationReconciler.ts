import { Redis } from '@upstash/redis';
import { settleStudyOperationMutation, studyOperationMarkerId } from './kv';
import {
  getPendingStudyOperations,
  PendingStudyOperation,
  resolveStudyOperation,
  StudyOperationResolution,
} from './platformDb';

export interface StudyOperationReconciliationResult {
  status: 'ok' | 'unavailable';
  examined: number;
  completed: number;
  rolledBack: number;
  stillPending: number;
  invalid: number;
}

// A newly-created operation may still have its original BYOS command in
// flight. Never infer absence during that request window: doing so could roll
// back platform authority immediately before a delayed create lands.
export const STUDY_OPERATION_RECONCILIATION_GRACE_MS = 5 * 60 * 1_000;

function terminalResolution(
  operation: PendingStudyOperation,
  mutationApplied: boolean
): StudyOperationResolution {
  if (operation.kind === 'create') {
    return mutationApplied ? 'create-complete' : 'create-rollback';
  }
  return mutationApplied ? 'delete-complete' : 'delete-rollback';
}

// Reconciles a bounded batch using the researcher's BYOS database as the
// authoritative source of study existence. A storage outage never mutates
// platform authority; that operation remains pending for a later retry.
export async function reconcilePendingStudyOperations(
  researcherId: string,
  kvClient: Redis,
  maximum = 25,
  minimumAgeMs = STUDY_OPERATION_RECONCILIATION_GRACE_MS
): Promise<StudyOperationReconciliationResult> {
  const loaded = await getPendingStudyOperations(researcherId, maximum);
  if (loaded.status !== 'ok') {
    return {
      status: 'unavailable',
      examined: 0,
      completed: 0,
      rolledBack: 0,
      stillPending: 0,
      invalid: 0,
    };
  }

  const result: StudyOperationReconciliationResult = {
    status: 'ok',
    examined: loaded.operations.length,
    completed: 0,
    rolledBack: 0,
    stillPending: 0,
    invalid: loaded.invalidCount,
  };

  await Promise.all(loaded.operations.map(async (operation) => {
    if (
      !Number.isSafeInteger(minimumAgeMs)
      || minimumAgeMs < 0
      || Date.now() - operation.updatedAt < minimumAgeMs
    ) {
      result.stillPending += 1;
      return;
    }

    const markerId = studyOperationMarkerId(operation.id, operation.createdAt);
    if (!markerId) {
      result.invalid += 1;
      return;
    }
    const mutation = await settleStudyOperationMutation(
      operation.kind,
      operation.studyId,
      markerId,
      kvClient
    );
    if (mutation === 'unavailable') {
      result.stillPending += 1;
      return;
    }

    const resolution = terminalResolution(operation, mutation === 'mutation-applied');
    const resolved = await resolveStudyOperation(operation, resolution);
    if (resolved !== 'resolved' && resolved !== 'already-resolved') {
      result.stillPending += 1;
      if (resolved === 'invalid') result.invalid += 1;
      return;
    }

    if (resolution.endsWith('complete')) result.completed += 1;
    else result.rolledBack += 1;
  }));

  return result;
}
