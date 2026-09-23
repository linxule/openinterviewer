// @vitest-environment node
//
// GET /api/studies on the Node standalone target (ST-01): the Redis workspace
// store's readiness is the former ping and its collection read is the former
// getAllStudiesChecked call, so the unconfigured-Redis empty list survives on
// Node only (the Cloudflare 503 is covered in api.studies.cloudflare.test.ts).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredStudy } from '../fixtures/models';
import { standaloneTestContext } from '../helpers/workspaceStoreFixture';
import type { RedisPort } from '@/lib/redisPort';

const contextMock = vi.hoisted(() => ({ getRequestContext: vi.fn() }));
vi.mock('@/lib/researcherContext', () => contextMock);

const kvMock = vi.hoisted(() => ({
  getAllStudiesChecked: vi.fn(),
  isKVAvailable: vi.fn(),
}));
vi.mock('@/lib/kv', () => kvMock);
vi.mock('@/lib/mode', () => ({ isHostedMode: vi.fn().mockReturnValue(false) }));

import { GET } from '@/app/api/studies/route';

const kvClient = { marker: 'standalone-redis' } as unknown as RedisPort;

beforeEach(() => {
  vi.clearAllMocks();
  contextMock.getRequestContext.mockResolvedValue({ authorized: true, context: standaloneTestContext(kvClient) });
});

describe('GET /api/studies on Node standalone (ST-01)', () => {
  it('ST-01: a failed Redis ping keeps the 200 empty list with the setup warning', async () => {
    kvMock.isKVAvailable.mockResolvedValue(false);

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      studies: [],
      warning: 'Storage not configured. Connect Upstash Redis to enable persistence.',
    });
    expect(kvMock.isKVAvailable).toHaveBeenCalledWith(kvClient);
    expect(kvMock.getAllStudiesChecked).not.toHaveBeenCalled();
  });

  it('ST-01: reads at most 1,000 studies from the context client and keeps the collection mappings', async () => {
    const study = makeStoredStudy();
    kvMock.isKVAvailable.mockResolvedValue(true);
    kvMock.getAllStudiesChecked.mockResolvedValueOnce({ status: 'ok', items: [study] });

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ studies: [JSON.parse(JSON.stringify(study))] });
    expect(kvMock.getAllStudiesChecked).toHaveBeenCalledWith(kvClient, 1_000);

    kvMock.getAllStudiesChecked.mockResolvedValueOnce({ status: 'unavailable' });
    const unavailable = await GET();
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({ error: 'Study storage is temporarily unavailable.', retryable: true });
  });
});
