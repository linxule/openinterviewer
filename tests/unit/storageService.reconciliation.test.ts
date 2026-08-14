import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deleteStudy,
  reconcileStudyOperations,
} from '@/services/storageService';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('hosted study operation client contract', () => {
  it('does not report a 202 delete as completed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      message: 'Study deletion is already awaiting reconciliation.',
      reconciliationPending: true,
      operationId: 'delete:study-a',
    }), { status: 202, headers: { 'Content-Type': 'application/json' } })));

    await expect(deleteStudy('study-a')).resolves.toEqual({
      success: false,
      pending: true,
      operationId: 'delete:study-a',
      error: 'Study deletion is already awaiting reconciliation.',
    });
  });

  it('treats an operation-bearing 503 as pending rather than a generic failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'Study deletion is awaiting reconciliation.',
      operationId: 'delete:study-a',
    }), { status: 503, headers: { 'Content-Type': 'application/json' } })));

    await expect(deleteStudy('study-a')).resolves.toMatchObject({
      success: false,
      pending: true,
      operationId: 'delete:study-a',
    });
  });

  it('exposes the bounded authenticated reconciliation endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'ok',
      completed: 1,
      rolledBack: 2,
      stillPending: 3,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(reconcileStudyOperations()).resolves.toEqual({
      success: true,
      completed: 1,
      rolledBack: 2,
      stillPending: 3,
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/studies/reconcile', { method: 'POST' });
  });
});
