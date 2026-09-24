// @vitest-environment node
//
// /api/operator/* at the route boundary on the Cloudflare target (OPS-01,
// OPS-02, OPS-03 local parts, JOB-10, gap F5/F10). Real configuration,
// readiness gate, operator authority and session verification; only the
// WorkspaceStore object behind the WORKSPACE_STORE binding is a scripted fake
// that records every RPC. The object's own semantics are exercised against
// real SQLite in tests/workers/{operator,backup}.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const redisConstructor = vi.hoisted(() => vi.fn());
vi.mock('@upstash/redis', () => ({ Redis: redisConstructor }));

const cookieJar = vi.hoisted(() => new Map<string, string>());
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined),
  })),
}));

import { GET as statusGET } from '@/app/api/operator/status/route';
import { POST as maintenancePOST } from '@/app/api/operator/maintenance/route';
import { GET as backupGET } from '@/app/api/operator/backup/route';
import { POST as importPOST } from '@/app/api/operator/backup/import/route';
import { POST as activatePOST } from '@/app/api/operator/recovery/activate/route';
import { POST as restorePOST } from '@/app/api/operator/recovery/restore/route';
import { createSessionToken, SESSION_COOKIE_NAME } from '@/lib/auth';
import {
  WORKER_INVOCATION_ACCESSOR,
  WORKER_RUNTIME_MARKER,
  type WorkerInvocation,
} from '@/lib/runtime/workerInvocation';

const ORIGIN = 'https://openinterviewer.example.workers.dev';
const WORKSPACE_ID = 'ws_0123456789abcdef0123456789abcdef';
const TOKEN = 'synthetic-operator-token-0123456789abcdefg';
const EPOCH = 'ep_fedcba9876543210fedcba9876543210';
const OLD_EPOCH = `ep_${'0'.repeat(31)}e`;
const CONTENT_MARKER = 'synthetic-participant-speech-51aa';
const CLOUDFLARE_ENV: Record<string, string> = {
  DEPLOYMENT_TARGET: 'cloudflare',
  DEPLOYMENT_MODE: 'standalone',
  AI_TRANSPORT: 'direct',
  AI_PROVIDER: 'openai',
  APP_BASE_URL: ORIGIN,
  ADMIN_PASSWORD: 'synthetic-admin-password-1',
  SESSION_SECRET: 'synthetic-session-secret-0123456789abcdefgh',
  PARTICIPANT_TOKEN_SECRET: 'synthetic-participant-secret-0123456789abcd',
  RATE_LIMIT_SALT: 'synthetic-rate-limit-salt-0123456789abcdef',
  OPERATOR_TOKEN: TOKEN,
  OPENAI_API_KEY: 'synthetic-openai-provider-key',
  WORKSPACE_ID,
  WORKSPACE_JURISDICTION: '',
  ANALYSIS_RECOVERY_EPOCH: EPOCH,
};
const MANAGED_ENV = [...Object.keys(CLOUDFLARE_ENV), 'NODE_ENV'];

type RpcCall = { method: string; input: unknown };
type Handler = (input: never) => unknown;

const runtimeGlobals = globalThis as unknown as Record<symbol, unknown>;
let savedEnv: Record<string, string | undefined> = {};
let rpcCalls: RpcCall[] = [];
let handlers: Record<string, Handler> = {};
let jurisdictions: string[] = [];
let logLines: string[] = [];

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

function namespace(): Record<string, unknown> {
  const selected = {
    idFromName: () => ({}),
    getByName(name: string) {
      if (name !== WORKSPACE_ID) throw new Error('unexpected workspace object');
      return workspaceStub;
    },
  };
  return {
    ...selected,
    jurisdiction(value: string) {
      jurisdictions.push(value);
      return selected;
    },
  };
}
const analysisQueue = { send: async () => undefined, sendBatch: async () => undefined };

