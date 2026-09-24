#!/usr/bin/env node
// operator:cloudflare (OPS-01, OPS-02, OPS-03, JOB-10): operator
// commands against a deployed Cloudflare installation's /api/operator API.
//
//   node scripts/cloudflare/operator.mjs <command> --origin <https://installation> [options]
//
// The administrator password and the installation's OPERATOR_TOKEN are read
// from stdin JSON ({"ADMIN_PASSWORD": "…", "OPERATOR_TOKEN": "…"}) or from
// no-echo terminal prompts, never from arguments or environment variables.
// The CLI signs in through POST /api/auth (operator requests need a sign-in
// from the last 15 minutes; it signs in again when needed) and sends the token
// as `Authorization: Bearer`. It never prints credentials, cookies or record
// contents: only states, versions, counts, identifiers and error classes.
//
// Operational backup directory (format v1, src/lib/backup/format.ts):
//   chunks/<NN>-<family>-<index>.json   one chunk record each (rows + sha256)
//   manifest.json                       format/schema versions, source, watermark, per-chunk checksums
//   trailer.json                        completion trailer, written last
// A directory without trailer.json is incomplete and is never imported.
// Reference: docs/operations/cloudflare-migration/RUNBOOK.md

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT, isMain } from './lib.mjs';

const USAGE = `Usage: node scripts/cloudflare/operator.mjs <command> --origin <https://installation> [options]

Commands
  status                                     maintenance state/version, activated epoch, counts, jobs
  maintenance <open|draining|frozen|recovery> --expected-state <state> --expected-version <n> [--classify-in-flight]
                                             compare-and-set transition; read status first
  backup export --out <dir>                  operational backup of a frozen/recovery workspace
                                             (the directory must be new or empty and outside the repository)
  backup import --in <dir>                   import a complete backup into an empty workspace in recovery
                                             (validated before sending; re-run to resume)
  recovery restore --expected-state <frozen|recovery> --expected-version <n> (--at <time> | --bookmark <b>)
                                             point-in-time restore of the workspace object; the new
                                             ANALYSIS_RECOVERY_EPOCH must already be bound (RUNBOOK OPS-03).
                                             --at is ISO 8601 with a zone (2026-09-21T14:30:00Z) within 30 days
  recovery activate --expected-epoch <ep_…>  activate the deployment's epoch after restore/import

Credentials
  {"ADMIN_PASSWORD": "…", "OPERATOR_TOKEN": "…"} as JSON on stdin, or no-echo prompts
  in an interactive terminal. Never pass them as arguments or environment variables.
`;

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_REFUSED = 2;

const STATES = ['open', 'draining', 'frozen', 'recovery'];
const EPOCH = /^ep_[0-9a-f]{32}$/;
const CREDENTIAL_NAMES = ['ADMIN_PASSWORD', 'OPERATOR_TOKEN'];
const REQUEST_TIMEOUT_MS = 120_000;
/** Sign in again before the Worker's 15-minute operator window closes. */
const SESSION_REFRESH_MS = 12 * 60 * 1000;
/** Same bound as the import route (src/app/api/operator/_lib/http.ts). */
const MAX_IMPORT_BODY_BYTES = 24 * 1024 * 1024;
const IMPORT_ATTEMPTS = 3;
const SESSION_COOKIE = 'research-auth';
/**
 * The Cloudflare sign-in body bound: MAX_CLOUDFLARE_LOGIN_BODY_BYTES in
 * src/lib/loginBody.ts, which POST /api/auth enforces (tests/unit/adminPasswordLimit.test.ts
 * keeps the two equal).
 */
export const MAX_LOGIN_BODY_BYTES = 1024;
/** Same rule and window as isRestoreBookmark and RESTORE_WINDOW_MS in src/lib/storage/types.ts. */
export const RESTORE_BOOKMARK = /^[0-9A-Za-z][0-9A-Za-z._-]{0,255}$/;
export const RESTORE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;

export class OperatorError extends Error {
  constructor(message, { exitCode = EXIT_FAILED, detail, transport = false } = {}) {
    super(message);
    this.name = 'OperatorError';
    this.exitCode = exitCode;
    this.detail = detail;
    /** An operator request was sent but no complete reply came back: the server may have acted. */
    this.transport = transport;
  }
}

const refuse = (message, detail) => new OperatorError(message, { exitCode: EXIT_REFUSED, detail });

function progress(message) {
  process.stderr.write(`${message}\n`);
}

// ---------- Arguments ----------

const OPTIONS = {
  origin: { type: 'string' },
  'expected-state': { type: 'string' },
  'expected-version': { type: 'string' },
  'classify-in-flight': { type: 'boolean' },
  out: { type: 'string' },
  in: { type: 'string' },
  'expected-epoch': { type: 'string' },
  at: { type: 'string' },
  bookmark: { type: 'string' },
  help: { type: 'boolean' },
};

const COMMAND_OPTIONS = {
  status: [],
  maintenance: ['expected-state', 'expected-version', 'classify-in-flight'],
  'backup export': ['out'],
  'backup import': ['in'],
  'recovery activate': ['expected-epoch'],
  'recovery restore': ['expected-state', 'expected-version', 'at', 'bookmark'],
};

