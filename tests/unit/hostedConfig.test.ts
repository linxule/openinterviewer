// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { getPublicConfig, validateHostedConfig, validateStandaloneConfig } from '@/lib/hostedConfig';

const SECRET_A = 'session-secret-value-32chars-min!';
const SECRET_B = 'participant-secret-value-32char!!';
const SECRET_C = 'rate-limit-salt-value-32chars-min';
const CREDENTIAL_KEY = Buffer.alloc(32, 7).toString('base64');

function hostedEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    DEPLOYMENT_MODE: 'hosted',
    APP_BASE_URL: 'https://research.example',
    PLATFORM_KEY_PREFIX: 'prod',
    PLATFORM_KV_REST_API_URL: 'https://example.upstash.io',
    PLATFORM_KV_REST_API_TOKEN: 'platform-token',
    CREDENTIAL_ENCRYPTION_KEYS: JSON.stringify({ current: CREDENTIAL_KEY }),
    CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: 'current',
    SESSION_SECRET: SECRET_A,
    PARTICIPANT_TOKEN_SECRET: SECRET_B,
    RATE_LIMIT_SALT: SECRET_C,
    GOOGLE_CLIENT_ID: 'google-id',
    GOOGLE_CLIENT_SECRET: 'google-secret',
    ...overrides,
  };
}

