// scripts/cloudflare/operator.mjs against a fake local installation (OPS-01,
// OPS-02, OPS-03 local parts, JOB-10). The fake server implements the
// /api/auth and /api/operator/* HTTP contracts with an in-memory workspace
// made of synthetic rows; no credentials, no network beyond 127.0.0.1.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ROOT } from '../../scripts/cloudflare/lib.mjs';

const CLI = path.join(ROOT, 'scripts', 'cloudflare', 'operator.mjs');
const PASSWORD = 'synthetic-admin-password-4471';
const TOKEN = 'synthetic-operator-token-0123456789abcdefgh';
const CREDENTIALS = JSON.stringify({ ADMIN_PASSWORD: PASSWORD, OPERATOR_TOKEN: TOKEN });
const CONTENT_MARKER = 'synthetic-participant-speech-9c1f';
const WORKSPACE_ID = `ws_${'1'.repeat(32)}`;
const SOURCE_EPOCH = `ep_${'a'.repeat(32)}`;

const format = await loadFormat();

async function loadFormat() {
  process.removeAllListeners('warning');
  return import(new URL('../../src/lib/backup/format.ts', import.meta.url).href);
}

function tempDir(t, prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---------- Synthetic workspace rows ----------

const ROW_COUNTS = {
  workspace_meta: 1,
  studies: 3,
  interviews: 7,
  analysis: 7,
  analysis_jobs: 2,
  aggregates: 1,
  participant_links: 4,
  consents: 2,
  idempotency_receipts: 1,
  budget_windows: 0,
  budget_members: 5,
  deletion_fences: 0,
};

function syntheticRow(family, index, watermark) {
  if (family.name === 'workspace_meta') {
    return {
      singleton: 1,
      workspace_id: WORKSPACE_ID,
      activated_epoch: SOURCE_EPOCH,
      maintenance_state: 'frozen',
      maintenance_version: watermark.maintenanceVersion,
      mutation_seq: watermark.mutationSeq,
      created_at: 1_800_000_000_000,
      updated_at: 1_800_000_000_000,
    };
  }
  const row = {};
  for (const column of family.columns) {
    row[column.name] = column.type === 'integer'
      ? 1_800_000_000_000 + index
      : `${family.name}-${column.name}-${String(index).padStart(3, '0')}${column.name === 'record_json' ? ` ${CONTENT_MARKER} — 研究` : ''}`;
  }
  return row;
}

function workspaceRows(watermark) {
  const rows = {};
  for (const family of format.BACKUP_FAMILIES) {
    rows[family.name] = Array.from({ length: ROW_COUNTS[family.name] }, (_, index) => syntheticRow(family, index, watermark));
  }
  return rows;
}

// ---------- Fake installation ----------

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  response.end(JSON.stringify(body));
}

