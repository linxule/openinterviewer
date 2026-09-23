// @vitest-environment node
//
// The participant flow on the Cloudflare target at the route boundary: link
// creation and exchange, link management, consent, greeting/interview
// admission, immutable save with its initial durable job, and researcher
// preview (RT-06, RT-07, RT-08/F10, RT-09, ST-02/03/06, JOB-01/02, OPS-01,
// F26). Real configuration, readiness gate, participant and researcher
// authentication, request contexts, rate-limit plans and Durable Object
// client; only the WorkspaceStore object behind WORKSPACE_STORE is a scripted
// fake that records every RPC, and the provider factory is a spy. The
// object's own transactions are exercised against real SQLite in
// tests/workers/.

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredInterview, makeStoredStudy, makeStudyConfig } from '../fixtures/models';

const redisConstructor = vi.hoisted(() => vi.fn());
vi.mock('@upstash/redis', () => ({ Redis: redisConstructor }));

const cookieJar = vi.hoisted(() => new Map<string, string>());
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined),
  })),
}));

const afterMock = vi.hoisted(() => vi.fn());
vi.mock('next/server', async (importOriginal) => ({
  ...await importOriginal<typeof import('next/server')>(),
  after: afterMock,
}));

const providerFactory = vi.hoisted(() => vi.fn());
vi.mock('@/lib/providers', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/providers')>(),
  getInterviewProvider: providerFactory,
}));

import { GET as exchangeGET, POST as generateLinkPOST } from '@/app/api/generate-link/route';
import { DELETE as linksDELETE, GET as linksGET } from '@/app/api/studies/[id]/participant-links/route';
import { POST as consentPOST } from '@/app/api/consent/route';
import { POST as greetingPOST } from '@/app/api/greeting/route';
import { POST as interviewPOST } from '@/app/api/interview/route';
import { POST as savePOST } from '@/app/api/interviews/save/route';
import { POST as synthesisPOST } from '@/app/api/synthesis/route';
import {
  createParticipantSessionToken,
  createSessionToken,
  getParticipantSessionCookieName,
  PARTICIPANT_SESSION_HEADER_NAME,
  SESSION_COOKIE_NAME,
} from '@/lib/auth';
import { DEFAULT_MODEL_BY_PROVIDER } from '@/lib/providerRegistry';
import {
  WORKER_INVOCATION_ACCESSOR,
  WORKER_RUNTIME_MARKER,
  type AdmissionIdentity,
  type WorkerInvocation,
} from '@/lib/runtime/workerInvocation';
import { ANALYSIS_INPUT_SCHEMA_VERSION } from '@/lib/storage/analysisProtocol';
import type { StoredStudy } from '@/types';

const WORKSPACE_ID = 'ws_0123456789abcdef0123456789abcdef';
const ORIGIN = 'https://openinterviewer.example.workers.dev';
const CLOUDFLARE_ENV: Record<string, string> = {
  DEPLOYMENT_TARGET: 'cloudflare',
  DEPLOYMENT_MODE: 'standalone',
  AI_TRANSPORT: 'direct',
  AI_PROVIDER: 'gemini',
  APP_BASE_URL: ORIGIN,
  ADMIN_PASSWORD: 'synthetic-admin-password-1',
  SESSION_SECRET: 'synthetic-session-secret-0123456789abcdefgh',
  PARTICIPANT_TOKEN_SECRET: 'synthetic-participant-secret-0123456789abcd',
  RATE_LIMIT_SALT: 'synthetic-rate-limit-salt-0123456789abcdef',
  OPERATOR_TOKEN: 'synthetic-operator-token-0123456789abcdefg',
  GEMINI_API_KEY: 'synthetic-gemini-provider-key',
  WORKSPACE_ID,
  WORKSPACE_JURISDICTION: '',
  ANALYSIS_RECOVERY_EPOCH: 'ep_fedcba9876543210fedcba9876543210',
};

const STUDY_ID = 'study-cf-participant';
const REVISION = 3;
// The study's explicit model; deliberately not the provider default.
const STUDY_MODEL = 'gemini-2.5-pro';
const CONSENT_TEXT = 'Synthetic consent text for the Cloudflare participant flow.';
const LINK_CODE = `${'Q'.repeat(21)}_${'r'.repeat(21)}`;
const HANDLE = '3f0c9a52-7c1e-4b8e-9a51-1d2e3f4a5b6c';
const ADDRESS = '203.0.113.7';

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

const LINK_ID = sha256(LINK_CODE);
const CONSENT_HASH = sha256(CONSENT_TEXT);

type RpcCall = { method: string; input: unknown };
type Handler = (input: never) => unknown;

