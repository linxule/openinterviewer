// Package-level composition of worker.js.
//  - Worker-graph sources: exact bytes from worker.js.map (attribute.mjs output).
//  - Handler/middleware esbuild inputs: exact worker bytes per input (attribute.mjs level 2).
//  - Turbopack chunk inputs: split by package using the chunk's own Turbopack source map
//    (.next/server/chunks/<chunk>.js.map, exact within the chunk file), scaled to the worker
//    bytes attributed to that chunk input. Scaling is the only approximation.
// MEASUREMENTS.md section 3, level 3 and the top-contributor table.
//
// Usage (from the repository root, after attribute.mjs, with the .next output of the same build):
//   node scripts/cloudflare/measure/compose.mjs [attribute.json] [repo root] [out.json]
// Defaults: dist/cloudflare/measure/attribute.json, this repository, dist/cloudflare/measure/compose.json.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { argOr, measureOutput, measurePath, ROOT } from './lib.mjs';

const args = process.argv.slice(2);
const attrPath = argOr(args[0], measurePath('attribute.json'));
const root = argOr(args[1], ROOT);
const outPath = argOr(args[2], () => measureOutput('compose.json'));
// Sources the map records by absolute path lose the checkout prefix.
const rootPrefix = `${root.replace(/^\//, '')}/`;
const attr = JSON.parse(readFileSync(attrPath, 'utf8'));

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DEC = new Int8Array(128).fill(-1);
for (let i = 0; i < 64; i++) DEC[B64.charCodeAt(i)] = i;

// Decode one standard map into per-line segment lists [col, globalSourceIdx], offset by
// (lineOff, colOff) as index-map sections require.
function decodeInto(map, lineSegs, lineOff, colOff, srcBase) {
  const m = map.mappings;
  let pos = 0, s = 0, ol = 0, oc = 0, nm = 0, ln = lineOff;
  const vlq = () => {
    let r = 0, sh = 0, c;
    do { const d = DEC[m.charCodeAt(pos++)]; c = d & 32; r += (d & 31) << sh; sh += 5; } while (c);
    return r & 1 ? -(r >>> 1) : r >>> 1;
  };
  while (pos <= m.length) {
    let col = ln === lineOff ? colOff : 0;
    const segs = (lineSegs[ln] ||= []);
    while (pos < m.length && m[pos] !== ';') {
      if (m[pos] === ',') { pos++; continue; }
      col += vlq();
      if (pos < m.length && m[pos] !== ',' && m[pos] !== ';') {
        s += vlq(); ol += vlq(); oc += vlq();
        if (pos < m.length && m[pos] !== ',' && m[pos] !== ';') nm += vlq();
        segs.push([col, srcBase + s]);
      } else segs.push([col, -1]);
    }
    pos++;
    ln++;
  }
}

function flatten(map) {
  if (!map.sections) return { sources: map.sources, decode: (ls) => decodeInto(map, ls, 0, 0, 0) };
  const sources = [];
  const parts = map.sections.map((sec) => { const base = sources.length; sources.push(...sec.map.sources); return [sec, base]; });
  return {
    sources,
    decode: (ls) => {
      for (const [sec, base] of parts) decodeInto(sec.map, ls, sec.offset.line, sec.offset.column, base);
      for (const segs of ls) if (segs) segs.sort((a, b) => a[0] - b[0]);
    },
  };
}

function bytesPerSource(code, rawMap) {
  const map = flatten(rawMap);
  const per = new Float64Array(map.sources.length);
  let unmapped = 0;
  const lines = code.split('\n');
  const lineSegs = [];
  map.decode(lineSegs);
  map.per = per;
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln];
    const ascii = Buffer.byteLength(line) === line.length;
    const len = (a, b) => (ascii ? b - a : Buffer.byteLength(line.slice(a, b)));
    const segs = lineSegs[ln] || [];
    const nl = ln < lines.length - 1 ? 1 : 0;
    if (!segs.length) { unmapped += len(0, line.length) + nl; continue; }
    unmapped += len(0, Math.min(segs[0][0], line.length));
    for (let i = 0; i < segs.length; i++) {
      const a = Math.min(segs[i][0], line.length);
      const b = i + 1 < segs.length ? Math.min(segs[i + 1][0], line.length) : line.length;
      const bytes = len(a, b) + (i === segs.length - 1 ? nl : 0);
      if (segs[i][1] < 0) unmapped += bytes; else per[segs[i][1]] += bytes;
    }
  }
  return { per, unmapped, sources: map.sources };
}

