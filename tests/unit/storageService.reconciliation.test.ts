import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deleteStudy,
  exportAllInterviews,
  getAllStudies,
  getInterview,
  readStudy,
  reconcileStudyOperations,
  ResearcherStorageUnavailableError,
  StudyOperationPendingError,
  saveStudy,
} from '@/services/storageService';
import { makeStudyConfig } from '../fixtures/models';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('hosted study operation client contract', () => {
  it('forwards populated deletion confirmation, retaining a body-free empty-only legacy request', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await deleteStudy('study-a');
    expect(fetchMock.mock.calls[0]).toEqual(['/api/studies/study-a', { method: 'DELETE' }]);
    const confirmation = { deleteInterviews: true as const, confirmStudyId: 'study-a', expectedRevision: 3 };
    await deleteStudy('study-a', confirmation);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual(confirmation);
    expect(fetchMock.mock.calls[1][1].headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('forwards the revision actually reviewed with a configuration edit', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'The study changed.' }), { status: 409 }));
    vi.stubGlobal('fetch', fetchMock);
    await saveStudy({ config: makeStudyConfig(), updateStudyId: 'study-a', expectedRevision: 3, confirmed: true });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ expectedRevision: 3, confirmed: true });
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('Idempotency-Key');
  });
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

  it('reports STUDY_OPERATION_PENDING from study and interview reads', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      error: 'A study operation is already in progress.',
      code: 'STUDY_OPERATION_PENDING',
    }), { status: 409, headers: { 'Content-Type': 'application/json' } }))));

    await expect(readStudy('study-a')).resolves.toEqual({
      status: 'pending',
      error: 'A study operation is already in progress.',
    });
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
