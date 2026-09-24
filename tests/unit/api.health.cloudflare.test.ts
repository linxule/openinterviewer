// @vitest-environment node
//
// Cloudflare readiness through the real configuration validator: a fake Worker
// invocation provides bindings, resolveWorkspaceStore is mocked, and every
// Redis entry point is observed to prove readiness never constructs Redis.

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

const schemaMock = vi.hoisted(() => ({ ensurePlatformSchemaLineage: vi.fn() }));
vi.mock('@/lib/platformSchema', () => schemaMock);

const resolveMock = vi.hoisted(() => ({ resolveWorkspaceStore: vi.fn() }));
vi.mock('@/lib/storage/resolve', () => resolveMock);

import { GET as healthGET } from '@/app/api/health/ready/route';
import { GET as readinessGET } from '@/app/api/config/readiness/route';
import * as kvClient from '@/lib/kvClient';
import type { RedisPort } from '@/lib/redisPort';
import {
  WORKER_INVOCATION_ACCESSOR,
  WORKER_RUNTIME_MARKER,
  type WorkerInvocation,
} from '@/lib/runtime/workerInvocation';
import type { StoreReadiness } from '@/lib/storage/types';

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
  WORKSPACE_ID: 'ws_0123456789abcdef0123456789abcdef',
  WORKSPACE_JURISDICTION: '',
  ANALYSIS_RECOVERY_EPOCH: 'ep_fedcba9876543210fedcba9876543210',
  // Present on purpose: Cloudflare readiness must ignore them entirely.
  KV_REST_API_URL: 'https://should-not-be-used.upstash.io',
  KV_REST_API_TOKEN: 'should-not-be-used-token',
};
const MANAGED_ENV = [...Object.keys(CLOUDFLARE_ENV), 'NODE_ENV'];

const runtimeGlobals = globalThis as unknown as Record<symbol, unknown>;
let savedEnv: Record<string, string | undefined> = {};
let accessedStoreMembers: string[] = [];
let readiness: ReturnType<typeof vi.fn<() => Promise<StoreReadiness>>>;

const workspaceNamespace = { idFromName: () => ({}), getByName: () => ({}) };
const analysisQueue = { send: async () => undefined, sendBatch: async () => undefined };

function installInvocation(bindings: Record<string, unknown>): void {
  const invocation: WorkerInvocation = {
    env: { ...CLOUDFLARE_ENV, ...bindings },
    identity: { kind: 'address', address: '203.0.113.7' },
    source: 'fetch',
  };
  runtimeGlobals[WORKER_INVOCATION_ACCESSOR] = () => invocation;
}

// Any store member other than readiness() would be a write, dispatch or read
// that readiness must never perform; record every access.
function fakeStore(): unknown {
  return new Proxy({}, {
    get(_target, property) {
      if (typeof property !== 'string' || property === 'then') return undefined;
      accessedStoreMembers.push(property);
      return property === 'readiness' ? readiness : () => {
        throw new Error(`unexpected store call: ${property}`);
      };
    },
  });
}

beforeEach(() => {
  savedEnv = Object.fromEntries(MANAGED_ENV.map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(CLOUDFLARE_ENV)) process.env[name] = value;
  Reflect.deleteProperty(process.env, 'NODE_ENV');
  runtimeGlobals[WORKER_RUNTIME_MARKER] = true;
  installInvocation({ WORKSPACE_STORE: workspaceNamespace, ANALYSIS_QUEUE: analysisQueue });
  accessedStoreMembers = [];
  readiness = vi.fn(async (): Promise<StoreReadiness> => ({ status: 'ready', maintenance: 'open' }));
  resolveMock.resolveWorkspaceStore.mockImplementation(() => fakeStore());
});

afterEach(() => {
  vi.useRealTimers();
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
  expect(schemaMock.ensurePlatformSchemaLineage).not.toHaveBeenCalled();
  expect(accessedStoreMembers.filter((name) => name !== 'readiness')).toEqual([]);
});

