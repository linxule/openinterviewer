// @vitest-environment node

// RT-11 at the network boundary: the four native adapters, built by the
// Cloudflare provider factory on the Cloudflare AI Gateway route, with the
// real SDKs. Only global fetch is stubbed; it records every request and
// answers with a synthetic provider body. Each call must reach exactly its
// provider's native gateway path, carry the provider's own credential and
// exactly the six cf-aig-* headers, be sent once, and report the gateway in
// its execution provenance.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIProvider, ProviderExecution } from '@/lib/ai';
import { getInterviewProvider } from '@/lib/providers';
import { CF_AIG_HEADER_NAMES, type ProviderRoute } from '@/lib/providers/endpoint';
import { ProviderFailure } from '@/lib/providerErrors';
import type { AggregateSynthesisResult, AIProviderType, SynthesisResult } from '@/types';
import { makeStudyConfig } from '../fixtures/models';

const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const GATEWAY_ID = 'oi-example';
const RUN_TOKEN = 'synthetic-ai-gateway-run-token-0123456789';
const ROUTE: ProviderRoute = { transport: 'cloudflare-gateway', accountId: ACCOUNT_ID, gatewayId: GATEWAY_ID, token: RUN_TOKEN };
const BASE = `https://gateway.ai.cloudflare.com/v1/${ACCOUNT_ID}/${GATEWAY_ID}`;

const REQUEST_URL = {
  claude: `${BASE}/anthropic/v1/messages`,
  openai: `${BASE}/openai/responses`,
  gemini: `${BASE}/google-ai-studio/v1beta/interactions`,
  openrouter: `${BASE}/openrouter/chat/completions`,
} satisfies Record<AIProviderType, string>;

const KEYS = {
  claude: 'sk-ant-synthetic-gateway-key',
  openai: 'sk-synthetic-openai-gateway-key',
  gemini: 'synthetic-gemini-gateway-key',
  openrouter: 'sk-or-synthetic-gateway-key',
} satisfies Record<AIProviderType, string>;

const MODELS = {
  claude: { requested: 'claude-sonnet-5', served: 'claude-sonnet-5-20260901' },
  openai: { requested: 'gpt-5.6-terra', served: 'gpt-5.6-terra-2026-09-01' },
  gemini: { requested: 'gemini-3.7-flash', served: 'gemini-3.7-flash-001' },
  openrouter: { requested: 'openai/gpt-5.6-terra', served: 'openai/gpt-5.6-terra-2026-09-01' },
} satisfies Record<AIProviderType, { requested: string; served: string }>;

const PROVIDERS = Object.keys(MODELS) as AIProviderType[];

const SYNTHESIS: SynthesisResult = {
  statedPreferences: ['Speed'],
  revealedPreferences: ['Efficiency'],
  themes: [{ theme: 'Speed', frequency: 1, evidenceRefs: [{ quote: 'fast', turnIndex: 1 }] }],
  contradictions: [],
  keyInsights: ['Participants value speed'],
  bottomLine: 'Speed matters.',
};
const PAYLOADS = {
  greeting: 'Hello, and thank you for joining.',
  interview: JSON.stringify({
    message: 'Tell me more about your first week.',
    questionAddressed: 0,
    phaseTransition: null,
    profileUpdates: [],
    shouldConclude: false,
  }),
  synthesis: JSON.stringify(SYNTHESIS),
  aggregate: JSON.stringify({
    commonThemes: [{ theme: 'Speed', frequency: 2, quoteRefs: [{ interviewIndex: 1, turnIndex: 1, quote: 'fast' }] }],
    divergentViews: [],
    keyFindings: ['Speed dominates'],
    researchImplications: ['Study trade-offs'],
    bottomLine: 'Speed consistently matters.',
  }),
  followup: JSON.stringify({
    name: 'Follow-up: speed',
    researchQuestion: 'When does speed matter?',
    coreQuestions: ['When is speed most important?'],
  }),
};

