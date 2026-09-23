#!/usr/bin/env node
// Cloudflare production-artifact browser harness (VERIFY-02/03).
//
// Runs the prebuilt Worker bundle from dist/cloudflare/artifact inside local
// workerd through wrangler's createTestHarness — real OpenNext fetch, real
// WorkspaceStore SQLite, real alarms and a real local Queue consumer — and
// exposes it on a fixed port for Playwright. Outbound Worker requests are
// proxied through this Node process: only the synthetic OpenAI Responses
// fixture answers; everything else (including any *.upstash.io request) is
// recorded and refused. Test-only control endpoints live under /__fixture/ on
// this proxy, never in the deployable Worker.
//
// Usage: node tests/e2e-cloudflare/server.mjs <port>

import http from 'node:http';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { scrubCredentials, scrubNotice } from '../../scripts/cloudflare/credential-env.mjs';
import { AGGREGATE, GREETING, SYNTHESIS } from './fixtureData.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.argv[2] || 3200);
const ARTIFACT_WORKER_DIR = path.join(ROOT, 'dist/cloudflare/artifact/worker');
const CONFIG = path.join(ROOT, 'cloudflare/test/wrangler.artifact.jsonc');

// VERIFY-01: no inherited provider or cloud credential reaches wrangler, the
// runtime or a fixture. They are removed from this process's environment
// before wrangler is loaded (the shared rule in credential-env.mjs); the
// Worker receives only the synthetic secrets below.
const scrubbed = scrubCredentials(process.env);
if (scrubbed.length > 0) console.error(scrubNotice('cloudflare e2e server', scrubbed));

if (!existsSync(ARTIFACT_WORKER_DIR)) {
  console.error('Build the Cloudflare artifact first: npm run build:cloudflare');
  process.exit(2);
}
const { createTestHarness } = await import('wrangler');

// Queued synthesis outcomes, consumed in arrival order by the next synthesis
// requests: 'reject' is a known provider failure (HTTP 400 before generation);
// 'server-error' is HTTP 500 after the request was received, which the queued
// policy records as recovery-required (DEVIATIONS.md, JOB-03).
const SYNTHESIS_FAILURES = {
  reject: { status: 400, error: { message: 'Synthetic rejection', type: 'invalid_request_error' } },
  'server-error': { status: 500, error: { message: 'Synthetic server error', type: 'server_error' } },
};

const fixture = {
  calls: [],
  refused: [],
  synthesisFailures: [],
  holdSynthesis: false,
  heldReleases: [],
  synthesisDelayMs: 0,
};

function operationOf(body) {
  const properties = body?.text?.format?.schema?.properties ?? {};
  if ('commonThemes' in properties) return 'aggregate';
  if ('statedPreferences' in properties) return 'synthesis';
  if ('message' in properties) return 'interview';
  return 'greeting';
}

async function openAiResponse(request) {
  const body = await request.json();
  const operation = operationOf(body);
  // The outcome is fixed when the request arrives, so a hold or a control
  // call made while this request is in flight cannot change it.
  const failure = operation === 'synthesis' ? fixture.synthesisFailures.shift() : undefined;
  const call = { operation, model: body.model, at: Date.now(), status: SYNTHESIS_FAILURES[failure]?.status ?? 200 };
  fixture.calls.push(call);
  if (operation === 'synthesis') {
    if (fixture.holdSynthesis) {
      await new Promise((resolve) => fixture.heldReleases.push(resolve));
    }
    if (fixture.synthesisDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, fixture.synthesisDelayMs));
    if (failure) {
      const { status, error } = SYNTHESIS_FAILURES[failure];
      return Response.json({ error }, { status });
    }
  }
  const text = operation === 'greeting'
    ? GREETING
    : JSON.stringify(operation === 'synthesis' ? SYNTHESIS : operation === 'aggregate' ? AGGREGATE : {
      message: 'Thank you. That completes our conversation.',
      questionAddressed: 0,
      phaseTransition: 'wrap-up',
      profileUpdates: [],
      shouldConclude: true,
    });
  return Response.json({
    id: 'resp_synthetic',
    object: 'response',
    created_at: 1,
    status: 'completed',
    model: body.model,
    output: [{ type: 'message', id: 'msg_synthetic', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }],
    usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
  });
}

