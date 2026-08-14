import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStudyConfig } from '../fixtures/models';

const contextMock = vi.hoisted(() => ({ getRequestContext: vi.fn() }));
vi.mock('@/lib/researcherContext', () => contextMock);

const kvMock = vi.hoisted(() => ({
  createStudyAtomic: vi.fn(),
  getAllStudies: vi.fn(),
  isKVAvailable: vi.fn(),
  studyOperationMarkerId: vi.fn((id: string, createdAt: number) => `${id}:${createdAt}`),
}));
vi.mock('@/lib/kv', () => kvMock);

const platformMock = vi.hoisted(() => ({
  beginCreateStudyOperation: vi.fn(),
  consumePlatformRateLimit: vi.fn(),
  resolveStudyOperation: vi.fn(),
}));
vi.mock('@/lib/platformDb', () => platformMock);

const modeMock = vi.hoisted(() => ({ isHostedMode: vi.fn() }));
vi.mock('@/lib/mode', () => modeMock);

import { POST } from '@/app/api/studies/route';

const request = () => new Request('http://localhost/api/studies', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ config: makeStudyConfig() }),
});

beforeEach(() => {
  vi.clearAllMocks();
  contextMock.getRequestContext.mockResolvedValue({
    authorized: true,
    context: { kvClient: {} },
    researcherId: 'researcher-a',
  });
  kvMock.isKVAvailable.mockResolvedValue(true);
  kvMock.createStudyAtomic.mockResolvedValue('created');
  platformMock.consumePlatformRateLimit.mockResolvedValue({ status: 'allowed', remaining: 99 });
  platformMock.beginCreateStudyOperation.mockImplementation((studyId: string, researcherId: string) => ({
    status: 'started',
    operation: {
      version: 1,
      id: `create:${studyId}`,
      kind: 'create',
      researcherId,
      studyId,
      createdAt: 1,
      updatedAt: 1,
    },
  }));
  platformMock.resolveStudyOperation.mockResolvedValue('resolved');
});

describe('hosted study creation ownership saga', () => {
  it('does not create researcher data when the durable operation cannot begin', async () => {
    modeMock.isHostedMode.mockReturnValue(true);
    platformMock.beginCreateStudyOperation.mockResolvedValue({ status: 'unavailable' });

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(kvMock.createStudyAtomic).not.toHaveBeenCalled();
  });

  it('enforces a lifetime ownership quota before touching researcher storage', async () => {
    modeMock.isHostedMode.mockReturnValue(true);
    platformMock.beginCreateStudyOperation.mockResolvedValue({ status: 'study-quota-exceeded' });

    const response = await POST(request());

    expect(response.status).toBe(409);
    expect(kvMock.createStudyAtomic).not.toHaveBeenCalled();
  });

  it('fails closed when the platform creation limiter is unavailable', async () => {
    modeMock.isHostedMode.mockReturnValue(true);
    platformMock.consumePlatformRateLimit.mockResolvedValue({ status: 'unavailable' });

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(platformMock.beginCreateStudyOperation).not.toHaveBeenCalled();
    expect(kvMock.createStudyAtomic).not.toHaveBeenCalled();
  });

  it('keeps the durable operation pending when researcher storage is unavailable', async () => {
    modeMock.isHostedMode.mockReturnValue(true);
    kvMock.createStudyAtomic.mockResolvedValue('unavailable');

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(503);
    const studyId = platformMock.beginCreateStudyOperation.mock.calls[0][0];
    expect(body.operationId).toBe(`create:${studyId}`);
  expect(platformMock.resolveStudyOperation).not.toHaveBeenCalled();
  });

  it('does not reissue BYOS creation for an operation already being reconciled', async () => {
    modeMock.isHostedMode.mockReturnValue(true);
    platformMock.beginCreateStudyOperation.mockImplementation((studyId: string, researcherId: string) => ({
      status: 'already-pending',
      operation: {
        version: 1, id: `create:${studyId}`, kind: 'create', researcherId, studyId,
        createdAt: 1, updatedAt: 1,
      },
    }));

    const response = await POST(request());

    expect(response.status).toBe(202);
    expect(kvMock.createStudyAtomic).not.toHaveBeenCalled();
    expect(platformMock.resolveStudyOperation).not.toHaveBeenCalled();
  });

  it('finalizes the durable operation after researcher storage confirms creation', async () => {
    modeMock.isHostedMode.mockReturnValue(true);

    const response = await POST(request());

    expect(response.status).toBe(200);
    const operation = platformMock.beginCreateStudyOperation.mock.results[0].value.operation;
    expect(kvMock.createStudyAtomic).toHaveBeenCalledWith(
      expect.objectContaining({ id: operation.studyId }),
      {},
      `${operation.id}:${operation.createdAt}`
    );
    expect(platformMock.resolveStudyOperation).toHaveBeenCalledWith(
      operation,
      'create-complete'
    );
  });

  it('returns accepted when storage succeeded but operation finalization is unavailable', async () => {
    modeMock.isHostedMode.mockReturnValue(true);
    platformMock.resolveStudyOperation.mockResolvedValue('unavailable');

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body.reconciliationPending).toBe(true);
    expect(body.operationId).toMatch(/^create:/);
  });

  it('creates standalone studies without platform ownership writes', async () => {
    modeMock.isHostedMode.mockReturnValue(false);

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(platformMock.beginCreateStudyOperation).not.toHaveBeenCalled();
    expect(platformMock.resolveStudyOperation).not.toHaveBeenCalled();
    expect(kvMock.createStudyAtomic).toHaveBeenCalledTimes(1);
  });
});
