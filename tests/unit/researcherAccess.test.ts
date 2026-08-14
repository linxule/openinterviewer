import { beforeEach, describe, expect, it, vi } from 'vitest';

const contextMock = vi.hoisted(() => ({ getRequestContext: vi.fn() }));
vi.mock('@/lib/researcherContext', () => contextMock);

const modeMock = vi.hoisted(() => ({ isHostedMode: vi.fn() }));
vi.mock('@/lib/mode', () => modeMock);

const navigationMock = vi.hoisted(() => ({
  redirect: vi.fn((destination: string) => {
    throw new Error(`NEXT_REDIRECT:${destination}`);
  }),
}));
vi.mock('next/navigation', () => navigationMock);

import {
  configurationRequiredResponse,
  enforceResearcherPageSetup,
} from '@/lib/researcherAccess';

beforeEach(() => {
  vi.clearAllMocks();
  modeMock.isHostedMode.mockReturnValue(true);
});

describe('researcher setup access helpers', () => {
  it('redirects an incomplete hosted account to onboarding', async () => {
    contextMock.getRequestContext.mockResolvedValue({
      authorized: true,
      context: null,
      setupRequired: true,
      missing: ['redis_url', 'redis_token'],
    });

    await expect(enforceResearcherPageSetup()).rejects.toThrow(
      'NEXT_REDIRECT:/onboarding'
    );
  });

  it('redirects a completed hosted account away from onboarding', async () => {
    contextMock.getRequestContext.mockResolvedValue({
      authorized: true,
      context: { kvClient: {} },
    });

    await expect(
      enforceResearcherPageSetup({ onboardingPage: true })
    ).rejects.toThrow('NEXT_REDIRECT:/studies');
  });

  it('allows an incomplete hosted account to finish onboarding', async () => {
    contextMock.getRequestContext.mockResolvedValue({
      authorized: true,
      context: null,
      setupRequired: true,
      missing: ['redis_url', 'redis_token', 'ai_provider'],
    });

    await expect(
      enforceResearcherPageSetup({ onboardingPage: true })
    ).resolves.toBeUndefined();
    expect(navigationMock.redirect).not.toHaveBeenCalled();
  });

  it('does not inspect standalone account setup', async () => {
    modeMock.isHostedMode.mockReturnValue(false);

    await expect(enforceResearcherPageSetup()).resolves.toBeUndefined();
    expect(contextMock.getRequestContext).not.toHaveBeenCalled();
  });

  it('returns a structured 428 response with actionable missing fields', async () => {
    const response = configurationRequiredResponse({
      authorized: true,
      context: null,
      setupRequired: true,
      error: 'Researcher onboarding is incomplete',
      missing: ['onboarding', 'redis_url'],
    });

    expect(response?.status).toBe(428);
    await expect(response?.json()).resolves.toEqual({
      error: 'Researcher onboarding is incomplete',
      code: 'CONFIGURATION_REQUIRED',
      missing: ['onboarding', 'redis_url'],
    });
  });

  it('maps authenticated researcher service outages to a retryable 503', async () => {
    const response = configurationRequiredResponse({
      authorized: true,
      context: null,
      researcherId: 'researcher-a',
      error: 'Researcher account storage is temporarily unavailable',
      statusCode: 503,
      retryable: true,
    });

    expect(response?.status).toBe(503);
    await expect(response?.json()).resolves.toEqual({
      error: 'Researcher account storage is temporarily unavailable',
      retryable: true,
    });
  });
});
