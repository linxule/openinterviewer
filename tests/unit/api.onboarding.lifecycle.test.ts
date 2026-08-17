import { beforeEach, describe, expect, it, vi } from 'vitest';

const cookiesMock = vi.hoisted(() => ({
  get: vi.fn(),
  delete: vi.fn(),
}));
vi.mock('next/headers', () => ({ cookies: vi.fn(async () => cookiesMock) }));

const identityMock = vi.hoisted(() => ({
  getHostedResearcherIdentity: vi.fn(),
  hasRecentResearcherSession: vi.fn(() => true),
}));
vi.mock('@/lib/researcherContext', () => identityMock);

const platformMock = vi.hoisted(() => ({
  consumePlatformRateLimit: vi.fn(),
  getResearcherByIdChecked: vi.fn(),
  updateResearcherCredentialsAtomic: vi.fn(),
}));
vi.mock('@/lib/platformDb', () => platformMock);

const cryptoMock = vi.hoisted(() => ({
  decrypt: vi.fn((value: string) => `plain:${value}`),
  encrypt: vi.fn((value: string) => `encrypted:${value}`),
}));
vi.mock('@/lib/crypto', () => cryptoMock);

const validationMock = vi.hoisted(() => ({
  normalizeCredential: vi.fn((value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null),
  validateRedisCredentials: vi.fn(),
  validateAiCredential: vi.fn(),
}));
vi.mock('@/lib/credentialValidation', () => validationMock);

const kvClientMock = vi.hoisted(() => ({
  evictResearcherClients: vi.fn(),
  storageIdFromRedisUrl: vi.fn(() => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
}));
vi.mock('@/lib/kvClient', () => kvClientMock);

vi.mock('@/lib/mode', () => ({ isHostedMode: () => true }));

import { POST as saveCredentials } from '@/app/api/onboarding/save-credentials/route';
import { POST as completeOnboarding } from '@/app/api/onboarding/complete/route';
import { POST as validateAiKey } from '@/app/api/onboarding/validate-ai-key/route';
import { DELETE as clearCredentials } from '@/app/api/account/credentials/route';

const account = (overrides: Record<string, unknown> = {}) => ({
  id: 'researcher-a',
  email: 'researcher@example.com',
  name: 'Researcher',
  avatarUrl: null,
  oauthProvider: 'google' as const,
  oauthId: 'oauth-a',
  createdAt: 1,
  lastLoginAt: 1,
  onboardingComplete: false,
  encryptedRedisUrl: 'redis-url',
  encryptedRedisToken: 'redis-token',
  encryptedGeminiApiKey: 'gemini-key',
  encryptedAnthropicApiKey: null,
  encryptedOpenAiApiKey: null,
  encryptedOpenRouterApiKey: null,
  redisConfiguredAt: 1,
  credentialRevision: 4,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  cookiesMock.get.mockReturnValue(undefined);
  identityMock.hasRecentResearcherSession.mockReturnValue(true);
  identityMock.getHostedResearcherIdentity.mockResolvedValue({
    authorized: true,
    researcherId: 'researcher-a',
    issuedAt: Math.floor(Date.now() / 1000),
  });
  platformMock.getResearcherByIdChecked.mockResolvedValue({ status: 'found', researcher: account() });
  platformMock.consumePlatformRateLimit.mockResolvedValue({ status: 'allowed', remaining: 10 });
  platformMock.updateResearcherCredentialsAtomic.mockResolvedValue({
    status: 'updated',
    credentialRevision: 5,
    bindingEpoch: 0,
    storageId: null,
    evict: { disposition: 'none' },
  });
  validationMock.validateRedisCredentials.mockResolvedValue({ valid: true });
  validationMock.validateAiCredential.mockResolvedValue({ valid: true });
});

describe('hosted credential lifecycle routes', () => {
  it.each(['openai', 'openrouter'] as const)('accepts %s key validation without returning the key', async provider => {
    const request = new Request('http://localhost/api/onboarding/validate-ai-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, apiKey: ' provider-secret ' }),
    });

    const response = await validateAiKey(request);

    expect(response.status).toBe(200);
    expect(validationMock.validateAiCredential).toHaveBeenCalledWith(provider, 'provider-secret');
    expect(await response.json()).toEqual({ valid: true });
  });

  it('re-reads, decrypts and validates persisted credentials before completion', async () => {
    cookiesMock.get.mockReturnValue({ value: '/setup' });
    const response = await completeOnboarding();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, redirectPath: '/setup' });
    expect(cookiesMock.delete).toHaveBeenCalledWith('post_onboarding_return_to');
    expect(cryptoMock.decrypt).toHaveBeenCalledWith('redis-url', {
      researcherId: 'researcher-a',
      purpose: 'redis-url',
    });
    expect(cryptoMock.decrypt).toHaveBeenCalledWith('redis-token', {
      researcherId: 'researcher-a',
      purpose: 'redis-token',
    });
    expect(cryptoMock.decrypt).toHaveBeenCalledWith('gemini-key', {
      researcherId: 'researcher-a',
      purpose: 'gemini-api-key',
    });
    expect(validationMock.validateRedisCredentials).toHaveBeenCalledWith('plain:redis-url', 'plain:redis-token');
    expect(validationMock.validateAiCredential).toHaveBeenCalledWith('gemini', 'plain:gemini-key');
    expect(platformMock.updateResearcherCredentialsAtomic).toHaveBeenCalledWith(
      'researcher-a',
      4,
      { onboardingComplete: true }
    );
  });

  it('does not complete onboarding when stored storage cannot be verified', async () => {
    validationMock.validateRedisCredentials.mockResolvedValue({ valid: false, reason: 'unavailable' });
    const response = await completeOnboarding();

    expect(response.status).toBe(503);
    expect(platformMock.updateResearcherCredentialsAtomic).not.toHaveBeenCalled();
  });

  it('validates replacements server-side before encrypting and saving them', async () => {
    const request = new Request('http://localhost/api/onboarding/save-credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ geminiApiKey: ' new-key ' }),
    });
    const response = await saveCredentials(request);

    expect(response.status).toBe(200);
    expect(validationMock.validateAiCredential).toHaveBeenCalledWith('gemini', 'new-key');
    expect(platformMock.updateResearcherCredentialsAtomic).toHaveBeenCalledWith(
      'researcher-a',
      4,
      expect.objectContaining({ encryptedGeminiApiKey: 'encrypted:new-key' })
    );
    expect(JSON.stringify(await response.json())).not.toContain('new-key');
  });

  it('validates and stores an OpenRouter replacement with field-bound encryption', async () => {
    const request = new Request('http://localhost/api/onboarding/save-credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ openRouterApiKey: ' openrouter-key ' }),
    });
    const response = await saveCredentials(request);

    expect(response.status).toBe(200);
    expect(validationMock.validateAiCredential).toHaveBeenCalledWith('openrouter', 'openrouter-key');
    expect(cryptoMock.encrypt).toHaveBeenCalledWith('openrouter-key', {
      researcherId: 'researcher-a',
      purpose: 'openrouter-api-key',
    });
    expect(platformMock.updateResearcherCredentialsAtomic).toHaveBeenCalledWith(
      'researcher-a',
      4,
      expect.objectContaining({ encryptedOpenRouterApiKey: 'encrypted:openrouter-key' })
    );
    expect(JSON.stringify(await response.json())).not.toContain('openrouter-key');
  });

  it('can complete onboarding with only an OpenAI AI credential', async () => {
    platformMock.getResearcherByIdChecked.mockResolvedValue({
      status: 'found',
      researcher: account({
        encryptedGeminiApiKey: null,
        encryptedOpenAiApiKey: 'openai-key',
      }),
    });

    const response = await completeOnboarding();

    expect(response.status).toBe(200);
    expect(cryptoMock.decrypt).toHaveBeenCalledWith('openai-key', {
      researcherId: 'researcher-a',
      purpose: 'openai-api-key',
    });
    expect(validationMock.validateAiCredential).toHaveBeenCalledWith('openai', 'plain:openai-key');
  });

  it('allows an intentional null clear and resets onboarding when it removes the last AI key', async () => {
    const request = new Request('http://localhost/api/onboarding/save-credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ geminiApiKey: null }),
    });
    const response = await saveCredentials(request);

    expect(response.status).toBe(200);
    expect(validationMock.validateAiCredential).not.toHaveBeenCalled();
    expect(platformMock.updateResearcherCredentialsAtomic).toHaveBeenCalledWith(
      'researcher-a',
      4,
      expect.objectContaining({ encryptedGeminiApiKey: null, onboardingComplete: false })
    );
  });

  it('clears Redis as one unit, resets onboarding and evicts the old cached client', async () => {
    const request = new Request('http://localhost/api/account/credentials', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'redis' }),
    });
    const response = await clearCredentials(request);

    expect(response.status).toBe(200);
    expect(platformMock.updateResearcherCredentialsAtomic).toHaveBeenCalledWith(
      'researcher-a',
      4,
      expect.objectContaining({
        encryptedRedisUrl: null,
        encryptedRedisToken: null,
        onboardingComplete: false,
      })
    );
    expect(kvClientMock.evictResearcherClients).toHaveBeenCalledWith({ disposition: 'none' });
  });

  it('clears OpenAI without resetting onboarding while OpenRouter remains configured', async () => {
    platformMock.getResearcherByIdChecked.mockResolvedValue({
      status: 'found',
      researcher: account({
        onboardingComplete: true,
        encryptedGeminiApiKey: null,
        encryptedOpenAiApiKey: 'openai-key',
        encryptedOpenRouterApiKey: 'openrouter-key',
      }),
    });
    const request = new Request('http://localhost/api/account/credentials', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'openai' }),
    });

    const response = await clearCredentials(request);

    expect(response.status).toBe(200);
    expect(platformMock.updateResearcherCredentialsAtomic).toHaveBeenCalledWith(
      'researcher-a',
      4,
      { encryptedOpenAiApiKey: null }
    );
    await expect(response.json()).resolves.toMatchObject({
      onboardingComplete: true,
      configured: { openai: false, openrouter: true },
    });
  });

  it('binds Redis saves to storageId and evicts with the CAS disposition', async () => {
    const storageId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    platformMock.updateResearcherCredentialsAtomic.mockResolvedValue({
      status: 'updated',
      credentialRevision: 5,
      bindingEpoch: 0,
      storageId,
      evict: { disposition: 'scoped', researcherId: 'researcher-a', storageId },
    });
    const request = new Request('http://localhost/api/onboarding/save-credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redisUrl: 'https://owner.upstash.io',
        redisToken: 'rotated-token',
      }),
    });
    const response = await saveCredentials(request);

    expect(response.status).toBe(200);
    expect(kvClientMock.storageIdFromRedisUrl).toHaveBeenCalledWith('https://owner.upstash.io');
    expect(platformMock.updateResearcherCredentialsAtomic).toHaveBeenCalledWith(
      'researcher-a',
      4,
      expect.objectContaining({
        encryptedRedisUrl: 'encrypted:https://owner.upstash.io',
        encryptedRedisToken: 'encrypted:rotated-token',
      }),
      { storageId },
    );
    expect(kvClientMock.evictResearcherClients).toHaveBeenCalledWith({
      disposition: 'scoped',
      researcherId: 'researcher-a',
      storageId,
    });
  });

  it('returns 409 when Redis clear is refused because studies or live ops exist', async () => {
    platformMock.updateResearcherCredentialsAtomic.mockResolvedValue({ status: 'refused' });
    const request = new Request('http://localhost/api/account/credentials', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'redis' }),
    });
    const response = await clearCredentials(request);
    expect(response.status).toBe(409);
    expect(kvClientMock.evictResearcherClients).not.toHaveBeenCalled();
  });
});