describe('hosted config validator', () => {
  it('accepts a complete hosted configuration', () => {
    expect(validateHostedConfig(hostedEnv())).toEqual([]);
    expect(getPublicConfig(hostedEnv())).toEqual({
      mode: 'hosted',
      aiTransport: 'direct',
      ready: true,
      oauth: { google: true, github: false },
      errors: [],
    });
  });

  it('reports only safe identifiers and never secret values', () => {
    const env = hostedEnv({
      SESSION_SECRET: 'short',
      CREDENTIAL_ENCRYPTION_KEYS: JSON.stringify({ current: 'not-32-bytes' }),
      PLATFORM_KV_REST_API_URL: 'https://evil.example',
    });
    const view = getPublicConfig(env);
    const serialized = JSON.stringify(view);

    expect(view.ready).toBe(false);
    expect(view.errors).toEqual(expect.arrayContaining([
      'weak_session_secret',
      'invalid_credential_key',
      'invalid_platform_redis_url',
    ]));
    expect(serialized).not.toContain('short');
    expect(serialized).not.toContain(SECRET_A);
    expect(serialized).not.toContain(CREDENTIAL_KEY);
    expect(serialized).not.toContain('platform-token');
    expect(serialized).not.toContain('google-secret');
  });

  it('requires independent signing and rate-limit secrets', () => {
    expect(validateHostedConfig(hostedEnv({ RATE_LIMIT_SALT: SECRET_A }))).toContain(
      'secrets_not_independent'
    );
  });

  it('requires at least one complete OAuth provider pair', () => {
    const errors = validateHostedConfig(hostedEnv({
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
      GITHUB_CLIENT_ID: 'gh-id',
    }));
    expect(errors).toEqual(expect.arrayContaining([
      'incomplete_github_oauth',
      'missing_oauth_provider',
    ]));
  });

  it('requires a constrained prefix and a valid active encryption key', () => {
    expect(validateHostedConfig(hostedEnv({ PLATFORM_KEY_PREFIX: 'Production:One' })))
      .toContain('invalid_platform_key_prefix');
    expect(validateHostedConfig(hostedEnv({
      CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: 'missing',
    }))).toContain('invalid_credential_key');
    expect(validateHostedConfig(hostedEnv({
      CREDENTIAL_ENCRYPTION_KEYS: JSON.stringify({ legacy: CREDENTIAL_KEY }),
      CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: 'legacy',
    }))).toContain('invalid_credential_key');
  });

  it('rejects a non-v2-clean PLATFORM_SCHEMA_LINEAGE value', () => {
    expect(validateHostedConfig(hostedEnv({ PLATFORM_SCHEMA_LINEAGE: 'v1' })))
      .toContain('invalid_platform_schema_lineage');
    expect(validateHostedConfig(hostedEnv({ PLATFORM_SCHEMA_LINEAGE: 'v2-clean' }))).toEqual([]);
    expect(validateHostedConfig(hostedEnv({ PLATFORM_SCHEMA_LINEAGE: '' }))).toEqual([]);
  });

  it('validates standalone readiness independently from hosted settings', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      DEPLOYMENT_MODE: 'standalone',
      APP_BASE_URL: 'https://standalone.example',
      ADMIN_PASSWORD: 'standalone-admin-password',
      SESSION_SECRET: SECRET_A,
      PARTICIPANT_TOKEN_SECRET: SECRET_B,
      RATE_LIMIT_SALT: SECRET_C,
      KV_REST_API_URL: 'https://standalone.upstash.io',
      KV_REST_API_TOKEN: 'redis-token',
      GEMINI_API_KEY: 'gemini-key',
    };
    expect(validateStandaloneConfig(env)).toEqual([]);
    expect(getPublicConfig(env)).toEqual({
      mode: 'standalone',
      aiTransport: 'direct',
      ready: true,
      oauth: { google: false, github: false },
      errors: [],
    });
    expect(getPublicConfig({ NODE_ENV: 'production', DEPLOYMENT_MODE: 'standalone' }).ready)
      .toBe(false);
  });

  it.each([
    ['openai', 'OPENAI_API_KEY'],
    ['openrouter', 'OPENROUTER_API_KEY'],
  ] as const)('accepts standalone %s only with its matching key', (provider, keyName) => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      DEPLOYMENT_MODE: 'standalone',
      APP_BASE_URL: 'https://standalone.example',
      ADMIN_PASSWORD: 'standalone-admin-password',
      SESSION_SECRET: SECRET_A,
      PARTICIPANT_TOKEN_SECRET: SECRET_B,
      RATE_LIMIT_SALT: SECRET_C,
      KV_REST_API_URL: 'https://standalone.upstash.io',
      KV_REST_API_TOKEN: 'redis-token',
      AI_PROVIDER: provider,
      [keyName]: 'provider-key',
    };

    expect(validateStandaloneConfig(env)).toEqual([]);
    delete env[keyName];
    expect(validateStandaloneConfig(env)).toEqual(expect.arrayContaining([
      'missing_ai_provider_key',
      'invalid_ai_provider',
    ]));
  });

  it('requires the implicit Gemini default key when AI_PROVIDER is omitted', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      DEPLOYMENT_MODE: 'standalone',
      APP_BASE_URL: 'https://standalone.example',
      ADMIN_PASSWORD: 'standalone-admin-password',
      SESSION_SECRET: SECRET_A,
      PARTICIPANT_TOKEN_SECRET: SECRET_B,
      RATE_LIMIT_SALT: SECRET_C,
      KV_REST_API_URL: 'https://standalone.upstash.io',
      KV_REST_API_TOKEN: 'redis-token',
      OPENAI_API_KEY: 'openai-key',
    };

    expect(validateStandaloneConfig(env)).toContain('invalid_ai_provider');
  });

  it('accepts standalone Gateway with Vercel OIDC and no provider API keys', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      DEPLOYMENT_MODE: 'standalone',
      APP_BASE_URL: 'https://standalone.example',
      ADMIN_PASSWORD: 'standalone-admin-password',
      SESSION_SECRET: SECRET_A,
      PARTICIPANT_TOKEN_SECRET: SECRET_B,
      RATE_LIMIT_SALT: SECRET_C,
      KV_REST_API_URL: 'https://standalone.upstash.io',
      KV_REST_API_TOKEN: 'redis-token',
      AI_TRANSPORT: 'gateway',
      AI_PROVIDER: 'gemini',
      VERCEL: '1',
    };

    expect(validateStandaloneConfig(env)).toEqual([]);
    expect(getPublicConfig(env)).toMatchObject({
      mode: 'standalone',
      aiTransport: 'gateway',
      ready: true,
    });
    expect(validateStandaloneConfig({ ...env, VERCEL: '' })).toContain('missing_ai_gateway_auth');
    expect(validateStandaloneConfig({ ...env, AI_PROVIDER: 'openrouter' }))
      .toContain('invalid_gateway_ai_provider');
  });

  it('keeps hosted researcher BYOS on direct adapters', () => {
    expect(validateHostedConfig(hostedEnv({ AI_TRANSPORT: 'gateway' })))
      .toContain('gateway_not_supported_hosted');
  });

  it('fails closed on production mode misconfiguration without leaking the typo', () => {
    const view = getPublicConfig({
      NODE_ENV: 'production',
      DEPLOYMENT_MODE: 'hostd',
    });
    expect(view).toEqual({
      mode: null,
      aiTransport: null,
      ready: false,
      oauth: { google: false, github: false },
      errors: ['invalid_deployment_mode'],
    });
    expect(JSON.stringify(view)).not.toContain('hostd');
  });
});