async function fakeInstallation(t, overrides = {}) {
  const state = {
    maintenance: { state: 'frozen', version: 4 },
    mutationSeq: 17,
    activatedEpoch: SOURCE_EPOCH,
    pageSize: 3,
    sessions: new Set(),
    signIns: 0,
    requests: [],
    maintenanceBodies: [],
    importCalls: [],
    imported: new Map(),
    finalized: null,
    faults: {},
    ...overrides,
  };
  let pagesServed = 0;
  let importCount = 0;
  let staleServed = false;

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const body = await readBody(request);
    state.requests.push({
      method: request.method,
      path: url.pathname,
      authorization: request.headers.authorization ?? null,
      cookie: request.headers.cookie ?? null,
    });

    if (url.pathname === '/api/auth' && request.method === 'POST') {
      let password = null;
      try {
        password = JSON.parse(body).password;
      } catch {
        // falls through to 401
      }
      if (password !== PASSWORD) return send(response, 401, { error: 'Invalid password' });
      state.signIns += 1;
      const session = `session-${state.signIns}`;
      state.sessions.add(session);
      return send(response, 200, { success: true }, {
        'set-cookie': `research-auth=${session}; Path=/; HttpOnly; Secure; SameSite=Strict`,
      });
    }

    if (!url.pathname.startsWith('/api/operator/')) return send(response, 404, { error: 'Not found' });
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      return send(response, 401, { error: 'Operator authorization required.', code: 'OPERATOR_UNAUTHORIZED' });
    }
    const session = /research-auth=([^;]+)/.exec(request.headers.cookie ?? '')?.[1];
    if (!session || !state.sessions.has(session)) {
      return send(response, 401, { error: 'Researcher sign-in required.', code: 'SIGN_IN_REQUIRED' });
    }
    if (state.faults.staleOnce && !staleServed) {
      staleServed = true;
      state.sessions.delete(session);
      return send(response, 403, { error: 'Sign in again.', code: 'RECENT_SIGN_IN_REQUIRED' });
    }
    const watermark = { maintenanceVersion: state.maintenance.version, mutationSeq: state.mutationSeq };

    if (url.pathname === '/api/operator/status' && request.method === 'GET') {
      return send(response, 200, {
        status: 'ok',
        workspaceId: WORKSPACE_ID,
        schemaVersion: 1,
        maintenance: state.maintenance,
        epoch: { activated: state.activatedEpoch, configuredMatches: true },
        counts: { ...ROW_COUNTS },
        jobs: { pending: 0, claimed: 0, started: 0, recoveryRequired: 1, oldestActiveAgeMs: null },
        alarm: { scheduledAt: null },
      });
    }

    if (url.pathname === '/api/operator/backup' && request.method === 'GET') {
      if (state.maintenance.state !== 'frozen' && state.maintenance.state !== 'recovery') {
        return send(response, 409, { error: 'not frozen', code: 'NOT_FROZEN' });
      }
      const presented = url.searchParams.get('watermark');
      if (presented !== null && presented !== `${watermark.maintenanceVersion}:${watermark.mutationSeq}`) {
        return send(response, 409, { error: 'changed', code: 'WATERMARK_CHANGED' });
      }
      const family = url.searchParams.get('family');
      const rows = workspaceRows(watermark)[family];
      if (!rows) return send(response, 400, { error: 'Unknown backup family.', code: 'INVALID_REQUEST' });
      const offset = Number(url.searchParams.get('cursor') ?? '0');
      const page = rows.slice(offset, offset + state.pageSize);
      pagesServed += 1;
      if (state.faults.mutateAfterPages !== undefined && pagesServed >= state.faults.mutateAfterPages) state.mutationSeq += 1;
      return send(response, 200, {
        status: 'ok',
        watermark,
        family,
        rows: page,
        nextCursor: offset + state.pageSize < rows.length ? String(offset + state.pageSize) : null,
        families: state.families ?? [...format.BACKUP_FAMILY_NAMES],
        schemaVersion: 1,
        workspaceId: WORKSPACE_ID,
      });
    }

    if (url.pathname === '/api/operator/maintenance' && request.method === 'POST') {
      const input = JSON.parse(body);
      state.maintenanceBodies.push(input);
      if (state.faults.maintenanceReply) return send(response, state.faults.maintenanceReply.status, state.faults.maintenanceReply.body);
      if (input.expectedState !== state.maintenance.state || input.expectedVersion !== state.maintenance.version) {
        return send(response, 409, { error: 'conflict', code: 'MAINTENANCE_CONFLICT', ...state.maintenance });
      }
      state.maintenance = { state: input.nextState, version: state.maintenance.version + 1 };
      return send(response, 200, { status: 'transitioned', ...state.maintenance });
    }

    if (url.pathname === '/api/operator/backup/import' && request.method === 'POST') {
      if (request.headers['content-type'] !== 'application/json') return send(response, 415, { code: 'UNSUPPORTED_MEDIA_TYPE' });
      importCount += 1;
      const input = JSON.parse(body);
      state.importCalls.push(input.chunk ? `${input.chunk.family}:${input.chunk.index}` : 'finalize');
      if (state.faults.importFailAt === importCount) {
        return send(response, 500, { error: 'Operator request failed.', code: 'INTERNAL' });
      }
      if (state.faults.importUnknownAt === importCount) {
        return send(response, 503, { error: 'The outcome is unknown.', code: 'OUTCOME_UNKNOWN', retryable: true });
      }
      if (state.maintenance.state !== 'recovery') return send(response, 409, { code: 'NOT_RECOVERY' });
      if (input.finalize) {
        const counts = {};
        for (const family of input.manifest.families) {
          counts[family.name] = family.chunks.reduce((sum, chunk) => sum + (state.imported.has(`${family.name}:${chunk.index}`) ? chunk.rows : 0), 0);
        }
        state.finalized = counts;
        return send(response, 200, { status: 'finalized', counts });
      }
      const { chunk } = input;
      if ((await format.chunkChecksum(chunk.rows)) !== chunk.sha256) {
        return send(response, 422, { code: 'IMPORT_REJECTED', errorClass: 'checksum-mismatch' });
      }
      const key = `${chunk.family}:${chunk.index}`;
      const duplicate = state.imported.has(key);
      state.imported.set(key, chunk.sha256);
      return send(response, 200, { status: 'accepted', family: chunk.family, index: chunk.index, duplicate });
    }

    if (url.pathname === '/api/operator/recovery/activate' && request.method === 'POST') {
      const input = JSON.parse(body);
      if (state.faults.activateReply) return send(response, state.faults.activateReply.status, state.faults.activateReply.body);
      if (state.maintenance.state !== 'recovery') return send(response, 409, { code: 'NOT_RECOVERY' });
      if (input.expectedActivatedEpoch !== state.activatedEpoch) return send(response, 409, { code: 'EPOCH_CONFLICT' });
      state.activatedEpoch = `ep_${'b'.repeat(32)}`;
      return send(response, 200, { status: 'activated', reconciledJobs: 2 });
    }
    return send(response, 404, { error: 'Not found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  return { state, origin: `http://127.0.0.1:${port}` };
}

function runCli(args, { stdin = CREDENTIALS, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: os.tmpdir(),
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      let json = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        json = null;
      }
      resolve({ code, stdout, stderr, json });
    });
    child.stdin.end(stdin);
  });
}

