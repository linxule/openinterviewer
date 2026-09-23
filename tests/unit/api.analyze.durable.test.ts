// @vitest-environment node
//
// Durable analysis API v2 at the route boundary on the Cloudflare target
// (03-analysis-jobs.md API-01/API-02, JOB-02/JOB-04, gap F10/F18). Real
// configuration, readiness gate, researcher session verification, researcher
// context and Durable Object client; only the WorkspaceStore object behind
// the WORKSPACE_STORE binding is a scripted fake that records every RPC. The
// object's own receipt/generation semantics are exercised against real
// SQLite in tests/workers/analysis.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredStudy, makeStudyConfig } from '../fixtures/models';

const redisConstructor = vi.hoisted(() => vi.fn());
vi.mock('@upstash/redis', () => ({ Redis: redisConstructor }));

vi.mock('@/lib/kvClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/kvClient')>();
  return {
    ...actual,
    getKVClient: vi.fn(actual.getKVClient),
    getPlatformClient: vi.fn(actual.getPlatformClient),
    getResearcherClient: vi.fn(actual.getResearcherClient),
  };
});

const cookieJar = vi.hoisted(() => new Map<string, string>());
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined),
  })),
}));

import { GET, OPTIONS, POST } from '@/app/api/interviews/[id]/analyze/route';
import { createParticipantSessionToken, createSessionToken, SESSION_COOKIE_NAME } from '@/lib/auth';
import * as kvClient from '@/lib/kvClient';
import { DEFAULT_MODEL_BY_PROVIDER } from '@/lib/providerRegistry';
import {
  WORKER_INVOCATION_ACCESSOR,
  WORKER_RUNTIME_MARKER,
  type WorkerInvocation,
} from '@/lib/runtime/workerInvocation';
import type { AcceptAnalysisRetryInput } from '@/lib/storage/analysisProtocol';
import { analysisRequestFingerprint, analysisRequestKeyDigest } from '@/lib/storage/durableObject';
import type { StoredStudy } from '@/types';

const WORKSPACE_ID = 'ws_0123456789abcdef0123456789abcdef';
const CLOUDFLARE_ENV: Record<string, string> = {
  DEPLOYMENT_TARGET: 'cloudflare',
  DEPLOYMENT_MODE: 'standalone',
  AI_TRANSPORT: 'direct',
  AI_PROVIDER: 'openai',
  APP_BASE_URL: 'https://openinterviewer.example.workers.dev',
  ADMIN_PASSWORD: 'synthetic-admin-password-1',
  SESSION_SECRET: 'synthetic-session-secret-0123456789abcdefgh',
  PARTICIPANT_TOKEN_SECRET: 'synthetic-participant-secret-0123456789abcd',
  RATE_LIMIT_SALT: 'synthetic-rate-limit-salt-0123456789abcdef',
  OPERATOR_TOKEN: 'synthetic-operator-token-0123456789abcdefg',
  OPENAI_API_KEY: 'synthetic-openai-provider-key',
  WORKSPACE_ID,
  WORKSPACE_JURISDICTION: '',
  ANALYSIS_RECOVERY_EPOCH: 'ep_fedcba9876543210fedcba9876543210',
};
const MANAGED_ENV = [...Object.keys(CLOUDFLARE_ENV), 'NODE_ENV'];

const STUDY_ID = 'study-durable-a';
const INTERVIEW_ID = 'session-3f0c9a52-7c1e-4b8e-9a51-1d2e3f4a5b6c';
const KEY = '6f1d8a8e-2d7c-4c1e-9d55-3a2f5b6c7d8e';
const OTHER_KEY = '0b7e4c2a-9f13-4d6e-8a21-5c4b3a2f1e0d';

type RpcCall = { method: string; input: unknown };
type Handler = (input: never) => unknown;

const runtimeGlobals = globalThis as unknown as Record<symbol, unknown>;
let savedEnv: Record<string, string | undefined> = {};
let rpcCalls: RpcCall[] = [];
let handlers: Record<string, Handler> = {};

// Every RPC the route makes is recorded; an unscripted one throws, which the
// client maps to unavailable, and tests assert on the recorded list.
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