type Captured = { url: string; method: string; headers: Record<string, string> };
let captured: Captured[] = [];
let nextText = PAYLOADS.synthesis;
let nextStatus = 200;
let nextErrorBody: unknown = null;
const saved: Record<string, string | undefined> = {};
const TOUCHED = ['DEPLOYMENT_TARGET', 'DEPLOYMENT_MODE', 'AI_TRANSPORT', 'ANTHROPIC_CUSTOM_HEADERS', 'OPENAI_CUSTOM_HEADERS'];

function providerOf(url: string): AIProviderType {
  const slug = new URL(url).pathname.split('/')[4];
  return ({ anthropic: 'claude', openai: 'openai', 'google-ai-studio': 'gemini', openrouter: 'openrouter' } as const)[
    slug as 'anthropic' | 'openai' | 'google-ai-studio' | 'openrouter'
  ];
}

function successBody(provider: AIProviderType, text: string): unknown {
  const served = MODELS[provider].served;
  switch (provider) {
    case 'openai':
      return {
        id: 'resp_synthetic', object: 'response', created_at: 1, status: 'completed', model: served,
        output: [{ type: 'message', id: 'msg_synthetic', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      };
    case 'claude':
      return {
        id: 'msg_synthetic', type: 'message', role: 'assistant', model: served,
        content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    case 'gemini':
      return {
        id: 'interaction_synthetic', model: served, status: 'completed', role: 'model',
        created: '2026-09-24T00:00:00Z', updated: '2026-09-24T00:00:00Z',
        steps: [{ type: 'model_output', content: [{ type: 'text', text }] }],
      };
    case 'openrouter':
      return {
        id: 'gen_synthetic', object: 'chat.completion', created: 1, model: served, system_fingerprint: null,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }],
        openrouter_metadata: {
          attempt: 1,
          attempts: [{ model: MODELS.openrouter.requested, provider: 'OpenAI', status: 200 }],
          endpoints: { available: [], total: 0 },
          is_byok: false,
          region: null,
          requested: MODELS.openrouter.requested,
          strategy: 'direct',
          summary: 'synthetic',
        },
      };
  }
}

beforeAll(() => {
  for (const name of TOUCHED) saved[name] = process.env[name];
});

afterAll(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

beforeEach(() => {
  process.env.DEPLOYMENT_TARGET = 'cloudflare';
  process.env.DEPLOYMENT_MODE = 'standalone';
  process.env.AI_TRANSPORT = 'cloudflare-gateway';
  captured = [];
  nextText = PAYLOADS.synthesis;
  nextStatus = 200;
  nextErrorBody = null;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    captured.push({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers.entries()) });
    if (nextStatus !== 200) {
      return new Response(JSON.stringify(nextErrorBody ?? { error: { type: 'api_error', message: 'synthetic' } }), {
        status: nextStatus,
        headers: { 'content-type': 'application/json', 'retry-after-ms': '1' },
      });
    }
    return Response.json(successBody(providerOf(request.url), nextText));
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const name of TOUCHED) delete process.env[name];
});

function adapter(provider: AIProviderType): AIProvider {
  const keys = {
    anthropicApiKey: provider === 'claude' ? KEYS.claude : null,
    openaiApiKey: provider === 'openai' ? KEYS.openai : null,
    geminiApiKey: provider === 'gemini' ? KEYS.gemini : null,
    openrouterApiKey: provider === 'openrouter' ? KEYS.openrouter : null,
    route: ROUTE,
  };
  return getInterviewProvider(makeStudyConfig({ aiProvider: provider, aiModel: MODELS[provider].requested }), keys);
}

function config(provider: AIProviderType) {
  return makeStudyConfig({ aiProvider: provider, aiModel: MODELS[provider].requested });
}

const history = [
  { id: 'm1', role: 'ai' as const, content: 'What was your first week like?', timestamp: 1 },
  { id: 'm2', role: 'user' as const, content: 'It was fast.', timestamp: 2 },
];
const behavior = { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] };
const progress = { questionsAsked: [], total: 1, currentPhase: 'background' as const, isComplete: false };