describe('RT-08 /api/health/ready on Cloudflare', () => {
  it('RT-08 reports ready after a bounded workspace readiness check, with no Redis', async () => {
    const response = await healthGET();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      ready: true,
      mode: 'standalone',
      target: 'cloudflare',
      checks: { configuration: true, workspaceStore: true, analysisQueue: true },
    });
    expect(readiness).toHaveBeenCalledTimes(1);
    expect(resolveMock.resolveWorkspaceStore).toHaveBeenCalledTimes(1);
  });

  it('RT-01 hands the store factory a fenced Redis port, never a real client', async () => {
    await healthGET();
    const [options] = resolveMock.resolveWorkspaceStore.mock.calls[0] as [
      { redisClient: () => RedisPort; researcherId: string | null },
    ];
    expect(options.researcherId).toBeNull();
    await expect(options.redisClient().ping()).rejects.toBeInstanceOf(kvClient.RedisAccessFencedError);
  });

  it.each<[string, StoreReadiness]>([
    ['unavailable', { status: 'unavailable' }],
    ['uninitialized', { status: 'held', reason: 'workspace-uninitialized' }],
    ['schema unsupported', { status: 'held', reason: 'schema-unsupported' }],
    ['identity mismatch', { status: 'held', reason: 'workspace-identity-mismatch', maintenance: 'open' }],
    ['recovery epoch mismatch', { status: 'held', reason: 'recovery-epoch-mismatch', maintenance: 'open' }],
    ['maintenance hold', { status: 'held', reason: 'maintenance', maintenance: 'frozen' }],
    ['frozen maintenance', { status: 'ready', maintenance: 'frozen' }],
    ['draining maintenance', { status: 'ready', maintenance: 'draining' }],
  ])('RT-08 returns 503 when the workspace is %s', async (_label, result) => {
    readiness.mockResolvedValue(result);
    const response = await healthGET();

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      ready: false,
      mode: 'standalone',
      target: 'cloudflare',
      checks: { configuration: true, workspaceStore: false, analysisQueue: true },
    });
  });

  it('RT-08 returns 503 when the readiness RPC throws or the store cannot be resolved', async () => {
    readiness.mockRejectedValue(new Error('rpc failed: secret detail'));
    const rejected = await healthGET();
    expect(rejected.status).toBe(503);
    expect(JSON.stringify(await rejected.json())).not.toContain('secret detail');

    resolveMock.resolveWorkspaceStore.mockImplementation(() => {
      throw new Error('binding-missing');
    });
    const unresolved = await healthGET();
    expect(unresolved.status).toBe(503);
    expect((await unresolved.json()).checks.workspaceStore).toBe(false);
  });

  it('RT-08 bounds the workspace readiness RPC at 2 seconds', async () => {
    vi.useFakeTimers();
    readiness.mockReturnValue(new Promise<StoreReadiness>(() => undefined));
    let settled = false;
    const pending = healthGET().then((response) => {
      settled = true;
      return response;
    });

    await vi.advanceTimersByTimeAsync(1_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const response = await pending;
    expect(response.status).toBe(503);
    expect((await response.json()).checks).toEqual({
      configuration: true,
      workspaceStore: false,
      analysisQueue: true,
    });
  });

  it('RT-08 reports a missing Queue binding without probing the workspace', async () => {
    installInvocation({ WORKSPACE_STORE: workspaceNamespace });
    const response = await healthGET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ready: false,
      mode: 'standalone',
      target: 'cloudflare',
      checks: { configuration: false, workspaceStore: false, analysisQueue: false },
    });
    expect(resolveMock.resolveWorkspaceStore).not.toHaveBeenCalled();
  });

  it('RT-08 reports a missing Durable Object binding without probing the workspace', async () => {
    installInvocation({ ANALYSIS_QUEUE: analysisQueue });
    const response = await healthGET();

    expect(response.status).toBe(503);
    expect((await response.json()).checks).toEqual({
      configuration: false,
      workspaceStore: false,
      analysisQueue: true,
    });
    expect(resolveMock.resolveWorkspaceStore).not.toHaveBeenCalled();
  });

  it('RT-08 does not probe or expose details when configuration is invalid', async () => {
    process.env.SESSION_SECRET = 'short';
    const response = await healthGET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.checks.configuration).toBe(false);
    expect(JSON.stringify(body)).not.toContain('weak_session_secret');
    expect(resolveMock.resolveWorkspaceStore).not.toHaveBeenCalled();
  });

  it('RT-08 is not ready outside a Worker invocation because no binding is visible', async () => {
    delete runtimeGlobals[WORKER_INVOCATION_ACCESSOR];
    delete runtimeGlobals[WORKER_RUNTIME_MARKER];
    const response = await healthGET();

    expect(response.status).toBe(503);
    expect((await response.json()).checks).toEqual({
      configuration: false,
      workspaceStore: false,
      analysisQueue: false,
    });
  });

  it('RT-01 refuses hosted mode on Cloudflare without touching platform Redis', async () => {
    process.env.DEPLOYMENT_MODE = 'hosted';
    const response = await healthGET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ready: false,
      mode: null,
      target: 'cloudflare',
      checks: { configuration: false, workspaceStore: false, analysisQueue: true },
    });
  });

  it('RT-01 a Worker whose process env lost the target never falls back to Redis', async () => {
    delete process.env.DEPLOYMENT_TARGET;
    const response = await healthGET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ready: false,
      mode: null,
      checks: { configuration: false, platformDatabase: false },
    });
  });
});