function installInvocation(env: Record<string, unknown> = {}): void {
  const invocation: WorkerInvocation = {
    env: { ...CLOUDFLARE_ENV, WORKSPACE_STORE: namespace(), ANALYSIS_QUEUE: analysisQueue, ...env },
    identity: { kind: 'address', address: '203.0.113.7' },
    source: 'fetch',
  };
  runtimeGlobals[WORKER_INVOCATION_ACCESSOR] = () => invocation;
}

function operatorHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, ...extra };
}

function get(path: string, headers = operatorHeaders()): Request {
  return new Request(`${ORIGIN}${path}`, { headers });
}

function post(path: string, body: unknown, headers = operatorHeaders({ 'content-type': 'application/json' })): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function read(response: Response) {
  expect(response.headers.get('cache-control')).toBe('no-store');
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function operatorEvents(): Array<Record<string, unknown>> {
  return logLines
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return {};
      }
    })
    .filter((event) => event.event === 'operator.action');
}

beforeEach(async () => {
  savedEnv = Object.fromEntries(MANAGED_ENV.map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(CLOUDFLARE_ENV)) process.env[name] = value;
  Reflect.deleteProperty(process.env, 'NODE_ENV');
  runtimeGlobals[WORKER_RUNTIME_MARKER] = true;
  installInvocation();
  rpcCalls = [];
  handlers = {};
  jurisdictions = [];
  logLines = [];
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
    logLines.push(String(line));
  });
  cookieJar.clear();
  cookieJar.set(SESSION_COOKIE_NAME, await createSessionToken());
});

afterEach(() => {
  delete runtimeGlobals[WORKER_RUNTIME_MARKER];
  delete runtimeGlobals[WORKER_INVOCATION_ACCESSOR];
  for (const name of MANAGED_ENV) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  expect(redisConstructor).not.toHaveBeenCalled();
  const logged = logLines.join('\n');
  expect(logged).not.toContain(TOKEN);
  expect(logged).not.toContain(CONTENT_MARKER);
});

const OK_STATUS = {
  status: 'ok',
  workspaceId: WORKSPACE_ID,
  schemaVersion: 1,
  maintenance: { state: 'frozen', version: 7 },
  epoch: { activated: EPOCH, configuredMatches: true },
  counts: { studies: 2, interviews: 5, operator_audit: 9 },
  jobs: { pending: 1, claimed: 0, started: 0, recoveryRequired: 2, oldestActiveAgeMs: 1200 },
  alarm: { scheduledAt: null },
};

describe('F5 every operator route requires operator authority before any RPC', () => {
  const calls: Array<[string, () => Promise<Response>]> = [
    ['status', () => statusGET(get('/api/operator/status', {}))],
    ['maintenance', () => maintenancePOST(post('/api/operator/maintenance', {}, { 'content-type': 'application/json' }))],
    ['backup', () => backupGET(get('/api/operator/backup?family=studies', {}))],
    ['backup/import', () => importPOST(post('/api/operator/backup/import', {}, { 'content-type': 'application/json' }))],
    ['recovery/activate', () => activatePOST(post('/api/operator/recovery/activate', {}, { 'content-type': 'application/json' }))],
    ['recovery/restore', () => restorePOST(post('/api/operator/recovery/restore', {}, { 'content-type': 'application/json' }))],
  ];

  it.each(calls)('%s without the bearer token is 401 and makes no RPC', async (_name, call) => {
    const { status, body } = await read(await call());
    expect(status).toBe(401);
    expect(body.code).toBe('OPERATOR_UNAUTHORIZED');
    expect(rpcCalls).toEqual([]);
  });

  it('a stale researcher session is refused on every route (403) with no RPC', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() - 16 * 60 * 1000);
    cookieJar.set(SESSION_COOKIE_NAME, await createSessionToken());
    vi.useRealTimers();
    const { status, body } = await read(await statusGET(get('/api/operator/status')));
    expect(status).toBe(403);
    expect(body.code).toBe('RECENT_SIGN_IN_REQUIRED');
    expect(rpcCalls).toEqual([]);
  });

  it('the Node target has no operator routes (404)', async () => {
    process.env.DEPLOYMENT_TARGET = 'node';
    delete runtimeGlobals[WORKER_RUNTIME_MARKER];
    delete runtimeGlobals[WORKER_INVOCATION_ACCESSOR];
    const { status } = await read(await statusGET(get('/api/operator/status')));
    expect(status).toBe(404);
  });
});

