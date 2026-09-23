#!/usr/bin/env node
// Fake wrangler for installer tests. Supports only the commands setup.mjs
// uses, with flags and output shaped like wrangler 4.136.3 (checked against
// its --help and wrangler-dist/cli.js): whoami --json, queues list/create,
// deployments list --json, secret list/bulk. Like the real CLI it rejects
// flags a command does not define, fails when --config names a missing file,
// and prefers a config's account_id over CLOUDFLARE_ACCOUNT_ID. Every
// invocation's argv, environment variable names and value digests are
// recorded; secret values are read from stdin and stored only as sha256
// digests.
//
// setup.mjs gives child processes a minimal environment, so tests reach this
// script through a generated wrapper that sets FAKE_WRANGLER_STATE (and
// optionally FAKE_WRANGLER_CAPTURE) before importing it.

import { appendFileSync, readFileSync } from 'node:fs';
import { digest, invocation, readState, takeFailure, writeState } from './fake-state.mjs';
import { parseJsonc } from '../../../scripts/cloudflare/lib.mjs';

const argv = process.argv.slice(2);
const state = readState();
state.invocations.push(invocation('wrangler', argv));

function finish(code, { stdout = '', stderr = '' } = {}) {
  writeState(state);
  if (stdout) process.stdout.write(stdout.endsWith('\n') ? stdout : `${stdout}\n`);
  if (stderr) process.stderr.write(stderr.endsWith('\n') ? stderr : `${stderr}\n`);
  process.exit(code);
}

// Global flags every wrangler command accepts, then each command's own
// (wrangler 4.136.3 --help). Booleans take no value.
const GLOBAL_FLAGS = { '--config': 'string', '-c': 'string', '--cwd': 'string', '--env': 'string', '-e': 'string', '--env-file': 'string', '--profile': 'string' };
const COMMAND_FLAGS = {
  whoami: { '--json': 'boolean', '--account': 'string' },
  'queues list': { '--page': 'string' },
  'queues create': { '--jurisdiction': 'string', '--delivery-delay-secs': 'string', '--message-retention-period-secs': 'string' },
  'deployments list': { '--name': 'string', '--json': 'boolean' },
  'secret list': { '--name': 'string', '--format': 'string' },
  'secret bulk': { '--name': 'string' },
};

const positionals = [];
const flags = {};
{
  let command = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('-')) {
      positionals.push(arg);
      continue;
    }
    command ??= positionals[0] === 'whoami' ? 'whoami' : `${positionals[0]} ${positionals[1]}`;
    const [name, inline] = arg.split('=', 2);
    const type = COMMAND_FLAGS[command]?.[name] ?? GLOBAL_FLAGS[name];
    if (!type) finish(1, { stderr: `\n✘ [ERROR] Unknown argument: ${name.replace(/^-+/, '')}\n` });
    if (type === 'boolean') flags[name] = true;
    else {
      const value = inline ?? argv[index + 1];
      if (inline === undefined) index += 1;
      if (value === undefined || value.startsWith('--')) finish(1, { stderr: `\n✘ [ERROR] Not enough arguments following: ${name.replace(/^-+/, '')}\n` });
      flags[name] = value;
    }
  }
}
const flag = (name) => flags[name];

function readConfig() {
  const configPath = flag('--config') ?? flag('-c');
  if (!configPath) return {};
  try {
    return parseJsonc(readFileSync(configPath, 'utf8'));
  } catch (error) {
    return finish(1, { stderr: `\n✘ [ERROR] Could not read file: ${configPath}\n\n  ${error.code ?? 'EINVAL'}: ${error.message}\n` });
  }
}

function apiError(path, message, code) {
  return `\n✘ [ERROR] A request to the Cloudflare API (${path}) failed.\n\n  ${message} [code: ${code}]\n`;
}

// wrangler getActiveAccountId(): config account_id, then CLOUDFLARE_ACCOUNT_ID,
// then the only account.
function accountId() {
  const config = readConfig();
  const chosen = config.account_id ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  if (chosen) {
    if (!state.accounts.some((account) => account.id === chosen)) finish(1, { stderr: apiError('/accounts', 'Authentication error', 10000) });
    return chosen;
  }
  if (state.accounts.length !== 1) {
    finish(1, { stderr: '✘ [ERROR] More than one account available but unable to select one in non-interactive mode.' });
  }
  return state.accounts[0].id;
}

