import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredStudy, makeStudyConfig } from '../fixtures/models';

const contextMock = vi.hoisted(() => ({
  getRequestContext: vi.fn(),
  getHostedResearcherIdentity: vi.fn(),
}));
vi.mock('@/lib/researcherContext', () => contextMock);

const kvMock = vi.hoisted(() => ({
  createStudyAtomic: vi.fn(),
  deleteStudy: vi.fn(),
  getStudy: vi.fn(),
  isKVAvailable: vi.fn(),
  replaceStudyConfigAtomic: vi.fn(),
  setStudyLinksEnabled: vi.fn(),
  studyOperationMarkerId: vi.fn((id: string, createdAt: number) => `${id}:${createdAt}`),
}));
vi.mock('@/lib/kv', () => kvMock);

const STORAGE_ID = 'a'.repeat(64);
const DELETE_STUDY_ID = '11111111-1111-4111-8111-111111111111';
const platformMock = vi.hoisted(() => ({
  beginCreateStudyOperationV2: vi.fn(),
  beginDeleteStudyOperationV2: vi.fn(),
  consumePlatformRateLimit: vi.fn(),
  getResearcherByIdChecked: vi.fn(),
  loadResearcherStorageBinding: vi.fn(),
  publishStudyOperationV2: vi.fn(),
  resolveStudyOperationV2: vi.fn(),
}));
vi.mock('@/lib/platformDb', () => platformMock);

const idempMock = vi.hoisted(() => ({
  beginCreateIdempotency: vi.fn(),
  casCreateIdempotencyState: vi.fn(),
  attachCreateIdempotencyOperation: vi.fn(),
  resolveCreateIdempotencyClient: vi.fn(() => ({})),
}));
vi.mock('@/lib/createIdempotency', async () => {
  const actual = await vi.importActual<typeof import('@/lib/createIdempotency')>('@/lib/createIdempotency');
  return {
    ...actual,
    beginCreateIdempotency: idempMock.beginCreateIdempotency,
    casCreateIdempotencyState: idempMock.casCreateIdempotencyState,
    attachCreateIdempotencyOperation: idempMock.attachCreateIdempotencyOperation,
    resolveCreateIdempotencyClient: idempMock.resolveCreateIdempotencyClient,
  };
});

const modeMock = vi.hoisted(() => ({ isHostedMode: vi.fn() }));
vi.mock('@/lib/mode', () => modeMock);

const kvClientMock = vi.hoisted(() => ({ getPlatformClient: vi.fn(() => ({})) }));
vi.mock('@/lib/kvClient', () => kvClientMock);

import { POST } from '@/app/api/studies/route';
import { DELETE } from '@/app/api/studies/[id]/route';

const operation = {
  version: 2 as const,
  id: `delete:${DELETE_STUDY_ID}:1`,
  kind: 'delete' as const,
  phase: 'pending' as const,
  researcherId: 'researcher-a',
  studyId: DELETE_STUDY_ID,
  generation: 1,
  opNonce: 'ab'.repeat(16),
  createdAt: 1,
  updatedAt: 1,
  idempotencyHash: null,
  fingerprint: null,
  frozenReceipt: null,
};

