// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterProvider } from '@/lib/providers/openrouter';
import { DEFAULT_OPENROUTER_MODEL } from '@/types';
import { makeStudyConfig } from '../fixtures/models';

const sendMock = vi.hoisted(() => vi.fn());
const clientCtorMock = vi.hoisted(() => vi.fn());

vi.mock('@openrouter/sdk', () => ({
  OpenRouter: class MockOpenRouter {
    chat = { send: sendMock };
    constructor(...args: unknown[]) {
      clientCtorMock(...args);
    }
  },
}));

function studyConfig() {
  return makeStudyConfig({ aiProvider: 'openrouter', aiModel: DEFAULT_OPENROUTER_MODEL });
}

function interviewJson() {
  return {
    message: 'Thanks for sharing.',
    questionAddressed: null,
    phaseTransition: null,
    profileUpdates: [],
    shouldConclude: false,
  };
}

function completion(content: string, options?: { model?: string; provider?: string }) {
  const model = options?.model || 'openai/gpt-5.6-sol';
  return {
    choices: [{ message: { content, model } }],
    model,
    openrouterMetadata: options?.provider
      ? { attempts: [{ model, provider: options.provider, status: 200 }] }
      : undefined,
  };
}

beforeEach(() => {
  sendMock.mockReset();
  clientCtorMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('OpenRouterProvider', () => {
  it('uses the official OpenRouter SDK and refuses an empty hosted sentinel', () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'or-env');
    expect(() => new OpenRouterProvider(undefined, '')).toThrow('OPENROUTER_API_KEY is required');

    new OpenRouterProvider(undefined, 'or-test');
    expect(clientCtorMock).toHaveBeenCalledWith({
      apiKey: 'or-test',
      appTitle: 'OpenInterviewer',
    });
  });

  it('allows a bounded custom provider/model slug but rejects automatic routing', () => {
    vi.stubEnv('OPENROUTER_MODEL', 'qwen/qwen3.6-plus');
    expect(() => new OpenRouterProvider(undefined, 'or-test')).not.toThrow();

    vi.stubEnv('OPENROUTER_MODEL', 'openrouter/auto');
    expect(() => new OpenRouterProvider(undefined, 'or-test')).toThrow(/Unsupported OpenRouter model/);
  });

  it('sends strict schema and privacy-constrained routing on the stable chat API', async () => {
    sendMock.mockResolvedValue(completion(JSON.stringify(interviewJson())));
    const provider = new OpenRouterProvider(undefined, 'or-test');

    await provider.generateInterviewResponse(
      [{ id: 'm1', role: 'user', content: 'Hi', timestamp: 1 }],
      studyConfig(),
      null,
      { questionsAsked: [], total: 1, currentPhase: 'background', isComplete: false },
      '',
    );

    const request = sendMock.mock.calls[0][0];
    expect(request.xOpenRouterMetadata).toBe('enabled');
    expect(request.chatRequest.model).toBe(DEFAULT_OPENROUTER_MODEL);
    expect(request.chatRequest.stream).toBe(false);
    expect(request.chatRequest.provider).toEqual({
      requireParameters: true,
      dataCollection: 'deny',
      zdr: true,
      allowFallbacks: false,
    });
    expect(request.chatRequest.responseFormat).toMatchObject({
      type: 'json_schema',
      jsonSchema: { strict: true, name: 'interview_response' },
    });
    expect(request.chatRequest.responseFormat.jsonSchema.schema.additionalProperties).toBe(false);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('applies the same privacy policy to plain-text greetings', async () => {
    sendMock.mockResolvedValue(completion('Welcome!'));
    const provider = new OpenRouterProvider(undefined, 'or-test');

    await expect(provider.getInterviewGreeting(studyConfig())).resolves.toBe('Welcome!');
    expect(sendMock.mock.calls[0][0].chatRequest.provider).toEqual({
      requireParameters: true,
      dataCollection: 'deny',
      zdr: true,
      allowFallbacks: false,
    });
    expect(sendMock.mock.calls[0][0].chatRequest.responseFormat).toBeUndefined();
  });

  it('sends the study\'s own configured model and records requested/resolved model and upstream provider', async () => {
    sendMock.mockResolvedValue(completion(JSON.stringify({
      statedPreferences: [],
      revealedPreferences: [],
      themes: [],
      contradictions: [],
      keyInsights: ['Insight'],
      bottomLine: 'Bottom line.',
    }), { model: 'openai/gpt-5.6-sol-2026-08-01', provider: 'OpenAI' }));
    const provider = new OpenRouterProvider(undefined, 'or-test');
    const studyModel = 'openai/gpt-5.6-researcher-choice';

    const result = await provider.synthesizeInterview(
      [],
      makeStudyConfig({ aiProvider: 'openrouter', aiModel: studyModel }),
      { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] },
      null,
    );

    expect(sendMock.mock.calls[0][0].chatRequest.model).toBe(studyModel);
    expect(result.execution).toEqual({
      provider: 'openrouter',
      requestedModel: studyModel,
      model: 'openai/gpt-5.6-sol-2026-08-01',
      routedProvider: 'OpenAI',
    });
  });

  it('fails closed instead of falling back to a default when the study has no explicit model', async () => {
    const provider = new OpenRouterProvider(undefined, 'or-test');
    const config = studyConfig();
    delete config.aiModel;

    await expect(provider.synthesizeInterview(
      [],
      config,
      { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] },
      null,
    )).rejects.toThrow('Study is missing an explicit AI model required for synthesis');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('fails closed when upstream routing metadata is absent', async () => {
    sendMock.mockResolvedValue(completion(JSON.stringify({
      statedPreferences: [],
      revealedPreferences: [],
      themes: [],
      contradictions: [],
      keyInsights: [],
      bottomLine: 'Bottom line.',
    })));
    const provider = new OpenRouterProvider(undefined, 'or-test');

    await expect(provider.synthesizeInterview(
      [],
      studyConfig(),
      { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] },
      null,
    )).rejects.toMatchObject({
      kind: 'invalid-response',
      message: 'OpenRouter response did not identify the upstream provider',
    });
  });

  it('fails once without retrying a rejected strict-schema request', async () => {
    sendMock.mockRejectedValue({ status: 400, name: 'APIError' });
    const provider = new OpenRouterProvider(undefined, 'or-test');

    await expect(provider.generateInterviewResponse(
      [],
      studyConfig(),
      null,
      { questionsAsked: [], total: 1, currentPhase: 'background', isComplete: false },
      '',
    )).rejects.toMatchObject({ kind: 'config' });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