function installInvocation(bindings: Record<string, unknown>): void {
  const invocation: WorkerInvocation = {
    env: { ...CLOUDFLARE_ENV, ...bindings },
    identity: { kind: 'address', address: '203.0.113.7' },
    source: 'fetch',
  };
  runtimeGlobals[WORKER_INVOCATION_ACCESSOR] = () => invocation;
}

function canonicalStudy(overrides: Partial<StoredStudy> = {}): StoredStudy {
  const config = makeStudyConfig({
    id: STUDY_ID,
    name: 'Durable analysis study',
    aiProvider: 'openai',
    aiModel: DEFAULT_MODEL_BY_PROVIDER.openai,
    createdAt: 1_760_000_000_000,
  });
  return makeStoredStudy({ id: STUDY_ID, config, revision: 3, ...overrides });
}

async function signIn(): Promise<void> {
  cookieJar.set(SESSION_COOKIE_NAME, await createSessionToken());
}

function analyzeUrl(studyId = STUDY_ID, interviewId = INTERVIEW_ID): string {
  return `https://openinterviewer.example.workers.dev/api/interviews/${interviewId}/analyze?studyId=${studyId}`;
}

function post(options: {
  headers?: Record<string, string | undefined>;
  body?: string;
  studyId?: string;
  interviewId?: string;
} = {}) {
  const headers: Record<string, string> = {};
  const merged: Record<string, string | undefined> = {
    'X-OpenInterviewer-Analysis-Version': '2',
    'Idempotency-Key': KEY,
    'Content-Type': 'application/json',
    ...options.headers,
  };
  for (const [name, value] of Object.entries(merged)) if (value !== undefined) headers[name] = value;
  const interviewId = options.interviewId ?? INTERVIEW_ID;
  return POST(
    new Request(analyzeUrl(options.studyId, interviewId), {
      method: 'POST',
      headers,
      body: options.body ?? JSON.stringify({ expectedGeneration: 1 }),
    }),
    { params: Promise.resolve({ id: interviewId }) },
  );
}

function get(studyId = STUDY_ID, interviewId = INTERVIEW_ID) {
  return GET(new Request(analyzeUrl(studyId, interviewId)), { params: Promise.resolve({ id: interviewId }) });
}

const methods = () => rpcCalls.map((call) => call.method);
const acceptInputs = () =>
  rpcCalls.filter((call) => call.method === 'acceptAnalysisRetry').map((call) => call.input as AcceptAnalysisRetryInput);

beforeEach(async () => {
  savedEnv = Object.fromEntries(MANAGED_ENV.map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(CLOUDFLARE_ENV)) process.env[name] = value;
  Reflect.deleteProperty(process.env, 'NODE_ENV');
  runtimeGlobals[WORKER_RUNTIME_MARKER] = true;
  installInvocation({ WORKSPACE_STORE: workspaceNamespace, ANALYSIS_QUEUE: analysisQueue });
  cookieJar.clear();
  rpcCalls = [];
  handlers = {
    getStudy: () => ({ status: 'found', study: canonicalStudy() }),
  };
  await signIn();
});

afterEach(() => {
  delete runtimeGlobals[WORKER_RUNTIME_MARKER];
  delete runtimeGlobals[WORKER_INVOCATION_ACCESSOR];
  for (const name of MANAGED_ENV) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  // RT-01: the Cloudflare path never constructs or touches Redis.
  expect(redisConstructor).not.toHaveBeenCalled();
  expect(kvClient.getKVClient).not.toHaveBeenCalled();
  expect(kvClient.getPlatformClient).not.toHaveBeenCalled();
  expect(kvClient.getResearcherClient).not.toHaveBeenCalled();
});