function assertNoSecretsOrContent(result) {
  const output = `${result.stdout}\n${result.stderr}`;
  assert.ok(!output.includes(PASSWORD), 'password printed');
  assert.ok(!output.includes(TOKEN), 'operator token printed');
  assert.ok(!/session-\d/.test(output), 'session cookie printed');
  assert.ok(!output.includes(CONTENT_MARKER), 'record content printed');
}

function backupLines(directory) {
  const chunks = readdirSync(path.join(directory, 'chunks')).sort();
  return [
    ...chunks.map((name) => readFileSync(path.join(directory, 'chunks', name), 'utf8').trim()),
    readFileSync(path.join(directory, 'manifest.json'), 'utf8').trim(),
    readFileSync(path.join(directory, 'trailer.json'), 'utf8').trim(),
  ];
}

async function exportFixture(t) {
  const source = await fakeInstallation(t);
  const out = path.join(tempDir(t, 'oi-operator-export-'), 'backup');
  const result = await runCli(['backup', 'export', '--out', out, '--origin', source.origin]);
  assert.equal(result.code, 0, result.stderr);
  return out;
}

// ---------- Credentials and arguments ----------

test('OPS-01 status signs in with stdin credentials, presents the bearer token and prints no secret', async (t) => {
  const { state, origin } = await fakeInstallation(t);
  const result = await runCli(['status', '--origin', origin]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json.maintenance.state, 'frozen');
  assert.equal(result.json.maintenance.version, 4);
  assert.equal(result.json.epoch.activated, SOURCE_EPOCH);
  const operatorCall = state.requests.find((request) => request.path === '/api/operator/status');
  assert.equal(operatorCall.authorization, `Bearer ${TOKEN}`);
  assert.equal(operatorCall.cookie, 'research-auth=session-1');
  assertNoSecretsOrContent(result);
});

test('credentials never come from argv or the environment', async (t) => {
  const { state, origin } = await fakeInstallation(t);
  const viaArgv = await runCli(['status', '--origin', origin, '--password', PASSWORD]);
  assert.equal(viaArgv.code, 2);
  const viaEnv = await runCli(['status', '--origin', origin], {
    stdin: '',
    env: { ADMIN_PASSWORD: PASSWORD, OPERATOR_TOKEN: TOKEN },
  });
  assert.equal(viaEnv.code, 2);
  assert.match(viaEnv.stderr, /stdin must be JSON/);
  const extraName = await runCli(['status', '--origin', origin], {
    stdin: JSON.stringify({ ADMIN_PASSWORD: PASSWORD, OPERATOR_TOKEN: TOKEN, SESSION_SECRET: 'x'.repeat(40) }),
  });
  assert.equal(extraName.code, 2);
  assert.equal(state.requests.length, 0);
  for (const result of [viaArgv, viaEnv, extraName]) assertNoSecretsOrContent(result);
});

