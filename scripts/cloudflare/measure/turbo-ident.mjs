// Identify what each duplicated Turbopack module id contains, exactly, using the chunk's
// own Turbopack source map (.next/server/chunks/<chunk>.js.map; the .next copy is the file
// the map describes). For each module factory range, sum mapped bytes per original package.
// MEASUREMENTS.md section 3, the module-id table.
//
// Usage (from the repository root, after turbopack.mjs, with the .next output of the same build):
//   node scripts/cloudflare/measure/turbo-ident.mjs [turbopack.json] [repo root] [topN]
// Defaults: dist/cloudflare/measure/turbopack.json, this repository, 15 (the rows MEASUREMENTS.md shows).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { argOr, measurePath, requireFromRepo, ROOT } from './lib.mjs';

const args = process.argv.slice(2);
const tpPath = argOr(args[0], measurePath('turbopack.json'));
const root = argOr(args[1], ROOT);
const topN = args[2] ?? '15';
const acorn = requireFromRepo('acorn');
const tp = JSON.parse(readFileSync(tpPath, 'utf8'));

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DEC = new Int8Array(128).fill(-1);
for (let i = 0; i < 64; i++) DEC[B64.charCodeAt(i)] = i;

function segmentsWithOffsets(code, rawMap) {
  const lineStarts = [0];
  for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const out = []; // [absOffset, sourceName]
  const sections = rawMap.sections ? rawMap.sections : [{ offset: { line: 0, column: 0 }, map: rawMap }];
  for (const sec of sections) {
    const map = sec.map;
    const m = map.mappings;
    let pos = 0, s = 0, ol = 0, oc = 0, nm = 0, ln = sec.offset.line;
    const vlq = () => { let r = 0, sh = 0, c; do { const d = DEC[m.charCodeAt(pos++)]; c = d & 32; r += (d & 31) << sh; sh += 5; } while (c); return r & 1 ? -(r >>> 1) : r >>> 1; };
    while (pos <= m.length) {
      let col = ln === sec.offset.line ? sec.offset.column : 0;
      while (pos < m.length && m[pos] !== ';') {
        if (m[pos] === ',') { pos++; continue; }
        col += vlq();
        if (pos < m.length && m[pos] !== ',' && m[pos] !== ';') {
          s += vlq(); ol += vlq(); oc += vlq();
          if (pos < m.length && m[pos] !== ',' && m[pos] !== ';') nm += vlq();
          out.push([lineStarts[ln] + col, map.sources[s]]);
        } else out.push([lineStarts[ln] + col, null]);
      }
      pos++; ln++;
    }
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
}
function pkg(src) {
  if (!src) return '(unmapped)';
  const s = decodeURIComponent(src).replace(/^(\.\.\/)+/, '').replace(/^turbopack:\/\/\/\[project\]\//, '');
  const i = s.lastIndexOf('node_modules/');
  if (i < 0) return s.split('/').slice(0, 3).join('/');
  const r = s.slice(i + 13).split('/');
  return r[0].startsWith('@') ? `${r[0]}/${r[1]}` : r[0];
}

const want = new Map(tp.topDuplicates.slice(0, Number(topN)).map((d) => [d.id, d]));
const found = new Map();
const chunkCache = new Map();
for (const [chunk] of Object.entries(tp.chunkInfo)) {
  if (found.size === want.size) break;
  const js = path.join(root, chunk); // chunk keys already start with .next/
  let code;
  try { code = readFileSync(js, 'utf8'); } catch { continue; }
  const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script' });
  let arr = null;
  for (const st of ast.body) if (st.type === 'ExpressionStatement' && st.expression.type === 'AssignmentExpression' && st.expression.right.type === 'ArrayExpression') arr = st.expression.right;
  if (!arr) continue;
  const els = arr.elements;
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    if (!el || el.type !== 'Literal' || typeof el.value !== 'number') continue;
    let j = i + 1;
    while (j < els.length && els[j] && els[j].type === 'Literal') j++;
    const id = String(el.value);
    if (want.has(id) && !found.has(id)) {
      const fn = els[j];
      if (!chunkCache.has(chunk)) chunkCache.set(chunk, segmentsWithOffsets(code, JSON.parse(readFileSync(`${js}.map`, 'utf8'))));
      const segs = chunkCache.get(chunk);
      const by = {};
      for (let k = 0; k < segs.length; k++) {
        const [off, src] = segs[k];
        if (off < fn.start || off >= fn.end) continue;
        const next = k + 1 < segs.length ? Math.min(segs[k + 1][0], fn.end) : fn.end;
        by[pkg(src)] = (by[pkg(src)] || 0) + (next - off);
      }
      found.set(id, { chunk, by });
    }
    i = j;
  }
}
for (const [id, d] of want) {
  const f = found.get(id);
  const top = f ? Object.entries(f.by).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${v}`).join(', ') : '(not found)';
  console.log(`${id}\tsize ${d.size}\tcopies ${d.copies}\texcess ${d.excessBytes}\t${top}`);
}
