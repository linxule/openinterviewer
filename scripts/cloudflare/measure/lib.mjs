// Shared defaults for the artifact measurement scripts in this directory
// (evidence/MEASUREMENTS.md). Every default is repository-relative, so the
// scripts run from any working directory; explicit arguments resolve against
// the current directory. Outputs default to dist/cloudflare/measure/, which is
// generated and ignored.

import { mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { ROOT } from '../lib.mjs';

export { ROOT };

export const WORKER_JS = path.join(ROOT, 'dist', 'cloudflare', 'artifact', 'worker', 'worker.js');
export const WORKER_MAP = `${WORKER_JS}.map`;
export const SERVER_FUNCTION_DIR = path.join(ROOT, '.open-next', 'server-functions', 'default');
export const HANDLER_META = path.join(SERVER_FUNCTION_DIR, 'handler.mjs.meta.json');
export const MEASURE_DIR = path.join(ROOT, 'dist', 'cloudflare', 'measure');

/** `arg` resolved against the working directory, or the default (a value, or a function called only when needed). */
export function argOr(arg, fallback) {
  if (arg !== undefined) return path.resolve(arg);
  return typeof fallback === 'function' ? fallback() : fallback;
}

/** A file in dist/cloudflare/measure/ (an earlier script's output). */
export function measurePath(name) {
  return path.join(MEASURE_DIR, name);
}

/** A default output file in dist/cloudflare/measure/, creating the directory. */
export function measureOutput(name) {
  mkdirSync(MEASURE_DIR, { recursive: true });
  return measurePath(name);
}

/** Files in dist/cloudflare/measure/ with the given extension, sorted. */
export function measureInputs(extension) {
  try {
    return readdirSync(MEASURE_DIR).filter((name) => name.endsWith(extension)).sort().map((name) => path.join(MEASURE_DIR, name));
  } catch {
    return [];
  }
}

/** A package from the repository's node_modules (acorn arrives with eslint and vite). */
export function requireFromRepo(id) {
  return createRequire(path.join(ROOT, 'package.json'))(id);
}
