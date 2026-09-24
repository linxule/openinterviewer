// Test sandbox for scripts/cloudflare/setup.mjs: a temporary directory with
// a simulated Cloudflare account (fake wrangler/deploy/git sharing one JSON
// state file), a fixture release artifact and a local fake origin server that
// also answers the Cloudflare API's AI Gateway routes and the gateway
// endpoint. No credentials, no network beyond 127.0.0.1.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROOT, parseJsonc, sha256File, sha256Tree } from '../../scripts/cloudflare/lib.mjs';
import { digest, initialState, readState, writeState } from './fixtures/fake-state.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Child environment values recorded by the fakes (exempt from file scans). */
export const ENV_CAPTURE = 'captured-child-env.ndjson';
const FIXTURES = path.join(HERE, 'fixtures');
export const SETUP = path.join(ROOT, 'scripts', 'cloudflare', 'setup.mjs');

export const PASSWORD = 'correct-horse-battery-staple-17';
export const PROVIDER_KEY = 'AIzaFixtureProviderKey-0123456789';
/** Synthetic AI Gateway credentials: the management token (process env only) and a Run token. */
export const ADMIN_TOKEN = 'fixture-cf-admin-token-0123456789abcdefghij';
export const RUN_TOKEN = 'fixture-aig-run-token-0123456789abcdefghijkl';

export function stdinSecrets(overrides = {}) {
  return JSON.stringify({ ADMIN_PASSWORD: PASSWORD, GEMINI_API_KEY: PROVIDER_KEY, ...overrides });
}

