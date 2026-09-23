#!/usr/bin/env node
// Restart-lane runtime (VERIFY-01). Runs the prebuilt production Worker from
// dist/cloudflare/artifact in local workerd through wrangler's
// unstable_startWorker, with Durable Object, alarm and Queue state persisted in
// a directory the calling test owns. The test SIGKILLs this process's whole
// group and starts a new runner on the same directory, so every durable claim
// it makes is observed across a real process restart.
//
// createTestHarness cannot do this: its resolveWorkerInputs forces
// `dev.persist: false`. This runner builds the same inputs by hand (prebuilt
// bundle: `no_bundle`, `find_additional_modules`, `base_dir`, no build
// command; synthetic secret bindings; an outbound service) and sets
// `dev.persist` to <state>/persist.
//
// Outbound Worker requests reach `outboundService` in this process: only the
// synthetic OpenAI Responses fixture answers; any other destination is refused
// (HTTP 599) and recorded. Every outbound call is appended synchronously to
// <state>/events.jsonl before it is answered, so a SIGKILL cannot lose the
// record of a request the fixture already received.
//
// Clients reach the Worker through a small HTTP proxy in this process (the
// same pattern as tests/e2e-cloudflare/server.mjs). It records each request's
// method and path (never the query, which can carry a link code). On request
// it marks one participant save cut: once the Worker has produced the save
// reply (so the object has decided), the proxy freezes the runtime's child
// processes with SIGSTOP and then either forwards the reply
// (`freeze-after-save-reply`) or keeps it from the client
// (`hold-save-reply`). The freeze pins the cut against scheduling jitter: the
// test's SIGKILL lands on a runtime that did nothing after the reply, exactly
// as if it had died at that instant.
//
// The control channel is a separate HTTP server in this process, never in the
// Worker: GET /state, POST /hold-synthesis, POST /release-synthesis,
// POST /hold-save-reply, POST /freeze-after-save-reply. Hold and freeze
// notices are also printed on stdout.
//
// `--worker txprobe` runs the restart lane's transaction probe instead
// (txProbe.worker.js, bundled from source, no secrets): its only outbound
// request, to restart-probe.invalid, is held open so the test can kill the
// runtime inside an uncommitted transaction.
//
// Usage: node tests/cloudflare-restart/runner.mjs --state <dir> --runtime <label>
//          [--worker artifact|txprobe] [--hold-synthesis]

import { execFileSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { scrubCredentials, scrubNotice } from '../../scripts/cloudflare/credential-env.mjs';
import { GREETING, SYNTHESIS } from '../e2e-cloudflare/fixtureData.mjs';
import { FAILED_PREFIX, HELD_PREFIX, READY_PREFIX, SECRETS, SERVED_MODEL } from './synthetic.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ARTIFACT_WORKER_DIR = path.join(ROOT, 'dist/cloudflare/artifact/worker');
const CONFIG = path.join(ROOT, 'cloudflare/test/wrangler.artifact.jsonc');
const TXPROBE_CONFIG = path.join(ROOT, 'tests/cloudflare-restart/wrangler.txprobe.jsonc');

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function refuse(reason) {
  process.stdout.write(`${FAILED_PREFIX}${JSON.stringify({ reason })}\n`);
  process.exit(2);
}

const stateDir = argument('--state');
const runtime = argument('--runtime') ?? 'runtime';
const workerKind = argument('--worker') ?? 'artifact';
if (workerKind !== 'artifact' && workerKind !== 'txprobe') refuse('--worker must be artifact or txprobe');
if (!stateDir || !path.isAbsolute(stateDir) || !existsSync(stateDir) || !statSync(stateDir).isDirectory()) {
  refuse('--state must name an existing absolute directory owned by the caller');
}
if (workerKind === 'artifact' && !existsSync(path.join(ARTIFACT_WORKER_DIR, 'worker.js'))) {
  refuse('no artifact; run npm run build:cloudflare');
}

// VERIFY-01: no inherited provider/cloud credentials. The test spawns this
// runner with an allowlisted environment; as a backstop for a direct run,
// credential-like variables are removed (shared rule, credential-env.mjs)
// before wrangler is loaded.
const scrubbed = scrubCredentials(process.env);
if (scrubbed.length > 0) process.stderr.write(`${scrubNotice('restart runner', scrubbed)}\n`);
const { unstable_readConfig, unstable_startWorker } = await import('wrangler');

const persistDir = path.join(stateDir, 'persist');
const workDir = path.join(stateDir, 'wrangler');
mkdirSync(persistDir, { recursive: true });
mkdirSync(workDir, { recursive: true });
const eventsPath = path.join(stateDir, 'events.jsonl');

function record(kind, detail) {
  appendFileSync(eventsPath, `${JSON.stringify({ at: Date.now(), runtime, pid: process.pid, kind, ...detail })}\n`);
}

// ---------- Synthetic OpenAI Responses fixture ----------

const fixture = {
  holdSynthesis: process.argv.includes('--hold-synthesis'),
  heldReleases: [],
  /** null, 'hold' (never forward) or 'forward' (forward, then stay frozen). */
  saveCut: null,
  calls: [],
  refused: [],
};

// Same classification as tests/e2e-cloudflare/server.mjs: the structured
// output schema names the operation.
function operationOf(body) {
  const properties = body?.text?.format?.schema?.properties ?? {};
  if ('statedPreferences' in properties) return 'synthesis';
  if ('shouldConclude' in properties || 'message' in properties) return 'interview';
  if ('commonThemes' in properties) return 'aggregate';
  return 'greeting';
}

const INTERVIEW_TURN = {
  message: 'Thank you. That completes our conversation.',
  questionAddressed: 0,
  phaseTransition: 'wrap-up',
  profileUpdates: [],
  shouldConclude: true,
};

async function openAiResponse(request) {
  const body = await request.json();
  const operation = operationOf(body);
  const call = { operation, model: body.model, keyPresented: request.headers.get('authorization') === `Bearer ${SECRETS.OPENAI_API_KEY}` };
  fixture.calls.push(call);
  // Durable before the Worker can observe any reply.
  record('outbound', call);
  if (operation === 'synthesis' && fixture.holdSynthesis) {
    record('held', { operation });
    process.stdout.write(`${HELD_PREFIX}${JSON.stringify({ what: 'synthesis' })}\n`);
    await new Promise((resolve) => fixture.heldReleases.push(resolve));
  }
  const text = operation === 'greeting'
    ? GREETING
    : JSON.stringify(operation === 'synthesis' ? SYNTHESIS : INTERVIEW_TURN);
  return Response.json({
    id: 'resp_synthetic',
    object: 'response',
    created_at: 1,
    status: 'completed',
    model: SERVED_MODEL,
    output: [{ type: 'message', id: 'msg_synthetic', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }],
    usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
  });
}

async function outboundService(request) {
  const url = new URL(request.url);
  if (workerKind === 'artifact' && request.method === 'POST' && url.origin === 'https://api.openai.com' && url.pathname === '/v1/responses') {
    return openAiResponse(request);
  }
  if (workerKind === 'txprobe' && url.origin === 'https://restart-probe.invalid' && url.pathname === '/hold') {
    record('held', { operation: 'probe-transaction' });
    process.stdout.write(`${HELD_PREFIX}${JSON.stringify({ what: 'probe-transaction' })}\n`);
    return new Promise(() => {});
  }
  const refused = { method: request.method, url: `${url.origin}${url.pathname}` };
  fixture.refused.push(refused);
  record('refused', refused);
  return new Response('refused by the restart-lane outbound guard', { status: 599 });
}

// ---------- Worker inputs (createTestHarness's prebuilt derivation, persisted) ----------

// Wrangler derives its project root (the .wrangler/tmp scratch directory)
// and the .dev.vars/.env lookup directory from `userConfigPath`. Pointing it
// into the caller's state directory keeps both inside a directory the test
// removes, and guarantees no repository dotenv file is read.
const userConfigPath = path.join(workDir, 'wrangler.jsonc');
let config;
const bindings = {};
if (workerKind === 'artifact') {
  const fileConfig = unstable_readConfig({ config: CONFIG });
  config = {
    ...fileConfig,
    main: path.join(ARTIFACT_WORKER_DIR, 'worker.js'),
    base_dir: ARTIFACT_WORKER_DIR,
    no_bundle: true,
    find_additional_modules: true,
    build: { ...fileConfig.build, command: undefined },
    userConfigPath,
  };
  for (const [name, value] of Object.entries(SECRETS)) bindings[name] = { type: 'secret_text', value };
} else {
  config = { ...unstable_readConfig({ config: TXPROBE_CONFIG }), userConfigPath };
}

let worker;
try {
  worker = await unstable_startWorker({
    config,
    bindings,
    sendMetrics: false,
    dev: {
      auth: () => {
        throw new Error('the restart lane never uses a Cloudflare account');
      },
      server: { hostname: '127.0.0.1', port: 0 },
      inspector: false,
      watch: false,
      logLevel: 'none',
      persist: persistDir,
      registry: undefined,
      remote: false,
      inferOriginFromRoutes: false,
      routeRequestsByRoutes: true,
      outboundService,
      structuredLogsHandler: (log) => record('log', { level: log.level, message: String(log.message).slice(0, 2_000) }),
    },
  });
  await worker.ready;
} catch (error) {
  refuse(`worker failed to start: ${error instanceof Error ? error.message : String(error)}`);
}
const workerUrl = String(await worker.url);

// wrangler's esbuild service and the two workerd processes it started.
let runtimePids = [];
try {
  runtimePids = execFileSync('pgrep', ['-P', String(process.pid)]).toString().trim().split('\n').filter(Boolean).map(Number);
} catch {
  runtimePids = [];
}

function freezeRuntime(reason) {
  for (const pid of runtimePids) {
    try {
      process.kill(pid, 'SIGSTOP');
    } catch {
      // Already gone.
    }
  }
  record('frozen', { reason, processes: runtimePids.length });
}

// ---------- Client proxy (this process only) ----------

const HOP_BY_HOP = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'content-length']);

