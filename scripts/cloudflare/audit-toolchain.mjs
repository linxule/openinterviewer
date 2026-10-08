#!/usr/bin/env node
// The audit-toolchain release lane: `npm audit --include=dev`, failing on any
// high or critical advisory except one listed, unexpired, in
// audit-exceptions.json (by advisory ID and package). It fails closed: output
// it cannot read, an expired exception or an unlisted advisory fails the lane.
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

/** `today` is YYYY-MM-DD; an exception holds through its expiry date. */
export function evaluate(advisories, exceptions, today) {
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
    } else {
      allowed.push(`${advisory.package} ${advisory.id} (until ${exception.expires})`);
    }
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
  const { failures, allowed, unused } = evaluate(blockingAdvisories(report), exceptions, today);
  for (const line of allowed) console.log(`allowed by audit-exceptions.json: ${line}`);
  for (const line of unused) console.log(`unused exception, remove it from audit-exceptions.json: ${line}`);
  if (failures.length > 0) {
    for (const line of failures) console.error(`blocking: ${line}`);
    process.exit(1);
  }
  console.log('audit-toolchain: no blocking development advisories');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
