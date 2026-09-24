// @vitest-environment node
//
// GET /api/config/status and GET /api/auth/me on the Cloudflare target
// (RT-01, RT-05, RT-08, 01-runtime route table). Real configuration, session
// verification and target-aware request context; every Redis and hosted
// platform entry point is observed to prove neither route constructs Redis,
// and the WorkspaceStore stub records any RPC (neither route needs one).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('@/lib/platformDb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platformDb')>();
  return { ...actual, getResearcherByIdChecked: vi.fn(actual.getResearcherByIdChecked) };
});

const cookieJar = vi.hoisted(() => new Map<string, string>());
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined),
  })),
}));

import { GET as statusGET } from '@/app/api/config/status/route';
import { GET as meGET } from '@/app/api/auth/me/route';
import { createSessionToken, SESSION_COOKIE_NAME } from '@/lib/auth';
import * as kvClient from '@/lib/kvClient';
import * as platformDb from '@/lib/platformDb';
import {
  WORKER_INVOCATION_ACCESSOR,
  WORKER_RUNTIME_MARKER,
  type WorkerInvocation,
} from '@/lib/runtime/workerInvocation';

const WORKSPACE_ID = 'ws_0123456789abcdef0123456789abcdef';
const OPENAI_KEY = 'synthetic-openai-provider-key';
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
  OPENAI_API_KEY: OPENAI_KEY,
  WORKSPACE_ID,
  WORKSPACE_JURISDICTION: '',
  ANALYSIS_RECOVERY_EPOCH: 'ep_fedcba9876543210fedcba9876543210',
  // Present on purpose: the Cloudflare target must ignore them entirely.
  KV_REST_API_URL: 'https://should-not-be-used.upstash.io',
  KV_REST_API_TOKEN: 'should-not-be-used-token',
};
const MANAGED_ENV = [...Object.keys(CLOUDFLARE_ENV), 'ANTHROPIC_API_KEY', 'NODE_ENV'];

const runtimeGlobals = globalThis as unknown as Record<symbol, unknown>;
let savedEnv: Record<string, string | undefined> = {};
let rpcCalls: string[] = [];

const workspaceStub = new Proxy({}, {
  get(_target, property) {
    if (typeof property !== 'string' || property === 'then') return undefined;
    return async () => {
      rpcCalls.push(property);
      throw new Error(`unexpected RPC ${property}`);
    };
  },
});
const workspaceNamespace = { idFromName: () => ({}), getByName: () => workspaceStub };

function installInvocation(env: Record<string, unknown> = {}): void {
  const invocation: WorkerInvocation = {
    env: { ...CLOUDFLARE_ENV, WORKSPACE_STORE: workspaceNamespace, ANALYSIS_QUEUE: { send: async () => undefined }, ...env },
    identity: { kind: 'address', address: '203.0.113.7' },
    source: 'fetch',
  };
  runtimeGlobals[WORKER_INVOCATION_ACCESSOR] = () => invocation;
}

beforeEach(async () => {
  savedEnv = Object.fromEntries(MANAGED_ENV.map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(CLOUDFLARE_ENV)) process.env[name] = value;
  Reflect.deleteProperty(process.env, 'NODE_ENV');
  runtimeGlobals[WORKER_RUNTIME_MARKER] = true;
  installInvocation();
  rpcCalls = [];
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
  expect(kvClient.getKVClient).not.toHaveBeenCalled();
  expect(kvClient.getPlatformClient).not.toHaveBeenCalled();
  expect(kvClient.getResearcherClient).not.toHaveBeenCalled();
  expect(platformDb.getResearcherByIdChecked).not.toHaveBeenCalled();
  expect(rpcCalls).toEqual([]);
});

describe('RT-01 GET /api/config/status on Cloudflare', () => {
  it('RT-08 reports the workspace-do storage capability and key availability as booleans only', async () => {
    const response = await statusGET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      mode: 'standalone',
      target: 'cloudflare',
      aiTransport: 'direct',
      storage: 'workspace-do',
      hasAnthropicKey: false,
      hasGeminiKey: false,
      hasOpenAiKey: true,
      hasOpenRouterKey: false,
    });
    expect(JSON.stringify(body)).not.toContain(OPENAI_KEY);
  });

  it('RT-11 reports Cloudflare AI Gateway, with availability still decided by the bound keys', async () => {
    process.env.AI_TRANSPORT = 'cloudflare-gateway';
    installInvocation({
      AI_TRANSPORT: 'cloudflare-gateway',
      CF_AI_GATEWAY_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
      CF_AI_GATEWAY_ID: 'oi-unit-test',
      CF_AI_GATEWAY_TOKEN: 'synthetic-ai-gateway-run-token-0123456789',
    });
    const body = await (await statusGET()).json();
    expect(body).toEqual({
      mode: 'standalone',
      target: 'cloudflare',
      aiTransport: 'cloudflare-gateway',
      storage: 'workspace-do',
      hasAnthropicKey: false,
      hasGeminiKey: false,
      hasOpenAiKey: true,
      hasOpenRouterKey: false,
    });
    expect(JSON.stringify(body)).not.toContain('synthetic-ai-gateway-run-token');
  });

  it('RT-05 provider key availability comes from the Worker invocation env', async () => {
    process.env.ANTHROPIC_API_KEY = 'synthetic-anthropic-key-in-process-env';
    installInvocation({ OPENAI_API_KEY: undefined });
    const body = await (await statusGET()).json();
    expect(body.hasAnthropicKey).toBe(false);
    expect(body.hasOpenAiKey).toBe(false);
  });

  it('requires a researcher session (401)', async () => {
    cookieJar.clear();
    expect((await statusGET()).status).toBe(401);
  });

  it('a missing workspace binding is 503, never a signed-out 401', async () => {
    installInvocation({ WORKSPACE_STORE: undefined });
    const response = await statusGET();
    expect(response.status).toBe(503);
  });

  it('RT-01 an unsupported Cloudflare mode is 503 without any hosted platform lookup', async () => {
    process.env.DEPLOYMENT_MODE = 'hosted';
    expect((await statusGET()).status).toBe(503);
  });
});

describe('RT-01 GET /api/auth/me on Cloudflare', () => {
  it('returns the standalone profile from the target-aware context', async () => {
    const response = await meGET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ mode: 'standalone', authenticated: true });
  });

  it('requires a researcher session (401)', async () => {
    cookieJar.set(SESSION_COOKIE_NAME, 'forged.session.token');
    expect((await meGET()).status).toBe(401);
  });

  it('a missing workspace binding is 503, never a signed-out 401', async () => {
    installInvocation({ WORKSPACE_STORE: undefined });
    expect((await meGET()).status).toBe(503);
  });

  it('RT-01 an unsupported Cloudflare mode is 503 without any hosted platform lookup', async () => {
    process.env.DEPLOYMENT_MODE = 'hosted';
    expect((await meGET()).status).toBe(503);
  });
});
