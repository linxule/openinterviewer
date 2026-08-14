import { beforeEach, describe, expect, it, vi } from 'vitest';

const kvMock = vi.hoisted(() => ({
  settleStudyOperationMutation: vi.fn(),
  studyOperationMarkerId: vi.fn((id: string, createdAt: number) => `${id}:${createdAt}`),
}));
vi.mock('@/lib/kv', () => kvMock);

const platformMock = vi.hoisted(() => ({
  getPendingStudyOperations: vi.fn(),
  resolveStudyOperation: vi.fn(),
}));
vi.mock('@/lib/platformDb', () => platformMock);

import { reconcilePendingStudyOperations } from '@/lib/studyOperationReconciler';

const createOperation = {
  version: 1 as const,
  id: 'create:study-create',
  kind: 'create' as const,
  researcherId: 'researcher-a',
  studyId: 'study-create',
  createdAt: 1,
  updatedAt: 1,
};
const deleteOperation = {
  version: 1 as const,
  id: 'delete:study-delete',
  kind: 'delete' as const,
  researcherId: 'researcher-a',
  studyId: 'study-delete',
  createdAt: 1,
  updatedAt: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  platformMock.getPendingStudyOperations.mockResolvedValue({
    status: 'ok',
    operations: [createOperation, deleteOperation],
    invalidCount: 0,
  });
  platformMock.resolveStudyOperation.mockResolvedValue('resolved');
});

describe('study operation reconciliation', () => {
  it('finishes or rolls back each operation from authoritative BYOS existence', async () => {
    kvMock.settleStudyOperationMutation.mockResolvedValue('mutation-applied');

    const result = await reconcilePendingStudyOperations('researcher-a', {} as never, 25, 0);

    expect(result).toEqual({
      status: 'ok',
      examined: 2,
      completed: 2,
      rolledBack: 0,
      stillPending: 0,
      invalid: 0,
    });
    expect(platformMock.resolveStudyOperation).toHaveBeenCalledWith(
      createOperation,
      'create-complete'
    );
    expect(platformMock.resolveStudyOperation).toHaveBeenCalledWith(
      deleteOperation,
      'delete-complete'
    );
  });

  it('uses inverse terminal actions when create is absent and delete remains', async () => {
    kvMock.settleStudyOperationMutation.mockResolvedValue('mutation-cancelled');

    const result = await reconcilePendingStudyOperations('researcher-a', {} as never, 25, 0);

    expect(result.rolledBack).toBe(2);
    expect(platformMock.resolveStudyOperation).toHaveBeenCalledWith(
      createOperation,
      'create-rollback'
    );
    expect(platformMock.resolveStudyOperation).toHaveBeenCalledWith(
      deleteOperation,
      'delete-rollback'
    );
  });

  it('leaves an operation pending when BYOS cannot be read', async () => {
    platformMock.getPendingStudyOperations.mockResolvedValue({
      status: 'ok', operations: [createOperation], invalidCount: 0,
    });
    kvMock.settleStudyOperationMutation.mockResolvedValue('unavailable');

    const result = await reconcilePendingStudyOperations('researcher-a', {} as never, 25, 0);

    expect(result.stillPending).toBe(1);
    expect(platformMock.resolveStudyOperation).not.toHaveBeenCalled();
  });

  it('does not infer absence while the original BYOS request may still be in flight', async () => {
    const freshOperation = {
      ...createOperation,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    platformMock.getPendingStudyOperations.mockResolvedValue({
      status: 'ok', operations: [freshOperation], invalidCount: 0,
    });

    const result = await reconcilePendingStudyOperations('researcher-a', {} as never);

    expect(result.stillPending).toBe(1);
    expect(kvMock.settleStudyOperationMutation).not.toHaveBeenCalled();
    expect(platformMock.resolveStudyOperation).not.toHaveBeenCalled();
  });

  it('fails closed when the platform operation index is unavailable', async () => {
    platformMock.getPendingStudyOperations.mockResolvedValue({ status: 'unavailable' });

    await expect(reconcilePendingStudyOperations('researcher-a', {} as never)).resolves.toEqual({
      status: 'unavailable',
      examined: 0,
      completed: 0,
      rolledBack: 0,
      stillPending: 0,
      invalid: 0,
    });
    expect(kvMock.settleStudyOperationMutation).not.toHaveBeenCalled();
  });
});