describe('POST /api/interviews/[id]/analyze on Cloudflare — admission order (API-01, F10, F18)', () => {
  it('F10: a not-ready deployment refuses before authentication or any workspace call', async () => {
    installInvocation({ WORKSPACE_STORE: workspaceNamespace });
    cookieJar.clear();

    const response = await post();

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ code: 'DEPLOYMENT_NOT_READY', retryable: false });
    expect(rpcCalls).toEqual([]);
  });

  it('F18/API-01: authentication runs before the version check, so an anonymous old client sees 401', async () => {
    cookieJar.clear();

    const response = await post({ headers: { 'X-OpenInterviewer-Analysis-Version': undefined } });

    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(rpcCalls).toEqual([]);
  });

  it('API-01: a participant cookie or participant token never authorizes analysis (POST and GET)', async () => {
    const participantToken = await createParticipantSessionToken({
      id: 'a'.repeat(64),
      studyId: STUDY_ID,
      studyRevision: 3,
      researcherId: null,
      expiresAt: null,
    });
    cookieJar.clear();
    cookieJar.set('participant-session', participantToken);
    expect((await post()).status).toBe(401);
    expect((await get()).status).toBe(401);

    // Presented where the researcher session belongs: wrong audience and type.
    cookieJar.set(SESSION_COOKIE_NAME, participantToken);
    expect((await post()).status).toBe(401);
    expect((await get()).status).toBe(401);
    expect(rpcCalls).toEqual([]);
  });

  it.each([
    ['missing', undefined],
    ['unsupported', '1'],
  ])('API-01: a %s version header is 409 ANALYSIS_CLIENT_UPDATE_REQUIRED before any workspace call', async (_label, version) => {
    const response = await post({ headers: { 'X-OpenInterviewer-Analysis-Version': version } });

    expect(response.status).toBe(409);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      code: 'ANALYSIS_CLIENT_UPDATE_REQUIRED',
      error: 'Reload this page to analyze interviews.',
    });
    expect(rpcCalls).toEqual([]);
  });

  it.each<[string, { headers?: Record<string, string | undefined>; body?: string }, number]>([
    ['a missing Idempotency-Key', { headers: { 'Idempotency-Key': undefined } }, 400],
    ['a non-UUID Idempotency-Key', { headers: { 'Idempotency-Key': 'retry-1' } }, 400],
    ['a non-JSON content type', { headers: { 'Content-Type': 'text/plain' } }, 400],
    ['an unparseable body', { body: '{"expectedGeneration":' }, 400],
    ['an unknown body field', { body: JSON.stringify({ expectedGeneration: 1, aiModel: 'other-model' }) }, 400],
    ['a workspace selector in the body', { body: JSON.stringify({ expectedGeneration: 1, workspaceId: 'ws_x' }) }, 400],
    ['a missing generation', { body: JSON.stringify({}) }, 400],
    ['a negative generation', { body: JSON.stringify({ expectedGeneration: -1 }) }, 400],
    ['a fractional generation', { body: JSON.stringify({ expectedGeneration: 1.5 }) }, 400],
    ['a string generation', { body: JSON.stringify({ expectedGeneration: '1' }) }, 400],
    ['an unsafe generation', { body: '{"expectedGeneration":9007199254740993}' }, 400],
    ['an array body', { body: JSON.stringify([1]) }, 400],
    ['an oversized body', { body: JSON.stringify({ expectedGeneration: 1, pad: 'x'.repeat(512) }) }, 413],
  ])('API-01: %s is refused before any workspace call', async (_label, request, status) => {
    const response = await post(request);

    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(rpcCalls).toEqual([]);
  });

  it('API-01: malformed study or interview identifiers are 400 without a workspace call', async () => {
    expect((await post({ studyId: 'not a study!' })).status).toBe(400);
    expect((await post({ interviewId: 'bad id!' })).status).toBe(400);
    expect(rpcCalls).toEqual([]);
  });
});

