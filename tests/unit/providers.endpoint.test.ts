// @vitest-environment node

// RT-05 on the Cloudflare target: every native adapter is constructed with an
// explicit endpoint, so the SDKs' environment defaults (base URL, bearer
// token, organization/project, Vertex selection) can never move or change a
// request, and a missing key never falls back to process.env. Real SDKs; only
// global fetch is stubbed, and it answers every request with a synthetic 400.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIProvider } from '@/lib/ai';
import { ClaudeProvider } from '@/lib/providers/claude';
import {
  CF_AIG_HEADER_NAMES,
  cfAigRequestHeaders,
  covers,
  DIRECT_BASE_URL,
  effectiveTransport,
  GATEWAY_SLUG,
  providerEndpoint,
  providerRouteErrors,
  resolveProviderRoute,
  SDK_ENV_OVERRIDE_NAMES,
  sdkEnvOverrides,
  withExactGatewayHeaders,
} from '@/lib/providers/endpoint';
import { GeminiProvider } from '@/lib/providers/gemini';
import { getInterviewProvider } from '@/lib/providers';
import { OpenAIProvider } from '@/lib/providers/openai';
import { OpenRouterProvider } from '@/lib/providers/openrouter';
import type { AIProviderType } from '@/types';
import { makeStudyConfig } from '../fixtures/models';
import { CLOUDFLARE_SDK_OVERRIDE_NAMES } from '../../scripts/check-setup.mjs';

// What a stray Worker var or secret could set. The SDKs read these when
// constructed without explicit options.
const OVERRIDES: Record<string, string> = {
  ANTHROPIC_BASE_URL: 'https://anthropic-override.invalid',
  ANTHROPIC_AUTH_TOKEN: 'synthetic-override-bearer',
  OPENAI_BASE_URL: 'https://openai-override.invalid/v1',
  OPENAI_ORG_ID: 'org-synthetic-override',
  OPENAI_PROJECT_ID: 'proj-synthetic-override',
  GOOGLE_GEMINI_BASE_URL: 'https://gemini-override.invalid',
  GOOGLE_GENAI_USE_VERTEXAI: 'true',
  OPENROUTER_BASE_URL: 'https://openrouter-override.invalid/api/v1',
};

const KEYS = {
  claude: 'sk-ant-synthetic-key',
  openai: 'sk-synthetic-openai-key',
  gemini: 'synthetic-gemini-key',
  openrouter: 'sk-or-synthetic-key',
} satisfies Record<AIProviderType, string>;

const MODELS = {
  claude: 'claude-sonnet-5',
  openai: 'gpt-5.6-terra',
  gemini: 'gemini-3.7-flash',
  openrouter: 'openai/gpt-5.6-terra',
} satisfies Record<AIProviderType, string>;

const DIRECT_REQUEST_URL = {
  claude: 'https://api.anthropic.com/v1/messages',
  openai: 'https://api.openai.com/v1/responses',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/interactions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
} satisfies Record<AIProviderType, string>;

const ADAPTERS = {
  claude: ClaudeProvider,
  openai: OpenAIProvider,
  gemini: GeminiProvider,
  openrouter: OpenRouterProvider,
} satisfies Record<AIProviderType, unknown>;

const DIRECT = { transport: 'direct' } as const;
const behavior = { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] };
const history = [{ id: 'm1', role: 'user' as const, content: 'Hello', timestamp: 1 }];

type Captured = { url: string; headers: Record<string, string> };
let captured: Captured[] = [];
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  const touched = [
    ...Object.keys(OVERRIDES),
    'DEPLOYMENT_TARGET', 'DEPLOYMENT_MODE', 'AI_TRANSPORT',
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY',
  ];
  for (const name of touched) saved[name] = process.env[name];
  Object.assign(process.env, OVERRIDES);
});