const request = new Request(`http://localhost/api/studies/${DELETE_STUDY_ID}`, {
  method: 'DELETE',
});
const routeContext = { params: Promise.resolve({ id: DELETE_STUDY_ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  modeMock.isHostedMode.mockReturnValue(true);
  contextMock.getRequestContext.mockResolvedValue({
    authorized: true,
    context: {
      kvClient: {},
      geminiApiKey: 'gemini-key',
      anthropicApiKey: null,
      openaiApiKey: null,
      openrouterApiKey: null,
    },
    researcherId: 'researcher-a',
  });
  contextMock.getHostedResearcherIdentity.mockResolvedValue({
    authorized: true,
    researcherId: 'researcher-a',
  });
  platformMock.getResearcherByIdChecked.mockResolvedValue({
    status: 'found',
    researcher: {
      id: 'researcher-a',
      onboardingComplete: true,
      encryptedRedisUrl: 'enc-url',
      encryptedRedisToken: 'enc-token',
      encryptedGeminiApiKey: 'enc-gemini',
      encryptedAnthropicApiKey: null,
      encryptedOpenAiApiKey: null,
      encryptedOpenRouterApiKey: null,
    },
  });
  kvMock.isKVAvailable.mockResolvedValue(true);
  kvMock.getStudy.mockResolvedValue(makeStoredStudy({ id: DELETE_STUDY_ID }));
  kvMock.deleteStudy.mockResolvedValue({ success: true });
  kvMock.createStudyAtomic.mockResolvedValue('created');
  platformMock.beginDeleteStudyOperationV2.mockResolvedValue({ status: 'started', operation });
  platformMock.consumePlatformRateLimit.mockResolvedValue({ status: 'allowed', remaining: 99 });
  platformMock.loadResearcherStorageBinding.mockResolvedValue({
    status: 'ok',
    binding: {
      version: 2,
      researcherId: 'researcher-a',
      storageId: STORAGE_ID,
      originHash: 'b'.repeat(64),
      credentialRevision: 1,
      bindingEpoch: 1,
      cipherSnapshot: 'cipher',
    },
  });
  platformMock.beginCreateStudyOperationV2.mockImplementation((input: { studyId: string; researcherId: string }) => ({
    status: 'started',
    operation: {
      version: 2,
      id: `create:${input.studyId}:1`,
      kind: 'create',
      phase: 'pending',
      researcherId: input.researcherId,
      studyId: input.studyId,
      generation: 1,
      opNonce: 'ab'.repeat(16),
      createdAt: 1,
      updatedAt: 1,
      idempotencyHash: 'f'.repeat(64),
      fingerprint: 'e'.repeat(64),
      frozenReceipt: null,
    },
  }));
  platformMock.resolveStudyOperationV2.mockResolvedValue({
    status: 'publishing',
    operation: { frozenReceipt: { resolution: 'create-complete', createdAt: 1 } },
  });
  platformMock.publishStudyOperationV2.mockResolvedValue({ status: 'published', zaddDelta: 1 });
  idempMock.beginCreateIdempotency.mockImplementation(async (opts: { mintStudy: () => { id: string; createdAt: number; updatedAt: number } }) => {
    const study = opts.mintStudy();
    return {
      status: 'started',
      record: {
        version: 2,
        researcherId: 'researcher-a',
        studyId: study.id,
        createdAt: study.createdAt,
        updatedAt: study.updatedAt,
        fingerprint: 'f'.repeat(64),
        state: 'pending',
        operationId: null,
        study,
      },
    };
  });
  idempMock.casCreateIdempotencyState.mockResolvedValue({ status: 'ok' });
  idempMock.attachCreateIdempotencyOperation.mockResolvedValue({ status: 'ok' });
});

describe('hosted study deletion operation saga', () => {
  it('loads the storage binding, begins v2, then mutates BYOS, then resolve/publish', async () => {
    const response = await DELETE(request, routeContext);

    expect(response.status).toBe(200);
    expect(kvMock.getStudy).not.toHaveBeenCalled();
    expect(platformMock.loadResearcherStorageBinding).toHaveBeenCalledWith('researcher-a');
    expect(platformMock.beginDeleteStudyOperationV2).toHaveBeenCalledWith(
      expect.objectContaining({
        researcherId: 'researcher-a',
        studyId: DELETE_STUDY_ID,
        storageId: STORAGE_ID,
        generation: 1,
        bindingEpoch: 1,
        idempotencyHash: null,
        fingerprint: null,
      }),
    );
    expect(platformMock.loadResearcherStorageBinding.mock.invocationCallOrder[0])
      .toBeLessThan(platformMock.beginDeleteStudyOperationV2.mock.invocationCallOrder[0]);
    expect(platformMock.beginDeleteStudyOperationV2.mock.invocationCallOrder[0])
      .toBeLessThan(kvMock.deleteStudy.mock.invocationCallOrder[0]);
    expect(kvMock.deleteStudy.mock.invocationCallOrder[0])
      .toBeLessThan(platformMock.resolveStudyOperationV2.mock.invocationCallOrder[0]);
    expect(platformMock.resolveStudyOperationV2.mock.invocationCallOrder[0])
      .toBeLessThan(platformMock.publishStudyOperationV2.mock.invocationCallOrder[0]);
    expect(kvMock.deleteStudy).toHaveBeenCalledWith(
      DELETE_STUDY_ID,
      {},
      `delete:${DELETE_STUDY_ID}:1`,
    );
    expect(platformMock.resolveStudyOperationV2).toHaveBeenCalledWith(
      expect.objectContaining({
        studyId: DELETE_STUDY_ID,
        storageId: STORAGE_ID,
        kind: 'delete',
        resolution: 'delete-complete',
      }),
    );
  });

  it('does not begin when the expected storage binding is missing', async () => {
    platformMock.loadResearcherStorageBinding.mockResolvedValue({ status: 'missing' });

    const response = await DELETE(request, routeContext);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ retryable: true, reason: 'unavailable' });
    expect(platformMock.beginDeleteStudyOperationV2).not.toHaveBeenCalled();
    expect(kvMock.deleteStudy).not.toHaveBeenCalled();
  });

  it('keeps authority pending when the delete result is ambiguous', async () => {
    kvMock.deleteStudy.mockResolvedValue({
      status: 'ambiguous',
      success: false,
      error: 'Failed to delete study',
      reason: 'ambiguous',
    });

    const response = await DELETE(request, routeContext);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({ retryable: true, reason: 'ambiguous' });
    expect(platformMock.resolveStudyOperationV2).not.toHaveBeenCalled();
    expect(platformMock.publishStudyOperationV2).not.toHaveBeenCalled();
  });

  it('returns 202 after begin when BYOS is unavailable', async () => {
    kvMock.deleteStudy.mockResolvedValue({
      status: 'unavailable',
      success: false,
      error: 'Failed to delete study',
    });

    const response = await DELETE(request, routeContext);
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body).toMatchObject({
      reconciliationPending: true,
      operationId: operation.id,
      studyId: DELETE_STUDY_ID,
      retryAfterSeconds: 5,
    });
    expect(platformMock.resolveStudyOperationV2).not.toHaveBeenCalled();
  });

  it('returns 202 after begin when persist-guard is still pending', async () => {
    kvMock.deleteStudy.mockResolvedValue({
      status: 'still-pending',
      success: false,
      error: 'STUDY_PERSIST_PENDING',
      code: 'STUDY_PERSIST_PENDING',
    });

    const response = await DELETE(request, routeContext);

    expect(response.status).toBe(202);
    expect(kvMock.deleteStudy).toHaveBeenCalled();
    expect(platformMock.resolveStudyOperationV2).not.toHaveBeenCalled();
  });

  it('does not reissue BYOS deletion for a begin replay', async () => {
    platformMock.beginDeleteStudyOperationV2.mockResolvedValue({
      status: 'replay',
      operation,
    });

    const response = await DELETE(request, routeContext);
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body.reconciliationPending).toBe(true);
    expect(body.operationId).toBe(operation.id);
    expect(kvMock.deleteStudy).not.toHaveBeenCalled();
    expect(platformMock.resolveStudyOperationV2).not.toHaveBeenCalled();
  });

  it('rolls back delete intent when interviews remain', async () => {
    kvMock.deleteStudy.mockResolvedValue({
      status: 'conflict',
      success: false,
      error: 'Cannot delete study with existing interviews',
    });

    const response = await DELETE(request, routeContext);

    expect(response.status).toBe(409);
    expect(platformMock.resolveStudyOperationV2).toHaveBeenCalledWith(
      expect.objectContaining({ resolution: 'delete-rollback', kind: 'delete' }),
    );
    expect(platformMock.publishStudyOperationV2).toHaveBeenCalled();
  });

  it('completes authority deletion when the BYOS script confirms absence', async () => {
    kvMock.deleteStudy.mockResolvedValue({
      status: 'not-found',
      success: false,
      error: 'Study not found',
    });

    const response = await DELETE(request, routeContext);

    expect(response.status).toBe(200);
    expect(platformMock.resolveStudyOperationV2).toHaveBeenCalledWith(
      expect.objectContaining({ resolution: 'delete-complete', kind: 'delete' }),
    );
  });

  it('returns accepted when BYOS deleted but platform finalization is unavailable', async () => {
    platformMock.resolveStudyOperationV2.mockResolvedValue({ status: 'unavailable' });

    const response = await DELETE(request, routeContext);
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body.reconciliationPending).toBe(true);
    expect(body.operationId).toBe(operation.id);
    expect(platformMock.publishStudyOperationV2).not.toHaveBeenCalled();
  });

  it('does not touch BYOS when platform ownership belongs to another account', async () => {
    platformMock.beginDeleteStudyOperationV2.mockResolvedValue({ status: 'owner' });

    const response = await DELETE(request, routeContext);

    expect(response.status).toBe(403);
    expect(kvMock.deleteStudy).not.toHaveBeenCalled();
  });

  it('returns 404 when ownership is missing', async () => {
    platformMock.beginDeleteStudyOperationV2.mockResolvedValue({ status: 'notfound' });

    const response = await DELETE(request, routeContext);

    expect(response.status).toBe(404);
    expect(kvMock.deleteStudy).not.toHaveBeenCalled();
  });
});

