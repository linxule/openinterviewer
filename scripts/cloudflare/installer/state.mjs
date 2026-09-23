// Installation state: the non-secret receipt, the installation wrangler
// config and a per-installation lock. Every file written here is checked
// against the in-memory secret registry first.

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { parseJsonc } from '../lib.mjs';
import {
  InstallerError,
  JURISDICTIONS,
  PHASES,
  PROVIDER_KEYS,
  RECEIPT_FORMAT_VERSION,
  REFUSED,
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
  if (receipt?.formatVersion !== RECEIPT_FORMAT_VERSION) {
    throw new InstallerError(`receipt ${file} has unsupported formatVersion ${receipt?.formatVersion}`, { exitCode: REFUSED });
  }
  return receipt;
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

export function writeReceipt(file, receipt, registry) {
  receipt.updatedAt = new Date().toISOString();
  const text = `${JSON.stringify(receipt, null, 2)}\n`;
  writeAtomic(file, registry.assertClean(text, 'the receipt'));
}

export function newReceipt({ install, environment, accountId, names, workspaceId, jurisdiction, provider, origin, bootstrap }) {
  const now = new Date().toISOString();
  return {
    formatVersion: RECEIPT_FORMAT_VERSION,
    install,
    env: environment,
    accountId,
    names,
    workspaceId,
    jurisdiction,
    provider,
    bootstrap,
    origin,
    originSource: origin ? 'explicit' : 'workers.dev',
    workersDevUrl: null,
    epochFingerprint: null,
    resources: {},
    secrets: { attemptedAt: null, epochGeneratedAt: null },
    operatorToken: null,
    phases: {},
    deployments: [],
    lastVerification: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * An update --change-provider records its change here before its first
 * remote write and clears it after its deploy. While it is set, only the
 * update that finishes it (`finishing`) may run; returns the pending record.
 */
export function assertNoPendingProviderChange(receipt, { finishing = false } = {}) {
  const pending = receipt.pendingProviderChange;
  if (!pending) return null;
  if (pending.from !== receipt.provider || pending.to === pending.from || !Object.hasOwn(PROVIDER_KEYS, pending.to ?? '')) {
    throw new InstallerError(`the receipt's pendingProviderChange ${JSON.stringify(pending)} is inconsistent with its provider ${receipt.provider}`, {
      exitCode: REFUSED,
      hints: ['Restore the receipt from your records before continuing.'],
    });
  }
  if (!finishing) {
    throw new InstallerError(`the provider change from ${pending.from} to ${pending.to} started at ${pending.startedAt} has not finished`, {
      exitCode: REFUSED,
      hints: [
        `Finish it first: update --provider ${pending.to} --change-provider --yes (it is safe to rerun; an already bound key is not requested again).`,
        `To go back to ${pending.from} afterwards, run update --provider ${pending.from} --change-provider --yes.`,
      ],
    });
  }
  return pending;
}

export function markPhase(receipt, phase) {
  if (!PHASES.includes(phase)) throw new Error(`unknown phase ${phase}`);
  receipt.phases[phase] ??= new Date().toISOString();
}

export function firstIncompletePhase(receipt) {
  return PHASES.find((phase) => !receipt?.phases?.[phase]) ?? null;
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
 * configDrift() so deploy.mjs accepts it.
 */
export function buildInstallationConfig(template, receipt, { bootstrap, provider = receipt.provider } = {}) {
  for (const name of REQUIRED_TEMPLATE_VARS) {
    if (!Object.hasOwn(template.vars ?? {}, name)) throw new InstallerError(`wrangler.jsonc vars lacks ${name}`);
  }
  const templateNames = templateQueueNames(template);
  const rename = (value) => {
    if (value === templateNames.queue) return receipt.names.queue;
    if (value === templateNames.deadLetterQueue) return receipt.names.deadLetterQueue;
    return value;
  };
  const config = structuredClone(template);
  delete config.$schema;
  config.name = receipt.names.worker;
  config.account_id = receipt.accountId;
  config.vars = {
    ...template.vars,
    DEPLOYMENT_TARGET: 'cloudflare',
    DEPLOYMENT_MODE: 'standalone',
    AI_TRANSPORT: 'direct',
    AI_PROVIDER: provider,
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
