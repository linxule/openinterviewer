// Installation state: the non-secret receipt, the installation wrangler
// config and a per-installation lock. Every file written here is checked
// against the in-memory secret registry first.

import { chmodSync, closeSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { parseJsonc } from '../lib.mjs';
import {
  AI_TRANSPORTS,
  GATEWAY_TOKEN_SECRET,
  GATEWAY_TRANSPORT,
  InstallerError,
  JURISDICTIONS,
  PHASES,
  PROVIDER_KEYS,
  RECEIPT_FORMAT_VERSION,
  REFUSED,
  SUPPORTED_RECEIPT_FORMATS,
  installationKey,
} from './model.mjs';
import { configDrift } from '../deploy.mjs';

export function installPaths(stateDir, install, environment) {
  const dir = path.join(stateDir, installationKey(install, environment));
  return {
    dir,
    receipt: path.join(dir, 'receipt.json'),
    config: path.join(dir, 'wrangler.jsonc'),
    lock: path.join(stateDir, `.${installationKey(install, environment)}.lock`),
  };
}

export function readReceipt(file) {
  if (!existsSync(file)) return null;
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new InstallerError(`receipt ${file} is not valid JSON; restore it from your records before continuing`, { exitCode: REFUSED });
  }
  if (!SUPPORTED_RECEIPT_FORMATS.includes(receipt?.formatVersion)) {
    throw new InstallerError(`receipt ${file} has unsupported formatVersion ${receipt?.formatVersion}`, { exitCode: REFUSED });
  }
  const migrated = migrateReceipt(receipt);
  const problem = receiptProblem(migrated);
  if (problem) {
    throw new InstallerError(`receipt ${file} is inconsistent: ${problem}`, {
      exitCode: REFUSED,
      hints: ['Restore the receipt from your records before continuing.'],
    });
  }
  return migrated;
}

/**
 * Format 1 → 2, in memory; the next save writes format 2 and keeps the
 * original as receipt.format1.json (writeReceipt). A format-1
 * installation bound its default provider's key plus the key of every
 * provider it switched from (`update --change-provider` never deleted one),
 * so those are its provider keys. An unfinished v1 provider change becomes a
 * `pendingChange` of kind `provider`; its target key is added when it
 * finishes, as before. Nothing else changes.
 */
export function migrateReceipt(receipt) {
  if (receipt.formatVersion === RECEIPT_FORMAT_VERSION) return receipt;
  const history = Array.isArray(receipt.providerHistory) ? receipt.providerHistory : [];
  const bound = new Set([receipt.provider, ...history.flatMap((entry) => [entry?.from, entry?.to])]);
  const providerKeys = Object.keys(PROVIDER_KEYS).filter((provider) => bound.has(provider));
  const migrated = {};
  for (const [key, value] of Object.entries(receipt)) {
    if (key === 'pendingProviderChange') continue;
    migrated[key] = key === 'formatVersion' ? RECEIPT_FORMAT_VERSION : value;
    if (key === 'provider') {
      migrated.providerKeys = providerKeys;
      migrated.aiTransport = 'direct';
    }
  }
  migrated.secretEvents ??= [];
  if (receipt.pendingProviderChange) migrated.pendingChange = { kind: 'provider', ...receipt.pendingProviderChange };
  return migrated;
}

/** The first structural problem of a format-2 receipt, or null. */
export function receiptProblem(receipt) {
  if (!Object.hasOwn(PROVIDER_KEYS, receipt.provider ?? '')) return `provider ${JSON.stringify(receipt.provider)} is not supported`;
  const keys = receipt.providerKeys;
  if (!Array.isArray(keys) || keys.length === 0) return 'providerKeys is missing';
  if (keys.some((key) => !Object.hasOwn(PROVIDER_KEYS, key)) || new Set(keys).size !== keys.length) return `providerKeys ${JSON.stringify(keys)} is not a list of distinct providers`;
  if (!keys.includes(receipt.provider)) return `providerKeys ${JSON.stringify(keys)} lacks the default provider ${receipt.provider}`;
  if (!AI_TRANSPORTS.includes(receipt.aiTransport)) return `aiTransport ${JSON.stringify(receipt.aiTransport)} is not supported by this installer`;
  if (!Array.isArray(receipt.secretEvents)) return 'secretEvents is not a list';
  const gateway = receipt.aiGateway;
  if (gateway !== undefined && gateway !== null) {
    if (typeof gateway !== 'object' || Array.isArray(gateway)) return 'aiGateway is not an object';
    if (gateway.id !== receipt.names?.worker) return `aiGateway.id ${JSON.stringify(gateway.id)} is not the Worker name ${receipt.names?.worker}`;
    if (gateway.accountId !== receipt.accountId) return `aiGateway.accountId ${JSON.stringify(gateway.accountId)} is not the installation account`;
    if (!Array.isArray(gateway.attempts)) return 'aiGateway.attempts is not a list';
  }
  if (receipt.aiTransport === GATEWAY_TRANSPORT) {
    if (!gateway) return 'aiTransport cloudflare-gateway without an aiGateway record';
    if (receipt.phases?.['ai-gateway'] && !gateway.observedAt) return 'the ai-gateway phase is recorded but the gateway was never observed';
  }
  return null;
}

