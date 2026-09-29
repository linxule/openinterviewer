// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  gatewayRouteForProvider,
  isGatewayAuthConfigured,
  resolveAITransport,
  toGatewayModelId,
} from '@/lib/aiTransport';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('AI transport configuration', () => {
  it('keeps direct provider adapters as the portable default', () => {
    vi.stubEnv('AI_TRANSPORT', '');
    expect(resolveAITransport()).toBe('direct');
  });

  it('fails closed on an unknown transport', () => {
    vi.stubEnv('AI_TRANSPORT', 'automatic');
    expect(() => resolveAITransport()).toThrow('AI_TRANSPORT must be direct or gateway');
  });

  it('accepts Vercel OIDC or an explicit Gateway key without exposing either', () => {
    expect(isGatewayAuthConfigured({ NODE_ENV: 'test', VERCEL: '1' })).toBe(true);
    expect(isGatewayAuthConfigured({ NODE_ENV: 'test', VERCEL_OIDC_TOKEN: 'oidc' })).toBe(true);
    expect(isGatewayAuthConfigured({ NODE_ENV: 'test', AI_GATEWAY_API_KEY: 'key' })).toBe(true);
    expect(isGatewayAuthConfigured({ NODE_ENV: 'test' })).toBe(false);
  });

  it('maps canonical models to current Gateway creator slugs and endpoint pins', () => {
    expect(toGatewayModelId('gemini', 'gemini-3.7-flash')).toBe('google/gemini-3.7-flash');
    expect(toGatewayModelId('claude', 'claude-sonnet-4-5')).toBe('anthropic/claude-sonnet-4.5');
    expect(toGatewayModelId('claude', 'claude-sonnet-5')).toBe('anthropic/claude-sonnet-5');
    expect(toGatewayModelId('claude', 'claude-sonnet-5-5')).toBe('anthropic/claude-sonnet-5.5');
    expect(toGatewayModelId('openai', 'gpt-6.1-sol')).toBe('openai/gpt-6.1-sol');
    expect(toGatewayModelId('openai', 'gpt-6-sol')).toBe('openai/gpt-6-sol');
    expect(toGatewayModelId('openai', 'gpt-6-luna')).toBe('openai/gpt-6-luna');
    expect(toGatewayModelId('openai', 'gpt-5.6-terra')).toBe('openai/gpt-5.6-terra');
    expect(gatewayRouteForProvider('gemini')).toBe('google');
    expect(gatewayRouteForProvider('claude')).toBe('anthropic');
    expect(gatewayRouteForProvider('openai')).toBe('openai');
  });
});
