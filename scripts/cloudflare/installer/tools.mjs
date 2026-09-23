// External executables the installer drives: wrangler, git and the deploy
// script. Secrets only ever travel on stdin; argv and logs carry names.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { minimalEnv } from '../lib.mjs';
import { InstallerError } from './model.mjs';
import { DEPLOY_CALL_MS, WRANGLER_CALL_MS } from './ownership.mjs';

// One environment allowlist for every wrangler the installer starts, its own
// calls and the one inside scripts/cloudflare/deploy.mjs: deploy.mjs gives
// wrangler minimalEnv() plus CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
// only, so the installer does the same. Otherwise preflight, queue creation
// and secret upload could succeed under settings the deploy never sees.
export const FORWARDED_ENV = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'];

// Settings wrangler would honour but deploy.mjs does not forward. They are
// dropped for every call (and reported); a non-public compliance region is
// refused because dropping it silently targets the public API.
export const UNFORWARDED_ENV = [
  'CLOUDFLARE_COMPLIANCE_REGION',
  'XDG_CONFIG_HOME',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
];

export function unforwardedEnvironment(env = process.env) {
  return UNFORWARDED_ENV.filter((name) => env[name] !== undefined && env[name] !== '');
}

/** Environment for every wrangler/deploy child: minimalEnv + FORWARDED_ENV, account pinned when known. */
export function toolEnv({ accountId } = {}) {
  const env = minimalEnv();
  for (const name of FORWARDED_ENV) if (process.env[name] !== undefined) env[name] = process.env[name];
  if (accountId) env.CLOUDFLARE_ACCOUNT_ID = accountId;
  return env;
}

const stripAnsi = (text) => text.replace(/\u001b\[[0-9;]*m/g, '');

/**
 * Run an executable (a `.mjs`/`.js` path runs under this Node binary).
 * Never rejects on a non-zero exit; returns { code, stdout, stderr }.
 */
export function execTool(executable, args, { cwd, env, input, timeoutMs = WRANGLER_CALL_MS, tee = null } = {}) {
  const script = /\.(?:mjs|cjs|js)$/.test(executable);
  const command = script ? process.execPath : executable;
  const argv = script ? [executable, ...args] : args;
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      tee?.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      tee?.write(chunk);
    });
    child.on('error', (error) => {
      reject(new InstallerError(`could not run ${path.basename(executable)}: ${error.code ?? error.message}`));
    });
    child.on('close', (code, signal) => {
      resolve({ code: code ?? (signal ? 128 : 1), stdout: stripAnsi(stdout), stderr: stripAnsi(stderr) });
    });
    child.stdin.on('error', () => {
      // The child may exit before reading stdin; the exit code reports it.
    });
    child.stdin.end(input ?? '');
  });
}

function tail(text, lines = 12) {
  return text.trim().split('\n').slice(-lines).map((line) => `    ${line}`).join('\n');
}

function commandFailure(label, result, hints = []) {
  const output = tail(`${result.stdout}\n${result.stderr}`);
  return new InstallerError(`${label} failed (exit ${result.code})${output ? `:\n${output}` : ''}`, { hints });
}

/** The JSON document wrangler printed, skipping any warning lines before it. */
function firstJson(text, open) {
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trimStart().startsWith(open)) continue;
    try {
      return JSON.parse(lines.slice(index).join('\n'));
    } catch {
      // Not the document; keep looking.
    }
  }
  return undefined;
}

/** Parse a wrangler (cli-table3) table into row objects keyed by header. */
export function parseWranglerTable(text) {
  const rows = [];
  let header = null;
  for (const rawLine of stripAnsi(text).split('\n')) {
    const line = rawLine.trim();
    const separator = line.startsWith('│') ? '│' : line.startsWith('|') ? '|' : null;
    if (!separator) continue;
    const cells = line.split(separator).slice(1, -1).map((cell) => cell.trim());
    if (!header) {
      header = cells;
      continue;
    }
    rows.push(Object.fromEntries(header.map((name, index) => [name, cells[index] ?? ''])));
  }
  return rows;
}

const WORKER_NOT_FOUND = /\[code: 10007\]|\[code: 10090\]|This Worker does not exist|Worker ".+" not found|script_not_found/i;
const NAME_TAKEN = /\[code: 11009\]|already taken|already exists/i;

export class Wrangler {
  constructor({ executable, cwd }) {
    if (!existsSync(executable)) {
      throw new InstallerError(`wrangler not found at ${executable}`, { hints: ['Run npm ci, or pass --wrangler <path>.'] });
    }
    this.executable = executable;
    this.cwd = cwd;
    this.accountId = null;
  }

  useAccount(accountId) {
    this.accountId = accountId;
  }

  run(args, { input } = {}) {
    return execTool(this.executable, args, { cwd: this.cwd, env: toolEnv({ accountId: this.accountId }), input });
  }