/**
 * Whether `phase` is complete. A direct installation has nothing to do in
 * the `ai-gateway` phase, so it counts as done once `resources` is: receipts
 * written before the phase existed need no rewrite, and a direct apply never
 * records it.
 */
export function phaseDone(receipt, phase) {
  if (receipt?.phases?.[phase]) return true;
  return phase === 'ai-gateway' && receipt?.aiTransport !== GATEWAY_TRANSPORT && Boolean(receipt?.phases?.resources);
}

/**
 * Whether the receipt vouches for the bound CF_AI_GATEWAY_TOKEN: this
 * installer probed a Run token it was given (apply, a transport switch or a
 * rotation) or recorded uploading one. A token bound any other way is never
 * used by the installer: a switch to the gateway would make the Worker send it.
 */
export function gatewayTokenRecorded(receipt) {
  return Boolean(receipt.aiGateway?.probedAt)
    || (receipt.secretEvents ?? []).some((event) => Array.isArray(event?.names) && event.names.includes(GATEWAY_TOKEN_SECRET));
}

/** A fresh `aiGateway` record: the installation's gateway id and account, nothing observed yet. */
export function newGatewayRecord(receipt) {
  return {
    id: receipt.names.worker,
    accountId: receipt.accountId,
    attempts: [],
    createdAt: null,
    observedAt: null,
    settingsDigest: null,
    settingsCheckedAt: null,
    probedAt: null,
  };
}

/** Tracks secret values held in memory so no file or report can contain one. */
export class SecretRegistry {
  #values = new Set();

  add(value) {
    if (typeof value === 'string' && value.length > 0) this.#values.add(value);
    return value;
  }

  assertClean(text, what) {
    for (const value of this.#values) {
      if (text.includes(value)) throw new InstallerError(`internal error: refusing to write a secret value into ${what}`);
    }
    return text;
  }
}

function writeAtomic(file, text, mode = 0o644) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode });
  renameSync(temp, file);
}

/** Where the first save of a migrated receipt keeps the original format-1 bytes. */
export function format1CopyPath(file) {
  return path.join(path.dirname(file), 'receipt.format1.json');
}

/**
 * Before a format-1 receipt is overwritten by a migration, keep its exact
 * bytes next to it (same mode) so a release from before format 2, whose
 * installer refuses a format-2 receipt, can still be rolled back to (RUNBOOK,
 * release classification). The copy always holds the format-1 receipt that
 * was migrated last: after a rollback the older installer records its own
 * deployments in the restored file, and the next migration must keep those.
 * An earlier, different copy is never overwritten; it is moved aside as
 * receipt.format1.<n>.json.
 */
function preserveFormat1(file) {
  if (!existsSync(file)) return;
  const bytes = readFileSync(file);
  let version;
  try {
    version = JSON.parse(bytes.toString('utf8'))?.formatVersion;
  } catch {
    return;
  }
  if (version !== 1) return;
  const copy = format1CopyPath(file);
  if (existsSync(copy)) {
    if (readFileSync(copy).equals(bytes)) return;
    let n = 1;
    while (existsSync(path.join(path.dirname(file), `receipt.format1.${n}.json`))) n += 1;
    // link() + unlink keeps the earlier copy and never overwrites an existing name.
    linkSync(copy, path.join(path.dirname(file), `receipt.format1.${n}.json`));
    rmSync(copy);
  }
  const temp = `${copy}.${process.pid}.tmp`;
  writeFileSync(temp, bytes);
  try {
    chmodSync(temp, statSync(file).mode & 0o777);
    // link() fails if the copy appeared meanwhile, so it is never overwritten.
    linkSync(temp, copy);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  } finally {
    rmSync(temp, { force: true });
  }
}

