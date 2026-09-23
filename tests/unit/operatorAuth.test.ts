// @vitest-environment node
//
// Operator authority matrix (OPS-01, gap F5): Cloudflare target only, the
// OPERATOR_TOKEN secret from the Worker invocation env compared in constant
// time, and a real standalone researcher session issued within 15 minutes.
// Real session signing/verification; only cookies and the invocation are
// supplied by the test.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const cookieJar = vi.hoisted(() => new Map<string, string>());
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined),
  })),
}));

import { timingSafeEqual } from 'node:crypto';
import { createParticipantSessionToken, createSessionToken, SESSION_COOKIE_NAME } from '@/lib/auth';
import {
  OPERATOR_SESSION_MAX_AGE_SECONDS,
  operatorAuthorityRefusal,
  operatorTokensMatch,
  type OperatorRequestLabel,
} from '@/lib/operatorAuth';
import {
  WORKER_INVOCATION_ACCESSOR,
  WORKER_RUNTIME_MARKER,
  type WorkerInvocation,
} from '@/lib/runtime/workerInvocation';

const TOKEN = 'synthetic-operator-token-0123456789abcdefg';
const PROCESS_ENV: Record<string, string> = {
  DEPLOYMENT_TARGET: 'cloudflare',
  DEPLOYMENT_MODE: 'standalone',
  AI_TRANSPORT: 'direct',
  SESSION_SECRET: 'synthetic-session-secret-0123456789abcdefgh',
  PARTICIPANT_TOKEN_SECRET: 'synthetic-participant-secret-0123456789abcd',
};
const MANAGED_ENV = [...Object.keys(PROCESS_ENV), 'OPERATOR_TOKEN', 'NODE_ENV'];
const LABEL: OperatorRequestLabel = { route: '/api/operator/status', method: 'GET', operation: 'status' };

const runtimeGlobals = globalThis as unknown as Record<symbol, unknown>;
let savedEnv: Record<string, string | undefined> = {};
let logLines: string[] = [];

function installInvocation(env: Record<string, unknown>): void {
  const invocation: WorkerInvocation = {
    env: { ...PROCESS_ENV, ...env },
    identity: { kind: 'address', address: '203.0.113.7' },
    source: 'fetch',
  };
  runtimeGlobals[WORKER_RUNTIME_MARKER] = true;
  runtimeGlobals[WORKER_INVOCATION_ACCESSOR] = () => invocation;
}

function request(authorization?: string): Request {
  return new Request('https://openinterviewer.example.workers.dev/api/operator/status', {
    headers: authorization === undefined ? {} : { authorization },
  });
}

async function signIn(ageSeconds = 0): Promise<void> {
  if (ageSeconds > 0) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() - ageSeconds * 1000);
  }
  cookieJar.set(SESSION_COOKIE_NAME, await createSessionToken());
  vi.useRealTimers();
}

function operatorEvents(): Array<Record<string, unknown>> {
  return logLines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event.event === 'operator.action');
}

beforeEach(() => {
  savedEnv = Object.fromEntries(MANAGED_ENV.map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(PROCESS_ENV)) process.env[name] = value;
  delete process.env.OPERATOR_TOKEN;
  Reflect.deleteProperty(process.env, 'NODE_ENV');
  installInvocation({ OPERATOR_TOKEN: TOKEN });
  cookieJar.clear();
  logLines = [];
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
    logLines.push(String(line));
  });
});

afterEach(() => {
  vi.useRealTimers();
  delete runtimeGlobals[WORKER_RUNTIME_MARKER];
  delete runtimeGlobals[WORKER_INVOCATION_ACCESSOR];
  for (const name of MANAGED_ENV) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  // No refusal or acceptance ever logs the token, a cookie or a password.
  const joined = logLines.join('\n');
  expect(joined).not.toContain(TOKEN);
  expect(joined).not.toContain('synthetic-session-secret');
});

async function refusal(authorization?: string) {
  const response = await operatorAuthorityRefusal(request(authorization), LABEL);
  if (!response) return null;
  return { status: response.status, body: await response.json(), headers: response.headers };
}

