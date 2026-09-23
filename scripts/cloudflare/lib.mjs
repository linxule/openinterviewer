// Shared helpers for the Cloudflare release, deploy, setup and operator
// scripts. Node built-ins only. Never prints secret values.

import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);

/** Parse JSON with // and /* comments and trailing commas (wrangler.jsonc). */
export function parseJsonc(text) {
  let out = '';
  let inString = false;
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (inString) {
      out += char;
      if (char === '\\') {
        out += next ?? '';
        i += 1;
      } else if (char === quote) {
        inString = false;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      out += char;
      continue;
    }
    if (char === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (char === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    out += char;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

export function readJsonc(file) {
  return parseJsonc(readFileSync(file, 'utf8'));
}

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function sha256File(file) {
  return sha256(readFileSync(file));
}

/** Deterministic digest of a directory tree: sorted relative paths + file digests. */
export function sha256Tree(dir) {
  const entries = [];
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const full = path.join(current, name);
      const stats = statSync(full);
      if (stats.isDirectory()) walk(full);
      else entries.push(`${path.relative(dir, full).split(path.sep).join('/')}\u0000${sha256File(full)}`);
    }
  };
  walk(dir);
  return { sha256: sha256(entries.join('\n')), files: entries.length };
}

export function treeBytes(dir) {
  let total = 0;
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      const stats = statSync(full);
      if (stats.isDirectory()) walk(full);
      else total += stats.size;
    }
  };
  walk(dir);
  return total;
}

export function git(args, cwd = ROOT) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

export function gitState(cwd = ROOT) {
  const commit = git(['rev-parse', 'HEAD'], cwd);
  const dirty = git(['status', '--porcelain', '--untracked-files=no'], cwd).length > 0;
  return { commit, dirty };
}

/**
 * Secret-bearing local files OpenNext would inline into the Worker bundle
 * (.env*) or wrangler would load for local runs (.dev.vars*). Templates are
 * allowed.
 */
export function secretBearingLocalFiles(dir = ROOT) {
  return readdirSync(dir).filter((name) => {
    if (name === '.env.example' || name === '.dev.vars.example') return false;
    return name === '.env' || name.startsWith('.env.') || name === '.dev.vars' || name.startsWith('.dev.vars.');
  });
}

export function installedVersion(pkg, cwd = ROOT) {
  try {
    return JSON.parse(readFileSync(path.join(cwd, 'node_modules', pkg, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

export function binPath(name, cwd = ROOT) {
  const candidate = path.join(cwd, 'node_modules', '.bin', name);
  if (!existsSync(candidate)) throw new Error(`Missing local binary ${name}; run npm ci`);
  return candidate;
}

/**
 * Run a command with an explicit, minimal environment. Output streams to the
 * terminal unless `capture` is set. Rejects on non-zero exit.
 */
export function run(command, args, { cwd = ROOT, env, capture = false, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: [input === undefined ? 'ignore' : 'pipe', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'],
    });
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
    }
    if (input !== undefined) {
      child.stdin.end(input);
    }
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const error = new Error(`${path.basename(command)} exited with ${code}`);
        error.code = code;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

/** Minimal environment for build/deploy subprocesses: no inherited secrets. */
export function minimalEnv(extra = {}) {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'CI', 'LANG', 'TERM', 'SHELL', 'USER'];
  const env = {};
  for (const name of keep) if (process.env[name] !== undefined) env[name] = process.env[name];
  return { ...env, NEXT_TELEMETRY_DISABLED: '1', WRANGLER_SEND_METRICS: 'false', ...extra };
}

export function fail(message, code = 1) {
  console.error(`error: ${message}`);
  process.exit(code);
}
