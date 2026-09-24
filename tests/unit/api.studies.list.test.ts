// @vitest-environment node
//
// GET /api/studies on the Node standalone target (ST-01): the Redis workspace
// store's readiness is the former ping and its collection read is the former
// getAllStudiesChecked call, so the unconfigured-Redis empty list survives on
// Node only (the Cloudflare 503 is covered in api.studies.cloudflare.test.ts).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredStudy, makeStudyConfig } from '../fixtures/models';
import { standaloneTestContext } from '../helpers/workspaceStoreFixture';
import type { RedisPort } from '@/lib/redisPort';
import { toStudyListItem, type StoredStudy } from '@/types';

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

    const response = await GET(new Request('http://localhost/api/studies'));

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

    const response = await GET(new Request('http://localhost/api/studies'));

    expect(response.status).toBe(200);
    // Without a view the response is the legacy list of whole stored studies (ST-08).
    await expect(response.json()).resolves.toEqual({ studies: [JSON.parse(JSON.stringify(study))] });
    expect(kvMock.getAllStudiesChecked).toHaveBeenCalledWith(kvClient, 1_000);

    kvMock.getAllStudiesChecked.mockResolvedValueOnce({ status: 'unavailable' });
    const unavailable = await GET(new Request('http://localhost/api/studies'));
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({ error: 'Study storage is temporarily unavailable.', retryable: true });
  });

  it('ST-08: the legacy response keeps every stored field in order, so a tab from before the summary view still renders', async () => {
    const study = makeStoredStudy({ config: makeStudyConfig({ coreQuestions: ['One?', 'Two?', 'Three?'] }) });
    kvMock.isKVAvailable.mockResolvedValue(true);
    kvMock.getAllStudiesChecked.mockResolvedValue({ status: 'ok', items: [study] });

    const response = await GET(new Request('http://localhost/api/studies'));
    const text = await response.text();
    expect(text).toBe(JSON.stringify({ studies: [study] }));
    // The study list's rendering before the summary view read the configuration directly.
    const legacyRow = (item: StoredStudy) => [item.config.name, item.config.coreQuestions.length, item.config.description];
    const [listed] = (JSON.parse(text) as { studies: StoredStudy[] }).studies;
    expect(legacyRow(listed)).toEqual([study.config.name, 3, study.config.description]);

    const explicit = await GET(new Request('http://localhost/api/studies?view=full'));
    expect(await explicit.text()).toBe(text);
  });

  it('ST-08: ?view=summary lists items without the configuration', async () => {
    const study = makeStoredStudy({ config: makeStudyConfig({ coreQuestions: ['One?', 'Two?'] }) });
    kvMock.isKVAvailable.mockResolvedValue(true);
    kvMock.getAllStudiesChecked.mockResolvedValue({ status: 'ok', items: [study] });

    const response = await GET(new Request('http://localhost/api/studies?view=summary'));

    expect(response.status).toBe(200);
    const body = await response.json() as { studies: Array<Record<string, unknown>> };
    expect(body).toEqual({ studies: [JSON.parse(JSON.stringify(toStudyListItem(study)))] });
    expect(body.studies[0]).toMatchObject({ coreQuestionCount: 2 });
    expect(body.studies[0]).not.toHaveProperty('config.coreQuestions');
    expect(kvMock.getAllStudiesChecked).toHaveBeenCalledWith(kvClient, 1_000);
  });

  it.each(['view=compact', 'view=', 'view=full&view=summary'])('ST-08: %s is a 400 before any storage read', async (query) => {
    const response = await GET(new Request(`http://localhost/api/studies?${query}`));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'view must be summary or full.' });
    expect(kvMock.isKVAvailable).not.toHaveBeenCalled();
    expect(kvMock.getAllStudiesChecked).not.toHaveBeenCalled();
  });
});
