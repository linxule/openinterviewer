// @vitest-environment node

import { afterEach, describe, expect, it } from 'vitest';
import {
  getCapabilities,
  isCloudflareTarget,
  resolveCapabilities,
} from '@/lib/runtime/capabilities';
import { isProductionStrict, resolveDeploymentTarget } from '@/lib/runtime/target';
import { WORKER_RUNTIME_MARKER } from '@/lib/runtime/workerInvocation';

type Env = Record<string, string | undefined>;
const runtimeGlobals = globalThis as unknown as Record<symbol, unknown>;

afterEach(() => {
  delete runtimeGlobals[WORKER_RUNTIME_MARKER];
});

describe('RT-01 deployment target resolution', () => {
  it('RT-01 defaults an absent or empty target to node', () => {
    expect(resolveDeploymentTarget({})).toEqual({ ok: true, target: 'node' });
    expect(resolveDeploymentTarget({ DEPLOYMENT_TARGET: '' })).toEqual({ ok: true, target: 'node' });
  });

  it.each(['aws', 'Cloudflare', ' cloudflare', 'cloudflare ', 'workers', 'NODE'])(
    'RT-01 rejects the inexact target %j instead of falling back',
    (value) => {
      expect(resolveDeploymentTarget({ DEPLOYMENT_TARGET: value })).toEqual({
        ok: false,
        error: 'invalid_deployment_target',
      });
      expect(resolveCapabilities({ DEPLOYMENT_TARGET: value, DEPLOYMENT_MODE: 'standalone' })).toEqual({
        ok: false,
        error: 'invalid_deployment_target',
      });
    },
  );
});

