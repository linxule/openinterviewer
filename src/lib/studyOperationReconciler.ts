import { decrypt } from './crypto';
import {
  deleteStudy,
  INTERVIEW_PERSISTING_PREFIX,
  parsePersistingGuard,
  persistCompletedInterviewFinish,
  settleStudyOperationMutation,
  STUDY_PERSISTING_PREFIX,
  studyOperationMarkerId,
} from './kv';
import { getPlatformClient, getResearcherClient } from './kvClient';
import {
  getResearcherByIdChecked,
  OP_GRACE_MS,
  parseOwnerRecord,
  parsePendingStudyOperationV2,
  parseStorageBinding,
  publishStudyOperationV2,
  recoverReservingStudyOperation,
  resolveStudyOperationV2,
  type PendingStudyOperationV2,
  type StudyOperationResolutionV2,
} from './platformDb';
import { platformKey } from './platformSchema';
import { RedisCommitAmbiguousError, type RedisPort } from './redisPort';
import { MAX_LIVE_OPS } from './wire/types';
import { OPERATION_RECORD_PREFIX, parseRegistryHGetAll } from './wire/registry';

export interface StudyOperationReconciliationResult {
  status: 'ok' | 'unavailable';
  examined: number;
  completed: number;
  rolledBack: number;
  stillPending: number;
  invalid: number;
  repaired: number;
}

export interface ReconcilePendingStudyOperationsInput {
  researcherId: string;
  now?: number;
  platform?: RedisPort;
}

// A newly-created operation may still have its original BYOS command in
// flight. Never infer absence during that request window: doing so could roll
// back platform authority immediately before a delayed create lands.
export const STUDY_OPERATION_RECONCILIATION_GRACE_MS = OP_GRACE_MS;
export const STUDY_OPS_CURSOR_SUFFIX = 'study-ops:cursor';

export const LOAD_REGISTRY_SCRIPT = `
-- loadRegistry
local limit = tonumber(ARGV[1])
if not limit then
  return {'oi:ops-overflow'}
end
local n = redis.call('HLEN', KEYS[1])
if n > limit then
  return {'oi:ops-overflow'}
end
return redis.call('HGETALL', KEYS[1])
`;

function emptyResult(status: StudyOperationReconciliationResult['status']): StudyOperationReconciliationResult {
  return {
    status,
    examined: 0,
    completed: 0,
    rolledBack: 0,
    stillPending: 0,
    invalid: 0,
    repaired: 0,
  };
}

function resolvePlatform(platform?: RedisPort): RedisPort {
  return platform ?? getPlatformClient();
}

function decodeOperation(studyId: string, raw: Record<string, unknown>): PendingStudyOperationV2 | null {
  const operation = parsePendingStudyOperationV2(
    `${OPERATION_RECORD_PREFIX}${JSON.stringify(raw)}`,
  );
  if (!operation || operation.studyId !== studyId) return null;
  return operation;
}

function rotateRecords<T extends { studyId: string }>(records: T[], cursor: string | null): T[] {
  const sorted = [...records].sort((left, right) => left.studyId.localeCompare(right.studyId));
  if (!cursor) return sorted;
  const index = sorted.findIndex((record) => record.studyId === cursor);
  if (index < 0) return sorted;
  return [...sorted.slice(index + 1), ...sorted.slice(0, index + 1)];
}

function terminalResolution(
  operation: PendingStudyOperationV2,
  mutationApplied: boolean,
): StudyOperationResolutionV2 {
  if (operation.kind === 'create') {
    return mutationApplied ? 'create-complete' : 'create-rollback';
  }
  return mutationApplied ? 'delete-complete' : 'delete-rollback';
}

async function readStorageId(
  platform: RedisPort,
  researcherId: string,
  studyId: string,
): Promise<string | null> {
  const owner = parseOwnerRecord(await platform.get(platformKey(`study-owner:${studyId}`)));
  if (owner?.storageId) return owner.storageId;
  const binding = parseStorageBinding(await platform.get(platformKey(`researcher-storage:${researcherId}`)));
  return binding?.storageId ?? null;
}

