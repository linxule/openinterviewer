// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GeminiProvider } from '@/lib/providers/gemini';
import { ClaudeProvider } from '@/lib/providers/claude';
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_GEMINI_MODEL,
} from '@/types';
import { makeStudyConfig } from '../fixtures/models';

const geminiCreateMock = vi.hoisted(() => vi.fn());
const geminiCtorMock = vi.hoisted(() => vi.fn());
const claudeCreateMock = vi.hoisted(() => vi.fn());
const claudeCtorMock = vi.hoisted(() => vi.fn());

vi.mock('@google/genai', () => ({
  GoogleGenAI: class MockGoogleGenAI {
    interactions = { create: geminiCreateMock };
    constructor(...args: unknown[]) {
      geminiCtorMock(...args);
    }
  },
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: claudeCreateMock };
    constructor(...args: unknown[]) {
      claudeCtorMock(...args);
    }
  },
}));

const interview = {
  message: 'Could you tell me more?',
  questionAddressed: null,
  phaseTransition: null,
  profileUpdates: [],
  shouldConclude: false,
};

const synthesis = {
  statedPreferences: [],
  revealedPreferences: [],
  themes: [],
  contradictions: [],
  keyInsights: ['Insight'],
  bottomLine: 'Bottom line.',
};

const progress = {
  questionsAsked: [],
  total: 1,
  currentPhase: 'background' as const,
  isComplete: false,
};

const behavior = {
  timePerTopic: {},
  messagesPerTopic: {},
  topicsExplored: [],
  contradictions: [],
};

beforeEach(() => {
  geminiCreateMock.mockReset();
  geminiCtorMock.mockReset();
  claudeCreateMock.mockReset();
  claudeCtorMock.mockReset();
});

describe('GeminiProvider Interactions API', () => {
  it('uses stateless Interactions structured output with full bounded history', async () => {
    geminiCreateMock.mockResolvedValue({
      output_text: JSON.stringify(interview),
      model: DEFAULT_GEMINI_MODEL,
    });
    const provider = new GeminiProvider(undefined, 'gemini-test');
    const config = makeStudyConfig({
      aiProvider: 'gemini',
      aiModel: DEFAULT_GEMINI_MODEL,
      enableReasoning: false,
    });
    const history = Array.from({ length: 12 }, (_, index) => ({
      id: `m${index}`,
      role: index % 2 === 0 ? 'user' as const : 'ai' as const,
      content: `turn-${index}`,
      timestamp: index,
    }));

    await provider.generateInterviewResponse(history, config, null, progress, '');

    const request = geminiCreateMock.mock.calls[0][0];
    expect(request).toMatchObject({
      model: DEFAULT_GEMINI_MODEL,
      store: false,
      response_format: {
        type: 'text',
        mime_type: 'application/json',
      },
      generation_config: { thinking_level: 'low' },
    });
    expect(request.response_format.schema.additionalProperties).toBe(false);
    expect(request.input).toContain('turn-0');
    expect(request.input).toContain('turn-11');
    expect(request.previous_interaction_id).toBeUndefined();
  });

  it('sends the study\'s own configured model and returns requested/resolved provenance', async () => {
    geminiCreateMock.mockResolvedValue({
      output_text: JSON.stringify(synthesis),
      model: 'gemini-3.1-pro-preview-2026-07-15',
    });
    const provider = new GeminiProvider(undefined, 'gemini-test');
    const studyModel = 'gemini-3.8-flash-researcher-choice';

    const result = await provider.synthesizeInterview(
      [],
      makeStudyConfig({ aiProvider: 'gemini', aiModel: studyModel }),
      behavior,
      null,
    );

    expect(geminiCreateMock.mock.calls[0][0].model).toBe(studyModel);
    expect(result.execution).toEqual({
      provider: 'gemini',
      requestedModel: studyModel,
      model: 'gemini-3.1-pro-preview-2026-07-15',
    });
    expect(geminiCreateMock.mock.calls[0][0].store).toBe(false);

    // Gemini's Interactions API rejects response_format schemas containing
    // maxLength/minimum/minItems with a 400, even though synthesisResponseSchema
    // (shared with every other provider) legitimately declares them. See
    // toGeminiResponseSchema in src/lib/providers/gemini.ts.
    const sentSchema = geminiCreateMock.mock.calls[0][0].response_format.schema;
    const seenKeys = new Set<string>();
    (function collect(value: unknown) {
      if (Array.isArray(value)) {
        value.forEach(collect);
        return;
      }
      if (value !== null && typeof value === 'object') {
        for (const [key, entry] of Object.entries(value)) {
          seenKeys.add(key);
          collect(entry);
        }
      }
    })(sentSchema);
    expect(seenKeys.has('maxLength')).toBe(false);
    expect(seenKeys.has('minimum')).toBe(false);
    expect(seenKeys.has('minItems')).toBe(false);
  });

  it('fails closed instead of falling back to a default when the study has no explicit model', async () => {
    const provider = new GeminiProvider(undefined, 'gemini-test');
    const config = makeStudyConfig({ aiProvider: 'gemini', aiModel: DEFAULT_GEMINI_MODEL });
    delete config.aiModel;

    await expect(provider.synthesizeInterview([], config, behavior, null)).rejects.toThrow(
      'Study is missing an explicit AI model required for synthesis',
    );
    expect(geminiCreateMock).not.toHaveBeenCalled();
  });
});

