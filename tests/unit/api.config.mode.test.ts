// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const redisConstructor = vi.hoisted(() => vi.fn());
vi.mock('@upstash/redis', () => ({ Redis: redisConstructor }));

import { GET } from '@/app/api/config/mode/route';
import { WORKER_INVOCATION_ACCESSOR, type WorkerInvocation } from '@/lib/runtime/workerInvocation';

const SECRETS = {
  ADMIN_PASSWORD: 'synthetic-admin-password-1',
  SESSION_SECRET: 'synthetic-session-secret-0123456789abcdefgh',
  PARTICIPANT_TOKEN_SECRET: 'synthetic-participant-secret-0123456789abcd',
  RATE_LIMIT_SALT: 'synthetic-rate-limit-salt-0123456789abcdef',
  GEMINI_API_KEY: 'synthetic-gemini-provider-key',
};
const NODE_STANDALONE = {
  ...SECRETS,
  NODE_ENV: 'production',
  DEPLOYMENT_MODE: 'standalone',
  APP_BASE_URL: 'https://standalone.example',
  KV_REST_API_URL: 'https://standalone.upstash.io',
  KV_REST_API_TOKEN: 'synthetic-redis-token',
};
const CLOUDFLARE = {
  ...SECRETS,
  DEPLOYMENT_TARGET: 'cloudflare',
  DEPLOYMENT_MODE: 'standalone',
  APP_BASE_URL: 'https://openinterviewer.example.workers.dev',
  WORKSPACE_ID: 'ws_0123456789abcdef0123456789abcdef',
  ANALYSIS_RECOVERY_EPOCH: 'ep_fedcba9876543210fedcba9876543210',
};
const MANAGED = [...new Set([...Object.keys(NODE_STANDALONE), ...Object.keys(CLOUDFLARE), 'AI_TRANSPORT'])];
const runtimeGlobals = globalThis as unknown as Record<symbol, unknown>;
let savedEnv: Record<string, string | undefined> = {};

function useEnv(values: Record<string, string>): void {
  for (const name of MANAGED) delete process.env[name];
  Object.assign(process.env, values);
}

beforeEach(() => {
  savedEnv = Object.fromEntries(MANAGED.map((name) => [name, process.env[name]]));
});

afterEach(() => {
  delete runtimeGlobals[WORKER_INVOCATION_ACCESSOR];
  for (const name of MANAGED) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  expect(redisConstructor).not.toHaveBeenCalled();
});

describe('RT-08 /api/config/mode', () => {
  it('RT-08 keeps the Node fields and advertises synchronous analysis', async () => {
    useEnv(NODE_STANDALONE);
    const response = await GET();

    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      mode: 'standalone',
      aiTransport: 'direct',
      oauth: { google: false, github: false },
      ready: true,
      errors: [],
      analysisExecution: 'synchronous',
    });
  });

  it('RT-08 advertises queued-v2 on a valid Cloudflare target', async () => {
    useEnv(CLOUDFLARE);
    const invocation: WorkerInvocation = {
      env: {
        WORKSPACE_STORE: { idFromName: () => ({}) },
        ANALYSIS_QUEUE: { send: async () => undefined },
      },
      identity: null,
      source: 'fetch',
    };
    runtimeGlobals[WORKER_INVOCATION_ACCESSOR] = () => invocation;

    expect(await (await GET()).json()).toEqual({
      mode: 'standalone',
      aiTransport: 'direct',
      oauth: { google: false, github: false },
      ready: true,
      errors: [],
      analysisExecution: 'queued-v2',
    });
  });

  it('RT-08 keeps advertising the protocol while not ready, and withholds it when unsupported', async () => {
    useEnv(CLOUDFLARE);
    expect(await (await GET()).json()).toMatchObject({
      ready: false,
      errors: ['missing_workspace_store_binding', 'missing_analysis_queue_binding'],
      analysisExecution: 'queued-v2',
    });

    useEnv({ ...CLOUDFLARE, AI_TRANSPORT: 'gateway' });
    expect(await (await GET()).json()).toMatchObject({
      mode: null,
      ready: false,
      errors: ['unsupported_cloudflare_transport'],
      analysisExecution: null,
    });
  });
});
