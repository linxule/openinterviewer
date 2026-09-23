// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeProvider } from '@/lib/providers/claude';
import { GeminiProvider } from '@/lib/providers/gemini';
import { OpenAIProvider } from '@/lib/providers/openai';
import { OpenRouterProvider } from '@/lib/providers/openrouter';
import { SYNTHESIS_DEADLINE_MS } from '@/lib/providers/shared';
import type { AIProvider, ProviderExecutionPolicy } from '@/lib/ai';
import type { AIProviderType } from '@/types';
import { makeStudyConfig } from '../fixtures/models';

const claudeCreate = vi.hoisted(() => vi.fn());
const openaiCreate = vi.hoisted(() => vi.fn());
const geminiCreate = vi.hoisted(() => vi.fn());
const openrouterSend = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: claudeCreate };
  },
}));
vi.mock('openai', () => ({
  default: class MockOpenAI {
    responses = { create: openaiCreate };
  },
}));
vi.mock('@google/genai', () => ({
  GoogleGenAI: class MockGoogleGenAI {
    interactions = { create: geminiCreate };
  },
}));
vi.mock('@openrouter/sdk', () => ({
  OpenRouter: class MockOpenRouter {
    chat = { send: openrouterSend };
  },
}));

const synthesis = {
  statedPreferences: [],
  revealedPreferences: [],
  themes: [],
  contradictions: [],
  keyInsights: ['Insight'],
  bottomLine: 'Bottom line.',
};
const text = JSON.stringify(synthesis);
const behavior = { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] };
const history = [{ id: 'm1', role: 'user' as const, content: 'Hello', timestamp: 1 }];
const progress = { questionsAsked: [], total: 1, currentPhase: 'background' as const, isComplete: false };

type Case = {
  provider: AIProviderType;
  model: string;
  make: () => AIProvider;
  mock: ReturnType<typeof vi.fn>;
  /** Index of the per-call request options argument. */
  optionsArg: number;
  defaultOptions: (deadline: number) => Record<string, unknown>;
  queuedOptions: (deadline: number) => Record<string, unknown>;
  respond: () => void;
};

const cases: Case[] = [
  {
    provider: 'claude',
    model: 'claude-sonnet-5',
    make: () => new ClaudeProvider('claude-sonnet-5', 'sk-ant-test'),
    mock: claudeCreate,
    optionsArg: 1,
    defaultOptions: (deadline) => ({ signal: expect.any(AbortSignal), timeout: deadline }),
    queuedOptions: (deadline) => ({ signal: expect.any(AbortSignal), timeout: deadline, maxRetries: 0 }),
    respond: () => claudeCreate.mockResolvedValue({ model: 'claude-sonnet-5-20260901', content: [{ type: 'text', text }] }),
  },
  {
    provider: 'openai',
    model: 'gpt-5.6-terra',
    make: () => new OpenAIProvider('gpt-5.6-terra', 'sk-test'),
    mock: openaiCreate,
    optionsArg: 1,
    defaultOptions: (deadline) => ({ signal: expect.any(AbortSignal), timeout: deadline }),
    queuedOptions: (deadline) => ({ signal: expect.any(AbortSignal), timeout: deadline, maxRetries: 0 }),
    respond: () => openaiCreate.mockResolvedValue({ model: 'gpt-5.6-terra-2026-09-01', output_text: text }),
  },
  {
    provider: 'gemini',
    model: 'gemini-3.7-flash',
    make: () => new GeminiProvider('gemini-3.7-flash', 'gemini-test'),
    mock: geminiCreate,
    optionsArg: 1,
    defaultOptions: (deadline) => ({ timeout: deadline, fetchOptions: { signal: expect.any(AbortSignal) } }),
    queuedOptions: (deadline) => ({ timeout: deadline, fetchOptions: { signal: expect.any(AbortSignal) }, maxRetries: 0 }),
    respond: () => geminiCreate.mockResolvedValue({ model: 'gemini-3.7-flash-001', output_text: text }),
  },
  {
    provider: 'openrouter',
    model: 'openai/gpt-5.6-terra',
    make: () => new OpenRouterProvider('openai/gpt-5.6-terra', 'or-test'),
    mock: openrouterSend,
    optionsArg: 1,
    defaultOptions: (deadline) => ({ signal: expect.any(AbortSignal), timeoutMs: deadline }),
    queuedOptions: (deadline) => ({ signal: expect.any(AbortSignal), timeoutMs: deadline, retries: { strategy: 'none' } }),
    respond: () => openrouterSend.mockResolvedValue({
      model: 'openai/gpt-5.6-terra',
      choices: [{ message: { content: text, model: 'openai/gpt-5.6-terra-2026-09-01' } }],
      openrouterMetadata: { attempts: [{ model: 'openai/gpt-5.6-terra', provider: 'OpenAI', status: 200 }] },
    }),
  },
];

