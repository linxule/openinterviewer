// @vitest-environment node
//
// Standalone researcher interview reads go through the workspace store
// (RT-09): the Redis store on the Node target (same kv.ts reads and
// 413/503/404 mappings as before) and the Durable Object store on the
// Cloudflare target, whose client assembles keyset pages. Hosted reads keep
// their owned-study/BYOS path (hosted.sharedByos.adversarial.test.ts).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredInterview } from '@/types';
import { makeStoredInterview } from '../fixtures/models';
import { standaloneTestContext } from '../helpers/workspaceStoreFixture';
import type { RedisPort } from '@/lib/redisPort';

const contextMock = vi.hoisted(() => ({
  getRequestContext: vi.fn(),
  getAuthorizedResearcherStudyContext: vi.fn(),
  getHostedResearcherIdentity: vi.fn(),
}));
vi.mock('@/lib/researcherContext', () => contextMock);

const kvMock = vi.hoisted(() => ({
  getAllInterviewsChecked: vi.fn(),
  getStudyInterviewsChecked: vi.fn(),
  getInterviewChecked: vi.fn(),
}));
vi.mock('@/lib/kv', () => kvMock);

import { GET as listGET } from '@/app/api/interviews/route';
import { GET as detailGET } from '@/app/api/interviews/[id]/route';
import { createDurableWorkspaceStore } from '@/lib/storage/durableObject';

type RpcCall = { method: string; input: Record<string, unknown> };
let rpcCalls: RpcCall[] = [];
let handlers: Record<string, (input: Record<string, unknown>) => unknown> = {};

const workspaceStub = new Proxy({}, {
  get(_target, property) {
    if (typeof property !== 'string' || property === 'then') return undefined;
    return async (input: Record<string, unknown>) => {
      rpcCalls.push({ method: property, input });
      const handler = handlers[property];
      if (!handler) throw new Error(`unscripted RPC ${property}`);
      return handler(input);
    };
  },
});

const redisClient = { marker: 'deployment-redis' } as unknown as RedisPort;

function useContext(context: ReturnType<typeof standaloneTestContext>) {
  const access = { authorized: true, context };
  contextMock.getRequestContext.mockResolvedValue(access);
  contextMock.getAuthorizedResearcherStudyContext.mockResolvedValue(access);
}

function nodeContext() {
  return standaloneTestContext(redisClient);
}

function cloudflareContext() {
  return standaloneTestContext({} as RedisPort, {
    store: createDurableWorkspaceStore({
      namespace: { getByName: () => workspaceStub },
      workspaceId: 'ws_0123456789abcdef0123456789abcdef',
      jurisdiction: '',
      rateLimitSalt: 'synthetic-rate-limit-salt-0123456789abcdef',
    }),
  });
}

const interviews: StoredInterview[] = [
  makeStoredInterview({ id: 'session-b', studyId: 'study-a', createdAt: 2_000 }),
  makeStoredInterview({ id: 'session-a', studyId: 'study-a', createdAt: 1_000 }),
];

const detail = (id: string, studyId?: string) => detailGET(
  new Request(`http://localhost/api/interviews/${id}${studyId ? `?studyId=${studyId}` : ''}`),
  { params: Promise.resolve({ id }) },
);

beforeEach(() => {
  rpcCalls = [];
  handlers = {};
});

