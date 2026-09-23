// Credential-free control for the OpenRouter SDK's retry behavior (no network: fetch is
// stubbed; synthetic key). Mirrors the jobFaults fixture: the first response is HTTP 500
// with `retry-after: 0` (and `retry-after-ms: <n>` when given, as the fixture now sends);
// the next is a 400 that ends the loop. Measures, per trial, whether and when a second
// request is made under (a) the SDK default and (b) retries: { strategy: 'none' }.
// MEASUREMENTS.md section 5, "Provider request counts".
//
// Usage (from the repository root):
//   node scripts/cloudflare/measure/openrouter-retry.mjs [trials] [--retry-after-ms <n>]
// Defaults: 40 trials, no retry-after-ms header.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './lib.mjs';

const { OpenRouter } = await import(pathToFileURL(path.join(ROOT, 'node_modules/@openrouter/sdk/esm/index.js')).href);
const args = process.argv.slice(2);
const flag = args.indexOf('--retry-after-ms');
const retryAfterMs = flag >= 0 ? args[flag + 1] : null;
const positional = args.filter((_, i) => flag < 0 || (i !== flag && i !== flag + 1));
const trials = Number(positional[0] || 40);

function makeFetch(log) {
  let n = 0;
  return async () => {
    n++;
    log.push(Date.now());
    if (n === 1) {
      return new Response(JSON.stringify({ error: { message: 'synthetic', code: 500 } }), {
        status: 500,
        headers: {
          'content-type': 'application/json',
          'retry-after': '0',
          ...(retryAfterMs === null ? {} : { 'retry-after-ms': retryAfterMs }),
        },
      });
    }
    return new Response(JSON.stringify({ error: { message: 'synthetic 400 to end the loop', code: 400 } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  };
}

async function trial(opts) {
  const log = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = makeFetch(log);
  try {
    const client = new OpenRouter({ apiKey: 'synthetic-openrouter-key' });
    await client.chat.send({ chatRequest: { model: 'openai/gpt-synthetic', messages: [{ role: 'user', content: 'x' }], stream: false } }, opts).catch(() => {});
  } finally {
    globalThis.fetch = realFetch;
  }
  return { requests: log.length, secondAfterMs: log.length > 1 ? log[1] - log[0] : null };
}

const res = { default: [], none: [] };
for (let i = 0; i < trials; i++) {
  res.default.push(await trial(undefined));
  res.none.push(await trial({ retries: { strategy: 'none' } }));
}
const d = res.default.map((r) => r.secondAfterMs).filter((x) => x !== null).sort((a, b) => a - b);
console.log(JSON.stringify({
  trials,
  retryAfterMs,
  default: { tookSecondRequest: d.length, minMs: d[0], medianMs: d[d.length >> 1], maxMs: d[d.length - 1], within300ms: d.filter((x) => x <= 300).length },
  strategyNone: { maxRequests: Math.max(...res.none.map((r) => r.requests)) },
}));