describe('OPS-01 GET /api/operator/status', () => {
  it('returns a closed projection of the object status', async () => {
    handlers.operatorStatus = () => ({ ...OK_STATUS, extra: CONTENT_MARKER });
    const { status, body } = await read(await statusGET(get('/api/operator/status')));
    expect(status).toBe(200);
    expect(body).toEqual(OK_STATUS);
    expect(rpcCalls.map((call) => call.method)).toEqual(['operatorStatus']);
    expect(operatorEvents()).toEqual([expect.objectContaining({ operation: 'status', status: 200 })]);
  });

  it('selects the object under the configured jurisdiction', async () => {
    installInvocation({ WORKSPACE_JURISDICTION: 'eu' });
    process.env.WORKSPACE_JURISDICTION = 'eu';
    handlers.operatorStatus = () => OK_STATUS;
    expect((await statusGET(get('/api/operator/status'))).status).toBe(200);
    expect(jurisdictions).toEqual(['eu']);
  });

  it.each([
    ['recovery-epoch-mismatch', 'workspace-unavailable'],
    ['workspace-uninitialized', 'workspace-unavailable'],
    ['workspace-unconfigured', 'workspace-unavailable'],
    ['workspace-identity-mismatch', 'workspace-unavailable'],
    ['maintenance', 'maintenance'],
  ])('maps a %s hold to 503 with an allowlisted reason', async (holdReason, reason) => {
    handlers.operatorStatus = () => ({ status: 'held', reason: holdReason });
    const { status, body } = await read(await statusGET(get('/api/operator/status')));
    expect(status).toBe(503);
    expect(body).toMatchObject({ code: 'WORKSPACE_HELD', retryable: false, reason, holdReason });
  });

  it('maps a thrown RPC or a malformed reply to a retryable 503', async () => {
    handlers.operatorStatus = () => {
      throw new Error(`rpc failed ${CONTENT_MARKER}`);
    };
    const thrown = await read(await statusGET(get('/api/operator/status')));
    expect(thrown.status).toBe(503);
    expect(thrown.body).toMatchObject({ code: 'WORKSPACE_UNAVAILABLE', retryable: true });
    expect(JSON.stringify(thrown.body)).not.toContain(CONTENT_MARKER);

    handlers.operatorStatus = () => ({ ...OK_STATUS, counts: { studies: 'many' } });
    expect((await statusGET(get('/api/operator/status'))).status).toBe(503);
  });

  it('refuses without an RPC when the workspace binding is missing', async () => {
    installInvocation({ WORKSPACE_STORE: undefined });
    const { status, body } = await read(await statusGET(get('/api/operator/status')));
    expect(status).toBe(503);
    expect(body).toMatchObject({ code: 'WORKSPACE_NOT_CONFIGURED', retryable: false });
    expect(rpcCalls).toEqual([]);
  });

  it('F10 stays available while the deployment is not ready (diagnosis path)', async () => {
    delete process.env.OPENAI_API_KEY;
    handlers.operatorStatus = () => OK_STATUS;
    expect((await statusGET(get('/api/operator/status'))).status).toBe(200);
  });
});

