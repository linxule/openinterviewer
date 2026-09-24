// Attribute generated worker.js bytes to sources via worker.js.map (VLQ decoded here,
// no dependency). Level 2: bytes mapped into the OpenNext server/middleware handler
// bundles are attributed to the esbuild __commonJS/__esm wrapper keys found in the
// handler text (sourcesContent), bounded by metafile bytesInOutput when a metafile is given.
// MEASUREMENTS.md section 3, levels 1 and 2.
//
// Usage (from the repository root, after npm run build:cloudflare):
//   node scripts/cloudflare/measure/attribute.mjs [worker.js] [worker.js.map] [out.json] [handler.mjs.meta.json]
// Defaults: dist/cloudflare/artifact/worker/worker.js and its map,
// dist/cloudflare/measure/attribute.json, and .open-next/server-functions/default/handler.mjs.meta.json
// when it exists.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { argOr, HANDLER_META, measureOutput, WORKER_JS, WORKER_MAP } from './lib.mjs';

const args = process.argv.slice(2);
const workerPath = argOr(args[0], WORKER_JS);
const mapPath = argOr(args[1], WORKER_MAP);
const outPath = argOr(args[2], () => measureOutput('attribute.json'));
const metaPath = argOr(args[3], existsSync(HANDLER_META) ? HANDLER_META : undefined);
const code = readFileSync(workerPath, 'utf8');
const map = JSON.parse(readFileSync(mapPath, 'utf8'));
const meta = metaPath ? JSON.parse(readFileSync(metaPath, 'utf8')) : null;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DEC = new Int8Array(128).fill(-1);
for (let i = 0; i < 64; i++) DEC[B64.charCodeAt(i)] = i;

const lines = code.split('\n');
const totalBytes = Buffer.byteLength(code);
const perSource = new Float64Array(map.sources.length);
let unmapped = 0;

const HANDLER_RE = /server-functions\/default\/handler\.mjs$/;
const MIDDLEWARE_RE = /middleware\/handler\.mjs$/;
const handlerIdx = map.sources.findIndex((s) => HANDLER_RE.test(s));
const middlewareIdx = map.sources.findIndex((s) => MIDDLEWARE_RE.test(s));
// Segment records for level 2: [srcIdx, origLine, origCol, bytes]
const level2 = { [handlerIdx]: [], [middlewareIdx]: [] };

const m = map.mappings;
let pos = 0;
let srcIdx = 0, origLine = 0, origCol = 0, nameIdx = 0;
function vlq() {
  let result = 0, shift = 0, cont;
  do {
    const d = DEC[m.charCodeAt(pos++)];
    cont = d & 32;
    result += (d & 31) << shift;
    shift += 5;
  } while (cont);
  return result & 1 ? -(result >>> 1) : result >>> 1;
}

let lineNo = 0;
while (lineNo < lines.length) {
  const line = lines[lineNo];
  const ascii = Buffer.byteLength(line) === line.length;
  const segs = []; // [genCol, src, oLine, oCol]
  let genCol = 0;
  while (pos < m.length && m[pos] !== ';') {
    if (m[pos] === ',') { pos++; continue; }
    genCol += vlq();
    if (pos < m.length && m[pos] !== ',' && m[pos] !== ';') {
      srcIdx += vlq(); origLine += vlq(); origCol += vlq();
      if (pos < m.length && m[pos] !== ',' && m[pos] !== ';') nameIdx += vlq();
      segs.push([genCol, srcIdx, origLine, origCol]);
    } else {
      segs.push([genCol, -1, 0, 0]);
    }
  }
  pos++; // skip ';'
  const len = (a, b) => (ascii ? b - a : Buffer.byteLength(line.slice(a, b)));
  const nl = lineNo < lines.length - 1 ? 1 : 0;
  if (segs.length === 0) {
    unmapped += len(0, line.length) + nl;
  } else {
    unmapped += len(0, Math.min(segs[0][0], line.length));
    for (let i = 0; i < segs.length; i++) {
      const a = Math.min(segs[i][0], line.length);
      const b = i + 1 < segs.length ? Math.min(segs[i + 1][0], line.length) : line.length;
      let bytes = len(a, b);
      if (i === segs.length - 1) bytes += nl;
      const s = segs[i][1];
      if (s < 0) { unmapped += bytes; continue; }
      perSource[s] += bytes;
      if (s === handlerIdx || s === middlewareIdx) level2[s].push([segs[i][2], segs[i][3], bytes]);
    }
  }
  lineNo++;
}

const sum = perSource.reduce((a, b) => a + b, 0) + unmapped;

