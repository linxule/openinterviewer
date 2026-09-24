// Parse Turbopack server chunks (module.exports=[id,(fn),id,(fn),...]) with acorn and
// report per-module sizes, modules present in more than one chunk, and which route
// entries load each chunk. Only chunks that are inputs of the OpenNext server bundle
// (handler.mjs.meta.json) are counted. MEASUREMENTS.md section 3, "Modules that appear
// more than once".
//
// Usage (from the repository root, after npm run build:cloudflare):
//   node scripts/cloudflare/measure/turbopack.mjs [server-functions dir] [out.json]
// Defaults: .open-next/server-functions/default, dist/cloudflare/measure/turbopack.json.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { argOr, measureOutput, requireFromRepo, SERVER_FUNCTION_DIR } from './lib.mjs';

const acorn = requireFromRepo('acorn');

const args = process.argv.slice(2);
const fnDir = argOr(args[0], SERVER_FUNCTION_DIR);
const outPath = argOr(args[1], () => measureOutput('turbopack.json'));
const meta = JSON.parse(readFileSync(path.join(fnDir, 'handler.mjs.meta.json'), 'utf8'));
const inputs = Object.values(meta.outputs)[0].inputs;
const prefix = '.open-next/server-functions/default/';
const chunkFiles = Object.keys(inputs)
  .filter((p) => p.startsWith(`${prefix}.next/server/chunks/`) && !p.endsWith('[turbopack]_runtime.js'))
  .map((p) => p.slice(prefix.length));

const modules = new Map(); // id -> { size, chunks: [], sample }
const chunkInfo = {};
const parseErrors = [];
for (const rel of chunkFiles) {
  const text = readFileSync(path.join(fnDir, rel), 'utf8');
  let ast;
  try {
    ast = acorn.parse(text, { ecmaVersion: 'latest', sourceType: 'script' });
  } catch (e) {
    parseErrors.push(`${rel}: ${e.message}`);
    continue;
  }
  // module.exports = [ ... ]  (possibly preceded by other statements)
  let arr = null;
  for (const st of ast.body) {
    const ex = st.type === 'ExpressionStatement' ? st.expression : null;
    if (ex && ex.type === 'AssignmentExpression' && ex.right.type === 'ArrayExpression') arr = ex.right;
  }
  if (!arr) { parseErrors.push(`${rel}: no module array`); continue; }
  const els = arr.elements;
  let n = 0;
  let bytes = 0;
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    if (!el) continue;
    if (el.type === 'Literal' && typeof el.value === 'number') {
      // one id may be followed by further ids sharing the same factory; factory is next non-literal
      let j = i + 1;
      while (j < els.length && els[j] && els[j].type === 'Literal') j++;
      const fn = els[j];
      if (!fn) continue;
      const src = text.slice(fn.start, fn.end);
      const size = Buffer.byteLength(src);
      const id = String(el.value);
      const rec = modules.get(id) || { size, chunks: [], text: src };
      rec.chunks.push(rel);
      modules.set(id, rec);
      n++;
      bytes += size;
      i = j;
    }
  }
  chunkInfo[rel] = { fileBytes: statSync(path.join(fnDir, rel)).size, modules: n, moduleBytes: bytes };
}

// Route entries -> chunks
const routeChunks = {};
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\/(route|page)\.js$/.test(full)) {
      const text = readFileSync(full, 'utf8');
      const refs = [...text.matchAll(/R\.c\("(server\/chunks\/[^"]+)"\)/g)].map((x) => `.next/${x[1]}`);
      routeChunks[path.relative(path.join(fnDir, '.next/server'), full)] = refs;
    }
  }
}
walk(path.join(fnDir, '.next/server/app'));

// Signature fingerprints (heuristic; minified code carries no module paths)
const SIGS = [
  ['@openrouter/sdk', /openrouter\.ai|OpenRouter/],
  ['openai', /OpenAI-Organization|openai-beta|x-stainless-(?:lang|arch)[\s\S]*OpenAI/],
  ['@anthropic-ai/sdk', /anthropic-version/],
  ['@google/genai', /generativelanguage\.googleapis\.com|x-goog-api-client/],
  ['@upstash/redis', /upstash/i],
  ['zod', /ZodError|\$ZodType|_zod/],
  ['ws', /258EAFA5-E914-47DA-95CA-C5AB0DC85B11/],
  ['jszip', /JSZip|jszip/],
  ['jose', /JWSSignatureVerificationFailed|JOSEError/],
  ['react-markdown/micromark', /micromark|mdast/],
  ['ai (Vercel AI SDK)', /AI_APICallError|ai-sdk|vercel\.ai/],
  ['node-fetch/undici', /undici/],
  ['arctic (OAuth)', /arctic|OAuth2Client|oauth2/i],
];
function fingerprint(text) {
  return SIGS.filter(([, re]) => re.test(text)).map(([n]) => n);
}

const dups = [...modules.entries()]
  .filter(([, r]) => r.chunks.length > 1)
  .map(([id, r]) => ({ id, size: r.size, copies: r.chunks.length, excessBytes: r.size * (r.chunks.length - 1), fingerprint: fingerprint(r.text), chunks: r.chunks }))
  .sort((a, b) => b.excessBytes - a.excessBytes);

const totalModuleBytes = [...modules.values()].reduce((a, r) => a + r.size * r.chunks.length, 0);
const uniqueModuleBytes = [...modules.values()].reduce((a, r) => a + r.size, 0);

// Chunk content-duplicate groups: same multiset of module ids
const chunkSig = {};
for (const rel of Object.keys(chunkInfo)) chunkSig[rel] = [];
for (const [id, r] of modules) for (const c of r.chunks) chunkSig[c].push(id);
const groups = {};
for (const [c, ids] of Object.entries(chunkSig)) {
  const key = ids.sort().join(',');
  (groups[key] ||= []).push(c);
}
const identicalChunkGroups = Object.values(groups).filter((g) => g.length > 1).map((g) => ({
  chunks: g,
  moduleBytesEach: chunkInfo[g[0]].moduleBytes,
  fileBytesEach: chunkInfo[g[0]].fileBytes,
  loadedBy: Object.entries(routeChunks).filter(([, refs]) => refs.some((r) => g.includes(r))).map(([k]) => k),
  fingerprintOfLargest: (() => {
    const ids = chunkSig[g[0]].map((id) => [id, modules.get(id)]).sort((a, b) => b[1].size - a[1].size).slice(0, 8);
    return ids.map(([id, r]) => ({ id, size: r.size, fp: fingerprint(r.text) }));
  })(),
}));

writeFileSync(outPath, JSON.stringify({
  chunksParsed: Object.keys(chunkInfo).length,
  parseErrors,
  moduleIds: modules.size,
  totalModuleBytes,
  uniqueModuleBytes,
  duplicatedModuleIds: dups.length,
  duplicatedExcessBytes: dups.reduce((a, d) => a + d.excessBytes, 0),
  topDuplicates: dups.slice(0, 40).map(({ chunks, ...d }) => ({ ...d, chunks: chunks.length })),
  identicalChunkGroups,
  chunkInfo,
  routeChunks,
}, null, 1));
console.log(`chunks ${Object.keys(chunkInfo).length}, parse errors ${parseErrors.length}, module ids ${modules.size}, module bytes ${totalModuleBytes}, unique ${uniqueModuleBytes}, duplicated ids ${dups.length} -> ${outPath}`);