describe('OPS-01 POST /api/operator/maintenance', () => {
  const transition = { expectedState: 'open', expectedVersion: 3, nextState: 'draining' };

  it('sends a compare-and-set transition with the object-side inputs only', async () => {
    handlers.transitionMaintenance = () => ({ status: 'transitioned', state: 'draining', version: 4 });
    const { status, body } = await read(await maintenancePOST(post('/api/operator/maintenance', transition)));
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'transitioned', state: 'draining', version: 4 });
    const [call] = rpcCalls;
    expect(call.method).toBe('transitionMaintenance');
    expect(call.input).toEqual({ ...transition, classifyInFlight: false, now: expect.any(Number) });
  });

  it('passes classifyInFlight and reports a lost-reply replay as already', async () => {
    handlers.transitionMaintenance = () => ({ status: 'already', state: 'frozen', version: 5 });
    const { status, body } = await read(await maintenancePOST(post('/api/operator/maintenance', {
      expectedState: 'draining', expectedVersion: 4, nextState: 'frozen', classifyInFlight: true,
    })));
    expect(status).toBe(200);
    expect(body.status).toBe('already');
    expect((rpcCalls[0].input as { classifyInFlight: boolean }).classifyInFlight).toBe(true);
  });

  it.each([
    [{ status: 'conflict', state: 'frozen', version: 9 }, { code: 'MAINTENANCE_CONFLICT', state: 'frozen', version: 9 }],
    [{ status: 'in-flight', claimed: 1, started: 2 }, { code: 'ANALYSIS_IN_FLIGHT', claimed: 1, started: 2 }],
    [{ status: 'invalid-transition' }, { code: 'INVALID_TRANSITION' }],
  ])('maps %j to 409', async (reply, expected) => {
    handlers.transitionMaintenance = () => reply;
    const { status, body } = await read(await maintenancePOST(post('/api/operator/maintenance', transition)));
    expect(status).toBe(409);
    expect(body).toMatchObject(expected);
  });

  it('maps a hold to 503 and a thrown RPC to an unknown outcome (read status first)', async () => {
    handlers.transitionMaintenance = () => ({ status: 'held', reason: 'recovery-epoch-mismatch' });
    const held = await read(await maintenancePOST(post('/api/operator/maintenance', transition)));
    expect(held.status).toBe(503);
    expect(held.body.holdReason).toBe('recovery-epoch-mismatch');

    handlers.transitionMaintenance = () => {
      throw new Error('reply lost');
    };
    const lost = await read(await maintenancePOST(post('/api/operator/maintenance', transition)));
    expect(lost.status).toBe(503);
    expect(lost.body).toMatchObject({ code: 'OUTCOME_UNKNOWN', retryable: true });
  });

  it('requires a JSON content type, a bounded body and exactly the allowed fields', async () => {
    const plain = await maintenancePOST(post('/api/operator/maintenance', transition, operatorHeaders({ 'content-type': 'text/plain' })));
    expect(plain.status).toBe(415);
    const large = await maintenancePOST(post('/api/operator/maintenance', { ...transition, pad: 'x'.repeat(2048) }));
    expect(large.status).toBe(413);
    const extra = await maintenancePOST(post('/api/operator/maintenance', { ...transition, workspaceId: WORKSPACE_ID }));
    expect(extra.status).toBe(400);
    const badState = await maintenancePOST(post('/api/operator/maintenance', { ...transition, nextState: 'paused' }));
    expect(badState.status).toBe(400);
    const badVersion = await maintenancePOST(post('/api/operator/maintenance', { ...transition, expectedVersion: -1 }));
    expect(badVersion.status).toBe(400);
    expect(rpcCalls).toEqual([]);
  });

  it('F10 reopening a not-ready deployment is refused before any RPC; tightening the hold is not', async () => {
    delete process.env.OPENAI_API_KEY;
    const reopen = await maintenancePOST(post('/api/operator/maintenance', {
      expectedState: 'frozen', expectedVersion: 5, nextState: 'open',
    }));
    expect(reopen.status).toBe(503);
    expect((await reopen.json()).code).toBe('DEPLOYMENT_NOT_READY');
    const resumeDrain = await maintenancePOST(post('/api/operator/maintenance', {
      expectedState: 'recovery', expectedVersion: 5, nextState: 'draining',
    }));
    expect(resumeDrain.status).toBe(503);
    expect(rpcCalls).toEqual([]);

    handlers.transitionMaintenance = () => ({ status: 'transitioned', state: 'frozen', version: 6 });
    const freeze = await maintenancePOST(post('/api/operator/maintenance', {
      expectedState: 'draining', expectedVersion: 5, nextState: 'frozen',
    }));
    expect(freeze.status).toBe(200);
  });
});

