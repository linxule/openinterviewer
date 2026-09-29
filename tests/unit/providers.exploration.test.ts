// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeProvider } from '@/lib/providers/claude';
import { GeminiProvider, toGeminiResponseSchema } from '@/lib/providers/gemini';
import { OpenAIProvider } from '@/lib/providers/openai';
import { OpenRouterProvider } from '@/lib/providers/openrouter';
import { GatewayProvider } from '@/lib/providers/gateway';
import { claudeOutputSchema } from '@/lib/providers/claude';
import { explorationResponseSchema } from '@/lib/providerSchemas';
import { ProviderTimeoutError } from '@/lib/providerErrors';
import type { AIProvider } from '@/lib/ai';
import type { AIProviderType } from '@/types';
import { makeStoredInterview, makeStudyConfig } from '../fixtures/models';

const request = vi.hoisted(() => vi.fn());
const generateText = vi.hoisted(() => vi.fn());
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: request }; } }));
vi.mock('@google/genai', () => ({ GoogleGenAI: class { interactions = { create: request }; } }));
vi.mock('openai', () => ({ default: class { responses = { create: request }; } }));
vi.mock('@openrouter/sdk', () => ({ OpenRouter: class { chat = { send: request }; } }));
vi.mock('ai', () => ({
  generateText,
  gateway: (model: string) => ({ modelId: model }),
  Output: { object: (options: unknown) => options },
  jsonSchema: (schema: unknown) => ({ schema }),
}));

const payload = {
  answer: 'One tentative pattern, with contrary evidence.',
  findings: [{
    heading: 'Speed is conditional', interpretation: 'A provisional construction rather than three forced archetypes.',
    supporting: [{ interviewIndex: 1, turnIndex: 2, quote: 'I value speed.' }],
    challenging: [{ interviewIndex: 2, turnIndex: 2, quote: 'Not at the cost of clarity.' }],
    uncertain: [],
  }],
  limitations: ['This small selected dataset cannot establish population prevalence.'],
};

type Case = { provider: AIProviderType; model: string; make: () => AIProvider };
const cases: Case[] = [
  { provider: 'claude', model: 'claude-sonnet-5', make: () => new ClaudeProvider('claude-sonnet-5', 'synthetic-test-key') },
  { provider: 'gemini', model: 'gemini-3.7-flash', make: () => new GeminiProvider('gemini-3.7-flash', 'synthetic-test-key') },
  { provider: 'openai', model: 'gpt-5.6-terra', make: () => new OpenAIProvider('gpt-5.6-terra', 'synthetic-test-key') },
  { provider: 'openrouter', model: 'openai/gpt-5.6-terra', make: () => new OpenRouterProvider('openai/gpt-5.6-terra', 'synthetic-test-key') },
];
function input(testCase: Case) {
  return {
    question: 'What supports or challenges the hypothesis?',
    studyConfig: makeStudyConfig({ aiProvider: testCase.provider, aiModel: testCase.model }),
    interviews: [makeStoredInterview({ synthesis: null }), makeStoredInterview({ synthesis: null })],
  };
}
function respond(provider: AIProviderType, model: string, value: unknown = payload) {
  const text = JSON.stringify(value);
  if (provider === 'claude') request.mockResolvedValue({ model, content: [{ type: 'text', text }] });
  else if (provider === 'openrouter') request.mockResolvedValue({
    model, choices: [{ message: { content: text } }], openrouterMetadata: { attempts: [{ provider: 'OpenAI', status: 200 }] },
  });
  else request.mockResolvedValue({ model, output_text: text });
}

