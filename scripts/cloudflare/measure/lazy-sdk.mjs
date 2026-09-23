// Check that the Queue consumer's module graph evaluates no provider SDK when
// it loads, and that the first queued call loads only its own provider's SDK
// (MEASUREMENTS.md, R2 status). Bundles with the esbuild that wrangler uses and
// the import-boundary settings, instruments esbuild's lazy-module helpers
// (__esm, __commonJS) to record each module they initialize, and imports the
// bundles in Node. No network: the first call's fetch is refused locally and
// the key is synthetic. Node timings are indicative only; workerd startup is
// measured with `wrangler check startup` (MEASUREMENTS.md section 4).
//
// Usage (from the repository root):
//   node scripts/cloudflare/measure/lazy-sdk.mjs [repo root] [out dir]
// Defaults: this repository, dist/cloudflare/measure/lazy-sdk/. Exits 1 when a
// provider SDK module is evaluated at import.
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { argOr, measureOutput, ROOT } from './lib.mjs';

const args = process.argv.slice(2);
const root = argOr(args[0], ROOT);
const outDir = argOr(args[1], () => measureOutput('lazy-sdk'));
mkdirSync(outDir, { recursive: true });

const SDK = /node_modules\/(@openrouter\/sdk|zod|openai|@anthropic-ai\/sdk|@google\/genai)\//;
const ESM_HELPER = 'var __esm = (fn, res, err) => function __init() {';
const CJS_HELPER = 'var __commonJS = (cb, mod) => function __require() {';
const record = (name) => `(globalThis.__lazySdkInits ??= []).push(__getOwnPropNames(${name})[0]);`;

async function instrumentedBundle(entry) {
  const outfile = path.join(outDir, `${path.parse(entry).name}.bundle.mjs`);
  await build({
    entryPoints: [path.join(root, entry)],
    absWorkingDir: root,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    conditions: ['workerd', 'worker', 'browser'],
    mainFields: ['browser', 'module', 'main'],
    external: ['cloudflare:*', 'node:*'],
    alias: { '@': path.join(root, 'src') },
    tsconfig: path.join(root, 'cloudflare', 'tsconfig.json'),
    outfile,
    logLevel: 'silent',
  });
  const code = readFileSync(outfile, 'utf8');
  if (!code.includes(ESM_HELPER)) throw new Error(`esbuild's __esm helper changed shape; update ${path.basename(import.meta.url)}`);
  const instrumented = code
    .replace(ESM_HELPER, `${ESM_HELPER} if (fn) ${record('fn')}`)
    .replace(CJS_HELPER, `${CJS_HELPER} if (!mod) ${record('cb')}`);
  const file = outfile.replace(/\.bundle\.mjs$/, '.instrumented.mjs');
  writeFileSync(file, instrumented);
  return { code, file };
}

const countBy = (paths) => paths.reduce((counts, p) => {
  const name = p.match(SDK)[1];
  return { ...counts, [name]: (counts[name] ?? 0) + 1 };
}, {});

async function importRecording(file) {
  globalThis.__lazySdkInits = [];
  const started = performance.now();
  const loaded = await import(pathToFileURL(file).href);
  return { loaded, ms: Math.round(performance.now() - started), inits: globalThis.__lazySdkInits.filter((key) => SDK.test(key)) };
}

const consumer = await instrumentedBundle('cloudflare/analysis/consumer.ts');
const sdkModules = [...consumer.code.matchAll(/^\/\/ (\S*node_modules\/\S+)$/gm)].map((m) => m[1]).filter((p) => SDK.test(p));
const wrapperKeys = new Set([...consumer.code.matchAll(/^ {2}"([^"]*node_modules\/[^"]+)"\(/gm)].map((m) => m[1]));
const eager = sdkModules.filter((p) => !wrapperKeys.has(p));
const consumerImport = await importRecording(consumer.file);
const zodRegistryAfterImport = '__zod_globalRegistry' in globalThis;

const execute = await instrumentedBundle('cloudflare/analysis/execute.ts');
const executeImport = await importRecording(execute.file);
const realFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = async () => {
  fetchCalls += 1;
  throw new TypeError('lazy-sdk: network refused');
};
let firstCall;
try {
  const provider = executeImport.loaded.createQueuedSynthesisProvider('openrouter', 'openai/gpt-5.6-terra', 'synthetic-openrouter');
  globalThis.__lazySdkInits = [];
  const started = performance.now();
  const outcome = await provider.synthesizeInterview(
    [{ id: 'm1', role: 'user', content: 'Hello', timestamp: 1 }],
    {
      id: 'study-lazy', name: 'Lazy', researchQuestion: 'q', coreQuestions: [], topicAreas: [], profileSchema: [],
      aiBehavior: 'standard', aiProvider: 'openrouter', aiModel: 'openai/gpt-5.6-terra', consentText: 'c', createdAt: 1,
    },
    { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] },
    null,
    { kind: 'queued-synthesis', deadlineMs: 2_000 },
  ).then(() => 'resolved', (error) => `${error?.name}: ${error?.message}`);
  firstCall = {
    outcome,
    fetchCalls,
    sdkModulesInitialized: countBy(globalThis.__lazySdkInits.filter((key) => SDK.test(key))),
    ms: Math.round(performance.now() - started),
  };
} finally {
  globalThis.fetch = realFetch;
}

const report = {
  root,
  consumerBundle: {
    bytes: Buffer.byteLength(consumer.code),
    sdkModules: countBy(sdkModules),
    sdkModulesOutsideLazyWrappers: countBy(eager),
    sdkModulesInitializedAtImport: countBy(consumerImport.inits),
    zodRegistryAfterImport,
    importMs: consumerImport.ms,
  },
  executeBundle: {
    sdkModulesInitializedAtImport: countBy(executeImport.inits),
    firstOpenRouterCall: firstCall,
  },
};
console.log(JSON.stringify(report, null, 2));
if (eager.length > 0 || consumerImport.inits.length > 0 || executeImport.inits.length > 0 || zodRegistryAfterImport) {
  console.error('lazy-sdk: a provider SDK is evaluated when the consumer graph loads');
  process.exit(1);
}
