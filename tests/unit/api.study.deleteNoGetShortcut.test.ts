import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStudyConfig, makeStoredStudy } from '../fixtures/models';

const STUDY_ID = '11111111-1111-4111-8111-111111111111';

const contextMock = vi.hoisted(() => ({ getRequestContext: vi.fn() }));
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

const platformMock = vi.hoisted(() => ({
  beginCreateStudyOperationV2: vi.fn(),
  beginDeleteStudyOperationV2: vi.fn(),
  consumePlatformRateLimit: vi.fn(),
  loadResearcherStorageBinding: vi.fn(),
  publishStudyOperationV2: vi.fn(),
  resolveStudyOperationV2: vi.fn(),
}));
vi.mock('@/lib/platformDb', () => platformMock);

const modeMock = vi.hoisted(() => ({ isHostedMode: vi.fn() }));
vi.mock('@/lib/mode', () => modeMock);

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

import { DELETE } from '@/app/api/studies/[id]/route';
import { POST } from '@/app/api/studies/route';

const deleteRequest = new Request(`http://localhost/api/studies/${STUDY_ID}`, { method: 'DELETE' });
const routeContext = { params: Promise.resolve({ id: STUDY_ID }) };

function storedStudy() {
  return makeStoredStudy({
    id: STUDY_ID,
    createdAt: 42,
    updatedAt: 42,
    config: { ...makeStudyConfig(), id: STUDY_ID, createdAt: 42 },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  modeMock.isHostedMode.mockReturnValue(false);
  contextMock.getRequestContext.mockResolvedValue({
    authorized: true,
    context: {
      kvClient: { name: 'standalone-kv' },
      geminiApiKey: 'gemini-key',
      anthropicApiKey: null,
      openaiApiKey: null,
      openrouterApiKey: null,
    },
    researcherId: null,
  });
  kvMock.isKVAvailable.mockResolvedValue(true);
  kvMock.deleteStudy.mockResolvedValue({ status: 'deleted', success: true });
  kvMock.createStudyAtomic.mockResolvedValue('created');
  idempMock.casCreateIdempotencyState.mockResolvedValue({ status: 'ok' });
});

describe('DELETE /api/studies/[id] standalone — no getStudy shortcut', () => {
  it('does not pre-GET the study body', async () => {
    const response = await DELETE(deleteRequest, routeContext);
    const body = await response.json();

    expect(kvMock.getStudy).not.toHaveBeenCalled();
    expect(kvMock.deleteStudy).toHaveBeenCalledWith(
      STUDY_ID,
      { name: 'standalone-kv' },
      `delete:${STUDY_ID}:0`,
    );
    expect(platformMock.beginDeleteStudyOperationV2).not.toHaveBeenCalled();
    expect(platformMock.loadResearcherStorageBinding).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true });
  });

  it('replays a terminal deleted receipt as 200 { success:true }', async () => {
    kvMock.deleteStudy.mockResolvedValue({ status: 'deleted', success: true });
    const first = await DELETE(deleteRequest, routeContext);
    const second = await DELETE(deleteRequest, routeContext);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ success: true });
    expect(kvMock.getStudy).not.toHaveBeenCalled();
  });

  it('returns 404 when the wrapper reports not-found', async () => {
    kvMock.deleteStudy.mockResolvedValue({
      status: 'not-found',
      success: false,
      error: 'Study not found',
    });
    const response = await DELETE(deleteRequest, routeContext);
    expect(response.status).toBe(404);
    expect(kvMock.getStudy).not.toHaveBeenCalled();
  });

  it('returns 409 STUDY_PERSIST_PENDING without hosted begin', async () => {
    kvMock.deleteStudy.mockResolvedValue({
      status: 'still-pending',
      success: false,
      error: 'STUDY_PERSIST_PENDING',
      code: 'STUDY_PERSIST_PENDING',
    });
    const response = await DELETE(deleteRequest, routeContext);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: 'STUDY_PERSIST_PENDING' });
  });

  it('returns 409 when interviews exist', async () => {
    kvMock.deleteStudy.mockResolvedValue({
      status: 'conflict',
      success: false,
      error: 'Cannot delete study with existing interviews',
    });
    const response = await DELETE(deleteRequest, routeContext);
    expect(response.status).toBe(409);
  });

  it('fails closed on malformed/unavailable delete wires', async () => {
    kvMock.deleteStudy.mockResolvedValue({
      status: 'unavailable',
      success: false,
      error: 'Failed to delete study',
    });
    const response = await DELETE(deleteRequest, routeContext);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ retryable: true, reason: 'unavailable' });
  });

  it('fails closed on response-loss / ambiguous delete', async () => {
    kvMock.deleteStudy.mockResolvedValue({
      status: 'ambiguous',
      success: false,
      error: 'Failed to delete study',
      reason: 'ambiguous',
    });
    const response = await DELETE(deleteRequest, routeContext);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ retryable: true, reason: 'ambiguous' });
  });
});

describe('POST /api/studies standalone receipt replay', () => {
  it('re-enters create on pending mapping so S4 returns the same 200 study', async () => {
    const minted = storedStudy();
    idempMock.beginCreateIdempotency
      .mockResolvedValueOnce({
        status: 'started',
        record: {
          version: 2,
          researcherId: 'standalone',
          studyId: STUDY_ID,
          createdAt: 42,
          updatedAt: 42,
          fingerprint: 'a'.repeat(64),
          state: 'pending',
          operationId: null,
          study: minted,
        },
      })
      .mockResolvedValueOnce({
        status: 'replay',
        record: {
          version: 2,
          researcherId: 'standalone',
          studyId: STUDY_ID,
          createdAt: 42,
          updatedAt: 42,
          fingerprint: 'a'.repeat(64),
          state: 'pending',
          operationId: null,
          study: minted,
        },
      });

    const headers = {
      'Content-Type': 'application/json',
      'Idempotency-Key': '22222222-2222-4222-8222-222222222222',
    };
    const body = JSON.stringify({ config: makeStudyConfig({ aiProvider: 'gemini' }) });
    const first = await POST(new Request('http://localhost/api/studies', {
      method: 'POST',
      headers,
      body,
    }));
    const second = await POST(new Request('http://localhost/api/studies', {
      method: 'POST',
      headers,
      body,
    }));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await first.json()).study.id).toBe(STUDY_ID);
    expect((await second.json()).study.id).toBe(STUDY_ID);
    expect(kvMock.createStudyAtomic).toHaveBeenCalledTimes(2);
    expect(kvMock.createStudyAtomic.mock.calls[0][0].id).toBe(STUDY_ID);
    expect(kvMock.createStudyAtomic.mock.calls[1][0].id).toBe(STUDY_ID);
  });

  it('returns 503 ambiguous when standalone create response is lost', async () => {
    const minted = storedStudy();
    idempMock.beginCreateIdempotency.mockResolvedValue({
      status: 'started',
      record: {
        version: 2,
        researcherId: 'standalone',
        studyId: STUDY_ID,
        createdAt: 42,
        updatedAt: 42,
        fingerprint: 'a'.repeat(64),
        state: 'pending',
        operationId: null,
        study: minted,
      },
    });
    kvMock.createStudyAtomic.mockResolvedValue('ambiguous');

    const response = await POST(new Request('http://localhost/api/studies', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': '22222222-2222-4222-8222-222222222222',
      },
      body: JSON.stringify({ config: makeStudyConfig({ aiProvider: 'gemini' }) }),
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ retryable: true, reason: 'ambiguous' });
  });
});
