// @vitest-environment node
//
// One held-workspace policy across every researcher and participant route
// that can refuse a held durable workspace (OPS-01): every hold is a no-store
// 503 with the route's copy and only the public reason. `maintenance` is
// retryable; every other hold is `workspace-unavailable` and not retryable,
// except where the route documents otherwise (save keeps the transcript in the
// browser; an analysis retry repeats the same key). The table covers every
// hold reason at every held branch: the participant session's own link check
// (the object refuses it while frozen or under an epoch hold), write-boundary
// holds, and readiness holds. Real configuration, contexts, authentication
// and Durable Object client; only the object behind WORKSPACE_STORE is a
// scripted fake that records every RPC.

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
import { DELETE as linksDELETE } from '@/app/api/studies/[id]/participant-links/route';
import { POST as consentPOST } from '@/app/api/consent/route';
import { POST as greetingPOST } from '@/app/api/greeting/route';
import { POST as interviewPOST } from '@/app/api/interview/route';
import { POST as savePOST } from '@/app/api/interviews/save/route';
import { POST as synthesisPOST } from '@/app/api/synthesis/route';
import { GET as studiesGET, POST as studiesPOST } from '@/app/api/studies/route';
import { DELETE as studyDELETE, PUT as studyPUT } from '@/app/api/studies/[id]/route';
import { DELETE as sampleDELETE, POST as samplePOST } from '@/app/api/demo/seed/route';
import { POST as followupPOST } from '@/app/api/studies/[id]/generate-followup/route';
import { POST as aggregatePOST } from '@/app/api/synthesis/aggregate/route';
import { POST as analyzePOST } from '@/app/api/interviews/[id]/analyze/route';
import {
  createParticipantSessionToken,
  createSessionToken,
  getParticipantSessionCookieName,
  PARTICIPANT_SESSION_HEADER_NAME,
  SESSION_COOKIE_NAME,
} from '@/lib/auth';
import {
  WORKER_INVOCATION_ACCESSOR,
  WORKER_RUNTIME_MARKER,
  type WorkerInvocation,
} from '@/lib/runtime/workerInvocation';
import type { WorkspaceHoldReason } from '@/lib/storage/types';
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

const STUDY_ID = '11111111-1111-4111-8111-111111111111';
const INTERVIEW_ID = 'interview-held-1';
const REVISION = 3;
const STUDY_MODEL = 'gemini-2.5-pro';
const CONSENT_TEXT = 'Synthetic consent text for the held-workspace table.';
const LINK_CODE = `${'Q'.repeat(21)}_${'r'.repeat(21)}`;
const HANDLE = '3f0c9a52-7c1e-4b8e-9a51-1d2e3f4a5b6c';
const IDEMPOTENCY_KEY = '22222222-2222-4222-8222-222222222222';

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

const LINK_ID = sha256(LINK_CODE);

const HOLD_REASONS: ReadonlyArray<WorkspaceHoldReason> = [
  'maintenance',
  'schema-unsupported',
  'workspace-identity-mismatch',
  'workspace-uninitialized',
  'recovery-epoch-mismatch',
];

// The allowlisted log reason for each internal hold reason.
const LOGGED: Record<WorkspaceHoldReason, string> = {
  maintenance: 'maintenance-hold',
  'schema-unsupported': 'schema-unsupported',
  'workspace-identity-mismatch': 'workspace-identity-mismatch',
  'workspace-uninitialized': 'not-configured',
  'recovery-epoch-mismatch': 'epoch-mismatch',
};

type Handler = (input: never) => unknown;
const runtimeGlobals = globalThis as unknown as Record<symbol, unknown>;
let rpcCalls: Array<{ method: string; input: unknown }> = [];
let handlers: Record<string, Handler> = {};

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

function installRuntime(): void {
  const invocation: WorkerInvocation = {
    env: {
      ...CLOUDFLARE_ENV,
      WORKSPACE_STORE: workspaceNamespace,
      ANALYSIS_QUEUE: { send: async () => undefined, sendBatch: async () => undefined },
    },
    identity: { kind: 'address', address: '203.0.113.7' },
    source: 'fetch',
  };
  runtimeGlobals[WORKER_RUNTIME_MARKER] = true;
  runtimeGlobals[WORKER_INVOCATION_ACCESSOR] = () => invocation;
}