const runtimeGlobals = globalThis as unknown as Record<symbol, unknown>;
let rpcCalls: RpcCall[] = [];
let handlers: Record<string, Handler> = {};

// Every RPC is recorded; an unscripted one throws, which the client maps to
// unavailable/ambiguous, and tests assert on the recorded list.
const workspaceStub = new Proxy({}, {
  get(_target, property) {
    if (typeof property !== 'string' || property === 'then') return undefined;
    return async (input?: unknown) => {
      rpcCalls.push({ method: property, input });
      const handler = handlers[property];
      if (!handler) throw new Error(`unscripted RPC ${property}`);
      return handler(input as never);
    };
  },
});
const workspaceNamespace = {
  idFromName: () => ({}),
  getByName(name: string) {
    if (name !== WORKSPACE_ID) throw new Error('unexpected workspace object');
    return workspaceStub;
  },
};
const analysisQueue = { send: async () => undefined, sendBatch: async () => undefined };

function installRuntime(
  identity: AdmissionIdentity | null = { kind: 'address', address: ADDRESS },
  bindings: Record<string, unknown> = { WORKSPACE_STORE: workspaceNamespace, ANALYSIS_QUEUE: analysisQueue },
): void {
  const invocation: WorkerInvocation = { env: { ...CLOUDFLARE_ENV, ...bindings }, identity, source: 'fetch' };
  runtimeGlobals[WORKER_RUNTIME_MARKER] = true;
  runtimeGlobals[WORKER_INVOCATION_ACCESSOR] = () => invocation;
}

function canonicalStudy(overrides: Partial<StoredStudy> = {}): StoredStudy {
  const config = makeStudyConfig({
    id: STUDY_ID,
    name: 'Cloudflare participant study',
    aiProvider: 'gemini',
    aiModel: STUDY_MODEL,
    consentText: CONSENT_TEXT,
    createdAt: 1_760_000_000_000,
  });
  return makeStoredStudy({ id: STUDY_ID, config, revision: REVISION, ...overrides });
}

const linkRecord = {
  id: LINK_ID,
  version: 1,
  studyId: STUDY_ID,
  studyRevision: REVISION,
  researcherId: null,
  createdAt: 1_760_000_000_000,
  expiresAt: null,
  revokedAt: null,
};

const acceptedConsent = {
  status: 'accepted',
  consent: {
    version: 1,
    participantSessionId: HANDLE,
    studyId: STUDY_ID,
    studyRevision: REVISION,
    consentHash: CONSENT_HASH,
    acceptedAt: 1_760_000_100_000,
  },
};

function defaultHandlers(): Record<string, Handler> {
  return {
    readiness: () => ({ status: 'ready', maintenance: 'open' }),
    getStudy: () => ({ status: 'found', study: canonicalStudy() }),
    getParticipantLink: () => ({ status: 'found', link: linkRecord }),
    verifyConsent: () => acceptedConsent,
    admitParticipantRequest: () => ({ status: 'admitted' }),
  };
}

const provider = {
  getInterviewGreeting: vi.fn(),
  generateInterviewResponse: vi.fn(),
  synthesizeInterview: vi.fn(),
};

function rpcMethods(): string[] {
  return rpcCalls.map(call => call.method);
}

function rpcInputs(method: string): Array<Record<string, unknown>> {
  return rpcCalls.filter(call => call.method === method).map(call => call.input as Record<string, unknown>);
}

async function participantRequest(path: string, body: unknown): Promise<Request> {
  const token = await createParticipantSessionToken(
    { id: LINK_ID, studyId: STUDY_ID, studyRevision: REVISION, researcherId: null, expiresAt: null },
    HANDLE,
  );
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `${getParticipantSessionCookieName(HANDLE)}=${token}`,
      [PARTICIPANT_SESSION_HEADER_NAME]: HANDLE,
    },
    body: JSON.stringify(body),
  });
}

