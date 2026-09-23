#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseJsonc } from './cloudflare/lib.mjs';

// One JSONC parser for the checker and the Cloudflare installer, so both read
// wrangler.jsonc identically.
export { parseJsonc };

const MIN_NODE = [24, 19, 0];
const MODES = new Set(['demo', 'standalone', 'hosted']);
const TARGETS = new Set(['node', 'cloudflare']);
const WORKSPACE_ID_PATTERN = /^ws_[a-f0-9]{32}$/;
const RECOVERY_EPOCH_PATTERN = /^ep_[a-f0-9]{32}$/;
const WORKSPACE_JURISDICTIONS = new Set(['', 'eu', 'fedramp']);
// Non-empty only while the installer initializes a fresh workspace object.
const WORKSPACE_BOOTSTRAP_STATES = new Set(['', 'open', 'recovery']);
// The analysis consumer contract (03-analysis-jobs.md): one message at a time,
// bounded platform retries, and a dead-letter queue.
const ANALYSIS_CONSUMER_SETTINGS = [
  ['max_batch_size', 1],
  ['max_concurrency', 1],
  ['max_retries', 3],
  ['retry_delay', 30],
];
const AI_PROVIDERS = {
  gemini: { key: 'GEMINI_API_KEY', label: 'Gemini' },
  claude: { key: 'ANTHROPIC_API_KEY', label: 'Claude' },
  openai: { key: 'OPENAI_API_KEY', label: 'OpenAI' },
  openrouter: { key: 'OPENROUTER_API_KEY', label: 'OpenRouter' },
};
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

// Mirrors src/lib/appBaseUrl.ts: localhost, *.localhost and loopback addresses
// (WHATWG URL already canonicalizes IPv4 and bracketed IPv6 hosts).
function isLocalHostname(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (host === '[::1]') return true;
  const mapped = host.match(/^\[::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}\]$/);
  return Boolean(mapped && parseInt(mapped[1], 16) >> 8 === 127);
}

