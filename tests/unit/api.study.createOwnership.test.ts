import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStudyConfig } from '../fixtures/models';

const contextMock = vi.hoisted(() => ({
  getRequestContext: vi.fn(),
  getHostedResearcherIdentity: vi.fn(),
}));
vi.mock('@/lib/researcherContext', () => contextMock);

const kvMock = vi.hoisted(() => ({
  createStudyAtomic: vi.fn(),
  getAllStudies: vi.fn(),
  isKVAvailable: vi.fn(),
  studyOperationMarkerId: vi.fn((id: string, createdAt: number) => `${id}:${createdAt}`),
}));
vi.mock('@/lib/kv', () => kvMock);

const STORAGE_ID = 'a'.repeat(64);
const OP_NONCE = 'ab'.repeat(16);

const platformMock = vi.hoisted(() => ({
  beginCreateStudyOperationV2: vi.fn(),
  consumePlatformRateLimit: vi.fn(),
  getResearcherByIdChecked: vi.fn(),
  loadResearcherStorageBinding: vi.fn(),
  publishStudyOperationV2: vi.fn(),
  resolveStudyOperationV2: vi.fn(),
}));
vi.mock('@/lib/platformDb', () => platformMock);

const modeMock = vi.hoisted(() => ({ isHostedMode: vi.fn() }));
vi.mock('@/lib/mode', () => modeMock);

const kvClientMock = vi.hoisted(() => ({ getPlatformClient: vi.fn(() => ({})) }));
vi.mock('@/lib/kvClient', () => kvClientMock);

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

import { POST } from '@/app/api/studies/route';

const IDEMPOTENCY_KEY = '11111111-1111-4111-8111-111111111111';

function v2CreateOperation(studyId: string, researcherId: string) {
  return {
    version: 2 as const,
    id: `create:${studyId}:1` as const,
    kind: 'create' as const,
    phase: 'pending' as const,
    researcherId,
    studyId,
    generation: 1,
    opNonce: OP_NONCE,
    createdAt: 1,
    updatedAt: 1,
    idempotencyHash: 'f'.repeat(64),
    fingerprint: 'e'.repeat(64),
    frozenReceipt: null,
  };
}

const request = () => new Request('http://localhost/api/studies', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Idempotency-Key': IDEMPOTENCY_KEY,
  },
  body: JSON.stringify({ config: makeStudyConfig() }),
});

beforeEach(() => {
  vi.clearAllMocks();
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
  kvMock.createStudyAtomic.mockResolvedValue('created');
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
    operation: v2CreateOperation(input.studyId, input.researcherId),
  }));
  platformMock.resolveStudyOperationV2.mockImplementation(async (input: {
    studyId: string;
    researcherId: string;
    resolution: 'create-complete' | 'create-rollback';
  }) => ({
    status: 'publishing',
    operation: {
      ...v2CreateOperation(input.studyId, input.researcherId),
      phase: 'publishing',
      frozenReceipt: {
        version: 2,
        studyId: input.studyId,
        generation: 1,
        kind: 'create',
        researcherId: input.researcherId,
        resolution: input.resolution,
        createdAt: 1,
      },
    },
  }));
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

