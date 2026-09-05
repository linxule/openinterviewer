// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAIProvider } from '@/lib/providers/openai';
import { ProviderFailure } from '@/lib/providerErrors';
import { DEFAULT_OPENAI_MODEL } from '@/types';
import { makeStudyConfig } from '../fixtures/models';

const createMock = vi.hoisted(() => vi.fn());
const clientCtorMock = vi.hoisted(() => vi.fn());

vi.mock('openai', () => {
  class MockOpenAI {
    responses = {
      create: createMock,
    };
    constructor(...args: unknown[]) {
      clientCtorMock(...args);
    }
  }
  return { default: MockOpenAI };
});

function studyConfig() {
  return makeStudyConfig({ aiProvider: 'openai', aiModel: DEFAULT_OPENAI_MODEL });
}

function interviewJson() {
  return {
    message: 'Tell me about your role.',
    questionAddressed: 0,
    phaseTransition: null,
    profileUpdates: [{ fieldId: 'role', value: 'Engineer', status: 'extracted' }],
    shouldConclude: false,
  };
}

function response(content: string, model = 'gpt-5.6-sol') {
  return {
    output_text: content,
    model,
  };
}

beforeEach(() => {
  createMock.mockReset();
  clientCtorMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('OpenAIProvider', () => {
  it('constructs a first-party OpenAI client with the provided key', () => {
    new OpenAIProvider(undefined, 'sk-test');

    expect(clientCtorMock).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-test' }));
  });

  it('prefers the constructor model, then OPENAI_MODEL, then the default', () => {
    vi.stubEnv('OPENAI_MODEL', 'gpt-5.6-luna');
    const provider = new OpenAIProvider(undefined, 'sk-test');
    createMock.mockResolvedValue(response('Welcome!', 'gpt-5.6-luna'));
    return provider.getInterviewGreeting(studyConfig()).then(() => {
      expect(createMock.mock.calls[0][0].model).toBe('gpt-5.6-luna');
    });
  });

  it('refuses an empty hosted sentinel instead of falling back to env', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-env');
    expect(() => new OpenAIProvider(undefined, '')).toThrow('OPENAI_API_KEY is required');
  });

  it('generates a structured interview response with strict json_schema via the Responses API', async () => {
    createMock.mockResolvedValue(response(JSON.stringify(interviewJson())));
    const provider = new OpenAIProvider(undefined, 'sk-test');

    const result = await provider.generateInterviewResponse(
      [
        { id: 'm1', role: 'user', content: 'Hi', timestamp: 1 },
        { id: 'm2', role: 'ai', content: 'Hello!', timestamp: 2 },
      ],
      studyConfig(),
      null,
      { questionsAsked: [], total: 1, currentPhase: 'background', isComplete: false },
      ''
    );

    expect(result.message).toBe('Tell me about your role.');
    const body = createMock.mock.calls[0][0];
    expect(body.model).toBe(DEFAULT_OPENAI_MODEL);
    expect(body.max_output_tokens).toBe(4_096);
    expect(body.store).toBe(false);
    expect(body.text.format.type).toBe('json_schema');
    expect(body.text.format.strict).toBe(true);
    const schema = body.text.format.schema;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual([
      'message',
      'questionAddressed',
      'phaseTransition',
      'profileUpdates',
      'shouldConclude',
    ]);
    // Nullable fields use type unions and nullable enums include null.
    expect(schema.properties.questionAddressed.type).toEqual(['integer', 'null']);
    expect(schema.properties.phaseTransition.enum).toContain(null);
    expect(schema.properties.profileUpdates.items.additionalProperties).toBe(false);
    // Interview history is flattened into the single-input format.
    expect(body.input).toContain('PARTICIPANT: Hi');
    expect(body.input).toContain('INTERVIEWER: Hello!');
  });

  it('maps enableReasoning to a Responses API reasoning effort', async () => {
    createMock.mockResolvedValue(response(JSON.stringify(interviewJson())));
    const provider = new OpenAIProvider(undefined, 'sk-test');
    const config = studyConfig();

    await provider.generateInterviewResponse(
      [],
      config,
      null,
      { questionsAsked: [], total: 1, currentPhase: 'background', isComplete: false },
      ''
    );
    expect(createMock.mock.calls[0][0].reasoning).toBeUndefined();

    config.enableReasoning = true;
    await provider.generateInterviewResponse(
      [],
      config,
      null,
      { questionsAsked: [], total: 1, currentPhase: 'background', isComplete: false },
      ''
    );
    expect(createMock.mock.calls[1][0].reasoning).toEqual({ effort: 'medium' });
  });

  it('sends the study\'s own configured model and returns execution provenance with the served model', async () => {
    createMock.mockResolvedValue(response(JSON.stringify({
      statedPreferences: [],
      revealedPreferences: [],
      themes: [],
      contradictions: [],
      keyInsights: ['Insight'],
      bottomLine: 'Bottom line.',
    }), 'gpt-5.6-sol'));
    const provider = new OpenAIProvider(undefined, 'sk-test');
    const studyModel = 'gpt-5.6-researcher-choice';

    const result = await provider.synthesizeInterview(
      [],
      makeStudyConfig({ aiProvider: 'openai', aiModel: studyModel }),
      { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] },
      null
    );

    expect(result.value.keyInsights).toEqual(['Insight']);
    expect(result.execution).toEqual({
      provider: 'openai',
      requestedModel: studyModel,
      model: 'gpt-5.6-sol',
    });
    expect(createMock.mock.calls[0][0].model).toBe(studyModel);
    expect(createMock.mock.calls[0][0].max_output_tokens).toBe(8_192);
  });

  it('fails closed instead of falling back to a default when the study has no explicit model', async () => {
    const provider = new OpenAIProvider(undefined, 'sk-test');
    const config = studyConfig();
    delete config.aiModel;

    await expect(provider.synthesizeInterview(
      [],
      config,
      { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] },
      null
    )).rejects.toThrow('Study is missing an explicit AI model required for synthesis');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('generates a plain-text greeting without a schema', async () => {
    createMock.mockResolvedValue(response('Welcome!', 'gpt-5.6-terra'));
    const provider = new OpenAIProvider(undefined, 'sk-test');

    await expect(provider.getInterviewGreeting(studyConfig())).resolves.toBe('Welcome!');

    const body = createMock.mock.calls[0][0];
    expect(body.text).toBeUndefined();
    expect(body.max_output_tokens).toBe(500);
  });

  it('rejects malformed structured output as invalid-response', async () => {
    createMock.mockResolvedValue(response('{"message": 42}'));
    const provider = new OpenAIProvider(undefined, 'sk-test');

    await expect(provider.generateInterviewResponse(
      [],
      studyConfig(),
      null,
      { questionsAsked: [], total: 1, currentPhase: 'background', isComplete: false },
      ''
    )).rejects.toMatchObject({ kind: 'invalid-response' });
  });

  it('classifies provider HTTP rejections as configuration errors', async () => {
    createMock.mockRejectedValue({ status: 401, name: 'AuthenticationError' });
    const provider = new OpenAIProvider(undefined, 'sk-test');

    await expect(provider.getInterviewGreeting(studyConfig())).rejects.toMatchObject({
      kind: 'config',
    });
  });

  it('throws ProviderFailure when the response has no text', async () => {
    createMock.mockResolvedValue({ output_text: '', model: 'gpt-5.6-terra' });
    const provider = new OpenAIProvider(undefined, 'sk-test');

    await expect(provider.getInterviewGreeting(studyConfig())).rejects.toBeInstanceOf(ProviderFailure);
  });
});
