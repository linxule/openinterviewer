// @vitest-environment node
//
// POST /api/auth sign-in hardening on the Cloudflare target (gap F5): a 1 KiB
// body bound enforced while the body streams in, and a durable failed-attempt
// budget that atomically admits (counts) each attempt before the password is
// compared and refunds it on success, so only failures stay counted. Real
// configuration, session signing and durable client (HMAC client keys); only
// the WorkspaceStore object behind WORKSPACE_STORE is a scripted fake
// recording every RPC. The budget itself runs against real SQLite, including
// a concurrent burst, in tests/workers/login.test.ts. The Node target's
// budget over Redis is tests/unit/api.auth.node.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const redisConstructor = vi.hoisted(() => vi.fn());
vi.mock('@upstash/redis', () => ({ Redis: redisConstructor }));

const cookieJar = vi.hoisted(() => new Map<string, { value: string; options?: unknown }>());
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)!.value } : undefined),
    set: (name: string, value: string, options?: unknown) => {
      cookieJar.set(name, { value, options });
    },
    delete: (name: string) => {
      cookieJar.delete(name);
    },
  })),
}));

import { POST } from '@/app/api/auth/route';
import { SESSION_COOKIE_NAME, verifySessionToken } from '@/lib/auth';
import {
  WORKER_INVOCATION_ACCESSOR,
  WORKER_RUNTIME_MARKER,
  type AdmissionIdentity,
  type WorkerInvocation,
} from '@/lib/runtime/workerInvocation';
import { loginClientKey } from '@/lib/storage/durableObject';

const WORKSPACE_ID = 'ws_0123456789abcdef0123456789abcdef';
const PASSWORD = 'synthetic-admin-password-1';
const SALT = 'synthetic-rate-limit-salt-0123456789abcdef';
const ADDRESS = '203.0.113.7';
const CLOUDFLARE_ENV: Record<string, string> = {
  DEPLOYMENT_TARGET: 'cloudflare',
  DEPLOYMENT_MODE: 'standalone',
  AI_TRANSPORT: 'direct',
  AI_PROVIDER: 'openai',
  APP_BASE_URL: 'https://openinterviewer.example.workers.dev',
  ADMIN_PASSWORD: PASSWORD,
  SESSION_SECRET: 'synthetic-session-secret-0123456789abcdefgh',
  PARTICIPANT_TOKEN_SECRET: 'synthetic-participant-secret-0123456789abcd',
  RATE_LIMIT_SALT: SALT,
  OPERATOR_TOKEN: 'synthetic-operator-token-0123456789abcdefg',
  OPENAI_API_KEY: 'synthetic-openai-provider-key',
  WORKSPACE_ID,
  WORKSPACE_JURISDICTION: '',
  ANALYSIS_RECOVERY_EPOCH: 'ep_fedcba9876543210fedcba9876543210',
};
const MANAGED_ENV = [...Object.keys(CLOUDFLARE_ENV), 'NODE_ENV'];

type RpcCall = { method: string; input: { clientKey: string; now: number } };
type Handler = (input: never) => unknown;

const runtimeGlobals = globalThis as unknown as Record<symbol, unknown>;
let savedEnv: Record<string, string | undefined> = {};
let rpcCalls: RpcCall[] = [];
let handlers: Record<string, Handler> = {};
let logLines: string[] = [];

