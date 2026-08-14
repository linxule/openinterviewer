import { beforeEach, describe, expect, it, vi } from 'vitest';

const contextMock = vi.hoisted(() => ({ getRequestContext: vi.fn() }));
vi.mock('@/lib/researcherContext', () => contextMock);

const kvMock = vi.hoisted(() => ({
  createStudyAtomic: vi.fn(),
  getAllStudies: vi.fn(),
  isKVAvailable: vi.fn(),
}));
vi.mock('@/lib/kv', () => kvMock);

vi.mock('@/lib/platformDb', () => ({
  deleteStudyOwnership: vi.fn(),
  registerStudyOwnership: vi.fn(),
}));
vi.mock('@/lib/mode', () => ({ isHostedMode: vi.fn().mockReturnValue(true) }));

import { GET } from '@/app/api/studies/route';

beforeEach(() => {
  vi.clearAllMocks();
  contextMock.getRequestContext.mockResolvedValue({
    authorized: true,
    context: null,
    researcherId: 'researcher-a',
    error: 'Researcher onboarding is incomplete',
    setupRequired: true,
    missing: ['onboarding', 'redis_url', 'redis_token'],
  });
});

describe('researcher API setup boundary', () => {
  it('returns 428 before touching researcher storage', async () => {
    const response = await GET();

    expect(response.status).toBe(428);
    await expect(response.json()).resolves.toEqual({
      error: 'Researcher onboarding is incomplete',
      code: 'CONFIGURATION_REQUIRED',
      missing: ['onboarding', 'redis_url', 'redis_token'],
    });
    expect(kvMock.isKVAvailable).not.toHaveBeenCalled();
    expect(kvMock.getAllStudies).not.toHaveBeenCalled();
  });
});
