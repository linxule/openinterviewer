// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RedisPort } from '@/lib/redisPort';
import { makeStoredInterview, makeStoredStudy } from '../fixtures/models';

const platformClient = {
  scard: vi.fn(),
  smembers: vi.fn(),
};

vi.mock('@/lib/kvClient', () => ({
  getPlatformClient: () => platformClient,
}));

const authorityMock = vi.hoisted(() => ({ getStudyAuthorityChecked: vi.fn() }));
vi.mock('@/lib/platformDb', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    getStudyAuthorityChecked: authorityMock.getStudyAuthorityChecked,
  };
});


const kvMock = vi.hoisted(() => ({
  getStudyChecked: vi.fn(),
  getStudyInterviewsChecked: vi.fn(),
}));
vi.mock('@/lib/kv', () => kvMock);

import { inspectOwnedStudyGates, loadOwnedInterviews, loadOwnedStudies } from '@/lib/ownedStudies';

const RESEARCHER = 'researcher-a';
const STUDY_A = '11111111-1111-4111-8111-111111111111';
const STUDY_B = '22222222-2222-4222-8222-222222222222';
const STUDY_C = '33333333-3333-4333-8333-333333333333';
const STUDY_PENDING = '44444444-4444-4444-8444-444444444444';
const kvClient = { marker: 'byos' } as never;