test('a refused password stops before any operator call', async (t) => {
  const { state, origin } = await fakeInstallation(t);
  const result = await runCli(['status', '--origin', origin], {
    stdin: JSON.stringify({ ADMIN_PASSWORD: 'not-the-password-0000', OPERATOR_TOKEN: TOKEN }),
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /ADMIN_PASSWORD was not accepted/);
  assert.deepEqual(state.requests.map((request) => request.path), ['/api/auth']);
});

test('--origin must be https, or http only to a loopback host', async () => {
  for (const origin of ['http://research.example.org', 'https://research.example.org/path', 'https://user:pw@research.example.org']) {
    const result = await runCli(['status', '--origin', origin]);
    assert.equal(result.code, 2, origin);
  }
});

test('OPS-01 operator requests sign in again when the Worker asks for a recent sign-in', async (t) => {
  const { state, origin } = await fakeInstallation(t, { faults: { staleOnce: true } });
  const result = await runCli(['status', '--origin', origin]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(state.signIns, 2);
});

// ---------- Maintenance ----------

test('OPS-01 maintenance sends the compare-and-set inputs and reports a conflict with the current state', async (t) => {
  const { state, origin } = await fakeInstallation(t);
  const moved = await runCli([
    'maintenance', 'recovery', '--expected-state', 'frozen', '--expected-version', '4', '--classify-in-flight', '--origin', origin,
  ]);
  assert.equal(moved.code, 0, moved.stderr);
  assert.deepEqual(moved.json, { command: 'maintenance', status: 'transitioned', state: 'recovery', version: 5 });
  assert.deepEqual(state.maintenanceBodies[0], {
    expectedState: 'frozen', expectedVersion: 4, nextState: 'recovery', classifyInFlight: true,
  });

  const stale = await runCli(['maintenance', 'open', '--expected-state', 'frozen', '--expected-version', '4', '--origin', origin]);
  assert.equal(stale.code, 2);
  assert.equal(stale.json.detail.code, 'MAINTENANCE_CONFLICT');
  assert.equal(stale.json.detail.state, 'recovery');
  assert.equal(stale.json.detail.version, 5);
  assert.deepEqual(state.maintenance, { state: 'recovery', version: 5 });
});

test('OPS-01 maintenance reports a definite 503 refusal as refused (exit 2), not as an unknown outcome', async (t) => {
  const cases = [
    [{ error: 'not ready', code: 'DEPLOYMENT_NOT_READY', retryable: false }, /DEPLOYMENT_NOT_READY/],
    [{ error: 'held', code: 'WORKSPACE_HELD', retryable: false, reason: 'workspace-unavailable', holdReason: 'schema-unsupported' }, /WORKSPACE_HELD \(schema-unsupported\)/],
    [{ error: 'no binding', code: 'WORKSPACE_NOT_CONFIGURED', retryable: false }, /WORKSPACE_NOT_CONFIGURED/],
  ];
  for (const [body, message] of cases) {
    const { origin } = await fakeInstallation(t, { faults: { maintenanceReply: { status: 503, body } } });
    const result = await runCli(['maintenance', 'open', '--expected-state', 'frozen', '--expected-version', '4', '--origin', origin]);
    assert.equal(result.code, 2, body.code);
    assert.match(result.stderr, /maintenance transition refused/);
    assert.match(result.stderr, message);
    assert.equal(result.json.detail.code, body.code);
    assert.doesNotMatch(result.stderr, /outcome unknown/);
  }
});

test('OPS-01 maintenance keeps an unknown outcome or an unrecognized 5xx as exit 1 with the current status', async (t) => {
  for (const [status, body] of [[503, { error: 'unknown', code: 'OUTCOME_UNKNOWN', retryable: true }], [502, {}], [500, { code: 'INTERNAL' }]]) {
    const { origin } = await fakeInstallation(t, { faults: { maintenanceReply: { status, body } } });
    const result = await runCli(['maintenance', 'open', '--expected-state', 'frozen', '--expected-version', '4', '--origin', origin]);
    assert.equal(result.code, 1, String(status));
    assert.match(result.stderr, new RegExp(`outcome unknown \\(HTTP ${status}`));
    assert.equal(result.json.detail.status.maintenance.state, 'frozen');
  }
});

test('OPS-01 maintenance refuses to guess the expected state or version', async (t) => {
  const { state, origin } = await fakeInstallation(t);
  const missingVersion = await runCli(['maintenance', 'open', '--expected-state', 'frozen', '--origin', origin]);
  assert.equal(missingVersion.code, 2);
  const badState = await runCli(['maintenance', 'paused', '--expected-state', 'frozen', '--expected-version', '4', '--origin', origin]);
  assert.equal(badState.code, 2);
  assert.equal(state.requests.length, 0);
});

// ---------- Backup export ----------

test('OPS-02 backup export writes private chunk files, a manifest and a completion trailer that validate', async (t) => {
  const { origin } = await fakeInstallation(t);
  const out = path.join(tempDir(t, 'oi-operator-export-'), 'backup');
  const result = await runCli(['backup', 'export', '--out', out, '--origin', origin]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json.complete, true);
  assert.deepEqual(result.json.watermark, { maintenanceVersion: 4, mutationSeq: 17 });
  assert.deepEqual(result.json.counts, ROW_COUNTS);
  assertNoSecretsOrContent(result);

  const validation = await format.validateBackupLines(backupLines(out));
  assert.equal(validation.status, 'valid');
  assert.deepEqual(validation.counts, ROW_COUNTS);
  // interviews: 7 rows at 3 per page → 3 chunk files; empty families have none.
  const chunkFiles = readdirSync(path.join(out, 'chunks'));
  assert.equal(chunkFiles.filter((name) => name.includes('-interviews-')).length, 3);
  assert.equal(chunkFiles.filter((name) => name.includes('-budget_windows-')).length, 0);
  assert.equal(statSync(out).mode & 0o777, 0o700);
  for (const name of [...chunkFiles.map((file) => path.join('chunks', file)), 'manifest.json', 'trailer.json']) {
    assert.equal(statSync(path.join(out, name)).mode & 0o777, 0o600, name);
  }
  const manifest = JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8')).manifest;
  assert.equal(manifest.formatVersion, 1);
  assert.equal(manifest.sourceWorkspaceId, WORKSPACE_ID);
  assert.ok(manifest.families.every((family) => family.chunks.every((chunk) => /^[0-9a-f]{64}$/.test(chunk.sha256))));
});

test('OPS-02 an interrupted export leaves no manifest or trailer and reports the held state', async (t) => {
  const { origin } = await fakeInstallation(t, { faults: { mutateAfterPages: 3 } });
  const out = path.join(tempDir(t, 'oi-operator-export-'), 'backup');
  const result = await runCli(['backup', 'export', '--out', out, '--origin', origin]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /no completion trailer/);
  assert.equal(existsSync(path.join(out, 'trailer.json')), false);
  assert.equal(existsSync(path.join(out, 'manifest.json')), false);
  assert.equal(result.json.detail.complete, false);
  assert.equal(result.json.detail.status.maintenance.state, 'frozen');
  assert.equal(result.json.detail.code, 'WATERMARK_CHANGED');
  assertNoSecretsOrContent(result);
  const validation = await format.validateBackupLines(
    readdirSync(path.join(out, 'chunks')).sort().map((name) => readFileSync(path.join(out, 'chunks', name), 'utf8').trim()),
  );
  assert.equal(validation.status, 'rejected');
});

test('OPS-02 export refuses a directory inside the repository or a non-empty one, before any request', async (t) => {
  const { state, origin } = await fakeInstallation(t);
  const inside = path.join(ROOT, 'tmp-operator-backup-test');
  const repo = await runCli(['backup', 'export', '--out', inside, '--origin', origin]);
  assert.equal(repo.code, 2);
  assert.match(repo.stderr, /outside the repository/);
  assert.equal(existsSync(inside), false);

  const busy = tempDir(t, 'oi-operator-busy-');
  writeFileSync(path.join(busy, 'other.txt'), 'x');
  const nonEmpty = await runCli(['backup', 'export', '--out', busy, '--origin', origin]);
  assert.equal(nonEmpty.code, 2);
  assert.equal(state.requests.length, 0);
});

test('OPS-02 export refuses an installation whose record families differ from this checkout, before writing anything', async (t) => {
  const { state, origin } = await fakeInstallation(t, { families: [...format.BACKUP_FAMILY_NAMES, 'newer_family'] });
  const out = path.join(tempDir(t, 'oi-operator-export-'), 'backup');
  const result = await runCli(['backup', 'export', '--out', out, '--origin', origin]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /different set of record families/);
  assert.match(result.stderr, /Nothing was written/);
  assert.equal(result.json.detail.errorClass, 'families-mismatch');
  assert.equal(result.json.detail.complete, false);
  assert.equal(existsSync(out), false);
  assert.equal(state.requests.filter((request) => request.path === '/api/operator/backup').length, 1);
  assertNoSecretsOrContent(result);

  const reordered = await fakeInstallation(t, { families: [...format.BACKUP_FAMILY_NAMES].reverse() });
  const second = await runCli(['backup', 'export', '--out', out, '--origin', reordered.origin]);
  assert.equal(second.code, 2);
  assert.equal(existsSync(out), false);
});

test('OPS-02 export refuses an open workspace and creates nothing', async (t) => {
  const { origin } = await fakeInstallation(t, { maintenance: { state: 'open', version: 2 } });
  const out = path.join(tempDir(t, 'oi-operator-export-'), 'backup');
  const result = await runCli(['backup', 'export', '--out', out, '--origin', origin]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /frozen or recovery/);
  assert.equal(existsSync(out), false);
});

// ---------- Backup import ----------

test('OPS-02 import sends every chunk in manifest order, then finalizes with matching counts', async (t) => {
  const backup = await exportFixture(t);
  const target = await fakeInstallation(t, { maintenance: { state: 'recovery', version: 1 } });
  const result = await runCli(['backup', 'import', '--in', backup, '--origin', target.origin]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json.finalized, true);
  assert.deepEqual(result.json.counts, ROW_COUNTS);
  assert.equal(target.state.importCalls[0], 'workspace_meta:0');
  assert.equal(target.state.importCalls.at(-1), 'finalize');
  assert.deepEqual(target.state.finalized, ROW_COUNTS);
  assertNoSecretsOrContent(result);
});

test('OPS-02 import is resumable by chunk identity after an interruption', async (t) => {
  const backup = await exportFixture(t);
  const target = await fakeInstallation(t, { maintenance: { state: 'recovery', version: 1 }, faults: { importFailAt: 3 } });
  const first = await runCli(['backup', 'import', '--in', backup, '--origin', target.origin]);
  assert.equal(first.code, 1);
  assert.match(first.stderr, /re-run the same command to resume/);
  assert.equal(target.state.imported.size, 2);
  assert.equal(target.state.finalized, null);

  target.state.faults = {};
  target.state.importCalls = [];
  const second = await runCli(['backup', 'import', '--in', backup, '--origin', target.origin]);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.json.duplicates, 2);
  assert.deepEqual(target.state.finalized, ROW_COUNTS);
});

test('OPS-02 import resends the same chunk after an unknown outcome', async (t) => {
  const backup = await exportFixture(t);
  const target = await fakeInstallation(t, { maintenance: { state: 'recovery', version: 1 }, faults: { importUnknownAt: 2 } });
  const result = await runCli(['backup', 'import', '--in', backup, '--origin', target.origin]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(target.state.importCalls[1], target.state.importCalls[2]);
  assert.deepEqual(target.state.finalized, ROW_COUNTS);
});

test('OPS-02 import refuses an incomplete or corrupted backup without contacting the installation', async (t) => {
  const backup = await exportFixture(t);
  const target = await fakeInstallation(t, { maintenance: { state: 'recovery', version: 1 } });

  const incomplete = path.join(tempDir(t, 'oi-operator-incomplete-'), 'backup');
  cpSync(backup, incomplete, { recursive: true });
  rmSync(path.join(incomplete, 'trailer.json'));
  const missingTrailer = await runCli(['backup', 'import', '--in', incomplete, '--origin', target.origin]);
  assert.equal(missingTrailer.code, 2);
  assert.equal(missingTrailer.json.detail.errorClass, 'trailer-missing');

  const corrupt = path.join(tempDir(t, 'oi-operator-corrupt-'), 'backup');
  cpSync(backup, corrupt, { recursive: true });
  const name = readdirSync(path.join(corrupt, 'chunks')).find((file) => file.includes('-studies-'));
  const record = JSON.parse(readFileSync(path.join(corrupt, 'chunks', name), 'utf8'));
  record.rows[0].revision += 1;
  writeFileSync(path.join(corrupt, 'chunks', name), `${JSON.stringify(record)}\n`);
  const tampered = await runCli(['backup', 'import', '--in', corrupt, '--origin', target.origin]);
  assert.equal(tampered.code, 2);
  assert.equal(tampered.json.detail.errorClass, 'checksum-mismatch');

  const extra = path.join(tempDir(t, 'oi-operator-extra-'), 'backup');
  cpSync(backup, extra, { recursive: true });
  writeFileSync(path.join(extra, 'chunks', '99-unknown-000000.json'), '{}\n');
  const stray = await runCli(['backup', 'import', '--in', extra, '--origin', target.origin]);
  assert.equal(stray.code, 2);
  assert.equal(stray.json.detail.errorClass, 'chunk-unexpected');

  assert.equal(target.state.requests.length, 0);
  for (const result of [missingTrailer, tampered, stray]) assertNoSecretsOrContent(result);
});

test('OPS-02 import refuses a workspace that is not in recovery before sending chunks', async (t) => {
  const backup = await exportFixture(t);
  const target = await fakeInstallation(t, { maintenance: { state: 'open', version: 0 } });
  const result = await runCli(['backup', 'import', '--in', backup, '--origin', target.origin]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /needs a workspace in recovery/);
  assert.deepEqual(target.state.importCalls, []);
});

// ---------- Recovery activation ----------

test('JOB-10 recovery activate sends the expected activated epoch; a malformed epoch is refused locally', async (t) => {
  const { state, origin } = await fakeInstallation(t, { maintenance: { state: 'recovery', version: 6 } });
  const malformed = await runCli(['recovery', 'activate', '--expected-epoch', 'ep_notanepoch', '--origin', origin]);
  assert.equal(malformed.code, 2);
  assert.equal(state.requests.length, 0);

  const activated = await runCli(['recovery', 'activate', '--expected-epoch', SOURCE_EPOCH, '--origin', origin]);
  assert.equal(activated.code, 0, activated.stderr);
  assert.equal(activated.json.status, 'activated');
  assert.equal(activated.json.reconciledJobs, 2);

  const stale = await runCli(['recovery', 'activate', '--expected-epoch', SOURCE_EPOCH, '--origin', origin]);
  assert.equal(stale.code, 2);
  assert.equal(stale.json.detail.code, 'EPOCH_CONFLICT');
});

test('JOB-10 recovery activate maps a held workspace to refused (exit 2) and an unknown outcome to exit 1', async (t) => {
  const held = await fakeInstallation(t, {
    maintenance: { state: 'recovery', version: 6 },
    faults: { activateReply: { status: 503, body: { code: 'WORKSPACE_HELD', reason: 'workspace-unavailable', holdReason: 'workspace-identity-mismatch' } } },
  });
  const refused = await runCli(['recovery', 'activate', '--expected-epoch', SOURCE_EPOCH, '--origin', held.origin]);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /activation refused \(HTTP 503 WORKSPACE_HELD \(workspace-identity-mismatch\)\)/);
  assert.equal(refused.json.detail.holdReason, 'workspace-identity-mismatch');

  const lost = await fakeInstallation(t, {
    maintenance: { state: 'recovery', version: 6 },
    faults: { activateReply: { status: 503, body: { code: 'OUTCOME_UNKNOWN', retryable: true } } },
  });
  const unknown = await runCli(['recovery', 'activate', '--expected-epoch', SOURCE_EPOCH, '--origin', lost.origin]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /activation outcome unknown/);
  assert.equal(unknown.json.detail.status.maintenance.state, 'recovery');
});