const proxy = http.createServer(async (req, res) => {
  const incoming = new URL(req.url ?? '/', 'http://proxy');
  record('request', { method: req.method, path: incoming.pathname });
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  try {
    const upstream = await fetch(new URL(incoming.pathname + incoming.search, workerUrl), {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : Buffer.concat(chunks),
      redirect: 'manual',
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    const cut = req.method === 'POST' && incoming.pathname === '/api/interviews/save' ? fixture.saveCut : null;
    if (cut) {
      // The Worker has answered, so the object has decided.
      fixture.saveCut = null;
      freezeRuntime(`save-reply-${cut}`);
    }
    if (cut === 'hold') {
      // The client never reads this outcome; the test kills this process.
      record('reply-held', { path: incoming.pathname, status: upstream.status });
      process.stdout.write(`${HELD_PREFIX}${JSON.stringify({ what: 'save-reply', status: upstream.status })}\n`);
      await new Promise(() => {});
    }
    const outHeaders = {};
    upstream.headers.forEach((value, name) => {
      if (name === 'set-cookie' || name === 'content-encoding' || HOP_BY_HOP.has(name)) return;
      outHeaders[name] = value;
    });
    const cookies = upstream.headers.getSetCookie();
    if (cookies.length > 0) outHeaders['set-cookie'] = cookies;
    res.writeHead(upstream.status, outHeaders);
    res.end(body);
    if (cut === 'forward') {
      record('reply-forwarded', { path: incoming.pathname, status: upstream.status });
      process.stdout.write(`${HELD_PREFIX}${JSON.stringify({ what: 'save-reply-forwarded', status: upstream.status })}\n`);
    }
  } catch (error) {
    res.destroy(error instanceof Error ? error : new Error('upstream failed'));
  }
});
await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
const clientUrl = `http://127.0.0.1:${proxy.address().port}/`;

// ---------- Control channel (this process only) ----------

const control = http.createServer((req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const { pathname } = new URL(req.url ?? '/', 'http://control');
  if (req.method === 'GET' && pathname === '/state') {
    return send(200, { runtime, pid: process.pid, calls: fixture.calls, refused: fixture.refused, heldSynthesis: fixture.heldReleases.length });
  }
  if (req.method === 'POST' && pathname === '/hold-synthesis') {
    fixture.holdSynthesis = true;
    return send(200, { ok: true });
  }
  if (req.method === 'POST' && pathname === '/release-synthesis') {
    fixture.holdSynthesis = false;
    const released = fixture.heldReleases.splice(0);
    for (const release of released) release();
    return send(200, { released: released.length });
  }
  if (req.method === 'POST' && (pathname === '/hold-save-reply' || pathname === '/freeze-after-save-reply')) {
    fixture.saveCut = pathname === '/hold-save-reply' ? 'hold' : 'forward';
    return send(200, { ok: true, processes: runtimePids.length });
  }
  return send(404, { error: 'unknown control' });
});
await new Promise((resolve) => control.listen(0, '127.0.0.1', resolve));
const controlUrl = `http://127.0.0.1:${control.address().port}`;

record('ready', { workerUrl: clientUrl, controlUrl });
process.stdout.write(`${READY_PREFIX}${JSON.stringify({ runtime, pid: process.pid, workerUrl: clientUrl, controlUrl })}\n`);

// A graceful stop is only for manual use; the lane always SIGKILLs.
const shutdown = async () => {
  proxy.close();
  control.close();
  await worker.dispose().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
