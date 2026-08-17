// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const configMock = vi.hoisted(() => ({ getPublicConfig: vi.fn() }));
vi.mock('@/lib/hostedConfig', () => configMock);

const platformMock = vi.hoisted(() => ({ getPlatformClient: vi.fn() }));
vi.mock('@/lib/kvClient', () => platformMock);

const schemaMock = vi.hoisted(() => ({
  ensurePlatformSchemaLineage: vi.fn(async () => 'ok'),
}));
vi.mock('@/lib/platformSchema', () => schemaMock);

import { GET } from '@/app/api/config/readiness/route';

beforeEach(() => {
  vi.clearAllMocks();
  platformMock.getPlatformClient.mockReturnValue({ ping: vi.fn() });
});

describe('public config readiness', () => {
  it('does not probe lineage when hosted configuration is already invalid', async () => {
    configMock.getPublicConfig.mockReturnValue({
      mode: 'hosted',
      ready: false,
      oauth: { google: false, github: false },
      errors: ['weak_session_secret'],
    });

    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      mode: 'hosted',
      ready: false,
      oauth: { google: false, github: false },
      errors: ['weak_session_secret'],
    });
    expect(schemaMock.ensurePlatformSchemaLineage).not.toHaveBeenCalled();
  });

  it('marks hosted schema-hold as not ready without leaking Redis details', async () => {
    configMock.getPublicConfig.mockReturnValue({
      mode: 'hosted',
      ready: true,
      oauth: { google: true, github: false },
      errors: [],
    });
    schemaMock.ensurePlatformSchemaLineage.mockResolvedValueOnce('hold');

    const response = await GET();
    const body = await response.json();
    expect(body).toEqual({
      mode: 'hosted',
      ready: false,
      oauth: { google: true, github: false },
      errors: ['schema_hold'],
    });
    expect(JSON.stringify(body)).not.toContain('schema-lineage');
  });
});
