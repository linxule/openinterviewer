// Provider endpoints on the Cloudflare target (RT-05, RT-11). Every native
// adapter there receives an explicit endpoint, so no SDK ever falls back to
// an environment default for its base URL, credentials or headers. Pure: no
// Next, Redis or process.env; callers pass the Worker env.
//
// resolveProviderRoute() is shared by the fetch path, the Queue consumer and
// readiness, so the three cannot drift; providerEndpoint(provider, route) and
// effectiveTransport(route, provider) are the only places that turn a route
// into a destination. Two routes exist: `direct` (each provider's own API)
// and `cloudflare-gateway` (the installation's Cloudflare AI Gateway, on each
// provider's native gateway path, with a fixed header set).

import type { AIProviderType } from '@/types';

export type EffectiveTransport = 'direct' | 'cloudflare-gateway';

export type ProviderRoute =
  | { readonly transport: 'direct' }
  | {
    readonly transport: 'cloudflare-gateway';
    readonly accountId: string;
    readonly gatewayId: string;
    /** AI Gateway Run token. Never logged, returned or persisted. */
    readonly token: string;
  };

export type ProviderEndpoint = {
  readonly transport: EffectiveTransport;
  readonly baseURL: string;
  /** Extra request headers: none on the direct route, exactly the cf-aig-* set on the gateway. */
  readonly headers: Readonly<Record<string, string>>;
};

/** Each SDK's own default, pinned so an environment variable cannot move it. */
export const DIRECT_BASE_URL: Readonly<Record<AIProviderType, string>> = {
  gemini: 'https://generativelanguage.googleapis.com',
  claude: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
};

/** The only AI Gateway host. There is no configurable gateway URL. */
export const CF_AI_GATEWAY_ORIGIN = 'https://gateway.ai.cloudflare.com';

/** Provider-native gateway path segments (never compat, universal, REST or dynamic routes). */
export const GATEWAY_SLUG: Readonly<Record<AIProviderType, string>> = {
  gemini: 'google-ai-studio',
  claude: 'anthropic',
  openai: 'openai',
  openrouter: 'openrouter',
};

/**
 * Appended to the OpenRouter gateway base. The Cloudflare page shows both
 * `…/openrouter/chat/completions` (prose) and `…/openrouter/v1/chat/completions`
 * (curl); the prose form is used, and was confirmed live on 24 September 2026
 * (spike S2: requests and `openrouterMetadata` pass through).
 */
export const OPENROUTER_GATEWAY_SUFFIX = '';

/**
 * The exact cf-aig-* request headers of the gateway route: authenticate,
 * store no log entry and no payload, bypass the cache, allow one attempt, and
 * never fall through to Cloudflare-billed credentials. No other cf-aig-*
 * header is ever sent (never cache-key, cache-ttl, request-timeout, metadata,
 * byok-alias or custom-cost).
 */
export function cfAigRequestHeaders(token: string): Readonly<Record<string, string>> {
  return {
    'cf-aig-authorization': `Bearer ${token}`,
    'cf-aig-collect-log': 'false',
    'cf-aig-collect-log-payload': 'false',
    'cf-aig-skip-cache': 'true',
    'cf-aig-max-attempts': '1',
    'cf-aig-no-wholesale': 'true',
  };
}

export const CF_AIG_HEADER_NAMES = Object.keys(cfAigRequestHeaders('x')) as readonly string[];

/**
 * Environment names the installed SDKs read when constructed or called:
 * base URLs, auth tokens, custom headers, request logging, Vertex or
 * enterprise selection, API version and project, and attribution headers.
 * Refused on Cloudflare whatever their value (readiness, check-setup and
 * route resolution). Sources: @anthropic-ai/sdk client.mjs, openai
 * client.mjs, @google/genai dist/node/index.mjs, @openrouter/sdk lib/env.js.
 */
