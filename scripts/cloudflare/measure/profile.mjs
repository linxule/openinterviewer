// Aggregate `wrangler check startup` CPU profiles: self time per function and per original
// source (via worker.js.map; handler.mjs positions further resolved to the esbuild input
// that contains them, using the same wrapper-key regions as attribute.mjs).
// MEASUREMENTS.md section 4 records the `wrangler check startup --outfile` command that
// writes the profiles; they must come from the same build as the map.
//
// Usage (from the repository root):
//   node scripts/cloudflare/measure/profile.mjs [worker.js.map] [handler.mjs.meta.json] [profile.cpuprofile ...]
// Arguments are recognised by extension. Defaults: the artifact's worker.js.map,
// .open-next/server-functions/default/handler.mjs.meta.json and every *.cpuprofile in
// dist/cloudflare/measure/.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { HANDLER_META, measureInputs, WORKER_MAP } from './lib.mjs';

const args = process.argv.slice(2).map((arg) => path.resolve(arg));
const mapPath = args.find((arg) => arg.endsWith('.map')) ?? WORKER_MAP;
const metaPath = args.find((arg) => arg.endsWith('.json')) ?? HANDLER_META;
const given = args.filter((arg) => arg.endsWith('.cpuprofile'));
const profiles = given.length > 0 ? given : measureInputs('.cpuprofile');
if (profiles.length === 0) {
  console.error('profile.mjs: no .cpuprofile given and none in dist/cloudflare/measure/');
  process.exit(1);
}
const map = JSON.parse(readFileSync(mapPath, 'utf8'));
const meta = JSON.parse(readFileSync(metaPath, 'utf8'));

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DEC = new Int8Array(128).fill(-1);
for (let i = 0; i < 64; i++) DEC[B64.charCodeAt(i)] = i;
const lineSegs = [];
{
  const m = map.mappings;
  let pos = 0, s = 0, ol = 0, oc = 0, nm = 0, ln = 0;
  const vlq = () => { let r = 0, sh = 0, c; do { const d = DEC[m.charCodeAt(pos++)]; c = d & 32; r += (d & 31) << sh; sh += 5; } while (c); return r & 1 ? -(r >>> 1) : r >>> 1; };
  while (pos <= m.length) {
    const segs = []; let col = 0;
    while (pos < m.length && m[pos] !== ';') {
      if (m[pos] === ',') { pos++; continue; }
      col += vlq();
      if (pos < m.length && m[pos] !== ',' && m[pos] !== ';') { s += vlq(); ol += vlq(); oc += vlq(); if (pos < m.length && m[pos] !== ',' && m[pos] !== ';') nm += vlq(); segs.push([col, s, ol, oc]); }
      else segs.push([col, -1, 0, 0]);
    }
    lineSegs[ln++] = segs; pos++;
  }
}
function lookup(line, col) {
  const segs = lineSegs[line] || [];
  let f = null;
  for (const sg of segs) { if (sg[0] <= col) f = sg; else break; }
  return f && f[1] >= 0 ? f : null;
}

const handlerIdx = map.sources.findIndex((x) => /server-functions\/default\/handler\.mjs$/.test(x));
const text = map.sourcesContent[handlerIdx];
const lineStarts = [0];
for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
const inputs = Object.values(meta.outputs)[0].inputs;
const keys = [];
for (const k of text.matchAll(/\{"((?:\.open-next|node_modules|\.next)\/[^"]+)"\(/g)) keys.push([k.index, k[1]]);
const regions = keys.map(([st, p], i) => [st, Math.min(i + 1 < keys.length ? keys[i + 1][0] : text.length, inputs[p] ? st + inputs[p].bytesInOutput : Infinity), p]);
function handlerInput(oLine, oCol) {
  const off = lineStarts[oLine] + oCol;
  let lo = 0, hi = regions.length - 1, f = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (regions[mid][0] <= off) { f = mid; lo = mid + 1; } else hi = mid - 1; }
  return f >= 0 && off < regions[f][1] ? regions[f][2].replace('.open-next/server-functions/default/', '') : '(handler glue)';
}

const bySource = new Map();
const byFunction = new Map();
let total = 0;
let runs = 0;
for (const file of profiles) {
  const p = JSON.parse(readFileSync(file, 'utf8'));
  runs++;
  const nodes = new Map(p.nodes.map((n) => [n.id, n]));
  const self = new Map();
  p.samples.forEach((id, i) => { self.set(id, (self.get(id) || 0) + (p.timeDeltas[i] ?? 0)); }); // same convention as wrangler summarizeStartupProfile
  for (const [id, us] of self) {
    const n = nodes.get(id);
    const cf = n.callFrame;
    total += us;
    let where;
    if (!cf.url) where = cf.functionName; // (garbage collector), (program), (idle)
    else if (!/worker\.js$/.test(cf.url)) where = `other script: ${cf.url.split('/').pop()}`;
    else {
      // prefer the positionTicks line (1-based) when present for self-time location
      const line = cf.lineNumber;
      const sg = line >= 0 ? lookup(line, cf.columnNumber) : null;
      if (!sg) where = '(worker.js top level / unmapped)';
      else if (sg[1] === handlerIdx) where = `handler: ${handlerInput(sg[2], sg[3])}`;
      else where = map.sources[sg[1]].replace(/^(\.\.\/)+/, '');
    }
    bySource.set(where, (bySource.get(where) || 0) + us);
    const fk = `${cf.functionName || '(anonymous)'} @ ${where}`;
    byFunction.set(fk, (byFunction.get(fk) || 0) + us);
  }
}
const ms = (us) => (us / 1000 / runs).toFixed(1);
console.log(`profiles ${runs}; mean sampled self time per run ${ms(total)} ms`);
console.log('--- self time by location (mean ms per run)');
for (const [k, v] of [...bySource].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`${ms(v).padStart(7)}  ${k}`);
console.log('--- self time by function (mean ms per run)');
for (const [k, v] of [...byFunction].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`${ms(v).padStart(7)}  ${k}`);

// Who triggers zod work at startup: nearest ancestor frame outside node_modules/zod.
const callers = new Map();
let zodTotal = 0;
for (const file of profiles) {
  const p = JSON.parse(readFileSync(file, 'utf8'));
  const nodes = new Map(p.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const srcOf = (n) => {
    const cf = n.callFrame;
    if (!/worker\.js$/.test(cf.url) || cf.lineNumber < 0) return null;
    const sg = lookup(cf.lineNumber, cf.columnNumber);
    if (!sg) return null;
    return sg[1] === handlerIdx ? `handler: ${handlerInput(sg[2], sg[3])}` : map.sources[sg[1]].replace(/^(\.\.\/)+/, '');
  };
  p.samples.forEach((id, i) => {
    const s0 = srcOf(nodes.get(id));
    if (!s0 || !s0.includes('node_modules/zod/')) return;
    const us = p.timeDeltas[i] ?? 0;
    zodTotal += us;
    let cur = parent.get(id);
    let found = '(no non-zod ancestor)';
    while (cur !== undefined) {
      const s = srcOf(nodes.get(cur));
      if (s && !s.includes('node_modules/zod/')) {
        const m = s.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
        found = m ? m[1] : s;
        break;
      }
      cur = parent.get(cur);
    }
    callers.set(found, (callers.get(found) || 0) + us);
  });
}
console.log(`--- zod self time ${ms(zodTotal)} ms/run, by nearest non-zod ancestor`);
for (const [k, v] of [...callers].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`${ms(v).padStart(7)}  ${k}`);
