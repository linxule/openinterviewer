// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import { ClaudeProvider, GeminiProvider, OpenAIProvider, OpenRouterProvider, resolveSynthesisModel } from '@/lib/providers';
import { ProviderFailure } from '@/lib/providerErrors';
import {
  type AIProviderType,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPENROUTER_MODEL,
} from '@/types';
import { makeStudyConfig } from '../fixtures/models';

const providerRequest = vi.hoisted(() => vi.fn());

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    interactions = { create: providerRequest };
  },
}));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: providerRequest };
  },
}));
vi.mock('openai', () => ({
  default: class {
    responses = { create: providerRequest };
  },
}));
vi.mock('@openrouter/sdk', () => ({
  OpenRouter: class {
    chat = { send: providerRequest };
  },
}));

/**
 * Synthesis (per-interview synthesis, aggregate synthesis, and follow-up
 * generation) uses the study's own configured provider and model — the
 * researcher's own choice — never a fixed per-provider override. See
 * AGENTS.md's synthesis-provenance invariant.
 */
describe('synthesis model resolution', () => {
  it.each(['gemini', 'claude', 'openai', 'openrouter'] as const)(
    'resolves a %s study to its own configured model, not a fixed override',
    (provider) => {
      const config = makeStudyConfig({ aiProvider: provider, aiModel: `${provider}-researcher-choice` });

      expect(resolveSynthesisModel(config)).toBe(`${provider}-researcher-choice`);
    },
  );

  it('fails closed rather than substituting a default when the study has no explicit model', () => {
    const config = makeStudyConfig({ aiProvider: 'gemini' });
    delete config.aiModel;

    expect(() => resolveSynthesisModel(config)).toThrow(
      'Study is missing an explicit AI model required for synthesis',
    );
  });

  it('fails closed on an empty-string model rather than treating it as configured', () => {
    const config = makeStudyConfig({ aiProvider: 'openai', aiModel: '' });

    expect(() => resolveSynthesisModel(config)).toThrow(
      'Study is missing an explicit AI model required for synthesis',
    );
  });
});

function synthesisResponse(provider: AIProviderType, model: string | null | undefined) {
  const text = JSON.stringify({
    statedPreferences: [], revealedPreferences: [], themes: [], contradictions: [],
    keyInsights: ['A synthetic insight.'], bottomLine: 'A synthetic bottom line.',
  });
  if (provider === 'claude') return { model, content: [{ type: 'text', text }] };
  if (provider === 'openrouter') return {
    model,
    choices: [{ message: { content: text } }],
    openrouterMetadata: { attempts: [{ provider: 'OpenAI', status: 200 }] },
  };
  return { model, output_text: text };
}

describe.each([
  { provider: 'gemini' as const, Provider: GeminiProvider, requestedModel: DEFAULT_GEMINI_MODEL },
  { provider: 'claude' as const, Provider: ClaudeProvider, requestedModel: DEFAULT_CLAUDE_MODEL },
  { provider: 'openai' as const, Provider: OpenAIProvider, requestedModel: DEFAULT_OPENAI_MODEL },
  { provider: 'openrouter' as const, Provider: OpenRouterProvider, requestedModel: DEFAULT_OPENROUTER_MODEL },
])('$provider served-model provenance', ({ provider, Provider, requestedModel }) => {
  const config = makeStudyConfig({ aiProvider: provider, aiModel: requestedModel });
  const behavior = { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] };

  it.each([undefined, null, '', ' \t '])('rejects absent or blank served models (%j)', async (model) => {
    providerRequest.mockResolvedValue(synthesisResponse(provider, model));
    const adapter = new Provider(requestedModel, 'synthetic-test-key');

    const result = adapter.synthesizeInterview([], config, behavior, null);

    await expect(result).rejects.toBeInstanceOf(ProviderFailure);
    await expect(result).rejects.toMatchObject({ kind: 'invalid-response' });
  });

  it('keeps the dated served snapshot separate from the requested alias', async () => {
    const servedModel = `${requestedModel}-2026-09-06`;
    providerRequest.mockResolvedValue(synthesisResponse(provider, ` ${servedModel} `));
    const adapter = new Provider(requestedModel, 'synthetic-test-key');

    const result = await adapter.synthesizeInterview([], config, behavior, null);

    expect(result.execution).toEqual({
      provider,
      requestedModel,
      model: servedModel,
      ...(provider === 'openrouter' ? { routedProvider: 'OpenAI' } : {}),
    });
  });
});
