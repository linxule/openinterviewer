// @vitest-environment node

import { afterEach, describe, expect, it } from 'vitest';
import { getAppBaseUrl, isLocalAppHost } from '@/lib/appBaseUrl';
import { WORKER_RUNTIME_MARKER } from '@/lib/runtime/workerInvocation';

const runtimeGlobals = globalThis as unknown as Record<symbol, unknown>;

afterEach(() => {
  delete runtimeGlobals[WORKER_RUNTIME_MARKER];
});

describe('getAppBaseUrl', () => {
  it('falls back to localhost only outside production', () => {
    expect(getAppBaseUrl({ NODE_ENV: 'development' })).toBe('http://localhost:3000');
    expect(getAppBaseUrl({ NODE_ENV: 'test' })).toBe('http://localhost:3000');
  });

  it('requires APP_BASE_URL in production', () => {
    expect(() => getAppBaseUrl({ NODE_ENV: 'production' })).toThrow(/APP_BASE_URL/);
  });

  it('requires a stable HTTPS origin in production', () => {
    expect(() => getAppBaseUrl({
      NODE_ENV: 'production',
      APP_BASE_URL: 'http://research.example',
    })).toThrow(/HTTPS/);
    expect(() => getAppBaseUrl({
      NODE_ENV: 'production',
      APP_BASE_URL: 'https://localhost',
    })).toThrow(/HTTPS/);
  });

  it('returns the configured origin without a trailing slash', () => {
    expect(getAppBaseUrl({
      NODE_ENV: 'production',
      APP_BASE_URL: 'https://research.example/',
    })).toBe('https://research.example');
  });

  it('rejects pathful canonical URLs', () => {
    expect(() => getAppBaseUrl({
      NODE_ENV: 'production',
      APP_BASE_URL: 'https://research.example/app',
    })).toThrow(/invalid/);
  });

  // Intentional change from the pre-Cloudflare code, which only matched the
  // literal 127.0.0.1 and an unbracketed '::1' that WHATWG URL never produces.
  it.each([
    'https://127.0.0.2',
    'https://[::1]',
    'https://[::ffff:127.0.0.1]',
    'https://localhost.',
  ])('RT-06 rejects the loopback origin %s in Node production', (origin) => {
    expect(() => getAppBaseUrl({ NODE_ENV: 'production', APP_BASE_URL: origin })).toThrow(/HTTPS/);
    expect(getAppBaseUrl({ NODE_ENV: 'development', APP_BASE_URL: origin })).toBe(new URL(origin).origin);
  });

  it('does not use VERCEL_URL as a fallback', () => {
    expect(getAppBaseUrl({
      NODE_ENV: 'development',
      VERCEL_URL: 'preview.vercel.app',
    } as NodeJS.ProcessEnv)).toBe('http://localhost:3000');
  });
});

describe('RT-06 APP_BASE_URL on Cloudflare', () => {
  const cloudflare = (APP_BASE_URL?: string) => ({ DEPLOYMENT_TARGET: 'cloudflare', APP_BASE_URL });

  it('RT-06 requires an explicit origin without relying on NODE_ENV', () => {
    expect(() => getAppBaseUrl(cloudflare())).toThrow(/required/);
    expect(() => getAppBaseUrl({ ...cloudflare(), NODE_ENV: 'development' })).toThrow(/required/);
  });

  it('RT-06 requires a stable HTTPS origin inside any Worker runtime', () => {
    runtimeGlobals[WORKER_RUNTIME_MARKER] = true;
    expect(() => getAppBaseUrl({})).toThrow(/required/);
    expect(() => getAppBaseUrl({ APP_BASE_URL: 'http://research.example' })).toThrow(/HTTPS/);
  });

  it.each([
    'http://research.example',
    'https://localhost',
    'https://localhost.',
    'https://app.localhost',
    'https://127.0.0.1',
    'https://127.1',
    'https://[::1]',
    'https://[0:0:0:0:0:0:0:1]',
    'https://[::ffff:127.0.0.1]',
  ])('RT-06 rejects the non-public origin %s', (origin) => {
    expect(() => getAppBaseUrl(cloudflare(origin))).toThrow(/HTTPS/);
  });

  it.each([
    'https://user:pass@research.example',
    'https://research.example/app',
    'https://research.example/?next=1',
    'https://research.example/#frag',
  ])('RT-06 rejects the non-origin URL %s', (value) => {
    expect(() => getAppBaseUrl(cloudflare(value))).toThrow(/invalid/);
  });

  it('RT-06 accepts a workers.dev origin', () => {
    expect(getAppBaseUrl(cloudflare('https://openinterviewer.example.workers.dev/')))
      .toBe('https://openinterviewer.example.workers.dev');
  });

  it('RT-06 classifies public hosts and addresses as non-local', () => {
    expect(isLocalAppHost('research.example')).toBe(false);
    expect(isLocalAppHost('203.0.113.7')).toBe(false);
    expect(isLocalAppHost('[2001:db8::1]')).toBe(false);
    expect(isLocalAppHost('localhost.example')).toBe(false);
  });
});
