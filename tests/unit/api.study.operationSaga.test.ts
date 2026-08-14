import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredStudy } from '../fixtures/models';

const contextMock = vi.hoisted(() => ({ getRequestContext: vi.fn() }));
vi.mock('@/lib/researcherContext', () => contextMock);

const kvMock = vi.hoisted(() => ({
  deleteStudy: vi.fn(),
  getStudy: vi.fn(),
  isKVAvailable: vi.fn(),
  replaceStudyConfigAtomic: vi.fn(),
  setStudyLinksEnabled: vi.fn(),
  studyOperationMarkerId: vi.fn((id: string, createdAt: number) => `${id}:${createdAt}`),
}));
vi.mock('@/lib/kv', () => kvMock);

const platformMock = vi.hoisted(() => ({
  beginDeleteStudyOperation: vi.fn(),
  resolveStudyOperation: vi.fn(),
}));
vi.mock('@/lib/platformDb', () => platformMock);

const modeMock = vi.hoisted(() => ({ isHostedMode: vi.fn() }));
vi.mock('@/lib/mode', () => modeMock);

import { DELETE } from '@/app/api/studies/[id]/route';

const operation = {
  version: 1 as const,
  id: 'delete:study-delete',
  kind: 'delete' as const,
  researcherId: 'researcher-a',
  studyId: 'study-delete',
  createdAt: 1,
  updatedAt: 1,
};

const request = new Request('http://localhost/api/studies/study-delete', {
  method: 'DELETE',
});
const routeContext = { params: Promise.resolve({ id: 'study-delete' }) };

beforeEach(() => {
  vi.clearAllMocks();
  modeMock.isHostedMode.mockReturnValue(true);
  contextMock.getRequestContext.mockResolvedValue({
    authorized: true,
    context: { kvClient: {} },
    researcherId: 'researcher-a',
  });
  kvMock.isKVAvailable.mockResolvedValue(true);
  kvMock.getStudy.mockResolvedValue(makeStoredStudy({ id: 'study-delete' }));
  kvMock.deleteStudy.mockResolvedValue({ success: true });
  platformMock.beginDeleteStudyOperation.mockResolvedValue({ status: 'started', operation });
  platformMock.resolveStudyOperation.mockResolvedValue('resolved');
});

describe('hosted study deletion operation saga', () => {
  it('records delete intent before touching researcher storage', async () => {
    const response = await DELETE(request, routeContext);

    expect(response.status).toBe(200);
    expect(platformMock.beginDeleteStudyOperation).toHaveBeenCalledWith(
      'study-delete',
      'researcher-a'
    );
    expect(platformMock.beginDeleteStudyOperation.mock.invocationCallOrder[0])
      .toBeLessThan(kvMock.deleteStudy.mock.invocationCallOrder[0]);
    expect(kvMock.deleteStudy).toHaveBeenCalledWith(
      'study-delete',
      {},
      'delete:study-delete:1'
    );
    expect(platformMock.resolveStudyOperation).toHaveBeenCalledWith(
      operation,
      'delete-complete'
    );
  });

  it('keeps authority pending when the delete result is ambiguous', async () => {
    kvMock.deleteStudy.mockResolvedValue({ success: false, error: 'Failed to delete study' });

    const response = await DELETE(request, routeContext);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.operationId).toBe('delete:study-delete');
    expect(platformMock.resolveStudyOperation).not.toHaveBeenCalled();
  });

  it('does not reissue BYOS deletion for an operation already being reconciled', async () => {
    platformMock.beginDeleteStudyOperation.mockResolvedValue({
      status: 'already-pending',
      operation,
    });

    const response = await DELETE(request, routeContext);

    expect(response.status).toBe(202);
    expect(kvMock.deleteStudy).not.toHaveBeenCalled();
    expect(platformMock.resolveStudyOperation).not.toHaveBeenCalled();
  });

  it('rolls back delete intent when researcher storage confirms the study remains', async () => {
    kvMock.deleteStudy.mockResolvedValue({
      success: false,
      error: 'Cannot delete study with existing interviews',
    });

    const response = await DELETE(request, routeContext);

    expect(response.status).toBe(400);
    expect(platformMock.resolveStudyOperation).toHaveBeenCalledWith(
      operation,
      'delete-rollback'
    );
  });

  it('completes authority deletion when the BYOS script confirms absence', async () => {
    kvMock.deleteStudy.mockResolvedValue({ success: false, error: 'Study not found' });

    const response = await DELETE(request, routeContext);

    expect(response.status).toBe(200);
    expect(platformMock.resolveStudyOperation).toHaveBeenCalledWith(
      operation,
      'delete-complete'
    );
  });

  it('returns accepted when BYOS is absent but platform finalization is unavailable', async () => {
    platformMock.resolveStudyOperation.mockResolvedValue('unavailable');

    const response = await DELETE(request, routeContext);
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body.reconciliationPending).toBe(true);
    expect(body.operationId).toBe('delete:study-delete');
  });

  it('does not touch BYOS when platform ownership belongs to another account', async () => {
    platformMock.beginDeleteStudyOperation.mockResolvedValue({ status: 'owner-conflict' });

    const response = await DELETE(request, routeContext);

    expect(response.status).toBe(403);
    expect(kvMock.deleteStudy).not.toHaveBeenCalled();
  });
});