describe('hosted study creation ownership saga', () => {
  it('does not create researcher data when the durable operation cannot begin', async () => {
    modeMock.isHostedMode.mockReturnValue(true);
    platformMock.beginCreateStudyOperationV2.mockResolvedValue({ status: 'unavailable' });

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(kvMock.createStudyAtomic).not.toHaveBeenCalled();
  });

  it('enforces a lifetime ownership quota before touching researcher storage', async () => {
    modeMock.isHostedMode.mockReturnValue(true);
    platformMock.beginCreateStudyOperationV2.mockResolvedValue({ status: 'studyquota' });

    const response = await POST(request());

    expect(response.status).toBe(409);
    expect(kvMock.createStudyAtomic).not.toHaveBeenCalled();
  });

  it('fails closed when the platform creation limiter is unavailable', async () => {
    modeMock.isHostedMode.mockReturnValue(true);
    platformMock.consumePlatformRateLimit.mockResolvedValue({ status: 'unavailable' });

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(platformMock.beginCreateStudyOperationV2).not.toHaveBeenCalled();
    expect(kvMock.createStudyAtomic).not.toHaveBeenCalled();
  });

  it('keeps the durable operation pending when researcher storage is unavailable', async () => {
    modeMock.isHostedMode.mockReturnValue(true);
    kvMock.createStudyAtomic.mockResolvedValue('unavailable');

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(202);
    const studyId = platformMock.beginCreateStudyOperationV2.mock.calls[0][0].studyId;
    expect(body.operationId).toBe(`create:${studyId}:1`);
    expect(body.studyId).toBe(studyId);
    expect(body.reconciliationPending).toBe(true);
    expect(platformMock.resolveStudyOperationV2).not.toHaveBeenCalled();
    expect(platformMock.publishStudyOperationV2).not.toHaveBeenCalled();
  });

  it('does not reissue BYOS creation for an operation already being reconciled', async () => {
    modeMock.isHostedMode.mockReturnValue(true);
    platformMock.beginCreateStudyOperationV2.mockImplementation((input: { studyId: string; researcherId: string }) => ({
      status: 'replay',
      operation: v2CreateOperation(input.studyId, input.researcherId),
    }));

    const response = await POST(request());

    expect(response.status).toBe(202);
    expect(kvMock.createStudyAtomic).not.toHaveBeenCalled();
    expect(platformMock.resolveStudyOperationV2).not.toHaveBeenCalled();
    expect(platformMock.publishStudyOperationV2).not.toHaveBeenCalled();
  });

  it('finalizes the durable operation after researcher storage confirms creation', async () => {
    modeMock.isHostedMode.mockReturnValue(true);

    const response = await POST(request());

    expect(response.status).toBe(200);
    const operation = platformMock.beginCreateStudyOperationV2.mock.results[0].value.operation;
    expect(kvMock.createStudyAtomic).toHaveBeenCalledWith(
      expect.objectContaining({ id: operation.studyId }),
      {},
      `create:${operation.studyId}:${operation.createdAt}`,
      expect.objectContaining({ researcherId: 'researcher-a' }),
    );
    expect(platformMock.resolveStudyOperationV2).toHaveBeenCalledWith(
      expect.objectContaining({
        studyId: operation.studyId,
        storageId: STORAGE_ID,
        generation: 1,
        opNonce: OP_NONCE,
        resolution: 'create-complete',
      }),
    );
    expect(platformMock.publishStudyOperationV2).toHaveBeenCalledWith(
      expect.objectContaining({
        studyId: operation.studyId,
        generation: 1,
        resolution: 'create-complete',
      }),
    );
  });

  it('returns accepted when storage succeeded but operation finalization is unavailable', async () => {
    modeMock.isHostedMode.mockReturnValue(true);
    platformMock.resolveStudyOperationV2.mockResolvedValue({ status: 'unavailable' });

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body.reconciliationPending).toBe(true);
    expect(body.operationId).toMatch(/^create:/);
    expect(platformMock.publishStudyOperationV2).not.toHaveBeenCalled();
  });

  it('creates standalone studies without platform ownership writes', async () => {
    modeMock.isHostedMode.mockReturnValue(false);

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(platformMock.beginCreateStudyOperationV2).not.toHaveBeenCalled();
    expect(platformMock.resolveStudyOperationV2).not.toHaveBeenCalled();
    expect(platformMock.publishStudyOperationV2).not.toHaveBeenCalled();
    expect(kvMock.createStudyAtomic).toHaveBeenCalledTimes(1);
  });

  it('maps schema-hold and begin-ambiguous without touching BYOS', async () => {
    modeMock.isHostedMode.mockReturnValue(true);
    platformMock.beginCreateStudyOperationV2.mockResolvedValueOnce({ status: 'hold' });
    const hold = await POST(request());
    expect(hold.status).toBe(503);
    expect(await hold.json()).toEqual({ retryable: false, reason: 'schema-hold' });

    platformMock.beginCreateStudyOperationV2.mockResolvedValueOnce({ status: 'ambiguous' });
    const ambiguous = await POST(request());
    expect(ambiguous.status).toBe(503);
    expect(await ambiguous.json()).toEqual({ retryable: true, reason: 'ambiguous' });
    expect(kvMock.createStudyAtomic).not.toHaveBeenCalled();
  });

  it('rolls back and returns 409 when BYOS reports cancellation', async () => {
    modeMock.isHostedMode.mockReturnValue(true);
    kvMock.createStudyAtomic.mockResolvedValue('cancelled');

    const response = await POST(request());

    expect(response.status).toBe(409);
    expect(platformMock.resolveStudyOperationV2).toHaveBeenCalledWith(
      expect.objectContaining({ resolution: 'create-rollback' }),
    );
    expect(platformMock.publishStudyOperationV2).toHaveBeenCalledWith(
      expect.objectContaining({ resolution: 'create-rollback' }),
    );
  });

  it('keeps standalone cancellation at 409 without platform writes', async () => {
    modeMock.isHostedMode.mockReturnValue(false);
    kvMock.createStudyAtomic.mockResolvedValue('cancelled');

    const response = await POST(request());

    expect(response.status).toBe(409);
    expect(platformMock.beginCreateStudyOperationV2).not.toHaveBeenCalled();
    expect(platformMock.resolveStudyOperationV2).not.toHaveBeenCalled();
  });
});