function expectedVersionOf(values) {
  const version = values['expected-version'];
  if (typeof version !== 'string' || !/^\d{1,15}$/.test(version)) {
    throw refuse('--expected-version is required: the maintenance version status reports');
  }
  return Number(version);
}

/**
 * A strict ISO 8601 time with an explicit zone, as epoch milliseconds. Refuses
 * impossible calendar dates (Date.parse would roll 2026-02-30 into March) and
 * times the platform cannot restore: ahead of now or more than 30 days back.
 */
export function parseRestoreTime(raw, now = Date.now()) {
  const match = ISO_TIME.exec(raw ?? '');
  if (!match) throw refuse('--at must be an ISO 8601 time with a zone, such as 2026-09-21T14:30:00Z');
  const [, year, month, day, hour, minute, second = '0', millis = '0', zone] = match;
  const fields = [year, month, day, hour, minute, second].map(Number);
  const wall = new Date(Date.UTC(fields[0], fields[1] - 1, fields[2], fields[3], fields[4], fields[5], Number(millis.padEnd(3, '0'))));
  const actual = [wall.getUTCFullYear(), wall.getUTCMonth() + 1, wall.getUTCDate(), wall.getUTCHours(), wall.getUTCMinutes(), wall.getUTCSeconds()];
  if (actual.some((value, index) => value !== fields[index])) throw refuse(`--at is not a real calendar time: ${raw}`);
  let offsetMinutes = 0;
  if (zone !== 'Z') {
    const [zoneHours, zoneMinutes] = zone.slice(1).split(':').map(Number);
    if (zoneHours > 23 || zoneMinutes > 59) throw refuse(`--at has an invalid zone offset: ${raw}`);
    offsetMinutes = (zone[0] === '-' ? -1 : 1) * (zoneHours * 60 + zoneMinutes);
  }
  const at = wall.getTime() - offsetMinutes * 60_000;
  if (at > now) throw refuse('--at is in the future: a restore target must be a past time');
  if (at < now - RESTORE_WINDOW_MS) throw refuse('--at is more than 30 days ago: point-in-time recovery reaches back 30 days');
  return at;
}

