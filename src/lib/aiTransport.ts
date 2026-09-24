import type { AIProviderType } from '@/types';

/** Node transports: direct native adapters, or Vercel AI Gateway (`gateway`). */
export type NodeAITransport = 'direct' | 'gateway';

/**
 * Every transport a deployment can report. `cloudflare-gateway` (native
 * adapters through Cloudflare AI Gateway) exists on the Cloudflare target
 * only; the Node resolver below never returns it. The active transport of a
 * deployment comes from capabilities (`activeAITransport`).
 */
export type AITransport = NodeAITransport | 'cloudflare-gateway';

export const GATEWAY_SUPPORTED_PROVIDERS = [
  'gemini',
  'claude',
  'openai',
] as const satisfies ReadonlyArray<AIProviderType>;

export type GatewayProviderType = (typeof GATEWAY_SUPPORTED_PROVIDERS)[number];

/** Node only (capabilities uses it for the Node target); refuses `cloudflare-gateway`. */
export function resolveAITransport(
  env: NodeJS.ProcessEnv = process.env,
): NodeAITransport {
  const configured = env.AI_TRANSPORT?.trim();
  if (!configured) return 'direct';
  if (configured === 'direct' || configured === 'gateway') return configured;
  throw new Error('AI_TRANSPORT must be direct or gateway');
}

export function isGatewayProvider(
  provider: string,
): provider is GatewayProviderType {
  return GATEWAY_SUPPORTED_PROVIDERS.some((candidate) => candidate === provider);
}

export function isGatewayAuthConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(
    env.AI_GATEWAY_API_KEY?.trim()
    || env.VERCEL_OIDC_TOKEN?.trim()
    || env.VERCEL === '1',
  );
}

const CLAUDE_GATEWAY_MODEL_ALIASES: Readonly<Record<string, string>> = {
  'claude-haiku-4-5': 'claude-haiku-4.5',
  'claude-sonnet-4-5': 'claude-sonnet-4.5',
  'claude-opus-4-5': 'claude-opus-4.5',
};

export function toGatewayModelId(
  provider: GatewayProviderType,
  model: string,
): `${string}/${string}` {
  const normalizedModel = provider === 'claude'
    ? (CLAUDE_GATEWAY_MODEL_ALIASES[model] ?? model)
    : model;
  const creator = provider === 'gemini'
    ? 'google'
    : provider === 'claude'
      ? 'anthropic'
      : 'openai';
  return `${creator}/${normalizedModel}`;
}

export function gatewayRouteForProvider(
  provider: GatewayProviderType,
): 'google' | 'anthropic' | 'openai' {
  if (provider === 'gemini') return 'google';
  if (provider === 'claude') return 'anthropic';
  return 'openai';
}
