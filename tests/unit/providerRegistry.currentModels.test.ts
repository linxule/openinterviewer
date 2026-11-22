import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_BY_PROVIDER, isKnownProviderModel } from '@/lib/providerRegistry';
import { validateStudyConfig } from '@/lib/studyConfigValidation';
import { makeStudyConfig } from '../fixtures/models';

describe('current model defaults and retired catalog enforcement', () => {
  it('starts newly selected providers on balanced, explicitly named active models', () => {
    expect(DEFAULT_MODEL_BY_PROVIDER.gemini).toBe('gemini-3.8-flash');
    expect(DEFAULT_MODEL_BY_PROVIDER.claude).toBe('claude-sonnet-5-5');
    expect(DEFAULT_MODEL_BY_PROVIDER.openai).toBe('gpt-6.1-sol');
    expect(DEFAULT_MODEL_BY_PROVIDER.openrouter).toBe('openai/gpt-6.1-sol');
  });

  it.each([
    ['gemini', 'gemini-3.8-flash'],
    ['gemini', 'gemini-4-hydrogen'],
    ['gemini', 'gemini-4-neon'],
    ['gemini', 'gemini-4-carbon'],
    ['gemini', 'gemini-4-argon'],
    ['openai', 'gpt-6.2-sol'],
    ['openai', 'gpt-6.1-sol'],
    ['openai', 'gpt-6-sol'],
    ['openai', 'gpt-6-luna'],
    ['claude', 'claude-sonnet-5-5'],
    ['claude', 'claude-sonnet-5'],
    ['claude', 'claude-opus-5'],
    ['claude', 'claude-fable-5'],
    ['claude', 'claude-haiku-4-5'],
    ['openrouter', 'openai/gpt-6.2-sol'],
    ['openrouter', 'openai/gpt-6.1-sol'],
    ['openrouter', 'google/gemini-3.8-flash'],
  ] as const)('%s %s is accepted and is never rewritten to a default', (provider, model) => {
    const study = makeStudyConfig({ aiProvider: provider, aiModel: model, aiProviderCommitment: 'fixed' });
    expect(isKnownProviderModel(provider, model)).toBe(true);
    const checked = validateStudyConfig(study);
    expect(checked).toMatchObject({ ok: true, config: { aiProvider: provider, aiModel: model, aiProviderCommitment: 'fixed' } });
    expect(study.aiModel).toBe(model);
  });

  it.each([
    ['gemini', 'gemini-3.7-flash'],
    ['gemini', 'gemini-2.5-flash'],
    ['gemini', 'gemini-2.5-pro'],
    ['gemini', 'gemini-3.1-pro-preview'],
    ['claude', 'claude-sonnet-4-5'],
    ['claude', 'claude-opus-4-5'],
    ['openai', 'gpt-5.6-luna'],
    ['openai', 'gpt-5.6-terra'],
    ['openai', 'gpt-5.6-sol'],
  ] as const)('retires %s %s from active study validation', (provider, model) => {
    const study = makeStudyConfig({ aiProvider: provider, aiModel: model });
    expect(isKnownProviderModel(provider, model)).toBe(false);
    expect(validateStudyConfig(study)).toMatchObject({
      ok: false,
      error: 'AI model is not compatible with the selected provider',
    });
  });

  it('does not make the expensive flagship or automatic routing a new default or option', () => {
    expect(isKnownProviderModel('openai', 'gpt-6-astra')).toBe(false);
    expect(isKnownProviderModel('openai', 'gpt-6.2-astra')).toBe(false);
    expect(isKnownProviderModel('openai', 'gpt-6')).toBe(false);
  });
});