function table(rows, columns) {
  const widths = columns.map((column) => Math.max(column.length, ...rows.map((row) => String(row[column]).length)));
  const line = (left, middle, right) => `${left}${widths.map((width) => '─'.repeat(width + 2)).join(middle)}${right}`;
  const cells = (values) => `│${values.map((value, index) => ` ${String(value).padEnd(widths[index])} `).join('│')}│`;
  if (rows.length === 0) return '┌┐\n└┘';
  return [
    line('┌', '┬', '┐'),
    cells(columns),
    line('├', '┼', '┤'),
    ...rows.map((row) => cells(columns.map((column) => row[column]))),
    line('└', '┴', '┘'),
  ].join('\n');
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function failure(command, target) {
  const when = takeFailure(state, command, target);
  if (when === 'before') finish(1, { stderr: apiError('/injected', `injected failure before ${command}`, 99999) });
  return when;
}

const [first, second] = positionals;
const command = first === 'whoami' ? 'whoami' : `${first} ${second}`;

switch (command) {
  case 'whoami': {
    failure('whoami');
    if (!state.loggedIn) finish(1, { stdout: JSON.stringify({ loggedIn: false }) });
    finish(0, {
      stdout: JSON.stringify({ loggedIn: true, authType: 'OAuth Token', email: 'operator@example.invalid', accounts: state.accounts, tokenPermissions: [] }, null, 2),
    });
    break;
  }
  case 'queues list': {
    accountId();
    failure('queues list');
    const page = Number(flag('--page') ?? 1);
    const names = Object.keys(state.queues).sort();
    const slice = names.slice((page - 1) * state.queuePageSize, page * state.queuePageSize);
    const rows = slice.map((name) => ({
      id: state.queues[name].id,
      name,
      created_on: state.queues[name].createdAt,
      modified_on: state.queues[name].createdAt,
      producers: '0',
      consumers: '0',
    }));
    finish(0, { stdout: table(rows, ['id', 'name', 'created_on', 'modified_on', 'producers', 'consumers']) });
    break;
  }
  case 'queues create': {
    const account = accountId();
    const name = positionals[2];
    const when = failure('queues create', name);
    if (when === 'race') state.queues[name] ??= { id: 'foreign-race-queue', createdAt: new Date().toISOString(), foreign: true };
    if (state.queues[name]) finish(1, { stderr: apiError(`/accounts/${account}/queues`, 'Queue name already taken', 11009) });
    state.queues[name] = { id: digest(name).slice(0, 32), createdAt: new Date().toISOString() };
    state.queueCreates.push(name);
    if (when === 'after') finish(1, { stderr: apiError(`/accounts/${account}/queues`, 'injected failure after queues create', 99999) });
    finish(0, { stdout: `🌀 Creating queue '${name}'\n✅ Created queue '${name}'` });
    break;
  }
  case 'deployments list': {
    const account = accountId();
    const name = flag('--name');
    failure('deployments list', name);
    const worker = state.workers[name];
    if (!worker) {
      finish(1, { stderr: apiError(`/accounts/${account}/workers/scripts/${name}/deployments`, 'This Worker does not exist on your account.', 10007) });
    }
    // Raw API deployments, oldest first (versionsDeploymentsListHandler --json).
    const deployments = worker.deployments.map((entry, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      source: 'wrangler',
      strategy: 'percentage',
      author_email: 'operator@example.invalid',
      annotations: { 'workers/triggered_by': 'upload', ...(entry.message ? { 'workers/message': entry.message } : {}) },
      versions: [{ version_id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`, percentage: 100 }],
      created_on: entry.at,
    }));
    finish(0, { stdout: JSON.stringify(deployments, null, 2) });
    break;
  }
  case 'secret list': {
    accountId();
    const name = flag('--name');
    failure('secret list', name);
    const worker = state.workers[name];
    if (!worker) finish(1, { stderr: `✘ [ERROR] Worker "${name}" not found.\n\nIf this is a new Worker, run \`wrangler deploy\` first to create it.` });
    finish(0, { stdout: JSON.stringify(Object.keys(worker.secrets).sort().map((secret) => ({ name: secret, type: 'secret_text' })), null, '  ') });
    break;
  }
  case 'secret bulk': {
    accountId();
    const name = flag('--name');
    const input = readStdin();
    const when = failure('secret bulk', name);
    let content;
    try {
      content = JSON.parse(input);
    } catch {
      finish(0, { stderr: '🚨 No content found in file, or piped input.' });
    }
    state.workers[name] ??= { draft: true, secrets: {}, deployments: [], vars: {} };
    const worker = state.workers[name];
    for (const [key, value] of Object.entries(content)) worker.secrets[key] = digest(value);
    state.secretBulkCalls.push({ worker: name, names: Object.keys(content).sort(), at: new Date().toISOString() });
    if (process.env.FAKE_WRANGLER_CAPTURE) appendFileSync(process.env.FAKE_WRANGLER_CAPTURE, `${JSON.stringify(content)}\n`);
    if (when === 'after') finish(1, { stderr: '🚨 Secrets failed to upload (injected lost reply)' });
    finish(0, { stdout: [`🌀 Processing the secrets for the Worker "${name}"`, ...Object.keys(content).map((key) => `✨ Successfully created secret for key: ${key}`)].join('\n') });
    break;
  }
  default:
    finish(1, { stderr: `fake wrangler: unsupported command ${JSON.stringify(argv)}` });
}