describe('OPS-01 / F5 operator authority', () => {
  it('F5 accepts the configured bearer token with a researcher session from the last 15 minutes', async () => {
    await signIn(60);
    expect(await refusal(`Bearer ${TOKEN}`)).toBeNull();
  });

  it('F5 is Cloudflare-only: the Node target has no operator surface (404)', async () => {
    process.env.DEPLOYMENT_TARGET = 'node';
    delete runtimeGlobals[WORKER_RUNTIME_MARKER];
    delete runtimeGlobals[WORKER_INVOCATION_ACCESSOR];
    process.env.OPERATOR_TOKEN = TOKEN;
    await signIn();
    const result = await refusal(`Bearer ${TOKEN}`);
    expect(result?.status).toBe(404);
    expect(result?.headers.get('cache-control')).toBe('no-store');
  });

  it.each([
    ['unset', undefined],
    ['shorter than 32 characters', 'short-operator-token-0123456789'],
    ['a template placeholder', 'change-me-operator-token-0123456789abcdef'],
    ['padded with whitespace', ` ${TOKEN}`],
  ])('F5 never opens when OPERATOR_TOKEN is %s (503 not configured)', async (_label, configured) => {
    installInvocation(configured === undefined ? {} : { OPERATOR_TOKEN: configured });
    await signIn();
    const result = await refusal(`Bearer ${configured ?? TOKEN}`);
    expect(result?.status).toBe(503);
    expect(result?.body).toMatchObject({ code: 'OPERATOR_NOT_CONFIGURED', retryable: false });
  });

  it('F5 reads OPERATOR_TOKEN from the Worker invocation env, never from process.env', async () => {
    installInvocation({});
    process.env.OPERATOR_TOKEN = TOKEN;
    await signIn();
    expect((await refusal(`Bearer ${TOKEN}`))?.status).toBe(503);
  });

  it.each([
    ['missing', undefined],
    ['wrong with equal length', `Bearer ${TOKEN.slice(0, -1)}h`],
    ['wrong and shorter', 'Bearer synthetic-operator'],
    ['the token without the Bearer scheme', TOKEN],
    ['a Basic credential', `Basic ${Buffer.from(`operator:${TOKEN}`).toString('base64')}`],
    ['the token with trailing text', `Bearer ${TOKEN} extra`],
  ])('F5 refuses an Authorization header that is %s (401)', async (_label, authorization) => {
    await signIn();
    const result = await refusal(authorization);
    expect(result?.status).toBe(401);
    expect(result?.body).toEqual({ error: 'Operator authorization required.', code: 'OPERATOR_UNAUTHORIZED' });
    expect(result?.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('F5 compares tokens in constant time over equal-length digests, whatever length is presented', async () => {
    const compare = vi.mocked(timingSafeEqual);
    compare.mockClear();
    expect(operatorTokensMatch('x', TOKEN)).toBe(false);
    expect(operatorTokensMatch(TOKEN, TOKEN)).toBe(true);
    expect(compare).toHaveBeenCalledTimes(2);
    for (const [left, right] of compare.mock.calls) {
      expect((left as Buffer).byteLength).toBe(32);
      expect((right as Buffer).byteLength).toBe(32);
    }

    compare.mockClear();
    await signIn();
    await refusal('Bearer short');
    await refusal(undefined);
    expect(compare).toHaveBeenCalledTimes(2);
  });

  it('F5 refuses a correct token without a valid researcher session (401)', async () => {
    const none = await refusal(`Bearer ${TOKEN}`);
    expect(none?.status).toBe(401);
    expect(none?.body.code).toBe('SIGN_IN_REQUIRED');

    cookieJar.set(SESSION_COOKIE_NAME, 'forged.session.token');
    expect((await refusal(`Bearer ${TOKEN}`))?.status).toBe(401);

    // A participant session never grants researcher authority.
    cookieJar.set(SESSION_COOKIE_NAME, await createParticipantSessionToken({
      id: 'a'.repeat(64),
      studyId: 'study-a',
      studyRevision: 1,
      researcherId: null,
      expiresAt: null,
    }));
    expect((await refusal(`Bearer ${TOKEN}`))?.status).toBe(401);
  });

  it('F5 refuses a correct token with a session older than 15 minutes (403)', async () => {
    await signIn(OPERATOR_SESSION_MAX_AGE_SECONDS + 60);
    const result = await refusal(`Bearer ${TOKEN}`);
    expect(result?.status).toBe(403);
    expect(result?.body.code).toBe('RECENT_SIGN_IN_REQUIRED');
  });

  it('RT-10 logs each decision as one allowlisted operator.action event without content', async () => {
    await refusal(undefined);
    await signIn();
    await refusal(`Bearer ${TOKEN}`);
    const events = operatorEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'operator.action',
      route: '/api/operator/status',
      method: 'GET',
      operation: 'status',
      status: 401,
      reason: 'invalid',
    });
    expect(Object.keys(events[0]).sort()).toEqual(['event', 'method', 'operation', 'reason', 'route', 'status', 'ts']);
  });
});
