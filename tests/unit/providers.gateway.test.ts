// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStudyConfig } from '../fixtures/models';

const generateTextMock = vi.hoisted(() => vi.fn());
const gatewayMock = vi.hoisted(() => vi.fn((model: string) => ({ modelId: model })));
const outputObjectMock = vi.hoisted(() => vi.fn((options: unknown) => ({ kind: 'object', ...options as object })));
const jsonSchemaMock = vi.hoisted(() => vi.fn((schema: unknown) => ({ schema })));

vi.mock('ai', () => ({
  generateText: generateTextMock,
  gateway: gatewayMock,
  Output: { object: outputObjectMock },
  jsonSchema: jsonSchemaMock,
}));

import { GatewayProvider } from '@/lib/providers/gateway';
import { getInterviewProvider } from '@/lib/providers';

function synthesisOutput() {
  return {
    statedPreferences: [],
    revealedPreferences: [],
    themes: [],
    contradictions: [],
    keyInsights: ['A useful insight'],
    bottomLine: 'A concise bottom line.',
  };
}

beforeEach(() => {
  vi.stubEnv('VERCEL', '1');
  vi.stubEnv('AI_TRANSPORT', 'gateway');
  vi.stubEnv('DEPLOYMENT_MODE', 'standalone');
  vi.stubEnv('AI_GATEWAY_ZERO_DATA_RETENTION', '');
  generateTextMock.mockReset();
  gatewayMock.mockClear();
  outputObjectMock.mockClear();
  jsonSchemaMock.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GatewayProvider', () => {
  it('uses strict structured output, pins the creator endpoint, and configures no retry or model fallback', async () => {
    generateTextMock.mockResolvedValue({
      output: {
        message: 'Thanks for sharing.',
        questionAddressed: null,
        phaseTransition: null,
        profileUpdates: [],
        shouldConclude: false,
      },
      text: '',
      response: { modelId: 'google/gemini-3.7-flash' },
    });
    const config = makeStudyConfig({ aiProvider: 'gemini', aiModel: 'gemini-3.7-flash' });
    const provider = new GatewayProvider('gemini', config.aiModel!);

    await provider.generateInterviewResponse(
      [{ id: 'm1', role: 'user', content: 'Hello', timestamp: 1 }],
      config,
      null,
      { questionsAsked: [], total: 1, currentPhase: 'background', isComplete: false },
      '',
    );

    expect(gatewayMock).toHaveBeenCalledWith('google/gemini-3.7-flash');
    expect(generateTextMock).toHaveBeenCalledWith(expect.objectContaining({
      maxRetries: 0,
      output: expect.objectContaining({ kind: 'object' }),
      providerOptions: {
        gateway: {
          only: ['google'],
          disallowPromptTraining: true,
        },
      },
    }));
    expect(jsonSchemaMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'object',
      additionalProperties: false,
    }));
  });

  it('records the study\'s own configured model as the Gateway request, the response model, and pinned routed provider', async () => {
    generateTextMock.mockResolvedValue({
      output: synthesisOutput(),
      text: '',
      response: { modelId: 'openai/gpt-5.6-sol-2026-08-01' },
    });
    const config = makeStudyConfig({ aiProvider: 'openai', aiModel: 'gpt-5.6-terra' });
    const provider = new GatewayProvider('openai', config.aiModel!);

    const result = await provider.synthesizeInterview(
      [],
      config,
      { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] },
      null,
    );

    expect(gatewayMock).toHaveBeenCalledWith('openai/gpt-5.6-terra');
    expect(result.execution).toEqual({
      provider: 'openai',
      requestedModel: 'openai/gpt-5.6-terra',
      model: 'openai/gpt-5.6-sol-2026-08-01',
      routedProvider: 'openai',
    });
  });

  it('fails closed instead of falling back to a default when the study has no explicit model', async () => {
    const config = makeStudyConfig({ aiProvider: 'openai', aiModel: 'gpt-5.6-terra' });
    const provider = new GatewayProvider('openai', config.aiModel!);
    delete config.aiModel;

    await expect(provider.synthesizeInterview(
      [],
      config,
      { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] },
      null,
    )).rejects.toThrow('Study is missing an explicit AI model required for synthesis');
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it('keeps plain-text greetings on the same privacy and route policy', async () => {
    generateTextMock.mockResolvedValue({
      output: undefined,
      text: 'Welcome!',
      response: { modelId: 'anthropic/claude-sonnet-4.5' },
    });
    const config = makeStudyConfig({ aiProvider: 'claude', aiModel: 'claude-sonnet-4-5' });
    const provider = new GatewayProvider('claude', config.aiModel!);

    await expect(provider.getInterviewGreeting(config)).resolves.toBe('Welcome!');
    expect(gatewayMock).toHaveBeenCalledWith('anthropic/claude-sonnet-4.5');
    expect(generateTextMock.mock.calls[0][0]).not.toHaveProperty('output');
    expect(generateTextMock.mock.calls[0][0].providerOptions.gateway.only).toEqual(['anthropic']);
  });

  it('honors an explicit ZDR filter and fails closed on malformed output', async () => {
    vi.stubEnv('AI_GATEWAY_ZERO_DATA_RETENTION', 'true');
    generateTextMock.mockResolvedValue({
      output: { message: 'missing required fields' },
      text: '',
      response: { modelId: 'google/gemini-3.7-flash' },
    });
    const config = makeStudyConfig({ aiProvider: 'gemini', aiModel: 'gemini-3.7-flash' });
    const provider = new GatewayProvider('gemini', config.aiModel!);

    await expect(provider.generateInterviewResponse(
      [],
      config,
      null,
      { questionsAsked: [], total: 1, currentPhase: 'background', isComplete: false },
      '',
    )).rejects.toMatchObject({ kind: 'invalid-response' });
    expect(generateTextMock.mock.calls[0][0].providerOptions.gateway.zeroDataRetention).toBe(true);
  });

  it('selects Gateway only for supported providers in standalone mode', () => {
    const gemini = getInterviewProvider(makeStudyConfig({
      aiProvider: 'gemini',
      aiModel: 'gemini-3.7-flash',
    }));
    expect(gemini).toBeInstanceOf(GatewayProvider);

    expect(() => getInterviewProvider(makeStudyConfig({
      aiProvider: 'openrouter',
      aiModel: 'openai/gpt-5.6-terra',
    }))).toThrow('OpenRouter is available only with the direct AI transport');
  });
});
