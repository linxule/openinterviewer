// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const configMock = vi.hoisted(() => ({ getPublicConfig: vi.fn() }));
vi.mock('@/lib/hostedConfig', () => configMock);

const pingMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/kvClient', () => ({
  getPlatformClient: () => ({ ping: pingMock }),
  getKVClient: () => ({ ping: pingMock }),
}));

import { GET } from '@/app/api/health/ready/route';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('deployment readiness endpoint', () => {
  it('reports a ready standalone deployment only after its Redis responds', async () => {
    configMock.getPublicConfig.mockReturnValue({ mode: 'standalone', ready: true });
    pingMock.mockResolvedValue('PONG');

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ready: true,
      mode: 'standalone',
      checks: { configuration: true, platformDatabase: true },
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(pingMock).toHaveBeenCalledTimes(1);
  });

  it('requires a live hosted platform database', async () => {
    configMock.getPublicConfig.mockReturnValue({ mode: 'hosted', ready: true });
    pingMock.mockResolvedValue('PONG');
    const ready = await GET();
    expect(ready.status).toBe(200);

    pingMock.mockResolvedValue('NOPE');
    const unavailable = await GET();
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      ready: false,
      mode: 'hosted',
      checks: { configuration: true, platformDatabase: false },
    });
  });

  it('does not probe storage or expose configuration details when config is invalid', async () => {
    configMock.getPublicConfig.mockReturnValue({
      mode: 'hosted',
      ready: false,
      errors: ['weak_session_secret'],
    });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(pingMock).not.toHaveBeenCalled();
    expect(body).toEqual({
      ready: false,
      mode: 'hosted',
      checks: { configuration: false, platformDatabase: false },
    });
    expect(JSON.stringify(body)).not.toContain('weak_session_secret');
  });
});
