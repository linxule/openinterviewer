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
  const report = validateSetup({ mode: 'demo', env: {}, nodeVersion: '24.15.0' });
  assert.equal(report.ok, true);
  assert.equal(report.checks.some((item) => item.code === 'demo.keyless'), true);
});

test('a complete production standalone setup passes', () => {
  const report = validateSetup({
    mode: 'standalone',
    production: true,
    env: validStandaloneEnv(),
    nodeVersion: '24.15.0',
  });
  assert.equal(report.ok, true, JSON.stringify(report.checks));
});

test('standalone signing and rate-limit secrets must be independent', () => {
  const env = validStandaloneEnv();
  env.PARTICIPANT_TOKEN_SECRET = env.SESSION_SECRET;
  const report = validateSetup({ mode: 'standalone', production: true, env, nodeVersion: '24.15.0' });
  assert.equal(report.ok, false);
  assert.equal(report.checks.some((item) => item.code.startsWith('env.secrets.duplicate.')), true);
});

test('hosted setup uses platform infrastructure and versioned credential keys', () => {
  const env = validHostedEnv();
  const report = validateSetup({ mode: 'hosted', production: true, env, nodeVersion: '24.15.0' });
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.equal(report.checks.some((item) => item.code === 'env.aiProvider.missing'), false);
});

test('credential key IDs match the runtime envelope contract', () => {
  const dotted = validateSetup({
    mode: 'hosted',
    production: true,
    nodeVersion: '24.15.0',
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
    nodeVersion: '24.15.0',
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
    nodeVersion: '24.15.0',
  });
  assert.equal(JSON.stringify(report).includes(leakedValue), false);
});