export function writeReceipt(file, receipt, registry) {
  receipt.updatedAt = new Date().toISOString();
  const text = registry.assertClean(`${JSON.stringify(receipt, null, 2)}\n`, 'the receipt');
  preserveFormat1(file);
  writeAtomic(file, text);
}

export function newReceipt({ install, environment, accountId, names, workspaceId, jurisdiction, provider, providerKeys, aiTransport = 'direct', origin, bootstrap }) {
  const now = new Date().toISOString();
  const receipt = {
    formatVersion: RECEIPT_FORMAT_VERSION,
    install,
    env: environment,
    accountId,
    names,
    workspaceId,
    jurisdiction,
    provider,
    providerKeys,
    aiTransport,
    bootstrap,
    origin,
    originSource: origin ? 'explicit' : 'workers.dev',
    workersDevUrl: null,
    epochFingerprint: null,
    resources: {},
    secrets: { attemptedAt: null, epochGeneratedAt: null },
    operatorToken: null,
    secretEvents: [],
    phases: {},
    deployments: [],
    lastVerification: null,
    createdAt: now,
    updatedAt: now,
  };
  // Direct receipts keep their pre-gateway shape; a gateway record appears
  // only when an installation first uses the gateway.
  if (aiTransport === GATEWAY_TRANSPORT) receipt.aiGateway = newGatewayRecord(receipt);
  return receipt;
}

function pendingProblem(receipt, pending) {
  switch (pending?.kind) {
    case 'provider':
      return pending.from !== receipt.provider || pending.to === pending.from || !Object.hasOwn(PROVIDER_KEYS, pending.to ?? '');
    case 'add-provider-key':
      return !Array.isArray(pending.providers) || pending.providers.length === 0
        || pending.providers.some((provider) => !Object.hasOwn(PROVIDER_KEYS, provider) || receipt.providerKeys.includes(provider));
    case 'rotate-provider-key':
      return !receipt.providerKeys.includes(pending.provider);
    case 'ai-transport':
      return pending.from !== receipt.aiTransport || pending.to === pending.from || !AI_TRANSPORTS.includes(pending.to ?? '');
    case 'rotate-ai-gateway-token':
      return !receipt.aiGateway?.observedAt;
    case 'rotate-admin-password':
      return false;
    default:
      return true;
  }
}

function pendingRefusal(pending) {
  switch (pending.kind) {
    case 'provider':
      return new InstallerError(`the provider change from ${pending.from} to ${pending.to} started at ${pending.startedAt} has not finished`, {
        exitCode: REFUSED,
        hints: [
          `Finish it first: update --provider ${pending.to} --change-provider --yes (it is safe to rerun; an already bound key is not requested again).`,
          `To go back to ${pending.from} afterwards, run update --provider ${pending.from} --change-provider --yes.`,
        ],
      });
    case 'add-provider-key':
      return new InstallerError(`adding the ${pending.providers.join(', ')} provider key(s), started at ${pending.startedAt}, has not finished`, {
        exitCode: REFUSED,
        hints: [`Finish it first: update --add-provider-key ${pending.providers.join(',')} --yes (it is safe to rerun; a key whose upload landed is not requested again).`],
      });
    case 'ai-transport':
      return new InstallerError(`the AI transport change from ${pending.from} to ${pending.to} started at ${pending.startedAt} has not finished`, {
        exitCode: REFUSED,
        hints: [
          `Finish it first: update --change-ai-transport --ai-transport ${pending.to} --yes (it is safe to rerun: an observed gateway is adopted, a bound Run token is not requested again).`,
          `Or abandon it: update --change-ai-transport --ai-transport ${pending.from} --yes deploys ${pending.from} again.`,
        ],
      });
    case 'rotate-ai-gateway-token':
      return new InstallerError(`rotating the AI Gateway Run token, started at ${pending.startedAt}, has not finished`, {
        exitCode: REFUSED,
        hints: [
          'Finish it first: update --rotate-ai-gateway-token --yes with the new token.',
          'The bound value may already be the new token or still the old one; supplying the new token again settles it.',
        ],
      });
    case 'rotate-admin-password':
      return new InstallerError(`rotating the administrator password (ADMIN_PASSWORD), started at ${pending.startedAt}, has not finished`, {
        exitCode: REFUSED,
        hints: [
          'Finish it first: update --rotate-admin-password --yes with the new password.',
          'The bound value may already be the new password or still the old one; supplying the new password again settles it.',
        ],
      });
    default:
      return new InstallerError(`rotating the ${pending.provider} key, started at ${pending.startedAt}, has not finished`, {
        exitCode: REFUSED,
        hints: [
          `Finish it first: update --rotate-provider-key ${pending.provider} --yes with the new key.`,
          'The bound value may already be the new key or still the old one; supplying the new key again settles it.',
        ],
      });
  }
}