describe('OPS-02 GET /api/operator/backup', () => {
  const page = {
    status: 'ok',
    watermark: { maintenanceVersion: 4, mutationSeq: 17 },
    family: 'interviews',
    rows: [{ id: 'iv-1', record_json: `{"content":"${CONTENT_MARKER}"}` }],
    nextCursor: '["iv-1"]',
    families: ['workspace_meta', 'studies', 'interviews'],
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
  };

  it('returns one page; the first request carries no watermark and later ones pin it', async () => {
    handlers.exportBackupPage = () => page;
    const first = await read(await backupGET(get('/api/operator/backup?family=interviews')));
    expect(first.status).toBe(200);
    expect(first.body).toEqual(page);
    expect(rpcCalls[0].input).toEqual({ watermark: null, family: 'interviews', cursor: null, pageSize: 500 });

    await backupGET(get(`/api/operator/backup?family=interviews&cursor=${encodeURIComponent('["iv-1"]')}&watermark=4:17`));
    expect(rpcCalls[1].input).toEqual({
      watermark: { maintenanceVersion: 4, mutationSeq: 17 },
      family: 'interviews',
      cursor: '["iv-1"]',
      pageSize: 500,
    });
  });

  it.each([
    ['a missing family', '/api/operator/backup'],
    ['an unknown family', '/api/operator/backup?family=login_attempts'],
    ['a repeated family', '/api/operator/backup?family=studies&family=interviews'],
    ['an unexpected parameter', '/api/operator/backup?family=studies&pageSize=10000'],
    ['a malformed watermark', '/api/operator/backup?family=studies&watermark=4'],
    ['an empty cursor', '/api/operator/backup?family=studies&cursor='],
    ['a later page (cursor) without the watermark', `/api/operator/backup?family=studies&cursor=${encodeURIComponent('["s1"]')}`],
  ])('refuses %s with 400 and no RPC', async (_label, path) => {
    const { status } = await read(await backupGET(get(path)));
    expect(status).toBe(400);
    expect(rpcCalls).toEqual([]);
  });

  it.each([
    [{ status: 'not-frozen' }, 409, 'NOT_FROZEN'],
    [{ status: 'watermark-changed' }, 409, 'WATERMARK_CHANGED'],
    [{ status: 'held', reason: 'workspace-identity-mismatch' }, 503, 'WORKSPACE_HELD'],
    [{ status: 'unavailable' }, 503, 'WORKSPACE_UNAVAILABLE'],
    [{ ...page, family: 'studies' }, 503, 'WORKSPACE_UNAVAILABLE'],
  ])('maps %j to %i', async (reply, expectedStatus, code) => {
    handlers.exportBackupPage = () => reply;
    const { status, body } = await read(await backupGET(get('/api/operator/backup?family=interviews')));
    expect(status).toBe(expectedStatus);
    expect(body.code).toBe(code);
  });
});

