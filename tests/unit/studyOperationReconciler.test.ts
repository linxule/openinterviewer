// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RedisPort } from '@/lib/redisPort';
import {
  buildPendingStudyOperationV2,
  encodeOperationRecord,
  encodeOwnerRecord,
  encodeStorageBinding,
  type PendingStudyOperationV2,
  type StudyOperationResolutionV2,
} from '@/lib/platformDb';
import { MAX_LIVE_OPS } from '@/lib/wire/types';

const kvMock = vi.hoisted(() => ({
  deleteStudy: vi.fn(),
  INTERVIEW_PERSISTING_PREFIX: 'interview-persisting:',
  parsePersistingGuard: vi.fn(),
  persistCompletedInterviewFinish: vi.fn(),
  settleStudyOperationMutation: vi.fn(),
  STUDY_PERSISTING_PREFIX: 'study-persisting:',
  studyOperationMarkerId: vi.fn((id: string, createdAt: number) => `${id}:${createdAt}`),
}));
vi.mock('@/lib/kv', () => kvMock);

const platformMock = vi.hoisted(() => ({
  recoverReservingStudyOperation: vi.fn(),
  resolveStudyOperationV2: vi.fn(),
  publishStudyOperationV2: vi.fn(),
  getResearcherByIdChecked: vi.fn(),
}));
vi.mock('@/lib/platformDb', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platformDb')>('@/lib/platformDb');
  return {
    ...actual,
    recoverReservingStudyOperation: platformMock.recoverReservingStudyOperation,
    resolveStudyOperationV2: platformMock.resolveStudyOperationV2,
    publishStudyOperationV2: platformMock.publishStudyOperationV2,
    getResearcherByIdChecked: platformMock.getResearcherByIdChecked,
  };
});

const kvClientMock = vi.hoisted(() => ({
  getResearcherClient: vi.fn(),
  getPlatformClient: vi.fn(),
}));
vi.mock('@/lib/kvClient', () => kvClientMock);

const cryptoMock = vi.hoisted(() => ({
  decrypt: vi.fn(),
}));
vi.mock('@/lib/crypto', () => cryptoMock);

import {
  LOAD_REGISTRY_SCRIPT,
  reconcilePendingStudyOperations,
} from '@/lib/studyOperationReconciler';

const RESEARCHER = 'researcher-a';
const OTHER = 'researcher-b';
const STORAGE_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const FINGERPRINT = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
const NONCE = '0123456789abcdef0123456789abcdef';
const NOW = 1_700_000_000_000;
const BYOS = {
  ping: vi.fn(),
  smembers: vi.fn(async () => []),
  get: vi.fn(async () => null),
} as unknown as RedisPort;

function byosMembers(members: string[]): void {
  (BYOS as unknown as { smembers: ReturnType<typeof vi.fn> }).smembers.mockResolvedValue(members);
}

function studyIdAt(index: number): string {
  return `11111111-1111-4111-8111-${index.toString(16).padStart(12, '0')}`;
}

function operation(input: {
  studyId: string;
  phase: PendingStudyOperationV2['phase'];
  researcherId?: string;
  kind?: PendingStudyOperationV2['kind'];
  updatedAt?: number;
  frozenReceipt?: PendingStudyOperationV2['frozenReceipt'];
}): PendingStudyOperationV2 {
  const built = buildPendingStudyOperationV2({
    kind: input.kind ?? 'create',
    phase: input.phase,
    researcherId: input.researcherId ?? RESEARCHER,
    studyId: input.studyId,
    generation: 1,
    opNonce: NONCE,
    createdAt: 1,
    updatedAt: input.updatedAt ?? 1,
    idempotencyHash: input.kind === 'delete' ? null : HASH,
    fingerprint: input.kind === 'delete' ? null : FINGERPRINT,
  });
  return { ...built, frozenReceipt: input.frozenReceipt ?? null };
}