function validateUrl(checks, env, name, { upstash = false, production = false } = {}) {
  if (!isPresent(env, name)) return;

  try {
    const parsed = new URL(env[name]);
    const localhost = isLocalHostname(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(localhost && !production)) {
      checks.push(check('error', `env.${name}.protocol`, `${name} must use HTTPS outside local development.`));
      return;
    }
    if (upstash && !parsed.hostname.endsWith('.upstash.io')) {
      checks.push(check('error', `env.${name}.host`, `${name} must be an Upstash REST URL.`));
      return;
    }
    if (name === 'APP_BASE_URL') {
      if (
        parsed.pathname !== '/'
        || parsed.search
        || parsed.hash
        || parsed.username
        || parsed.password
      ) {
        checks.push(check(
          'error',
          `env.${name}.origin`,
          `${name} must be an origin without credentials, a path, query, or fragment.`,
        ));
        return;
      }
      if (production && localhost) {
        checks.push(check('error', `env.${name}.local`, `${name} must be a public origin in production, not localhost.`));
        return;
      }
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

// ANALYSIS_RECOVERY_EPOCH is not sensitive; it is a secret binding so that
// `wrangler rollback` cannot silently reinstate an older epoch.
const CLOUDFLARE_SECRET_NAMES = [
  'ADMIN_PASSWORD',
  'SESSION_SECRET',
  'PARTICIPANT_TOKEN_SECRET',
  'RATE_LIMIT_SALT',
  'OPERATOR_TOKEN',
  'ANALYSIS_RECOVERY_EPOCH',
  ...Object.values(AI_PROVIDERS).map((provider) => provider.key),
];

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function stringVars(config) {
  const vars = isRecord(config?.vars) ? config.vars : {};
  return Object.fromEntries(Object.entries(vars).filter(([, value]) => typeof value === 'string'));
}

function validateFormat(checks, env, name, pattern, description) {
  const value = env[name];
  if (typeof value !== 'string' || value.length === 0) {
    checks.push(check('error', `env.${name}.missing`, `${name} is missing.`));
  } else if (!pattern.test(value)) {
    checks.push(check('error', `env.${name}.invalid`, `${name} must be ${description}.`));
  } else {
    checks.push(check('pass', `env.${name}.valid`, `${name} has a valid format.`));
  }
}

function validateWorkspaceStoreBinding(checks, config) {
  const bindings = Array.isArray(config.durable_objects?.bindings) ? config.durable_objects.bindings : [];
  const binding = bindings.find((item) => isRecord(item) && item.name === 'WORKSPACE_STORE');
  if (!binding || !isNonEmptyString(binding.class_name)) {
    checks.push(check('error', 'wrangler.WORKSPACE_STORE.missing', 'Declare the WORKSPACE_STORE Durable Object binding.'));
    return;
  }
  if (binding.script_name !== undefined) {
    checks.push(check('error', 'wrangler.WORKSPACE_STORE.external', 'WORKSPACE_STORE must be implemented by this Worker, not another script.'));
    return;
  }
  const className = binding.class_name;
  const migrations = Array.isArray(config.migrations) ? config.migrations.filter(isRecord) : [];
  const listed = (field) => migrations.some((migration) => (
    Array.isArray(migration[field]) && migration[field].includes(className)
  ));
  if (!listed('new_sqlite_classes') || listed('new_classes') || listed('deleted_classes')) {
    checks.push(check(
      'error',
      'wrangler.WORKSPACE_STORE.sqlite',
      'WORKSPACE_STORE must be created by a new_sqlite_classes migration and never deleted.',
    ));
    return;
  }
  checks.push(check('pass', 'wrangler.WORKSPACE_STORE.valid', 'The SQLite-backed WORKSPACE_STORE Durable Object is declared.'));
}

function validateAnalysisQueue(checks, config) {
  const queues = isRecord(config.queues) ? config.queues : {};
  const producers = Array.isArray(queues.producers) ? queues.producers : [];
  const producer = producers.find((item) => isRecord(item) && item.binding === 'ANALYSIS_QUEUE');
  if (!producer || !isNonEmptyString(producer.queue)) {
    checks.push(check('error', 'wrangler.ANALYSIS_QUEUE.producer.missing', 'Declare the ANALYSIS_QUEUE producer binding.'));
    return;
  }
  checks.push(check('pass', 'wrangler.ANALYSIS_QUEUE.producer.present', 'The ANALYSIS_QUEUE producer is declared.'));

  const consumers = (Array.isArray(queues.consumers) ? queues.consumers : [])
    .filter((item) => isRecord(item) && item.queue === producer.queue);
  if (consumers.length === 0) {
    checks.push(check('error', 'wrangler.ANALYSIS_QUEUE.consumer.missing', 'This Worker must consume the same queue that ANALYSIS_QUEUE produces to.'));
    return;
  }
  if (consumers.length > 1) {
    checks.push(check('error', 'wrangler.ANALYSIS_QUEUE.consumer.duplicate', 'Declare exactly one consumer for the analysis queue.'));
    return;
  }
  const [consumer] = consumers;
  let valid = true;
  for (const [field, expected] of ANALYSIS_CONSUMER_SETTINGS) {
    if (consumer[field] !== expected) {
      valid = false;
      checks.push(check(
        'error',
        `wrangler.ANALYSIS_QUEUE.consumer.${field}`,
        `The analysis queue consumer must set ${field} to ${expected}.`,
      ));
    }
  }
  if (!isNonEmptyString(consumer.dead_letter_queue) || consumer.dead_letter_queue === producer.queue) {
    valid = false;
    checks.push(check(
      'error',
      'wrangler.ANALYSIS_QUEUE.consumer.dead_letter_queue',
      'The analysis queue consumer must name a separate dead_letter_queue.',
    ));
  }
  if (valid) {
    checks.push(check('pass', 'wrangler.ANALYSIS_QUEUE.consumer.valid', 'The analysis queue consumer settings are valid.'));
  }
}

function validateWranglerConfig(checks, wrangler) {
  if (!wrangler) {
    checks.push(check('warn', 'wrangler.unchecked', 'The Wrangler configuration was not checked.'));
    return;
  }
  if (wrangler.error === 'missing') {
    checks.push(check('error', 'wrangler.config.missing', 'The Wrangler configuration file was not found.'));
    return;
  }
  if (wrangler.error || !isRecord(wrangler.config)) {
    checks.push(check('error', 'wrangler.config.invalid', 'The Wrangler configuration is not valid JSONC.'));
    return;
  }
  const { config } = wrangler;

  validateWorkspaceStoreBinding(checks, config);
  validateAnalysisQueue(checks, config);

  const vars = isRecord(config.vars) ? config.vars : {};
  if (vars.DEPLOYMENT_TARGET !== 'cloudflare') {
    checks.push(check(
      'error',
      'wrangler.vars.DEPLOYMENT_TARGET',
      'Wrangler vars must set DEPLOYMENT_TARGET to cloudflare; the Worker refuses to serve otherwise.',
    ));
  }
  for (const name of CLOUDFLARE_SECRET_NAMES) {
    if (isNonEmptyString(vars[name])) {
      checks.push(check('error', `wrangler.vars.${name}.secret`, `${name} must be a Worker secret, not a plain-text var.`));
    }
  }

  // RT-10: automatic invocation logs and traces record raw request URLs,
  // including participant entry codes.
  const observability = isRecord(config.observability) ? config.observability : {};
  const logs = isRecord(observability.logs) ? observability.logs : {};
  const logsEnabled = logs.enabled ?? observability.enabled ?? false;
  if (logsEnabled && logs.invocation_logs !== false) {
    checks.push(check(
      'error',
      'wrangler.observability.invocation_logs',
      'Set observability.logs.invocation_logs to false; invocation logs capture participant URLs.',
    ));
  }
  if (isRecord(observability.traces) && observability.traces.enabled === true) {
    checks.push(check(
      'error',
      'wrangler.observability.traces',
      'Keep automatic traces disabled; they capture participant URLs.',
    ));
  }
  if (config.logpush === true) {
    checks.push(check(
      'error',
      'wrangler.logpush',
      'Keep logpush disabled; Workers Trace Events export request URLs, including participant entry codes.',
    ));
  }
  for (const field of ['tail_consumers', 'streaming_tail_consumers']) {
    if (Array.isArray(config[field]) && config[field].length > 0) {
      checks.push(check(
        'error',
        `wrangler.${field}`,
        `Remove ${field}; Tail Workers receive request URLs, including participant entry codes.`,
      ));
    }
  }
  if (isRecord(config.env) && Object.keys(config.env).length > 0) {
    checks.push(check(
      'warn',
      'wrangler.env.unchecked',
      'Named Wrangler environments are not checked; they do not inherit bindings from the top level.',
    ));
  }
}

function validateCloudflareSetup(checks, env, selectedMode, wrangler) {
  if (selectedMode === 'hosted' || env.DEPLOYMENT_MODE === 'hosted') {
    checks.push(check(
      'error',
      'env.cloudflare.hosted',
      'Hosted mode is not supported on Cloudflare; use the Node deployment for hosted researcher BYOS.',
    ));
    return;
  }
  if (!isPresent(env, 'DEPLOYMENT_MODE')) {
    checks.push(check('error', 'env.DEPLOYMENT_MODE.missing', 'DEPLOYMENT_MODE must be standalone on Cloudflare.'));
  } else if (env.DEPLOYMENT_MODE !== selectedMode) {
    checks.push(check('error', 'mode.mismatch', `DEPLOYMENT_MODE does not match the requested ${selectedMode} check.`));
  } else {
    checks.push(check('pass', 'mode.match', `Deployment mode is ${selectedMode}.`));
  }
  if (env.DEPLOYMENT_TARGET !== 'cloudflare') {
    checks.push(check('error', 'target.mismatch', 'DEPLOYMENT_TARGET must be cloudflare for this check.'));
  }

  addRequiredEnv(checks, env, 'SESSION_SECRET', { minLength: 32 });
  addRequiredEnv(checks, env, 'PARTICIPANT_TOKEN_SECRET', { minLength: 32 });
  addRequiredEnv(checks, env, 'RATE_LIMIT_SALT', { minLength: 32 });
  addRequiredEnv(checks, env, 'ADMIN_PASSWORD', { minLength: 16 });
  addRequiredEnv(checks, env, 'APP_BASE_URL');
  validateUrl(checks, env, 'APP_BASE_URL', { production: true });
  if (isPresent(env, 'NEXT_PUBLIC_BASE_URL')) {
    checks.push(check('warn', 'env.NEXT_PUBLIC_BASE_URL.legacy', 'NEXT_PUBLIC_BASE_URL is obsolete; use server-only APP_BASE_URL.'));
  }

  const aiTransport = isPresent(env, 'AI_TRANSPORT') ? env.AI_TRANSPORT.trim() : 'direct';
  if (aiTransport === 'gateway') {
    checks.push(check('error', 'env.cloudflare.gateway', 'Cloudflare uses direct provider transport; Vercel AI Gateway is not supported.'));
  } else if (aiTransport !== 'direct') {
    checks.push(check('error', 'env.AI_TRANSPORT.invalid', 'AI_TRANSPORT must be direct on Cloudflare.'));
  } else {
    checks.push(check('pass', 'env.AI_TRANSPORT.valid', 'AI transport is direct.'));
  }

  const selectedProvider = isPresent(env, 'AI_PROVIDER') ? env.AI_PROVIDER.trim() : 'gemini';
  const providerConfig = Object.prototype.hasOwnProperty.call(AI_PROVIDERS, selectedProvider)
    ? AI_PROVIDERS[selectedProvider]
    : undefined;
  if (!providerConfig) {
    checks.push(check('error', 'env.AI_PROVIDER.invalid', 'AI_PROVIDER must be gemini, claude, openai, or openrouter.'));
  } else if (!isPresent(env, providerConfig.key)) {
    checks.push(check(
      'error',
      `env.AI_PROVIDER.${selectedProvider}`,
      `AI_PROVIDER selects ${providerConfig.label} but ${providerConfig.key} is missing.`,
    ));
  } else if (looksLikePlaceholder(env[providerConfig.key])) {
    checks.push(check('error', `env.${providerConfig.key}.placeholder`, `${providerConfig.key} still contains a placeholder.`));
  } else {
    checks.push(check('pass', 'env.aiProvider.present', `The ${providerConfig.label} provider key is configured.`));
  }

  validateFormat(checks, env, 'WORKSPACE_ID', WORKSPACE_ID_PATTERN, 'ws_ followed by 32 lowercase hex characters');
  validateFormat(
    checks,
    env,
    'ANALYSIS_RECOVERY_EPOCH',
    RECOVERY_EPOCH_PATTERN,
    'ep_ followed by 32 lowercase hex characters',
  );
  if (!WORKSPACE_JURISDICTIONS.has(env.WORKSPACE_JURISDICTION ?? '')) {
    checks.push(check('error', 'env.WORKSPACE_JURISDICTION.invalid', 'WORKSPACE_JURISDICTION must be empty, eu, or fedramp.'));
  } else {
    checks.push(check('pass', 'env.WORKSPACE_JURISDICTION.valid', 'WORKSPACE_JURISDICTION is valid.'));
  }
  const bootstrap = env.WORKSPACE_BOOTSTRAP ?? '';
  if (!WORKSPACE_BOOTSTRAP_STATES.has(bootstrap)) {
    checks.push(check('error', 'env.WORKSPACE_BOOTSTRAP.invalid', 'WORKSPACE_BOOTSTRAP must be empty, open, or recovery.'));
  } else if (bootstrap) {
    checks.push(check(
      'warn',
      'env.WORKSPACE_BOOTSTRAP.active',
      'WORKSPACE_BOOTSTRAP is set. Clear it once the workspace is initialized; while set, a changed workspace identity, jurisdiction or Worker name initializes an empty writable workspace.',
    ));
  }

  // Operator routes refuse without this token; the rest of the deployment works.
  if (isPresent(env, 'OPERATOR_TOKEN')) {
    addRequiredEnv(checks, env, 'OPERATOR_TOKEN', { minLength: 32 });
  } else {
    checks.push(check(
      'warn',
      'env.OPERATOR_TOKEN.missing',
      'OPERATOR_TOKEN is not set; maintenance, backup and recovery operator actions stay unavailable until it is.',
    ));
  }

  for (const name of ['KV_REST_API_URL', 'KV_REST_API_TOKEN']) {
    if (isPresent(env, name)) {
      checks.push(check('warn', `env.${name}.cloudflare`, `${name} is ignored on Cloudflare; research data lives in the workspace Durable Object.`));
    }
  }

  validateIndependentSecrets(checks, env, [
    'ADMIN_PASSWORD',
    'SESSION_SECRET',
    'PARTICIPANT_TOKEN_SECRET',
    'RATE_LIMIT_SALT',
    'OPERATOR_TOKEN',
  ]);
  validateWranglerConfig(checks, wrangler);
}

export function validateSetup({
  mode,
  production = false,
  env = {},
  nodeVersion = process.versions.node,
  target,
  wrangler,
} = {}) {
  const checks = [];
  const selectedMode = mode || env.DEPLOYMENT_MODE || 'standalone';
  const parsedNode = parseVersion(nodeVersion);
  const configuredTarget = env.DEPLOYMENT_TARGET || undefined;
  const selectedTarget = target || configuredTarget || 'node';

  if (!TARGETS.has(selectedTarget) || (configuredTarget !== undefined && !TARGETS.has(configuredTarget))) {
    return {
      mode: selectedMode,
      target: null,
      production,
      ok: false,
      checks: [check('error', 'env.DEPLOYMENT_TARGET.invalid', 'DEPLOYMENT_TARGET must be node or cloudflare.')],
    };
  }

  if (!MODES.has(selectedMode)) {
    return {
      mode: selectedMode,
      target: selectedTarget,
      production,
      ok: false,
      checks: [check('error', 'mode.invalid', 'Mode must be demo, standalone, or hosted.')],
    };
  }

  if (!parsedNode || !versionAtLeast(parsedNode, MIN_NODE)) {
    checks.push(check('error', 'node.unsupported', 'Node.js 24.19.0 or newer is required.'));
  } else {
    checks.push(check('pass', 'node.supported', 'The Node.js version is supported.'));
  }

  if (selectedMode === 'demo') {
    checks.push(check('pass', 'demo.keyless', 'The scripted demo requires no provider key, storage, or authentication environment variables.'));
    return {
      mode: selectedMode,
      target: selectedTarget,
      production,
      ok: !checks.some((item) => item.status === 'error'),
      checks,
    };
  }

  if (selectedTarget === 'cloudflare') {
    // Wrangler vars are the deployed non-secret configuration; a local
    // .dev.vars (or other env file) overrides them, as `wrangler dev` does.
    const effectiveEnv = { ...stringVars(wrangler?.config), ...env };
    validateCloudflareSetup(checks, effectiveEnv, selectedMode, wrangler);
    // The Cloudflare target is always production-strict.
    return {
      mode: selectedMode,
      target: selectedTarget,
      production: true,
      ok: !checks.some((item) => item.status === 'error'),
      checks,
    };
  }

  if (configuredTarget !== undefined && configuredTarget !== selectedTarget) {
    checks.push(check('error', 'target.mismatch', `DEPLOYMENT_TARGET does not match the requested ${selectedTarget} check.`));
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

    const aiTransport = isPresent(env, 'AI_TRANSPORT') ? env.AI_TRANSPORT.trim() : 'direct';
    const selectedProvider = isPresent(env, 'AI_PROVIDER') ? env.AI_PROVIDER.trim() : 'gemini';
    const providerConfig = AI_PROVIDERS[selectedProvider];
    if (aiTransport !== 'direct' && aiTransport !== 'gateway') {
      checks.push(check('error', 'env.AI_TRANSPORT.invalid', 'AI_TRANSPORT must be direct or gateway.'));
    } else {
      checks.push(check('pass', 'env.AI_TRANSPORT.valid', `AI transport is ${aiTransport}.`));
    }
    if (!providerConfig) {
      checks.push(check(
        'error',
        'env.AI_PROVIDER.invalid',
        'AI_PROVIDER must be gemini, claude, openai, or openrouter.',
      ));
    }

    if (aiTransport === 'gateway') {
      const hasGatewayAuth = isPresent(env, 'AI_GATEWAY_API_KEY')
        || isPresent(env, 'VERCEL_OIDC_TOKEN')
        || env.VERCEL === '1';
      if (!hasGatewayAuth) {
        checks.push(check(
          'error',
          'env.aiGateway.auth.missing',
          'Gateway transport requires Vercel OIDC or AI_GATEWAY_API_KEY.',
        ));
      } else {
        checks.push(check('pass', 'env.aiGateway.auth.present', 'Vercel AI Gateway authentication is available.'));
      }
      if (selectedProvider === 'openrouter') {
        checks.push(check(
          'error',
          'env.aiGateway.provider.openrouter',
          'OpenRouter uses the direct transport; Gateway supports Gemini, Claude, and OpenAI studies.',
        ));
      }
      if (
        isPresent(env, 'AI_GATEWAY_ZERO_DATA_RETENTION')
        && env.AI_GATEWAY_ZERO_DATA_RETENTION !== 'true'
        && env.AI_GATEWAY_ZERO_DATA_RETENTION !== 'false'
      ) {
        checks.push(check(
          'error',
          'env.AI_GATEWAY_ZERO_DATA_RETENTION.invalid',
          'AI_GATEWAY_ZERO_DATA_RETENTION must be true or false.',
        ));
      }
      for (const provider of Object.values(AI_PROVIDERS)) {
        if (isPresent(env, provider.key)) {
          checks.push(check(
            'warn',
            `env.${provider.key}.gateway`,
            `${provider.key} is ignored by Gateway transport; keep it only if you also use direct transport elsewhere.`,
          ));
        }
      }
    } else if (aiTransport === 'direct') {
      const configuredProviders = Object.entries(AI_PROVIDERS)
        .filter(([, provider]) => isPresent(env, provider.key));
      if (configuredProviders.length === 0) {
        checks.push(check(
          'error',
          'env.aiProvider.missing',
          'Configure at least one of GEMINI_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY.',
        ));
      } else {
        checks.push(check('pass', 'env.aiProvider.present', 'At least one AI provider key is configured.'));
      }
      if (providerConfig && !isPresent(env, providerConfig.key)) {
        checks.push(check(
          'error',
          `env.AI_PROVIDER.${selectedProvider}`,
          `AI_PROVIDER selects ${providerConfig.label} but ${providerConfig.key} is missing.`,
        ));
      }
    }

    validateIndependentSecrets(checks, env, [
      'ADMIN_PASSWORD',
      'SESSION_SECRET',
      'PARTICIPANT_TOKEN_SECRET',
      'RATE_LIMIT_SALT',
    ]);
  }

  if (selectedMode === 'hosted') {
    if (isPresent(env, 'AI_TRANSPORT') && env.AI_TRANSPORT.trim() !== 'direct') {
      checks.push(check(
        'error',
        'env.AI_TRANSPORT.hosted',
        'Hosted researcher BYOS requires AI_TRANSPORT=direct.',
      ));
    }
    addRequiredEnv(checks, env, 'PLATFORM_KV_REST_API_URL');
    addRequiredEnv(checks, env, 'PLATFORM_KV_REST_API_TOKEN');
    addRequiredEnv(checks, env, 'PLATFORM_KEY_PREFIX');
    validateUrl(checks, env, 'PLATFORM_KV_REST_API_URL', { upstash: true, production });
    validateHostedKeyring(checks, env);

    const schemaLineage = isPresent(env, 'PLATFORM_SCHEMA_LINEAGE')
      ? env.PLATFORM_SCHEMA_LINEAGE.trim()
      : '';
    if (schemaLineage && schemaLineage !== 'v2-clean') {
      checks.push(check(
        'error',
        'env.PLATFORM_SCHEMA_LINEAGE.invalid',
        'PLATFORM_SCHEMA_LINEAGE must be unset or exactly v2-clean.',
      ));
    } else if (production && schemaLineage !== 'v2-clean') {
      checks.push(check(
        'error',
        'env.PLATFORM_SCHEMA_LINEAGE.hold',
        'Hosted production would HOLD schema lineage. Set PLATFORM_SCHEMA_LINEAGE=v2-clean only after attesting this prefix/database has no v1 study-operation rows.',
      ));
    } else if (production) {
      checks.push(check(
        'pass',
        'env.PLATFORM_SCHEMA_LINEAGE.v2-clean',
        'Platform schema lineage bootstrap is allowed.',
      ));
    }

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

    for (const name of [
      'ADMIN_PASSWORD',
      ...Object.values(AI_PROVIDERS).map((provider) => provider.key),
      'KV_REST_API_URL',
      'KV_REST_API_TOKEN',
    ]) {
      if (isPresent(env, name)) {
        const message = Object.values(AI_PROVIDERS).some((provider) => provider.key === name)
          ? `${name} is ignored in hosted mode; researchers configure provider keys in the application UI.`
          : `${name} is not part of the hosted researcher BYOS path.`;
        checks.push(check('warn', `env.${name}.hosted`, message));
      }
    }
  }

  return {
    mode: selectedMode,
    target: selectedTarget,
    production,
    ok: !checks.some((item) => item.status === 'error'),
    checks,
  };
}

function parseArgs(argv) {
  const args = {
    mode: undefined,
    target: undefined,
    production: false,
    json: false,
    envFile: undefined,
    wranglerConfig: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mode') {
      args.mode = argv[index + 1];
      index += 1;
    } else if (arg === '--target') {
      args.target = argv[index + 1];
      index += 1;
    } else if (arg === '--wrangler-config') {
      args.wranglerConfig = argv[index + 1];
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

function loadWranglerConfig(cwd, configPath) {
  const absolute = path.resolve(cwd, configPath);
  const source = path.relative(cwd, absolute) || path.basename(absolute);
  if (!fs.existsSync(absolute)) return { source, error: 'missing' };
  try {
    return { source, config: parseJsonc(fs.readFileSync(absolute, 'utf8')) };
  } catch {
    return { source, error: 'invalid' };
  }
}

function printHuman(report, sources) {
  const target = report.target === 'cloudflare' ? ' on Cloudflare' : '';
  console.log(`OpenInterviewer setup check: ${report.mode}${target}${report.production ? ' (production)' : ''}`);
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
  --target node|cloudflare       Deployment target (default: DEPLOYMENT_TARGET or node)
  --production                   Require production-only settings (always on for cloudflare)
  --env-file PATH                Read a specific env file (for example .dev.vars) instead
                                 of Next.js local files
  --wrangler-config PATH         Wrangler configuration to check (default for the
                                 cloudflare target: wrangler.jsonc); its vars are merged
                                 beneath the environment, as wrangler dev does
  --json                         Emit redacted machine-readable JSON
  --help                         Show this help

The checker reads names and validates shapes only. It never prints values,
writes secrets, makes network requests, or calls an AI provider. For the
cloudflare target, binding presence in configuration does not prove that the
deployed Queue consumer is running; installation verification tests that.`);
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
    let target = args.target || env.DEPLOYMENT_TARGET || undefined;
    let wrangler;
    if (args.wranglerConfig || target === 'cloudflare') {
      wrangler = loadWranglerConfig(process.cwd(), args.wranglerConfig || 'wrangler.jsonc');
      if (!wrangler.error) sources.push(wrangler.source);
      const wranglerTarget = stringVars(wrangler.config).DEPLOYMENT_TARGET;
      target = target || wranglerTarget || undefined;
    }
    const report = validateSetup({
      mode: args.mode,
      target,
      production: args.production || env.NODE_ENV === 'production',
      env,
      wrangler,
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