describe('POST /api/interviews/[id]/analyze on Cloudflare — acceptance (API-01, JOB-02, JOB-04)', () => {
  it('API-01/JOB-02: accepts with 202 and freezes the canonical study config, revision, provider and explicit model', async () => {
    handlers.acceptAnalysisRetry = () => ({
      status: 'accepted',
      // Fields outside the closed projection must never reach the response.
      body: { status: 'pending', generation: 2, phase: 'queued', pollAfterMs: 2000, jobId: 'job-secret', claimNonce: 'nonce' },
    });

    const response = await post();

    expect(response.status).toBe(202);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'pending', generation: 2, phase: 'queued', pollAfterMs: 2000 });
    expect(methods()).toEqual(['getStudy', 'acceptAnalysisRetry']);

    const study = canonicalStudy();
    const [input] = acceptInputs();
    expect(input).toMatchObject({
      studyId: STUDY_ID,
      interviewId: INTERVIEW_ID,
      expectedGeneration: 1,
      input: {
        inputSchemaVersion: 1,
        studyConfig: study.config,
        studyRevision: 3,
        requestedProvider: 'openai',
        requestedModel: DEFAULT_MODEL_BY_PROVIDER.openai,
      },
    });
    // JOB-04: only a digest scoped to workspace, study and interview reaches storage.
    expect(input.requestKeyDigest).toBe(await analysisRequestKeyDigest({
      workspaceId: WORKSPACE_ID,
      studyId: STUDY_ID,
      interviewId: INTERVIEW_ID,
      rawIdempotencyKey: KEY,
    }));
    expect(input.requestFingerprint).toBe(await analysisRequestFingerprint(1));
    expect(JSON.stringify(rpcCalls)).not.toContain(KEY);
  });

  it('JOB-04: replaying the same key and body reuses its receipt; the same key with another generation conflicts', async () => {
    // A minimal receipt model of the object (the real one is in cloudflare/workspace/analysis.ts).
    const receipts = new Map<string, { fingerprint: string; generation: number }>();
    let allocations = 0;
    handlers.acceptAnalysisRetry = (input: AcceptAnalysisRetryInput) => {
      const receipt = receipts.get(input.requestKeyDigest);
      if (receipt) {
        return receipt.fingerprint === input.requestFingerprint
          ? { status: 'accepted', body: { status: 'pending', generation: receipt.generation, phase: 'running', pollAfterMs: 2000 } }
          : { status: 'key-conflict' };
      }
      allocations += 1;
      const generation = input.expectedGeneration + 1;
      receipts.set(input.requestKeyDigest, { fingerprint: input.requestFingerprint, generation });
      return { status: 'accepted', body: { status: 'pending', generation, phase: 'queued', pollAfterMs: 2000 } };
    };

    const first = await post();
    const replay = await post();
    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual({ status: 'pending', generation: 2, phase: 'running', pollAfterMs: 2000 });
    expect(allocations).toBe(1);
    const [a, b] = acceptInputs();
    expect(b.requestKeyDigest).toBe(a.requestKeyDigest);
    expect(b.requestFingerprint).toBe(a.requestFingerprint);

    const conflict = await post({ body: JSON.stringify({ expectedGeneration: 0 }) });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'ANALYSIS_REQUEST_KEY_CONFLICT' });
    expect(allocations).toBe(1);

    // Another key is another intentional action with its own digest.
    await post({ headers: { 'Idempotency-Key': OTHER_KEY } });
    expect(acceptInputs()[3].requestKeyDigest).not.toBe(a.requestKeyDigest);
  });

  it.each<[string, unknown, number, Record<string, unknown>]>([
    ['existing active work', { status: 'existing', body: { status: 'pending', generation: 4, phase: 'running' } }, 202,
      { status: 'pending', generation: 4, phase: 'running', pollAfterMs: 2000 }],
    ['a completed interview', { status: 'already-complete', body: { status: 'already-complete', generation: 1 } }, 200,
      { status: 'already-complete', generation: 1 }],
    ['a replay whose generation finished', { status: 'accepted', body: { status: 'failed', generation: 2, failureKind: 'timeout', recoveryRequired: true } }, 200,
      { status: 'failed', generation: 2, failureKind: 'timeout', recoveryRequired: true }],
    ['a mismatched terminal generation', { status: 'state-changed' }, 409, { code: 'ANALYSIS_STATE_CHANGED' }],
    ['a foreign or missing interview', { status: 'not-found' }, 404, { error: 'Interview not found' }],
    ['a maintenance hold', { status: 'held', reason: 'maintenance' }, 503, { retryable: true, reason: 'maintenance' }],
    ['a recovery-epoch hold', { status: 'held', reason: 'recovery-epoch-mismatch' }, 503,
      { retryable: true, reason: 'workspace-unavailable' }],
    ['an uninitialized workspace', { status: 'held', reason: 'workspace-uninitialized' }, 503,
      { retryable: true, reason: 'workspace-unavailable' }],
    ['a corrupt record', { status: 'corrupt' }, 503, { retryable: true }],
    ['an unknown allocation commit', { status: 'unavailable' }, 503, { retryable: true }],
    ['a reply outside the contract', { status: 'accepted', body: { status: 'pending', generation: 0, phase: 'not-scheduled' } }, 503,
      { retryable: true }],
  ])('API-01: maps %s', async (_label, outcome, status, body) => {
    handlers.acceptAnalysisRetry = () => outcome;

    const response = await post();

    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const json = await response.json();
    expect(json).toMatchObject(body);
    if (status === 202 || status === 200) expect(json).toEqual(body);
    expect(JSON.stringify(json)).not.toMatch(/epoch|uninitialized|corrupt/);
  });

  it('API-01: a thrown allocation RPC is 503 retryable, never success or failure', async () => {
    handlers.acceptAnalysisRetry = () => {
      throw new Error('connection reset after commit');
    };

    const response = await post();

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({ retryable: true });
    expect(JSON.stringify(body)).not.toContain('connection reset');
  });

  it('JOB-02: a missing study is 404 and a study without a valid explicit model is 503, both without allocation', async () => {
    handlers.acceptAnalysisRetry = () => ({ status: 'accepted', body: { status: 'pending', generation: 1, phase: 'queued' } });

    handlers.getStudy = () => ({ status: 'not-found' });
    expect((await post()).status).toBe(404);

    const unreviewed = canonicalStudy();
    delete (unreviewed.config as { aiModel?: string }).aiModel;
    handlers.getStudy = () => ({ status: 'found', study: unreviewed });
    const malformed = await post();
    expect(malformed.status).toBe(503);
    expect(malformed.headers.get('cache-control')).toBe('no-store');

    handlers.getStudy = () => ({ status: 'unavailable' });
    expect((await post()).status).toBe(503);

    expect(methods()).not.toContain('acceptAnalysisRetry');
  });
});