beforeEach(() => {
  for (const mock of [claudeCreate, openaiCreate, geminiCreate, openrouterSend]) mock.mockReset();
});

describe.each(cases)('JOB-09 $provider per-call execution policy', (testCase) => {
  const study = () => makeStudyConfig({ aiProvider: testCase.provider, aiModel: testCase.model });

  it('JOB-09 keeps the default synthesis request options byte-identical when no policy is passed', async () => {
    testCase.respond();
    await testCase.make().synthesizeInterview(history, study(), behavior, null);
    expect(testCase.mock).toHaveBeenCalledTimes(1);
    expect(testCase.mock.mock.calls[0][testCase.optionsArg]).toStrictEqual(testCase.defaultOptions(SYNTHESIS_DEADLINE_MS));
  });

  it('JOB-09 treats an explicit default policy exactly like no policy', async () => {
    testCase.respond();
    await testCase.make().synthesizeInterview(history, study(), behavior, null, { kind: 'default' });
    expect(testCase.mock.mock.calls[0][testCase.optionsArg]).toStrictEqual(testCase.defaultOptions(SYNTHESIS_DEADLINE_MS));
  });

  it('JOB-09 disables SDK retries per call and applies the explicit deadline under queued-synthesis', async () => {
    testCase.respond();
    const policy: ProviderExecutionPolicy = { kind: 'queued-synthesis', deadlineMs: 45_000 };
    const result = await testCase.make().synthesizeInterview(history, study(), behavior, null, policy);
    expect(testCase.mock).toHaveBeenCalledTimes(1);
    expect(testCase.mock.mock.calls[0][testCase.optionsArg]).toStrictEqual(testCase.queuedOptions(45_000));
    expect(result.execution.requestedModel).toBe(testCase.model);
  });

  it('JOB-09 never lets a queued deadline exceed the synthesis deadline and rejects an invalid one', async () => {
    testCase.respond();
    await testCase.make().synthesizeInterview(history, study(), behavior, null, {
      kind: 'queued-synthesis',
      deadlineMs: SYNTHESIS_DEADLINE_MS * 5,
    });
    expect(testCase.mock.mock.calls[0][testCase.optionsArg]).toStrictEqual(testCase.queuedOptions(SYNTHESIS_DEADLINE_MS));
    await expect(testCase.make().synthesizeInterview(history, study(), behavior, null, {
      kind: 'queued-synthesis',
      deadlineMs: 0,
    })).rejects.toThrow(/positive integer deadline/);
    expect(testCase.mock).toHaveBeenCalledTimes(1);
  });

  it('JOB-09 leaves participant greeting and interview calls on the default policy', async () => {
    const provider = testCase.make();
    const config = study();
    const turn = JSON.stringify({ message: 'Tell me more.', questionAddressed: null, phaseTransition: null, profileUpdates: [], shouldConclude: false });
    const reply = (value: string) => {
      if (testCase.provider === 'claude') claudeCreate.mockResolvedValue({ model: testCase.model, content: [{ type: 'text', text: value }] });
      else if (testCase.provider === 'openai') openaiCreate.mockResolvedValue({ model: testCase.model, output_text: value });
      else if (testCase.provider === 'gemini') geminiCreate.mockResolvedValue({ model: testCase.model, output_text: value });
      else openrouterSend.mockResolvedValue({ model: testCase.model, choices: [{ message: { content: value } }] });
    };
    reply('Hello and welcome.');
    await provider.getInterviewGreeting(config);
    reply(turn);
    await provider.generateInterviewResponse(history, config, null, progress, '');
    for (const call of testCase.mock.mock.calls) {
      const options = call[testCase.optionsArg] as Record<string, unknown>;
      expect(options).not.toHaveProperty('maxRetries');
      expect(options).not.toHaveProperty('retries');
    }
  });
});