async function finishThenDeletePendingStudy(
  studyId: string,
  markerId: string,
  kvClient: RedisPort,
): Promise<'mutation-applied' | 'mutation-cancelled' | 'unavailable' | 'still-pending'> {
  let members: unknown;
  try {
    members = await kvClient.smembers(`${STUDY_PERSISTING_PREFIX}${studyId}`);
  } catch {
    return 'unavailable';
  }
  if (!Array.isArray(members)) return 'unavailable';

  for (const member of members) {
    if (typeof member !== 'string' || member.length === 0) continue;
    let raw: unknown;
    try {
      raw = await kvClient.get(`${INTERVIEW_PERSISTING_PREFIX}${member}`);
    } catch {
      return 'unavailable';
    }
    const guard = parsePersistingGuard(raw);
    if (!guard || guard.studyId !== studyId) continue;
    const finished = await persistCompletedInterviewFinish(guard, kvClient);
    if (finished.status === 'created' || finished.status === 'duplicate') continue;
    if (finished.status === 'ambiguous' || finished.status === 'unavailable') {
      return 'unavailable';
    }
  }

  const deleted = await deleteStudy(studyId, kvClient, markerId);
  if (deleted.status === 'deleted' || deleted.status === 'not-found') return 'mutation-applied';
  if (deleted.status === 'still-pending') return 'still-pending';
  if (deleted.status === 'conflict' || deleted.status === 'cancelled') return 'mutation-cancelled';
  return 'unavailable';
}

async function acquireCallerByosClient(researcherId: string): Promise<RedisPort | null> {
  const loaded = await getResearcherByIdChecked(researcherId);
  if (loaded.status !== 'found') return null;
  const { encryptedRedisUrl, encryptedRedisToken } = loaded.researcher;
  if (!encryptedRedisUrl || !encryptedRedisToken) return null;
  try {
    const redisUrl = decrypt(encryptedRedisUrl, { researcherId, purpose: 'redis-url' });
    const redisToken = decrypt(encryptedRedisToken, { researcherId, purpose: 'redis-token' });
    if (!redisUrl || !redisToken) return null;
    return getResearcherClient(redisUrl, redisToken, { researcherId });
  } catch {
    return null;
  }
}

async function publishResolved(
  operation: PendingStudyOperationV2,
  resolution: StudyOperationResolutionV2,
  createdAt: number,
  now: number,
): Promise<'repaired' | 'invalid' | 'pending'> {
  const published = await publishStudyOperationV2({
    researcherId: operation.researcherId,
    studyId: operation.studyId,
    generation: operation.generation,
    kind: operation.kind,
    opNonce: operation.opNonce,
    resolution,
    now,
    createdAt,
  });
  if (published.status === 'published' || published.status === 'pruned') return 'repaired';
  if (published.status === 'invalid') return 'invalid';
  return 'pending';
}

async function continueResolve(
  operation: PendingStudyOperationV2,
  platform: RedisPort,
  resolution: StudyOperationResolutionV2,
  now: number,
  createdAt?: number,
): Promise<'repaired' | 'invalid' | 'pending'> {
  const storageId = await readStorageId(platform, operation.researcherId, operation.studyId);
  if (!storageId) return 'pending';
  const resolved = await resolveStudyOperationV2({
    researcherId: operation.researcherId,
    studyId: operation.studyId,
    storageId,
    generation: operation.generation,
    kind: operation.kind,
    opNonce: operation.opNonce,
    resolution,
    now,
    createdAt,
  });
  if (resolved.status === 'publishing') {
    const receipt = resolved.operation.frozenReceipt;
    return publishResolved(
      resolved.operation,
      receipt?.resolution ?? resolution,
      receipt?.createdAt ?? createdAt ?? now,
      now,
    );
  }
  if (resolved.status === 'terminal') return 'repaired';
  if (resolved.status === 'invalid') return 'invalid';
  return 'pending';
}

async function repairPublishing(
  operation: PendingStudyOperationV2,
  now: number,
): Promise<'repaired' | 'invalid' | 'pending'> {
  const receipt = operation.frozenReceipt;
  if (!receipt) return 'invalid';
  return publishResolved(operation, receipt.resolution, receipt.createdAt, now);
}

