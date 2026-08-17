import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredStudy, makeStudyConfig } from '../fixtures/models';

const cookiesMock = vi.hoisted(() => ({ cookies: vi.fn() }));
vi.mock('next/headers', () => cookiesMock);

const authMock = vi.hoisted(() => ({
  verifySessionToken: vi.fn(),
  verifyParticipantToken: vi.fn(),
  SESSION_COOKIE_NAME: 'researcher-session',
}));
vi.mock('@/lib/auth', () => authMock);

const platformMock = vi.hoisted(() => ({
  getResearcherByIdChecked: vi.fn(),
  getStudyAuthorityChecked: vi.fn(),
  getStudyOwnerChecked: vi.fn(),
}));
vi.mock('@/lib/platformDb', () => platformMock);

const modeMock = vi.hoisted(() => ({
  isHostedMode: vi.fn(),
  isStandaloneMode: vi.fn(),
}));
vi.mock('@/lib/mode', () => modeMock);

const kvClientMock = vi.hoisted(() => ({
  getKVClient: vi.fn(),
  getResearcherClient: vi.fn(),
}));
vi.mock('@/lib/kvClient', () => kvClientMock);

const cryptoMock = vi.hoisted(() => ({ decrypt: vi.fn() }));
vi.mock('@/lib/crypto', () => cryptoMock);

const kvMock = vi.hoisted(() => ({ getStudy: vi.fn() }));
vi.mock('@/lib/kv', () => kvMock);

const participantLinksMock = vi.hoisted(() => ({ getParticipantLinkById: vi.fn() }));
vi.mock('@/lib/participantLinks', () => participantLinksMock);

import {
  getAuthorizedResearcherStudyContext,
  getParticipantRequestContext,
  presentStudyAuthority,
  resolveHostedResearcherStudyContext,
  resolveParticipantOrPreviewContext,
  selectedStudyIdFromParticipantBody,
} from '@/lib/researcherContext';

const OWNER = {
  version: 2 as const,
  researcherId: 'researcher-a',
  storageId: 'a'.repeat(64),
  generation: 1,
};

function expectNoByosWork() {
  expect(platformMock.getResearcherByIdChecked).not.toHaveBeenCalled();
  expect(cryptoMock.decrypt).not.toHaveBeenCalled();
  expect(kvClientMock.getResearcherClient).not.toHaveBeenCalled();
  expect(kvMock.getStudy).not.toHaveBeenCalled();
  expect(participantLinksMock.getParticipantLinkById).not.toHaveBeenCalled();
}

describe('presentStudyAuthority opaque participant vs researcher statuses', () => {
  it('maps live/deny/notfound/adel differently by audience', () => {
    expect(presentStudyAuthority({ status: 'live', phase: 'pending' }, 'researcher')).toMatchObject({
      ok: false,
      statusCode: 409,
      code: 'STUDY_OPERATION_PENDING',
    });
    expect(presentStudyAuthority({ status: 'live', phase: 'pending' }, 'participant')).toEqual({
      ok: false,
      statusCode: 404,
      error: 'This study is no longer active.',
    });
    const researcherDeny = presentStudyAuthority({ status: 'deny' }, 'researcher');
    const participantDeny = presentStudyAuthority({ status: 'deny' }, 'participant');
    const participantMissing = presentStudyAuthority({ status: 'notfound' }, 'participant');
    const researcherAdel = presentStudyAuthority({ status: 'adel' }, 'researcher');
    const participantAdel = presentStudyAuthority({ status: 'adel' }, 'participant');
    expect(researcherDeny).toMatchObject({ ok: false, statusCode: 403 });
    expect(participantDeny).toMatchObject({ ok: false, statusCode: 404 });
    expect(participantMissing).toMatchObject({ ok: false, statusCode: 404 });
    expect(researcherAdel).toMatchObject({ ok: false, statusCode: 503, retryable: true });
    expect(participantAdel).toMatchObject({ ok: false, statusCode: 503, retryable: true });
    if (!participantAdel.ok) expect(participantAdel.error).not.toMatch(/delet/i);
    expect(presentStudyAuthority({ status: 'allow', owner: OWNER }, 'researcher')).toEqual({
      ok: true,
      owner: OWNER,
    });
  });
});