describe('bounded owned-study loading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platformClient.scard.mockResolvedValue(2);
    platformClient.smembers.mockResolvedValue([STUDY_A, STUDY_B]);
  });

  it('returns live stubs without reading BYOS and skips cross-tagged deny ids', async () => {
    authorityMock.getStudyAuthorityChecked.mockImplementation(async ({ studyId }: { studyId: string }) => {
      if (studyId === STUDY_A) return { status: 'live', phase: 'pending' };
      return { status: 'deny' };
    });

    const loaded = await loadOwnedStudies(RESEARCHER, kvClient);
    expect(loaded).toEqual({
      status: 'ok',
      items: [{
        id: STUDY_A,
        reconciliationPending: true,
        operationId: STUDY_A,
        phase: 'pending',
      }],
      pendingStudies: [{
        id: STUDY_A,
        reconciliationPending: true,
        operationId: STUDY_A,
        phase: 'pending',
      }],
    });
    expect(kvMock.getStudyChecked).not.toHaveBeenCalled();
  });

  it('unions interviews only from allowed studies', async () => {
    const own = makeStoredInterview({ id: 'int-b', studyId: STUDY_B });
    authorityMock.getStudyAuthorityChecked.mockImplementation(async ({ studyId }: { studyId: string }) => {
      if (studyId === STUDY_A) return { status: 'deny' };
      return { status: 'allow', owner: { researcherId: RESEARCHER } };
    });
    kvMock.getStudyInterviewsChecked.mockImplementation(async (studyId: string) => {
      if (studyId === STUDY_B) return { status: 'ok', items: [own] };
      return { status: 'ok', items: [makeStoredInterview({ id: 'leaked', studyId })] };
    });

    const loaded = await loadOwnedInterviews(RESEARCHER, kvClient);
    expect(loaded.status).toBe('ok');
    if (loaded.status === 'ok') {
      expect(loaded.items).toEqual([own]);
      expect(loaded.pendingStudies).toEqual([]);
    }
    expect(kvMock.getStudyInterviewsChecked).toHaveBeenCalledTimes(1);
    expect(kvMock.getStudyInterviewsChecked).toHaveBeenCalledWith(STUDY_B, kvClient, 1_000);
  });

  it.each([500, 1_000])('enforces the aggregate cap of %i before reading the overflowing study', async (maximum) => {
    const firstCount = maximum / 2;
    const secondCount = maximum - firstCount + 1;
    const first = Array.from({ length: firstCount }, (_, index) => (
      makeStoredInterview({ id: `first-${index}`, studyId: STUDY_A })
    ));
    const records = new Map(first.map(interview => [`interview:${interview.id}`, interview]));
    platformClient.scard.mockResolvedValue(3);
    platformClient.smembers.mockResolvedValue([STUDY_A, STUDY_B, STUDY_C]);
    authorityMock.getStudyAuthorityChecked.mockResolvedValue({ status: 'allow' });
    const client = {
      scard: vi.fn().mockImplementation(async (key: string) => {
        // Every study must pass authority inspection before any BYOS read.
        expect(authorityMock.getStudyAuthorityChecked).toHaveBeenCalledTimes(3);
        return key === `study-interviews:${STUDY_A}` ? firstCount : secondCount;
      }),
      smembers: vi.fn().mockResolvedValue(first.map(interview => interview.id)),
      get: vi.fn().mockImplementation(async (key: string) => records.get(key) ?? null),
    } as unknown as RedisPort;
    const actualKv = await vi.importActual<typeof import('@/lib/kv')>('@/lib/kv');
    kvMock.getStudyInterviewsChecked.mockImplementation(actualKv.getStudyInterviewsChecked);

    await expect(loadOwnedInterviews(RESEARCHER, client, maximum)).resolves.toEqual({
      status: 'too-large', count: maximum + 1, maximum,
    });
    expect(kvMock.getStudyInterviewsChecked).toHaveBeenNthCalledWith(2, STUDY_B, client, maximum - firstCount);
    expect(client.scard).toHaveBeenCalledTimes(2);
    expect(client.scard).toHaveBeenNthCalledWith(2, `study-interviews:${STUDY_B}`);
    expect(client.smembers).toHaveBeenCalledExactlyOnceWith(`study-interviews:${STUDY_A}`);
    expect(client.get).toHaveBeenCalledTimes(firstCount);
    expect(kvMock.getStudyInterviewsChecked).not.toHaveBeenCalledWith(STUDY_C, client, expect.anything());
  });

  it('rejects aggregate overflow when an index grows between SCARD and SMEMBERS', async () => {
    const first = makeStoredInterview({ id: 'first', studyId: STUDY_A });
    platformClient.scard.mockResolvedValue(3);
    platformClient.smembers.mockResolvedValue([STUDY_A, STUDY_B, STUDY_C]);
    authorityMock.getStudyAuthorityChecked.mockResolvedValue({ status: 'allow' });
    const client = {
      scard: vi.fn().mockResolvedValue(1),
      smembers: vi.fn()
        .mockResolvedValueOnce(['first'])
        .mockResolvedValueOnce(['second', 'concurrent-insert']),
      get: vi.fn().mockResolvedValue(first),
    } as unknown as RedisPort;
    const actualKv = await vi.importActual<typeof import('@/lib/kv')>('@/lib/kv');
    kvMock.getStudyInterviewsChecked.mockImplementation(actualKv.getStudyInterviewsChecked);

    await expect(loadOwnedInterviews(RESEARCHER, client, 2)).resolves.toEqual({
      status: 'too-large', count: 3, maximum: 2,
    });
    expect(kvMock.getStudyInterviewsChecked).toHaveBeenNthCalledWith(2, STUDY_B, client, 1);
    expect(client.scard).toHaveBeenCalledTimes(2);
    expect(client.smembers).toHaveBeenCalledTimes(2);
    expect(client.smembers).toHaveBeenNthCalledWith(2, `study-interviews:${STUDY_B}`);
    expect(client.get).toHaveBeenCalledExactlyOnceWith('interview:first');
    expect(kvMock.getStudyInterviewsChecked).not.toHaveBeenCalledWith(STUDY_C, client, expect.anything());
  });

  it.each([0, 1])('checks a trailing study with %i interviews after reaching the exact cap', async (trailingCount) => {
    const older = makeStoredInterview({ id: 'older', studyId: STUDY_A, createdAt: 1 });
    const newer = makeStoredInterview({ id: 'newer', studyId: STUDY_B, createdAt: 2 });
    const records = new Map([older, newer].map(interview => [`interview:${interview.id}`, interview]));
    platformClient.scard.mockResolvedValue(4);
    platformClient.smembers.mockResolvedValue([STUDY_A, STUDY_B, STUDY_C, STUDY_PENDING]);
    authorityMock.getStudyAuthorityChecked.mockImplementation(async ({ studyId }: { studyId: string }) => (
      studyId === STUDY_PENDING ? { status: 'live', phase: 'pending' } : { status: 'allow' }
    ));
    const client = {
      scard: vi.fn().mockImplementation(async (key: string) => (
        key === `study-interviews:${STUDY_C}` ? trailingCount : 1
      )),
      smembers: vi.fn().mockImplementation(async (key: string) => {
        if (key === `study-interviews:${STUDY_A}`) return ['older'];
        if (key === `study-interviews:${STUDY_B}`) return ['newer'];
        return [];
      }),
      get: vi.fn().mockImplementation(async (key: string) => records.get(key) ?? null),
    } as unknown as RedisPort;
    const actualKv = await vi.importActual<typeof import('@/lib/kv')>('@/lib/kv');
    kvMock.getStudyInterviewsChecked.mockImplementation(actualKv.getStudyInterviewsChecked);

    const loaded = await loadOwnedInterviews(RESEARCHER, client, 2);
    if (trailingCount === 0) {
      expect(loaded).toEqual({
        status: 'ok',
        items: [newer, older],
        pendingStudies: [{
          id: STUDY_PENDING,
          reconciliationPending: true,
          operationId: STUDY_PENDING,
          phase: 'pending',
        }],
      });
      expect(client.smembers).toHaveBeenCalledWith(`study-interviews:${STUDY_C}`);
    } else {
      expect(loaded).toEqual({ status: 'too-large', count: 3, maximum: 2 });
      expect(client.smembers).not.toHaveBeenCalledWith(`study-interviews:${STUDY_C}`);
    }
    expect(kvMock.getStudyInterviewsChecked).toHaveBeenNthCalledWith(3, STUDY_C, client, 0);
    expect(client.scard).toHaveBeenCalledTimes(3);
    expect(client.get).toHaveBeenCalledTimes(2);
  });

  it('fails closed on adel without returning peer studies', async () => {
    authorityMock.getStudyAuthorityChecked.mockResolvedValue({ status: 'adel' });
    const loaded = await loadOwnedStudies(RESEARCHER, kvClient);
    expect(loaded.status).toBe('blocked');
    if (loaded.status === 'blocked') {
      expect(loaded.presented.statusCode).toBe(503);
      expect(loaded.presented.error).not.toMatch(/delet|journal/i);
    }
    expect(kvMock.getStudyChecked).not.toHaveBeenCalled();
  });

  it('loads allowed studies from BYOS after authority allow', async () => {
    const study = makeStoredStudy({ id: STUDY_B });
    authorityMock.getStudyAuthorityChecked.mockImplementation(async ({ studyId }: { studyId: string }) => (
      studyId === STUDY_B
        ? { status: 'allow', owner: { researcherId: RESEARCHER } }
        : { status: 'notfound' }
    ));
    kvMock.getStudyChecked.mockResolvedValue({ status: 'found', study });
    const loaded = await loadOwnedStudies(RESEARCHER, kvClient);
    expect(loaded).toMatchObject({ status: 'ok', items: [study], pendingStudies: [] });
  });

  it('inspects authority without a BYOS client', async () => {
    authorityMock.getStudyAuthorityChecked.mockImplementation(async ({ studyId }: { studyId: string }) => (
      studyId === STUDY_A
        ? { status: 'live', phase: 'reserving' }
        : { status: 'allow', owner: { researcherId: RESEARCHER } }
    ));
    const inspected = await inspectOwnedStudyGates(RESEARCHER);
    expect(inspected).toEqual({
      status: 'ok',
      allowedIds: [STUDY_B],
      pendingStudies: [{
        id: STUDY_A,
        reconciliationPending: true,
        operationId: STUDY_A,
        phase: 'reserving',
      }],
    });
    expect(kvMock.getStudyChecked).not.toHaveBeenCalled();
  });
});
