#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIN_NODE = [24, 15, 0];
const MODES = new Set(['demo', 'standalone', 'hosted']);
const SECRET_PLACEHOLDERS = /^(?:change[-_ ]?me|replace[-_ ]?me|your[-_ ]|example|todo|secret$)/i;

function check(status, code, message) {
  return { status, code, message };
}

export function parseDotenv(text) {
  const parsed = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    const [, name, rawValue] = match;
    let value = rawValue.trim();

    if (
      value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }

    parsed[name] = value;
  }

  return parsed;
}

function parseVersion(version) {
  const match = String(version).replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function versionAtLeast(actual, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
}

function isPresent(env, name) {
  return typeof env[name] === 'string' && env[name].trim().length > 0;
}

function looksLikePlaceholder(value) {
  return SECRET_PLACEHOLDERS.test(value.trim());
}

function isBase64Key32(value) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return false;
  try {
    return Buffer.from(value, 'base64').length === 32;
  } catch {
    return false;
  }
}

function addRequiredEnv(checks, env, name, options = {}) {
  if (!isPresent(env, name)) {
    checks.push(check('error', `env.${name}.missing`, `${name} is missing.`));
    return false;
  }

  const value = env[name];
  if (looksLikePlaceholder(value)) {
    checks.push(check('error', `env.${name}.placeholder`, `${name} still contains a placeholder.`));
    return false;
  }

  if (options.minLength && value.length < options.minLength) {
    checks.push(check(
      'error',
      `env.${name}.short`,
      `${name} must be at least ${options.minLength} characters.`,
    ));
    return false;
  }

  checks.push(check('pass', `env.${name}.present`, `${name} is configured.`));
  return true;
}

function validateUrl(checks, env, name, { upstash = false, production = false } = {}) {
  if (!isPresent(env, name)) return;

  try {
    const parsed = new URL(env[name]);
    const localhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if (parsed.protocol !== 'https:' && !(localhost && !production)) {
      checks.push(check('error', `env.${name}.protocol`, `${name} must use HTTPS outside local development.`));
      return;
    }
    if (upstash && !parsed.hostname.endsWith('.upstash.io')) {
      checks.push(check('error', `env.${name}.host`, `${name} must be an Upstash REST URL.`));
      return;
    }
    if (name === 'APP_BASE_URL' && (parsed.pathname !== '/' || parsed.search || parsed.hash)) {
      checks.push(check('error', `env.${name}.origin`, `${name} must be an origin without a path, query, or fragment.`));
      return;
    }
    checks.push(check('pass', `env.${name}.valid`, `${name} has a valid URL shape.`));
  } catch {
    checks.push(check('error', `env.${name}.invalid`, `${name} is not a valid URL.`));
  }
}

function validateIndependentSecrets(checks, env, names) {
  const configured = names.filter((name) => isPresent(env, name));
  for (let left = 0; left < configured.length; left += 1) {
    for (let right = left + 1; right < configured.length; right += 1) {
      if (env[configured[left]] === env[configured[right]]) {
        checks.push(check(
          'error',
          `env.secrets.duplicate.${configured[left]}.${configured[right]}`,
          `${configured[left]} and ${configured[right]} must be independent values.`,
        ));
      }
    }
  }
}

function validateHostedKeyring(checks, env) {
  const hasKeyring = isPresent(env, 'CREDENTIAL_ENCRYPTION_KEYS');
  const hasLegacyKey = isPresent(env, 'CREDENTIAL_ENCRYPTION_KEY');

  if (!hasKeyring) {
    checks.push(check(
      'error',
      'env.credentialEncryption.missing',
      'CREDENTIAL_ENCRYPTION_KEYS and CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID are required for a new hosted deployment.',
    ));
    if (!hasLegacyKey) return;
  }

  if (hasKeyring) {
    let keyring;
    try {
      keyring = JSON.parse(env.CREDENTIAL_ENCRYPTION_KEYS);
    } catch {
      checks.push(check('error', 'env.CREDENTIAL_ENCRYPTION_KEYS.json', 'CREDENTIAL_ENCRYPTION_KEYS must be a JSON object.'));
      return;
    }

    if (!keyring || Array.isArray(keyring) || typeof keyring !== 'object' || Object.keys(keyring).length === 0) {
      checks.push(check('error', 'env.CREDENTIAL_ENCRYPTION_KEYS.empty', 'CREDENTIAL_ENCRYPTION_KEYS must contain at least one key.'));
      return;
    }

    const invalidKey = Object.entries(keyring).some(([keyId, value]) => (
      !/^[A-Za-z0-9_-]{1,64}$/.test(keyId)
      || keyId === 'legacy'
      || typeof value !== 'string'
      || !isBase64Key32(value)
    ));
    if (invalidKey) {
      checks.push(check(
        'error',
        'env.CREDENTIAL_ENCRYPTION_KEYS.invalid',
        'Every credential key ID must be safe and every key must be a base64-encoded 32-byte value.',
      ));
      return;
    }

    if (!addRequiredEnv(checks, env, 'CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID')) return;
    if (env.CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID === 'legacy') {
      checks.push(check(
        'error',
        'env.CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID.reserved',
        'CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID uses a reserved key ID.',
      ));
      return;
    }
    if (!(env.CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID in keyring)) {
      checks.push(check(
        'error',
        'env.CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID.unknown',
        'CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID must name a key in CREDENTIAL_ENCRYPTION_KEYS.',
      ));
      return;
    }
    checks.push(check('pass', 'env.CREDENTIAL_ENCRYPTION_KEYS.valid', 'The credential-encryption keyring is valid.'));
  }

  if (hasLegacyKey) {
    if (!isBase64Key32(env.CREDENTIAL_ENCRYPTION_KEY)) {
      checks.push(check(
        'error',
        'env.CREDENTIAL_ENCRYPTION_KEY.invalid',
        'CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte value.',
      ));
    } else {
      checks.push(check(
        'warn',
        'env.CREDENTIAL_ENCRYPTION_KEY.legacy',
        'CREDENTIAL_ENCRYPTION_KEY is legacy; retain it only while rotating old stored credentials.',
      ));
    }
  }
}