async function researcherRequest(
  url: string,
  init: { method: string; body?: string; preview?: boolean },
): Promise<Request> {
  const token = await createSessionToken();
  cookieJar.set(SESSION_COOKIE_NAME, token);
  return new Request(url, {
    method: init.method,
    headers: {
      'Content-Type': 'application/json',
      Cookie: `${SESSION_COOKIE_NAME}=${token}`,
      ...(init.preview ? { 'X-OpenInterviewer-Preview': '1' } : {}),
    },
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
}

const history = [
  { id: 'm1', role: 'ai' as const, content: 'What was onboarding like?', timestamp: 1 },
  { id: 'm2', role: 'user' as const, content: 'A synthetic answer.', timestamp: 2 },
];
const behaviorData = { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] };
const interviewBody = {
  history,
  participantProfile: null,
  questionProgress: { questionsAsked: [], total: 1, currentPhase: 'background', isComplete: false },
  currentContext: '',
};

function saveBody() {
  const interview = makeStoredInterview({ id: 'browser-id', studyId: STUDY_ID, transcript: history });
  return {
    id: interview.id,
    studyId: STUDY_ID,
    transcript: interview.transcript,
    participantProfile: interview.participantProfile,
    behaviorData: interview.behaviorData,
    createdAt: interview.createdAt,
  };
}

beforeEach(() => {
  for (const [name, value] of Object.entries(CLOUDFLARE_ENV)) vi.stubEnv(name, value);
  rpcCalls = [];
  handlers = defaultHandlers();
  cookieJar.clear();
  installRuntime();
  provider.getInterviewGreeting.mockResolvedValue('A synthetic greeting.');
  provider.generateInterviewResponse.mockResolvedValue({
    message: 'A synthetic follow-up.',
    questionAddressed: null,
    phaseTransition: null,
    profileUpdates: [],
    shouldConclude: false,
  });
  provider.synthesizeInterview.mockResolvedValue({
    value: {
      statedPreferences: [],
      revealedPreferences: [],
      themes: [],
      contradictions: [],
      keyInsights: ['A synthetic insight.'],
      bottomLine: 'A synthetic bottom line.',
    },
    execution: { provider: 'gemini', requestedModel: STUDY_MODEL, model: `${STUDY_MODEL}-001` },
  });
  providerFactory.mockReturnValue(provider);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  delete runtimeGlobals[WORKER_INVOCATION_ACCESSOR];
  delete runtimeGlobals[WORKER_RUNTIME_MARKER];
  vi.unstubAllEnvs();
  // No Cloudflare participant path may construct a Redis client (RT-01).
  expect(redisConstructor).not.toHaveBeenCalled();
});

describe('deployment readiness gate on the Cloudflare target (RT-08, gap F10)', () => {
  it('F10: a not-ready deployment refuses every participant and link mutation before storage or provider use', async () => {
    installRuntime(undefined, { WORKSPACE_STORE: workspaceNamespace });

    const responses = [
      await consentPOST(await participantRequest('/api/consent', { studyId: STUDY_ID })),
      await greetingPOST(await participantRequest('/api/greeting', {})),
      await interviewPOST(await participantRequest('/api/interview', interviewBody)),
      await savePOST(await participantRequest('/api/interviews/save', saveBody())),
      await synthesisPOST(await researcherRequest(`${ORIGIN}/api/synthesis`, {
        method: 'POST',
        preview: true,
        body: JSON.stringify({ studyId: STUDY_ID, history, behaviorData, participantProfile: null }),
      })),
      await generateLinkPOST(await researcherRequest(`${ORIGIN}/api/generate-link`, {
        method: 'POST',
        body: JSON.stringify({ studyConfig: { id: STUDY_ID } }),
      })),
      await exchangeGET(new Request(`${ORIGIN}/api/generate-link?token=${LINK_CODE}`)),
      await linksDELETE(
        await researcherRequest(`${ORIGIN}/api/studies/${STUDY_ID}/participant-links`, {
          method: 'DELETE',
          body: JSON.stringify({ linkId: LINK_ID }),
        }),
        { params: Promise.resolve({ id: STUDY_ID }) },
      ),
    ];

    for (const response of responses) {
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ code: 'DEPLOYMENT_NOT_READY', retryable: false });
    }
    expect(rpcCalls).toEqual([]);
    expect(providerFactory).not.toHaveBeenCalled();
    expect(afterMock).not.toHaveBeenCalled();
  });
});

describe('Workers subrequest refusal (RT-07)', () => {
  it('RT-07: greeting, interview and save refuse a subrequest identity before any store or provider call', async () => {
    installRuntime({ kind: 'subrequest' });

    const greeting = await greetingPOST(await participantRequest('/api/greeting', {}));
    const interview = await interviewPOST(await participantRequest('/api/interview', interviewBody));
    const save = await savePOST(await participantRequest('/api/interviews/save', saveBody()));

    for (const response of [greeting, interview, save]) {
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: 'Participant requests must come directly from a browser.',
        retryable: false,
      });
    }
    expect(rpcCalls).toEqual([]);
    expect(providerFactory).not.toHaveBeenCalled();
  });
});