  async whoami() {
    const result = await this.run(['whoami', '--json']);
    const body = firstJson(result.stdout, '{');
    if (result.code !== 0 || !body?.loggedIn) {
      throw new InstallerError('wrangler is not authenticated', {
        hints: ['Run node_modules/.bin/wrangler login, or export CLOUDFLARE_API_TOKEN for an API token with Workers permissions.'],
      });
    }
    const accounts = Array.isArray(body.accounts)
      ? body.accounts.filter((account) => typeof account?.id === 'string').map(({ id, name }) => ({ id, name: String(name ?? '') }))
      : [];
    return { authType: String(body.authType ?? ''), accounts };
  }

  /** Every queue in the account (all pages) as name → { id, created_on, ... }. */
  async listQueues() {
    const rows = new Map();
    for (let page = 1; page <= 100; page += 1) {
      const result = await this.run(['queues', 'list', '--page', String(page)]);
      if (result.code !== 0) throw commandFailure('wrangler queues list', result);
      const pageRows = parseWranglerTable(result.stdout);
      const before = rows.size;
      for (const row of pageRows) if (row.name) rows.set(row.name, row);
      if (pageRows.length === 0 || rows.size === before) return rows;
    }
    throw new InstallerError('wrangler queues list did not terminate after 100 pages');
  }

  /** Never throws on a failed create: the caller re-lists and decides. */
  async createQueue(name) {
    const result = await this.run(['queues', 'create', name]);
    const output = `${result.stdout}\n${result.stderr}`;
    return {
      ok: result.code === 0,
      nameTaken: result.code !== 0 && NAME_TAKEN.test(output),
      error: result.code === 0 ? null : commandFailure(`wrangler queues create ${name}`, result, ['Run resume to continue.']),
    };
  }

  /** The Worker's deployments (oldest first), or null when the Worker does not exist. */
  async deployments(worker) {
    const result = await this.run(['deployments', 'list', '--name', worker, '--json']);
    if (result.code !== 0) {
      if (WORKER_NOT_FOUND.test(`${result.stdout}\n${result.stderr}`)) return null;
      throw commandFailure(`wrangler deployments list --name ${worker}`, result);
    }
    const body = firstJson(result.stdout, '[');
    if (!Array.isArray(body)) throw new InstallerError('wrangler deployments list returned unexpected output');
    return body;
  }

  async workerExists(worker) {
    return (await this.deployments(worker)) !== null;
  }

  // Real wrangler fails when --config names a missing file, so the caller
  // must have written the installation config first (context.ensureConfigFile).
  #configArgs(configPath) {
    if (!configPath) return [];
    if (!existsSync(configPath)) throw new InstallerError(`internal error: installation config ${configPath} is missing`);
    return ['--config', configPath];
  }

  /** Secret names bound to the Worker, or null when the Worker does not exist. */
  async secretNames(worker, configPath) {
    const args = ['secret', 'list', '--name', worker, '--format', 'json', ...this.#configArgs(configPath)];
    const result = await this.run(args);
    if (result.code !== 0) {
      if (WORKER_NOT_FOUND.test(`${result.stdout}\n${result.stderr}`)) return null;
      throw commandFailure(`wrangler secret list --name ${worker}`, result);
    }
    const body = firstJson(result.stdout, '[');
    if (!Array.isArray(body)) throw new InstallerError('wrangler secret list returned unexpected output');
    return new Set(body.map((entry) => entry?.name).filter((name) => typeof name === 'string'));
  }

  /** One `wrangler secret bulk` call; values travel as JSON on stdin only. */
  async putSecrets(worker, configPath, values) {
    const args = ['secret', 'bulk', '--name', worker, ...this.#configArgs(configPath)];
    const result = await this.run(args, { input: JSON.stringify(values) });
    if (result.code !== 0) throw commandFailure(`wrangler secret bulk --name ${worker} (${Object.keys(values).length} names)`, result);
  }
}

export async function gitState(executable, cwd) {
  const env = minimalEnv();
  const head = await execTool(executable, ['rev-parse', 'HEAD'], { cwd, env });
  if (head.code !== 0) throw new InstallerError('git rev-parse HEAD failed; run setup from a git checkout');
  const status = await execTool(executable, ['status', '--porcelain', '--untracked-files=no'], { cwd, env });
  if (status.code !== 0) throw new InstallerError('git status failed');
  return { commit: head.stdout.trim(), dirty: status.stdout.trim().length > 0 };
}

/**
 * Run the checked-in deploy script (or a substitute) for one installation
 * config. Output is streamed to stderr for the operator and returned. The
 * environment is the same allowlist the installer's own wrangler calls get.
 */
export async function runDeploy({ script, configPath, artifactDir, cwd, accountId }) {
  const args = ['--install', configPath, '--confirm'];
  if (artifactDir) args.push('--artifact', artifactDir);
  return execTool(script, args, {
    cwd,
    env: toolEnv({ accountId }),
    timeoutMs: DEPLOY_CALL_MS,
    tee: process.stderr,
  });
}