function registryPairs(ops: PendingStudyOperationV2[]): string[] {
  return ops.flatMap((op) => [op.studyId, encodeOperationRecord(op)]);
}

function fakePlatform(input: {
  wire?: unknown;
  cursor?: string | null;
  throwOnEval?: boolean;
}): RedisPort & {
  cursor: string | null;
  eval: ReturnType<typeof vi.fn>;
} {
  const state = {
    cursor: (input.cursor ?? null) as string | null,
    evalCalls: [] as unknown[][],
    setKeys: [] as string[],
  };
  const evalFn = vi.fn(async (script: string, keys: string[], args: string[]) => {
    state.evalCalls.push([script, keys, args]);
    if (input.throwOnEval) throw new Error('platform down');
    return input.wire ?? [];
  });
  const port = {
    get: vi.fn(async (key: string) => {
      if (key === 'study-ops:cursor') return state.cursor;
      if (key.startsWith('study-owner:')) {
        return encodeOwnerRecord({
          version: 2,
          researcherId: RESEARCHER,
          storageId: STORAGE_ID,
          generation: 1,
        });
      }
      if (key.startsWith('researcher-storage:')) {
        return encodeStorageBinding({
          version: 2,
          researcherId: RESEARCHER,
          storageId: STORAGE_ID,
          originHash: STORAGE_ID,
          credentialRevision: 1,
          bindingEpoch: 1,
          cipherSnapshot: 'cipher',
        });
      }
      return null;
    }),
    set: vi.fn(async (key: string, value: string) => {
      state.setKeys.push(key);
      if (key === 'study-ops:cursor') state.cursor = value;
      return 'OK';
    }),
    eval: evalFn,
  };
  return Object.assign(port, state) as unknown as RedisPort & {
    cursor: string | null;
    eval: typeof evalFn;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  platformMock.recoverReservingStudyOperation.mockResolvedValue({ status: 'pending' });
  platformMock.resolveStudyOperationV2.mockImplementation(async (input: {
    studyId: string;
    resolution: StudyOperationResolutionV2;
  }) => ({
    status: 'publishing',
    operation: operation({
      studyId: input.studyId,
      phase: 'publishing',
      frozenReceipt: {
        version: 2,
        studyId: input.studyId,
        generation: 1,
        kind: 'create',
        researcherId: RESEARCHER,
        resolution: input.resolution,
        createdAt: NOW,
      },
    }),
  }));
  platformMock.publishStudyOperationV2.mockResolvedValue({ status: 'published', zaddDelta: 1 });
  platformMock.getResearcherByIdChecked.mockResolvedValue({
    status: 'found',
    researcher: {
      id: RESEARCHER,
      encryptedRedisUrl: 'enc-url',
      encryptedRedisToken: 'enc-token',
      encryptedGeminiApiKey: 'enc-gemini',
      encryptedAnthropicApiKey: 'enc-anthropic',
      encryptedOpenAiApiKey: 'enc-openai',
      encryptedOpenRouterApiKey: 'enc-openrouter',
    },
  });
  cryptoMock.decrypt.mockImplementation((_value: string, context: { purpose: string }) => {
    if (context.purpose === 'redis-url') return 'https://example.upstash.io';
    if (context.purpose === 'redis-token') return 'token';
    throw new Error(`unexpected decrypt purpose ${context.purpose}`);
  });
  kvClientMock.getResearcherClient.mockReturnValue(BYOS);
  kvMock.settleStudyOperationMutation.mockResolvedValue('mutation-applied');
  kvMock.deleteStudy.mockResolvedValue({ status: 'deleted', success: true });
  kvMock.parsePersistingGuard.mockReturnValue(null);
  kvMock.persistCompletedInterviewFinish.mockResolvedValue({ status: 'created' });
});

