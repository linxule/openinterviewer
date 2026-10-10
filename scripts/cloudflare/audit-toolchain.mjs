#!/usr/bin/env node
// The audit-toolchain release lane: `npm audit --include=dev`, failing on any
// high or critical advisory except one listed, unexpired, in
// audit-exceptions.json (by advisory ID and package). It fails closed: output
// it cannot read, an expired exception or an unlisted advisory fails the lane.
// An exception may name `onlyVia`: the direct devDependencies through which the
// package may be reached. Every run resolves the lockfile graph and fails if
// the package is reachable from any other direct dependency, or is not marked
// dev-only, so the exception lapses the moment its risk argument does.
// Production dependencies are audited separately with no exceptions.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BLOCKING = new Set(['high', 'critical']);

export function advisoryId(url) {
  const match = /\/(GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})\b/i.exec(url ?? '');
  return match ? match[1] : null;
}

/** Every distinct blocking root advisory in an `npm audit --json` report. */
export function blockingAdvisories(report) {
  const found = new Map();
  for (const vulnerability of Object.values(report?.vulnerabilities ?? {})) {
    for (const via of vulnerability.via ?? []) {
      if (typeof via !== 'object' || !via || !BLOCKING.has(via.severity)) continue;
      const id = advisoryId(via.url) ?? `source-${via.source}`;
      const key = `${id}:${via.name}`;
      if (!found.has(key)) found.set(key, { id, package: via.name, severity: via.severity, title: via.title ?? '' });
    }
  }
  return [...found.values()];
}

/**
 * The root's direct dependencies from which `name` is reachable in a lockfile
 * (lockfileVersion 2/3 `packages`), following Node's nested node_modules
 * resolution, plus whether every installed copy is marked dev-only.
 */
export function reachability(lock, name) {
  const packages = lock?.packages ?? {};
  const resolve = (from, dep) => {
    for (let base = from; ; base = base.slice(0, Math.max(0, base.lastIndexOf('/node_modules/')))) {
      const candidate = `${base ? `${base}/` : ''}node_modules/${dep}`;
      if (packages[candidate]) return candidate;
      if (!base) return null;
    }
  };
  const edges = (location) => {
    const entry = packages[location] ?? {};
    const names = Object.keys({ ...entry.dependencies, ...entry.optionalDependencies, ...entry.peerDependencies, ...(location === '' ? entry.devDependencies : {}) });
    return names.map((dep) => [dep, resolve(location, dep)]).filter(([, target]) => target);
  };
  const isTarget = (location) => location === `node_modules/${name}` || location.endsWith(`/node_modules/${name}`);
  const roots = new Set();
  for (const [direct, start] of edges('')) {
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length > 0) {
      const location = queue.shift();
      if (isTarget(location)) { roots.add(direct); break; }
      for (const [, next] of edges(location)) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  const copies = Object.entries(packages).filter(([location]) => isTarget(location));
  return { roots: [...roots].sort(), devOnly: copies.length > 0 && copies.every(([, entry]) => entry.dev === true) };
}

/** `today` is YYYY-MM-DD; an exception holds through its expiry date. */
export function evaluate(advisories, exceptions, today, lock = null) {
  const failures = [];
  const allowed = [];
  const used = new Set();
  for (const advisory of advisories) {
    const exception = exceptions.find((entry) => entry.id === advisory.id && entry.package === advisory.package);
    if (!exception) {
      failures.push(`${advisory.severity} ${advisory.package} ${advisory.id}: ${advisory.title}`);
      continue;
    }
    used.add(exception);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(exception.expires ?? '') || !exception.reason) {
      failures.push(`${advisory.package} ${advisory.id}: the exception needs a reason and an expiry date`);
    } else if (today > exception.expires) {
      failures.push(`${advisory.package} ${advisory.id}: the exception expired on ${exception.expires}`);
    } else if (exception.onlyVia && !scopeHolds(exception, lock, advisory.package)) {
      const { roots, devOnly } = reachability(lock, advisory.package);
      failures.push(`${advisory.package} ${advisory.id}: the exception allows it only via ${exception.onlyVia.join(', ')} (dev-only), but it is reached via ${roots.join(', ') || 'nothing resolvable'}${devOnly ? '' : ' and is not dev-only'}`);
    } else {
      allowed.push(`${advisory.package} ${advisory.id} (until ${exception.expires})`);
    }
  }
  function scopeHolds(entry, lockfile, name) {
    if (!Array.isArray(entry.onlyVia) || entry.onlyVia.length === 0 || !lockfile) return false;
    const { roots, devOnly } = reachability(lockfile, name);
    const devDependencies = lockfile.packages?.['']?.devDependencies ?? {};
    const dependencies = lockfile.packages?.['']?.dependencies ?? {};
    return devOnly && roots.length > 0 && roots.every((root) => entry.onlyVia.includes(root) && root in devDependencies && !(root in dependencies));
  }
  const unused = exceptions.filter((entry) => !used.has(entry)).map((entry) => `${entry.package} ${entry.id}`);
  return { failures, allowed, unused };
}

function main() {
  const exceptions = JSON.parse(readFileSync(path.join(HERE, 'audit-exceptions.json'), 'utf8')).exceptions ?? [];
  const run = spawnSync('npm', ['audit', '--include=dev', '--audit-level=high', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let report;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    process.stderr.write(`${run.stdout ?? ''}${run.stderr ?? ''}\naudit-toolchain: npm audit output could not be read; failing closed.\n`);
    process.exit(1);
  }
  if (report.error) {
    process.stderr.write(`audit-toolchain: npm audit failed: ${JSON.stringify(report.error)}\n`);
    process.exit(1);
  }
  const today = new Date().toISOString().slice(0, 10);
  const lock = JSON.parse(readFileSync(path.join(HERE, '..', '..', 'package-lock.json'), 'utf8'));
  const { failures, allowed, unused } = evaluate(blockingAdvisories(report), exceptions, today, lock);
  for (const line of allowed) console.log(`allowed by audit-exceptions.json: ${line}`);
  for (const line of unused) console.log(`unused exception, remove it from audit-exceptions.json: ${line}`);
  if (failures.length > 0) {
    for (const line of failures) console.error(`blocking: ${line}`);
    process.exit(1);
  }
  console.log('audit-toolchain: no blocking development advisories');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
