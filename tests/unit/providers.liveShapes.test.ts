// @vitest-environment node

// Request and response shapes the live providers impose, found by the paid
// staging smoke on 24 September 2026 (docs/operations/cloudflare-migration/
// evidence/REVIEW-PACKET.md §17): Claude refuses schema bounds and nullable
// enums in output_config, and OpenRouter omits `attempts` on a
// single-endpoint route.
import { describe, expect, it, vi } from 'vitest';
import { ClaudeProvider, OpenRouterProvider } from '@/lib/providers';
import { claudeOutputSchema } from '@/lib/providers/claude';
import { upstreamProvider } from '@/lib/providers/openrouter';
import { ProviderFailure } from '@/lib/providerErrors';
import {
  aggregateSynthesisResponseSchema,
  followupStudyResponseSchema,
  interviewResponseSchema,
  synthesisResponseSchema,
} from '@/lib/providerSchemas';
import { DEFAULT_CLAUDE_MODEL, DEFAULT_OPENROUTER_MODEL } from '@/types';
import { makeStudyConfig } from '../fixtures/models';

const providerRequest = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: providerRequest };
  },
}));
vi.mock('@openrouter/sdk', () => ({
  OpenRouter: class {
    chat = { send: providerRequest };
  },
}));

const REFUSED_BY_CLAUDE = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'maxItems'];
const SCHEMAS = {
  interviewResponseSchema,
  synthesisResponseSchema,
  aggregateSynthesisResponseSchema,
  followupStudyResponseSchema,
};

/** Every schema node (not property names) of `schema`, with its path. */
function nodes(schema: unknown, path = '$'): Array<{ path: string; node: Record<string, unknown> }> {
  if (Array.isArray(schema)) return schema.flatMap((item, i) => nodes(item, `${path}[${i}]`));
  if (!schema || typeof schema !== 'object') return [];
  const node = schema as Record<string, unknown>;
  const found = [{ path, node }];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties' && value && typeof value === 'object') {
      for (const [name, child] of Object.entries(value)) found.push(...nodes(child, `${path}.${name}`));
    } else if (typeof value === 'object') {
      found.push(...nodes(value, `${path}/${key}`));
    }
  }
  return found;
}

describe('claudeOutputSchema', () => {
  it.each(Object.entries(SCHEMAS))('%s carries no keyword Claude refuses and no nullable enum', (_name, schema) => {
    const converted = claudeOutputSchema(schema);
    for (const { path, node } of nodes(converted)) {
      for (const keyword of REFUSED_BY_CLAUDE) expect(node, `${path} keeps ${keyword}`).not.toHaveProperty(keyword);
      if ('enum' in node && Array.isArray(node.type)) {
        expect(node.type, `${path} is a nullable enum`).not.toContain('null');
      }
      if (Array.isArray(node.enum)) expect(node.enum, `${path} enum lists null`).not.toContain(null);
    }
  });

  it('rewrites the nullable phase enum as anyOf of the phases and null, and keeps everything else', () => {
    const converted = claudeOutputSchema(interviewResponseSchema) as {
      properties: Record<string, Record<string, unknown>>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(converted.properties.phaseTransition).toEqual({
      anyOf: [
        { type: 'string', enum: ['background', 'core-questions', 'exploration', 'feedback', 'wrap-up'] },
        { type: 'null' },
      ],
    });
    expect(converted.properties.questionAddressed).toEqual({ type: ['integer', 'null'] });
    expect(converted.required).toEqual(interviewResponseSchema.required);
    expect(converted.additionalProperties).toBe(false);
  });

  it('leaves the provider-neutral schema unchanged and removes keywords only, not properties of that name', () => {
    const before = JSON.stringify(synthesisResponseSchema);
    claudeOutputSchema(synthesisResponseSchema);
    expect(JSON.stringify(synthesisResponseSchema)).toBe(before);

    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: { minimum: { type: 'integer', minimum: 0 }, maxItems: { type: 'array', items: { type: 'string' }, maxItems: 2 } },
      required: ['minimum', 'maxItems'],
    };
    expect(claudeOutputSchema(schema)).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: { minimum: { type: 'integer' }, maxItems: { type: 'array', items: { type: 'string' } } },
      required: ['minimum', 'maxItems'],
    });
  });

  it('is what the Claude adapter sends', async () => {
    providerRequest.mockReset();
    providerRequest.mockResolvedValue({
      model: DEFAULT_CLAUDE_MODEL,
      content: [{ type: 'text', text: JSON.stringify({ message: 'Tell me more.', questionAddressed: null, phaseTransition: null, profileUpdates: [], shouldConclude: false }) }],
    });
    const provider = new ClaudeProvider(DEFAULT_CLAUDE_MODEL, 'synthetic-test-key');
    await provider.generateInterviewResponse(
      [{ id: 'a1', role: 'ai', content: 'Hello.', timestamp: 1 }, { id: 'u1', role: 'user', content: 'Hi.', timestamp: 2 }],
      makeStudyConfig({ aiProvider: 'claude', aiModel: DEFAULT_CLAUDE_MODEL }),
      null,
      { questionsAsked: [], total: 1, currentPhase: 'background', isComplete: false },
      '',
    );
    expect(providerRequest.mock.calls[0][0].output_config.format.schema).toEqual(claudeOutputSchema(interviewResponseSchema));
  });
});

