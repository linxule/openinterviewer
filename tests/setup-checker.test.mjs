import assert from 'node:assert/strict';
import test from 'node:test';

import { CLOUDFLARE_SDK_OVERRIDE_NAMES, parseDotenv, validateSetup } from '../scripts/check-setup.mjs';

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

// ---------------------------------------------------------------------------
// Cloudflare target (RT-01, RT-06, RT-08, SETUP-02, RT-10)
// ---------------------------------------------------------------------------

const { parseJsonc } = await import('../scripts/check-setup.mjs');
const { parseJsonc: installerParseJsonc } = await import('../scripts/cloudflare/lib.mjs');
const { spawnSync } = await import('node:child_process');
const fs = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');

const CHECKER = new URL('../scripts/check-setup.mjs', import.meta.url).pathname;
const REPO_WRANGLER = new URL('../wrangler.jsonc', import.meta.url).pathname;

function validCloudflareEnv() {
  return {
    DEPLOYMENT_TARGET: 'cloudflare',
    DEPLOYMENT_MODE: 'standalone',
    APP_BASE_URL: 'https://openinterviewer.example.workers.dev',
    ADMIN_PASSWORD: secret('a'),
    SESSION_SECRET: secret('b'),
    PARTICIPANT_TOKEN_SECRET: secret('c'),
    RATE_LIMIT_SALT: secret('d'),
    OPERATOR_TOKEN: secret('o'),
    GEMINI_API_KEY: secret('f'),
    WORKSPACE_ID: 'ws_0123456789abcdef0123456789abcdef',
    WORKSPACE_JURISDICTION: '',
    ANALYSIS_RECOVERY_EPOCH: 'ep_fedcba9876543210fedcba9876543210',
  };
}

