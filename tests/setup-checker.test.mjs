import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDotenv, validateSetup } from '../scripts/check-setup.mjs';

const secret = (character) => character.repeat(48);
const base64Key = Buffer.alloc(32, 7).toString('base64');

function validStandaloneEnv() {
  return {
    DEPLOYMENT_MODE: 'standalone',
    APP_BASE_URL: 'https://interviews.example.org',
    ADMIN_PASSWORD: secret('a'),
    SESSION_SECRET: secret('b'),
    PARTICIPANT_TOKEN_SECRET: secret('c'),
    RATE_LIMIT_SALT: secret('d'),
    KV_REST_API_URL: 'https://example.upstash.io',
    KV_REST_API_TOKEN: secret('e'),
    GEMINI_API_KEY: secret('f'),
    AI_PROVIDER: 'gemini',
  };
}

function validHostedEnv() {
  return {
    DEPLOYMENT_MODE: 'hosted',
    APP_BASE_URL: 'https://staging.example.org',
    SESSION_SECRET: secret('b'),
    PARTICIPANT_TOKEN_SECRET: secret('c'),
    RATE_LIMIT_SALT: secret('d'),
    PLATFORM_KV_REST_API_URL: 'https://platform.upstash.io',
    PLATFORM_KV_REST_API_TOKEN: secret('e'),
    PLATFORM_KEY_PREFIX: 'staging',
    PLATFORM_SCHEMA_LINEAGE: 'v2-clean',
    CREDENTIAL_ENCRYPTION_KEYS: JSON.stringify({ '2026-08': base64Key }),
    CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: '2026-08',
    GOOGLE_CLIENT_ID: 'google-client-id',
    GOOGLE_CLIENT_SECRET: secret('g'),
  };
}

test('parseDotenv extracts names without interpolating values', () => {
  assert.deepEqual(parseDotenv(`
# comment
PLAIN=value
QUOTED="value with spaces"
export EMPTY=
INLINE=value # explanation
`), {
    PLAIN: 'value',
    QUOTED: 'value with spaces',
    EMPTY: '',
    INLINE: 'value',
  });
});

test('demo mode is keyless and storage-free', () => {
  const report = validateSetup({ mode: 'demo', env: {}, nodeVersion: '24.19.0' });
  assert.equal(report.ok, true);
  assert.equal(report.checks.some((item) => item.code === 'demo.keyless'), true);
});

test('a complete production standalone setup passes', () => {
  const report = validateSetup({
    mode: 'standalone',
    production: true,
    env: validStandaloneEnv(),
    nodeVersion: '24.19.0',
  });
  assert.equal(report.ok, true, JSON.stringify(report.checks));
});

test('each standalone AI provider independently satisfies the provider contract', () => {
  const providers = [
    ['gemini', 'GEMINI_API_KEY'],
    ['claude', 'ANTHROPIC_API_KEY'],
    ['openai', 'OPENAI_API_KEY'],
    ['openrouter', 'OPENROUTER_API_KEY'],
  ];

  for (const [provider, keyName] of providers) {
    const env = validStandaloneEnv();
    delete env.GEMINI_API_KEY;
    env.AI_PROVIDER = provider;
    env[keyName] = secret(provider.at(0));

    const report = validateSetup({
      mode: 'standalone',
      production: true,
      env,
      nodeVersion: '24.19.0',
    });
    assert.equal(report.ok, true, `${provider}: ${JSON.stringify(report.checks)}`);
  }
});

test('standalone selected provider requires its matching key', () => {
  const env = validStandaloneEnv();
  env.AI_PROVIDER = 'openai';
  const report = validateSetup({
    mode: 'standalone',
    production: true,
    env,
    nodeVersion: '24.19.0',
  });

  assert.equal(report.ok, false);
  assert.equal(report.checks.some((item) => item.code === 'env.AI_PROVIDER.openai'), true);
});

test('standalone rejects an unknown AI provider', () => {
  const env = validStandaloneEnv();
  env.AI_PROVIDER = 'unknown';
  const report = validateSetup({
    mode: 'standalone',
    production: true,
    env,
    nodeVersion: '24.19.0',
  });

  assert.equal(report.ok, false);
  assert.equal(report.checks.some((item) => item.code === 'env.AI_PROVIDER.invalid'), true);
});

test('standalone Gateway accepts Vercel OIDC without provider API keys', () => {
  const env = validStandaloneEnv();
  delete env.GEMINI_API_KEY;
  env.AI_TRANSPORT = 'gateway';
  env.VERCEL = '1';

  const report = validateSetup({
    mode: 'standalone',
    production: true,
    env,
    nodeVersion: '24.19.0',
  });

  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.equal(report.checks.some((item) => item.code === 'env.aiGateway.auth.present'), true);
});