export function parseCommand(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw refuse(`${error.message}\n\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  if (values.help) return { command: 'help' };
  const [first, second, ...rest] = positionals;
  let command;
  let nextState = null;
  if (first === 'status' && positionals.length === 1) command = 'status';
  else if (first === 'maintenance' && positionals.length === 2) {
    command = 'maintenance';
    nextState = second;
  } else if ((first === 'backup' && (second === 'export' || second === 'import')) || (first === 'recovery' && (second === 'activate' || second === 'restore'))) {
    if (rest.length > 0) throw refuse(`unexpected arguments after ${first} ${second}\n\n${USAGE}`);
    command = `${first} ${second}`;
  } else {
    throw refuse(`unknown command\n\n${USAGE}`);
  }
  const allowed = new Set(['origin', ...COMMAND_OPTIONS[command]]);
  const unexpected = Object.keys(values).filter((name) => !allowed.has(name));
  if (unexpected.length > 0) throw refuse(`${command} does not take --${unexpected.join(', --')}`);
  if (!values.origin) throw refuse(`--origin is required\n\n${USAGE}`);
  const origin = validateOrigin(values.origin);

  if (command === 'maintenance') {
    if (!STATES.includes(nextState)) throw refuse('maintenance needs one of open, draining, frozen, recovery');
    if (!STATES.includes(values['expected-state'])) {
      throw refuse('--expected-state is required: the state status reports (open, draining, frozen or recovery)');
    }
    return {
      command,
      origin,
      nextState,
      expectedState: values['expected-state'],
      expectedVersion: expectedVersionOf(values),
      classifyInFlight: values['classify-in-flight'] === true,
    };
  }
  if (command === 'backup export') {
    if (!values.out) throw refuse('--out <directory> is required');
    return { command, origin, out: values.out };
  }
  if (command === 'backup import') {
    if (!values.in) throw refuse('--in <directory> is required');
    return { command, origin, in: values.in };
  }
  if (command === 'recovery activate') {
    if (!EPOCH.test(values['expected-epoch'] ?? '')) {
      throw refuse('--expected-epoch is required: the activated epoch status reports (ep_ followed by 32 hex digits)');
    }
    return { command, origin, expectedEpoch: values['expected-epoch'] };
  }
  if (command === 'recovery restore') {
    const expectedState = values['expected-state'];
    if (expectedState !== 'frozen' && expectedState !== 'recovery') {
      throw refuse('--expected-state is required: frozen or recovery, as status reports (a restore needs a held workspace)');
    }
    const expectedVersion = expectedVersionOf(values);
    if ((values.at === undefined) === (values.bookmark === undefined)) {
      throw refuse('recovery restore needs exactly one of --at <ISO 8601 time> and --bookmark <bookmark>');
    }
    if (values.bookmark !== undefined && !RESTORE_BOOKMARK.test(values.bookmark)) {
      throw refuse('--bookmark must be a point-in-time recovery bookmark (letters, digits, dots, dashes, underscores; at most 256)');
    }
    return {
      command,
      origin,
      expectedState,
      expectedVersion,
      bookmark: values.bookmark ?? null,
      at: values.at === undefined ? null : parseRestoreTime(values.at),
    };
  }
  return { command, origin };
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** An exact origin: HTTPS, or HTTP only to a loopback host (local rehearsal). */
export function validateOrigin(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw refuse('--origin must be an absolute URL such as https://research.example.org');
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw refuse('--origin must be only a scheme and host (no credentials, path, query or fragment)');
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw refuse('--origin must use https (http is accepted only for a loopback host)');
  }
  return url.origin;
}

// ---------- Credentials (stdin JSON or no-echo prompt; never argv/env) ----------

function validateCredential(name, value) {
  if (typeof value !== 'string' || value.length === 0) throw refuse(`${name} is blank`);
  if (value.length > 4096) throw refuse(`${name} is longer than 4096 characters`);
  if (/[\u0000-\u001f\u007f]/.test(value)) throw refuse(`${name} contains control characters`);
  // The Worker refuses a larger sign-in body with 413 before comparing the
  // password, so such a password could never sign in: refuse it here instead.
  if (name === 'ADMIN_PASSWORD' && Buffer.byteLength(JSON.stringify({ password: value })) > MAX_LOGIN_BODY_BYTES) {
    throw refuse(
      `ADMIN_PASSWORD is too long for Cloudflare sign-in: the sign-in request would exceed the ${MAX_LOGIN_BODY_BYTES} bytes `
        + `the Worker accepts (at most ${MAX_LOGIN_BODY_BYTES - Buffer.byteLength('{"password":""}')} ASCII characters; `
        + 'fewer with multi-byte or escaped characters). Rotate it to a shorter value.',
    );
  }
  return value;
}

async function readAllStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function promptHidden(label) {
  const stdin = process.stdin;
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\r' || character === '\n' || character === '\u0004') {
          cleanup();
          resolve(value);
          return;
        }
        if (character === '\u0003') {
          cleanup();
          reject(new OperatorError('cancelled', { exitCode: 130 }));
          return;
        }
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else value += character;
      }
    };
    process.stderr.write(`${label} (input hidden): `);
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

export async function readCredentials() {
  if (process.stdin.isTTY) {
    if (typeof process.stdin.setRawMode !== 'function') throw refuse('credentials need a no-echo terminal or JSON on stdin');
    const values = {};
    for (const name of CREDENTIAL_NAMES) values[name] = validateCredential(name, await promptHidden(name));
    return values;
  }
  let body;
  try {
    body = JSON.parse(await readAllStdin());
  } catch {
    throw refuse('stdin must be JSON: {"ADMIN_PASSWORD": "…", "OPERATOR_TOKEN": "…"}');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw refuse('stdin JSON must be an object');
  const unexpected = Object.keys(body).filter((key) => !CREDENTIAL_NAMES.includes(key));
  if (unexpected.length > 0) throw refuse(`stdin JSON has unexpected names: ${unexpected.join(', ')} (expected exactly ${CREDENTIAL_NAMES.join(', ')})`);
  const values = {};
  for (const name of CREDENTIAL_NAMES) {
    if (!Object.hasOwn(body, name)) throw refuse(`stdin JSON lacks ${name}`);
    values[name] = validateCredential(name, body[name]);
  }
  return values;
}

// ---------- HTTP ----------

function networkFailure(error, { transport = false } = {}) {
  // A timeout rejects with a DOMException, whose numeric legacy `code` (23) says nothing: use its name.
  const code = [error?.cause?.code, error?.code].find((value) => typeof value === 'string') ?? error?.name ?? 'network-error';
  return new OperatorError(`request failed (${String(code)})`, { detail: { network: String(code) }, transport });
}

function parseJsonObject(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

async function readJson(response) {
  try {
    return parseJsonObject(await response.text());
  } catch {
    return {};
  }
}

/** Server-provided fields that are safe to show: codes, states, counts. Never content. */
function safeDetail(status, body) {
  const detail = { httpStatus: status };
  for (const key of ['code', 'error', 'reason', 'holdReason', 'errorClass', 'counts', 'state', 'version', 'claimed', 'started', 'retryable']) {
    if (body[key] !== undefined) detail[key] = body[key];
  }
  return detail;
}

export class OperatorClient {
  constructor(origin, credentials, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    this.origin = origin;
    this.credentials = credentials;
    this.cookie = null;
    this.signedInAt = 0;
    this.timeoutMs = timeoutMs;
  }

  async signIn() {
    let response;
    try {
      response = await fetch(`${this.origin}/api/auth`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ password: this.credentials.ADMIN_PASSWORD }),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw networkFailure(error);
    }
    const body = await readJson(response);
    if (response.status === 429) {
      throw new OperatorError(`sign-in refused: too many attempts; retry after ${response.headers.get('retry-after') ?? '?'} seconds`, {
        detail: safeDetail(429, body),
      });
    }
    if (response.status === 401) throw refuse('sign-in refused: ADMIN_PASSWORD was not accepted', safeDetail(401, body));
    if (response.status !== 200) throw new OperatorError(`sign-in failed (HTTP ${response.status})`, { detail: safeDetail(response.status, body) });
    const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    const session = setCookies
      .map((value) => value.split(';')[0].trim())
      .find((pair) => pair.startsWith(`${SESSION_COOKIE}=`) && pair.length > SESSION_COOKIE.length + 1);
    if (!session) throw new OperatorError('sign-in returned no session cookie');
    this.cookie = session;
    this.signedInAt = Date.now();
  }

  async ensureSession() {
    if (!this.cookie || Date.now() - this.signedInAt > SESSION_REFRESH_MS) await this.signIn();
  }

  /**
   * One operator API call. Returns { status, body }; never throws on an HTTP
   * status. A request that was sent but got no complete reply (reset, timeout,
   * body cut off) throws an OperatorError with `transport` set.
   */
  async call(method, pathname, { query, body } = {}) {
    await this.ensureSession();
    const send = async () => {
      const url = new URL(pathname, this.origin);
      for (const [key, value] of Object.entries(query ?? {})) {
        if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
      }
      const headers = {
        accept: 'application/json',
        authorization: `Bearer ${this.credentials.OPERATOR_TOKEN}`,
        cookie: this.cookie,
      };
      if (body !== undefined) headers['content-type'] = 'application/json';
      let response;
      try {
        response = await fetch(url, {
          method,
          headers,
          body: body === undefined ? undefined : body,
          redirect: 'manual',
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        // The timeout signal also bounds reading the body.
        return { status: response.status, body: parseJsonObject(await response.text()) };
      } catch (error) {
        throw networkFailure(error, { transport: true });
      }
    };
    let result = await send();
    // Operator authority needs a sign-in from the last 15 minutes; refusals
    // happen before any storage call, so one retry after signing in is safe.
    if (
      (result.status === 403 && result.body.code === 'RECENT_SIGN_IN_REQUIRED')
      || (result.status === 401 && result.body.code === 'SIGN_IN_REQUIRED')
    ) {
      await this.signIn();
      result = await send();
    }
    if (result.status === 401 && result.body.code === 'OPERATOR_UNAUTHORIZED') {
      throw refuse('operator request refused: OPERATOR_TOKEN was not accepted', safeDetail(401, result.body));
    }
    if (result.status === 404 && pathname.startsWith('/api/operator/')) {
      throw refuse('this origin has no operator API (it is not a Cloudflare installation)', safeDetail(404, result.body));
    }
    if (result.status === 503 && result.body.code === 'OPERATOR_NOT_CONFIGURED') {
      throw refuse('operator access is not configured on this installation (OPERATOR_TOKEN is missing)', safeDetail(503, result.body));
    }
    return result;
  }

  async status() {
    const result = await this.call('GET', '/api/operator/status');
    if (result.status !== 200 || result.body.status !== 'ok') {
      throw new OperatorError(`status failed (HTTP ${result.status})`, { detail: safeDetail(result.status, result.body) });
    }
    return result.body;
  }
}

/** The status fields an operator needs after any outcome. */
function statusSummary(status) {
  return {
    workspaceId: status.workspaceId,
    maintenance: status.maintenance,
    epoch: status.epoch,
    jobs: status.jobs,
  };
}

/** Best-effort status read after a failure: the held state is part of the report. */
async function currentStatus(client) {
  try {
    return statusSummary(await client.status());
  } catch (error) {
    return { unavailable: error instanceof OperatorError ? error.message : 'status could not be read' };
  }
}

/**
 * A state-changing request that may or may not have committed: the Worker
 * said so (OUTCOME_UNKNOWN, an unrecognized 5xx), the reply was lost, or a 2xx
 * carried no recognizable result. The request is never repeated here; the
 * report carries `outcome: "unknown"` and a fresh status read, or says that
 * status could not be read either.
 */
async function outcomeUnknown(client, action, reason, detail, next = '') {
  const status = await currentStatus(client);
  const statusNote = status.unavailable === undefined
    ? 'current status is reported below'
    : 'status could not be read either: run status before anything else and decide from the state it reports (RUNBOOK "Operator CLI")';
  return new OperatorError(`${action} outcome unknown (${reason}); ${statusNote}${next ? `. ${next}` : ''}`, {
    detail: { ...detail, outcome: 'unknown', status },
  });
}

/** Sends a state-changing request once; a lost reply becomes an unknown outcome, never a resend. */
async function sendMutation(client, action, pathname, body) {
  try {
    return await client.call('POST', pathname, { body });
  } catch (error) {
    if (error instanceof OperatorError && error.transport) {
      throw await outcomeUnknown(client, action, `no reply: ${error.detail.network}`, error.detail);
    }
    throw error;
  }
}

// ---------- Backup format (shared with the Worker, loaded with type stripping) ----------

let formatModule = null;

async function loadFormat() {
  if (formatModule) return formatModule;
  const listeners = process.listeners('warning');
  process.removeAllListeners('warning');
  process.on('warning', (warning) => {
    // Loading the portable TypeScript module is expected; keep other warnings.
    if (warning?.code === 'MODULE_TYPELESS_PACKAGE_JSON') return;
    if (warning?.name === 'ExperimentalWarning' && /type stripping/i.test(String(warning.message))) return;
    for (const listener of listeners) listener(warning);
  });
  formatModule = await import(new URL('../../src/lib/backup/format.ts', import.meta.url).href);
  return formatModule;
}

function chunkFileName(format, family, index) {
  const order = format.BACKUP_FAMILY_NAMES.indexOf(family);
  return `${String(order).padStart(2, '0')}-${family}-${String(index).padStart(6, '0')}.json`;
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function realpathOfNearestAncestor(target) {
  let current = path.resolve(target);
  const rest = [];
  while (!existsSync(current)) {
    rest.unshift(path.basename(current));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.join(realpathSync(current), ...rest);
}

/** --out must be a new or empty directory outside the repository. Creates nothing. */
export function checkExportDirectory(raw) {
  const target = path.resolve(raw);
  if (isInside(realpathOfNearestAncestor(target), realpathSync(ROOT))) {
    throw refuse('--out must be outside the repository: a backup contains participant data');
  }
  if (existsSync(target)) {
    if (!statSync(target).isDirectory()) throw refuse('--out exists and is not a directory');
    if (readdirSync(target).length > 0) throw refuse('--out must be a new or empty directory');
  }
  return target;
}

/** Re-checks, then creates the directory private (0700) with its chunks/ folder. */
function createExportDirectory(target) {
  checkExportDirectory(target);
  if (!existsSync(target)) mkdirSync(target, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(target, 'chunks'), { mode: 0o700 });
  return target;
}

function writePrivateFile(file, text) {
  const fd = openSync(file, 'wx', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function sameWatermark(a, b) {
  return a.maintenanceVersion === b.maintenanceVersion && a.mutationSeq === b.mutationSeq;
}

function watermarkParam(watermark) {
  return watermark ? `${watermark.maintenanceVersion}:${watermark.mutationSeq}` : null;
}

function sameFamilies(advertised, known) {
  return Array.isArray(advertised) && advertised.length === known.length && advertised.every((name, index) => name === known[index]);
}

async function exportBackup(client, options) {
  const format = await loadFormat();
  const before = await client.status();
  const state = before.maintenance?.state;
  if (state !== 'frozen' && state !== 'recovery') {
    throw refuse(`backup export needs a frozen or recovery workspace; it is ${state} (version ${before.maintenance?.version})`, {
      status: statusSummary(before),
    });
  }
  const written = [];
  let directory = null;
  let writer = null;
  let first = null;
  const counts = {};
  try {
    for (const family of format.BACKUP_FAMILY_NAMES) {
      let cursor = null;
      counts[family] = 0;
      do {
        const result = await client.call('GET', '/api/operator/backup', {
          query: { family, cursor, watermark: watermarkParam(first?.watermark) },
        });
        const page = result.body;
        if (result.status !== 200 || page.status !== 'ok') {
          throw new OperatorError(`backup page for ${family} refused (HTTP ${result.status}${page.code ? ` ${page.code}` : ''})`, {
            detail: safeDetail(result.status, page),
          });
        }
        if (!first) {
          // A manifest must cover every family the installation holds: refuse before writing anything.
          if (!sameFamilies(page.families, format.BACKUP_FAMILY_NAMES)) {
            throw refuse(
              'the installation backs up a different set of record families than this CLI checkout; '
                + 'run the operator CLI from the release deployed there',
              { errorClass: 'families-mismatch' },
            );
          }
          directory = createExportDirectory(options.out);
          first = { watermark: page.watermark, workspaceId: page.workspaceId, schemaVersion: page.schemaVersion };
          writer = new format.BackupWriter({
            schemaVersion: page.schemaVersion,
            sourceWorkspaceId: page.workspaceId,
            exportedAt: Date.now(),
            watermark: page.watermark,
          });
        } else if (
          !sameWatermark(page.watermark, first.watermark)
          || page.workspaceId !== first.workspaceId
          || page.schemaVersion !== first.schemaVersion
        ) {
          throw new OperatorError('the workspace changed during the export (watermark mismatch)', { detail: { errorClass: 'watermark-changed' } });
        }
        if (page.rows.length > 0) {
          const record = await writer.chunk(family, page.rows, page.watermark);
          const name = chunkFileName(format, family, record.index);
          writePrivateFile(path.join(directory, 'chunks', name), `${format.encodeBackupRecord(record)}\n`);
          written.push({ family, index: record.index, name });
          counts[family] += page.rows.length;
        }
        if (page.nextCursor !== null && page.nextCursor === cursor) throw new OperatorError('backup paging did not advance');
        cursor = page.nextCursor;
      } while (cursor !== null);
      progress(`exported ${family}: ${counts[family]} rows`);
    }

    // The watermark still holds after the last page: nothing changed at all.
    const check = await client.call('GET', '/api/operator/backup', {
      query: { family: format.BACKUP_FAMILY_NAMES[0], watermark: watermarkParam(first.watermark) },
    });
    if (check.status !== 200 || check.body.status !== 'ok' || !sameWatermark(check.body.watermark, first.watermark)) {
      throw new OperatorError('the workspace changed after the last page (watermark mismatch)', { detail: safeDetail(check.status, check.body) });
    }

    const { manifest, trailer } = await writer.finish();
    // Re-validate exactly what is on disk before declaring it complete.
    const validator = new format.BackupValidator();
    for (const entry of written) {
      const line = readFileSync(path.join(directory, 'chunks', entry.name), 'utf8').trim();
      const rejected = await validator.accept(format.parseBackupLine(line));
      if (rejected) throw new OperatorError(`written backup failed validation (${rejected.errorClass})`, { detail: { errorClass: rejected.errorClass } });
    }
    for (const record of [manifest, trailer]) {
      const rejected = await validator.accept(record);
      if (rejected) throw new OperatorError(`written backup failed validation (${rejected.errorClass})`, { detail: { errorClass: rejected.errorClass } });
    }
    const validation = validator.finish();
    if (validation.status !== 'valid') throw new OperatorError(`written backup failed validation (${validation.errorClass})`);

    writePrivateFile(path.join(directory, 'manifest.json'), `${format.encodeBackupRecord(manifest)}\n`);
    // The completion trailer is written last, only after every page matched one watermark.
    writePrivateFile(path.join(directory, 'trailer.json'), `${format.encodeBackupRecord(trailer)}\n`);
  } catch (error) {
    const status = await currentStatus(client);
    const failure = error instanceof OperatorError ? error : new OperatorError('backup export failed');
    const leftBehind = directory
      ? 'The directory has no completion trailer and must not be used.'
      : 'Nothing was written.';
    throw new OperatorError(
      `backup export interrupted: ${failure.message}. ${leftBehind} `
        + 'The workspace stays held; return it to service explicitly with a maintenance transition.',
      { exitCode: failure.exitCode, detail: { ...(failure.detail ?? {}), complete: false, directory, status } },
    );
  }

  return {
    command: 'backup export',
    complete: true,
    directory,
    workspaceId: first.workspaceId,
    schemaVersion: first.schemaVersion,
    watermark: first.watermark,
    chunks: written.length,
    counts,
    status: statusSummary(before),
    next: 'Store the directory with protections suitable for participant data. The workspace stays held until you transition it.',
  };
}

// ---------- Backup import ----------

function readRecordFile(format, file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { missing: true };
  }
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length !== 1) return { invalid: true };
  try {
    return { record: format.parseBackupLine(lines[0]), bytes: Buffer.byteLength(lines[0]) };
  } catch {
    return { invalid: true };
  }
}

/** Validates the whole backup directory before anything is sent. */
async function loadBackupDirectory(format, raw) {
  const directory = path.resolve(raw);
  if (!existsSync(directory) || !statSync(directory).isDirectory()) throw refuse('--in must be a backup directory');
  const trailerFile = readRecordFile(format, path.join(directory, 'trailer.json'));
  if (trailerFile.missing) throw refuse('backup is incomplete: trailer.json is missing (an interrupted export); it cannot be imported', { errorClass: 'trailer-missing' });
  const manifestFile = readRecordFile(format, path.join(directory, 'manifest.json'));
  if (manifestFile.missing) throw refuse('backup is incomplete: manifest.json is missing', { errorClass: 'manifest-missing' });
  if (trailerFile.invalid || manifestFile.invalid) throw refuse('backup manifest or trailer is not a single valid record', { errorClass: 'format-invalid' });
  const manifestRecord = manifestFile.record;
  if (manifestRecord?.kind !== 'manifest' || !format.isValidBackupManifest(manifestRecord.manifest)) {
    throw refuse('backup manifest is invalid', { errorClass: 'manifest-invalid' });
  }
  const manifest = manifestRecord.manifest;
  const importManifest = format.importManifestOf(manifest);
  const manifestBytes = Buffer.byteLength(JSON.stringify(importManifest));

  const expected = [];
  for (const family of manifest.families) {
    for (const descriptor of family.chunks) {
      expected.push({ family: family.name, index: descriptor.index, name: chunkFileName(format, family.name, descriptor.index) });
    }
  }
  const chunksDir = path.join(directory, 'chunks');
  const present = existsSync(chunksDir) ? readdirSync(chunksDir) : [];
  const expectedNames = new Set(expected.map((entry) => entry.name));
  if (present.some((name) => !expectedNames.has(name))) {
    throw refuse('backup has chunk files the manifest does not describe', { errorClass: 'chunk-unexpected' });
  }

  const validator = new format.BackupValidator();
  for (const entry of expected) {
    const file = readRecordFile(format, path.join(chunksDir, entry.name));
    if (file.missing) throw refuse(`backup is missing chunk ${entry.family} #${entry.index}`, { errorClass: 'chunk-missing' });
    if (file.invalid) throw refuse(`backup chunk ${entry.family} #${entry.index} is not a single valid record`, { errorClass: 'format-invalid' });
    const rejected = await validator.accept(file.record);
    if (rejected) throw refuse(`backup failed validation (${rejected.errorClass})`, { errorClass: rejected.errorClass, counts: rejected.counts });
    if (file.record.family !== entry.family || file.record.index !== entry.index) {
      throw refuse('backup chunk file does not hold the chunk its name claims', { errorClass: 'chunk-unexpected' });
    }
    // Chunks are bound to their descriptors and cannot be split: refuse early.
    if (file.bytes + manifestBytes + 1024 > MAX_IMPORT_BODY_BYTES) {
      throw refuse(`backup chunk ${entry.family} #${entry.index} exceeds the import request limit`, { errorClass: 'chunk-too-large' });
    }
  }
  for (const record of [manifestRecord, trailerFile.record]) {
    const rejected = await validator.accept(record);
    if (rejected) throw refuse(`backup failed validation (${rejected.errorClass})`, { errorClass: rejected.errorClass, counts: rejected.counts });
  }
  const validation = validator.finish();
  if (validation.status !== 'valid') throw refuse(`backup failed validation (${validation.errorClass})`, { errorClass: validation.errorClass });
  return { directory, chunksDir, manifest, importManifest, expected, counts: validation.counts };
}

const RESUME_IMPORT = 'Accepted chunks are kept; re-run the same command to resume.';

/**
 * Import chunks and finalize are idempotent under one manifest digest (a
 * replayed finalize answers `finalized` again), so these are the only
 * state-changing requests the CLI resends.
 */
async function importCall(client, body, action) {
  let last = null;
  for (let attempt = 1; attempt <= IMPORT_ATTEMPTS; attempt += 1) {
    try {
      const result = await client.call('POST', '/api/operator/backup/import', { body });
      // Unknown outcome or unavailable storage: the same chunk is safe to resend.
      if (result.status === 503 && result.body.retryable === true && attempt < IMPORT_ATTEMPTS) {
        last = result;
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        continue;
      }
      return result;
    } catch (error) {
      if (!(error instanceof OperatorError) || error.exitCode !== EXIT_FAILED || !error.detail?.network) throw error;
      if (attempt === IMPORT_ATTEMPTS) {
        if (error.transport) throw await outcomeUnknown(client, action, `no reply: ${error.detail.network}`, error.detail, RESUME_IMPORT);
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  return last;
}

async function importBackup(client, backup) {
  const format = await loadFormat();

  const before = await client.status();
  if (before.maintenance?.state !== 'recovery') {
    throw refuse(`backup import needs a workspace in recovery; it is ${before.maintenance?.state} (version ${before.maintenance?.version})`, {
      status: statusSummary(before),
    });
  }

  let sent = 0;
  let duplicates = 0;
  for (const entry of backup.expected) {
    const { record } = readRecordFile(format, path.join(backup.chunksDir, entry.name));
    const body = JSON.stringify({
      manifest: backup.importManifest,
      chunk: { family: record.family, index: record.index, sha256: record.sha256, rows: record.rows },
    });
    const action = `import of ${entry.family} #${entry.index}`;
    const result = await importCall(client, body, action);
    if (result.status !== 200 || result.body.status !== 'accepted' || result.body.family !== entry.family || result.body.index !== entry.index) {
      if (isUnknownReply(result)) throw await outcomeUnknown(client, action, unknownSummary(result), safeDetail(result.status, result.body), RESUME_IMPORT);
      throw new OperatorError(
        `${action} refused (HTTP ${result.status}${result.body.code ? ` ${result.body.code}` : ''}). ${RESUME_IMPORT}`,
        { detail: { ...safeDetail(result.status, result.body), status: await currentStatus(client) } },
      );
    }
    sent += 1;
    if (result.body.duplicate === true) duplicates += 1;
  }

  const finalized = await importCall(client, JSON.stringify({ manifest: backup.importManifest, chunk: null, finalize: true }), 'import finalize');
  if (finalized.status !== 200 || finalized.body.status !== 'finalized') {
    if (isUnknownReply(finalized)) {
      throw await outcomeUnknown(client, 'import finalize', unknownSummary(finalized), safeDetail(finalized.status, finalized.body), RESUME_IMPORT);
    }
    throw new OperatorError(
      `import finalize refused (HTTP ${finalized.status}${finalized.body.code ? ` ${finalized.body.code}` : ''})`,
      { detail: { ...safeDetail(finalized.status, finalized.body), status: await currentStatus(client) } },
    );
  }
  const after = await currentStatus(client);
  return {
    command: 'backup import',
    finalized: true,
    chunks: sent,
    duplicates,
    counts: finalized.body.counts,
    status: after,
    next: 'The workspace stays in recovery. Activate the deployment epoch with: recovery activate --expected-epoch <activated epoch from status>.',
  };
}

// ---------- Commands ----------

/**
 * 503 codes the Worker returns only when it refused the request before the
 * object acted, or the object refused it: the transition certainly did not
 * happen. Any other 5xx may have committed.
 */
const DEFINITE_REFUSAL_CODES = new Set(['DEPLOYMENT_NOT_READY', 'WORKSPACE_HELD', 'WORKSPACE_NOT_CONFIGURED']);

function refusalSummary(result) {
  const { code, holdReason } = result.body;
  return `HTTP ${result.status}${code ? ` ${code}` : ''}${typeof holdReason === 'string' ? ` (${holdReason})` : ''}`;
}

function isDefiniteRefusal(result) {
  return result.status === 503 && DEFINITE_REFUSAL_CODES.has(result.body.code);
}

/**
 * A reply that does not settle a state-changing request: OUTCOME_UNKNOWN, a
 * 5xx that is not a definite refusal, or a 2xx without the expected result
 * (callers check the expected result first).
 */
function isUnknownReply(result) {
  if (result.status >= 200 && result.status < 300) return true;
  return !isDefiniteRefusal(result) && (result.body.code === 'OUTCOME_UNKNOWN' || result.status >= 500);
}

function unknownSummary(result) {
  return result.status >= 200 && result.status < 300 ? `HTTP ${result.status} without a recognizable result` : refusalSummary(result);
}

async function maintenance(client, options) {
  const result = await sendMutation(client, 'maintenance', '/api/operator/maintenance', JSON.stringify({
    expectedState: options.expectedState,
    expectedVersion: options.expectedVersion,
    nextState: options.nextState,
    ...(options.classifyInFlight ? { classifyInFlight: true } : {}),
  }));
  if (result.status === 200 && (result.body.status === 'transitioned' || result.body.status === 'already')) {
    return { command: 'maintenance', status: result.body.status, state: result.body.state, version: result.body.version };
  }
  const detail = safeDetail(result.status, result.body);
  // A lost reply is resolved by reading status, never by repeating blindly.
  if (isUnknownReply(result)) throw await outcomeUnknown(client, 'maintenance', unknownSummary(result), detail);
  throw refuse(`maintenance transition refused (${refusalSummary(result)})`, detail);
}

async function activate(client, options) {
  const result = await sendMutation(client, 'activation', '/api/operator/recovery/activate', JSON.stringify({
    expectedActivatedEpoch: options.expectedEpoch,
  }));
  if (result.status === 200 && (result.body.status === 'activated' || result.body.status === 'already-active')) {
    return {
      command: 'recovery activate',
      status: result.body.status,
      ...(typeof result.body.reconciledJobs === 'number' ? { reconciledJobs: result.body.reconciledJobs } : {}),
      next: 'Verify with status, then return the workspace to service with a maintenance transition.',
    };
  }
  const detail = safeDetail(result.status, result.body);
  if (isUnknownReply(result)) throw await outcomeUnknown(client, 'activation', unknownSummary(result), detail);
  throw refuse(`activation refused (${refusalSummary(result)})`, detail);
}

async function restore(client, options) {
  const result = await sendMutation(client, 'restore', '/api/operator/recovery/restore', JSON.stringify({
    expectedState: options.expectedState,
    expectedVersion: options.expectedVersion,
    ...(options.bookmark !== null ? { bookmark: options.bookmark } : { at: options.at }),
  }));
  if (result.status === 200 && result.body.status === 'scheduled') {
    return {
      command: 'recovery restore',
      status: 'scheduled',
      bookmark: result.body.bookmark,
      undoBookmark: result.body.undoBookmark,
      next: 'The workspace object restarts on the restored storage. Read status: it reports the restored maintenance state '
        + 'and version with epoch.configuredMatches false. Then move it to recovery and activate the epoch. '
        + 'Keep undoBookmark: restoring it, from frozen or recovery, reverses this restore.',
    };
  }
  const detail = safeDetail(result.status, result.body);
  // The object may have restarted on the restored storage before replying.
  if (isUnknownReply(result)) throw await outcomeUnknown(client, 'restore', unknownSummary(result), detail);
  throw refuse(`restore refused (${refusalSummary(result)})`, detail);
}

/** Runs a parsed command with a signed-in client. */
export async function runCommand(client, options, backup = null) {
  switch (options.command) {
    case 'status':
      return { command: 'status', ...(await client.status()) };
    case 'maintenance':
      return maintenance(client, options);
    case 'backup export':
      return exportBackup(client, options);
    case 'backup import':
      return importBackup(client, backup);
    case 'recovery activate':
      return activate(client, options);
    case 'recovery restore':
      return restore(client, options);
    default:
      throw refuse('unknown command');
  }
}

export async function runOperator(argv) {
  const options = parseCommand(argv);
  if (options.command === 'help') {
    process.stdout.write(USAGE);
    return null;
  }
  // Validate local inputs that need no network before asking for credentials:
  // an incomplete or corrupt backup never reaches the workspace.
  let backup = null;
  if (options.command === 'backup import') {
    backup = await loadBackupDirectory(await loadFormat(), options.in);
    progress(`backup validated: ${backup.expected.length} chunks from ${backup.manifest.sourceWorkspaceId}`);
  }
  if (options.command === 'backup export') checkExportDirectory(options.out);
  const credentials = await readCredentials();
  const client = new OperatorClient(options.origin, credentials);
  await client.signIn();
  return runCommand(client, options, backup);
}

async function main() {
  try {
    const result = await runOperator(process.argv.slice(2));
    if (result) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = EXIT_OK;
  } catch (error) {
    if (error instanceof OperatorError) {
      process.stderr.write(`error: ${error.message}\n`);
      process.stdout.write(`${JSON.stringify({ ok: false, error: error.message, ...(error.detail ? { detail: error.detail } : {}) }, null, 2)}\n`);
      process.exitCode = error.exitCode;
      return;
    }
    // Never print an unexpected error's message: it could carry a response body.
    process.stderr.write(`error: unexpected failure (${error?.name ?? 'Error'})\n`);
    process.exitCode = EXIT_FAILED;
  }
}

// import.meta.main, not an argv[1] path comparison: Node runs the real path
// of a symlinked script, so that comparison never matched through a link.
if (isMain(import.meta)) {
  await main();
}