// Outbound guard: the harness proxies Worker subrequests through this global.
const realFetch = globalThis.fetch;
let harnessOrigin = '';
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (harnessOrigin && url.origin === harnessOrigin) return realFetch(request);
  if (url.origin === 'https://api.openai.com' && url.pathname === '/v1/responses') return openAiResponse(request);
  fixture.refused.push(`${request.method} ${url.origin}${url.pathname}`);
  return new Response('refused by e2e outbound guard', { status: 599 });
};

const harness = await createTestHarness({
  workers: [{
    configPath: CONFIG,
    prebuiltWorkerDir: ARTIFACT_WORKER_DIR,
    secrets: {
      ADMIN_PASSWORD: 'e2e-cloudflare-admin-password',
      SESSION_SECRET: 'e2e-cloudflare-session-secret-000000000000001',
      PARTICIPANT_TOKEN_SECRET: 'e2e-cloudflare-participant-secret-0000000001',
      RATE_LIMIT_SALT: 'e2e-cloudflare-rate-limit-salt-000000000001',
      OPERATOR_TOKEN: 'e2e-cloudflare-operator-token-00000000000001',
      OPENAI_API_KEY: 'sk-e2e-cloudflare-synthetic',
    },
  }],
});
const { url: harnessUrl } = await harness.listen();
harnessOrigin = new URL(harnessUrl).origin;

function control(req, res, pathname) {
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  if (pathname === '/__fixture/state') {
    return send(200, {
      calls: fixture.calls,
      refused: fixture.refused,
      pendingSynthesisFailures: fixture.synthesisFailures.length,
      heldSynthesis: fixture.heldReleases.length,
    });
  }
  if (pathname === '/__fixture/reset') {
    Object.assign(fixture, { calls: [], refused: [], synthesisFailures: [], holdSynthesis: false, synthesisDelayMs: 0 });
    for (const release of fixture.heldReleases.splice(0)) release();
    return send(200, { ok: true });
  }
  if (pathname === '/__fixture/fail-next-synthesis') {
    fixture.synthesisFailures.push('reject');
    return send(200, { ok: true });
  }
  if (pathname === '/__fixture/server-error-next-synthesis') {
    fixture.synthesisFailures.push('server-error');
    return send(200, { ok: true });
  }
  if (pathname === '/__fixture/hold-synthesis') { fixture.holdSynthesis = true; return send(200, { ok: true }); }
  if (pathname === '/__fixture/release-synthesis') {
    fixture.holdSynthesis = false;
    const released = fixture.heldReleases.splice(0);
    for (const release of released) release();
    return send(200, { released: released.length });
  }
  return send(404, { error: 'unknown fixture control' });
}

const server = http.createServer(async (req, res) => {
  const incoming = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  if (incoming.pathname.startsWith('/__fixture/')) return control(req, res, incoming.pathname);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || name === 'host' || name === 'connection') continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  try {
    const upstream = await realFetch(new URL(incoming.pathname + incoming.search, harnessUrl), {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : Buffer.concat(chunks),
      redirect: 'manual',
    });
    const outHeaders = {};
    upstream.headers.forEach((value, name) => {
      if (name === 'set-cookie' || name === 'content-encoding' || name === 'content-length' || name === 'transfer-encoding') return;
      outHeaders[name] = value;
    });
    const cookies = upstream.headers.getSetCookie();
    if (cookies.length > 0) outHeaders['set-cookie'] = cookies;
    res.writeHead(upstream.status, outHeaders);
    if (upstream.body) {
      for await (const chunk of upstream.body) res.write(chunk);
    }
    res.end();
  } catch (error) {
    // Pass an errored Worker body on as a failed transfer, not a clean end.
    // Export invalidation does not rely on this proxy: the Worker errors the
    // body when an export stream fails (cloudflare/opennext/
    // backpressureWrapper.ts), and the browser client refuses any archive
    // without its closing ZIP records (isCompleteZipArchive in
    // src/services/storageService.ts). The proxy must only not mask that.
    res.destroy(error instanceof Error ? error : new Error('upstream failed'));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`cloudflare artifact e2e server ready on http://127.0.0.1:${PORT}`);
});

const shutdown = async () => {
  server.close();
  await harness.close().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
