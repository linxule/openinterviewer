// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { getAppBaseUrl } from '@/lib/appBaseUrl';

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

  it('does not use VERCEL_URL as a fallback', () => {
    expect(getAppBaseUrl({
      NODE_ENV: 'development',
      VERCEL_URL: 'preview.vercel.app',
    } as NodeJS.ProcessEnv)).toBe('http://localhost:3000');
  });
});
