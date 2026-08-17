// @vitest-environment node

process.env.PLATFORM_KEY_PREFIX = '';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredInterview, makeStoredStudy, makeStudyConfig } from '../fixtures/models';
import { buildSchemaLineageValue } from '@/lib/platformSchema';
import {
  buildPendingStudyOperationV2,
  encodeAccountRecord,
  encodeOperationRecord,
  encodeOwnerRecord,
  encodeStorageBinding,
} from '@/lib/platformDb';
import { MemoryPlatformRedis } from '../helpers/memoryPlatformRedis';

const cookiesMock = vi.hoisted(() => ({ cookies: vi.fn() }));
vi.mock('next/headers', () => cookiesMock);

const authMock = vi.hoisted(() => ({
  verifySessionToken: vi.fn(),
  verifyParticipantToken: vi.fn(),
  createParticipantSessionToken: vi.fn(async () => 'participant-session-token'),
  getParticipantSessionCookieOptions: vi.fn(() => ({ httpOnly: true, path: '/' })),
  getParticipantSessionCookieName: vi.fn((handle?: string) => (
    handle ? `participant-session-${handle}` : 'participant-session'
  )),
  PARTICIPANT_SESSION_HEADER_NAME: 'x-openinterviewer-participant-session',
  SESSION_COOKIE_NAME: 'researcher-session',
}));
vi.mock('@/lib/auth', () => authMock);

const researcherLookup = vi.hoisted(() => ({ getResearcherByIdChecked: vi.fn() }));
const platformRate = vi.hoisted(() => ({
  consumePlatformRateLimit: vi.fn(async () => ({ status: 'ok' })),
}));
vi.mock('@/lib/platformDb', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    getResearcherByIdChecked: researcherLookup.getResearcherByIdChecked,
    consumePlatformRateLimit: platformRate.consumePlatformRateLimit,
  };
});

const modeMock = vi.hoisted(() => ({
  isHostedMode: vi.fn(() => true),
  isStandaloneMode: vi.fn(() => false),
}));
vi.mock('@/lib/mode', () => modeMock);

const kvClientMock = vi.hoisted(() => ({
  getKVClient: vi.fn(),
  getResearcherClient: vi.fn(),
  getPlatformClient: vi.fn(),
}));
vi.mock('@/lib/kvClient', () => kvClientMock);

const cryptoMock = vi.hoisted(() => ({ decrypt: vi.fn() }));
vi.mock('@/lib/crypto', () => cryptoMock);

const kvMock = vi.hoisted(() => ({
  getStudy: vi.fn(),
  getStudyChecked: vi.fn(),
  getInterviewChecked: vi.fn(),
  getStudyInterviewsChecked: vi.fn(),
  getAllInterviewsChecked: vi.fn(),
  persistCompletedInterview: vi.fn(),
  replaceStudyConfigAtomic: vi.fn(),
  setStudyLinksEnabled: vi.fn(),
  isKVAvailable: vi.fn(async () => true),
  INTERVIEW_PERSISTING_PREFIX: 'interview-persisting:',
  parsePersistingGuard: vi.fn(),
}));
vi.mock('@/lib/kv', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, ...kvMock };
});

const participantLinksMock = vi.hoisted(() => ({
  getParticipantLinkById: vi.fn(),
  getParticipantLinkByCode: vi.fn(),
  asStudyAuthorityFromLink: vi.fn(),
  createParticipantLinkRecord: vi.fn(),
  listParticipantLinksForStudy: vi.fn(),
  revokeParticipantLink: vi.fn(),
}));
vi.mock('@/lib/participantLinks', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, ...participantLinksMock };
});

const consentMock = vi.hoisted(() => ({
  recordParticipantConsent: vi.fn(),
  verifyParticipantConsent: vi.fn(),
}));
vi.mock('@/lib/participantConsent', () => consentMock);

const providersMock = vi.hoisted(() => ({
  getInterviewProvider: vi.fn(),
}));
vi.mock('@/lib/providers', () => providersMock);

vi.mock('@/lib/rateLimit', () => ({
  participantRateLimitResponse: vi.fn(async () => null),
  getSavePersistRatePlan: vi.fn(() => []),
}));
vi.mock('@/lib/platformAiRateLimit', () => ({
  hostedAiRateLimitResponse: vi.fn(async () => null),
}));
vi.mock('@/lib/synthesisReceipt', () => ({
  createSynthesisReceipt: vi.fn(async () => 'receipt'),
  verifySynthesisReceipt: vi.fn(async () => ({
    aiProvider: 'gemini',
    aiModel: 'gemini-3.1-pro-preview',
  })),
}));