describe('resolveHostedResearcherStudyContext authority-before-BYOS', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    modeMock.isHostedMode.mockReturnValue(true);
    modeMock.isStandaloneMode.mockReturnValue(false);
  });

  it('does not decrypt BYOS or open researcher Redis on live-op denial', async () => {
    platformMock.getStudyAuthorityChecked.mockResolvedValue({ status: 'live', phase: 'pending' });
    const result = await resolveHostedResearcherStudyContext({
      researcherId: 'researcher-a',
      studyId: '11111111-1111-4111-8111-111111111111',
      purpose: 'mutate-config',
    });
    expect(result).toMatchObject({
      authorized: false,
      context: null,
      statusCode: 409,
    });
    expectNoByosWork();
  });

  it('resolves BYOS only after allow', async () => {
    platformMock.getStudyAuthorityChecked.mockResolvedValue({ status: 'allow', owner: OWNER });
    platformMock.getResearcherByIdChecked.mockResolvedValue({
      status: 'found',
      researcher: {
        id: 'researcher-a',
        onboardingComplete: true,
        encryptedRedisUrl: 'enc-url',
        encryptedRedisToken: 'enc-token',
        encryptedGeminiApiKey: null,
        encryptedAnthropicApiKey: null,
        encryptedOpenAiApiKey: null,
        encryptedOpenRouterApiKey: null,
      },
    });
    cryptoMock.decrypt.mockImplementation((_value: string, meta: { purpose: string }) => {
      if (meta.purpose === 'redis-url') return 'https://example.upstash.io';
      if (meta.purpose === 'redis-token') return 'token';
      return null;
    });
    kvClientMock.getResearcherClient.mockReturnValue({ kind: 'byos' });

    const result = await resolveHostedResearcherStudyContext({
      researcherId: 'researcher-a',
      studyId: '11111111-1111-4111-8111-111111111111',
      purpose: 'read',
    });
    expect(result.authorized).toBe(true);
    expect(result.context?.kvClient).toEqual({ kind: 'byos' });
    expect(platformMock.getStudyAuthorityChecked.mock.invocationCallOrder[0])
      .toBeLessThan(platformMock.getResearcherByIdChecked.mock.invocationCallOrder[0]);
    expect(cryptoMock.decrypt).toHaveBeenCalled();
    expect(kvClientMock.getResearcherClient).toHaveBeenCalled();
  });

  it('authorizes from identity only and skips BYOS decrypt on deny', async () => {
    cookiesMock.cookies.mockResolvedValue({ get: vi.fn(() => ({ value: 'session' })) });
    authMock.verifySessionToken.mockResolvedValue({
      valid: true,
      researcherId: 'researcher-b',
      issuedAt: Math.floor(Date.now() / 1000),
    });
    platformMock.getStudyAuthorityChecked.mockResolvedValue({ status: 'deny' });
    const result = await getAuthorizedResearcherStudyContext(
      '11111111-1111-4111-8111-111111111111',
      'read',
    );
    expect(result).toMatchObject({ authorized: false, statusCode: 403 });
    expectNoByosWork();
  });
});

