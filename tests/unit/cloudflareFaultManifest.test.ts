// @vitest-environment node
// VERIFY-01: the Cloudflare fault manifest (tests/workers/faultManifest.ts)
// must stay complete and true. workerd cannot read test sources, so this Node
// test does: every write site and WorkspaceStore RPC in the Cloudflare sources
// is named by a cut or listed as a non-cut surface, every named symbol exists,
// and every cut names at least one active test, by exact title, in a file a
// test lane runs.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLOUDFLARE_FAULT_CUTS, NON_CUT_SURFACES } from '../workers/faultManifest';

const ROOT = path.resolve(__dirname, '../..');

/** Directories whose tests a lane runs (test:cloudflare, :restart, :artifact, test, test:setup:cloudflare). */
const LANE_DIRECTORIES = ['tests/workers/', 'tests/cloudflare-restart/', 'tests/cloudflare-artifact/', 'tests/unit/', 'tests/setup-cloudflare/'];
const SCANNED_DIRECTORIES = ['cloudflare/workspace', 'cloudflare/analysis'];
const STORE = 'cloudflare/workspace/WorkspaceStore.ts';

const sources = new Map<string, string>();
function source(file: string): string {
  let text = sources.get(file);
  if (text === undefined) {
    text = readFileSync(path.join(ROOT, file), 'utf8');
    sources.set(file, text);
  }
  return text;
}