describe('OPS-02 POST /api/operator/backup/import', () => {
  const manifest = { formatVersion: 1, families: [], counts: {} };
  const chunk = { family: 'studies', index: 0, sha256: 'a'.repeat(64), rows: [{ id: 's-1' }] };

  it('forwards one chunk under its manifest', async () => {
    handlers.importBackupChunk = () => ({ status: 'accepted', family: 'studies', index: 0, duplicate: true });
    const { status, body } = await read(await importPOST(post('/api/operator/backup/import', { manifest, chunk })));
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'accepted', family: 'studies', index: 0, duplicate: true });
    expect(rpcCalls[0].input).toEqual({ manifest, chunk, finalize: false, now: expect.any(Number) });
  });

  it('finalizes and returns counts', async () => {
    handlers.importBackupChunk = () => ({ status: 'finalized', counts: { studies: 1 } });
    const { status, body } = await read(await importPOST(post('/api/operator/backup/import', { manifest, chunk: null, finalize: true })));
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'finalized', counts: { studies: 1 } });
    expect(rpcCalls[0].input).toMatchObject({ chunk: null, finalize: true });
  });

  it.each([
    [{ status: 'rejected', errorClass: 'checksum-mismatch', counts: { rows: 1 } }, 422, { code: 'IMPORT_REJECTED', errorClass: 'checksum-mismatch', counts: { rows: 1 } }],
    [{ status: 'rejected', errorClass: `Bad ${CONTENT_MARKER}` }, 422, { code: 'IMPORT_REJECTED', errorClass: 'rejected' }],
    [{ status: 'not-empty' }, 409, { code: 'WORKSPACE_NOT_EMPTY' }],
    [{ status: 'not-recovery' }, 409, { code: 'NOT_RECOVERY' }],
    [{ status: 'held', reason: 'schema-unsupported' }, 503, { code: 'WORKSPACE_HELD', holdReason: 'schema-unsupported' }],
    [{ status: 'unavailable' }, 503, { code: 'OUTCOME_UNKNOWN', retryable: true }],
  ])('maps %j to %i', async (reply, expectedStatus, expected) => {
    handlers.importBackupChunk = () => reply;
    const { status, body } = await read(await importPOST(post('/api/operator/backup/import', { manifest, chunk })));
    expect(status).toBe(expectedStatus);
    expect(body).toMatchObject(expected);
    expect(JSON.stringify(body)).not.toContain(CONTENT_MARKER);
  });

  it('maps a thrown RPC to an unknown outcome that is safe to resend', async () => {
    handlers.importBackupChunk = () => {
      throw new Error('reply lost');
    };
    const { status, body } = await read(await importPOST(post('/api/operator/backup/import', { manifest, chunk })));
    expect(status).toBe(503);
    expect(body).toMatchObject({ code: 'OUTCOME_UNKNOWN', retryable: true });
  });

  it.each([
    ['both a chunk and finalize', { manifest, chunk, finalize: true }],
    ['neither a chunk nor finalize', { manifest, chunk: null }],
    ['a chunk of an unknown family', { manifest, chunk: { ...chunk, family: 'login_attempts' } }],
    ['a chunk with a malformed checksum', { manifest, chunk: { ...chunk, sha256: 'xyz' } }],
    ['an empty chunk', { manifest, chunk: { ...chunk, rows: [] } }],
    ['a chunk with extra members', { manifest, chunk: { ...chunk, workspaceId: WORKSPACE_ID } }],
    ['a missing manifest', { chunk }],
    ['an unexpected field', { manifest, chunk, epoch: EPOCH }],
  ])('refuses %s with 400 and no RPC', async (_label, body) => {
    expect((await importPOST(post('/api/operator/backup/import', body))).status).toBe(400);
    expect(rpcCalls).toEqual([]);
  });

  it('bounds the request body at 24 MiB', async () => {
    const oversized = JSON.stringify({ manifest, chunk: { ...chunk, rows: [{ pad: 'x'.repeat(24 * 1024 * 1024) }] } });
    const response = await importPOST(post('/api/operator/backup/import', oversized));
    expect(response.status).toBe(413);
    expect(rpcCalls).toEqual([]);
  });
});