/**
 * A change that writes remote state outside apply (update --change-provider,
 * --add-provider-key, --rotate-provider-key, --change-ai-transport,
 * --rotate-ai-gateway-token, --rotate-admin-password) is recorded here before its
 * first remote write and cleared once it is observed. While it is set, only
 * the update that finishes it (`finishes(pending)` true) may run; returns
 * the pending record.
 */
export function assertNoPendingChange(receipt, { finishes = () => false } = {}) {
  const pending = receipt.pendingChange;
  if (!pending) return null;
  if (pendingProblem(receipt, pending)) {
    throw new InstallerError(`the receipt's pendingChange ${JSON.stringify(pending)} is inconsistent with its provider ${receipt.provider}, provider keys ${receipt.providerKeys.join(', ')} and AI transport ${receipt.aiTransport}`, {
      exitCode: REFUSED,
      hints: ['Restore the receipt from your records before continuing.'],
    });
  }
  if (!finishes(pending)) throw pendingRefusal(pending);
  return pending;
}

export function markPhase(receipt, phase) {
  if (!PHASES.includes(phase)) throw new Error(`unknown phase ${phase}`);
  receipt.phases[phase] ??= new Date().toISOString();
}

export function firstIncompletePhase(receipt) {
  return PHASES.find((phase) => !phaseDone(receipt, phase)) ?? null;
}

/** All receipts in the state directory (for cross-installation origin checks). */
export function listReceipts(stateDir) {
  if (!existsSync(stateDir)) return [];
  const receipts = [];
  for (const name of readdirSync(stateDir)) {
    const file = path.join(stateDir, name, 'receipt.json');
    if (!existsSync(file)) continue;
    try {
      receipts.push(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      // An unreadable sibling receipt is reported by its own commands.
    }
  }
  return receipts;
}

/** Exclusive per-installation lock; released on exit. */
export function acquireLock(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  let fd;
  try {
    fd = openSync(file, 'wx', 0o644);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let holder = '';
    try {
      holder = readFileSync(file, 'utf8').trim();
    } catch {
      // Lock vanished between checks; report it as held anyway.
    }
    throw new InstallerError(`another setup run holds ${file}${holder ? ` (${holder})` : ''}`, {
      exitCode: REFUSED,
      hints: ['If no other setup:cloudflare process is running, delete the lock file and retry.'],
    });
  }
  writeSync(fd, `pid ${process.pid} since ${new Date().toISOString()}\n`);
  closeSync(fd);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    rmSync(file, { force: true });
  };
  process.once('exit', release);
  return release;
}

// ---------- Installation config ----------

// The exact drift rule deploy.mjs enforces before any upload.
export { configDrift };

const REQUIRED_TEMPLATE_VARS = [
  'DEPLOYMENT_TARGET',
  'DEPLOYMENT_MODE',
  'AI_TRANSPORT',
  'AI_PROVIDER',
  'CF_AI_GATEWAY_ACCOUNT_ID',
  'CF_AI_GATEWAY_ID',
  'APP_BASE_URL',
  'WORKSPACE_ID',
  'WORKSPACE_JURISDICTION',
  'WORKSPACE_BOOTSTRAP',
];

function templateQueueNames(template) {
  const producers = template.queues?.producers ?? [];
  const consumers = template.queues?.consumers ?? [];
  const producer = producers.filter((entry) => entry.binding === 'ANALYSIS_QUEUE');
  if (producers.length !== 1 || producer.length !== 1) {
    throw new InstallerError('wrangler.jsonc must declare exactly one queue producer, bound as ANALYSIS_QUEUE');
  }
  const queue = producer[0].queue;
  const consumer = consumers.filter((entry) => entry.queue === queue);
  if (consumers.length !== 1 || consumer.length !== 1 || !consumer[0].dead_letter_queue) {
    throw new InstallerError('wrangler.jsonc must declare exactly one consumer for the analysis queue, with a dead_letter_queue');
  }
  return { queue, deadLetterQueue: consumer[0].dead_letter_queue };
}