export const SDK_ENV_OVERRIDE_NAMES = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_LOG',
  'OPENAI_BASE_URL',
  'OPENAI_CUSTOM_HEADERS',
  'OPENAI_LOG',
  'OPENAI_ORG_ID',
  'OPENAI_PROJECT_ID',
  'GOOGLE_GEMINI_BASE_URL',
  'GOOGLE_VERTEX_BASE_URL',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_GENAI_USE_ENTERPRISE',
  'GOOGLE_GENAI_API_VERSION',
  'GOOGLE_GENAI_USER_PROJECT',
  'GOOGLE_GENAI_DEBUG',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'OPENROUTER_BASE_URL',
  'OPENROUTER_DEBUG',
  'OPENROUTER_HTTP_REFERER',
  'OPENROUTER_APP_TITLE',
  'OPENROUTER_APP_CATEGORIES',
] as const;

type RouteEnv = Readonly<Record<string, unknown>>;

/** SDK override names present in `env` (any value, including empty). */
export function sdkEnvOverrides(env: RouteEnv): string[] {
  return SDK_ENV_OVERRIDE_NAMES.filter((name) => Object.prototype.hasOwnProperty.call(env, name)
    && env[name] !== undefined);
}

export const CF_AI_GATEWAY_ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/;
export const CF_AI_GATEWAY_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const MIN_CF_AI_GATEWAY_TOKEN_LENGTH = 32;

export type ProviderRouteError =
  | 'invalid_ai_transport'
  | 'provider_sdk_env_override'
  | 'invalid_cf_ai_gateway_account_id'
  | 'invalid_cf_ai_gateway_id'
  | 'missing_cf_ai_gateway_token'
  | 'weak_cf_ai_gateway_token'
  | 'cf_ai_gateway_config_without_transport';

export type ProviderRouteResolution =
  | { ok: true; route: ProviderRoute }
  | { ok: false; error: ProviderRouteError };

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Whether a bound Run token is structurally usable: long enough, no whitespace. */
export function isWellFormedGatewayToken(token: string): boolean {
  return token.length >= MIN_CF_AI_GATEWAY_TOKEN_LENGTH && !/\s/.test(token);
}

/**
 * Every route error of a Cloudflare Worker env, in a fixed order. Readiness
 * reports them all; resolveProviderRoute refuses on the first.
 *
 * - AI_TRANSPORT: empty or `direct`, or `cloudflare-gateway`; anything else is refused.
 * - Any SDK override name is refused.
 * - `cloudflare-gateway` needs a 32-hex account ID, a gateway ID other than
 *   `default`, and a well-formed Run token. The identifiers are used exactly
 *   as bound (never trimmed).
 * - On `direct` the two gateway identifiers must be empty. A Run token may
 *   stay bound (it is never sent on the direct route), so switching back to
 *   direct needs no secret deletion.
 */
export function providerRouteErrors(env: RouteEnv): ProviderRouteError[] {
  const errors: ProviderRouteError[] = [];
  const raw = env.AI_TRANSPORT;
  const transport = typeof raw === 'string' ? raw.trim() : raw;
  const gateway = transport === 'cloudflare-gateway';
  if (transport !== undefined && transport !== '' && transport !== 'direct' && !gateway) {
    errors.push('invalid_ai_transport');
  }
  if (sdkEnvOverrides(env).length > 0) errors.push('provider_sdk_env_override');
  const accountId = text(env.CF_AI_GATEWAY_ACCOUNT_ID);
  const gatewayId = text(env.CF_AI_GATEWAY_ID);
  if (gateway) {
    if (!CF_AI_GATEWAY_ACCOUNT_ID_PATTERN.test(accountId)) errors.push('invalid_cf_ai_gateway_account_id');
    if (!CF_AI_GATEWAY_ID_PATTERN.test(gatewayId) || gatewayId === 'default') errors.push('invalid_cf_ai_gateway_id');
    const token = text(env.CF_AI_GATEWAY_TOKEN);
    if (!token) errors.push('missing_cf_ai_gateway_token');
    else if (!isWellFormedGatewayToken(token)) errors.push('weak_cf_ai_gateway_token');
  } else if (accountId !== '' || gatewayId !== '') {
    errors.push('cf_ai_gateway_config_without_transport');
  }
  return errors;
}