describe('participant link exchange (RT-06, OPS-01)', () => {
  it('RT-06: exchanges the code by digest, sets a tab-scoped HttpOnly cookie and is never cached', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValueOnce(HANDLE);

    const response = await exchangeGET(new Request(`${ORIGIN}/api/generate-link?token=${LINK_CODE}`));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('set-cookie')).toContain(`participant-session-${HANDLE}=`);
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(body).toMatchObject({ valid: true, data: { sessionHandle: HANDLE, aiTransport: 'direct' } });
    expect(body.data.studyConfig).not.toHaveProperty('interviewerInstructions');
    // Exchange, then the new session's own authority re-check.
    expect(rpcInputs('getParticipantLink')).toEqual([
      expect.objectContaining({ linkId: LINK_ID, purpose: 'exchange' }),
      expect.objectContaining({ linkId: LINK_ID, purpose: 'session' }),
    ]);
    expect(JSON.stringify(rpcCalls)).not.toContain(LINK_CODE);
  });

  it('OPS-01: a draining workspace starts no new collection: 503, no cookie, never cached', async () => {
    handlers.getParticipantLink = () => ({ status: 'held', reason: 'maintenance' });

    const response = await exchangeGET(new Request(`${ORIGIN}/api/generate-link?token=${LINK_CODE}`));

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('set-cookie')).toBeNull();
    await expect(response.json()).resolves.toEqual({
      valid: false,
      error: 'New interviews cannot start right now. Please try again later.',
      retryable: true,
      reason: 'maintenance',
    });
    expect(rpcMethods()).toEqual(['getParticipantLink']);
  });

  it('RT-06: an unknown, expired or revoked code is 403 without a cookie', async () => {
    handlers.getParticipantLink = () => ({ status: 'revoked' });

    const response = await exchangeGET(new Request(`${ORIGIN}/api/generate-link?token=${LINK_CODE}`));

    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});