import {
  getParticipantRequestContext,
  presentStudyAuthority,
  resolveParticipantOrPreviewContext,
} from '@/lib/researcherContext';
import { POST as consentPOST } from '@/app/api/consent/route';
import { POST as greetingPOST } from '@/app/api/greeting/route';
import { POST as interviewPOST } from '@/app/api/interview/route';
import { POST as synthesisPOST } from '@/app/api/synthesis/route';
import { POST as savePOST } from '@/app/api/interviews/save/route';
import { GET as exchangeGET, POST as generateLinkPOST } from '@/app/api/generate-link/route';
import { GET as interviewsGET } from '@/app/api/interviews/route';
import { GET as interviewDetailGET } from '@/app/api/interviews/[id]/route';
import { GET as exportGET } from '@/app/api/interviews/export/route';
import { POST as aggregatePOST } from '@/app/api/synthesis/aggregate/route';
import { POST as followupPOST } from '@/app/api/studies/[id]/generate-followup/route';
import { GET as linksGET, DELETE as linksDELETE } from '@/app/api/studies/[id]/participant-links/route';
import { GET as studiesGET } from '@/app/api/studies/route';
import {
  GET as studyDetailGET,
  PUT as studyDetailPUT,
} from '@/app/api/studies/[id]/route';

const STUDY_A = '11111111-1111-4111-8111-111111111111';
const STUDY_B = '22222222-2222-4222-8222-222222222222';
const RESEARCHER_A = 'researcher-a';
const RESEARCHER_B = 'researcher-b';
const STORAGE_ID = 'a'.repeat(64);
const HASH = 'c'.repeat(64);
const FINGERPRINT = 'd'.repeat(64);
const NONCE = '0123456789abcdef0123456789abcdef';
const NOW = 1_700_000_000_000;
const LINK_A = 'e'.repeat(64);

const platform = new MemoryPlatformRedis();

function seedSharedStorage() {
  platform.strings.clear();
  platform.hashes.clear();
  platform.sets.clear();
  platform.zsets.clear();
  platform.writes = [];
  platform.strings.set('schema-lineage', buildSchemaLineageValue(NOW));
  platform.strings.set(`researcher:${RESEARCHER_A}`, encodeAccountRecord({ id: RESEARCHER_A }));
  platform.strings.set(`researcher:${RESEARCHER_B}`, encodeAccountRecord({ id: RESEARCHER_B }));
  platform.strings.set(`study-owner:${STUDY_A}`, encodeOwnerRecord({
    version: 2,
    researcherId: RESEARCHER_A,
    storageId: STORAGE_ID,
    generation: 1,
  }));
  platform.strings.set(`study-owner:${STUDY_B}`, encodeOwnerRecord({
    version: 2,
    researcherId: RESEARCHER_B,
    storageId: STORAGE_ID,
    generation: 1,
  }));
  platform.sets.set(`researcher-studies:${RESEARCHER_A}`, new Set([STUDY_A]));
  platform.sets.set(`researcher-studies:${RESEARCHER_B}`, new Set([STUDY_B]));
  for (const researcherId of [RESEARCHER_A, RESEARCHER_B]) {
    platform.strings.set(`researcher-storage:${researcherId}`, encodeStorageBinding({
      version: 2,
      researcherId,
      storageId: STORAGE_ID,
      originHash: STORAGE_ID,
      credentialRevision: 1,
      bindingEpoch: 1,
      cipherSnapshot: 'cipher',
    }));
  }
  platform.sets.set(`storage-researchers:${STORAGE_ID}`, new Set([RESEARCHER_A, RESEARCHER_B]));
}

function seedLive(studyId: string, researcherId: string, kind: 'create' | 'delete') {
  const op = buildPendingStudyOperationV2({
    kind,
    phase: 'pending',
    researcherId,
    studyId,
    generation: 1,
    opNonce: NONCE,
    createdAt: NOW,
    idempotencyHash: kind === 'create' ? HASH : null,
    fingerprint: kind === 'create' ? FINGERPRINT : null,
  });
  const hash = platform.hashes.get('study-ops:v2') ?? new Map<string, string>();
  hash.set(studyId, encodeOperationRecord(op));
  platform.hashes.set('study-ops:v2', hash);
}

function researcherAccount(id: string) {
  return {
    status: 'found' as const,
    researcher: {
      id,
      onboardingComplete: true,
      encryptedRedisUrl: `enc-url-${id}`,
      encryptedRedisToken: `enc-token-${id}`,
      encryptedGeminiApiKey: null,
      encryptedAnthropicApiKey: null,
      encryptedOpenAiApiKey: null,
      encryptedOpenRouterApiKey: null,
    },
  };
}

function participantAuth(researcherId: string, studyId: string) {
  return {
    valid: true,
    studyId,
    linkId: LINK_A,
    sessionId: `session-${researcherId}`,
    studyRevision: 1,
    researcherId,
  };
}

function expectNoSideEffects() {
  expect(consentMock.recordParticipantConsent).not.toHaveBeenCalled();
  expect(providersMock.getInterviewProvider).not.toHaveBeenCalled();
  expect(kvMock.persistCompletedInterview).not.toHaveBeenCalled();
}