describe('getParticipantRequestContext hosted authority-before-BYOS', () => {
  const request = new Request('http://localhost/api/greeting', {
    method: 'POST',
    headers: { Authorization: 'Bearer token-x' },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    modeMock.isHostedMode.mockReturnValue(true);
    modeMock.isStandaloneMode.mockReturnValue(false);
    cookiesMock.cookies.mockResolvedValue({ get: vi.fn() });
    authMock.verifyParticipantToken.mockResolvedValue({
      valid: true,
      studyId: '11111111-1111-4111-8111-111111111111',
      linkId: 'b'.repeat(64),
      sessionId: 'session-a',
      studyRevision: 1,
      researcherId: 'researcher-a',
    });
  });

  it('returns opaque 404 and skips link/BYOS work on live or deny', async () => {
    platformMock.getStudyAuthorityChecked.mockResolvedValue({ status: 'live', phase: 'publishing' });
    const live = await getParticipantRequestContext(request);
    expect(live).toMatchObject({ valid: false, statusCode: 404, error: 'This study is no longer active.' });
    expectNoByosWork();

    platformMock.getStudyAuthorityChecked.mockResolvedValue({ status: 'deny' });
    const denied = await getParticipantRequestContext(request);
    expect(denied.statusCode).toBe(404);
    expectNoByosWork();
  });

  it('returns 503 without leaking journal and without BYOS on adel', async () => {
    platformMock.getStudyAuthorityChecked.mockResolvedValue({ status: 'adel' });
    const result = await getParticipantRequestContext(request);
    expect(result).toMatchObject({ valid: false, statusCode: 503, retryable: true });
    expect(result.error).not.toMatch(/delet|journal/i);
    expectNoByosWork();
  });

  it('uses new-persist then persist-repair only when a live delete can finish a matching guard', async () => {
    platformMock.getStudyAuthorityChecked
      .mockResolvedValueOnce({ status: 'live', phase: 'pending' })
      .mockResolvedValueOnce({ status: 'allow', owner: OWNER });
    platformMock.getResearcherByIdChecked.mockResolvedValue({
      status: 'found',
      researcher: {
        id: 'researcher-a',
        onboardingComplete: true,
        encryptedRedisUrl: 'enc-url',
        encryptedRedisToken: 'enc-token',
        encryptedGeminiApiKey: null,
        encryptedAnthropicApiKey: null,
        encryptedOpenAiApiKey: null,
        encryptedOpenRouterApiKey: null,
      },
    });
    cryptoMock.decrypt.mockImplementation((_value: string, meta: { purpose: string }) => {
      if (meta.purpose === 'redis-url') return 'https://example.upstash.io';
      if (meta.purpose === 'redis-token') return 'token';
      return null;
    });
    kvClientMock.getResearcherClient.mockReturnValue({ kind: 'byos' });
    participantLinksMock.getParticipantLinkById.mockResolvedValue({
      status: 'found',
      link: {
        studyId: '11111111-1111-4111-8111-111111111111',
        studyRevision: 1,
        researcherId: 'researcher-a',
      },
    });
    const studyId = '11111111-1111-4111-8111-111111111111';
    kvMock.getStudy.mockResolvedValue(makeStoredStudy({
      id: studyId,
      config: makeStudyConfig({ id: studyId }),
    }));

    const result = await getParticipantRequestContext(request, { purpose: 'new-persist' });
    expect(result.valid).toBe(true);
    expect(result.persistRepairOnly).toBe(true);
    expect(platformMock.getStudyAuthorityChecked).toHaveBeenNthCalledWith(1, expect.objectContaining({
      purpose: 'new-persist',
    }));
    expect(platformMock.getStudyAuthorityChecked).toHaveBeenNthCalledWith(2, expect.objectContaining({
      purpose: 'persist-repair',
    }));
    expect(platformMock.getStudyAuthorityChecked.mock.invocationCallOrder[0])
      .toBeLessThan(platformMock.getResearcherByIdChecked.mock.invocationCallOrder[0]);
  });

  it('returns opaque 404 for a missing hosted study after authority allow', async () => {
    platformMock.getStudyAuthorityChecked.mockResolvedValue({ status: 'allow', owner: OWNER });
    platformMock.getResearcherByIdChecked.mockResolvedValue({
      status: 'found',
      researcher: {
        id: 'researcher-a',
        onboardingComplete: true,
        encryptedRedisUrl: 'enc-url',
        encryptedRedisToken: 'enc-token',
        encryptedGeminiApiKey: null,
        encryptedAnthropicApiKey: null,
        encryptedOpenAiApiKey: null,
        encryptedOpenRouterApiKey: null,
      },
    });
    cryptoMock.decrypt.mockImplementation((_value: string, meta: { purpose: string }) => {
      if (meta.purpose === 'redis-url') return 'https://example.upstash.io';
      if (meta.purpose === 'redis-token') return 'token';
      return null;
    });
    kvClientMock.getResearcherClient.mockReturnValue({ kind: 'byos' });
    participantLinksMock.getParticipantLinkById.mockResolvedValue({
      status: 'found',
      link: {
        studyId: '11111111-1111-4111-8111-111111111111',
        studyRevision: 1,
        researcherId: 'researcher-a',
      },
    });
    kvMock.getStudy.mockResolvedValue(null);

    const result = await getParticipantRequestContext(request);
    expect(result).toMatchObject({
      valid: false,
      statusCode: 404,
      error: 'This study is no longer active.',
    });
  });
});

