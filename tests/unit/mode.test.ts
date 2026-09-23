// @vitest-environment node

import { afterEach, describe, expect, it } from 'vitest';
import { getDeploymentMode, resolveDeploymentMode } from '@/lib/mode';
import { WORKER_RUNTIME_MARKER } from '@/lib/runtime/workerInvocation';

const runtimeGlobals = globalThis as unknown as Record<symbol, unknown>;

afterEach(() => {
  delete runtimeGlobals[WORKER_RUNTIME_MARKER];
});

describe('resolveDeploymentMode', () => {
  it('defaults to standalone when unset outside production', () => {
    expect(resolveDeploymentMode({ NODE_ENV: 'test' })).toEqual({ ok: true, mode: 'standalone' });
    expect(resolveDeploymentMode({ NODE_ENV: 'development', DEPLOYMENT_MODE: '' })).toEqual({
      ok: true,
      mode: 'standalone',
    });
  });

  it('fails closed when unset in production', () => {
    expect(resolveDeploymentMode({ NODE_ENV: 'production' })).toEqual({
      ok: false,
      error: 'missing_deployment_mode',
    });
  });

  it('accepts only exact standalone or hosted values', () => {
    expect(resolveDeploymentMode({ DEPLOYMENT_MODE: 'hosted' })).toEqual({ ok: true, mode: 'hosted' });
    expect(resolveDeploymentMode({ DEPLOYMENT_MODE: 'standalone' })).toEqual({
      ok: true,
      mode: 'standalone',
    });
  });

  it('rejects typos and case variants instead of falling back', () => {
    expect(resolveDeploymentMode({ DEPLOYMENT_MODE: 'Hosted' })).toEqual({
      ok: false,
      error: 'invalid_deployment_mode',
    });
    expect(resolveDeploymentMode({ DEPLOYMENT_MODE: 'hostd' })).toEqual({
      ok: false,
      error: 'invalid_deployment_mode',
    });
    expect(resolveDeploymentMode({ NODE_ENV: 'production', DEPLOYMENT_MODE: 'hosted ' })).toEqual({
      ok: false,
      error: 'invalid_deployment_mode',
    });
  });
});

describe('RT-01 production-strict mode on Cloudflare', () => {
  it('RT-01 requires DEPLOYMENT_MODE on the Cloudflare target without NODE_ENV', () => {
    expect(resolveDeploymentMode({ DEPLOYMENT_TARGET: 'cloudflare' })).toEqual({
      ok: false,
      error: 'missing_deployment_mode',
    });
    expect(resolveDeploymentMode({ DEPLOYMENT_TARGET: 'cloudflare', NODE_ENV: 'development' })).toEqual({
      ok: false,
      error: 'missing_deployment_mode',
    });
  });

  it('RT-01 requires DEPLOYMENT_MODE inside a Worker runtime whatever the env says', () => {
    runtimeGlobals[WORKER_RUNTIME_MARKER] = true;
    expect(resolveDeploymentMode({})).toEqual({ ok: false, error: 'missing_deployment_mode' });
    expect(resolveDeploymentMode({ NODE_ENV: 'development', DEPLOYMENT_MODE: '' })).toEqual({
      ok: false,
      error: 'missing_deployment_mode',
    });
    expect(resolveDeploymentMode({ DEPLOYMENT_MODE: 'standalone' })).toEqual({ ok: true, mode: 'standalone' });
  });

  it('RT-01 keeps the Node development default unchanged', () => {
    expect(resolveDeploymentMode({ DEPLOYMENT_TARGET: 'node', NODE_ENV: 'development' })).toEqual({
      ok: true,
      mode: 'standalone',
    });
  });
});

describe('getDeploymentMode', () => {
  it('throws on an exact-value mismatch instead of defaulting', () => {
    const previous = process.env.DEPLOYMENT_MODE;
    process.env.DEPLOYMENT_MODE = 'hostd';

    expect(() => getDeploymentMode()).toThrow(/exactly "standalone" or "hosted"/);

    if (previous === undefined) delete process.env.DEPLOYMENT_MODE;
    else process.env.DEPLOYMENT_MODE = previous;
  });
});
