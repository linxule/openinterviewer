// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const modeMock = vi.hoisted(() => ({ isHostedMode: vi.fn() }));
vi.mock('@/lib/mode', () => modeMock);

const identityMock = vi.hoisted(() => ({
  getResearcherIdentity: vi.fn(),
  getRequestContext: vi.fn(),
}));
vi.mock('@/lib/researcherContext', () => identityMock);

const platformMock = vi.hoisted(() => ({
  consumePlatformRateLimit: vi.fn(),
}));
vi.mock('@/lib/platformDb', () => platformMock);

const schemaMock = vi.hoisted(() => ({
  ensurePlatformSchemaLineage: vi.fn(),
}));
vi.mock('@/lib/platformSchema', () => schemaMock);

const kvClientMock = vi.hoisted(() => ({
  getPlatformClient: vi.fn(),
}));
vi.mock('@/lib/kvClient', () => kvClientMock);

const reconcilerMock = vi.hoisted(() => ({
  reconcilePendingStudyOperations: vi.fn(),
}));
vi.mock('@/lib/studyOperationReconciler', () => reconcilerMock);

import { POST } from '@/app/api/studies/reconcile/route';

beforeEach(() => {
  vi.clearAllMocks();
  modeMock.isHostedMode.mockReturnValue(true);
  identityMock.getResearcherIdentity.mockResolvedValue({
    authorized: true,
    researcherId: 'researcher-a',
  });
  kvClientMock.getPlatformClient.mockReturnValue({ ping: vi.fn() });
  schemaMock.ensurePlatformSchemaLineage.mockResolvedValue('ok');
  platformMock.consumePlatformRateLimit.mockResolvedValue({ status: 'allowed', remaining: 29 });
  reconcilerMock.reconcilePendingStudyOperations.mockResolvedValue({
    status: 'ok',
    examined: 2,
    completed: 1,
    rolledBack: 0,
    stillPending: 0,
    invalid: 0,
    repaired: 1,
  });
});

describe('POST /api/studies/reconcile', () => {
  it('returns 404 outside hosted mode without reading identity or BYOS', async () => {
    modeMock.isHostedMode.mockReturnValue(false);

    const response = await POST();

    expect(response.status).toBe(404);
    expect(identityMock.getResearcherIdentity).not.toHaveBeenCalled();
    expect(identityMock.getRequestContext).not.toHaveBeenCalled();
    expect(kvClientMock.getPlatformClient).not.toHaveBeenCalled();
    expect(reconcilerMock.reconcilePendingStudyOperations).not.toHaveBeenCalled();
  });

  it('returns 401 from identity-only auth and never decrypts credentials', async () => {
    identityMock.getResearcherIdentity.mockResolvedValue({
      authorized: false,
      error: 'Unauthorized',
    });

    const response = await POST();

    expect(response.status).toBe(401);
    expect(identityMock.getRequestContext).not.toHaveBeenCalled();
    expect(schemaMock.ensurePlatformSchemaLineage).not.toHaveBeenCalled();
    expect(platformMock.consumePlatformRateLimit).not.toHaveBeenCalled();
    expect(reconcilerMock.reconcilePendingStudyOperations).not.toHaveBeenCalled();
  });

  it('returns 503 schema-hold before rate limit or registry load', async () => {
    schemaMock.ensurePlatformSchemaLineage.mockResolvedValue('hold');

    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      error: 'Platform schema is not ready',
      retryable: false,
      reason: 'schema-hold',
    });
    expect(platformMock.consumePlatformRateLimit).not.toHaveBeenCalled();
    expect(reconcilerMock.reconcilePendingStudyOperations).not.toHaveBeenCalled();
  });

  it('returns 429 when the reconcile family is limited', async () => {
    platformMock.consumePlatformRateLimit.mockResolvedValue({
      status: 'limited',
      retryAfterSeconds: 12,
    });

    const response = await POST();

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('12');
    expect(reconcilerMock.reconcilePendingStudyOperations).not.toHaveBeenCalled();
  });

  it('returns 503 when lineage, rate limit, or reconcile is unavailable', async () => {
    kvClientMock.getPlatformClient.mockImplementation(() => {
      throw new Error('missing platform');
    });
    await expect(POST()).resolves.toMatchObject({ status: 503 });

    kvClientMock.getPlatformClient.mockReturnValue({ ping: vi.fn() });
    platformMock.consumePlatformRateLimit.mockResolvedValue({ status: 'unavailable' });
    await expect(POST()).resolves.toMatchObject({ status: 503 });

    platformMock.consumePlatformRateLimit.mockResolvedValue({ status: 'allowed', remaining: 1 });
    reconcilerMock.reconcilePendingStudyOperations.mockResolvedValue({
      status: 'unavailable',
      examined: 0,
      completed: 0,
      rolledBack: 0,
      stillPending: 0,
      invalid: 0,
      repaired: 0,
    });
    await expect(POST()).resolves.toMatchObject({ status: 503 });
    expect(identityMock.getRequestContext).not.toHaveBeenCalled();
  });

  it('returns 200 and only passes researcherId into the reconciler', async () => {
    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      status: 'ok',
      examined: 2,
      completed: 1,
      rolledBack: 0,
      stillPending: 0,
      invalid: 0,
      repaired: 1,
    });
    expect(reconcilerMock.reconcilePendingStudyOperations).toHaveBeenCalledWith({
      researcherId: 'researcher-a',
    });
    expect(identityMock.getRequestContext).not.toHaveBeenCalled();
  });
});
