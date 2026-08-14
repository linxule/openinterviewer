import { beforeEach, describe, expect, it, vi } from 'vitest';

const cookiesMock = vi.hoisted(() => ({ cookies: vi.fn() }));
vi.mock('next/headers', () => cookiesMock);

const authMock = vi.hoisted(() => ({
  verifySessionToken: vi.fn(),
  verifyParticipantToken: vi.fn(),
  SESSION_COOKIE_NAME: 'researcher-session',
}));
vi.mock('@/lib/auth', () => authMock);

const platformMock = vi.hoisted(() => ({
  getResearcherByIdChecked: vi.fn(),
  getStudyOwnerChecked: vi.fn(),
}));
vi.mock('@/lib/platformDb', () => platformMock);

vi.mock('@/lib/mode', () => ({
  isHostedMode: () => true,
  isStandaloneMode: () => false,
}));
vi.mock('@/lib/kvClient', () => ({ getKVClient: vi.fn(), getResearcherClient: vi.fn() }));
vi.mock('@/lib/crypto', () => ({ decrypt: vi.fn() }));
vi.mock('@/lib/kv', () => ({ getStudy: vi.fn() }));
vi.mock('@/lib/participantLinks', () => ({ getParticipantLinkById: vi.fn() }));

import { getHostedResearcherIdentity, getRequestContext } from '@/lib/researcherContext';

beforeEach(() => {
  vi.clearAllMocks();
  cookiesMock.cookies.mockResolvedValue({
    get: vi.fn().mockReturnValue({ value: 'signed-session' }),
  });
  authMock.verifySessionToken.mockResolvedValue({ valid: true, researcherId: 'researcher-a' });
  platformMock.getResearcherByIdChecked.mockResolvedValue({
    status: 'found',
    researcher: {
      id: 'researcher-a',
      onboardingComplete: false,
      encryptedRedisUrl: null,
      encryptedRedisToken: null,
      encryptedGeminiApiKey: null,
      encryptedAnthropicApiKey: null,
    },
  });
});

describe('hosted setup authentication boundary', () => {
  it('authenticates onboarding identity without resolving researcher storage', async () => {
    const result = await getHostedResearcherIdentity();

    expect(result).toEqual({
      authorized: true,
      researcherId: 'researcher-a',
      issuedAt: undefined,
    });
    expect(platformMock.getResearcherByIdChecked).not.toHaveBeenCalled();
  });

  it('keeps normal request context fail-closed until onboarding has usable storage', async () => {
    const result = await getRequestContext();

    expect(result).toMatchObject({
      authorized: true,
      context: null,
      researcherId: 'researcher-a',
      setupRequired: true,
      missing: ['onboarding', 'redis_url', 'redis_token'],
    });
  });

  it('keeps a valid session authenticated while reporting platform storage outage as retryable', async () => {
    platformMock.getResearcherByIdChecked.mockResolvedValue({ status: 'unavailable' });

    const result = await getRequestContext();

    expect(result).toMatchObject({
      authorized: true,
      context: null,
      researcherId: 'researcher-a',
      statusCode: 503,
      retryable: true,
    });
  });
});