describe('JOB-10 / OPS-03 POST /api/operator/recovery/activate', () => {
  it('sends only the expected activated epoch; the new epoch comes from the Worker binding', async () => {
    handlers.activateRecoveryEpoch = () => ({ status: 'activated', reconciledJobs: 3 });
    const { status, body } = await read(await activatePOST(post('/api/operator/recovery/activate', { expectedActivatedEpoch: OLD_EPOCH })));
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'activated', reconciledJobs: 3 });
    expect(rpcCalls[0].input).toEqual({ expectedActivatedEpoch: OLD_EPOCH, now: expect.any(Number) });
  });

  it.each([
    [{ status: 'already-active' }, 200, { status: 'already-active' }],
    [{ status: 'conflict' }, 409, { code: 'EPOCH_CONFLICT' }],
    [{ status: 'not-recovery' }, 409, { code: 'NOT_RECOVERY' }],
    [{ status: 'held', reason: 'workspace-identity-mismatch' }, 503, { code: 'WORKSPACE_HELD' }],
    [{ status: 'unavailable' }, 503, { code: 'OUTCOME_UNKNOWN' }],
  ])('maps %j to %i', async (reply, expectedStatus, expected) => {
    handlers.activateRecoveryEpoch = () => reply;
    const { status, body } = await read(await activatePOST(post('/api/operator/recovery/activate', { expectedActivatedEpoch: OLD_EPOCH })));
    expect(status).toBe(expectedStatus);
    expect(body).toMatchObject(expected);
  });

  it.each([
    ['a malformed epoch', { expectedActivatedEpoch: 'ep_123' }],
    ['a chosen new epoch', { expectedActivatedEpoch: OLD_EPOCH, epoch: EPOCH }],
    ['no epoch', {}],
  ])('refuses %s with 400 and no RPC', async (_label, body) => {
    expect((await activatePOST(post('/api/operator/recovery/activate', body))).status).toBe(400);
    expect(rpcCalls).toEqual([]);
  });

  it('F10 activation is available while the deployment is not ready', async () => {
    delete process.env.OPENAI_API_KEY;
    handlers.activateRecoveryEpoch = () => ({ status: 'activated', reconciledJobs: 0 });
    expect((await activatePOST(post('/api/operator/recovery/activate', { expectedActivatedEpoch: OLD_EPOCH }))).status).toBe(200);
  });
});