/**
 * The installation config: the current template with installation-owned
 * fields only (name, account_id, vars values, queue names). Must pass
 * configDrift() so deploy.mjs accepts it. On the Cloudflare AI Gateway
 * transport the two gateway identifiers name the installation's account and
 * its own gateway (the Worker name); on direct they stay empty (RT-11).
 */
export function buildInstallationConfig(template, receipt, { bootstrap, provider = receipt.provider, aiTransport = receipt.aiTransport } = {}) {
  for (const name of REQUIRED_TEMPLATE_VARS) {
    if (!Object.hasOwn(template.vars ?? {}, name)) throw new InstallerError(`wrangler.jsonc vars lacks ${name}`);
  }
  const templateNames = templateQueueNames(template);
  const rename = (value) => {
    if (value === templateNames.queue) return receipt.names.queue;
    if (value === templateNames.deadLetterQueue) return receipt.names.deadLetterQueue;
    return value;
  };
  const gateway = aiTransport === GATEWAY_TRANSPORT;
  if (gateway && receipt.aiGateway?.id !== receipt.names.worker) {
    throw new InstallerError('internal error: the Cloudflare AI Gateway transport needs the installation\'s gateway record');
  }
  const config = structuredClone(template);
  delete config.$schema;
  config.name = receipt.names.worker;
  config.account_id = receipt.accountId;
  config.vars = {
    ...template.vars,
    DEPLOYMENT_TARGET: 'cloudflare',
    DEPLOYMENT_MODE: 'standalone',
    AI_TRANSPORT: aiTransport,
    AI_PROVIDER: provider,
    CF_AI_GATEWAY_ACCOUNT_ID: gateway ? receipt.accountId : '',
    CF_AI_GATEWAY_ID: gateway ? receipt.aiGateway.id : '',
    APP_BASE_URL: receipt.origin ?? '',
    WORKSPACE_ID: receipt.workspaceId,
    WORKSPACE_JURISDICTION: JURISDICTIONS[receipt.jurisdiction],
    WORKSPACE_BOOTSTRAP: bootstrap,
  };
  config.queues = {
    ...config.queues,
    producers: config.queues.producers.map((entry) => ({ ...entry, queue: rename(entry.queue) })),
    consumers: config.queues.consumers.map((entry) => ({
      ...entry,
      queue: rename(entry.queue),
      dead_letter_queue: rename(entry.dead_letter_queue),
    })),
  };
  const drift = configDrift(template, config);
  if (drift.length > 0) throw new InstallerError(`internal error: generated config drifts from the template in ${drift.join(', ')}`);
  return config;
}

/** Installation-owned values that must never change silently between deploys. */
export function installationIdentity(config) {
  return {
    name: config.name,
    account_id: config.account_id,
    vars: { ...config.vars },
    producers: (config.queues?.producers ?? []).map((entry) => entry.queue),
    consumers: (config.queues?.consumers ?? []).map((entry) => [entry.queue, entry.dead_letter_queue]),
  };
}

export function identityDiff(expected, actual, { ignoreVars = [] } = {}) {
  const diffs = [];
  const compare = (label, a, b) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`${label}: expected ${JSON.stringify(a)}, found ${JSON.stringify(b)}`);
  };
  compare('name', expected.name, actual.name);
  compare('account_id', expected.account_id, actual.account_id);
  const vars = new Set([...Object.keys(expected.vars), ...Object.keys(actual.vars)]);
  for (const name of [...vars].sort()) {
    if (ignoreVars.includes(name)) continue;
    compare(`vars.${name}`, expected.vars[name], actual.vars[name]);
  }
  compare('queue producers', expected.producers, actual.producers);
  compare('queue consumers', expected.consumers, actual.consumers);
  return diffs;
}

export function writeInstallationConfig(file, config, receipt, registry) {
  const header = [
    `// Generated by setup:cloudflare for installation ${receipt.install} (${receipt.env}).`,
    '// Installation-owned fields only; everything else comes from wrangler.jsonc.',
    '// Do not edit: `npm run setup:cloudflare -- update` regenerates it from the',
    '// current template and receipt.json. Contains no secrets.',
  ].join('\n');
  writeAtomic(file, registry.assertClean(`${header}\n${JSON.stringify(config, null, 2)}\n`, 'the installation config'));
}

export function readInstallationConfig(file) {
  if (!existsSync(file)) return null;
  return parseJsonc(readFileSync(file, 'utf8'));
}
