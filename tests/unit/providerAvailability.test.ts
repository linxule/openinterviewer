import { afterEach, describe, expect, it, vi } from 'vitest';
import { missingProviderCredential } from '@/lib/providerAvailability';
import { makeStudyConfig } from '../fixtures/models';

const context = {
  geminiApiKey: 'gemini-key',
  anthropicApiKey: null,
  openaiApiKey: 'openai-key',
  openrouterApiKey: null,
};

describe('provider credential availability', () => {
  it('matches the canonical study provider to its request-scoped key', () => {
    expect(missingProviderCredential(
      context,
      makeStudyConfig({ aiProvider: 'openai', aiModel: 'gpt-5.6-terra' }),
    )).toBeNull();
    expect(missingProviderCredential(
      context,
      makeStudyConfig({ aiProvider: 'openrouter', aiModel: 'openai/gpt-5.6-terra' }),
    )).toBe('openrouter');
  });
});

describe('provider credential availability on Cloudflare AI Gateway (RT-11)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('decides by the bound provider key, as on direct (the gateway forwards the provider\'s own key)', () => {
    vi.stubEnv('DEPLOYMENT_TARGET', 'cloudflare');
    vi.stubEnv('DEPLOYMENT_MODE', 'standalone');
    vi.stubEnv('AI_TRANSPORT', 'cloudflare-gateway');
    expect(missingProviderCredential(context, makeStudyConfig({ aiProvider: 'openai', aiModel: 'gpt-5.6-terra' }))).toBeNull();
    expect(missingProviderCredential(context, makeStudyConfig({ aiProvider: 'claude', aiModel: 'claude-sonnet-5' }))).toBe('claude');
    expect(missingProviderCredential(
      { ...context, openrouterApiKey: 'openrouter-key' },
      makeStudyConfig({ aiProvider: 'openrouter', aiModel: 'openai/gpt-5.6-terra' }),
    )).toBeNull();
  });
});