describe('study operation reconciliation', () => {
  it('loads the HASH once and fails closed on overflow', async () => {
    const platform = fakePlatform({ wire: ['oi:ops-overflow'] });
    await expect(reconcilePendingStudyOperations({
      researcherId: RESEARCHER,
      now: NOW,
      platform,
    })).resolves.toEqual({
      status: 'unavailable',
      examined: 0,
      completed: 0,
      rolledBack: 0,
      stillPending: 0,
      invalid: 0,
      repaired: 0,
    });
    expect(platform.eval).toHaveBeenCalledTimes(1);
    expect(platform.eval.mock.calls[0][0]).toBe(LOAD_REGISTRY_SCRIPT);
    expect(platform.eval.mock.calls[0][2]).toEqual([String(MAX_LIVE_OPS)]);
    expect(platformMock.recoverReservingStudyOperation).not.toHaveBeenCalled();
    expect(kvMock.settleStudyOperationMutation).not.toHaveBeenCalled();
  });

  it('rotates through every field so the first 25 cannot starve later records', async () => {
    const ops = Array.from({ length: 30 }, (_, index) => operation({
      studyId: studyIdAt(index),
      phase: 'reserving',
    }));
    const platform = fakePlatform({
      wire: registryPairs(ops),
      cursor: studyIdAt(24),
    });

    const result = await reconcilePendingStudyOperations({
      researcherId: RESEARCHER,
      now: NOW,
      platform,
    });

    expect(result.examined).toBe(30);
    expect(result.repaired).toBe(30);
    const recoveredIds = platformMock.recoverReservingStudyOperation.mock.calls.map(
      (call) => (call[0] as { studyId: string }).studyId,
    );
    expect(recoveredIds[0]).toBe(studyIdAt(25));
    expect(recoveredIds).toHaveLength(30);
    expect(new Set(recoveredIds).size).toBe(30);
    expect(platform.cursor).toBe(studyIdAt(24));
    expect(kvMock.settleStudyOperationMutation).not.toHaveBeenCalled();
  });

  it('switches on phase immediately and never settles BYOS for reserving/resolving/publishing', async () => {
    const reserving = operation({ studyId: studyIdAt(1), phase: 'reserving' });
    const resolving = operation({ studyId: studyIdAt(2), phase: 'resolving' });
    const publishing = operation({
      studyId: studyIdAt(3),
      phase: 'publishing',
      frozenReceipt: {
        version: 2,
        studyId: studyIdAt(3),
        generation: 1,
        kind: 'create',
        researcherId: RESEARCHER,
        resolution: 'create-complete',
        createdAt: NOW,
      },
    });
    const platform = fakePlatform({ wire: registryPairs([reserving, resolving, publishing]) });

    const result = await reconcilePendingStudyOperations({
      researcherId: RESEARCHER,
      now: NOW,
      platform,
    });

    expect(result).toMatchObject({ status: 'ok', examined: 3, repaired: 3, stillPending: 0 });
    expect(platformMock.recoverReservingStudyOperation).toHaveBeenCalledTimes(1);
    expect(platformMock.recoverReservingStudyOperation.mock.calls[0][0].studyId).toBe(studyIdAt(1));
    expect(platformMock.resolveStudyOperationV2).toHaveBeenCalledTimes(1);
    expect(platformMock.resolveStudyOperationV2.mock.calls[0][0]).toMatchObject({
      studyId: studyIdAt(2),
    });
    expect(platformMock.publishStudyOperationV2).toHaveBeenCalled();
    expect(kvMock.settleStudyOperationMutation).not.toHaveBeenCalled();
    expect(cryptoMock.decrypt).not.toHaveBeenCalled();
    expect(platformMock.getResearcherByIdChecked).not.toHaveBeenCalled();
  });

  it('leaves another researcher pending untouched and does not decrypt', async () => {
    const foreign = operation({
      studyId: studyIdAt(1),
      phase: 'pending',
      researcherId: OTHER,
      updatedAt: 1,
    });
    const platform = fakePlatform({ wire: registryPairs([foreign]) });

    const result = await reconcilePendingStudyOperations({
      researcherId: RESEARCHER,
      now: NOW,
      platform,
    });

    expect(result.stillPending).toBe(1);
    expect(kvMock.settleStudyOperationMutation).not.toHaveBeenCalled();
    expect(cryptoMock.decrypt).not.toHaveBeenCalled();
    expect(platformMock.resolveStudyOperationV2).not.toHaveBeenCalled();
  });

  it('does not infer BYOS absence while the caller pending record is inside grace', async () => {
    const fresh = operation({
      studyId: studyIdAt(1),
      phase: 'pending',
      updatedAt: NOW - 1_000,
    });
    const platform = fakePlatform({ wire: registryPairs([fresh]) });

    const result = await reconcilePendingStudyOperations({
      researcherId: RESEARCHER,
      now: NOW,
      platform,
    });

    expect(result.stillPending).toBe(1);
    expect(kvMock.settleStudyOperationMutation).not.toHaveBeenCalled();
    expect(cryptoMock.decrypt).not.toHaveBeenCalled();
  });

  it('acquires only Redis credentials for the caller pending record and never AI keys', async () => {
    const pending = operation({
      studyId: studyIdAt(1),
      phase: 'pending',
      updatedAt: 1,
    });
    const platform = fakePlatform({ wire: registryPairs([pending]) });

    const result = await reconcilePendingStudyOperations({
      researcherId: RESEARCHER,
      now: NOW,
      platform,
    });

    expect(result).toMatchObject({ status: 'ok', examined: 1, completed: 1, rolledBack: 0 });
    expect(cryptoMock.decrypt.mock.calls.map((call) => (
      call[1] as { purpose: string }
    ).purpose)).toEqual([
      'redis-url',
      'redis-token',
    ]);
    expect(kvClientMock.getResearcherClient).toHaveBeenCalledTimes(1);
    expect(kvMock.settleStudyOperationMutation).toHaveBeenCalledWith(
      'create',
      studyIdAt(1),
      `create:${studyIdAt(1)}:1`,
      BYOS,
    );
    expect(platformMock.resolveStudyOperationV2).toHaveBeenCalledWith(
      expect.objectContaining({ resolution: 'create-complete', storageId: STORAGE_ID }),
    );
  });

  it('rolls back a pending delete when deleteStudy reports cancellation', async () => {
    byosMembers([]);
    kvMock.deleteStudy.mockResolvedValue({
      status: 'cancelled',
      success: false,
      error: 'Study operation cancelled',
    });
    const pending = operation({
      studyId: studyIdAt(1),
      phase: 'pending',
      kind: 'delete',
      updatedAt: 1,
    });
    const platform = fakePlatform({ wire: registryPairs([pending]) });

    const result = await reconcilePendingStudyOperations({
      researcherId: RESEARCHER,
      now: NOW,
      platform,
    });

    expect(result.rolledBack).toBe(1);
    expect(platformMock.resolveStudyOperationV2).toHaveBeenCalledWith(
      expect.objectContaining({ resolution: 'delete-rollback' }),
    );
    expect(kvMock.settleStudyOperationMutation).not.toHaveBeenCalled();
  });

  it('finish-then-deletes a pending delete: matching persist guards are finished before deleteStudy', async () => {
    // Regression for review P0-2: a persist-guard backed up a pending delete
    // must be Finished (guard removed) before deleteStudy, with zero
    // SETTLE_STUDY_OPERATION_SCRIPT cancellation.
    const guardId = 'int-1';
    const guard = {
      version: 2,
      studyId: studyIdAt(1),
      interviewId: guardId,
      generation: 1,
      markerId: 'marker',
      deploymentMode: 'hosted' as const,
      ratePlan: [],
    };
    byosMembers([guardId]);
    (BYOS as unknown as { get: ReturnType<typeof vi.fn> }).get.mockResolvedValue('oi:pguard:{"version":2}');
    kvMock.parsePersistingGuard.mockReturnValue(guard);
    kvMock.persistCompletedInterviewFinish.mockResolvedValue({ status: 'created' });
    kvMock.deleteStudy.mockResolvedValue({ status: 'deleted', success: true });

    const pending = operation({
      studyId: studyIdAt(1),
      phase: 'pending',
      kind: 'delete',
      updatedAt: 1,
    });
    const platform = fakePlatform({ wire: registryPairs([pending]) });

    const result = await reconcilePendingStudyOperations({
      researcherId: RESEARCHER,
      now: NOW,
      platform,
    });

    expect(result).toMatchObject({ status: 'ok', completed: 1, rolledBack: 0 });
    expect(kvMock.persistCompletedInterviewFinish).toHaveBeenCalledWith(guard, BYOS);
    expect(kvMock.deleteStudy).toHaveBeenCalledWith(studyIdAt(1), BYOS, `delete:${studyIdAt(1)}:1`);
    expect(
      kvMock.persistCompletedInterviewFinish.mock.invocationCallOrder[0],
    ).toBeLessThan(kvMock.deleteStudy.mock.invocationCallOrder[0]);
    expect(kvMock.settleStudyOperationMutation).not.toHaveBeenCalled();
    expect(platformMock.resolveStudyOperationV2).toHaveBeenCalledWith(
      expect.objectContaining({ resolution: 'delete-complete' }),
    );
  });

  it('leaves a pending delete pending when deleteStudy is still-pending without rolling back authority', async () => {
    byosMembers([]);
    kvMock.deleteStudy.mockResolvedValue({
      status: 'still-pending',
      success: false,
      error: 'STUDY_PERSIST_PENDING',
    });
    const pending = operation({
      studyId: studyIdAt(1),
      phase: 'pending',
      kind: 'delete',
      updatedAt: 1,
    });
    const platform = fakePlatform({ wire: registryPairs([pending]) });

    const result = await reconcilePendingStudyOperations({
      researcherId: RESEARCHER,
      now: NOW,
      platform,
    });

    expect(result).toMatchObject({ status: 'ok', stillPending: 1, rolledBack: 0 });
    expect(platformMock.resolveStudyOperationV2).not.toHaveBeenCalled();
    expect(kvMock.settleStudyOperationMutation).not.toHaveBeenCalled();
  });

  it('keeps a pending record when BYOS cannot be read', async () => {
    kvMock.settleStudyOperationMutation.mockResolvedValue('unavailable');
    const pending = operation({
      studyId: studyIdAt(1),
      phase: 'pending',
      updatedAt: 1,
    });
    const platform = fakePlatform({ wire: registryPairs([pending]) });

    const result = await reconcilePendingStudyOperations({
      researcherId: RESEARCHER,
      now: NOW,
      platform,
    });

    expect(result.stillPending).toBe(1);
    expect(platformMock.resolveStudyOperationV2).not.toHaveBeenCalled();
  });

  it('processes all 100 bounded fields in one invocation', async () => {
    const ops = Array.from({ length: 100 }, (_, index) => operation({
      studyId: studyIdAt(index),
      phase: 'reserving',
    }));
    const platform = fakePlatform({ wire: registryPairs(ops) });

    const result = await reconcilePendingStudyOperations({
      researcherId: RESEARCHER,
      now: NOW,
      platform,
    });

    expect(result.examined).toBe(100);
    expect(result.repaired).toBe(100);
    expect(platformMock.recoverReservingStudyOperation).toHaveBeenCalledTimes(100);
  });

  it('rejects a registry leaf that is not a prefixed operation object', async () => {
    const platform = fakePlatform({
      wire: [studyIdAt(1), '{"version":2,"phase":"reserving"}'],
    });

    const result = await reconcilePendingStudyOperations({
      researcherId: RESEARCHER,
      now: NOW,
      platform,
    });

    expect(result.status).toBe('unavailable');
    expect(platformMock.recoverReservingStudyOperation).not.toHaveBeenCalled();
  });
});