describe('ClaudeProvider native structured output', () => {
  it('uses output_config.format and adaptive thinking without pseudo-tools', async () => {
    claudeCreateMock.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify(interview) }],
      model: DEFAULT_CLAUDE_MODEL,
    });
    const provider = new ClaudeProvider(undefined, 'claude-test');
    const config = makeStudyConfig({
      aiProvider: 'claude',
      aiModel: DEFAULT_CLAUDE_MODEL,
      enableReasoning: true,
    });

    await provider.generateInterviewResponse(
      [{ id: 'm1', role: 'user', content: 'Hello', timestamp: 1 }],
      config,
      null,
      progress,
      '',
    );

    const request = claudeCreateMock.mock.calls[0][0];
    expect(request.model).toBe(DEFAULT_CLAUDE_MODEL);
    expect(request.output_config.format).toMatchObject({ type: 'json_schema' });
    expect(request.output_config.format.schema.additionalProperties).toBe(false);
    expect(request.thinking).toEqual({ type: 'adaptive', display: 'omitted' });
    expect(request.tools).toBeUndefined();
    expect(request.tool_choice).toBeUndefined();
  });

  it('sends the study\'s own configured model and returns requested/resolved provenance', async () => {
    claudeCreateMock.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify(synthesis) }],
      model: 'claude-opus-5-20260801',
    });
    const provider = new ClaudeProvider(undefined, 'claude-test');
    const studyModel = 'claude-opus-5-researcher-choice';

    const result = await provider.synthesizeInterview(
      [],
      makeStudyConfig({ aiProvider: 'claude', aiModel: studyModel }),
      behavior,
      null,
    );

    expect(claudeCreateMock.mock.calls[0][0].model).toBe(studyModel);
    expect(result.execution).toEqual({
      provider: 'claude',
      requestedModel: studyModel,
      model: 'claude-opus-5-20260801',
    });
  });

  it('fails closed instead of falling back to a default when the study has no explicit model', async () => {
    const provider = new ClaudeProvider(undefined, 'claude-test');
    const config = makeStudyConfig({ aiProvider: 'claude', aiModel: DEFAULT_CLAUDE_MODEL });
    delete config.aiModel;

    await expect(provider.synthesizeInterview([], config, behavior, null)).rejects.toThrow(
      'Study is missing an explicit AI model required for synthesis',
    );
    expect(claudeCreateMock).not.toHaveBeenCalled();
  });
});