export function buildArtifact(artifactDir, commit, { status = 'passed' } = {}) {
  rmSync(artifactDir, { recursive: true, force: true });
  mkdirSync(path.join(artifactDir, 'worker'), { recursive: true });
  mkdirSync(path.join(artifactDir, 'assets'), { recursive: true });
  writeFileSync(path.join(artifactDir, 'worker', 'worker.js'), `export default {}; // ${commit}\n`);
  writeFileSync(path.join(artifactDir, 'assets', 'index.txt'), 'fixture asset\n');
  const worker = sha256Tree(path.join(artifactDir, 'worker'));
  const assets = sha256Tree(path.join(artifactDir, 'assets'));
  const manifest = {
    formatVersion: 1,
    source: { commit, dirty: false },
    lockfileSha256: sha256File(path.join(ROOT, 'package-lock.json')),
    templateConfigSha256: sha256File(path.join(ROOT, 'wrangler.jsonc')),
    artifact: { main: 'worker.js', workerSha256: worker.sha256, assetsSha256: assets.sha256 },
  };
  writeFileSync(path.join(artifactDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    path.join(artifactDir, 'receipt.json'),
    `${JSON.stringify({ status, source: { commit }, artifact: { workerSha256: worker.sha256 } }, null, 2)}\n`,
  );
}

const PROVIDER_KEYS = { gemini: 'GEMINI_API_KEY', claude: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', openrouter: 'OPENROUTER_API_KEY' };

/**
 * Simulates the public readiness endpoints of a deployed installation from
 * the fake account state, including F2 bootstrap semantics: a fresh
 * workspace object initializes on the first readiness call only while
 * WORKSPACE_BOOTSTRAP is open|recovery.
 */
function simulate(state, origin, pathname) {
  const host = new URL(origin).hostname;
  const entry = Object.entries(state.workers).find(([name, worker]) => !worker.draft && (
    host === `${name}.${state.subdomain}.workers.dev`
    || (worker.vars?.APP_BASE_URL && new URL(worker.vars.APP_BASE_URL).hostname === host)
  ));
  if (!entry) return { status: 404, body: { error: 'no worker routed for this host' } };
  const [name, worker] = entry;
  const vars = worker.vars ?? {};
  const errors = [];
  if (!vars.APP_BASE_URL) errors.push('missing_app_base_url');
  for (const [secret, code] of [
    ['ADMIN_PASSWORD', 'missing_admin_password'],
    ['SESSION_SECRET', 'missing_session_secret'],
    ['PARTICIPANT_TOKEN_SECRET', 'missing_participant_token_secret'],
    ['RATE_LIMIT_SALT', 'missing_rate_limit_salt'],
  ]) if (!worker.secrets[secret]) errors.push(code);
  const key = PROVIDER_KEYS[vars.AI_PROVIDER];
  if (!key || !worker.secrets[key]) errors.push('missing_ai_provider_key');
  // RT-11 route rules (src/lib/providers/endpoint.ts providerRouteErrors).
  const transport = vars.AI_TRANSPORT || 'direct';
  if (transport === 'cloudflare-gateway') {
    if (!/^[a-f0-9]{32}$/.test(vars.CF_AI_GATEWAY_ACCOUNT_ID ?? '')) errors.push('invalid_cf_ai_gateway_account_id');
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(vars.CF_AI_GATEWAY_ID ?? '') || vars.CF_AI_GATEWAY_ID === 'default') errors.push('invalid_cf_ai_gateway_id');
    if (!worker.secrets.CF_AI_GATEWAY_TOKEN) errors.push('missing_cf_ai_gateway_token');
  } else if (transport !== 'direct') errors.push('invalid_ai_transport');
  else if (vars.CF_AI_GATEWAY_ACCOUNT_ID || vars.CF_AI_GATEWAY_ID) errors.push('cf_ai_gateway_config_without_transport');
  if (!/^ws_[a-f0-9]{32}$/.test(vars.WORKSPACE_ID ?? '')) errors.push('invalid_workspace_id');
  if (!worker.secrets.ANALYSIS_RECOVERY_EPOCH) errors.push('invalid_analysis_recovery_epoch');
  errors.push(...(state.http.extraErrors ?? []));
  const configuration = errors.length === 0;
  // `workspaceErrors`: codes the workspace object reports on successive
  // probes (one per /api/health/ready, which each probe requests first) before
  // it answers normally, e.g. the version from before the secret upload.
  if (pathname === '/api/health/ready') state.http.currentWorkspaceError = (state.http.workspaceErrors ?? []).shift() ?? null;
  const injected = state.http.currentWorkspaceError ?? null;
  let workspaceError = null;
  if (configuration && injected) workspaceError = injected;
  else if (configuration) {
    const objectKey = `${name}|${vars.WORKSPACE_ID}|${vars.WORKSPACE_JURISDICTION}`;
    let object = state.objects[objectKey];
    if (!object && ['open', 'recovery'].includes(vars.WORKSPACE_BOOTSTRAP)) {
      object = { maintenance: vars.WORKSPACE_BOOTSTRAP, bootstrap: vars.WORKSPACE_BOOTSTRAP, initializedAt: new Date().toISOString() };
      state.objects[objectKey] = object;
    }
    if (state.http.forceNotReady) workspaceError = 'workspace_unavailable';
    else if (!object) workspaceError = 'workspace_uninitialized';
    else if (object.maintenance !== 'open') workspaceError = 'workspace_maintenance';
  }
  const ready = configuration && !workspaceError;
  const publicErrors = configuration ? (workspaceError ? [workspaceError] : []) : errors;
  const view = { mode: 'standalone', aiTransport: transport, oauth: { google: false, github: false }, ready, errors: publicErrors, analysisExecution: 'queued-v2' };
  if (pathname === '/api/health/ready') {
    return {
      status: ready ? 200 : 503,
      body: { ready, mode: 'standalone', target: 'cloudflare', checks: { configuration, workspaceStore: configuration && !workspaceError, analysisQueue: true } },
    };
  }
  if (pathname === '/api/config/readiness') return { status: 200, body: view };
  if (pathname === '/api/config/mode') return { status: 200, body: view };
  return { status: 404, body: { error: 'not found' } };
}

const API_ORIGIN = 'https://api.cloudflare.com';
const GATEWAY_ORIGIN = 'https://gateway.ai.cloudflare.com';

/**
 * One-shot failure of the fake Cloudflare API for `at` ('get', 'create',
 * 'logs'); `skip: n` lets n matching calls pass first.
 */
function takeApiFailure(state, at) {
  const index = state.gatewayApi.failures.findIndex((entry) => entry.at === at);
  if (index < 0) return null;
  const entry = state.gatewayApi.failures[index];
  if (entry.skip > 0) {
    entry.skip -= 1;
    return null;
  }
  return state.gatewayApi.failures.splice(index, 1)[0];
}

const apiError = (status, code) => ({ status, body: { success: false, errors: [{ code, message: `fixture error ${code}` }], messages: [], result: null } });

/**
 * The Cloudflare API's AI Gateway routes (GET/POST gateways, GET logs), as
 * documented in the API reference. Records every call (method, path, whether
 * the management token matched, and a POST body, which holds no secret).
 * PUT, PATCH and DELETE are recorded and refused: the installer must never send them.
 */
function simulateApi(state, request, body) {
  const url = new URL(request.url, API_ORIGIN);
  const match = /^\/client\/v4\/accounts\/([^/]+)\/ai-gateway\/gateways(?:\/([^/]+)(\/logs)?)?$/.exec(url.pathname);
  const presented = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
  const tokenOk = state.gatewayApi.adminTokenDigest !== null && digest(presented) === state.gatewayApi.adminTokenDigest;
  const call = { method: request.method, path: url.pathname, query: url.search, authorized: tokenOk };
  if (request.method === 'POST') call.body = JSON.parse(body || 'null');
  state.gatewayApi.calls.push(call);
  if (!match) return apiError(404, 7000);
  if (!tokenOk) return apiError(403, 10000);
  const [, account, id, logs] = match;
  if (!state.accounts.some((entry) => entry.id === account)) return apiError(403, 10000);
  const key = `${account}/${id}`;
  if (request.method === 'GET') {
    const failure = takeApiFailure(state, logs ? 'logs' : 'get');
    if (failure) return apiError(failure.status ?? 503, 99999);
    const gateway = state.gateways[`${account}/${id}`];
    if (!gateway) return apiError(404, 7002);
    if (logs) {
      const total = state.gatewayApi.logCounts[key] ?? 0;
      return { status: 200, body: { success: true, result: [], result_info: { page: 1, per_page: 1, count: Math.min(total, 1), total_count: total } } };
    }
    return { status: 200, body: { success: true, errors: [], messages: [], result: gateway } };
  }
  if (request.method === 'POST' && !id) {
    const input = call.body ?? {};
    const failure = takeApiFailure(state, 'create');
    if (failure?.when === 'before') return apiError(503, 99999);
    const gatewayKey = `${account}/${input.id}`;
    if (state.gateways[gatewayKey]) return apiError(409, 7001);
    const at = new Date().toISOString();
    // Response fields of the API reference that a new gateway reports unset.
    state.gateways[gatewayKey] = {
      ...input,
      created_at: at,
      modified_at: at,
      is_default: false,
      logpush: false,
      rate_limiting_technique: 'fixed',
      store_id: null,
      workers_ai_billing_mode: 'postpaid',
      ...state.gatewayApi.createOverrides,
    };
    if (failure?.when === 'after') return { status: 0 };
    return { status: 200, body: { success: true, errors: [], messages: [], result: state.gateways[gatewayKey] } };
  }
  return apiError(405, 7003);
}

/**
 * The gateway endpoint, as the design expects it to answer a request with no
 * provider credential (gw-final §5; the exact bodies are a remote gate):
 * without a valid Run token 401 AiGatewayError 2009; with one, 400
 * AiGatewayError because a provider key is required. A request carrying a
 * provider credential would be a provider call: it is recorded as such.
 */
function simulateGateway(state, request) {
  const url = new URL(request.url, GATEWAY_ORIGIN);
  const [, version, account, id] = url.pathname.split('/');
  const headers = request.headers;
  const cfAig = Object.fromEntries(Object.entries(headers).filter(([name]) => name.startsWith('cf-aig-')).map(([name, value]) => [name, name === 'cf-aig-authorization' ? 'redacted' : value]));
  const presented = /^Bearer (.+)$/.exec(headers['cf-aig-authorization'] ?? '')?.[1] ?? null;
  const providerCredential = Boolean(headers.authorization || headers['x-api-key'] || headers['x-goog-api-key']);
  state.gatewayApi.probes.push({ path: url.pathname, method: request.method, cfAig, tokenPresented: presented !== null, providerCredential });
  const gatewayError = (status, internalCode, message) => ({ status, body: { success: false, result: [], messages: [], name: 'AiGatewayError', httpCode: status, internalCode, message } });
  if (state.gatewayApi.probeOverride) return state.gatewayApi.probeOverride;
  const gateway = version === 'v1' ? state.gateways[`${account}/${id}`] : null;
  if (!gateway) return gatewayError(404, 2001, 'Gateway not found');
  if (gateway.authentication && (presented === null || !state.gatewayApi.runTokenDigests.includes(digest(presented)))) return gatewayError(401, 2009, 'Unauthorized');
  if (providerCredential) return { status: 599, body: { error: 'fixture: this request carried a provider credential' } };
  return gatewayError(400, 2021, 'Provider credentials required');
}

async function startOrigin(stateFile) {
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const state = readState(stateFile);
    const origin = request.headers['x-fake-origin'];
    if (origin === API_ORIGIN || origin === GATEWAY_ORIGIN) {
      const result = origin === API_ORIGIN ? simulateApi(state, request, body) : simulateGateway(state, request);
      writeState(state, stateFile);
      if (result.status === 0) {
        request.socket.destroy();
        return;
      }
      response.writeHead(result.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result.body));
      return;
    }
    state.http.requests.push({ origin, path: request.url });
    // `down`: nothing answers; `unroutedHosts`: a custom domain not yet attached.
    if (state.http.down || (state.http.unroutedHosts ?? []).includes(new URL(origin).hostname)) {
      writeState(state, stateFile);
      request.socket.destroy();
      return;
    }
    const result = simulate(state, origin, new URL(request.url, 'http://fake').pathname);
    writeState(state, stateFile);
    response.writeHead(result.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result.body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function wrapper(file, target, stateFile, capture) {
  writeFileSync(
    file,
    [
      `process.env.FAKE_WRANGLER_STATE = ${JSON.stringify(stateFile)};`,
      `process.env.FAKE_WRANGLER_CAPTURE = ${JSON.stringify(capture)};`,
      `process.env.FAKE_WRANGLER_ENV_CAPTURE = ${JSON.stringify(path.join(path.dirname(capture), ENV_CAPTURE))};`,
      `await import(${JSON.stringify(pathToFileURL(target).href)});`,
      '',
    ].join('\n'),
  );
}

export async function createSandbox(t, { state: overrides = {} } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'oi-setup-'));
  const stateFile = path.join(dir, 'fake-account.json');
  const capture = path.join(dir, 'captured-secret-values.ndjson');
  const stateDir = path.join(dir, 'installations');
  const artifactDir = path.join(dir, 'artifact');
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  writeState(initialState(overrides), stateFile);
  wrapper(path.join(bin, 'wrangler.mjs'), path.join(FIXTURES, 'fake-wrangler.mjs'), stateFile, capture);
  wrapper(path.join(bin, 'deploy.mjs'), path.join(FIXTURES, 'fake-deploy.mjs'), stateFile, capture);
  wrapper(path.join(bin, 'git.mjs'), path.join(FIXTURES, 'fake-git.mjs'), stateFile, capture);
  buildArtifact(artifactDir, readState(stateFile).git.commit);
  const origin = await startOrigin(stateFile);
  t.after(async () => {
    await origin.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const sandbox = {
    dir,
    stateFile,
    stateDir,
    artifactDir,
    tokenFile: path.join(dir, 'operator-token.txt'),
    state: () => readState(stateFile),
    update(mutate) {
      const state = readState(stateFile);
      mutate(state);
      writeState(state, stateFile);
    },
    installDir: (install = 'acme', env = 'production') => path.join(stateDir, `${install}-${env}`),
    receipt(install = 'acme', env = 'production') {
      return JSON.parse(readFileSync(path.join(sandbox.installDir(install, env), 'receipt.json'), 'utf8'));
    },
    config(install = 'acme', env = 'production') {
      return parseJsonc(readFileSync(path.join(sandbox.installDir(install, env), 'wrangler.jsonc'), 'utf8'));
    },
    capturedEnv() {
      try {
        return readFileSync(path.join(dir, ENV_CAPTURE), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
    capturedSecrets() {
      try {
        return readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
    newCommit(commit) {
      sandbox.update((state) => { state.git.commit = commit; });
      buildArtifact(artifactDir, commit);
    },
    run(command, args = [], { input, extraArgs = true, env: extraEnv = {} } = {}) {
      const defaults = extraArgs
        ? [
          '--state-dir', stateDir,
          '--wrangler', path.join(bin, 'wrangler.mjs'),
          '--deploy-script', path.join(bin, 'deploy.mjs'),
          '--git', path.join(bin, 'git.mjs'),
          '--artifact-dir', artifactDir,
          '--wait-seconds', '1',
        ]
        : [];
      const env = { PATH: process.env.PATH, HOME: dir, TMPDIR: process.env.TMPDIR ?? os.tmpdir(), FAKE_HTTP_BASE: origin.url, ...extraEnv };
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', pathToFileURL(path.join(FIXTURES, 'fetch-preload.mjs')).href, SETUP, command, ...args, ...defaults], {
          cwd: ROOT,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout, stderr, output: `${stdout}\n${stderr}` }));
        child.stdin.end(input ?? '');
      });
    },
  };
  return sandbox;
}

export function applyArgs(sandbox, { install = 'acme', env = 'production', provider = 'gemini', jurisdiction = 'eu', extra = [] } = {}) {
  return [
    '--install', install,
    '--env', env,
    '--provider', provider,
    '--jurisdiction', jurisdiction,
    '--operator-token-file', sandbox.tokenFile,
    '--secrets-stdin',
    '--yes',
    ...extra,
  ];
}

/** Every file under a directory, recursively (for secret-leak scans). */
export function filesUnder(dir) {
  const files = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(dir);
  return files;
}

/** Every secret name an installation binds with the Gemini provider. */
export const ALL_SECRET_NAMES = [
  'ADMIN_PASSWORD',
  'ANALYSIS_RECOVERY_EPOCH',
  'GEMINI_API_KEY',
  'OPERATOR_TOKEN',
  'PARTICIPANT_TOKEN_SECRET',
  'RATE_LIMIT_SALT',
  'SESSION_SECRET',
];

/**
 * No secret value (supplied, generated or uploaded) may appear in any file
 * the installer or the fakes wrote, in run output, in any child's argv, or
 * in any child's environment under any variable name, even as a substring.
 * Secret names may not appear as child environment variable names either.
 */
export function assertNoSecretLeak(sandbox, runs, extraValues = []) {
  const values = new Set([PASSWORD, PROVIDER_KEY, ADMIN_TOKEN, RUN_TOKEN, ...extraValues]);
  for (const upload of sandbox.capturedSecrets()) for (const value of Object.values(upload)) values.add(value);
  const exempt = new Set([path.join(sandbox.dir, 'captured-secret-values.ndjson'), path.join(sandbox.dir, ENV_CAPTURE), sandbox.tokenFile]);
  const texts = filesUnder(sandbox.dir)
    .filter((file) => !exempt.has(file) && !path.basename(file).startsWith('operator-token'))
    .map((file) => [file, readFileSync(file, 'utf8')]);
  for (const run of runs) texts.push(['run output', run.output]);
  for (const entry of sandbox.state().invocations) texts.push([`${entry.tool} argv`, entry.argv.join(' ')]);
  for (const value of values) {
    for (const [where, text] of texts) assert.ok(!text.includes(value), `a secret value leaked into ${where}`);
  }
  const secretNames = new Set([...ALL_SECRET_NAMES, ...Object.values(PROVIDER_KEYS), 'CF_AI_GATEWAY_TOKEN', 'CF_AI_GATEWAY_ADMIN_TOKEN']);
  for (const entry of sandbox.state().invocations) {
    for (const name of entry.env) assert.ok(!secretNames.has(name), `${entry.tool} received ${name} in its environment`);
  }
  const children = sandbox.capturedEnv();
  assert.equal(children.length, sandbox.state().invocations.length, 'every child environment was captured');
  for (const child of children) {
    for (const value of values) {
      assert.ok(!child.values.some((envValue) => envValue.includes(value)), `${child.tool} ${child.argv.join(' ')} received a secret value in its environment`);
    }
  }
}

/** Common arguments for resume (credentials only matter while the secrets phase is pending). */
export function resumeArgs(sandbox, extra = []) {
  return ['--install', 'acme', '--env', 'production', '--operator-token-file', sandbox.tokenFile, '--secrets-stdin', '--yes', ...extra];
}

/** Mutating fake-account invocations and Cloudflare API calls (anything that changes remote state). */
export function mutations(state) {
  return [
    ...state.invocations.filter((entry) => entry.tool === 'deploy'
      || (entry.tool === 'wrangler' && ((entry.argv[0] === 'queues' && entry.argv[1] === 'create') || (entry.argv[0] === 'secret' && entry.argv[1] === 'bulk')))),
    ...(state.gatewayApi?.calls ?? []).filter((call) => call.method !== 'GET'),
  ];
}