describe('Node standalone reads through the Redis workspace store (RT-09)', () => {
  beforeEach(() => useContext(nodeContext()));

  it('RT-09: lists every interview and a study\'s interviews with the same 1,000-record reads as before', async () => {
    kvMock.getAllInterviewsChecked.mockResolvedValue({ status: 'ok', items: interviews });
    kvMock.getStudyInterviewsChecked.mockResolvedValue({ status: 'ok', items: interviews });

    const all = await listGET(new Request('http://localhost/api/interviews'));
    expect(all.status).toBe(200);
    expect(await all.json()).toEqual({ interviews });
    expect(kvMock.getAllInterviewsChecked).toHaveBeenCalledWith(redisClient, 1_000);

    const scoped = await listGET(new Request('http://localhost/api/interviews?studyId=study-a'));
    expect(scoped.status).toBe(200);
    expect(await scoped.json()).toEqual({ interviews });
    expect(kvMock.getStudyInterviewsChecked).toHaveBeenCalledWith('study-a', redisClient, 1_000);
  });

  it.each<[string, unknown, number]>([
    ['too-large', { status: 'too-large', count: 1_001, maximum: 1_000 }, 413],
    ['unavailable', { status: 'unavailable' }, 503],
  ])('RT-09: a %s collection keeps its explicit status', async (_label, loaded, status) => {
    kvMock.getAllInterviewsChecked.mockResolvedValue(loaded);
    expect((await listGET(new Request('http://localhost/api/interviews'))).status).toBe(status);
  });

  it('RT-09: reads one interview, refusing another study\'s record as not found', async () => {
    kvMock.getInterviewChecked.mockResolvedValue({ status: 'found', interview: interviews[0] });

    const found = await detail('session-b', 'study-a');
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual({ interview: interviews[0] });
    expect(kvMock.getInterviewChecked).toHaveBeenCalledWith('session-b', redisClient);

    expect((await detail('session-b', 'study-other')).status).toBe(404);
    kvMock.getInterviewChecked.mockResolvedValue({ status: 'unavailable' });
    expect((await detail('session-b')).status).toBe(503);
  });
});

describe('Cloudflare standalone reads through the durable workspace store (RT-09, ST-08)', () => {
  beforeEach(() => useContext(cloudflareContext()));

  it('RT-09: assembles every interview from keyset pages, bounded at 1,000', async () => {
    handlers.listInterviews = (input) => {
      const page = input.page as { cursor: string | null };
      return page.cursor === null
        ? { status: 'ok', items: [interviews[0]], nextCursor: 'after-b', count: 2 }
        : { status: 'ok', items: [interviews[1]], nextCursor: null, count: 2 };
    };

    const response = await listGET(new Request('http://localhost/api/interviews'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ interviews });
    expect(rpcCalls.map((call) => call.input)).toEqual([
      expect.objectContaining({ scope: 'all', maximum: 1_000, page: expect.objectContaining({ cursor: null }) }),
      expect.objectContaining({ scope: 'all', maximum: 1_000, page: expect.objectContaining({ cursor: 'after-b' }) }),
    ]);
    expect(kvMock.getAllInterviewsChecked).not.toHaveBeenCalled();
  });

  it('RT-09: scopes a study list to that study', async () => {
    handlers.listInterviews = () => ({ status: 'ok', items: interviews, nextCursor: null, count: 2 });

    const response = await listGET(new Request('http://localhost/api/interviews?studyId=study-a'));

    expect(response.status).toBe(200);
    expect(rpcCalls[0].input).toMatchObject({ scope: 'study', studyId: 'study-a', maximum: 1_000 });
  });

  it.each<[string, unknown, number]>([
    ['an over-ceiling collection', { status: 'too-large', count: 1_001, maximum: 1_000 }, 413],
    ['unavailable storage', { status: 'unavailable' }, 503],
    ['a malformed page', { status: 'ok', items: 'not-a-list' }, 503],
  ])('RT-09: %s is never an empty success', async (_label, page, status) => {
    handlers.listInterviews = () => page;

    const response = await listGET(new Request('http://localhost/api/interviews'));

    expect(response.status).toBe(status);
    expect(await response.json()).not.toHaveProperty('interviews');
  });

  it('RT-09: reads one interview through the object and keeps the study match', async () => {
    handlers.getInterview = () => ({ status: 'found', interview: interviews[0] });

    const found = await detail('session-b', 'study-a');
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual({ interview: interviews[0] });
    expect(rpcCalls[0]).toEqual({ method: 'getInterview', input: { interviewId: 'session-b' } });

    expect((await detail('session-b', 'study-other')).status).toBe(404);
    handlers.getInterview = () => ({ status: 'not-found' });
    expect((await detail('session-b')).status).toBe(404);
    handlers.getInterview = () => {
      throw new Error('rpc failed');
    };
    expect((await detail('session-b')).status).toBe(503);
    expect(kvMock.getInterviewChecked).not.toHaveBeenCalled();
  });
});