describe('upstreamProvider (OpenRouter provenance)', () => {
  const live = {
    attempt: 1,
    strategy: 'direct',
    endpoints: { available: [{ model: 'openai/gpt-5.6-terra-20260709', provider: 'Azure', selected: true }], total: 7 },
  };

  it('reads the selected endpoint when OpenRouter reports no attempts (the live single-endpoint shape)', () => {
    expect(upstreamProvider(live)).toBe('Azure');
  });

  it('prefers the last successful attempt when attempts are reported', () => {
    expect(upstreamProvider({ ...live, attempts: [{ provider: 'OpenAI', status: 503 }, { provider: 'Azure', status: 200 }] })).toBe('Azure');
  });

  it('identifies nothing when every reported attempt failed, even with a selected endpoint', () => {
    expect(upstreamProvider({ ...live, attempts: [{ provider: 'OpenAI', status: 503 }] })).toBeNull();
  });

  it.each([
    ['no metadata', undefined],
    ['no endpoints', { attempt: 1 }],
    ['none selected', { endpoints: { available: [{ provider: 'Azure', selected: false }] } }],
    ['two selected', { endpoints: { available: [{ provider: 'Azure', selected: true }, { provider: 'OpenAI', selected: true }] } }],
    ['blank provider', { endpoints: { available: [{ provider: '  ', selected: true }] } }],
    ['truthy but not true', { endpoints: { available: [{ provider: 'Azure', selected: 'yes' }] } }],
  ])('identifies nothing with %s', (_label, metadata) => {
    expect(upstreamProvider(metadata as never)).toBeNull();
  });

  it('records the selected endpoint as the routed provider of a synthesis', async () => {
    providerRequest.mockReset();
    providerRequest.mockResolvedValue({
      model: DEFAULT_OPENROUTER_MODEL,
      choices: [{ message: { content: JSON.stringify({
        statedPreferences: [], revealedPreferences: [], themes: [], contradictions: [],
        keyInsights: ['A synthetic insight.'], bottomLine: 'A synthetic bottom line.',
      }) } }],
      openrouterMetadata: live,
    });
    const result = await new OpenRouterProvider(DEFAULT_OPENROUTER_MODEL, 'synthetic-test-key').synthesizeInterview(
      [],
      makeStudyConfig({ aiProvider: 'openrouter', aiModel: DEFAULT_OPENROUTER_MODEL }),
      { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] },
      null,
    );
    expect(result.execution).toMatchObject({ provider: 'openrouter', routedProvider: 'Azure' });
  });

  it('still refuses a synthesis whose upstream is not identified', async () => {
    providerRequest.mockReset();
    providerRequest.mockResolvedValue({
      model: DEFAULT_OPENROUTER_MODEL,
      choices: [{ message: { content: JSON.stringify({
        statedPreferences: [], revealedPreferences: [], themes: [], contradictions: [],
        keyInsights: ['A synthetic insight.'], bottomLine: 'A synthetic bottom line.',
      }) } }],
      openrouterMetadata: { attempt: 1, endpoints: { available: [] } },
    });
    const result = new OpenRouterProvider(DEFAULT_OPENROUTER_MODEL, 'synthetic-test-key').synthesizeInterview(
      [],
      makeStudyConfig({ aiProvider: 'openrouter', aiModel: DEFAULT_OPENROUTER_MODEL }),
      { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] },
      null,
    );
    await expect(result).rejects.toBeInstanceOf(ProviderFailure);
    await expect(result).rejects.toThrow('did not identify the upstream provider');
  });
});