describe('hosted study creation operation saga', () => {
  const createRequest = () => new Request('http://localhost/api/studies', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': '11111111-1111-4111-8111-111111111111',
    },
    body: JSON.stringify({ config: makeStudyConfig() }),
  });

  it('runs begin then BYOS then resolve then publish on the minted studyId', async () => {
    const response = await POST(createRequest());
    expect(response.status).toBe(200);
    const begun = platformMock.beginCreateStudyOperationV2.mock.calls[0][0];
    expect(kvMock.createStudyAtomic.mock.calls[0][0].id).toBe(begun.studyId);
    const minted = begun.studyId;
    expect(platformMock.beginCreateStudyOperationV2.mock.invocationCallOrder[0])
      .toBeLessThan(kvMock.createStudyAtomic.mock.invocationCallOrder[0]);
    expect(kvMock.createStudyAtomic.mock.invocationCallOrder[0])
      .toBeLessThan(platformMock.resolveStudyOperationV2.mock.invocationCallOrder[0]);
    expect(platformMock.resolveStudyOperationV2.mock.invocationCallOrder[0])
      .toBeLessThan(platformMock.publishStudyOperationV2.mock.invocationCallOrder[0]);
    expect(platformMock.resolveStudyOperationV2).toHaveBeenCalledWith(
      expect.objectContaining({ studyId: minted, resolution: 'create-complete' }),
    );
  });

  it('preserves 503 ambiguous after begin-started without resolving', async () => {
    kvMock.createStudyAtomic.mockResolvedValue('ambiguous');
    const response = await POST(createRequest());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ retryable: true, reason: 'ambiguous' });
    expect(platformMock.resolveStudyOperationV2).not.toHaveBeenCalled();
  });
});