describe('GET /api/interviews/[id]/analyze on Cloudflare (API-02)', () => {
  it.each<[string, unknown, Record<string, unknown>]>([
    ['queued work', { status: 'pending', generation: 1, phase: 'queued', pollAfterMs: 2000, jobId: 'job-secret' },
      { status: 'pending', generation: 1, phase: 'queued', pollAfterMs: 2000 }],
    ['running work', { status: 'pending', generation: 2, phase: 'running', claimToken: 'x', recoveryEpoch: 'ep_x' },
      { status: 'pending', generation: 2, phase: 'running', pollAfterMs: 2000 }],
    ['an eligible legacy interview', { status: 'pending', generation: 0, phase: 'not-scheduled' },
      { status: 'pending', generation: 0, phase: 'not-scheduled' }],
    ['an attached result', { status: 'complete', generation: 3, synthesis: { bottomLine: 'secret' } },
      { status: 'complete', generation: 3 }],
    ['a recorded failure', { status: 'failed', generation: 2, failureKind: 'provider', recoveryRequired: false, error: 'sdk text' },
      { status: 'failed', generation: 2, failureKind: 'provider', recoveryRequired: false }],
  ])('API-02: returns the closed projection for %s, read-only and uncached', async (_label, body, expected) => {
    handlers.readAnalysisStatus = () => ({ status: 'ok', body });

    const response = await get();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(expected);
    expect(methods()).toEqual(['readAnalysisStatus']);
    expect(rpcCalls[0].input).toEqual({ studyId: STUDY_ID, interviewId: INTERVIEW_ID });
  });

  it.each<[string, unknown, number]>([
    ['a foreign or missing interview', { status: 'not-found' }, 404],
    ['a corrupt record', { status: 'corrupt' }, 503],
    ['unavailable storage', { status: 'unavailable' }, 503],
    ['a malformed projection', { status: 'ok', body: { status: 'already-complete', generation: 1 } }, 503],
  ])('API-02: maps %s without any mutation', async (_label, outcome, status) => {
    handlers.readAnalysisStatus = () => outcome;

    const response = await get();

    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(methods()).toEqual(['readAnalysisStatus']);
  });

  it('API-02: a status read needs no version header, key or body, and an anonymous read is 401', async () => {
    handlers.readAnalysisStatus = () => ({ status: 'ok', body: { status: 'complete', generation: 1 } });
    expect((await get()).status).toBe(200);

    cookieJar.clear();
    const anonymous = await get();
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('cache-control')).toBe('no-store');
    expect(methods()).toEqual(['readAnalysisStatus']);
  });

  it('API-02: OPTIONS advertises the status GET on the Cloudflare target without a workspace call', () => {
    const response = OPTIONS();

    expect(response.status).toBe(204);
    expect(response.headers.get('allow')).toBe('GET, HEAD, OPTIONS, POST');
    expect(methods()).toEqual([]);
  });
});