export function validateSetup({
  mode,
  production = false,
  env = {},
  nodeVersion = process.versions.node,
} = {}) {
  const checks = [];
  const selectedMode = mode || env.DEPLOYMENT_MODE || 'standalone';
  const parsedNode = parseVersion(nodeVersion);

  if (!MODES.has(selectedMode)) {
    return {
      mode: selectedMode,
      production,
      ok: false,
      checks: [check('error', 'mode.invalid', 'Mode must be demo, standalone, or hosted.')],
    };
  }

  if (!parsedNode || !versionAtLeast(parsedNode, MIN_NODE)) {
    checks.push(check('error', 'node.unsupported', 'Node.js 24.15.0 or newer is required.'));
  } else {
    checks.push(check('pass', 'node.supported', 'The Node.js version is supported.'));
  }

  if (selectedMode === 'demo') {
    checks.push(check('pass', 'demo.keyless', 'The scripted demo requires no provider key, storage, or authentication environment variables.'));
    return { mode: selectedMode, production, ok: !checks.some((item) => item.status === 'error'), checks };
  }

  const configuredMode = env.DEPLOYMENT_MODE || 'standalone';
  if (configuredMode !== selectedMode) {
    checks.push(check('error', 'mode.mismatch', `DEPLOYMENT_MODE does not match the requested ${selectedMode} check.`));
  } else {
    checks.push(check('pass', 'mode.match', `Deployment mode is ${selectedMode}.`));
  }

  addRequiredEnv(checks, env, 'SESSION_SECRET', { minLength: 32 });
  addRequiredEnv(checks, env, 'PARTICIPANT_TOKEN_SECRET', { minLength: 32 });
  addRequiredEnv(checks, env, 'RATE_LIMIT_SALT', { minLength: 32 });

  if (production || selectedMode === 'hosted') {
    addRequiredEnv(checks, env, 'APP_BASE_URL');
    validateUrl(checks, env, 'APP_BASE_URL', { production });
  } else if (isPresent(env, 'APP_BASE_URL')) {
    validateUrl(checks, env, 'APP_BASE_URL', { production: false });
  } else {
    checks.push(check('warn', 'env.APP_BASE_URL.local', 'APP_BASE_URL is optional locally but required for production links and OAuth callbacks.'));
  }

  if (isPresent(env, 'NEXT_PUBLIC_BASE_URL')) {
    checks.push(check('warn', 'env.NEXT_PUBLIC_BASE_URL.legacy', 'NEXT_PUBLIC_BASE_URL is obsolete; use server-only APP_BASE_URL.'));
  }

  if (selectedMode === 'standalone') {
    addRequiredEnv(checks, env, 'ADMIN_PASSWORD', { minLength: 16 });
    addRequiredEnv(checks, env, 'KV_REST_API_URL');
    addRequiredEnv(checks, env, 'KV_REST_API_TOKEN');
    validateUrl(checks, env, 'KV_REST_API_URL', { upstash: true, production });

    const hasGemini = isPresent(env, 'GEMINI_API_KEY');
    const hasAnthropic = isPresent(env, 'ANTHROPIC_API_KEY');
    if (!hasGemini && !hasAnthropic) {
      checks.push(check('error', 'env.aiProvider.missing', 'Configure at least one of GEMINI_API_KEY or ANTHROPIC_API_KEY.'));
    } else {
      checks.push(check('pass', 'env.aiProvider.present', 'At least one AI provider key is configured.'));
    }

    if (env.AI_PROVIDER === 'gemini' && !hasGemini) {
      checks.push(check('error', 'env.AI_PROVIDER.gemini', 'AI_PROVIDER selects Gemini but GEMINI_API_KEY is missing.'));
    } else if (env.AI_PROVIDER === 'claude' && !hasAnthropic) {
      checks.push(check('error', 'env.AI_PROVIDER.claude', 'AI_PROVIDER selects Claude but ANTHROPIC_API_KEY is missing.'));
    } else if (isPresent(env, 'AI_PROVIDER') && !['gemini', 'claude'].includes(env.AI_PROVIDER)) {
      checks.push(check('error', 'env.AI_PROVIDER.invalid', 'AI_PROVIDER must be gemini or claude.'));
    }

    validateIndependentSecrets(checks, env, [
      'ADMIN_PASSWORD',
      'SESSION_SECRET',
      'PARTICIPANT_TOKEN_SECRET',
      'RATE_LIMIT_SALT',
    ]);
  }

  if (selectedMode === 'hosted') {
    addRequiredEnv(checks, env, 'PLATFORM_KV_REST_API_URL');
    addRequiredEnv(checks, env, 'PLATFORM_KV_REST_API_TOKEN');
    addRequiredEnv(checks, env, 'PLATFORM_KEY_PREFIX');
    validateUrl(checks, env, 'PLATFORM_KV_REST_API_URL', { upstash: true, production });
    validateHostedKeyring(checks, env);

    const oauthProviders = [
      ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
      ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'],
    ];
    let completeProviders = 0;
    for (const [clientId, clientSecret] of oauthProviders) {
      const hasId = isPresent(env, clientId);
      const hasSecret = isPresent(env, clientSecret);
      if (hasId !== hasSecret) {
        checks.push(check('error', `env.oauth.${clientId}.incomplete`, `${clientId} and ${clientSecret} must be configured together.`));
      } else if (hasId && hasSecret) {
        completeProviders += 1;
        checks.push(check('pass', `env.oauth.${clientId}.complete`, `${clientId} and its matching secret are configured.`));
      }
    }
    if (completeProviders === 0) {
      checks.push(check('error', 'env.oauth.missing', 'Configure at least one complete Google or GitHub OAuth client pair.'));
    }

    validateIndependentSecrets(checks, env, [
      'SESSION_SECRET',
      'PARTICIPANT_TOKEN_SECRET',
      'RATE_LIMIT_SALT',
    ]);

    for (const name of ['ADMIN_PASSWORD', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'KV_REST_API_URL', 'KV_REST_API_TOKEN']) {
      if (isPresent(env, name)) {
        checks.push(check('warn', `env.${name}.hosted`, `${name} is not part of the hosted researcher BYOS path.`));
      }
    }
  }

  return {
    mode: selectedMode,
    production,
    ok: !checks.some((item) => item.status === 'error'),
    checks,
  };
}