function validWranglerConfig() {
  return {
    name: 'openinterviewer-synthetic',
    main: 'cloudflare/worker.ts',
    observability: { enabled: true, logs: { enabled: true, invocation_logs: false }, traces: { enabled: false } },
    vars: { DEPLOYMENT_TARGET: 'cloudflare', DEPLOYMENT_MODE: 'standalone', AI_TRANSPORT: 'direct' },
    durable_objects: { bindings: [{ name: 'WORKSPACE_STORE', class_name: 'WorkspaceStore' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['WorkspaceStore'] }],
    queues: {
      producers: [{ binding: 'ANALYSIS_QUEUE', queue: 'oi-analysis' }],
      consumers: [{
        queue: 'oi-analysis',
        max_batch_size: 1,
        max_concurrency: 1,
        max_retries: 3,
        retry_delay: 30,
        dead_letter_queue: 'oi-analysis-dlq',
      }],
    },
  };
}

function cloudflareReport({ env = validCloudflareEnv(), config = validWranglerConfig(), wrangler, ...rest } = {}) {
  return validateSetup({
    target: 'cloudflare',
    env,
    nodeVersion: '24.19.0',
    wrangler: wrangler === undefined ? { config } : wrangler,
    ...rest,
  });
}

function codes(report) {
  return report.checks.map((item) => item.code);
}

function errorCodes(report) {
  return report.checks.filter((item) => item.status === 'error').map((item) => item.code);
}

test('RT-08 a complete Cloudflare standalone setup passes without Redis', () => {
  const report = cloudflareReport();
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.equal(report.target, 'cloudflare');
  assert.equal(report.production, true);
  assert.equal(codes(report).some((code) => code.startsWith('env.KV_')), false);
});

test('RT-01 DEPLOYMENT_TARGET selects the Cloudflare checks without a flag', () => {
  const report = validateSetup({
    env: validCloudflareEnv(),
    nodeVersion: '24.19.0',
    wrangler: { config: validWranglerConfig() },
  });
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.equal(report.target, 'cloudflare');
});

test('RT-01 an unknown target fails without echoing the value', () => {
  for (const options of [
    { target: 'aws-lambda', env: {} },
    { env: { DEPLOYMENT_TARGET: 'aws-lambda' } },
    { target: 'node', env: { DEPLOYMENT_TARGET: 'aws-lambda' } },
  ]) {
    const report = validateSetup({ mode: 'standalone', nodeVersion: '24.19.0', ...options });
    assert.equal(report.ok, false);
    assert.deepEqual(codes(report), ['env.DEPLOYMENT_TARGET.invalid']);
    assert.equal(JSON.stringify(report).includes('aws-lambda'), false);
  }
});

test('RT-01 an explicit node check refuses a cloudflare-targeted environment', () => {
  const env = { ...validStandaloneEnv(), DEPLOYMENT_TARGET: 'cloudflare' };
  const report = validateSetup({ mode: 'standalone', target: 'node', production: true, env, nodeVersion: '24.19.0' });
  assert.equal(report.ok, false);
  assert.equal(codes(report).includes('target.mismatch'), true);
});

test('RT-01 the default node check is unchanged by the target field', () => {
  const plain = validateSetup({ mode: 'standalone', production: true, env: validStandaloneEnv(), nodeVersion: '24.19.0' });
  const explicit = validateSetup({
    mode: 'standalone',
    production: true,
    env: { ...validStandaloneEnv(), DEPLOYMENT_TARGET: 'node' },
    nodeVersion: '24.19.0',
  });
  assert.deepEqual(explicit.checks, plain.checks);
  assert.equal(plain.target, 'node');
});

test('RT-05 Cloudflare accepts any bound key set with the default key and checks every bound key', () => {
  const all = {
    ...validCloudflareEnv(),
    ANTHROPIC_API_KEY: 'synthetic-anthropic-key-0123456789',
    OPENAI_API_KEY: 'synthetic-openai-key-0123456789',
    OPENROUTER_API_KEY: 'synthetic-openrouter-key-0123456789',
  };
  const report = cloudflareReport({ env: all });
  assert.deepEqual(errorCodes(report), []);
  const summary = report.checks.find((item) => item.code === 'env.aiProviderKeys');
  assert.equal(summary.message, 'Provider keys bound: gemini, claude, openai, openrouter; not bound: none.');
  assert.equal(JSON.stringify(report).includes('synthetic-openai-key'), false);

  const single = cloudflareReport();
  assert.equal(single.checks.find((item) => item.code === 'env.aiProviderKeys').message, 'Provider keys bound: gemini; not bound: claude, openai, openrouter.');

  const placeholder = cloudflareReport({ env: { ...validCloudflareEnv(), OPENAI_API_KEY: 'your-openai-key' } });
  assert.deepEqual(errorCodes(placeholder), ['env.OPENAI_API_KEY.placeholder']);

  const missingDefault = cloudflareReport({ env: { ...all, AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: undefined } });
  assert.deepEqual(errorCodes(missingDefault), ['env.AI_PROVIDER.claude']);
});

test('RT-05 Cloudflare refuses SDK override variables from the environment or wrangler vars', () => {
  for (const name of CLOUDFLARE_SDK_OVERRIDE_NAMES) {
    for (const value of ['https://attacker.example', '']) {
      const fromEnv = cloudflareReport({ env: { ...validCloudflareEnv(), [name]: value } });
      assert.deepEqual(errorCodes(fromEnv), ['env.cloudflare.sdkOverride'], name);
      assert.equal(JSON.stringify(fromEnv).includes('attacker'), false);
    }
  }
  const config = validWranglerConfig();
  config.vars = { ...config.vars, OPENAI_LOG: 'debug', ANTHROPIC_CUSTOM_HEADERS: 'cf-aig-cache-key: x' };
  const fromVars = cloudflareReport({ config });
  assert.deepEqual(errorCodes(fromVars), ['env.cloudflare.sdkOverride']);
  assert.match(fromVars.checks.find((item) => item.code === 'env.cloudflare.sdkOverride').message, /^Remove ANTHROPIC_CUSTOM_HEADERS, OPENAI_LOG:/);
});

test('RT-05 an SDK override set only in the checking shell is reported, not refused', () => {
  // `env` is the files plus the shell; `configEnv` the files alone (what the CLI passes).
  const shell = cloudflareReport({ env: { ...validCloudflareEnv(), GOOGLE_CLOUD_PROJECT: 'my-gcloud-project', OPENAI_LOG: 'debug' }, configEnv: validCloudflareEnv() });
  assert.equal(shell.ok, true, JSON.stringify(errorCodes(shell)));
  const warning = shell.checks.find((item) => item.code === 'env.cloudflare.sdkOverride.shell');
  assert.equal(warning.status, 'warn');
  assert.match(warning.message, /^OPENAI_LOG, GOOGLE_CLOUD_PROJECT are set only in the shell running this check/);
  assert.equal(JSON.stringify(shell).includes('my-gcloud-project'), false);

  const fromFile = cloudflareReport({ env: { ...validCloudflareEnv(), GOOGLE_CLOUD_PROJECT: 'p' }, configEnv: { ...validCloudflareEnv(), GOOGLE_CLOUD_PROJECT: 'p' } });
  assert.deepEqual(errorCodes(fromFile), ['env.cloudflare.sdkOverride']);
  assert.equal(fromFile.checks.some((item) => item.code === 'env.cloudflare.sdkOverride.shell'), false);

  const config = validWranglerConfig();
  config.vars = { ...config.vars, GOOGLE_CLOUD_PROJECT: 'p' };
  const fromVars = cloudflareReport({ config, configEnv: validCloudflareEnv() });
  assert.deepEqual(errorCodes(fromVars), ['env.cloudflare.sdkOverride']);
});

test('RT-05 the CLI without --env-file ignores the shell for SDK overrides and names it', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oi-setup-shell-'));
  try {
    fs.writeFileSync(path.join(directory, '.env'), Object.entries(validCloudflareEnv()).map(([name, value]) => `${name}=${value}`).join('\n'));
    fs.writeFileSync(path.join(directory, 'wrangler.jsonc'), JSON.stringify(validWranglerConfig()));
    const run = (extraEnv) => spawnSync(process.execPath, [CHECKER, '--target', 'cloudflare', '--json'], {
      cwd: directory,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, ...extraEnv },
    });

    const shell = run({ GOOGLE_CLOUD_PROJECT: 'operator-gcloud-project' });
    assert.equal(shell.status, 0, shell.stdout + shell.stderr);
    const report = JSON.parse(shell.stdout);
    assert.equal(report.checks.find((item) => item.code === 'env.cloudflare.sdkOverride.shell').status, 'warn');
    assert.equal(shell.stdout.includes('operator-gcloud-project'), false);

    fs.appendFileSync(path.join(directory, '.env'), '\nGOOGLE_CLOUD_PROJECT=declared-in-file\n');
    const declared = run({});
    assert.equal(declared.status, 1, declared.stdout + declared.stderr);
    assert.deepEqual(JSON.parse(declared.stdout).checks.filter((item) => item.status === 'error').map((item) => item.code), ['env.cloudflare.sdkOverride']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('RT-01 Cloudflare refuses hosted mode and Gateway transport', () => {
  const hosted = cloudflareReport({ env: { ...validCloudflareEnv(), DEPLOYMENT_MODE: 'hosted' } });
  assert.equal(hosted.ok, false);
  assert.equal(codes(hosted).includes('env.cloudflare.hosted'), true);

  const hostedFlag = cloudflareReport({ mode: 'hosted' });
  assert.equal(codes(hostedFlag).includes('env.cloudflare.hosted'), true);

  const gateway = cloudflareReport({ env: { ...validCloudflareEnv(), AI_TRANSPORT: 'gateway' } });
  assert.equal(gateway.ok, false);
  assert.deepEqual(errorCodes(gateway), ['env.cloudflare.gateway']);
  assert.match(gateway.checks.find((item) => item.code === 'env.cloudflare.gateway').message, /Vercel AI Gateway is Node-only/);

  const invalid = cloudflareReport({ env: { ...validCloudflareEnv(), AI_TRANSPORT: 'grpc' } });
  assert.deepEqual(errorCodes(invalid), ['env.AI_TRANSPORT.invalid']);
});

const CF_GATEWAY = {
  AI_TRANSPORT: 'cloudflare-gateway',
  CF_AI_GATEWAY_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
  CF_AI_GATEWAY_ID: 'oi-example',
  CF_AI_GATEWAY_TOKEN: secret('g'),
};

test('RT-11 Cloudflare accepts its own AI Gateway transport with valid identifiers and a Run token', () => {
  const report = cloudflareReport({ env: { ...validCloudflareEnv(), ...CF_GATEWAY } });
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.equal(codes(report).includes('env.cloudflare.gateway.valid'), true);
  assert.match(report.checks.find((item) => item.code === 'env.AI_TRANSPORT.valid').message, /cloudflare-gateway/);
  assert.equal(JSON.stringify(report).includes(CF_GATEWAY.CF_AI_GATEWAY_TOKEN), false);
});

test('RT-11 Cloudflare AI Gateway refuses malformed identifiers, a missing or weak token and a shared token', () => {
  const cases = [
    [{ CF_AI_GATEWAY_ACCOUNT_ID: 'acct' }, 'env.CF_AI_GATEWAY_ACCOUNT_ID.invalid'],
    [{ CF_AI_GATEWAY_ID: 'default' }, 'env.CF_AI_GATEWAY_ID.invalid'],
    [{ CF_AI_GATEWAY_ID: 'Bad/Id' }, 'env.CF_AI_GATEWAY_ID.invalid'],
    [{ CF_AI_GATEWAY_TOKEN: undefined }, 'env.CF_AI_GATEWAY_TOKEN.missing'],
    [{ CF_AI_GATEWAY_TOKEN: 'short' }, 'env.CF_AI_GATEWAY_TOKEN.weak'],
    [{ CF_AI_GATEWAY_TOKEN: 'your-ai-gateway-run-token-placeholder-value' }, 'env.CF_AI_GATEWAY_TOKEN.placeholder'],
  ];
  for (const [override, code] of cases) {
    const env = { ...validCloudflareEnv(), ...CF_GATEWAY, ...override };
    for (const [name, value] of Object.entries(override)) if (value === undefined) delete env[name];
    assert.deepEqual(errorCodes(cloudflareReport({ env })), [code], code);
  }
  const shared = cloudflareReport({ env: { ...validCloudflareEnv(), ...CF_GATEWAY, CF_AI_GATEWAY_TOKEN: secret('f') } });
  assert.deepEqual(errorCodes(shared), ['env.CF_AI_GATEWAY_TOKEN.independent']);
});

test('RT-11 gateway identifiers without the gateway transport are refused; a bound token on direct is allowed', () => {
  const identifiers = cloudflareReport({ env: { ...validCloudflareEnv(), CF_AI_GATEWAY_ID: 'oi-example' } });
  assert.deepEqual(errorCodes(identifiers), ['env.cloudflare.gatewayWithoutTransport']);
  const token = cloudflareReport({ env: { ...validCloudflareEnv(), CF_AI_GATEWAY_TOKEN: secret('g') } });
  assert.equal(token.ok, true, JSON.stringify(token.checks));
});

test('RT-11 the Run token must be a secret, never a wrangler var', () => {
  const config = validWranglerConfig();
  config.vars = { ...config.vars, CF_AI_GATEWAY_TOKEN: secret('g') };
  const report = cloudflareReport({ config });
  assert.equal(errorCodes(report).includes('wrangler.vars.CF_AI_GATEWAY_TOKEN.secret'), true);
});

test('RT-11 Node refuses Cloudflare AI Gateway', () => {
  const report = validateSetup({
    mode: 'standalone',
    env: { ...validStandaloneEnv(), AI_TRANSPORT: 'cloudflare-gateway' },
    nodeVersion: '24.19.0',
  });
  assert.equal(report.ok, false);
  assert.equal(errorCodes(report).includes('env.AI_TRANSPORT.cloudflare_only'), true);
});

test('RT-01 Cloudflare requires an explicit DEPLOYMENT_MODE and cloudflare target', () => {
  const env = validCloudflareEnv();
  delete env.DEPLOYMENT_MODE;
  const config = validWranglerConfig();
  delete config.vars.DEPLOYMENT_MODE;
  assert.deepEqual(errorCodes(cloudflareReport({ env, config })), ['env.DEPLOYMENT_MODE.missing']);

  const nodeTargeted = cloudflareReport({ env: { ...validCloudflareEnv(), DEPLOYMENT_TARGET: 'node' } });
  assert.deepEqual(errorCodes(nodeTargeted), ['target.mismatch']);
});

test('RT-08 Cloudflare ignores Redis variables with a warning', () => {
  const report = cloudflareReport({
    env: { ...validCloudflareEnv(), KV_REST_API_URL: 'https://x.upstash.io', KV_REST_API_TOKEN: secret('k') },
  });
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.equal(codes(report).includes('env.KV_REST_API_URL.cloudflare'), true);
  assert.equal(codes(report).includes('env.KV_REST_API_TOKEN.cloudflare'), true);
});

test('SETUP-02 Cloudflare requires exactly the selected provider key', () => {
  const env = validCloudflareEnv();
  env.AI_PROVIDER = 'openai';
  assert.deepEqual(errorCodes(cloudflareReport({ env })), ['env.AI_PROVIDER.openai']);

  for (const [provider, keyName] of [
    ['gemini', 'GEMINI_API_KEY'],
    ['claude', 'ANTHROPIC_API_KEY'],
    ['openai', 'OPENAI_API_KEY'],
    ['openrouter', 'OPENROUTER_API_KEY'],
  ]) {
    const single = validCloudflareEnv();
    delete single.GEMINI_API_KEY;
    single.AI_PROVIDER = provider;
    single[keyName] = secret('p');
    const report = cloudflareReport({ env: single });
    assert.equal(report.ok, true, `${provider}: ${JSON.stringify(report.checks)}`);
  }

  const unknown = cloudflareReport({ env: { ...validCloudflareEnv(), AI_PROVIDER: 'constructor' } });
  assert.deepEqual(errorCodes(unknown), ['env.AI_PROVIDER.invalid']);
});

test('SETUP-02 Cloudflare rejects placeholder and reused credentials', () => {
  const placeholder = cloudflareReport({
    env: { ...validCloudflareEnv(), SESSION_SECRET: 'change-me-change-me-change-me-change-me', GEMINI_API_KEY: 'your-gemini-key' },
  });
  assert.deepEqual(errorCodes(placeholder).sort(), ['env.GEMINI_API_KEY.placeholder', 'env.SESSION_SECRET.placeholder']);

  const env = validCloudflareEnv();
  env.ADMIN_PASSWORD = env.SESSION_SECRET;
  const reused = cloudflareReport({ env });
  assert.deepEqual(errorCodes(reused), ['env.secrets.duplicate.ADMIN_PASSWORD.SESSION_SECRET']);

  const weak = cloudflareReport({ env: { ...validCloudflareEnv(), ADMIN_PASSWORD: 'short-password' } });
  assert.deepEqual(errorCodes(weak), ['env.ADMIN_PASSWORD.short']);
});

test('SETUP-02 Cloudflare refuses an ADMIN_PASSWORD whose sign-in body exceeds 1 KiB, like readiness', () => {
  for (const [shape, longest, onePast] of [
    ['ASCII', 'a'.repeat(1_009), 'a'.repeat(1_010)],
    ['three-byte', '€'.repeat(336), '€'.repeat(337)],
    ['JSON-escaped', '"'.repeat(504), '"'.repeat(505)],
  ]) {
    const accepted = cloudflareReport({ env: { ...validCloudflareEnv(), ADMIN_PASSWORD: longest } });
    assert.equal(accepted.ok, true, `${shape}: ${JSON.stringify(errorCodes(accepted))}`);
    const refused = cloudflareReport({ env: { ...validCloudflareEnv(), ADMIN_PASSWORD: onePast } });
    assert.deepEqual(errorCodes(refused), ['env.ADMIN_PASSWORD.too_long'], shape);
    assert.equal(codes(refused).includes('env.ADMIN_PASSWORD.present'), false, shape);
    const { message } = refused.checks.find((item) => item.code === 'env.ADMIN_PASSWORD.too_long');
    assert.match(message, /1024 bytes \(at most 1009 ASCII characters/);
    assert.equal(message.includes(onePast), false, 'the message never contains the value');
  }
  // The bound is Cloudflare sign-in's; the Node target keeps no maximum.
  const node = validateSetup({
    mode: 'standalone',
    production: true,
    env: { ...validStandaloneEnv(), ADMIN_PASSWORD: 'a'.repeat(1_010) },
    nodeVersion: '24.19.0',
  });
  assert.equal(node.ok, true, JSON.stringify(node.checks));
});

test('SETUP-02 OPERATOR_TOKEN is optional but, when set, must be a strong independent credential', () => {
  const env = validCloudflareEnv();
  delete env.OPERATOR_TOKEN;
  const missing = cloudflareReport({ env });
  assert.equal(missing.ok, true, JSON.stringify(missing.checks));
  assert.deepEqual(
    missing.checks.filter((item) => item.code === 'env.OPERATOR_TOKEN.missing').map((item) => item.status),
    ['warn'],
  );
  assert.equal(codes(cloudflareReport()).includes('env.OPERATOR_TOKEN.present'), true);

  const placeholder = cloudflareReport({ env: { ...validCloudflareEnv(), OPERATOR_TOKEN: 'replace-me-operator-token-0000000000000' } });
  assert.deepEqual(errorCodes(placeholder), ['env.OPERATOR_TOKEN.placeholder']);

  const short = cloudflareReport({ env: { ...validCloudflareEnv(), OPERATOR_TOKEN: 'o'.repeat(31) } });
  assert.deepEqual(errorCodes(short), ['env.OPERATOR_TOKEN.short']);

  for (const name of ['ADMIN_PASSWORD', 'SESSION_SECRET', 'PARTICIPANT_TOKEN_SECRET', 'RATE_LIMIT_SALT']) {
    const reused = validCloudflareEnv();
    reused.OPERATOR_TOKEN = reused[name];
    assert.deepEqual(errorCodes(cloudflareReport({ env: reused })), [`env.secrets.duplicate.${name}.OPERATOR_TOKEN`], name);
  }
});

test('ST-01 WORKSPACE_BOOTSTRAP accepts only empty, open or recovery and warns while set', () => {
  for (const value of ['yes-please', 'OPEN', ' open', 'true']) {
    const report = cloudflareReport({ env: { ...validCloudflareEnv(), WORKSPACE_BOOTSTRAP: value } });
    assert.deepEqual(errorCodes(report), ['env.WORKSPACE_BOOTSTRAP.invalid'], JSON.stringify(value));
    assert.equal(JSON.stringify(report).includes('yes-please'), false);
  }
  for (const value of ['open', 'recovery']) {
    const report = cloudflareReport({ env: { ...validCloudflareEnv(), WORKSPACE_BOOTSTRAP: value } });
    assert.equal(report.ok, true, value);
    assert.deepEqual(
      report.checks.filter((item) => item.code.startsWith('env.WORKSPACE_BOOTSTRAP')).map((item) => [item.status, item.code]),
      [['warn', 'env.WORKSPACE_BOOTSTRAP.active']],
      value,
    );
  }
  const config = validWranglerConfig();
  config.vars.WORKSPACE_BOOTSTRAP = 'yes-please';
  assert.deepEqual(errorCodes(cloudflareReport({ config })), ['env.WORKSPACE_BOOTSTRAP.invalid']);
  config.vars.WORKSPACE_BOOTSTRAP = '';
  assert.equal(codes(cloudflareReport({ config })).some((code) => code.startsWith('env.WORKSPACE_BOOTSTRAP')), false);
});

test('ST-01 Cloudflare validates workspace identity, epoch and jurisdiction formats', () => {
  const cases = [
    [{ WORKSPACE_ID: undefined }, 'env.WORKSPACE_ID.missing'],
    [{ WORKSPACE_ID: 'ws_ABCDEF' }, 'env.WORKSPACE_ID.invalid'],
    [{ WORKSPACE_ID: ' ws_0123456789abcdef0123456789abcdef' }, 'env.WORKSPACE_ID.invalid'],
    [{ ANALYSIS_RECOVERY_EPOCH: undefined }, 'env.ANALYSIS_RECOVERY_EPOCH.missing'],
    [{ ANALYSIS_RECOVERY_EPOCH: 'ep_1' }, 'env.ANALYSIS_RECOVERY_EPOCH.invalid'],
    [{ WORKSPACE_JURISDICTION: 'EU' }, 'env.WORKSPACE_JURISDICTION.invalid'],
    [{ WORKSPACE_JURISDICTION: 'us' }, 'env.WORKSPACE_JURISDICTION.invalid'],
  ];
  for (const [overrides, expected] of cases) {
    const env = { ...validCloudflareEnv(), ...overrides };
    for (const [name, value] of Object.entries(overrides)) if (value === undefined) delete env[name];
    assert.deepEqual(errorCodes(cloudflareReport({ env })), [expected], JSON.stringify(overrides));
  }
  for (const jurisdiction of ['eu', 'fedramp', undefined]) {
    const env = { ...validCloudflareEnv(), WORKSPACE_JURISDICTION: jurisdiction };
    if (jurisdiction === undefined) delete env.WORKSPACE_JURISDICTION;
    assert.equal(cloudflareReport({ env }).ok, true, String(jurisdiction));
  }
});

test('RT-06 Cloudflare APP_BASE_URL is always production-strict', () => {
  const cases = [
    ['http://localhost:8787', 'env.APP_BASE_URL.protocol'],
    ['http://openinterviewer.example', 'env.APP_BASE_URL.protocol'],
    ['https://localhost', 'env.APP_BASE_URL.local'],
    ['https://app.localhost', 'env.APP_BASE_URL.local'],
    ['https://127.0.0.1', 'env.APP_BASE_URL.local'],
    ['https://[::1]', 'env.APP_BASE_URL.local'],
    ['https://user:pass@openinterviewer.example', 'env.APP_BASE_URL.origin'],
    ['https://openinterviewer.example/path', 'env.APP_BASE_URL.origin'],
    [undefined, 'env.APP_BASE_URL.missing'],
  ];
  for (const [value, expected] of cases) {
    const env = { ...validCloudflareEnv(), APP_BASE_URL: value };
    if (value === undefined) delete env.APP_BASE_URL;
    const report = cloudflareReport({ env, production: false });
    assert.deepEqual(errorCodes(report), [expected], String(value));
    if (value) assert.equal(JSON.stringify(report).includes(value), false);
  }
});

test('RT-06 Node production APP_BASE_URL rejects credentials and loopback hosts', () => {
  for (const [value, expected] of [
    ['https://localhost', 'env.APP_BASE_URL.local'],
    ['https://localhost.', 'env.APP_BASE_URL.local'],
    ['https://[::1]', 'env.APP_BASE_URL.local'],
    ['https://127.0.0.2', 'env.APP_BASE_URL.local'],
    ['https://[::ffff:127.0.0.1]', 'env.APP_BASE_URL.local'],
    ['https://preview.localhost', 'env.APP_BASE_URL.local'],
    ['https://user:pass@interviews.example.org', 'env.APP_BASE_URL.origin'],
  ]) {
    const report = validateSetup({
      mode: 'standalone',
      production: true,
      env: { ...validStandaloneEnv(), APP_BASE_URL: value },
      nodeVersion: '24.19.0',
    });
    assert.deepEqual(errorCodes(report), [expected], value);
  }
  for (const value of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
    const report = validateSetup({
      mode: 'standalone',
      env: { ...validStandaloneEnv(), APP_BASE_URL: value },
      nodeVersion: '24.19.0',
    });
    assert.equal(report.ok, true, `${value}: ${JSON.stringify(report.checks)}`);
  }
});

test('RT-02 Wrangler configuration must declare the SQLite store and analysis queue contract', () => {
  const mutate = (change) => {
    const config = validWranglerConfig();
    change(config);
    return errorCodes(cloudflareReport({ config }));
  };
  assert.deepEqual(mutate((c) => { c.durable_objects.bindings = []; }), ['wrangler.WORKSPACE_STORE.missing']);
  assert.deepEqual(mutate((c) => { c.durable_objects.bindings[0].script_name = 'other'; }), ['wrangler.WORKSPACE_STORE.external']);
  assert.deepEqual(mutate((c) => { c.migrations = [{ tag: 'v1', new_classes: ['WorkspaceStore'] }]; }), ['wrangler.WORKSPACE_STORE.sqlite']);
  assert.deepEqual(mutate((c) => { c.migrations = []; }), ['wrangler.WORKSPACE_STORE.sqlite']);
  assert.deepEqual(
    mutate((c) => { c.migrations.push({ tag: 'v2', deleted_classes: ['WorkspaceStore'] }); }),
    ['wrangler.WORKSPACE_STORE.sqlite'],
  );
  assert.deepEqual(mutate((c) => { c.queues.producers = []; }), ['wrangler.ANALYSIS_QUEUE.producer.missing']);
  assert.deepEqual(mutate((c) => { c.queues.consumers[0].queue = 'other-queue'; }), ['wrangler.ANALYSIS_QUEUE.consumer.missing']);
  assert.deepEqual(
    mutate((c) => { c.queues.consumers.push({ ...c.queues.consumers[0] }); }),
    ['wrangler.ANALYSIS_QUEUE.consumer.duplicate'],
  );
  for (const [field, wrong] of [
    ['max_batch_size', 10],
    ['max_concurrency', undefined],
    ['max_retries', 5],
    ['retry_delay', '30'],
  ]) {
    assert.deepEqual(
      mutate((c) => { c.queues.consumers[0][field] = wrong; }),
      [`wrangler.ANALYSIS_QUEUE.consumer.${field}`],
      field,
    );
  }
  assert.deepEqual(
    mutate((c) => { delete c.queues.consumers[0].dead_letter_queue; }),
    ['wrangler.ANALYSIS_QUEUE.consumer.dead_letter_queue'],
  );
  assert.deepEqual(
    mutate((c) => { c.queues.consumers[0].dead_letter_queue = 'oi-analysis'; }),
    ['wrangler.ANALYSIS_QUEUE.consumer.dead_letter_queue'],
  );
});

test('RT-05 Wrangler vars must target cloudflare and never carry secrets', () => {
  const config = validWranglerConfig();
  config.vars.DEPLOYMENT_TARGET = 'node';
  config.vars.SESSION_SECRET = 'LEAKED-plaintext-session-secret-value-0000';
  config.vars.OPENAI_API_KEY = 'LEAKED-plaintext-provider-key';
  config.vars.OPERATOR_TOKEN = 'LEAKED-plaintext-operator-token-value-00000';
  const report = cloudflareReport({ config });
  assert.deepEqual(errorCodes(report).sort(), [
    'wrangler.vars.DEPLOYMENT_TARGET',
    'wrangler.vars.OPENAI_API_KEY.secret',
    'wrangler.vars.OPERATOR_TOKEN.secret',
    'wrangler.vars.SESSION_SECRET.secret',
  ]);
  assert.equal(JSON.stringify(report).includes('LEAKED'), false);
});

test('RT-05 ANALYSIS_RECOVERY_EPOCH must be a secret binding so rollback cannot restore an older epoch', () => {
  const env = validCloudflareEnv();
  const config = validWranglerConfig();
  config.vars.ANALYSIS_RECOVERY_EPOCH = env.ANALYSIS_RECOVERY_EPOCH;
  delete env.ANALYSIS_RECOVERY_EPOCH;
  assert.deepEqual(errorCodes(cloudflareReport({ env, config })), ['wrangler.vars.ANALYSIS_RECOVERY_EPOCH.secret']);
});

test('RT-05 Wrangler vars supply non-secret configuration and local env overrides them', () => {
  const env = validCloudflareEnv();
  const config = validWranglerConfig();
  config.vars.WORKSPACE_ID = env.WORKSPACE_ID;
  delete env.WORKSPACE_ID;
  delete env.DEPLOYMENT_MODE;
  assert.equal(cloudflareReport({ env, config }).ok, true);

  config.vars.APP_BASE_URL = '';
  assert.equal(cloudflareReport({ env, config }).ok, true);
  delete env.APP_BASE_URL;
  assert.deepEqual(errorCodes(cloudflareReport({ env, config })), ['env.APP_BASE_URL.missing']);
});

test('RT-10 Wrangler observability must not capture participant URLs', () => {
  const invocationLogs = validWranglerConfig();
  delete invocationLogs.observability.logs.invocation_logs;
  assert.deepEqual(errorCodes(cloudflareReport({ config: invocationLogs })), ['wrangler.observability.invocation_logs']);

  const inherited = validWranglerConfig();
  inherited.observability = { enabled: true };
  assert.deepEqual(errorCodes(cloudflareReport({ config: inherited })), ['wrangler.observability.invocation_logs']);

  const traces = validWranglerConfig();
  traces.observability.traces.enabled = true;
  assert.deepEqual(errorCodes(cloudflareReport({ config: traces })), ['wrangler.observability.traces']);

  const disabled = validWranglerConfig();
  disabled.observability = { enabled: false };
  assert.equal(cloudflareReport({ config: disabled }).ok, true);
});

test('RT-10 Wrangler must not export request URLs through Logpush or Tail Workers', () => {
  const logpush = validWranglerConfig();
  logpush.logpush = true;
  assert.deepEqual(errorCodes(cloudflareReport({ config: logpush })), ['wrangler.logpush']);

  const tail = validWranglerConfig();
  tail.tail_consumers = [{ service: 'url-sink' }];
  assert.deepEqual(errorCodes(cloudflareReport({ config: tail })), ['wrangler.tail_consumers']);

  const streaming = validWranglerConfig();
  streaming.streaming_tail_consumers = [{ service: 'url-sink' }];
  assert.deepEqual(errorCodes(cloudflareReport({ config: streaming })), ['wrangler.streaming_tail_consumers']);

  const off = validWranglerConfig();
  Object.assign(off, { logpush: false, tail_consumers: [], streaming_tail_consumers: [] });
  assert.equal(cloudflareReport({ config: off }).ok, true);
});

test('RT-02 missing, invalid, unchecked and multi-environment Wrangler configurations are reported', () => {
  assert.deepEqual(errorCodes(cloudflareReport({ wrangler: { error: 'missing' } })), ['wrangler.config.missing']);
  assert.deepEqual(errorCodes(cloudflareReport({ wrangler: { error: 'invalid' } })), ['wrangler.config.invalid']);
  const unchecked = cloudflareReport({ wrangler: null });
  assert.equal(unchecked.ok, true);
  assert.equal(codes(unchecked).includes('wrangler.unchecked'), true);
  const config = validWranglerConfig();
  config.env = { staging: { name: 'oi-staging' } };
  assert.equal(codes(cloudflareReport({ config })).includes('wrangler.env.unchecked'), true);
});

test('RT-02 parseJsonc strips comments and trailing commas only outside strings', () => {
  assert.deepEqual(parseJsonc(`{
    // line comment with "quotes"
    "url": "https://example.test/a//b/*c*/", /* block
    comment */ "escaped": "quote \\" // not a comment",
    "list": [1, 2,],
    "comma": ",}",
  }`), {
    url: 'https://example.test/a//b/*c*/',
    escaped: 'quote " // not a comment',
    list: [1, 2],
    comma: ',}',
  });
  assert.throws(() => parseJsonc('{ "a": 1 /* unterminated '));
  // The checker and the installer share one parser, so they read wrangler.jsonc identically.
  assert.equal(parseJsonc, installerParseJsonc);
});

test('RT-02 the repository Wrangler template satisfies the binding contract', () => {
  const config = parseJsonc(fs.readFileSync(REPO_WRANGLER, 'utf8'));
  const report = cloudflareReport({ config });
  const wranglerErrors = errorCodes(report).filter((code) => code.startsWith('wrangler.'));
  assert.deepEqual(wranglerErrors, []);
});

test('SETUP-01 the CLI runs through a symlinked path and fails an incomplete setup there too', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oi-setup-link-'));
  try {
    const link = path.join(directory, 'check-setup.mjs');
    fs.symlinkSync(CHECKER, link);
    const result = spawnSync(process.execPath, [link, '--mode', 'standalone', '--production', '--json'], {
      cwd: directory,
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    });
    // Node runs a linked script from its real path; an argv[1] comparison
    // skipped the check there and exited 0 with no report.
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('SETUP-01 the CLI reads .dev.vars and the default wrangler.jsonc and never prints values', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oi-setup-check-'));
  try {
    const env = validCloudflareEnv();
    fs.writeFileSync(
      path.join(directory, '.dev.vars'),
      Object.entries(env).map(([name, value]) => `${name}=${value}`).join('\n'),
    );
    fs.writeFileSync(
      path.join(directory, 'wrangler.jsonc'),
      `// synthetic\n${JSON.stringify(validWranglerConfig(), null, 2).replace(/\n}$/, ',\n}')}`,
    );
    const run = (args) => spawnSync(process.execPath, [CHECKER, ...args], {
      cwd: directory,
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    });

    const passing = run(['--target', 'cloudflare', '--env-file', '.dev.vars', '--json']);
    assert.equal(passing.status, 0, passing.stdout + passing.stderr);
    const report = JSON.parse(passing.stdout);
    assert.equal(report.target, 'cloudflare');
    assert.deepEqual(report.sources, ['.dev.vars', 'wrangler.jsonc']);
    for (const value of Object.values(env).filter((item) => item.length > 16)) {
      assert.equal(passing.stdout.includes(value), false);
    }

    const human = run(['--env-file', '.dev.vars']);
    assert.equal(human.status, 0, human.stdout + human.stderr);
    assert.match(human.stdout, /standalone on Cloudflare \(production\)/);

    fs.rmSync(path.join(directory, 'wrangler.jsonc'));
    const missing = run(['--target', 'cloudflare', '--env-file', '.dev.vars', '--json']);
    assert.equal(missing.status, 1);
    assert.equal(JSON.parse(missing.stdout).checks.some((item) => item.code === 'wrangler.config.missing'), true);

    const invalidTarget = run(['--target', 'lambda', '--env-file', '.dev.vars']);
    assert.equal(invalidTarget.status, 1);
    assert.equal(invalidTarget.stdout.includes('lambda'), false);

    const unsafe = validWranglerConfig();
    Object.assign(unsafe.vars, {
      ANALYSIS_RECOVERY_EPOCH: env.ANALYSIS_RECOVERY_EPOCH,
      OPERATOR_TOKEN: 'synthetic-operator-token-in-plain-vars-000000',
      WORKSPACE_BOOTSTRAP: 'yes-please',
    });
    Object.assign(unsafe, { logpush: true, tail_consumers: [{ service: 'url-sink' }] });
    fs.writeFileSync(path.join(directory, 'wrangler.jsonc'), JSON.stringify(unsafe));
    const refused = run(['--target', 'cloudflare', '--env-file', '.dev.vars', '--json']);
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    const refusedCodes = JSON.parse(refused.stdout).checks.filter((item) => item.status === 'error').map((item) => item.code);
    for (const code of [
      'wrangler.vars.ANALYSIS_RECOVERY_EPOCH.secret',
      'wrangler.vars.OPERATOR_TOKEN.secret',
      'wrangler.logpush',
      'wrangler.tail_consumers',
    ]) {
      assert.equal(refusedCodes.includes(code), true, code);
    }
    for (const value of ['synthetic-operator-token-in-plain-vars', env.ANALYSIS_RECOVERY_EPOCH, 'yes-please']) {
      assert.equal(refused.stdout.includes(value), false, value);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