const TOP_LEVEL_FUNCTION = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/;
/** A column-0 line that opens a class body or an object literal of methods. */
const CONTAINER = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+\w+|^(?:export\s+)?(?:const|let)\s+\w+(?::[^=]+)?\s*=\s*\{\s*$|^export\s+default\s+\{\s*$/;
const MEMBER = /^ {2}(?:(?:private|protected|public|static|async|get|set)\s+)*(\w+)\s*(?:<[^>]*>)?\(/;
const NOT_A_MEMBER = new Set(['if', 'for', 'while', 'switch', 'return', 'catch', 'await', 'throw', 'super']);

function isComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/**
 * Each line with the top-level function, or the class or object-literal
 * member, it belongs to. Members are recognized only inside a container, so a
 * call at two-space indentation in a function body never renames the symbol.
 */
function linesWithSymbol(file: string): Array<{ line: string; symbol: string | null }> {
  let symbol: string | null = null;
  let inContainer = false;
  return source(file).split('\n').map((line) => {
    if (/^\S/.test(line) && !isComment(line)) {
      if (line.startsWith('}')) {
        inContainer = false;
      } else if (/^[A-Za-z_@]/.test(line)) {
        // A new top-level statement; `)` lines continue a multi-line signature.
        const top = line.match(TOP_LEVEL_FUNCTION);
        inContainer = !top && CONTAINER.test(line);
        symbol = top ? top[1] : null;
      }
    } else if (inContainer && !isComment(line)) {
      const member = line.match(MEMBER);
      if (member && !NOT_A_MEMBER.has(member[1])) symbol = member[1];
    }
    return { line, symbol };
  });
}

function symbolsOf(file: string): Set<string> {
  return new Set(linesWithSymbol(file).map((entry) => entry.symbol).filter((symbol): symbol is string => symbol !== null));
}

const WRITE_SITE = [
  /\.transactionSync\(/,
  /\.transaction\(\s*async/,
  /\bkv\.(?:put|delete)\(/,
  /\.(?:setAlarm|deleteAlarm)\(/,
  /\bINSERT\s+INTO\b/,
  /\bUPDATE\s+\w+(?:\s+SET\b|\s*$)/,
  /\bDELETE\s+FROM\b/,
];

/** `<file>#<symbol>` for every function or member that writes durable state or opens a transaction. */
function writeSites(): Set<string> {
  const sites = new Set<string>();
  for (const directory of SCANNED_DIRECTORIES) {
    for (const name of readdirSync(path.join(ROOT, directory)).filter((entry) => entry.endsWith('.ts'))) {
      const file = `${directory}/${name}`;
      for (const { line, symbol } of linesWithSymbol(file)) {
        if (isComment(line) || !WRITE_SITE.some((pattern) => pattern.test(line))) continue;
        sites.add(`${file}#${symbol ?? '(module)'}`);
      }
    }
  }
  return sites;
}

/** Public async members of the WorkspaceStore class: its RPC surface plus the alarm. */
function storeRpcs(): Set<string> {
  const rpcs = new Set<string>();
  for (const line of source(STORE).split('\n')) {
    const match = line.match(/^ {2}async\s+(\w+)\s*\(/);
    if (match) rpcs.add(`${STORE}#${match[1]}`);
  }
  return rpcs;
}

function namedSymbols(): Set<string> {
  return new Set(CLOUDFLARE_FAULT_CUTS.flatMap((cut) => cut.code));
}

type Declaration = 'active' | 'skipped' | 'missing';

function escapeFor(quote: string, title: string): string {
  return title.replace(/\\/g, '\\\\').replace(new RegExp(quote, 'g'), `\\${quote}`);
}

/**
 * Whether `title` is the literal first argument of an `it`/`test` call
 * (including `it.each(...)(title` and node:test's `test(title`).
 */
function declaration(file: string, title: string): Declaration {
  const text = source(file);
  let found: Declaration = 'missing';
  for (const quote of ["'", '"', '`']) {
    const literal = `${quote}${escapeFor(quote, title)}${quote}`;
    for (let index = text.indexOf(literal); index !== -1; index = text.indexOf(literal, index + 1)) {
      const before = text.slice(Math.max(0, index - 400), index).trimEnd();
      const direct = before.match(/\b(it|test)((?:\.\w+)*)\($/);
      const eachCall = /\)\($/.test(before) ? before.match(/\b(it|test)((?:\.\w+)*)\.each\((?:(?!\b(?:it|test)\()[\s\S])*$/) : null;
      const call = direct ?? eachCall;
      if (!call) continue;
      if (/\.(?:skip|todo)\b/.test(call[2])) {
        found = 'skipped';
        continue;
      }
      return 'active';
    }
  }
  return found;
}

describe('Cloudflare fault manifest (VERIFY-01)', () => {
  it('names each cut once, with its cut, durable evidence, expected reply and next action', () => {
    const ids = CLOUDFLARE_FAULT_CUTS.map((cut) => cut.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const cut of CLOUDFLARE_FAULT_CUTS) {
      expect(cut.id, cut.id).toMatch(/^(?:CF|M0)-[A-Z0-9-]+$/);
      for (const field of ['cut', 'durableEvidence', 'expectedReply', 'nextAction'] as const) {
        expect(cut[field].trim(), `${cut.id}.${field}`).not.toBe('');
      }
      expect(cut.code.length, `${cut.id}.code`).toBeGreaterThan(0);
    }
  });

  it('gives every cut at least one covering test (a cut listed with coverage: [] fails here)', () => {
    const uncovered = CLOUDFLARE_FAULT_CUTS.filter((cut) => cut.coverage.length === 0).map((cut) => cut.id);
    expect(uncovered).toEqual([]);
  });

  it('points every coverage entry at an active test, by exact title, in a file a test lane runs', () => {
    const problems: string[] = [];
    for (const cut of CLOUDFLARE_FAULT_CUTS) {
      for (const { file, title } of cut.coverage) {
        if (!LANE_DIRECTORIES.some((directory) => file.startsWith(directory))) {
          problems.push(`${cut.id}: ${file} is not in a test lane`);
          continue;
        }
        if (!existsSync(path.join(ROOT, file))) {
          problems.push(`${cut.id}: ${file} does not exist`);
          continue;
        }
        if (/\b(?:describe|it|test)\.only\b/.test(source(file))) problems.push(`${cut.id}: ${file} focuses tests with .only`);
        const state = declaration(file, title);
        if (state !== 'active') problems.push(`${cut.id}: "${title}" is ${state} in ${file}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('names only symbols that exist in the named source files', () => {
    const problems: string[] = [];
    for (const reference of [...namedSymbols(), ...Object.keys(NON_CUT_SURFACES)]) {
      const [file, symbol] = reference.split('#');
      if (!existsSync(path.join(ROOT, file))) problems.push(`${reference}: no such file`);
      else if (!symbolsOf(file).has(symbol)) problems.push(`${reference}: no such function or member`);
    }
    expect(problems).toEqual([]);
  });

  it('accounts for every storage transaction, synchronous-KV write and alarm write in the Cloudflare sources', () => {
    const accounted = new Set([...namedSymbols(), ...Object.keys(NON_CUT_SURFACES)]);
    const sites = writeSites();
    // The scan must see the protocol's known cut sites, or it is broken.
    for (const known of [
      'cloudflare/workspace/completion.ts#persistCompletedInterview',
      'cloudflare/workspace/analysis.ts#claimAnalysisJob',
      'cloudflare/workspace/scheduler.ts#dispatch',
      'cloudflare/workspace/exports.ts#storeSnapshot',
      'cloudflare/workspace/migrate.ts#applyMigrations',
      `${STORE}#initialize`,
    ]) {
      expect(sites.has(known), known).toBe(true);
    }
    expect([...sites].filter((site) => !accounted.has(site)).sort()).toEqual([]);
  });

  it('accounts for every WorkspaceStore RPC and its alarm', () => {
    const accounted = new Set([...namedSymbols(), ...Object.keys(NON_CUT_SURFACES)]);
    const rpcs = storeRpcs();
    expect(rpcs.has(`${STORE}#persistCompletedInterview`)).toBe(true);
    expect(rpcs.has(`${STORE}#alarm`)).toBe(true);
    expect([...rpcs].filter((rpc) => !accounted.has(rpc)).sort()).toEqual([]);
  });

  it('keeps a non-cut surface out of the cut entries', () => {
    const named = namedSymbols();
    expect(Object.keys(NON_CUT_SURFACES).filter((surface) => named.has(surface))).toEqual([]);
  });
});