afterAll(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

beforeEach(() => {
  captured = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    captured.push({ url: request.url, headers: Object.fromEntries(request.headers.entries()) });
    return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'synthetic refusal' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.DEPLOYMENT_TARGET;
  delete process.env.DEPLOYMENT_MODE;
  delete process.env.AI_TRANSPORT;
});

async function firstRequest(provider: AIProvider, type: AIProviderType): Promise<Captured> {
  await provider
    .synthesizeInterview(history, makeStudyConfig({ aiProvider: type, aiModel: MODELS[type] }), behavior, null)
    .then(() => undefined, () => undefined);
  expect(captured.length).toBeGreaterThanOrEqual(1);
  return captured[0];
}

const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const GATEWAY_ID = 'oi-example-staging';
const RUN_TOKEN = 'synthetic-ai-gateway-run-token-0123456789';
const GATEWAY_ENV = {
  AI_TRANSPORT: 'cloudflare-gateway',
  CF_AI_GATEWAY_ACCOUNT_ID: ACCOUNT_ID,
  CF_AI_GATEWAY_ID: GATEWAY_ID,
  CF_AI_GATEWAY_TOKEN: RUN_TOKEN,
};
const GATEWAY_ROUTE = { transport: 'cloudflare-gateway', accountId: ACCOUNT_ID, gatewayId: GATEWAY_ID, token: RUN_TOKEN } as const;

describe('RT-05 provider endpoint seams', () => {
  it('resolves the direct route, and refuses any other transport or an SDK override name', () => {
    expect(resolveProviderRoute({})).toEqual({ ok: true, route: DIRECT });
    expect(resolveProviderRoute({ AI_TRANSPORT: ' direct ' })).toEqual({ ok: true, route: DIRECT });
    expect(resolveProviderRoute({ AI_TRANSPORT: 'gateway' })).toEqual({ ok: false, error: 'invalid_ai_transport' });
    expect(resolveProviderRoute({ AI_TRANSPORT: 'cloudflare' })).toEqual({ ok: false, error: 'invalid_ai_transport' });
    for (const name of SDK_ENV_OVERRIDE_NAMES) {
      expect(resolveProviderRoute({ AI_TRANSPORT: 'direct', [name]: '' })).toEqual({ ok: false, error: 'provider_sdk_env_override' });
      expect(resolveProviderRoute({ ...GATEWAY_ENV, [name]: '' })).toEqual({ ok: false, error: 'provider_sdk_env_override' });
    }
    expect(sdkEnvOverrides({ OPENAI_LOG: 'debug', GEMINI_API_KEY: 'k', OTHER: 'x' })).toEqual(['OPENAI_LOG']);
  });

  it('RT-11: resolves the Cloudflare AI Gateway route from exact, validated identifiers and a Run token', () => {
    expect(resolveProviderRoute(GATEWAY_ENV)).toEqual({ ok: true, route: GATEWAY_ROUTE });
    // A token may stay bound on direct: it is never sent there.
    expect(resolveProviderRoute({ AI_TRANSPORT: 'direct', CF_AI_GATEWAY_TOKEN: RUN_TOKEN })).toEqual({ ok: true, route: DIRECT });
  });

  it.each<[string, Record<string, string | undefined>, string]>([
    ['a missing account ID', { CF_AI_GATEWAY_ACCOUNT_ID: undefined }, 'invalid_cf_ai_gateway_account_id'],
    ['an uppercase account ID', { CF_AI_GATEWAY_ACCOUNT_ID: ACCOUNT_ID.toUpperCase() }, 'invalid_cf_ai_gateway_account_id'],
    ['a padded account ID', { CF_AI_GATEWAY_ACCOUNT_ID: ` ${ACCOUNT_ID}` }, 'invalid_cf_ai_gateway_account_id'],
    ['a short account ID', { CF_AI_GATEWAY_ACCOUNT_ID: ACCOUNT_ID.slice(1) }, 'invalid_cf_ai_gateway_account_id'],
    ['the default gateway', { CF_AI_GATEWAY_ID: 'default' }, 'invalid_cf_ai_gateway_id'],
    ['an empty gateway ID', { CF_AI_GATEWAY_ID: '' }, 'invalid_cf_ai_gateway_id'],
    ['a gateway ID with a slash', { CF_AI_GATEWAY_ID: 'oi/other' }, 'invalid_cf_ai_gateway_id'],
    ['an uppercase gateway ID', { CF_AI_GATEWAY_ID: 'OI-Staging' }, 'invalid_cf_ai_gateway_id'],
    ['a trailing-hyphen gateway ID', { CF_AI_GATEWAY_ID: 'oi-' }, 'invalid_cf_ai_gateway_id'],
    ['a 65-character gateway ID', { CF_AI_GATEWAY_ID: 'a'.repeat(65) }, 'invalid_cf_ai_gateway_id'],
    ['a missing token', { CF_AI_GATEWAY_TOKEN: undefined }, 'missing_cf_ai_gateway_token'],
    ['an empty token', { CF_AI_GATEWAY_TOKEN: '' }, 'missing_cf_ai_gateway_token'],
    ['a short token', { CF_AI_GATEWAY_TOKEN: 'x'.repeat(31) }, 'weak_cf_ai_gateway_token'],
    ['a token with whitespace', { CF_AI_GATEWAY_TOKEN: `${RUN_TOKEN} ` }, 'weak_cf_ai_gateway_token'],
  ])('RT-11: refuses %s, with no fallback to direct', (_label, override, error) => {
    const env: Record<string, string | undefined> = { ...GATEWAY_ENV, ...override };
    for (const [name, value] of Object.entries(override)) if (value === undefined) delete env[name];
    expect(resolveProviderRoute(env)).toEqual({ ok: false, error });
    expect(providerRouteErrors(env)).toEqual([error]);
  });

  it('RT-11: gateway identifiers without the gateway transport are refused', () => {
    expect(resolveProviderRoute({ AI_TRANSPORT: 'direct', CF_AI_GATEWAY_ACCOUNT_ID: ACCOUNT_ID }))
      .toEqual({ ok: false, error: 'cf_ai_gateway_config_without_transport' });
    expect(resolveProviderRoute({ CF_AI_GATEWAY_ID: GATEWAY_ID })).toEqual({ ok: false, error: 'cf_ai_gateway_config_without_transport' });
    // Empty template values are the direct installation's normal state.
    expect(resolveProviderRoute({ AI_TRANSPORT: 'direct', CF_AI_GATEWAY_ACCOUNT_ID: '', CF_AI_GATEWAY_ID: '' }))
      .toEqual({ ok: true, route: DIRECT });
  });

  it.each(Object.keys(DIRECT_BASE_URL) as AIProviderType[])('RT-11: sends %s to its native gateway path with exactly six cf-aig headers', (type) => {
    const endpoint = providerEndpoint(type, GATEWAY_ROUTE);
    expect(effectiveTransport(GATEWAY_ROUTE, type)).toBe('cloudflare-gateway');
    expect(endpoint.transport).toBe('cloudflare-gateway');
    expect(endpoint.baseURL).toBe(`https://gateway.ai.cloudflare.com/v1/${ACCOUNT_ID}/${GATEWAY_ID}/${GATEWAY_SLUG[type]}`);
    expect(endpoint.headers).toEqual({
      'cf-aig-authorization': `Bearer ${RUN_TOKEN}`,
      'cf-aig-collect-log': 'false',
      'cf-aig-collect-log-payload': 'false',
      'cf-aig-skip-cache': 'true',
      'cf-aig-max-attempts': '1',
      'cf-aig-no-wholesale': 'true',
    });
    expect(new Set(Object.keys(endpoint.headers))).toEqual(new Set(CF_AIG_HEADER_NAMES));
  });

  it('D9: covers() admits direct always and a gateway only when it was disclosed', () => {
    expect(covers('direct', 'direct')).toBe(true);
    expect(covers('cloudflare-gateway', 'direct')).toBe(true);
    expect(covers('cloudflare-gateway', 'cloudflare-gateway')).toBe(true);
    expect(covers('direct', 'cloudflare-gateway')).toBe(false);
  });

  it('RT-11: makes the cf-aig set exact whatever a request already carried', () => {
    const headers = new Headers({
      'cf-aig-cache-key': 'stray',
      'CF-AIG-Cache-TTL': '3600',
      'cf-aig-collect-log': 'true',
      'x-api-key': 'kept',
    });
    withExactGatewayHeaders(headers, cfAigRequestHeaders(RUN_TOKEN));
    const names = [...headers.keys()];
    expect(new Set(names.filter((name) => name.startsWith('cf-aig-')))).toEqual(new Set(CF_AIG_HEADER_NAMES));
    expect(headers.get('cf-aig-collect-log')).toBe('false');
    expect(headers.get('x-api-key')).toBe('kept');
  });

  it('refuses the same SDK override names as setup:check', () => {
    expect([...SDK_ENV_OVERRIDE_NAMES]).toEqual(CLOUDFLARE_SDK_OVERRIDE_NAMES);
  });

  it.each(Object.keys(DIRECT_BASE_URL) as AIProviderType[])('gives %s its pinned direct endpoint with no extra headers', (type) => {
    expect(effectiveTransport(DIRECT, type)).toBe('direct');
    expect(providerEndpoint(type, DIRECT)).toEqual({ transport: 'direct', baseURL: DIRECT_BASE_URL[type], headers: {} });
  });
});

describe.each(Object.keys(ADAPTERS) as AIProviderType[])('RT-05 %s adapter with an explicit endpoint', (type) => {
  it('sends to the provider\'s own host whatever the SDK environment variables say', async () => {
    const Adapter = ADAPTERS[type];
    const request = await firstRequest(new Adapter(MODELS[type], KEYS[type], providerEndpoint(type, DIRECT)), type);
    expect(request.url).toBe(DIRECT_REQUEST_URL[type]);
    expect(request.headers).not.toHaveProperty('openai-organization');
    expect(request.headers).not.toHaveProperty('openai-project');
    if (type !== 'openai' && type !== 'openrouter') expect(request.headers).not.toHaveProperty('authorization');
    expect(Object.keys(request.headers).filter((name) => name.startsWith('cf-aig-'))).toEqual([]);
  });

  it('control: without an endpoint (the Node construction) the same environment moves the request', async () => {
    const Adapter = ADAPTERS[type];
    const request = await firstRequest(new Adapter(MODELS[type], KEYS[type]), type);
    expect(request.url).not.toBe(DIRECT_REQUEST_URL[type]);
  });
});

describe('RT-05 Cloudflare provider factory', () => {
  const cloudflare = () => {
    process.env.DEPLOYMENT_TARGET = 'cloudflare';
    process.env.DEPLOYMENT_MODE = 'standalone';
    process.env.AI_TRANSPORT = 'direct';
  };

  it.each([
    ['claude', 'ANTHROPIC_API_KEY'],
    ['openai', 'OPENAI_API_KEY'],
    ['gemini', 'GEMINI_API_KEY'],
    ['openrouter', 'OPENROUTER_API_KEY'],
  ] as const)('refuses a missing %s key instead of reading %s from process.env', (type, envName) => {
    cloudflare();
    process.env[envName] = `synthetic-process-env-${type}-key`;
    try {
      expect(() => getInterviewProvider(makeStudyConfig({ aiProvider: type, aiModel: MODELS[type] }), { route: DIRECT }))
        .toThrow(`${envName} is required`);
    } finally {
      delete process.env[envName];
    }
  });

  it('refuses to construct any adapter without a resolved route', () => {
    cloudflare();
    expect(() => getInterviewProvider(makeStudyConfig({ aiProvider: 'claude', aiModel: MODELS.claude }), { anthropicApiKey: KEYS.claude }))
      .toThrow('The provider route is not configured for this deployment');
  });

  it('builds the adapter on the explicit direct endpoint', async () => {
    cloudflare();
    const provider = getInterviewProvider(
      makeStudyConfig({ aiProvider: 'claude', aiModel: MODELS.claude }),
      { anthropicApiKey: KEYS.claude, route: DIRECT },
    );
    const request = await firstRequest(provider, 'claude');
    expect(request.url).toBe(DIRECT_REQUEST_URL.claude);
    expect(request.headers['x-api-key']).toBe(KEYS.claude);
    expect(request.headers).not.toHaveProperty('authorization');
  });
});
