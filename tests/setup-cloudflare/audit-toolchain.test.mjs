// The audit-toolchain lane's exception handling (scripts/cloudflare/audit-toolchain.mjs).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { advisoryId, blockingAdvisories, evaluate } from '../../scripts/cloudflare/audit-toolchain.mjs';
import { ROOT } from '../../scripts/cloudflare/lib.mjs';

const BRACES = {
  name: 'braces',
  severity: 'high',
  title: 'braces vulnerable to stack-exhaustion denial of service through deeply nested patterns',
  url: 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm',
  source: 1240992,
};

const report = (...vias) => ({
  vulnerabilities: {
    braces: { via: vias },
    micromatch: { via: ['braces'] },
    postcss: { via: [{ name: 'postcss-selector-parser', severity: 'moderate', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc' }] },
  },
});

const exception = { id: 'GHSA-vfj7-8cjw-p6xm', package: 'braces', reason: 'no patched release', expires: '2026-11-08' };

test('collects each blocking root advisory once and ignores moderate ones and package references', () => {
  assert.equal(advisoryId(BRACES.url), 'GHSA-vfj7-8cjw-p6xm');
  assert.deepEqual(blockingAdvisories(report(BRACES, BRACES)), [
    { id: 'GHSA-vfj7-8cjw-p6xm', package: 'braces', severity: 'high', title: BRACES.title },
  ]);
});

test('an unexpired exception allows only its own advisory and package', () => {
  const result = evaluate(blockingAdvisories(report(BRACES)), [exception], '2026-10-08');
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.allowed, ['braces GHSA-vfj7-8cjw-p6xm (until 2026-11-08)']);
  const other = { ...BRACES, name: 'next', severity: 'critical', url: 'https://github.com/advisories/GHSA-vcvr-r3jv-pc5j' };
  assert.equal(evaluate(blockingAdvisories(report(other)), [exception], '2026-10-08').failures.length, 1);
  const samePackageOtherAdvisory = { ...BRACES, url: 'https://github.com/advisories/GHSA-zzzz-zzzz-zzzz' };
  assert.equal(evaluate(blockingAdvisories(report(samePackageOtherAdvisory)), [exception], '2026-10-08').failures.length, 1);
});

test('the exception holds through its expiry date and fails the day after', () => {
  assert.deepEqual(evaluate(blockingAdvisories(report(BRACES)), [exception], '2026-11-08').failures, []);
  assert.match(evaluate(blockingAdvisories(report(BRACES)), [exception], '2026-11-09').failures[0], /expired on 2026-11-08/);
});

test('an exception without a reason or a valid expiry does not allow anything', () => {
  for (const broken of [{ ...exception, reason: '' }, { ...exception, expires: 'soon' }, { ...exception, expires: undefined }]) {
    assert.match(evaluate(blockingAdvisories(report(BRACES)), [broken], '2026-10-08').failures[0], /needs a reason and an expiry/);
  }
});

test('an exception no longer needed is reported for removal', () => {
  assert.deepEqual(evaluate([], [exception], '2026-10-08').unused, ['braces GHSA-vfj7-8cjw-p6xm']);
});

test('the committed exceptions are each dated, explained and short-lived', () => {
  const { exceptions } = JSON.parse(readFileSync(path.join(ROOT, 'scripts', 'cloudflare', 'audit-exceptions.json'), 'utf8'));
  for (const entry of exceptions) {
    assert.match(entry.id, /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/);
    assert.ok(entry.package && entry.reason && entry.recorded);
    const days = (Date.parse(entry.expires) - Date.parse(entry.recorded)) / 86_400_000;
    assert.ok(days > 0 && days <= 45, `${entry.id} must expire within 45 days of being recorded`);
  }
});