describe('RT-01 supported capability matrix', () => {
  const supported: Array<[string, Env, object]> = [
    [
      'node standalone direct',
      { DEPLOYMENT_MODE: 'standalone' },
      { target: 'node', mode: 'standalone', transport: 'direct', storage: 'redis', analysisExecution: 'synchronous' },
    ],
    [
      'explicit node standalone gateway',
      { DEPLOYMENT_TARGET: 'node', DEPLOYMENT_MODE: 'standalone', AI_TRANSPORT: 'gateway' },
      { target: 'node', mode: 'standalone', transport: 'gateway', storage: 'redis', analysisExecution: 'synchronous' },
    ],
    [
      'node hosted direct',
      { DEPLOYMENT_MODE: 'hosted', AI_TRANSPORT: 'direct' },
      { target: 'node', mode: 'hosted', transport: 'direct', storage: 'redis-byos', analysisExecution: 'synchronous' },
    ],
    [
      'node standalone default outside production',
      { NODE_ENV: 'development' },
      { target: 'node', mode: 'standalone', transport: 'direct', storage: 'redis', analysisExecution: 'synchronous' },
    ],
    [
      'cloudflare standalone with absent transport',
      { DEPLOYMENT_TARGET: 'cloudflare', DEPLOYMENT_MODE: 'standalone' },
      { target: 'cloudflare', mode: 'standalone', transport: 'direct', storage: 'workspace-do', analysisExecution: 'queued-v2' },
    ],
    [
      'cloudflare standalone direct',
      { DEPLOYMENT_TARGET: 'cloudflare', DEPLOYMENT_MODE: 'standalone', AI_TRANSPORT: 'direct' },
      { target: 'cloudflare', mode: 'standalone', transport: 'direct', storage: 'workspace-do', analysisExecution: 'queued-v2' },
    ],
    [
      'cloudflare standalone through Cloudflare AI Gateway (RT-11)',
      { DEPLOYMENT_TARGET: 'cloudflare', DEPLOYMENT_MODE: 'standalone', AI_TRANSPORT: 'cloudflare-gateway' },
      {
        target: 'cloudflare',
        mode: 'standalone',
        transport: 'cloudflare-gateway',
        storage: 'workspace-do',
        analysisExecution: 'queued-v2',
      },
    ],
  ];

  it.each(supported)('RT-01 resolves %s', (_label, env, expected) => {
    expect(resolveCapabilities(env)).toEqual({ ok: true, capabilities: expected });
    expect(getCapabilities(env)).toEqual(expected);
  });

  const unsupported: Array<[string, Env, string]> = [
    ['node missing mode in production', { NODE_ENV: 'production' }, 'missing_deployment_mode'],
    ['node inexact mode', { DEPLOYMENT_MODE: 'Hosted' }, 'invalid_deployment_mode'],
    ['node invalid transport', { DEPLOYMENT_MODE: 'standalone', AI_TRANSPORT: 'grpc' }, 'invalid_ai_transport'],
    ['node hosted gateway', { DEPLOYMENT_MODE: 'hosted', AI_TRANSPORT: 'gateway' }, 'gateway_not_supported_hosted'],
    // Cloudflare AI Gateway is the Cloudflare target's own transport (RT-11).
    ['node cloudflare-gateway', { DEPLOYMENT_MODE: 'standalone', AI_TRANSPORT: 'cloudflare-gateway' }, 'invalid_ai_transport'],
    ['node hosted cloudflare-gateway', { DEPLOYMENT_MODE: 'hosted', AI_TRANSPORT: 'cloudflare-gateway' }, 'invalid_ai_transport'],
    ['cloudflare missing mode without NODE_ENV', { DEPLOYMENT_TARGET: 'cloudflare' }, 'missing_deployment_mode'],
    [
      'cloudflare missing mode even in development',
      { DEPLOYMENT_TARGET: 'cloudflare', NODE_ENV: 'development' },
      'missing_deployment_mode',
    ],
    ['cloudflare empty mode', { DEPLOYMENT_TARGET: 'cloudflare', DEPLOYMENT_MODE: '' }, 'missing_deployment_mode'],
    ['cloudflare hosted', { DEPLOYMENT_TARGET: 'cloudflare', DEPLOYMENT_MODE: 'hosted' }, 'unsupported_cloudflare_mode'],
    ['cloudflare inexact mode', { DEPLOYMENT_TARGET: 'cloudflare', DEPLOYMENT_MODE: 'Standalone' }, 'invalid_deployment_mode'],
    [
      'cloudflare gateway',
      { DEPLOYMENT_TARGET: 'cloudflare', DEPLOYMENT_MODE: 'standalone', AI_TRANSPORT: 'gateway' },
      'unsupported_cloudflare_transport',
    ],
    [
      'cloudflare invalid transport',
      { DEPLOYMENT_TARGET: 'cloudflare', DEPLOYMENT_MODE: 'standalone', AI_TRANSPORT: 'grpc' },
      'invalid_ai_transport',
    ],
  ];

  it.each(unsupported)('RT-01 refuses %s', (_label, env, error) => {
    expect(resolveCapabilities(env)).toEqual({ ok: false, error });
    expect(() => getCapabilities(env)).toThrow(`Unsupported deployment configuration: ${error}`);
  });

  it('RT-01 never infers storage from credentials or bindings-shaped values', () => {
    const cloudflare = resolveCapabilities({
      DEPLOYMENT_TARGET: 'cloudflare',
      DEPLOYMENT_MODE: 'standalone',
      KV_REST_API_URL: 'https://example.upstash.io',
      KV_REST_API_TOKEN: 'token',
    });
    expect(cloudflare).toMatchObject({ ok: true, capabilities: { storage: 'workspace-do' } });

    const node = resolveCapabilities({
      DEPLOYMENT_MODE: 'standalone',
      WORKSPACE_ID: 'ws_0123456789abcdef0123456789abcdef',
      WORKSPACE_STORE: 'present',
    });
    expect(node).toMatchObject({ ok: true, capabilities: { storage: 'redis' } });
  });

  it('RT-01 refuses the Node default inside a Worker runtime', () => {
    runtimeGlobals[WORKER_RUNTIME_MARKER] = true;
    expect(resolveCapabilities({ DEPLOYMENT_MODE: 'standalone' })).toEqual({
      ok: false,
      error: 'invalid_deployment_target',
    });
    expect(resolveCapabilities({ DEPLOYMENT_TARGET: 'node', DEPLOYMENT_MODE: 'standalone' })).toEqual({
      ok: false,
      error: 'invalid_deployment_target',
    });
    expect(resolveCapabilities({ DEPLOYMENT_TARGET: 'cloudflare', DEPLOYMENT_MODE: 'standalone' }))
      .toMatchObject({ ok: true, capabilities: { target: 'cloudflare' } });
  });

  it('RT-01 unsupported-configuration errors carry no configured values', () => {
    expect(() => getCapabilities({ DEPLOYMENT_TARGET: 'cloudflare', DEPLOYMENT_MODE: 'hostd-typo' }))
      .toThrow(/^Unsupported deployment configuration: invalid_deployment_mode$/);
  });

  it('RT-01 isCloudflareTarget recognizes only the exact cloudflare target', () => {
    expect(isCloudflareTarget({ DEPLOYMENT_TARGET: 'cloudflare' })).toBe(true);
    expect(isCloudflareTarget({ DEPLOYMENT_TARGET: 'Cloudflare' })).toBe(false);
    expect(isCloudflareTarget({})).toBe(false);
  });
});

describe('RT-06 production strictness', () => {
  it('RT-06 is strict for NODE_ENV production, the Cloudflare target and any Worker runtime', () => {
    expect(isProductionStrict({ NODE_ENV: 'production' })).toBe(true);
    expect(isProductionStrict({ DEPLOYMENT_TARGET: 'cloudflare' })).toBe(true);
    expect(isProductionStrict({ DEPLOYMENT_TARGET: 'cloudflare', NODE_ENV: 'development' })).toBe(true);
    expect(isProductionStrict({ NODE_ENV: 'development' })).toBe(false);
    expect(isProductionStrict({})).toBe(false);

    runtimeGlobals[WORKER_RUNTIME_MARKER] = true;
    expect(isProductionStrict({})).toBe(true);
  });
});