function parseArgs(argv) {
  const args = { mode: undefined, production: false, json: false, envFile: undefined };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mode') {
      args.mode = argv[index + 1];
      index += 1;
    } else if (arg === '--production') {
      args.production = true;
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--env-file') {
      args.envFile = argv[index + 1];
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function loadLocalEnvironment(cwd, envFile) {
  const loaded = {};
  const sources = [];
  const nodeEnv = process.env.NODE_ENV || 'development';
  const candidates = envFile
    ? [envFile]
    : ['.env', `.env.${nodeEnv}`, '.env.local', `.env.${nodeEnv}.local`];

  for (const candidate of candidates) {
    const absolute = path.resolve(cwd, candidate);
    if (!fs.existsSync(absolute)) continue;
    Object.assign(loaded, parseDotenv(fs.readFileSync(absolute, 'utf8')));
    sources.push(path.relative(cwd, absolute) || path.basename(absolute));
  }

  // An explicitly requested file is an isolated, deterministic audit target.
  // Without --env-file, process env has the same highest precedence it has in
  // the running Next.js process.
  return { env: envFile ? loaded : { ...loaded, ...process.env }, sources };
}

function printHuman(report, sources) {
  console.log(`OpenInterviewer setup check: ${report.mode}${report.production ? ' (production)' : ''}`);
  console.log(`Environment sources: ${sources.length ? sources.join(', ') : 'process environment only'}`);
  for (const item of report.checks) {
    console.log(`${item.status.toUpperCase().padEnd(5)} ${item.message}`);
  }
  console.log(report.ok ? 'Result: ready' : 'Result: setup incomplete');
}

function printHelp() {
  console.log(`Usage: node scripts/check-setup.mjs [options]

Options:
  --mode demo|standalone|hosted  Validate one setup journey
  --production                   Require production-only settings
  --env-file PATH                Read a specific env file instead of Next.js local files
  --json                         Emit redacted machine-readable JSON
  --help                         Show this help

The checker reads names and validates shapes only. It never prints values,
writes secrets, makes network requests, or calls an AI provider.`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      printHelp();
      process.exit(0);
    }
    const { env, sources } = loadLocalEnvironment(process.cwd(), args.envFile);
    const report = validateSetup({
      mode: args.mode,
      production: args.production || env.NODE_ENV === 'production',
      env,
    });
    if (args.json) {
      console.log(JSON.stringify({ ...report, sources }, null, 2));
    } else {
      printHuman(report, sources);
    }
    process.exit(report.ok ? 0 : 1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Setup check failed.');
    process.exit(2);
  }
}