/**
 * The provider route of a Cloudflare Worker env. There is no fallback route:
 * a malformed gateway configuration never degrades to direct.
 */
export function resolveProviderRoute(env: RouteEnv): ProviderRouteResolution {
  const errors = providerRouteErrors(env);
  if (errors.length > 0) return { ok: false, error: errors[0] };
  const transport = typeof env.AI_TRANSPORT === 'string' ? env.AI_TRANSPORT.trim() : '';
  if (transport === 'cloudflare-gateway') {
    return {
      ok: true,
      route: {
        transport: 'cloudflare-gateway',
        accountId: text(env.CF_AI_GATEWAY_ACCOUNT_ID),
        gatewayId: text(env.CF_AI_GATEWAY_ID),
        token: text(env.CF_AI_GATEWAY_TOKEN),
      },
    };
  }
  return { ok: true, route: { transport: 'direct' } };
}

/**
 * The transport a request for `provider` actually uses on `route`. Per
 * provider so that a provider the gateway cannot serve can stay direct and
 * still be disclosed truthfully (gw-final D14); today every provider follows
 * the route.
 */
export function effectiveTransport(route: ProviderRoute, provider: AIProviderType): EffectiveTransport {
  void provider;
  return route.transport;
}

export function providerEndpoint(provider: AIProviderType, route: ProviderRoute): ProviderEndpoint {
  const transport = effectiveTransport(route, provider);
  if (transport === 'cloudflare-gateway' && route.transport === 'cloudflare-gateway') {
    const suffix = provider === 'openrouter' ? OPENROUTER_GATEWAY_SUFFIX : '';
    return {
      transport,
      baseURL: `${CF_AI_GATEWAY_ORIGIN}/v1/${route.accountId}/${route.gatewayId}/${GATEWAY_SLUG[provider]}${suffix}`,
      headers: cfAigRequestHeaders(route.token),
    };
  }
  return { transport: 'direct', baseURL: DIRECT_BASE_URL[provider], headers: {} };
}

export function isEffectiveTransport(value: unknown): value is EffectiveTransport {
  return value === 'direct' || value === 'cloudflare-gateway';
}

/**
 * Whether participant content consented under `disclosed` may be sent on
 * `current` (D9). Direct is always covered: it sends to the named provider
 * only, which every disclosure names. Anything else must match exactly.
 */
export function covers(disclosed: EffectiveTransport, current: EffectiveTransport): boolean {
  return current === 'direct' || disclosed === current;
}

/**
 * Replace every cf-aig-* header of an outgoing request with exactly the
 * endpoint's own set, whatever an SDK added from its environment
 * (ANTHROPIC_CUSTOM_HEADERS, OPENAI_CUSTOM_HEADERS). Readiness already
 * refuses those names; this keeps the wire set exact regardless.
 */
export function withExactGatewayHeaders(
  headers: Headers,
  gatewayHeaders: Readonly<Record<string, string>>,
): Headers {
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase().startsWith('cf-aig-')) headers.delete(name);
  }
  for (const [name, value] of Object.entries(gatewayHeaders)) headers.set(name, value);
  return headers;
}

/**
 * A fetch for SDKs that accept one (Anthropic, OpenAI): the request goes to
 * the global fetch at call time with its cf-aig-* set made exact.
 */
export function gatewayFetch(gatewayHeaders: Readonly<Record<string, string>>): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const headers = withExactGatewayHeaders(
      new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)),
      gatewayHeaders,
    );
    return globalThis.fetch(input, { ...init, headers });
  }) as typeof fetch;
}
