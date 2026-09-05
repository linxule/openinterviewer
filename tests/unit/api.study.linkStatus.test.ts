import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredStudy } from '../fixtures/models';

const contextMock = vi.hoisted(() => ({
  getRequestContext: vi.fn(),
  getAuthorizedResearcherStudyContext: vi.fn(),
  getHostedResearcherIdentity: vi.fn(),
}));
vi.mock('@/lib/researcherContext', () => contextMock);

const kvMock = vi.hoisted(() => ({
  deleteStudy: vi.fn(),
  getStudy: vi.fn(),
  isKVAvailable: vi.fn(),
  replaceStudyConfigAtomic: vi.fn(),
  setStudyLinksEnabled: vi.fn(),
}));
vi.mock('@/lib/kv', () => kvMock);

vi.mock('@/lib/mode', () => ({ isHostedMode: vi.fn().mockReturnValue(false) }));

import { PUT } from '@/app/api/studies/[id]/route';

const request = (body: unknown) => new Request('http://localhost/api/studies/study-links', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  const access = { authorized: true, context: { kvClient: {} } };
  contextMock.getRequestContext.mockResolvedValue(access);
  contextMock.getAuthorizedResearcherStudyContext.mockResolvedValue(access);
  kvMock.isKVAvailable.mockResolvedValue(true);
});

describe('study participant-link status updates', () => {
  it.each([0, 4])('revokes links independently when interviewCount is %s', async (interviewCount) => {
    const existing = makeStoredStudy({ id: 'study-links', interviewCount });
    const updated = {
      ...existing,
      config: { ...existing.config, linksEnabled: false },
    };
    kvMock.getStudy.mockResolvedValue(existing);
    kvMock.setStudyLinksEnabled.mockResolvedValue({ status: 'updated', study: updated });

    const response = await PUT(request({ linksEnabled: false }), {
      params: Promise.resolve({ id: 'study-links' }),
    });

    expect(response.status).toBe(200);
    expect(kvMock.setStudyLinksEnabled).toHaveBeenCalledWith('study-links', false, {});
    expect(kvMock.replaceStudyConfigAtomic).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({
      study: { config: { linksEnabled: false } },
    });
  });

  it('maps persist-guard link serialization to 409 STUDY_OPERATION_PENDING', async () => {
    kvMock.getStudy.mockResolvedValue(makeStoredStudy({ id: 'study-links' }));
    kvMock.setStudyLinksEnabled.mockResolvedValue({ status: 'persist-guard' });

    const response = await PUT(request({ linksEnabled: false }), {
      params: Promise.resolve({ id: 'study-links' }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'STUDY_OPERATION_PENDING' });
    expect(kvMock.replaceStudyConfigAtomic).not.toHaveBeenCalled();
  });
});