function pkgOf(src) {
  const s = decodeURIComponent(src).replace(/^(\.\.\/)+/, '').replace(/^turbopack:\/\/\/\[project\]\//, '');
  const i = s.lastIndexOf('node_modules/');
  if (i >= 0) {
    const rest = s.slice(i + 13).split('/');
    const name = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
    if (name === 'next' && rest[1] === 'dist' && rest[2] === 'compiled') {
      const sub = rest[3].startsWith('@') ? `${rest[3]}/${rest[4]}` : rest[3];
      return `next (compiled ${sub})`;
    }
    return name;
  }
  if (s.startsWith('src/') || s.startsWith('cloudflare/')) return `app: ${s.split('/').slice(0, 2).join('/')}`;
  return `other: ${s.split('/').slice(0, 3).join('/')}`;
}

const chunkComposition = {};
function chunkShares(chunkRel) {
  if (chunkComposition[chunkRel]) return chunkComposition[chunkRel];
  const js = path.join(root, '.next', chunkRel);
  const mp = `${js}.map`;
  if (!existsSync(js) || !existsSync(mp)) return null;
  const code = readFileSync(js, 'utf8');
  const map = JSON.parse(readFileSync(mp, 'utf8'));
  const { per, unmapped, sources } = bytesPerSource(code, map);
  const shares = {};
  sources.forEach((src, i) => { if (per[i]) shares[pkgOf(src)] = (shares[pkgOf(src)] || 0) + per[i]; });
  if (unmapped) shares['(turbopack runtime glue / unmapped)'] = unmapped;
  const total = Buffer.byteLength(code);
  chunkComposition[chunkRel] = { total, shares };
  return chunkComposition[chunkRel];
}

const layers = {}; // pkg -> { worker, handler, middleware }
const add = (pkg, layer, bytes) => {
  layers[pkg] ||= { 'worker graph': 0, 'server handler': 0, middleware: 0 };
  layers[pkg][layer] += bytes;
};

// 1. worker graph (everything except the two handler sources)
for (const [src, bytes] of Object.entries(attr.bySource)) {
  if (/server-functions\/default\/handler\.mjs$|middleware\/handler\.mjs$/.test(src)) continue;
  add(src.startsWith('node-built-in-modules:') ? 'node built-in imports' : pkgOf(src.startsWith(rootPrefix) ? src.slice(rootPrefix.length) : src), 'worker graph', bytes);
}
add('(unmapped worker bytes)', 'worker graph', attr.unmapped);

// 2/3. handler + middleware inputs
let scaledChunks = 0, unscaledChunks = 0;
for (const [layerKey, layer, prefix] of [['handler', 'server handler', '.open-next/server-functions/default/'], ['middleware', 'middleware', '.open-next/middleware/']]) {
  const l2 = attr[layerKey];
  add('(handler glue outside module wrappers)', layer, l2.other);
  for (const [input, bytes] of Object.entries(l2.inputs)) {
    const rel = input.startsWith(prefix) ? input.slice(prefix.length) : input;
    const m = rel.match(/^\.next\/(server\/chunks\/.+)$/);
    if (m) {
      const comp = chunkShares(m[1]);
      if (comp) {
        const sum = Object.values(comp.shares).reduce((a, b) => a + b, 0);
        for (const [p, b] of Object.entries(comp.shares)) add(p, layer, (bytes * b) / sum);
        scaledChunks++;
        continue;
      }
      unscaledChunks++;
      add('(turbopack chunk without map)', layer, bytes);
      continue;
    }
    add(pkgOf(rel), layer, bytes);
  }
}

const rows = Object.entries(layers).map(([pkg, v]) => ({ pkg, ...v, total: v['worker graph'] + v['server handler'] + v.middleware }))
  .sort((a, b) => b.total - a.total);
const grand = rows.reduce((a, r) => a + r.total, 0);
writeFileSync(outPath, JSON.stringify({ grand, scaledChunks, unscaledChunks, rows, chunkComposition }, null, 1));
console.log(`grand ${Math.round(grand)} (worker.js ${attr.totalBytes}); chunks scaled ${scaledChunks}, without map ${unscaledChunks} -> ${outPath}`);
for (const r of rows.slice(0, 40)) console.log([Math.round(r.total), Math.round(r['worker graph']), Math.round(r['server handler']), Math.round(r.middleware), r.pkg].join('\t'));