function canonicalStudy(): StoredStudy {
  const config = makeStudyConfig({
    id: STUDY_ID,
    name: 'Held workspace study',
    aiProvider: 'gemini',
    aiModel: STUDY_MODEL,
    consentText: CONSENT_TEXT,
    createdAt: 1_760_000_000_000,
  });
  return makeStoredStudy({ id: STUDY_ID, config, revision: REVISION });
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

function defaultHandlers(): Record<string, Handler> {
  return {
    readiness: () => ({ status: 'ready', maintenance: 'open' }),
    getStudy: () => ({ status: 'found', study: canonicalStudy() }),
    getParticipantLink: () => ({ status: 'found', link: linkRecord }),
    verifyConsent: () => ({
      status: 'accepted',
      consent: {
        version: 1,
        participantSessionId: HANDLE,
        studyId: STUDY_ID,
        studyRevision: REVISION,
        consentHash: sha256(CONSENT_TEXT),
        acceptedAt: 1_760_000_100_000,
      },
    }),
    admitParticipantRequest: () => ({ status: 'admitted' }),
  };
}

// ---------- Requests ----------

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
  path: string,
  init: { method: string; body?: unknown; preview?: boolean; headers?: Record<string, string> },
): Promise<Request> {
  const token = await createSessionToken();
  cookieJar.set(SESSION_COOKIE_NAME, token);
  return new Request(`${ORIGIN}${path}`, {
    method: init.method,
    headers: {
      'Content-Type': 'application/json',
      Cookie: `${SESSION_COOKIE_NAME}=${token}`,
      ...(init.preview ? { 'X-OpenInterviewer-Preview': '1' } : {}),
      ...init.headers,
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
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

const studyParams = () => ({ params: Promise.resolve({ id: STUDY_ID }) });

// ---------- Hold scripting ----------

const heldOutcome = (reason: WorkspaceHoldReason) => () => ({ status: 'held', reason });

/** The object refuses the participant session's own link check. */
function sessionLinkHold(reason: WorkspaceHoldReason): void {
  handlers.getParticipantLink = (input: { purpose?: string }) => (input.purpose === 'session'
    ? { status: 'held', reason }
    : { status: 'found', link: linkRecord });
}

/** Link exchange (new collection start) refused. */
function exchangeHold(reason: WorkspaceHoldReason): void {
  handlers.getParticipantLink = (input: { purpose?: string }) => (input.purpose === 'exchange'
    ? { status: 'held', reason }
    : { status: 'found', link: linkRecord });
}

/** Readiness as the object reports it: frozen for maintenance, otherwise the hold. */
function readinessHold(reason: WorkspaceHoldReason): void {
  handlers.readiness = () => (reason === 'maintenance'
    ? { status: 'ready', maintenance: 'frozen' }
    : { status: 'held', reason });
}

function writeHold(method: string, extra: Record<string, unknown> = {}) {
  return (reason: WorkspaceHoldReason) => {
    handlers[method] = () => ({ status: 'held', reason, ...extra });
  };
}

// ---------- Route copy (hard-coded so a copy regression fails here) ----------

type Copy = { maintenance: string; unavailable: string };

const CONSENT_COPY: Copy = {
  maintenance: 'Consent cannot be recorded right now. Please try again later.',
  unavailable: 'Consent cannot be recorded because this study is unavailable. Please contact the researcher.',
};
const INTERVIEW_COPY: Copy = {
  maintenance: 'This interview is paused for maintenance. Please try again later.',
  unavailable: 'This interview is unavailable right now. Please contact the researcher.',
};
const SAVE_COPY: Copy = {
  maintenance: 'Storage is temporarily unavailable. Interview not saved. Please try again.',
  unavailable: 'Storage is temporarily unavailable. Interview not saved. Please try again.',
};
const EXCHANGE_COPY: Copy = {
  maintenance: 'New interviews cannot start right now. Please try again later.',
  unavailable: 'Unable to verify participant link.',
};
const PREVIEW_COPY: Copy = {
  maintenance: 'Researcher preview is unavailable while this workspace is under maintenance.',
  unavailable: 'Researcher preview cannot run because this workspace is unavailable. Its operator must restore it.',
};
const RESEARCHER_COPY: Copy = {
  maintenance: 'This workspace is paused for maintenance. Try again later.',
  unavailable: 'Workspace storage is unavailable until its operator completes setup or recovery.',
};
const ANALYSIS_COPY: Copy = {
  maintenance: 'Analysis is paused while this workspace is under maintenance. Try again later.',
  unavailable: 'Analysis is temporarily unavailable. Please try again.',
};
function actionCopy(action: string): Copy {
  return {
    maintenance: `${action} while this workspace is under maintenance.`,
    unavailable: `${action} because this workspace is unavailable. Its operator must restore it.`,
  };
}

type HeldCase = {
  name: string;
  /** The route name in the allowlisted log. */
  route: string;
  hold: (reason: WorkspaceHoldReason) => void;
  call: () => Promise<Response>;
  /** The RPC whose refusal produced the hold; nothing runs after it. */
  heldRpc: string;
  copy: Copy;
  /** Documented route override of the retry policy. */
  retryable?: true;
  body?: Record<string, unknown>;
  /** Holds under which the route does not refuse (reads under an epoch hold or maintenance). */
  reasons?: ReadonlyArray<WorkspaceHoldReason>;
};

const CASES: HeldCase[] = [
  // Participant session: the object refuses the session's own link check.
  {
    name: 'consent (session link check)',
    route: '/api/consent',
    hold: sessionLinkHold,
    call: async () => consentPOST(await participantRequest('/api/consent', { studyId: STUDY_ID })),
    heldRpc: 'getParticipantLink',
    copy: CONSENT_COPY,
  },
  {
    name: 'greeting (session link check)',
    route: '/api/greeting',
    hold: sessionLinkHold,
    call: async () => greetingPOST(await participantRequest('/api/greeting', {})),
    heldRpc: 'getParticipantLink',
    copy: INTERVIEW_COPY,
  },
  {
    name: 'interview (session link check)',
    route: '/api/interview',
    hold: sessionLinkHold,
    call: async () => interviewPOST(await participantRequest('/api/interview', interviewBody)),
    heldRpc: 'getParticipantLink',
    copy: INTERVIEW_COPY,
  },
  {
    name: 'save (session link check)',
    route: '/api/interviews/save',
    hold: sessionLinkHold,
    call: async () => savePOST(await participantRequest('/api/interviews/save', saveBody())),
    heldRpc: 'getParticipantLink',
    copy: SAVE_COPY,
    retryable: true,
  },
  // Participant holds that begin after the session check.
  {
    name: 'consent (record)',
    route: '/api/consent',
    hold: writeHold('recordConsent'),
    call: async () => consentPOST(await participantRequest('/api/consent', { studyId: STUDY_ID })),
    heldRpc: 'recordConsent',
    copy: CONSENT_COPY,
  },
  {
    name: 'greeting (admission)',
    route: '/api/greeting',
    hold: writeHold('admitParticipantRequest'),
    call: async () => greetingPOST(await participantRequest('/api/greeting', {})),
    heldRpc: 'admitParticipantRequest',
    copy: INTERVIEW_COPY,
  },
  {
    name: 'interview (admission)',
    route: '/api/interview',
    hold: writeHold('admitParticipantRequest'),
    call: async () => interviewPOST(await participantRequest('/api/interview', interviewBody)),
    heldRpc: 'admitParticipantRequest',
    copy: INTERVIEW_COPY,
  },
  {
    name: 'save (completion write)',
    route: '/api/interviews/save',
    hold: writeHold('persistCompletedInterview'),
    call: async () => savePOST(await participantRequest('/api/interviews/save', saveBody())),
    heldRpc: 'persistCompletedInterview',
    copy: SAVE_COPY,
    retryable: true,
  },
  // Link exchange, and the new session's re-check right after it.
  {
    name: 'link exchange',
    route: '/api/generate-link',
    hold: exchangeHold,
    call: () => exchangeGET(new Request(`${ORIGIN}/api/generate-link?token=${LINK_CODE}`)),
    heldRpc: 'getParticipantLink',
    copy: EXCHANGE_COPY,
    body: { valid: false },
  },
  {
    name: 'link exchange (new session re-check)',
    route: '/api/generate-link',
    hold: sessionLinkHold,
    call: () => exchangeGET(new Request(`${ORIGIN}/api/generate-link?token=${LINK_CODE}`)),
    heldRpc: 'getParticipantLink',
    copy: EXCHANGE_COPY,
    body: { valid: false },
  },
  // Researcher preview (paid, no write).
  {
    name: 'greeting preview',
    route: '/api/greeting',
    hold: readinessHold,
    call: async () => greetingPOST(await researcherRequest('/api/greeting', {
      method: 'POST',
      preview: true,
      body: { studyId: STUDY_ID },
    })),
    heldRpc: 'readiness',
    copy: PREVIEW_COPY,
  },
  {
    name: 'interview preview',
    route: '/api/interview',
    hold: readinessHold,
    call: async () => interviewPOST(await researcherRequest('/api/interview', {
      method: 'POST',
      preview: true,
      body: { ...interviewBody, studyId: STUDY_ID },
    })),
    heldRpc: 'readiness',
    copy: PREVIEW_COPY,
  },
  {
    name: 'synthesis preview',
    route: '/api/synthesis',
    hold: readinessHold,
    call: async () => synthesisPOST(await researcherRequest('/api/synthesis', {
      method: 'POST',
      preview: true,
      body: { studyId: STUDY_ID, history, behaviorData, participantProfile: null },
    })),
    heldRpc: 'readiness',
    copy: PREVIEW_COPY,
  },
  // Researcher routes.
  {
    name: 'generate link',
    route: '/api/generate-link',
    hold: writeHold('createParticipantLink'),
    call: async () => generateLinkPOST(await researcherRequest('/api/generate-link', {
      method: 'POST',
      body: { studyConfig: { id: STUDY_ID } },
    })),
    heldRpc: 'createParticipantLink',
    copy: actionCopy('Participant links cannot be created'),
  },
  {
    name: 'revoke link',
    route: '/api/studies/[id]/participant-links',
    hold: writeHold('revokeParticipantLink'),
    call: async () => linksDELETE(
      await researcherRequest(`/api/studies/${STUDY_ID}/participant-links`, {
        method: 'DELETE',
        body: { linkId: LINK_ID },
      }),
      studyParams(),
    ),
    heldRpc: 'revokeParticipantLink',
    copy: actionCopy('Participant links cannot be revoked'),
  },
  {
    name: 'list studies (read readiness)',
    route: '/api/studies',
    hold: readinessHold,
    call: async () => {
      await researcherRequest('/api/studies', { method: 'GET' });
      return studiesGET();
    },
    heldRpc: 'readiness',
    copy: RESEARCHER_COPY,
    // Reads continue in every maintenance state and under an epoch hold.
    reasons: ['schema-unsupported', 'workspace-identity-mismatch', 'workspace-uninitialized'],
  },
  {
    name: 'create study',
    route: '/api/studies',
    hold: writeHold('createStudy'),
    call: async () => studiesPOST(await researcherRequest('/api/studies', {
      method: 'POST',
      body: { config: makeStudyConfig({ aiProvider: 'gemini', aiModel: STUDY_MODEL }) },
      headers: { 'Idempotency-Key': IDEMPOTENCY_KEY },
    })),
    heldRpc: 'createStudy',
    copy: RESEARCHER_COPY,
  },
  {
    name: 'update study (readiness)',
    route: '/api/studies/[id]',
    hold: readinessHold,
    call: async () => studyPUT(
      await researcherRequest(`/api/studies/${STUDY_ID}`, { method: 'PUT', body: { config: { name: 'Later' } } }),
      studyParams(),
    ),
    heldRpc: 'readiness',
    copy: RESEARCHER_COPY,
  },
  {
    name: 'update study (config write)',
    route: '/api/studies/[id]',
    hold: writeHold('replaceStudyConfig'),
    call: async () => studyPUT(
      await researcherRequest(`/api/studies/${STUDY_ID}`, { method: 'PUT', body: { config: { name: 'Later' } } }),
      studyParams(),
    ),
    heldRpc: 'replaceStudyConfig',
    copy: RESEARCHER_COPY,
  },
  {
    name: 'update study (links write)',
    route: '/api/studies/[id]',
    hold: writeHold('setStudyLinksEnabled'),
    call: async () => studyPUT(
      await researcherRequest(`/api/studies/${STUDY_ID}`, { method: 'PUT', body: { linksEnabled: false } }),
      studyParams(),
    ),
    heldRpc: 'setStudyLinksEnabled',
    copy: RESEARCHER_COPY,
  },
  {
    name: 'delete study (readiness)',
    route: '/api/studies/[id]',
    hold: readinessHold,
    call: async () => studyDELETE(await researcherRequest(`/api/studies/${STUDY_ID}`, { method: 'DELETE' }), studyParams()),
    heldRpc: 'readiness',
    copy: RESEARCHER_COPY,
  },
  {
    name: 'delete study (write)',
    route: '/api/studies/[id]',
    hold: writeHold('deleteStudy', { success: false }),
    call: async () => studyDELETE(await researcherRequest(`/api/studies/${STUDY_ID}`, { method: 'DELETE' }), studyParams()),
    heldRpc: 'deleteStudy',
    copy: RESEARCHER_COPY,
  },
  {
    name: 'load sample workspace (readiness)',
    route: '/api/demo/seed',
    hold: readinessHold,
    call: async () => {
      await researcherRequest('/api/demo/seed', { method: 'POST' });
      return samplePOST();
    },
    heldRpc: 'readiness',
    copy: RESEARCHER_COPY,
  },
  {
    name: 'load sample workspace (write)',
    route: '/api/demo/seed',
    hold: writeHold('seedSampleWorkspace'),
    call: async () => {
      await researcherRequest('/api/demo/seed', { method: 'POST' });
      return samplePOST();
    },
    heldRpc: 'seedSampleWorkspace',
    copy: RESEARCHER_COPY,
  },
  {
    name: 'clear sample workspace',
    route: '/api/demo/seed',
    hold: writeHold('clearSampleWorkspace'),
    call: async () => {
      await researcherRequest('/api/demo/seed', { method: 'DELETE' });
      return sampleDELETE();
    },
    heldRpc: 'clearSampleWorkspace',
    copy: RESEARCHER_COPY,
  },
  {
    name: 'follow-up generation',
    route: '/api/studies/[id]/generate-followup',
    hold: readinessHold,
    call: async () => followupPOST(
      await researcherRequest(`/api/studies/${STUDY_ID}/generate-followup`, { method: 'POST' }),
      studyParams(),
    ),
    heldRpc: 'readiness',
    copy: RESEARCHER_COPY,
  },
  {
    name: 'aggregate synthesis',
    route: '/api/synthesis/aggregate',
    hold: readinessHold,
    call: async () => aggregatePOST(await researcherRequest('/api/synthesis/aggregate', {
      method: 'POST',
      body: { studyId: STUDY_ID },
    })),
    heldRpc: 'readiness',
    copy: RESEARCHER_COPY,
  },
  {
    name: 'analysis retry',
    route: '/api/interviews/[id]/analyze',
    hold: writeHold('acceptAnalysisRetry'),
    call: async () => analyzePOST(
      await researcherRequest(`/api/interviews/${INTERVIEW_ID}/analyze?studyId=${STUDY_ID}`, {
        method: 'POST',
        body: { expectedGeneration: 1 },
        headers: { 'X-OpenInterviewer-Analysis-Version': '2', 'Idempotency-Key': IDEMPOTENCY_KEY },
      }),
      { params: Promise.resolve({ id: INTERVIEW_ID }) },
    ),
    heldRpc: 'acceptAnalysisRetry',
    copy: ANALYSIS_COPY,
    // API-01: the client repeats the same key and body after any 503.
    retryable: true,
  },
];

const TABLE = CASES.flatMap(entry => (entry.reasons ?? HOLD_REASONS).map(reason => [entry.name, reason, entry] as const));

beforeEach(() => {
  for (const [name, value] of Object.entries(CLOUDFLARE_ENV)) vi.stubEnv(name, value);
  rpcCalls = [];
  handlers = defaultHandlers();
  cookieJar.clear();
  installRuntime();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  delete runtimeGlobals[WORKER_INVOCATION_ACCESSOR];
  delete runtimeGlobals[WORKER_RUNTIME_MARKER];
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  providerFactory.mockReset();
  afterMock.mockReset();
  expect(redisConstructor).not.toHaveBeenCalled();
});

describe('one held-workspace response on every researcher and participant route (OPS-01)', () => {
  it('covers every hold reason on every held branch', () => {
    expect(new Set(TABLE.map(([, reason]) => reason))).toEqual(new Set(HOLD_REASONS));
    expect(CASES.length).toBeGreaterThanOrEqual(28);
  });

  it.each(TABLE)('%s: a %s hold', async (_name, reason, entry) => {
    entry.hold(reason);

    const response = await entry.call();

    const maintenance = reason === 'maintenance';
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('set-cookie')).toBeNull();
    const body = await response.json() as Record<string, unknown>;
    expect(body).toEqual({
      ...entry.body,
      error: maintenance ? entry.copy.maintenance : entry.copy.unavailable,
      retryable: entry.retryable ?? maintenance,
      reason: maintenance ? 'maintenance' : 'workspace-unavailable',
    });
    // The internal hold reason reaches the allowlisted log only.
    if (!maintenance) expect(JSON.stringify(body)).not.toContain(reason);
    const logged = vi.mocked(console.error).mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(logged).toContainEqual(expect.objectContaining({
      event: 'workspace.store',
      route: entry.route,
      status: 503,
      reason: LOGGED[reason],
    }));
    // The request stopped at the refusal: no later RPC, provider call or
    // deferred work.
    expect(rpcCalls.at(-1)?.method).toBe(entry.heldRpc);
    expect(providerFactory).not.toHaveBeenCalled();
    expect(afterMock).not.toHaveBeenCalled();
  });
});
