// Simulated Cloudflare account shared by the fake wrangler, the fake deploy
// script, the fake git and the fake HTTP origin. Persisted as JSON at
// FAKE_WRANGLER_STATE. Secret VALUES are never stored here: only names and
// sha256 digests (plaintext capture for leak tests goes to a separate file
// outside every directory the installer writes).

import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export const ACCOUNT = { id: 'a'.repeat(32), name: 'Fixture Account' };

export function initialState(overrides = {}) {
  return {
    loggedIn: true,
    accounts: [ACCOUNT],
    subdomain: 'fixture-sub',
    queuePageSize: 20,
    queues: {},
    queueCreates: [],
    workers: {},
    secretBulkCalls: [],
    deploys: [],
    invocations: [],
    failures: [],
    deploy: { refusePendingOrigin: false },
    git: { commit: '1'.repeat(40), dirty: false },
    http: { forceNotReady: false, requests: [] },
    objects: {},
    ...overrides,
  };
}

export function statePath() {
  const file = process.env.FAKE_WRANGLER_STATE;
  if (!file) throw new Error('FAKE_WRANGLER_STATE is not set');
  return file;
}

export function readState(file = statePath()) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function writeState(state, file = statePath()) {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temp, file);
}

export const digest = (value) => createHash('sha256').update(value).digest('hex');

/**
 * One invocation record: argv and environment variable names. The values go
 * to FAKE_WRANGLER_ENV_CAPTURE (outside every directory the installer
 * writes), so leak tests can prove that no secret value reached a child
 * process through any environment variable, whatever its name, even as a
 * substring.
 */
export function invocation(tool, argv, env = process.env) {
  if (process.env.FAKE_WRANGLER_ENV_CAPTURE) {
    appendFileSync(process.env.FAKE_WRANGLER_ENV_CAPTURE, `${JSON.stringify({ tool, argv: argv.slice(0, 2), values: Object.values(env) })}\n`);
  }
  return { tool, argv, env: Object.keys(env).sort() };
}

/**
 * Consume a one-shot failure for `command` (e.g. 'queues create', 'secret
 * bulk', 'deploy'), optionally for one target. `when` is 'before' (nothing
 * happens), 'after' (the effect lands, then the tool fails: a lost reply) or,
 * for 'queues create', 'race' (another party creates the queue first). An
 * entry with `skip: n` lets n matching calls pass before it fires.
 * FAKE_WRANGLER_FAIL_AT=[after:]<command>[:<target>] is honoured as well.
 */
export function takeFailure(state, command, target) {
  const fromEnv = process.env.FAKE_WRANGLER_FAIL_AT;
  if (fromEnv) {
    const after = fromEnv.startsWith('after:');
    const [at, envTarget] = (after ? fromEnv.slice(6) : fromEnv).split(':');
    if (at === command && (!envTarget || envTarget === target)) return after ? 'after' : 'before';
  }
  const index = state.failures.findIndex((entry) => entry.at === command && (!entry.target || entry.target === target));
  if (index < 0) return null;
  const entry = state.failures[index];
  if (entry.skip > 0) {
    entry.skip -= 1;
    return null;
  }
  state.failures.splice(index, 1);
  return entry.when ?? 'before';
}