describe('hosted preview authority-before-BYOS', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    modeMock.isHostedMode.mockReturnValue(true);
    modeMock.isStandaloneMode.mockReturnValue(false);
    cookiesMock.cookies.mockResolvedValue({
      get: vi.fn(() => ({ value: 'researcher-session' })),
    });
    authMock.verifyParticipantToken.mockResolvedValue({ valid: true, isAdmin: true });
    authMock.verifySessionToken.mockResolvedValue({
      valid: true,
      researcherId: 'researcher-a',
      issuedAt: Math.floor(Date.now() / 1000),
    });
  });

  it('does not decrypt BYOS until a study is selected', async () => {
    const result = await getParticipantRequestContext(new Request('http://localhost/api/greeting', {
      method: 'POST',
      headers: { 'X-OpenInterviewer-Preview': '1' },
    }));
    expect(result).toMatchObject({
      valid: true,
      isAdmin: true,
      needsStudySelection: true,
      context: null,
    });
    expectNoByosWork();
    expect(platformMock.getStudyAuthorityChecked).not.toHaveBeenCalled();
  });

  it('gates the selected study with preview purpose before BYOS', async () => {
    platformMock.getStudyAuthorityChecked.mockResolvedValue({ status: 'live', phase: 'pending' });
    const result = await resolveParticipantOrPreviewContext(
      new Request('http://localhost/api/greeting', {
        method: 'POST',
        headers: { 'X-OpenInterviewer-Preview': '1' },
      }),
      { selectedStudyId: '11111111-1111-4111-8111-111111111111', purpose: 'preview' },
    );
    expect(result).toMatchObject({
      valid: false,
      isAdmin: true,
      statusCode: 409,
    });
    expect(platformMock.getStudyAuthorityChecked).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'preview',
      studyId: '11111111-1111-4111-8111-111111111111',
      researcherId: 'researcher-a',
    }));
    expectNoByosWork();
  });

  it('does not let a body study id steal participant authority without the preview marker', async () => {
    authMock.verifyParticipantToken.mockResolvedValue({
      valid: true,
      studyId: '11111111-1111-4111-8111-111111111111',
      linkId: 'b'.repeat(64),
      sessionId: 'session-a',
      studyRevision: 1,
      researcherId: 'researcher-a',
    });
    platformMock.getStudyAuthorityChecked.mockResolvedValue({ status: 'live', phase: 'pending' });
    const result = await resolveParticipantOrPreviewContext(
      new Request('http://localhost/api/greeting'),
      { selectedStudyId: '22222222-2222-4222-8222-222222222222', purpose: 'read' },
    );
    expect(result.statusCode).toBe(404);
    expect(platformMock.getStudyAuthorityChecked).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'read',
      studyId: '11111111-1111-4111-8111-111111111111',
    }));
    expectNoByosWork();
  });
});

describe('selectedStudyIdFromParticipantBody', () => {
  it('prefers the explicit studyId over a nested config id', () => {
    expect(selectedStudyIdFromParticipantBody({
      studyId: 'study-a',
      studyConfig: { id: 'study-b' },
    })).toBe('study-a');
  });
});