describe('participant link creation (RT-06, RT-09)', () => {
  function mint(url = `${ORIGIN}/api/generate-link`) {
    return researcherRequest(url, { method: 'POST', body: JSON.stringify({ studyConfig: { id: STUDY_ID } }) });
  }

  it('RT-06: persists only the code digest and builds the URL from APP_BASE_URL, never the request host', async () => {
    handlers.createParticipantLink = (input: { linkId: string; studyId: string; studyRevision: number; expiresAt: number | null; now: number }) => ({
      status: 'created',
      link: { ...linkRecord, id: input.linkId, expiresAt: input.expiresAt, createdAt: input.now },
    });

    const response = await generateLinkPOST(await mint('https://attacker.invalid/api/generate-link'));
    const body = await response.json() as { token: string; url: string };

    expect(response.status).toBe(200);
    expect(body.url).toBe(`${ORIGIN}/p/${body.token}`);
    const [created] = rpcInputs('createParticipantLink');
    expect(created).toMatchObject({ studyId: STUDY_ID, studyRevision: REVISION, linkId: sha256(body.token) });
    expect(created.expiresAt).toBe((created.now as number) + 30 * 24 * 60 * 60 * 1000);
    expect(JSON.stringify(rpcCalls)).not.toContain(body.token);
  });

  it.each([
    [{ status: 'revision-stale' }, 409],
    [{ status: 'links-disabled' }, 409],
    [{ status: 'quota-exceeded' }, 409],
    [{ status: 'study-not-found' }, 404],
  ])('RT-09: maps the write-boundary outcome %o to %i without a link', async (outcome, status) => {
    handlers.createParticipantLink = () => outcome;

    const response = await generateLinkPOST(await mint());
    const body = await response.json();

    expect(response.status).toBe(status);
    expect(body).not.toHaveProperty('token');
    expect(body).not.toHaveProperty('url');
  });

  it.each([
    ['maintenance', {
      error: 'Participant links cannot be created while this workspace is under maintenance.',
      retryable: true,
      reason: 'maintenance',
    }],
    ['recovery-epoch-mismatch', {
      error: 'Participant links cannot be created because this workspace is unavailable. Its operator must restore it.',
      retryable: false,
      reason: 'workspace-unavailable',
    }],
  ] as const)('OPS-01: a %s hold refuses link creation with copy for its public reason', async (reason, body) => {
    handlers.createParticipantLink = () => ({ status: 'held', reason });

    const response = await generateLinkPOST(await mint());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual(body);
  });

  it('RT-09: an RPC failure is a retryable 503, never a link', async () => {
    const response = await generateLinkPOST(await mint());

    expect(rpcMethods()).toContain('createParticipantLink');
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ retryable: true });
  });

  it('RT-06: an oversized body is refused before authentication or storage', async () => {
    const response = await generateLinkPOST(new Request(`${ORIGIN}/api/generate-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studyConfig: { id: STUDY_ID }, padding: 'x'.repeat(150_000) }),
    }));

    expect(response.status).toBe(413);
    expect(rpcCalls).toEqual([]);
  });
});

describe('participant link management (RT-09)', () => {
  const params = { params: Promise.resolve({ id: STUDY_ID }) };

  it('RT-09: lists metadata through the workspace store and is never cached', async () => {
    const metadata = { id: LINK_ID, studyRevision: REVISION, createdAt: 1, expiresAt: null, revokedAt: null };
    handlers.listParticipantLinks = () => ({ status: 'ok', links: [metadata], truncated: false });

    const response = await linksGET(
      await researcherRequest(`${ORIGIN}/api/studies/${STUDY_ID}/participant-links`, { method: 'GET' }),
      params,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ links: [metadata], truncated: false });
    expect(rpcInputs('listParticipantLinks')).toEqual([
      expect.objectContaining({ studyId: STUDY_ID, maximum: 1_000 }),
    ]);
  });

  it('RT-09: a list the store cannot read is a retryable 503', async () => {
    const response = await linksGET(
      await researcherRequest(`${ORIGIN}/api/studies/${STUDY_ID}/participant-links`, { method: 'GET' }),
      params,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ retryable: true });
  });

  it('RT-09/OPS-01: revokes through the store and refuses while held', async () => {
    const revoke = () => researcherRequest(`${ORIGIN}/api/studies/${STUDY_ID}/participant-links`, {
      method: 'DELETE',
      body: JSON.stringify({ linkId: LINK_ID }),
    });
    handlers.revokeParticipantLink = () => ({ status: 'revoked', revokedAt: 1_760_000_200_000 });

    const revoked = await linksDELETE(await revoke(), params);
    expect(revoked.status).toBe(200);
    await expect(revoked.json()).resolves.toEqual({
      link: { id: LINK_ID, revoked: true, revokedAt: 1_760_000_200_000 },
    });
    expect(rpcInputs('revokeParticipantLink')).toEqual([
      expect.objectContaining({ studyId: STUDY_ID, linkId: LINK_ID }),
    ]);

    handlers.revokeParticipantLink = () => ({ status: 'held', reason: 'maintenance' });
    const held = await linksDELETE(await revoke(), params);
    expect(held.status).toBe(503);
    await expect(held.json()).resolves.toMatchObject({ reason: 'maintenance', retryable: true });
  });
});

describe('server-recorded consent (ST-03, OPS-01)', () => {
  it('ST-03: records the session, current revision and consent digest, never the consent text', async () => {
    handlers.recordConsent = () => acceptedConsent;

    const response = await consentPOST(await participantRequest('/api/consent', {
      studyId: STUDY_ID,
      acceptedAt: 1,
      consentHash: 'client-controlled',
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      preview: false,
      acceptedAt: acceptedConsent.consent.acceptedAt,
    });
    const [recorded] = rpcInputs('recordConsent');
    expect(recorded).toMatchObject({
      participantSessionId: HANDLE,
      studyId: STUDY_ID,
      studyRevision: REVISION,
      consentHash: CONSENT_HASH,
    });
    expect(JSON.stringify(rpcCalls)).not.toContain(CONSENT_TEXT);
  });

  it.each([
    ['maintenance', true, 'maintenance', 'Consent cannot be recorded right now. Please try again later.'],
    [
      'recovery-epoch-mismatch',
      false,
      'workspace-unavailable',
      'Consent cannot be recorded because this study is unavailable. Please contact the researcher.',
    ],
  ] as const)('OPS-01: a %s hold that begins after the session check is a 503 with only the public reason', async (
    reason,
    retryable,
    publicReason,
    error,
  ) => {
    handlers.recordConsent = () => ({ status: 'held', reason });

    const response = await consentPOST(await participantRequest('/api/consent', { studyId: STUDY_ID }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error, retryable, reason: publicReason });
  });
});

describe('greeting and interview admission (ST-06, RT-07, OPS-01)', () => {
  it('ST-06: admits through the store with salted counter keys, then calls the canonical study provider', async () => {
    const response = await greetingPOST(await participantRequest('/api/greeting', {
      studyConfig: { id: STUDY_ID, aiProvider: 'claude', aiModel: 'claude-haiku-4-5' },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ greeting: 'A synthetic greeting.' });
    const [admission] = rpcInputs('admitParticipantRequest');
    expect(admission.operation).toBe('greeting');
    const counters = admission.counters as Array<{ key: string }>;
    expect(counters).toHaveLength(3);
    for (const counter of counters) expect(counter.key).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(admission)).not.toContain(HANDLE);
    expect(JSON.stringify(admission)).not.toContain(ADDRESS);
    // Consent is verified before any budget is charged.
    expect(rpcMethods().indexOf('verifyConsent')).toBeLessThan(rpcMethods().indexOf('admitParticipantRequest'));
    expect(providerFactory.mock.calls[0][0]).toMatchObject({ aiProvider: 'gemini', aiModel: STUDY_MODEL });
    expect(providerFactory.mock.calls[0][1]).toMatchObject({ geminiApiKey: CLOUDFLARE_ENV.GEMINI_API_KEY });
  });

  it('ST-06: interview admission uses the interview budget set', async () => {
    const response = await interviewPOST(await participantRequest('/api/interview', interviewBody));

    expect(response.status).toBe(200);
    const [admission] = rpcInputs('admitParticipantRequest');
    expect(admission.operation).toBe('interview');
    expect(admission.counters).toHaveLength(5);
    expect(provider.generateInterviewResponse).toHaveBeenCalledOnce();
  });

  it('ST-06: a limited budget is 429 with Retry-After and no provider call', async () => {
    handlers.admitParticipantRequest = () => ({ status: 'limited', rejectedIndex: 1, retryAfterSeconds: 120 });

    const response = await greetingPOST(await participantRequest('/api/greeting', {}));

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('120');
    expect(providerFactory).not.toHaveBeenCalled();
  });

  it.each([
    ['maintenance', {
      error: 'This interview is paused for maintenance. Please try again later.',
      retryable: true,
      reason: 'maintenance',
    }],
    ['recovery-epoch-mismatch', {
      error: 'This interview is unavailable right now. Please contact the researcher.',
      retryable: false,
      reason: 'workspace-unavailable',
    }],
  ] as const)('OPS-01: a %s hold that begins after the session check refuses admission as a held workspace, not a limiter failure', async (
    reason,
    body,
  ) => {
    handlers.admitParticipantRequest = () => ({ status: 'held', reason });

    for (const response of [
      await greetingPOST(await participantRequest('/api/greeting', {})),
      await interviewPOST(await participantRequest('/api/interview', interviewBody)),
    ]) {
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
      await expect(response.json()).resolves.toEqual(body);
    }
    expect(providerFactory).not.toHaveBeenCalled();
  });

  it('ST-03: missing consent is 428 before any budget or provider use', async () => {
    handlers.verifyConsent = () => ({ status: 'missing' });

    const response = await greetingPOST(await participantRequest('/api/greeting', {}));

    expect(response.status).toBe(428);
    await expect(response.json()).resolves.toMatchObject({ code: 'CONSENT_REQUIRED' });
    expect(rpcMethods()).not.toContain('admitParticipantRequest');
    expect(providerFactory).not.toHaveBeenCalled();
  });
});

describe('immutable save with its initial durable job (JOB-01, JOB-02, ST-02, ST-03)', () => {
  it('JOB-01/02: persists once with consent binding and frozen explicit-model inputs; no after() and no provider', async () => {
    expect(DEFAULT_MODEL_BY_PROVIDER.gemini).not.toBe(STUDY_MODEL);
    handlers.persistCompletedInterview = () => ({ status: 'created' });

    const response = await savePOST(await participantRequest('/api/interviews/save', saveBody()));

    expect(response.status).toBe(200);
    // The success body is unchanged from the Node route.
    await expect(response.json()).resolves.toEqual({ success: true, id: `session-${HANDLE}`, created: true });
    const persisted = rpcInputs('persistCompletedInterview');
    expect(persisted).toHaveLength(1);
    const [input] = persisted;
    expect(input).toMatchObject({
      expectedStudyRevision: REVISION,
      allowDisabledLinks: false,
      identity: { participantSessionId: HANDLE, linkId: LINK_ID },
      consent: { participantSessionId: HANDLE, studyId: STUDY_ID, studyRevision: REVISION, consentHash: CONSENT_HASH },
      initialAnalysis: {
        inputSchemaVersion: ANALYSIS_INPUT_SCHEMA_VERSION,
        studyRevision: REVISION,
        requestedProvider: 'gemini',
        requestedModel: STUDY_MODEL,
        studyConfig: expect.objectContaining({ id: STUDY_ID, aiProvider: 'gemini', aiModel: STUDY_MODEL }),
      },
      interview: expect.objectContaining({
        id: `session-${HANDLE}`,
        studyId: STUDY_ID,
        synthesis: null,
        studyRevision: REVISION,
        consentHash: CONSENT_HASH,
        conductedByProvider: 'gemini',
        conductedByModel: STUDY_MODEL,
        participantLinkId: LINK_ID,
      }),
    });
    expect(input.initialJobId).toMatch(/^[a-f0-9-]{36}$/);
    const ratePlan = input.ratePlan as Array<{ key: string }>;
    expect(ratePlan).toHaveLength(4);
    for (const row of ratePlan) expect(row.key).toMatch(/^interview-rate:[a-f0-9]{64}:\d+$/);
    // The binding carries the consent digest only (the frozen study config
    // holds the researcher's consent text as part of the study).
    expect(input.consent).not.toHaveProperty('consentText');
    expect(afterMock).not.toHaveBeenCalled();
    expect(providerFactory).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: 'link-inactive' }, 403, { error: 'Participant link is no longer active.' }],
    [{ status: 'consent-required' }, 428, {
      error: 'Verified participant consent is required before saving.',
      code: 'CONSENT_REQUIRED',
    }],
    [{ status: 'held', reason: 'maintenance' }, 503, {
      error: 'Storage is temporarily unavailable. Interview not saved. Please try again.',
      retryable: true,
      reason: 'maintenance',
    }],
    [{ status: 'held', reason: 'workspace-identity-mismatch' }, 503, {
      error: 'Storage is temporarily unavailable. Interview not saved. Please try again.',
      retryable: true,
      reason: 'workspace-unavailable',
    }],
    [{ status: 'revision-stale' }, 409, {
      error: 'This study changed before the interview could be saved. Restart with the latest study link.',
    }],
    [{ status: 'rate-limited' }, 429, {
      error: 'Too many save attempts. Please wait before trying again.',
      retryable: true,
    }],
    [{ status: 'duplicate' }, 200, { success: true, id: `session-${HANDLE}`, created: false, duplicate: true }],
  ])('ST-02/03: maps the write-boundary outcome %o to %i and never schedules analysis', async (outcome, status, body) => {
    handlers.persistCompletedInterview = () => outcome;

    const response = await savePOST(await participantRequest('/api/interviews/save', saveBody()));

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual(body);
    expect(afterMock).not.toHaveBeenCalled();
    expect(providerFactory).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: 'id-collision' }],
    [{ status: 'persisted' }],
  ])('ST-02: an unrecognized persist outcome %o is a retryable 503, never success', async (outcome) => {
    handlers.persistCompletedInterview = () => outcome;

    const response = await savePOST(await participantRequest('/api/interviews/save', saveBody()));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'Storage is temporarily unavailable. Interview not saved. Please try again.',
      retryable: true,
    });
    expect(afterMock).not.toHaveBeenCalled();
    expect(providerFactory).not.toHaveBeenCalled();
    // The durable client closes the reply set: an out-of-union status becomes
    // ambiguous there and is logged by operation, never by reply content.
    const logged = vi.mocked(console.error).mock.calls.map(([line]) => String(line));
    expect(logged.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({
      event: 'workspace.store',
      operation: 'persistCompletedInterview',
      reason: 'unknown-outcome',
    }));
    expect(logged.join('\n')).not.toContain(outcome.status);
  });

  it('ST-02: an RPC failure after submission is a retryable 503, never success', async () => {
    const response = await savePOST(await participantRequest('/api/interviews/save', saveBody()));

    expect(rpcMethods()).toContain('persistCompletedInterview');
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ retryable: true });
    expect(afterMock).not.toHaveBeenCalled();
  });

  it('ST-03: the route-level consent check still refuses before persistence', async () => {
    handlers.verifyConsent = () => ({ status: 'mismatch' });

    const response = await savePOST(await participantRequest('/api/interviews/save', saveBody()));

    expect(response.status).toBe(428);
    expect(rpcMethods()).not.toContain('persistCompletedInterview');
  });
});

describe('steady-state workspace holds on participant routes (OPS-01)', () => {
  // What the object answers while it stays held: every participant-session
  // operation is refused, the session's own link check included, while reads
  // (study, consent verification) stay open. The request stops at the link
  // check, and the resolver reports the hold so each route answers with its
  // held-workspace copy and public reason, not a generic storage failure.
  function holdWorkspace(reason: 'maintenance' | 'recovery-epoch-mismatch') {
    const held = () => ({ status: 'held', reason });
    handlers.readiness = () => (reason === 'maintenance'
      ? { status: 'ready', maintenance: 'frozen' }
      : { status: 'held', reason });
    handlers.getParticipantLink = held;
    handlers.recordConsent = held;
    handlers.admitParticipantRequest = held;
    handlers.persistCompletedInterview = held;
  }

  async function participantResponses() {
    return {
      consent: await consentPOST(await participantRequest('/api/consent', { studyId: STUDY_ID })),
      greeting: await greetingPOST(await participantRequest('/api/greeting', {})),
      interview: await interviewPOST(await participantRequest('/api/interview', interviewBody)),
      save: await savePOST(await participantRequest('/api/interviews/save', saveBody())),
    };
  }

  it.each([
    ['maintenance', 'a frozen workspace', {
      consent: {
        error: 'Consent cannot be recorded right now. Please try again later.',
        retryable: true,
        reason: 'maintenance',
      },
      greeting: {
        error: 'This interview is paused for maintenance. Please try again later.',
        retryable: true,
        reason: 'maintenance',
      },
      interview: {
        error: 'This interview is paused for maintenance. Please try again later.',
        retryable: true,
        reason: 'maintenance',
      },
      save: {
        error: 'Storage is temporarily unavailable. Interview not saved. Please try again.',
        retryable: true,
        reason: 'maintenance',
      },
    }],
    ['recovery-epoch-mismatch', 'an epoch hold', {
      consent: {
        error: 'Consent cannot be recorded because this study is unavailable. Please contact the researcher.',
        retryable: false,
        reason: 'workspace-unavailable',
      },
      greeting: {
        error: 'This interview is unavailable right now. Please contact the researcher.',
        retryable: false,
        reason: 'workspace-unavailable',
      },
      interview: {
        error: 'This interview is unavailable right now. Please contact the researcher.',
        retryable: false,
        reason: 'workspace-unavailable',
      },
      // The participant keeps the transcript and retries the save.
      save: {
        error: 'Storage is temporarily unavailable. Interview not saved. Please try again.',
        retryable: true,
        reason: 'workspace-unavailable',
      },
    }],
  ] as const)(
    'OPS-01: a %s hold (%s) refuses consent, greeting, interview and save with the held response before any work',
    async (reason, _label, expected) => {
      holdWorkspace(reason);

      const responses = await participantResponses();

      for (const [route, response] of Object.entries(responses)) {
        expect(response.status, route).toBe(503);
        expect(response.headers.get('cache-control'), route).toBe('no-store');
        await expect(response.json(), route).resolves.toEqual(expected[route as keyof typeof expected]);
      }
      const logged = vi.mocked(console.error).mock.calls.map(([line]) => JSON.parse(String(line)));
      for (const route of ['/api/consent', '/api/greeting', '/api/interview', '/api/interviews/save']) {
        expect(logged).toContainEqual(expect.objectContaining({
          event: 'workspace.store',
          route,
          status: 503,
          reason: reason === 'maintenance' ? 'maintenance-hold' : 'epoch-mismatch',
        }));
      }
      expect(new Set(rpcMethods())).toEqual(new Set(['getParticipantLink']));
      expect(providerFactory).not.toHaveBeenCalled();
      expect(afterMock).not.toHaveBeenCalled();
    },
  );
});

describe('researcher preview under maintenance (gap F26)', () => {
  function previewSynthesis() {
    return researcherRequest(`${ORIGIN}/api/synthesis`, {
      method: 'POST',
      preview: true,
      body: JSON.stringify({ studyId: STUDY_ID, history, behaviorData, participantProfile: null }),
    });
  }

  it('F26: preview synthesis runs while draining and never persists', async () => {
    handlers.readiness = () => ({ status: 'ready', maintenance: 'draining' });

    const response = await synthesisPOST(await previewSynthesis());

    expect(response.status).toBe(200);
    expect(provider.synthesizeInterview).toHaveBeenCalledOnce();
    expect(rpcMethods()).not.toContain('persistCompletedInterview');
    expect(rpcMethods().every(method => ['getStudy', 'readiness'].includes(method))).toBe(true);
  });

  it.each(['frozen', 'recovery'] as const)('F26: preview synthesis is refused while %s, before the provider', async (maintenance) => {
    handlers.readiness = () => ({ status: 'ready', maintenance });

    const response = await synthesisPOST(await previewSynthesis());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ retryable: true, reason: 'maintenance' });
    expect(providerFactory).not.toHaveBeenCalled();
  });

  it('F26: preview greeting is refused for a held workspace, before the provider', async () => {
    handlers.readiness = () => ({ status: 'held', reason: 'recovery-epoch-mismatch' });

    const response = await greetingPOST(await researcherRequest(`${ORIGIN}/api/greeting`, {
      method: 'POST',
      preview: true,
      body: JSON.stringify({ studyId: STUDY_ID }),
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ retryable: false, reason: 'workspace-unavailable' });
    expect(providerFactory).not.toHaveBeenCalled();
    expect(rpcMethods()).not.toContain('admitParticipantRequest');
  });
});
