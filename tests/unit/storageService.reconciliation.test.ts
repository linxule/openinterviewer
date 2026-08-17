import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deleteStudy,
  exportAllInterviews,
  getAllStudies,
  getInterview,
  getStudy,
  reconcileStudyOperations,
  ResearcherStorageUnavailableError,
  StudyOperationPendingError,
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

  it('throws STUDY_OPERATION_PENDING from study and interview reads', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      error: 'A study operation is already in progress.',
      code: 'STUDY_OPERATION_PENDING',
    }), { status: 409, headers: { 'Content-Type': 'application/json' } }))));

    await expect(getStudy('study-a')).rejects.toBeInstanceOf(StudyOperationPendingError);
    await expect(getInterview('int-a', 'study-a')).rejects.toBeInstanceOf(StudyOperationPendingError);
  });


  it('types 409 live-only export as pending rather than empty success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'A study operation is already in progress.',
      code: 'STUDY_OPERATION_PENDING',
      retryable: true,
    }), { status: 409, headers: { 'Content-Type': 'application/json' } })));

    await expect(exportAllInterviews()).rejects.toBeInstanceOf(StudyOperationPendingError);
  });

  it('types 503 study list and export outcomes without inventing empty success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      error: 'Study storage is temporarily unavailable.',
      retryable: true,
    }), { status: 503, headers: { 'Content-Type': 'application/json' } }))));

    await expect(getAllStudies()).resolves.toMatchObject({
      studies: [],
      warning: 'Study storage is temporarily unavailable.',
      outcome: { status: 'unavailable', retryable: true },
    });
    await expect(exportAllInterviews()).rejects.toBeInstanceOf(ResearcherStorageUnavailableError);
  });
});