beforeEach(() => { request.mockReset(); generateText.mockReset(); });
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe.each(cases)('$provider exploration', (testCase) => {
  it('uses the configured study model, closed schema and served snapshot with exactly one attempt', async () => {
    respond(testCase.provider, `${testCase.model}-snapshot`);
    const result = await testCase.make().exploreStudy(input(testCase), { kind: 'exploration', deadlineMs: 30_000 });
    expect(request).toHaveBeenCalledTimes(1);
    expect(result.value).toEqual(payload);
    expect(result.execution).toEqual({
      provider: testCase.provider, requestedModel: testCase.model, model: `${testCase.model}-snapshot`,
      ...(testCase.provider === 'openrouter' ? { routedProvider: 'OpenAI' } : {}),
    });
    const [body, options] = request.mock.calls[0];
    if (testCase.provider === 'openrouter') {
      expect(body.chatRequest.model).toBe(testCase.model);
      expect(body.chatRequest.responseFormat.jsonSchema.schema).toEqual(explorationResponseSchema);
      expect(body.chatRequest.provider.allowFallbacks).toBe(false);
      expect(options).toMatchObject({ retries: { strategy: 'none' }, timeoutMs: 30_000, signal: expect.any(AbortSignal) });
    } else {
      expect(body.model).toBe(testCase.model);
      expect(options).toMatchObject({ maxRetries: 0, timeout: 30_000 });
      if (testCase.provider === 'claude') expect(body.output_config.format.schema).toEqual(claudeOutputSchema(explorationResponseSchema));
      if (testCase.provider === 'gemini') {
        expect(body.response_format.schema).toEqual(toGeminiResponseSchema(explorationResponseSchema));
        expect(body.generation_config.max_output_tokens).toBe(12_000);
      }
      if (testCase.provider === 'openai') expect(body.text.format.schema).toEqual(explorationResponseSchema);
    }
  });

  it.each([undefined, { kind: 'default' as const }])('cannot enable retries by omitting the policy or supplying default (%j)', async (policy) => {
    respond(testCase.provider, testCase.model);
    await testCase.make().exploreStudy(input(testCase), policy);
    const options = request.mock.calls[0][1];
    expect(testCase.provider === 'openrouter' ? options.retries : options.maxRetries).toEqual(testCase.provider === 'openrouter' ? { strategy: 'none' } : 0);
  });

  it('refuses malformed output without a repair request', async () => {
    respond(testCase.provider, testCase.model, { answer: 'A plausible answer with missing evidence fields.' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(testCase.make().exploreStudy(input(testCase))).rejects.toMatchObject({ kind: 'invalid-response' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('refuses missing served-model provenance without a second call', async () => {
    respond(testCase.provider, '');
    await expect(testCase.make().exploreStudy(input(testCase))).rejects.toMatchObject({ kind: 'invalid-response' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid deadlines and missing configured models before sending data', async () => {
    const adapter = testCase.make();
    await expect(adapter.exploreStudy(input(testCase), { kind: 'exploration', deadlineMs: 0 })).rejects.toThrow(/positive integer deadline/);
    const incomplete = input(testCase);
    delete incomplete.studyConfig.aiModel;
    await expect(adapter.exploreStudy(incomplete)).rejects.toThrow(/explicit AI model/);
    expect(request).not.toHaveBeenCalled();
  });

  it('never exceeds the exploration attempt deadline even when a larger one is requested', async () => {
    respond(testCase.provider, testCase.model);
    await testCase.make().exploreStudy(input(testCase), { kind: 'exploration', deadlineMs: 600_000 });
    const options = request.mock.calls[0][1];
    expect(testCase.provider === 'openrouter' ? options.timeoutMs : options.timeout).toBe(120_000);
  });

  it('aborts a timed-out attempt without retrying', async () => {
    vi.useFakeTimers();
    request.mockImplementation(() => new Promise(() => {}));
    const outcome = testCase.make().exploreStudy(input(testCase), { kind: 'exploration', deadlineMs: 25 }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(25);
    expect(await outcome).toBeInstanceOf(ProviderTimeoutError);
    const options = request.mock.calls[0][1];
    const signal = testCase.provider === 'gemini' ? options.fetchOptions.signal : options.signal;
    expect(signal.aborted).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('Vercel Gateway exploration', () => {
  it('pins the study creator endpoint, uses one attempt and records the actual response model', async () => {
    vi.stubEnv('VERCEL', '1');
    generateText.mockResolvedValue({ output: payload, response: { modelId: 'openai/gpt-5.6-terra-snapshot' } });
    const testCase = cases[2];
    const adapter = new GatewayProvider('openai', testCase.model);
    const result = await adapter.exploreStudy(input(testCase), { kind: 'exploration', deadlineMs: 5_000 });
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(generateText.mock.calls[0][0]).toMatchObject({
      model: { modelId: 'openai/gpt-5.6-terra' }, maxRetries: 0,
      providerOptions: { gateway: { only: ['openai'], disallowPromptTraining: true } },
      output: { schema: { schema: explorationResponseSchema } },
    });
    expect(result.execution).toEqual({ provider: 'openai', requestedModel: 'openai/gpt-5.6-terra', model: 'openai/gpt-5.6-terra-snapshot', routedProvider: 'openai' });
  });

  it('refuses malformed answers without repairing or falling back', async () => {
    vi.stubEnv('VERCEL', '1');
    generateText.mockResolvedValue({ output: {}, response: { modelId: 'openai/gpt-5.6-terra' } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(new GatewayProvider('openai', cases[2].model).exploreStudy(input(cases[2]))).rejects.toMatchObject({ kind: 'invalid-response' });
    expect(generateText).toHaveBeenCalledTimes(1);
  });
});