const workspaceStub = new Proxy({}, {
  get(_target, property) {
    if (typeof property !== 'string' || property === 'then') return undefined;
    return async (input: { clientKey: string; now: number }) => {
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

function installInvocation(env: Record<string, unknown> = {}, identity: AdmissionIdentity | null = { kind: 'address', address: ADDRESS }): void {
  const invocation: WorkerInvocation = {
    env: { ...CLOUDFLARE_ENV, WORKSPACE_STORE: workspaceNamespace, ANALYSIS_QUEUE: { send: async () => undefined }, ...env },
    identity,
    source: 'fetch',
  };
  runtimeGlobals[WORKER_RUNTIME_MARKER] = true;
  runtimeGlobals[WORKER_INVOCATION_ACCESSOR] = () => invocation;
}

function login(body: unknown): Request {
  return new Request('https://openinterviewer.example.workers.dev/api/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function allow(): void {
  handlers.admitLoginAttempt = () => ({ status: 'admitted' });
  handlers.refundLoginAttempt = () => ({ status: 'refunded' });
}

/**
 * A minimal model of the object's contract (the real one is
 * cloudflare/workspace/login.ts): each RPC decides and counts in one step, as
 * the object's single-threaded transaction does, and replies a tick later so
 * concurrent requests interleave.
 */
function atomicBudget(maximum: number): { counts: Map<string, number> } {
  const counts = new Map<string, number>();
  handlers.admitLoginAttempt = async (input: { clientKey: string }) => {
    const current = counts.get(input.clientKey) ?? 0;
    const outcome = current >= maximum
      ? { status: 'limited', scope: 'client', retryAfterSeconds: 900 }
      : (counts.set(input.clientKey, current + 1), { status: 'admitted' });
    await new Promise((resolve) => setTimeout(resolve, 1));
    return outcome;
  };
  handlers.refundLoginAttempt = async (input: { clientKey: string }) => {
    counts.set(input.clientKey, Math.max(0, (counts.get(input.clientKey) ?? 0) - 1));
    await new Promise((resolve) => setTimeout(resolve, 1));
    return { status: 'refunded' };
  };
  return { counts };
}

beforeEach(() => {
  savedEnv = Object.fromEntries(MANAGED_ENV.map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(CLOUDFLARE_ENV)) process.env[name] = value;
  Reflect.deleteProperty(process.env, 'NODE_ENV');
  installInvocation();
  rpcCalls = [];
  handlers = {};
  cookieJar.clear();
  logLines = [];
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
    logLines.push(String(line));
  });
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
  expect(logged).not.toContain(PASSWORD);
  expect(logged).not.toContain(ADDRESS);
});

describe('F5 Cloudflare sign-in budget', () => {
  it('F5 admits (counts) the attempt before a correct password, then refunds it', async () => {
    allow();
    const response = await POST(login({ password: PASSWORD }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await verifySessionToken(cookieJar.get(SESSION_COOKIE_NAME)!.value)).valid).toBe(true);
    expect(rpcCalls.map((call) => call.method)).toEqual(['admitLoginAttempt', 'refundLoginAttempt']);
  });

  it('F5 a wrong password keeps its admitted attempt counted, keyed by an HMAC of the client identity', async () => {
    allow();
    const response = await POST(login({ password: 'not-the-password-000' }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Invalid password' });
    expect(cookieJar.has(SESSION_COOKIE_NAME)).toBe(false);
    expect(rpcCalls.map((call) => call.method)).toEqual(['admitLoginAttempt']);
    const expectedKey = await loginClientKey(SALT, { kind: 'address', address: ADDRESS });
    expect(expectedKey).toMatch(/^[0-9a-f]{64}$/);
    for (const call of rpcCalls) {
      expect(call.input).toEqual({ clientKey: expectedKey, now: expect.any(Number) });
      expect(JSON.stringify(call.input)).not.toContain(ADDRESS);
    }
  });

  it('F5 a concurrent burst from one client reaches the password comparison at most 10 times', async () => {
    const { counts } = atomicBudget(10);
    const responses = await Promise.all(
      Array.from({ length: 40 }, () => POST(login({ password: 'not-the-password-000' }))),
    );
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 401)).toHaveLength(10);
    expect(statuses.filter((status) => status === 429)).toHaveLength(30);
    expect(rpcCalls.every((call) => call.method === 'admitLoginAttempt')).toBe(true);
    expect([...counts.values()]).toEqual([10]);
    // Once the burst is spent even the correct password waits for the window.
    expect((await POST(login({ password: PASSWORD }))).status).toBe(429);
  });

  it('F5 a correct password inside a burst is refunded, so only the failures stay counted', async () => {
    const { counts } = atomicBudget(10);
    const responses = await Promise.all([
      ...Array.from({ length: 5 }, () => POST(login({ password: 'not-the-password-000' }))),
      POST(login({ password: PASSWORD })),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 401, 401, 401, 401, 401]);
    expect([...counts.values()]).toEqual([5]);
  });

  it('F5 a limited client gets 429 with Retry-After, even with the correct password, and nothing else is called', async () => {
    handlers.admitLoginAttempt = () => ({ status: 'limited', scope: 'client', retryAfterSeconds: 600 });
    const response = await POST(login({ password: PASSWORD }));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('600');
    expect(await response.json()).toMatchObject({ retryable: true });
    expect(cookieJar.has(SESSION_COOKIE_NAME)).toBe(false);
    expect(rpcCalls.map((call) => call.method)).toEqual(['admitLoginAttempt']);
  });

  it('F5 the global budget limits every client the same way', async () => {
    handlers.admitLoginAttempt = () => ({ status: 'limited', scope: 'global', retryAfterSeconds: 3_000 });
    const response = await POST(login({ password: PASSWORD }));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('3000');
  });

  it.each([
    ['the admission RPC throws', () => {
      handlers.admitLoginAttempt = () => {
        throw new Error('rpc failed');
      };
    }],
    ['the object is held', () => {
      handlers.admitLoginAttempt = () => ({ status: 'held', reason: 'schema-unsupported' });
    }],
    ['the reply is malformed', () => {
      handlers.admitLoginAttempt = () => ({ status: 'limited', scope: 'client', retryAfterSeconds: 0 });
    }],
    ['the reply is the retired read-only check', () => {
      handlers.admitLoginAttempt = () => ({ status: 'allowed' });
    }],
  ])('F5 fails closed with 503 when %s, even for the correct password', async (_label, arrange) => {
    arrange();
    const response = await POST(login({ password: PASSWORD }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ retryable: true });
    expect(cookieJar.has(SESSION_COOKIE_NAME)).toBe(false);
    expect(rpcCalls.map((call) => call.method)).toEqual(['admitLoginAttempt']);
  });

  it('F5 a lost refund leaves the attempt counted and still signs in; the event carries no content', async () => {
    handlers.admitLoginAttempt = () => ({ status: 'admitted' });
    handlers.refundLoginAttempt = () => {
      throw new Error('rpc failed');
    };
    const response = await POST(login({ password: PASSWORD }));
    expect(response.status).toBe(200);
    expect(cookieJar.has(SESSION_COOKIE_NAME)).toBe(true);
    expect(logLines.map((line) => JSON.parse(line))).toContainEqual(expect.objectContaining({
      event: 'workspace.store', route: '/api/auth', operation: 'login.refund', status: 200, reason: 'unavailable',
    }));
  });

  it('F5 fails closed with 503 and no RPC when the workspace binding is missing', async () => {
    installInvocation({ WORKSPACE_STORE: undefined });
    const response = await POST(login({ password: PASSWORD }));
    expect(response.status).toBe(503);
    expect(rpcCalls).toEqual([]);
  });

  it.each([
    ['a body over 1 KiB', JSON.stringify({ password: PASSWORD, pad: 'x'.repeat(1024) }), 413],
    ['malformed JSON', '{"password":', 400],
    ['a JSON array', '[]', 400],
    ['a missing password', '{}', 400],
    ['a non-string password', '{"password":12345}', 400],
  ])('F5 refuses %s before any budget RPC', async (_label, body, status) => {
    allow();
    const response = await POST(login(body));
    expect(response.status).toBe(status);
    expect(rpcCalls).toEqual([]);
  });

  it('F5 cancels an oversized body without Content-Length as soon as it exceeds 1 KiB', async () => {
    allow();
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= 8 * 1024 * 1024) {
          controller.close();
          return;
        }
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request('https://openinterviewer.example.workers.dev/api/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit);
    expect(request.headers.get('content-length')).toBeNull();
    const response = await POST(request);
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    // Only what the stream had queued ahead of the refusal was produced, never the 8 MiB.
    expect(pulled).toBeLessThanOrEqual(4 * chunk.byteLength);
    expect(rpcCalls).toEqual([]);
  });

  it('F5 accepts a streamed body at the bound in several chunks', async () => {
    allow();
    const text = JSON.stringify({ password: PASSWORD, pad: '' });
    const padded = JSON.stringify({ password: PASSWORD, pad: 'x'.repeat(1024 - text.length) });
    expect(new TextEncoder().encode(padded).byteLength).toBe(1024);
    const bytes = new TextEncoder().encode(padded);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 100) controller.enqueue(bytes.slice(offset, offset + 100));
        controller.close();
      },
    });
    const response = await POST(new Request('https://openinterviewer.example.workers.dev/api/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit));
    expect(response.status).toBe(200);
  });

  it('RT-05 compares against ADMIN_PASSWORD from the Worker invocation env', async () => {
    allow();
    process.env.ADMIN_PASSWORD = 'a-different-process-env-password';
    expect((await POST(login({ password: PASSWORD }))).status).toBe(200);
    expect((await POST(login({ password: 'a-different-process-env-password' }))).status).toBe(401);
  });

  it('F5 without a usable address every request shares one unknown scope; subrequests share another', async () => {
    allow();
    installInvocation({}, { kind: 'unknown', reason: 'missing' });
    await POST(login({ password: 'wrong-password-0000' }));
    installInvocation({}, { kind: 'unknown', reason: 'invalid' });
    await POST(login({ password: 'wrong-password-0000' }));
    installInvocation({}, { kind: 'subrequest' });
    await POST(login({ password: 'wrong-password-0000' }));
    installInvocation({}, { kind: 'address', address: '198.51.100.9' });
    await POST(login({ password: 'wrong-password-0000' }));
    const keys = rpcCalls.filter((call) => call.method === 'admitLoginAttempt').map((call) => call.input.clientKey);
    expect(keys[0]).toBe(keys[1]);
    expect(new Set(keys).size).toBe(3);
    expect(keys[0]).toBe(await loginClientKey(SALT, null));
  });

  it('F10 sign-in is not gated on deployment readiness (operators sign in to a held deployment)', async () => {
    allow();
    delete process.env.OPENAI_API_KEY;
    expect((await POST(login({ password: PASSWORD }))).status).toBe(200);
  });
});
