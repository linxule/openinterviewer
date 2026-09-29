import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_BY_PROVIDER, isKnownProviderModel } from '@/lib/providerRegistry';
import { validateStudyConfig } from '@/lib/studyConfigValidation';
import { makeStudyConfig } from '../fixtures/models';

describe('current model defaults preserve existing study processor choices', () => {
  it('starts newly selected providers on balanced, explicitly named models', () => {
    expect(DEFAULT_MODEL_BY_PROVIDER.openai).toBe('gpt-6.1-sol');
    expect(DEFAULT_MODEL_BY_PROVIDER.claude).toBe('claude-sonnet-5-5');
  });

  it.each([
    ['openai', 'gpt-6.1-sol'],
    ['openai', 'gpt-6-sol'],
    ['openai', 'gpt-6-luna'],
    ['openai', 'gpt-5.6-luna'],
    ['openai', 'gpt-5.6-terra'],
    ['openai', 'gpt-5.6-sol'],
    ['claude', 'claude-sonnet-5-5'],
    ['claude', 'claude-sonnet-5'],
    ['claude', 'claude-sonnet-4-5'],
    ['claude', 'claude-opus-5'],
    ['claude', 'claude-opus-4-5'],
    ['claude', 'claude-fable-5'],
    ['claude', 'claude-haiku-4-5'],
  ] as const)('%s %s remains accepted and is never rewritten to a default', (provider, model) => {
    const study = makeStudyConfig({ aiProvider: provider, aiModel: model, aiProviderCommitment: 'fixed' });
    expect(isKnownProviderModel(provider, model)).toBe(true);
    const checked = validateStudyConfig(study);
    expect(checked).toMatchObject({ ok: true, config: { aiProvider: provider, aiModel: model, aiProviderCommitment: 'fixed' } });
    expect(study.aiModel).toBe(model);
  });

  it('does not make the expensive flagship or automatic routing a new default or option', () => {
    expect(isKnownProviderModel('openai', 'gpt-6-astra')).toBe(false);
    expect(isKnownProviderModel('openai', 'gpt-6')).toBe(false);
  });
});
