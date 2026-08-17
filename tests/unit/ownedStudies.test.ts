// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
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