// Reconciles the hosted HASH registry. Reserving/resolving/publishing are
// platform-only. BYOS is acquired only for the caller's exact pending records.
export async function reconcilePendingStudyOperations(
  input: ReconcilePendingStudyOperationsInput,
): Promise<StudyOperationReconciliationResult> {
  const now = input.now ?? Date.now();
  let platform: RedisPort;
  try {
    platform = resolvePlatform(input.platform);
  } catch {
    return emptyResult('unavailable');
  }

  let loadedWire: unknown;
  try {
    loadedWire = await platform.eval(
      LOAD_REGISTRY_SCRIPT,
      [platformKey('study-ops:v2')],
      [String(MAX_LIVE_OPS)],
    );
  } catch (error) {
    if (error instanceof RedisCommitAmbiguousError && error.commitState === 'may-have-committed') {
      return emptyResult('unavailable');
    }
    return emptyResult('unavailable');
  }

  const parsed = parseRegistryHGetAll(loadedWire);
  if (parsed.status !== 'ok') return emptyResult('unavailable');

  const cursorKey = platformKey(STUDY_OPS_CURSOR_SUFFIX);
  let cursor: string | null = null;
  try {
    const rawCursor = await platform.get(cursorKey);
    cursor = typeof rawCursor === 'string' && rawCursor.length > 0 ? rawCursor : null;
  } catch {
    return emptyResult('unavailable');
  }

  const rotated = rotateRecords(parsed.value, cursor);
  const result = emptyResult('ok');
  result.examined = rotated.length;

  const byosClients = new Map<string, RedisPort | null>();

  for (const record of rotated) {
    try {
      await platform.set(cursorKey, record.studyId);
    } catch {
      return { ...result, status: 'unavailable' };
    }

    const operation = decodeOperation(record.studyId, record.operation);
    if (!operation) {
      result.invalid += 1;
      continue;
    }

    switch (operation.phase) {
      case 'reserving': {
        const recovered = await recoverReservingStudyOperation({
          studyId: operation.studyId,
          researcherId: operation.researcherId,
          generation: operation.generation,
          kind: operation.kind,
          opNonce: operation.opNonce,
          now,
          graceMs: OP_GRACE_MS,
        });
        if (recovered.status === 'pending' || recovered.status === 'abandoned') {
          result.repaired += 1;
          break;
        }
        if (recovered.status === 'phase' && recovered.phase === 'resolving') {
          const continued = await continueResolve(
            { ...operation, phase: 'resolving' },
            platform,
            operation.kind === 'create' ? 'create-complete' : 'delete-complete',
            now,
          );
          if (continued === 'repaired') result.repaired += 1;
          else if (continued === 'invalid') result.invalid += 1;
          else result.stillPending += 1;
          break;
        }
        if (recovered.status === 'phase' && recovered.phase === 'publishing') {
          const published = await repairPublishing({ ...operation, phase: 'publishing' }, now);
          if (published === 'repaired') result.repaired += 1;
          else if (published === 'invalid') result.invalid += 1;
          else result.stillPending += 1;
          break;
        }
        if (recovered.status === 'invalid') result.invalid += 1;
        else result.stillPending += 1;
        break;
      }
      case 'resolving': {
        const receipt = operation.frozenReceipt;
        const continued = await continueResolve(
          operation,
          platform,
          receipt?.resolution ?? (operation.kind === 'create' ? 'create-complete' : 'delete-complete'),
          now,
          receipt?.createdAt,
        );
        if (continued === 'repaired') result.repaired += 1;
        else if (continued === 'invalid') result.invalid += 1;
        else result.stillPending += 1;
        break;
      }
      case 'publishing': {
        const published = await repairPublishing(operation, now);
        if (published === 'repaired') result.repaired += 1;
        else if (published === 'invalid') result.invalid += 1;
        else result.stillPending += 1;
        break;
      }
      case 'pending': {
        if (operation.researcherId !== input.researcherId) {
          result.stillPending += 1;
          break;
        }
        if (now - operation.updatedAt < OP_GRACE_MS) {
          result.stillPending += 1;
          break;
        }
        if (!byosClients.has(input.researcherId)) {
          byosClients.set(input.researcherId, await acquireCallerByosClient(input.researcherId));
        }
        const kvClient = byosClients.get(input.researcherId) ?? null;
        if (!kvClient) {
          result.stillPending += 1;
          break;
        }
        const markerId = studyOperationMarkerId(`${operation.kind}:${operation.studyId}`, operation.createdAt);
        if (!markerId) {
          result.invalid += 1;
          break;
        }
        const mutation = operation.kind === 'delete'
          ? await finishThenDeletePendingStudy(operation.studyId, markerId, kvClient)
          : await settleStudyOperationMutation(
            operation.kind,
            operation.studyId,
            markerId,
            kvClient,
          );
        if (mutation === 'unavailable' || mutation === 'still-pending') {
          result.stillPending += 1;
          break;
        }
        const resolution = terminalResolution(operation, mutation === 'mutation-applied');
        const continued = await continueResolve(operation, platform, resolution, now, now);
        if (continued === 'invalid') {
          result.invalid += 1;
          result.stillPending += 1;
          break;
        }
        if (continued !== 'repaired') {
          result.stillPending += 1;
          break;
        }
        if (resolution.endsWith('complete')) result.completed += 1;
        else result.rolledBack += 1;
        break;
      }
      default: {
        result.invalid += 1;
      }
    }
  }

  return result;
}