describe('hosted shared-BYOS participant/preview adversarial matrix', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedSharedStorage();
    modeMock.isHostedMode.mockReturnValue(true);
    modeMock.isStandaloneMode.mockReturnValue(false);
    kvClientMock.getPlatformClient.mockReturnValue(platform.asPort());
    kvClientMock.getResearcherClient.mockImplementation((_url: string, _token: string, meta: { researcherId: string }) => ({
      kind: 'byos',
      researcherId: meta.researcherId,
      get: vi.fn(),
    }));
    cryptoMock.decrypt.mockImplementation((value: string) => value.replace('enc-url-', 'https://shared.upstash.io/').replace('enc-token-', 'token-'));
    researcherLookup.getResearcherByIdChecked.mockImplementation(async (id: string) => researcherAccount(id));
    cookiesMock.cookies.mockResolvedValue({ get: vi.fn(() => ({ value: 'session' })) });
    participantLinksMock.getParticipantLinkById.mockImplementation(async () => ({
      status: 'found',
      link: { studyId: STUDY_A, studyRevision: 1, researcherId: RESEARCHER_A },
    }));
    kvMock.getStudy.mockImplementation(async (id: string) => makeStoredStudy({
      id,
      config: makeStudyConfig({ id }),
    }));
    kvMock.getStudyChecked.mockImplementation(async (id: string) => ({
      status: 'found',
      study: makeStoredStudy({ id, config: makeStudyConfig({ id }) }),
    }));
    kvMock.getStudyInterviewsChecked.mockImplementation(async (id: string) => ({
      status: 'ok',
      items: [makeStoredInterview({ id: `int-${id}`, studyId: id })],
    }));
    kvMock.getInterviewChecked.mockImplementation(async (id: string) => ({
      status: 'found',
      interview: makeStoredInterview({ id, studyId: STUDY_A }),
    }));
    kvMock.getAllInterviewsChecked.mockResolvedValue({
      status: 'ok',
      items: [makeStoredInterview({ id: 'leaked-all', studyId: STUDY_A })],
    });
    participantLinksMock.listParticipantLinksForStudy.mockResolvedValue({
      status: 'ok', links: [], truncated: false,
    });
    participantLinksMock.revokeParticipantLink.mockResolvedValue({
      status: 'revoked', revokedAt: NOW,
    });
    participantLinksMock.createParticipantLinkRecord.mockResolvedValue({
      status: 'created', code: 'code-a',
    });
    consentMock.verifyParticipantConsent.mockResolvedValue({
      status: 'accepted',
      consent: {
        version: 1,
        participantSessionId: 'session-researcher-a',
        studyId: STUDY_A,
        studyRevision: 1,
        consentHash: 'f'.repeat(64),
        acceptedAt: NOW,
      },
    });
    consentMock.recordParticipantConsent.mockResolvedValue({
      status: 'accepted',
      consent: { acceptedAt: NOW },
    });
    providersMock.getInterviewProvider.mockReturnValue({
      getInterviewGreeting: vi.fn().mockResolvedValue('hello'),
      generateInterviewResponse: vi.fn().mockResolvedValue({ message: 'ok' }),
      synthesizeInterview: vi.fn().mockResolvedValue({
        value: {
          statedPreferences: [],
          revealedPreferences: [],
          themes: [],
          contradictions: [],
          keyInsights: ['k'],
          bottomLine: 'b',
        },
        execution: { provider: 'gemini', requestedModel: 'm', model: 'm' },
      }),
    });
  });

  it('lets A through and returns opaque 404 for B on A’s study with zero BYOS decrypt', async () => {
    authMock.verifyParticipantToken.mockResolvedValue(participantAuth(RESEARCHER_A, STUDY_A));
    const allowed = await getParticipantRequestContext(new Request('http://localhost/api/greeting'));
    expect(allowed.valid).toBe(true);
    expect(allowed.studyId).toBe(STUDY_A);
    expect(cryptoMock.decrypt).toHaveBeenCalled();

    vi.clearAllMocks();
    kvClientMock.getPlatformClient.mockReturnValue(platform.asPort());
    researcherLookup.getResearcherByIdChecked.mockImplementation(async (id: string) => researcherAccount(id));
    participantLinksMock.getParticipantLinkById.mockResolvedValue({
      status: 'found',
      link: { studyId: STUDY_A, studyRevision: 1, researcherId: RESEARCHER_A },
    });
    authMock.verifyParticipantToken.mockResolvedValue(participantAuth(RESEARCHER_B, STUDY_A));
    const denied = await getParticipantRequestContext(new Request('http://localhost/api/greeting'));
    expect(denied).toMatchObject({
      valid: false,
      statusCode: 404,
      error: 'This study is no longer active.',
    });
    expect(cryptoMock.decrypt).not.toHaveBeenCalled();
    expect(kvClientMock.getResearcherClient).not.toHaveBeenCalled();
    expect(kvMock.getStudy).not.toHaveBeenCalled();
    expect(participantLinksMock.getParticipantLinkById).not.toHaveBeenCalled();
  });

  it('maps live create to participant 404 and researcher preview 409 without provider work', async () => {
    seedLive(STUDY_A, RESEARCHER_A, 'create');
    authMock.verifyParticipantToken.mockResolvedValue(participantAuth(RESEARCHER_A, STUDY_A));
    const participant = await getParticipantRequestContext(new Request('http://localhost/api/consent'));
    const presentedLive = presentStudyAuthority({ status: 'live', phase: 'pending' }, 'participant');
    expect(presentedLive.ok).toBe(false);
    if (!presentedLive.ok) expect(presentedLive.statusCode).toBe(404);
    expect(participant.statusCode).toBe(404);

    authMock.verifyParticipantToken.mockResolvedValue({ valid: true, isAdmin: true });
    authMock.verifySessionToken.mockResolvedValue({
      valid: true,
      researcherId: RESEARCHER_A,
      issuedAt: Math.floor(Date.now() / 1000),
    });
    const preview = await resolveParticipantOrPreviewContext(
      new Request('http://localhost/api/greeting', { headers: { 'X-OpenInterviewer-Preview': '1' } }),
      { selectedStudyId: STUDY_A, purpose: 'preview' },
    );
    expect(preview).toMatchObject({ valid: false, statusCode: 409, isAdmin: true });
    expect(cryptoMock.decrypt).not.toHaveBeenCalled();
  });

  it('allows persist-repair for A during live delete and still 404s B', async () => {
    seedLive(STUDY_A, RESEARCHER_A, 'delete');
    authMock.verifyParticipantToken.mockResolvedValue(participantAuth(RESEARCHER_A, STUDY_A));
    const repair = await getParticipantRequestContext(new Request('http://localhost/api/interviews/save'), {
      purpose: 'new-persist',
    });
    expect(repair.valid).toBe(true);
    expect(repair.persistRepairOnly).toBe(true);

    authMock.verifyParticipantToken.mockResolvedValue(participantAuth(RESEARCHER_B, STUDY_A));
    const denied = await getParticipantRequestContext(new Request('http://localhost/api/interviews/save'), {
      purpose: 'new-persist',
    });
    expect(denied.statusCode).toBe(404);
  });

  it('returns 503 without journal leak on adel, mismatch, and authority outage', async () => {
    const journal = platform.hashes.get('account-delete-journal') ?? new Map<string, string>();
    journal.set(RESEARCHER_A, 'oi:adel-journal:{"version":2}');
    platform.hashes.set('account-delete-journal', journal);
    authMock.verifyParticipantToken.mockResolvedValue(participantAuth(RESEARCHER_A, STUDY_A));
    const adel = await getParticipantRequestContext(new Request('http://localhost/api/greeting'));
    expect(adel).toMatchObject({ valid: false, statusCode: 503, retryable: true });
    expect(adel.error).not.toMatch(/delet|journal/i);

    seedSharedStorage();
    platform.strings.set(`researcher-storage:${RESEARCHER_A}`, encodeStorageBinding({
      version: 2,
      researcherId: RESEARCHER_A,
      storageId: 'b'.repeat(64),
      originHash: 'b'.repeat(64),
      credentialRevision: 1,
      bindingEpoch: 1,
      cipherSnapshot: 'cipher',
    }));
    const mismatch = await getParticipantRequestContext(new Request('http://localhost/api/greeting'));
    expect(mismatch.statusCode).toBe(503);
    expect(cryptoMock.decrypt).not.toHaveBeenCalled();

    platform.evalError = new Error('platform down');
    const outage = await getParticipantRequestContext(new Request('http://localhost/api/greeting'));
    expect(outage.statusCode).toBe(503);
    platform.evalError = undefined;
  });

  it('gives B a positive path on B’s own study', async () => {
    participantLinksMock.getParticipantLinkById.mockResolvedValue({
      status: 'found',
      link: { studyId: STUDY_B, studyRevision: 1, researcherId: RESEARCHER_B },
    });
    authMock.verifyParticipantToken.mockResolvedValue(participantAuth(RESEARCHER_B, STUDY_B));
    const result = await getParticipantRequestContext(new Request('http://localhost/api/greeting'));
    expect(result.valid).toBe(true);
    expect(result.studyId).toBe(STUDY_B);
    expect(kvClientMock.getResearcherClient).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ researcherId: RESEARCHER_B }),
    );
  });

  it('does not record consent, call a provider, or persist when B is denied at the route', async () => {
    authMock.verifyParticipantToken.mockResolvedValue(participantAuth(RESEARCHER_B, STUDY_A));
    const body = JSON.stringify({
      studyId: STUDY_A,
      studyConfig: { id: STUDY_A },
      history: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }],
      participantProfile: null,
      questionProgress: { questionsAsked: [], total: 0, currentPhase: 'background', isComplete: false },
      currentContext: '',
      behaviorData: { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] },
      transcript: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }],
      synthesis: {
        statedPreferences: [],
        revealedPreferences: [],
        themes: [],
        contradictions: [],
        keyInsights: ['k'],
        bottomLine: 'b',
        _receipt: 'receipt',
      },
    });
    const headers = { 'Content-Type': 'application/json' };

    const consent = await consentPOST(new Request('http://localhost/api/consent', { method: 'POST', headers, body }));
    const greeting = await greetingPOST(new Request('http://localhost/api/greeting', { method: 'POST', headers, body }));
    const interview = await interviewPOST(new Request('http://localhost/api/interview', { method: 'POST', headers, body }));
    const synthesis = await synthesisPOST(new Request('http://localhost/api/synthesis', { method: 'POST', headers, body }));
    const save = await savePOST(new Request('http://localhost/api/interviews/save', { method: 'POST', headers, body }));

    expect([consent.status, greeting.status, interview.status, synthesis.status, save.status])
      .toEqual([404, 404, 404, 404, 404]);
    expectNoSideEffects();
  });

  it('sets no participant cookie when exchange is live or B is denied', async () => {
    participantLinksMock.getParticipantLinkByCode.mockResolvedValue({ status: 'live', phase: 'pending' });
    participantLinksMock.asStudyAuthorityFromLink.mockReturnValue({ status: 'live', phase: 'pending' });
    const live = await exchangeGET(new Request('http://localhost/api/generate-link?token=code-a'));
    expect(live.status).toBe(404);
    expect(live.headers.get('set-cookie')).toBeNull();

    participantLinksMock.getParticipantLinkByCode.mockResolvedValue({ status: 'deny' });
    participantLinksMock.asStudyAuthorityFromLink.mockReturnValue({ status: 'deny' });
    const denied = await exchangeGET(new Request('http://localhost/api/generate-link?token=code-b'));
    expect(denied.status).toBe(404);
    expect(denied.headers.get('set-cookie')).toBeNull();
    expect(authMock.createParticipantSessionToken).not.toHaveBeenCalled();
  });
});