describe('OPS-03 POST /api/operator/recovery/restore', () => {
  const BOOKMARK = '0000007b-0000b26e-00001538-0c3e87bb37b3db5cc52eedb93cd3b96b';
  const UNDO = '0000007c-0000b26f-00001539-1c3e87bb37b3db5cc52eedb93cd3b96c';
  const DAY_MS = 24 * 3_600_000;
  const byBookmark = { expectedState: 'frozen', expectedVersion: 5, bookmark: BOOKMARK };

  it('forwards a bookmark with the compare-and-set inputs and returns the undo bookmark', async () => {
    handlers.restoreToBookmark = () => ({ status: 'scheduled', bookmark: BOOKMARK, undoBookmark: UNDO });
    const { status, body } = await read(await restorePOST(post('/api/operator/recovery/restore', byBookmark)));
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'scheduled', bookmark: BOOKMARK, undoBookmark: UNDO });
    expect(rpcCalls).toEqual([{ method: 'restoreToBookmark', input: { ...byBookmark, at: null, now: expect.any(Number) } }]);
    expect(operatorEvents()).toEqual([expect.objectContaining({ route: '/api/operator/recovery/restore', operation: 'recovery.restore', status: 200 })]);
  });

  it('forwards a time in epoch milliseconds for the object to resolve', async () => {
    handlers.restoreToBookmark = () => ({ status: 'scheduled', bookmark: BOOKMARK, undoBookmark: UNDO });
    const at = Date.now() - 2 * DAY_MS;
    const { status } = await read(await restorePOST(post('/api/operator/recovery/restore', { expectedState: 'recovery', expectedVersion: 9, at })));
    expect(status).toBe(200);
    expect(rpcCalls[0].input).toEqual({ expectedState: 'recovery', expectedVersion: 9, bookmark: null, at, now: expect.any(Number) });
  });

  it.each([
    [{ status: 'conflict', state: 'recovery', version: 6 }, 409, { code: 'MAINTENANCE_CONFLICT', state: 'recovery', version: 6 }],
    [{ status: 'not-held', state: 'open', version: 5 }, 409, { code: 'NOT_HELD', state: 'open', version: 5 }],
    [{ status: 'epoch-not-rotated' }, 409, { code: 'EPOCH_NOT_ROTATED' }],
    [{ status: 'bookmark-refused' }, 422, { code: 'BOOKMARK_REFUSED', retryable: false }],
    [{ status: 'invalid-request' }, 400, { code: 'INVALID_REQUEST' }],
    [{ status: 'held', reason: 'workspace-identity-mismatch' }, 503, { code: 'WORKSPACE_HELD', holdReason: 'workspace-identity-mismatch' }],
    [{ status: 'unavailable' }, 503, { code: 'OUTCOME_UNKNOWN', retryable: true }],
    [{ status: 'scheduled', bookmark: BOOKMARK, undoBookmark: `${CONTENT_MARKER} <script>` }, 503, { code: 'OUTCOME_UNKNOWN' }],
    [{ status: 'conflict', state: 'paused', version: 6 }, 503, { code: 'OUTCOME_UNKNOWN' }],
  ])('maps %j to %i', async (reply, expectedStatus, expected) => {
    handlers.restoreToBookmark = () => reply;
    const { status, body } = await read(await restorePOST(post('/api/operator/recovery/restore', byBookmark)));
    expect(status).toBe(expectedStatus);
    expect(body).toMatchObject(expected);
    expect(JSON.stringify(body)).not.toContain(CONTENT_MARKER);
  });

  it('maps a thrown RPC (the object may have restarted before replying) to an unknown outcome', async () => {
    handlers.restoreToBookmark = () => {
      throw new Error('Durable Object reset');
    };
    const { status, body } = await read(await restorePOST(post('/api/operator/recovery/restore', byBookmark)));
    expect(status).toBe(503);
    expect(body).toMatchObject({ code: 'OUTCOME_UNKNOWN', retryable: true });
  });

  it.each([
    ['both a bookmark and a time', { ...byBookmark, at: Date.now() - DAY_MS }],
    ['neither a bookmark nor a time', { expectedState: 'frozen', expectedVersion: 5 }],
    ['a malformed bookmark', { ...byBookmark, bookmark: 'bookmark with spaces' }],
    ['an oversized bookmark', { ...byBookmark, bookmark: 'a'.repeat(257) }],
    ['a time in the future', { expectedState: 'frozen', expectedVersion: 5, at: Date.now() + 60_000 }],
    ['a time beyond the 30-day window', { expectedState: 'frozen', expectedVersion: 5, at: Date.now() - 31 * DAY_MS }],
    ['a time that is not epoch milliseconds', { expectedState: 'frozen', expectedVersion: 5, at: '2026-09-21T10:00:00Z' }],
    ['an unknown state', { ...byBookmark, expectedState: 'paused' }],
    ['a missing version', { expectedState: 'frozen', bookmark: BOOKMARK }],
    ['a chosen epoch', { ...byBookmark, epoch: EPOCH }],
  ])('refuses %s with 400 and no RPC', async (_label, body) => {
    const { status, body: reply } = await read(await restorePOST(post('/api/operator/recovery/restore', body)));
    expect(status).toBe(400);
    expect(reply.code).toBe('INVALID_REQUEST');
    expect(rpcCalls).toEqual([]);
  });

  it('requires a JSON content type and a bounded body', async () => {
    expect((await restorePOST(post('/api/operator/recovery/restore', byBookmark, operatorHeaders({ 'content-type': 'text/plain' })))).status).toBe(415);
    expect((await restorePOST(post('/api/operator/recovery/restore', { ...byBookmark, pad: 'x'.repeat(2048) }))).status).toBe(413);
    expect(rpcCalls).toEqual([]);
  });

  it('F10 a restore is available while the deployment is not ready (it never resumes work)', async () => {
    delete process.env.OPENAI_API_KEY;
    handlers.restoreToBookmark = () => ({ status: 'scheduled', bookmark: BOOKMARK, undoBookmark: UNDO });
    expect((await restorePOST(post('/api/operator/recovery/restore', byBookmark))).status).toBe(200);
  });
});