test('standalone Gateway rejects missing auth and direct-only OpenRouter', () => {
  const env = validStandaloneEnv();
  delete env.GEMINI_API_KEY;
  env.AI_TRANSPORT = 'gateway';
  env.AI_PROVIDER = 'openrouter';

  const report = validateSetup({
    mode: 'standalone',
    production: true,
    env,
    nodeVersion: '24.19.0',
  });

  assert.equal(report.ok, false);
  assert.equal(report.checks.some((item) => item.code === 'env.aiGateway.auth.missing'), true);
  assert.equal(report.checks.some((item) => item.code === 'env.aiGateway.provider.openrouter'), true);
});

test('standalone signing and rate-limit secrets must be independent', () => {
  const env = validStandaloneEnv();
  env.PARTICIPANT_TOKEN_SECRET = env.SESSION_SECRET;
  const report = validateSetup({ mode: 'standalone', production: true, env, nodeVersion: '24.19.0' });
  assert.equal(report.ok, false);
  assert.equal(report.checks.some((item) => item.code.startsWith('env.secrets.duplicate.')), true);
});

test('hosted setup uses platform infrastructure and versioned credential keys', () => {
  const env = validHostedEnv();
  const report = validateSetup({ mode: 'hosted', production: true, env, nodeVersion: '24.19.0' });
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.equal(report.checks.some((item) => item.code === 'env.aiProvider.missing'), false);
});

test('hosted BYOS rejects Gateway transport', () => {
  const env = validHostedEnv();
  env.AI_TRANSPORT = 'gateway';
  const report = validateSetup({ mode: 'hosted', production: true, env, nodeVersion: '24.19.0' });
  assert.equal(report.ok, false);
  assert.equal(report.checks.some((item) => item.code === 'env.AI_TRANSPORT.hosted'), true);
});

test('hosted setup warns that deployment-owner provider keys are ignored', () => {
  const providerKeys = [
    'GEMINI_API_KEY',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
  ];
  const env = validHostedEnv();
  for (const name of providerKeys) env[name] = secret(name.at(0));

  const report = validateSetup({ mode: 'hosted', production: true, env, nodeVersion: '24.19.0' });
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  for (const name of providerKeys) {
    assert.equal(report.checks.some((item) => item.code === `env.${name}.hosted`), true);
    assert.equal(JSON.stringify(report).includes(env[name]), false);
  }
});

test('credential key IDs match the runtime envelope contract', () => {
  const dotted = validateSetup({
    mode: 'hosted',
    production: true,
    nodeVersion: '24.19.0',
    env: {
      ...validHostedEnv(),
      CREDENTIAL_ENCRYPTION_KEYS: JSON.stringify({ 'key.v1': base64Key }),
      CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: 'key.v1',
    },
  });
  assert.equal(dotted.ok, false);

  const reserved = validateSetup({
    mode: 'hosted',
    production: true,
    nodeVersion: '24.19.0',
    env: {
      ...validHostedEnv(),
      CREDENTIAL_ENCRYPTION_KEYS: JSON.stringify({ legacy: base64Key }),
      CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: 'legacy',
    },
  });
  assert.equal(reserved.ok, false);
});

test('reports contain env names and never include secret values', () => {
  const leakedValue = `LEAK-${secret('x')}`;
  const report = validateSetup({
    mode: 'standalone',
    production: true,
    env: { ...validStandaloneEnv(), SESSION_SECRET: leakedValue, RATE_LIMIT_SALT: leakedValue },
    nodeVersion: '24.19.0',
  });
  assert.equal(JSON.stringify(report).includes(leakedValue), false);
});

test('hosted production fails when schema lineage would HOLD', () => {
  const env = validHostedEnv();
  delete env.PLATFORM_SCHEMA_LINEAGE;
  const report = validateSetup({ mode: 'hosted', production: true, env, nodeVersion: '24.19.0' });
  assert.equal(report.ok, false);
  assert.equal(report.checks.some((item) => item.code === 'env.PLATFORM_SCHEMA_LINEAGE.hold'), true);
});

test('hosted production rejects a non-v2-clean schema lineage value', () => {
  const env = validHostedEnv();
  env.PLATFORM_SCHEMA_LINEAGE = 'v1';
  const report = validateSetup({ mode: 'hosted', production: true, env, nodeVersion: '24.19.0' });
  assert.equal(report.ok, false);
  assert.equal(report.checks.some((item) => item.code === 'env.PLATFORM_SCHEMA_LINEAGE.invalid'), true);
});

test('Node.js older than 24.19.0 is unsupported', () => {
  const report = validateSetup({
    mode: 'demo',
    env: {},
    nodeVersion: '24.15.0',
  });
  assert.equal(report.ok, false);
  assert.equal(report.checks.some((item) => item.code === 'node.unsupported'), true);
});
