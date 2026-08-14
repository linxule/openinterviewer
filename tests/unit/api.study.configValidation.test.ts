import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STUDY_MUTATION_MAX_BYTES } from '@/lib/studyConfigValidation';
import { makeStoredStudy, makeStudyConfig } from '../fixtures/models';

const contextMock = vi.hoisted(() => ({ getRequestContext: vi.fn() }));
vi.mock('@/lib/researcherContext', () => contextMock);

const kvMock = vi.hoisted(() => ({
  createStudyAtomic: vi.fn(),
  deleteStudy: vi.fn(),
  getAllStudies: vi.fn(),
  getStudy: vi.fn(),
  isKVAvailable: vi.fn(),
  replaceStudyConfigAtomic: vi.fn(),
  setStudyLinksEnabled: vi.fn(),
}));
vi.mock('@/lib/kv', () => kvMock);

vi.mock('@/lib/platformDb', () => ({
  consumePlatformRateLimit: vi.fn(),
  deleteStudyOwnership: vi.fn(),
  registerStudyOwnership: vi.fn(),
}));
vi.mock('@/lib/mode', () => ({ isHostedMode: vi.fn().mockReturnValue(false) }));

import { POST } from '@/app/api/studies/route';
import { PUT } from '@/app/api/studies/[id]/route';

const request = (url: string, method: 'POST' | 'PUT', body: unknown) => new Request(url, {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  contextMock.getRequestContext.mockResolvedValue({
    authorized: true,
    context: { kvClient: {} },
    researcherId: 'researcher-a',
  });
  kvMock.isKVAvailable.mockResolvedValue(true);
  kvMock.createStudyAtomic.mockResolvedValue('created');
});

describe('study route configuration validation', () => {
  it('rejects unknown create fields before any persistence write', async () => {
    const response = await POST(request(
      'http://localhost/api/studies',
      'POST',
      { config: { ...makeStudyConfig(), injected: true } }
    ));

    expect(response.status).toBe(400);
    expect(kvMock.createStudyAtomic).not.toHaveBeenCalled();
  });

  it('returns 413 for an oversized declared study body', async () => {
    const oversized = new Request('http://localhost/api/studies', {
      method: 'POST',
      headers: { 'Content-Length': String(STUDY_MUTATION_MAX_BYTES + 1) },
      body: '{}',
    });

    const response = await POST(oversized);

    expect(response.status).toBe(413);
    expect(kvMock.isKVAvailable).not.toHaveBeenCalled();
  });

  it('merges and validates a partial update before the atomic write', async () => {
    const config = makeStudyConfig({ id: 'study-validation', createdAt: 123 });
    const study = makeStoredStudy({
      id: 'study-validation',
      config,
      createdAt: 123,
      revision: 7,
    });
    const updatedStudy = { ...study, config: { ...config, name: 'Updated' }, revision: 8 };
    kvMock.getStudy.mockResolvedValue(study);
    kvMock.replaceStudyConfigAtomic.mockResolvedValue({ status: 'updated', study: updatedStudy });

    const response = await PUT(request(
      'http://localhost/api/studies/study-validation',
      'PUT',
      { config: { name: 'Updated' } }
    ), { params: Promise.resolve({ id: 'study-validation' }) });

    expect(response.status).toBe(200);
    expect(kvMock.replaceStudyConfigAtomic).toHaveBeenCalledWith(
      'study-validation',
      7,
      expect.objectContaining({ id: 'study-validation', createdAt: 123, name: 'Updated' }),
      {}
    );
  });

  it('rejects attempts to change the server-owned study ID', async () => {
    const config = makeStudyConfig({ id: 'study-validation', createdAt: 123 });
    kvMock.getStudy.mockResolvedValue(makeStoredStudy({
      id: 'study-validation',
      config,
      createdAt: 123,
    }));

    const response = await PUT(request(
      'http://localhost/api/studies/study-validation',
      'PUT',
      { config: { id: 'other-study' } }
    ), { params: Promise.resolve({ id: 'study-validation' }) });

    expect(response.status).toBe(400);
    expect(kvMock.replaceStudyConfigAtomic).not.toHaveBeenCalled();
  });
});