function normalize(src) {
  return src.replace(/^(\.\.\/)+/, '');
}
function packageOf(src) {
  const s = normalize(src);
  if (s.startsWith('node-built-in-modules:')) return 'node built-ins (imports)';
  const nm = s.lastIndexOf('node_modules/');
  if (nm >= 0) {
    const rest = s.slice(nm + 'node_modules/'.length).split('/');
    return rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
  }
  return s;
}

// Level 2
function level2Attribution(idx) {
  if (idx < 0) return null;
  const text = map.sourcesContent[idx];
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  // wrapper keys: {"<path>"(   -- esbuild __commonJS/__esm object-method keys
  const keyRe = /\{"((?:\.open-next|node_modules|\.next)\/[^"]+)"\(/g;
  // non-minified esbuild output marks every module with a "// <path>" line instead
  const commentRe = /^\/\/ ((?:\.open-next|node_modules|\.next|node-builtins|src|cloudflare)[^\s]*)$/gm;
  const keys = [];
  let k;
  while ((k = keyRe.exec(text))) keys.push([k.index, k[1]]);
  if (keys.length === 0) while ((k = commentRe.exec(text))) keys.push([k.index, k[1]]);
  keys.sort((a, b) => a[0] - b[0]);
  const metaInputs = meta && idx === handlerIdx ? Object.values(meta.outputs)[0].inputs : null;
  const regions = keys.map(([start, p], i) => {
    const next = i + 1 < keys.length ? keys[i + 1][0] : text.length;
    const cap = metaInputs && metaInputs[p] ? start + metaInputs[p].bytesInOutput : next;
    return [start, Math.min(next, cap), p];
  });
  const starts = regions.map((r) => r[0]);
  const out = new Map();
  let other = 0;
  for (const [oLine, oCol, bytes] of level2[idx]) {
    const off = lineStarts[oLine] + oCol;
    let lo = 0, hi = starts.length - 1, f = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= off) { f = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (f >= 0 && off < regions[f][1]) out.set(regions[f][2], (out.get(regions[f][2]) || 0) + bytes);
    else other += bytes;
  }
  return { wrapperKeys: keys.length, textChars: text.length, other, inputs: Object.fromEntries([...out].sort((a, b) => b[1] - a[1])) };
}

const bySource = {};
map.sources.forEach((s, i) => { if (perSource[i]) bySource[normalize(s)] = (bySource[normalize(s)] || 0) + perSource[i]; });
const byPackage = {};
map.sources.forEach((s, i) => { const p = packageOf(s); byPackage[p] = (byPackage[p] || 0) + perSource[i]; });

// Duplicate package versions: same package name reached through different node_modules paths
const pkgPaths = {};
for (const s of map.sources) {
  const n = normalize(s);
  const nm = n.lastIndexOf('node_modules/');
  if (nm < 0) continue;
  const root = n.slice(0, nm + 'node_modules/'.length) + (n.slice(nm + 13).split('/')[0].startsWith('@') ? n.slice(nm + 13).split('/').slice(0, 2).join('/') : n.slice(nm + 13).split('/')[0]);
  (pkgPaths[packageOf(s)] ||= new Set()).add(root);
}
const duplicatedPackagePaths = Object.fromEntries(Object.entries(pkgPaths).filter(([, v]) => v.size > 1).map(([k, v]) => [k, [...v]]));

// Duplicate source contents (same text under two source paths)
const contentHash = new Map();
map.sourcesContent.forEach((c, i) => {
  if (c == null) return;
  const key = `${c.length}:${c.slice(0, 200)}:${c.slice(-200)}`;
  (contentHash.get(key) || contentHash.set(key, []).get(key)).push(normalize(map.sources[i]));
});
const duplicatedContents = [...contentHash.values()].filter((v) => v.length > 1);

const result = {
  worker: workerPath,
  totalBytes,
  attributedPlusUnmapped: sum,
  unmapped,
  sources: map.sources.length,
  byPackage: Object.fromEntries(Object.entries(byPackage).sort((a, b) => b[1] - a[1])),
  bySource: Object.fromEntries(Object.entries(bySource).sort((a, b) => b[1] - a[1])),
  duplicatedPackagePaths,
  duplicatedContents,
  handler: level2Attribution(handlerIdx),
  middleware: level2Attribution(middlewareIdx),
};
writeFileSync(outPath, JSON.stringify(result, null, 1));
console.log(`total ${totalBytes} B, attributed+unmapped ${sum} B, unmapped ${unmapped} B, sources ${map.sources.length} -> ${outPath}`);