function researcherSession(researcherId: string) {
  authMock.verifySessionToken.mockResolvedValue({
    valid: true,
    researcherId,
    issuedAt: Math.floor(Date.now() / 1000),
  });
}

describe('hosted shared-BYOS researcher list/export/link adversarial matrix', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedSharedStorage();
    modeMock.isHostedMode.mockReturnValue(true);
    modeMock.isStandaloneMode.mockReturnValue(false);
    kvClientMock.getPlatformClient.mockReturnValue(platform.asPort());
    kvClientMock.getResearcherClient.mockImplementation((_url: string, _token: string, meta: { researcherId: string }) => ({
      kind: 'byos',
      researcherId: meta.researcherId,
      get: vi.fn(),
    }));
    cryptoMock.decrypt.mockImplementation((value: string) => value.replace('enc-url-', 'https://shared.upstash.io/').replace('enc-token-', 'token-'));
    researcherLookup.getResearcherByIdChecked.mockImplementation(async (id: string) => researcherAccount(id));
    cookiesMock.cookies.mockResolvedValue({ get: vi.fn(() => ({ value: 'session' })) });
    kvMock.getStudyChecked.mockImplementation(async (id: string) => ({
      status: 'found',
      study: makeStoredStudy({ id, config: makeStudyConfig({ id }) }),
    }));
    kvMock.getStudyInterviewsChecked.mockImplementation(async (id: string) => ({
      status: 'ok',
      items: [makeStoredInterview({ id: `int-${id}`, studyId: id })],
    }));
    kvMock.getInterviewChecked.mockResolvedValue({
      status: 'found',
      interview: makeStoredInterview({ id: 'int-a', studyId: STUDY_A }),
    });
    kvMock.getAllInterviewsChecked.mockResolvedValue({
      status: 'ok',
      items: [makeStoredInterview({ id: 'leaked-all', studyId: STUDY_A })],
    });
    participantLinksMock.listParticipantLinksForStudy.mockResolvedValue({
      status: 'ok', links: [], truncated: false,
    });
    participantLinksMock.createParticipantLinkRecord.mockResolvedValue({
      status: 'created', code: 'code-a',
    });
    participantLinksMock.revokeParticipantLink.mockResolvedValue({
      status: 'revoked', revokedAt: NOW,
    });
    platformRate.consumePlatformRateLimit.mockResolvedValue({ status: 'ok' });
  });

  it('lists only owned studies and never reads all-interviews for B', async () => {
    researcherSession(RESEARCHER_B);
    const list = await studiesGET();
    const body = await list.json();
    expect(list.status).toBe(200);
    expect(body.studies.map((study: { id: string }) => study.id)).toEqual([STUDY_B]);
    expect(kvMock.getStudyChecked).toHaveBeenCalledWith(STUDY_B, expect.anything());
    expect(kvMock.getStudyChecked).not.toHaveBeenCalledWith(STUDY_A, expect.anything());

    const interviews = await interviewsGET(new Request('http://localhost/api/interviews'));
    const interviewBody = await interviews.json();
    expect(interviews.status).toBe(200);
    expect(interviewBody.interviews.every((row: { studyId: string }) => row.studyId === STUDY_B)).toBe(true);
    expect(kvMock.getAllInterviewsChecked).not.toHaveBeenCalled();
  });

  it('returns 403/409 for B on A’s study-scoped researcher surfaces with zero provider or mint work', async () => {
    researcherSession(RESEARCHER_B);
    const headers = { 'Content-Type': 'application/json' };
    const studyParams = { params: Promise.resolve({ id: STUDY_A }) };

    const filtered = await interviewsGET(new Request(`http://localhost/api/interviews?studyId=${STUDY_A}`));
    const detail = await interviewDetailGET(
      new Request(`http://localhost/api/interviews/int-a?studyId=${STUDY_A}`),
      { params: Promise.resolve({ id: 'int-a' }) },
    );
    const studyDetail = await studyDetailGET(
      new Request(`http://localhost/api/studies/${STUDY_A}`),
      { params: Promise.resolve({ id: STUDY_A }) },
    );
    const aggregate = await aggregatePOST(new Request('http://localhost/api/synthesis/aggregate', {
      method: 'POST', headers, body: JSON.stringify({ studyId: STUDY_A }),
    }));
    const followup = await followupPOST(new Request(`http://localhost/api/studies/${STUDY_A}/generate-followup`, {
      method: 'POST', headers, body: JSON.stringify({ synthesis: { studyId: STUDY_A } }),
    }), studyParams);
    const mint = await generateLinkPOST(new Request('http://localhost/api/generate-link', {
      method: 'POST', headers, body: JSON.stringify({ studyConfig: { id: STUDY_A } }),
    }));
    const links = await linksGET(new Request(`http://localhost/api/studies/${STUDY_A}/participant-links`), studyParams);
    const revoke = await linksDELETE(new Request(`http://localhost/api/studies/${STUDY_A}/participant-links`, {
      method: 'DELETE', headers, body: JSON.stringify({ linkId: 'a'.repeat(64) }),
    }), studyParams);

    expect([
      filtered.status,
      detail.status,
      studyDetail.status,
      aggregate.status,
      followup.status,
      mint.status,
      links.status,
      revoke.status,
    ]).toEqual([403, 403, 403, 403, 403, 403, 403, 403]);
    expect(providersMock.getInterviewProvider).not.toHaveBeenCalled();
    expect(participantLinksMock.createParticipantLinkRecord).not.toHaveBeenCalled();
    expect(participantLinksMock.listParticipantLinksForStudy).not.toHaveBeenCalled();
    expect(participantLinksMock.revokeParticipantLink).not.toHaveBeenCalled();
    expect(kvMock.getStudyInterviewsChecked).not.toHaveBeenCalled();
    expect(kvMock.getStudyChecked).not.toHaveBeenCalled();
    expect(kvMock.getInterviewChecked).not.toHaveBeenCalled();
    expect(cryptoMock.decrypt).not.toHaveBeenCalled();
    expect(kvClientMock.getResearcherClient).not.toHaveBeenCalled();
  });

  it('maps live A to researcher 409 without BYOS interview reads', async () => {
    seedLive(STUDY_A, RESEARCHER_A, 'create');
    researcherSession(RESEARCHER_A);
    const filtered = await interviewsGET(new Request(`http://localhost/api/interviews?studyId=${STUDY_A}`));
    expect(filtered.status).toBe(409);
    await expect(filtered.json()).resolves.toMatchObject({ code: 'STUDY_OPERATION_PENDING' });
    expect(kvMock.getStudyInterviewsChecked).not.toHaveBeenCalled();

    const listed = await studiesGET();
    const body = await listed.json();
    expect(body.studies).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: STUDY_A, reconciliationPending: true }),
    ]));
    expect(kvMock.getStudyChecked).not.toHaveBeenCalledWith(STUDY_A, expect.anything());

    const headers = { 'Content-Type': 'application/json' };
    const studyParams = { params: Promise.resolve({ id: STUDY_A }) };
    const detail = await interviewDetailGET(
      new Request(`http://localhost/api/interviews/int-a?studyId=${STUDY_A}`),
      { params: Promise.resolve({ id: 'int-a' }) },
    );
    const studyDetail = await studyDetailGET(
      new Request(`http://localhost/api/studies/${STUDY_A}`),
      studyParams,
    );
    const aggregate = await aggregatePOST(new Request('http://localhost/api/synthesis/aggregate', {
      method: 'POST', headers, body: JSON.stringify({ studyId: STUDY_A }),
    }));
    const followup = await followupPOST(new Request(`http://localhost/api/studies/${STUDY_A}/generate-followup`, {
      method: 'POST', headers, body: JSON.stringify({ synthesis: { studyId: STUDY_A } }),
    }), studyParams);
    const mint = await generateLinkPOST(new Request('http://localhost/api/generate-link', {
      method: 'POST', headers, body: JSON.stringify({ studyConfig: { id: STUDY_A } }),
    }));
    const links = await linksGET(new Request(`http://localhost/api/studies/${STUDY_A}/participant-links`), studyParams);
    expect([detail.status, studyDetail.status, aggregate.status, followup.status, mint.status, links.status])
      .toEqual([409, 409, 409, 409, 409, 409]);
    expect(kvMock.getInterviewChecked).not.toHaveBeenCalled();
    expect(providersMock.getInterviewProvider).not.toHaveBeenCalled();
  });

  it('rejects B PUT on A’s study config and link toggle with zero BYOS writes', async () => {
    // Regression for review P0-1: shared-BYOS tenant B must never mutate A’s
    // study; the authority gate (mutate-config / link) denies before decrypt.
    researcherSession(RESEARCHER_B);
    const headers = { 'Content-Type': 'application/json' };
    const studyParams = { params: Promise.resolve({ id: STUDY_A }) };

    const configPut = await studyDetailPUT(
      new Request(`http://localhost/api/studies/${STUDY_A}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ config: makeStudyConfig({ id: STUDY_A }) }),
      }),
      studyParams,
    );
    const linkPut = await studyDetailPUT(
      new Request(`http://localhost/api/studies/${STUDY_A}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ linksEnabled: false }),
      }),
      studyParams,
    );

    expect([configPut.status, linkPut.status]).toEqual([403, 403]);
    expect(kvMock.getStudy).not.toHaveBeenCalled();
    expect(kvMock.replaceStudyConfigAtomic).not.toHaveBeenCalled();
    expect(kvMock.setStudyLinksEnabled).not.toHaveBeenCalled();
    expect(cryptoMock.decrypt).not.toHaveBeenCalled();
    expect(kvClientMock.getResearcherClient).not.toHaveBeenCalled();
  });

  it('maps live delete to 409 STUDY_OPERATION_PENDING on owner PUT with zero BYOS writes', async () => {
    // Regression for review P0-1: during a live operation the owner must not
    // PUT through to BYOS either.
    seedLive(STUDY_A, RESEARCHER_A, 'delete');
    researcherSession(RESEARCHER_A);

    const put = await studyDetailPUT(
      new Request(`http://localhost/api/studies/${STUDY_A}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: makeStudyConfig({ id: STUDY_A }) }),
      }),
      { params: Promise.resolve({ id: STUDY_A }) },
    );

    expect(put.status).toBe(409);
    await expect(put.json()).resolves.toMatchObject({ code: 'STUDY_OPERATION_PENDING' });
    expect(kvMock.getStudy).not.toHaveBeenCalled();
    expect(kvMock.replaceStudyConfigAtomic).not.toHaveBeenCalled();
    expect(cryptoMock.decrypt).not.toHaveBeenCalled();
    expect(kvClientMock.getResearcherClient).not.toHaveBeenCalled();
  });

  it('skips a cross-tagged A id in B’s index and still serves B’s own study', async () => {
    platform.sets.set(`researcher-studies:${RESEARCHER_B}`, new Set([STUDY_A, STUDY_B]));
    researcherSession(RESEARCHER_B);
    const listed = await studiesGET();
    const body = await listed.json();
    expect(body.studies.map((study: { id: string }) => study.id)).toEqual([STUDY_B]);
    expect(kvMock.getStudyChecked).not.toHaveBeenCalledWith(STUDY_A, expect.anything());

    const interviews = await interviewsGET(new Request('http://localhost/api/interviews'));
    const interviewBody = await interviews.json();
    expect(interviewBody.interviews.map((row: { studyId: string }) => row.studyId)).toEqual([STUDY_B]);
  });

  it('exports only B interviews from shared storage', async () => {
    researcherSession(RESEARCHER_B);
    const exported = await exportGET();
    expect(exported.status).toBe(200);
    expect(kvMock.getAllInterviewsChecked).not.toHaveBeenCalled();
    expect(kvMock.getStudyInterviewsChecked).toHaveBeenCalledWith(STUDY_B, expect.anything(), 500);
    expect(kvMock.getStudyInterviewsChecked).not.toHaveBeenCalledWith(STUDY_A, expect.anything(), expect.anything());
  });

  it('returns 404 for a cross-tagged interview whose studyId does not match the gated study', async () => {
    researcherSession(RESEARCHER_B);
    kvMock.getInterviewChecked.mockResolvedValue({
      status: 'found',
      interview: makeStoredInterview({ id: 'int-cross', studyId: STUDY_A }),
    });
    const response = await interviewDetailGET(
      new Request(`http://localhost/api/interviews/int-cross?studyId=${STUDY_B}`),
      { params: Promise.resolve({ id: 'int-cross' }) },
    );
    expect(response.status).toBe(404);
    expect(kvMock.getInterviewChecked).toHaveBeenCalled();
  });

  it('returns 503 without journal leak on researcher pair mismatch and authority outage', async () => {
    researcherSession(RESEARCHER_A);
    platform.strings.set(`researcher-storage:${RESEARCHER_A}`, encodeStorageBinding({
      version: 2,
      researcherId: RESEARCHER_A,
      storageId: 'b'.repeat(64),
      originHash: 'b'.repeat(64),
      credentialRevision: 1,
      bindingEpoch: 1,
      cipherSnapshot: 'cipher',
    }));
    const mismatch = await interviewsGET(new Request(`http://localhost/api/interviews?studyId=${STUDY_A}`));
    expect(mismatch.status).toBe(503);
    expect(cryptoMock.decrypt).not.toHaveBeenCalled();

    seedSharedStorage();
    platform.evalError = new Error('platform down');
    const outage = await interviewsGET(new Request(`http://localhost/api/interviews?studyId=${STUDY_A}`));
    expect(outage.status).toBe(503);
    platform.evalError = undefined;
    expect(kvMock.getStudyInterviewsChecked).not.toHaveBeenCalled();
  });

  it('lets B use B’s own study-scoped researcher surfaces', async () => {
    researcherSession(RESEARCHER_B);
    kvMock.getInterviewChecked.mockResolvedValue({
      status: 'found',
      interview: makeStoredInterview({ id: 'int-b', studyId: STUDY_B }),
    });
    const detail = await interviewDetailGET(
      new Request(`http://localhost/api/interviews/int-b?studyId=${STUDY_B}`),
      { params: Promise.resolve({ id: 'int-b' }) },
    );
    const studyDetail = await studyDetailGET(
      new Request(`http://localhost/api/studies/${STUDY_B}`),
      { params: Promise.resolve({ id: STUDY_B }) },
    );
    const links = await linksGET(
      new Request(`http://localhost/api/studies/${STUDY_B}/participant-links`),
      { params: Promise.resolve({ id: STUDY_B }) },
    );
    expect(detail.status).toBe(200);
    expect(studyDetail.status).toBe(200);
    expect(links.status).toBe(200);
    expect(kvMock.getInterviewChecked).toHaveBeenCalled();
    expect(participantLinksMock.listParticipantLinksForStudy).toHaveBeenCalled();
  });

  it('returns 503 without decrypt or journal leak when A is journaled', async () => {
    const journal = platform.hashes.get('account-delete-journal') ?? new Map<string, string>();
    journal.set(RESEARCHER_A, 'oi:adel-journal:{"version":2}');
    platform.hashes.set('account-delete-journal', journal);
    researcherSession(RESEARCHER_A);
    const listed = await studiesGET();
    const interviews = await interviewsGET(new Request('http://localhost/api/interviews'));
    const exported = await exportGET();
    expect([listed.status, interviews.status, exported.status]).toEqual([503, 503, 503]);
    const listedBody = await listed.json();
    expect(listedBody.error).not.toMatch(/delet|journal/i);
    expect(cryptoMock.decrypt).not.toHaveBeenCalled();
    expect(kvClientMock.getResearcherClient).not.toHaveBeenCalled();
    expect(kvMock.getStudyChecked).not.toHaveBeenCalled();
    expect(kvMock.getStudyInterviewsChecked).not.toHaveBeenCalled();
  });

  it('fails closed on poisoned owner, reverse, and cross-tagged index records', async () => {
    researcherSession(RESEARCHER_A);
    platform.strings.set(`study-owner:${STUDY_A}`, 'poisoned-owner');
    const poisonedOwner = await studiesGET();
    expect(poisonedOwner.status).toBe(503);
    expect(cryptoMock.decrypt).not.toHaveBeenCalled();

    seedSharedStorage();
    platform.sets.set(`storage-researchers:${STORAGE_ID}`, new Set([RESEARCHER_B]));
    const poisonedReverse = await interviewsGET(new Request('http://localhost/api/interviews'));
    expect(poisonedReverse.status).toBe(503);
    expect(kvMock.getStudyInterviewsChecked).not.toHaveBeenCalled();

    seedSharedStorage();
    platform.sets.set(`researcher-studies:${RESEARCHER_B}`, new Set([STUDY_A, STUDY_B]));
    researcherSession(RESEARCHER_B);
    const exported = await exportGET();
    expect(exported.status).toBe(200);
    expect(kvMock.getStudyInterviewsChecked).toHaveBeenCalledWith(STUDY_B, expect.anything(), 500);
    expect(kvMock.getStudyInterviewsChecked).not.toHaveBeenCalledWith(STUDY_A, expect.anything(), expect.anything());
  });

  it('maps live A export and revoke to 409 without mint or BYOS interview reads', async () => {
    seedLive(STUDY_A, RESEARCHER_A, 'delete');
    researcherSession(RESEARCHER_A);
    const exported = await exportGET();
    expect(exported.status).toBe(409);
    await expect(exported.json()).resolves.toMatchObject({ code: 'STUDY_OPERATION_PENDING' });
    expect(kvMock.getStudyInterviewsChecked).not.toHaveBeenCalled();
    expect(cryptoMock.decrypt).not.toHaveBeenCalled();

    const revoke = await linksDELETE(new Request(`http://localhost/api/studies/${STUDY_A}/participant-links`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ linkId: 'a'.repeat(64) }),
    }), { params: Promise.resolve({ id: STUDY_A }) });
    expect(revoke.status).toBe(409);
    await expect(revoke.json()).resolves.toMatchObject({ code: 'STUDY_OPERATION_PENDING' });
    expect(participantLinksMock.revokeParticipantLink).not.toHaveBeenCalled();
  });

  it('lets B mint and list links on B’s own study after authority allow', async () => {
    researcherSession(RESEARCHER_B);
    researcherLookup.getResearcherByIdChecked.mockImplementation(async (id: string) => ({
      ...researcherAccount(id),
      researcher: {
        ...researcherAccount(id).researcher,
        encryptedGeminiApiKey: `enc-gemini-${id}`,
      },
    }));
    const mint = await generateLinkPOST(new Request('http://localhost/api/generate-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studyConfig: { id: STUDY_B } }),
    }));
    expect(mint.status).not.toBe(403);
    expect(mint.status).not.toBe(404);
    expect(kvMock.getStudyChecked).toHaveBeenCalledWith(STUDY_B, expect.anything());
    expect(kvMock.getStudyChecked).not.toHaveBeenCalledWith(STUDY_A, expect.anything());
    expect(participantLinksMock.createParticipantLinkRecord.mock.calls.every(
      (call) => call[0]?.studyId === STUDY_B,
    )).toBe(true);
  });
});