function aggregateResult(provider: AIProviderType): AggregateSynthesisResult {
  return {
    studyId: 'study-1', studyRevision: 1, interviewIds: ['i1', 'i2'], interviewCount: 2,
    aiProvider: provider, aiModel: MODELS[provider].served, requestedAiModel: MODELS[provider].requested,
    commonThemes: [{ theme: 'Speed', frequency: 2 }], divergentViews: [], keyFindings: ['Speed'],
    researchImplications: ['More'], bottomLine: 'Speed matters.', generatedAt: 1,
  };
}

type Operation = 'greeting' | 'interview' | 'synthesis' | 'queued-synthesis' | 'aggregate' | 'followup';

async function run(provider: AIProviderType, operation: Operation): Promise<ProviderExecution | null> {
  const p = adapter(provider);
  switch (operation) {
    case 'greeting':
      nextText = PAYLOADS.greeting;
      await p.getInterviewGreeting(config(provider));
      return null;
    case 'interview':
      nextText = PAYLOADS.interview;
      await p.generateInterviewResponse(history, config(provider), null, progress, '');
      return null;
    case 'synthesis':
      nextText = PAYLOADS.synthesis;
      return (await p.synthesizeInterview(history, config(provider), behavior, null)).execution;
    case 'queued-synthesis':
      nextText = PAYLOADS.synthesis;
      return (await p.synthesizeInterview(history, config(provider), behavior, null, { kind: 'queued-synthesis', deadlineMs: 5_000 })).execution;
    case 'aggregate':
      nextText = PAYLOADS.aggregate;
      return (await p.synthesizeAggregate(config(provider), [SYNTHESIS, SYNTHESIS], 2)).execution;
    case 'followup':
      nextText = PAYLOADS.followup;
      return (await p.generateFollowupStudy(config(provider), aggregateResult(provider))).execution;
  }
}

function expectGatewayRequest(provider: AIProviderType, request: Captured): void {
  expect(request.method).toBe('POST');
  expect(request.url.split('?')[0]).toBe(REQUEST_URL[provider]);
  const cfAig = Object.keys(request.headers).filter((name) => name.startsWith('cf-aig-'));
  expect(new Set(cfAig)).toEqual(new Set(CF_AIG_HEADER_NAMES));
  expect(cfAig).toHaveLength(CF_AIG_HEADER_NAMES.length);
  expect(request.headers).toMatchObject({
    'cf-aig-authorization': `Bearer ${RUN_TOKEN}`,
    'cf-aig-collect-log': 'false',
    'cf-aig-collect-log-payload': 'false',
    'cf-aig-skip-cache': 'true',
    'cf-aig-max-attempts': '1',
    'cf-aig-no-wholesale': 'true',
  });
  // The provider's own credential travels on the request (no stored keys).
  switch (provider) {
    case 'claude':
      expect(request.headers['x-api-key']).toBe(KEYS.claude);
      expect(request.headers).not.toHaveProperty('authorization');
      break;
    case 'gemini':
      expect(request.headers['x-goog-api-key']).toBe(KEYS.gemini);
      expect(request.headers).not.toHaveProperty('authorization');
      break;
    case 'openai':
      expect(request.headers.authorization).toBe(`Bearer ${KEYS.openai}`);
      break;
    case 'openrouter':
      expect(request.headers.authorization).toBe(`Bearer ${KEYS.openrouter}`);
      break;
  }
  // The Run token is never the provider credential.
  expect(Object.entries(request.headers).filter(([, value]) => value.includes(RUN_TOKEN)).map(([name]) => name))
    .toEqual(['cf-aig-authorization']);
}