describe('RT-08 /api/config/readiness on Cloudflare', () => {
  it('RT-08 keeps the 200 contract and advertises queued-v2 when ready', async () => {
    const response = await readinessGET();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      mode: 'standalone',
      aiTransport: 'direct',
      ready: true,
      oauth: { google: false, github: false },
      errors: [],
      analysisExecution: 'queued-v2',
    });
    expect(readiness).toHaveBeenCalledTimes(1);
  });

  it.each<[StoreReadiness, string]>([
    [{ status: 'unavailable' }, 'workspace_unavailable'],
    [{ status: 'held', reason: 'workspace-uninitialized' }, 'workspace_uninitialized'],
    [{ status: 'held', reason: 'workspace-unconfigured' }, 'workspace_unconfigured'],
    [{ status: 'held', reason: 'schema-unsupported' }, 'workspace_schema_unsupported'],
    [{ status: 'held', reason: 'workspace-identity-mismatch' }, 'workspace_identity_mismatch'],
    [{ status: 'held', reason: 'recovery-epoch-mismatch' }, 'workspace_recovery_epoch_mismatch'],
    [{ status: 'held', reason: 'maintenance', maintenance: 'recovery' }, 'workspace_maintenance'],
    [{ status: 'ready', maintenance: 'draining' }, 'workspace_maintenance'],
  ])('RT-08 maps %j to ready:false with %s', async (result, error) => {
    readiness.mockResolvedValue(result);
    const response = await readinessGET();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ready: false,
      errors: [error],
      analysisExecution: 'queued-v2',
    });
  });

  it('RT-08 maps a thrown or timed-out readiness RPC to workspace_unavailable', async () => {
    readiness.mockRejectedValue(new Error('rpc failed'));
    expect(await (await readinessGET()).json()).toMatchObject({ ready: false, errors: ['workspace_unavailable'] });

    vi.useFakeTimers();
    readiness.mockReturnValue(new Promise<StoreReadiness>(() => undefined));
    const pending = readinessGET();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await (await pending).json()).toMatchObject({ ready: false, errors: ['workspace_unavailable'] });
  });

  it('RT-08 returns configuration errors without probing the workspace', async () => {
    installInvocation({ WORKSPACE_STORE: workspaceNamespace });
    process.env.WORKSPACE_ID = 'ws_not-valid';
    const response = await readinessGET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      mode: 'standalone',
      aiTransport: 'direct',
      ready: false,
      oauth: { google: false, github: false },
      errors: ['invalid_workspace_id', 'missing_analysis_queue_binding'],
      analysisExecution: 'queued-v2',
    });
    expect(resolveMock.resolveWorkspaceStore).not.toHaveBeenCalled();
  });

  it('RT-01 an unsupported Cloudflare transport withholds the analysis protocol', async () => {
    process.env.AI_TRANSPORT = 'gateway';
    expect(await (await readinessGET()).json()).toEqual({
      mode: null,
      aiTransport: null,
      ready: false,
      oauth: { google: false, github: false },
      errors: ['unsupported_cloudflare_transport'],
      analysisExecution: null,
    });
    expect(resolveMock.resolveWorkspaceStore).not.toHaveBeenCalled();
  });
});