describe.each(PROVIDERS)('RT-11 %s through Cloudflare AI Gateway', (provider) => {
  it.each<Operation>(['greeting', 'interview', 'synthesis', 'queued-synthesis', 'aggregate', 'followup'])(
    '%s: one request to the native gateway path with the provider key and exactly the six cf-aig headers',
    async (operation) => {
      const execution = await run(provider, operation);

      expect(captured).toHaveLength(1);
      expectGatewayRequest(provider, captured[0]);
      if (execution) {
        expect(execution).toMatchObject({
          provider,
          requestedModel: MODELS[provider].requested,
          // The served model still comes from the response body.
          model: MODELS[provider].served,
          aiTransport: 'cloudflare-gateway',
        });
        if (provider === 'openrouter') expect(execution.routedProvider).toBe('OpenAI');
        else expect(execution).not.toHaveProperty('routedProvider');
      }
    },
  );

  it('queued synthesis: a gateway 500 is one request and an uncertain (unavailable) failure, never a retry', async () => {
    nextStatus = 500;
    const outcome = adapter(provider).synthesizeInterview(
      history, config(provider), behavior, null, { kind: 'queued-synthesis', deadlineMs: 5_000 },
    );

    await expect(outcome).rejects.toBeInstanceOf(ProviderFailure);
    await expect(outcome).rejects.toMatchObject({ kind: 'unavailable' });
    expect(captured).toHaveLength(1);
    expectGatewayRequest(provider, captured[0]);
  });

  it('D12: a 401 AiGatewayError is a known configuration failure, sent once, logged with origin gateway only', async () => {
    nextStatus = 401;
    // The members recorded from a live unauthenticated probe (gw-cfDocs §8);
    // the rest of the live body is a remote gate (DEVIATIONS).
    nextErrorBody = {
      success: false,
      name: 'AiGatewayError',
      httpCode: 401,
      internalCode: 2009,
      message: 'Unauthorized',
    };
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => { logged.push(String(line)); });

    const outcome = adapter(provider).synthesizeInterview(
      history, config(provider), behavior, null, { kind: 'queued-synthesis', deadlineMs: 5_000 },
    );

    await expect(outcome).rejects.toMatchObject({ kind: 'config' });
    expect(captured).toHaveLength(1);
    const failure = logged.map((line) => JSON.parse(line)).find((entry) => entry.event === 'provider.failure');
    expect(failure).toMatchObject({ provider, operation: 'synthesis', status: 401, origin: 'gateway' });
    expect(Object.keys(failure).sort()).toEqual(['errorType', 'event', 'operation', 'origin', 'provider', 'status', 'ts']);
    expect(logged.join('\n')).not.toMatch(/Unauthorized|2009|synthetic-ai-gateway-run-token/);
  });
});

describe('RT-11 header set is exact whatever the SDK environment says', () => {
  it.each([
    ['claude', 'ANTHROPIC_CUSTOM_HEADERS'],
    ['openai', 'OPENAI_CUSTOM_HEADERS'],
  ] as const)('%s: %s cannot add cf-aig-cache-key or turn logging back on', async (provider, envName) => {
    // Readiness refuses these names on Cloudflare; this is the wire-level backstop.
    process.env[envName] = 'cf-aig-cache-key: stray\ncf-aig-collect-log: true\ncf-aig-cache-ttl: 3600';

    await run(provider, 'queued-synthesis');

    expect(captured).toHaveLength(1);
    expectGatewayRequest(provider, captured[0]);
    expect(captured[0].headers).not.toHaveProperty('cf-aig-cache-key');
    expect(captured[0].headers['cf-aig-collect-log']).toBe('false');
  });
});

describe('RT-11 the direct route carries no cf-aig header and records no transport', () => {
  it.each(PROVIDERS)('%s', async (provider) => {
    process.env.AI_TRANSPORT = 'direct';
    const keys = {
      anthropicApiKey: KEYS.claude, openaiApiKey: KEYS.openai, geminiApiKey: KEYS.gemini, openrouterApiKey: KEYS.openrouter,
      route: { transport: 'direct' } as const,
    };
    nextText = PAYLOADS.synthesis;
    // The stub answers by gateway slug; answer direct hosts by provider. The
    // Stainless SDKs capture fetch when constructed, so stub first.
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      captured.push({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers.entries()) });
      return Response.json(successBody(provider, nextText));
    }));
    const p = getInterviewProvider(config(provider), keys);

    const result = await p.synthesizeInterview(history, config(provider), behavior, null, { kind: 'queued-synthesis', deadlineMs: 5_000 });

    expect(captured).toHaveLength(1);
    expect(captured[0].url).not.toContain('gateway.ai.cloudflare.com');
    expect(Object.keys(captured[0].headers).filter((name) => name.startsWith('cf-aig-'))).toEqual([]);
    expect(result.execution).not.toHaveProperty('aiTransport');
  });
});
