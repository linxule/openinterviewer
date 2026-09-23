// update and verify against a simulated Cloudflare account.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { applyArgs, assertNoSecretLeak, buildArtifact, createSandbox, mutations, stdinSecrets } from './helpers.mjs';

const ORIGIN = 'https://oi-acme.fixture-sub.workers.dev';
const NEXT_COMMIT = '3'.repeat(40);

async function installed(t, overrides = {}) {
  const sandbox = await createSandbox(t, { state: { ...overrides } });
  const run = await sandbox.run('apply', applyArgs(sandbox), { input: stdinSecrets() });
  assert.equal(run.code, 0, run.output);
  return sandbox;
}

const UPDATE = ['--install', 'acme', '--env', 'production', '--yes'];

// Every test owns an isolated sandbox, so they run concurrently.
describe('setup:cloudflare update and verify', { concurrency: 6 }, () => {
  test('update deploys the new artifact with identical names and vars and never touches secrets', async (t) => {
    const sandbox = await installed(t);
    const before = sandbox.state();
    const receiptBefore = sandbox.receipt();
    sandbox.newCommit(NEXT_COMMIT);

    const run = await sandbox.run('update', UPDATE);
    assert.equal(run.code, 0, run.output);
    const after = sandbox.state();
    assert.equal(after.deploys.length, before.deploys.length + 1);
    const [previous, latest] = after.deploys.slice(-2);
    assert.equal(latest.name, previous.name);
    assert.equal(latest.account_id, previous.account_id);
    assert.deepEqual(latest.vars, previous.vars);
    assert.deepEqual(latest.queues, previous.queues);
    assert.equal(latest.vars.WORKSPACE_BOOTSTRAP, '');
    assert.deepEqual(after.secretBulkCalls, before.secretBulkCalls);
    assert.deepEqual(after.workers['oi-acme'].secrets, before.workers['oi-acme'].secrets);
    assert.deepEqual(after.queueCreates, before.queueCreates);
    assert.equal(Object.keys(after.objects).length, 1);

    const receipt = sandbox.receipt();
    assert.equal(receipt.epochFingerprint, receiptBefore.epochFingerprint);
    assert.equal(receipt.workspaceId, receiptBefore.workspaceId);
    assert.deepEqual(receipt.deployments.at(-1).purpose, 'update');
    assert.equal(receipt.deployments.at(-1).commit, NEXT_COMMIT);

    const again = await sandbox.run('update', UPDATE);
    assert.equal(again.code, 0, again.output);
    assert.deepEqual(sandbox.state().deploys.at(-1).vars, previous.vars);
  });

  for (const [label, prepare, args, pattern] of [
    ['a jurisdiction change', null, ['--jurisdiction', 'none'], /data migration/],
    ['a provider change without --change-provider', null, ['--provider', 'openai'], /Pass --change-provider/],
    ['an origin change', null, ['--origin', 'https://interviews.example.org'], /separate operation/],
    ['an artifact from another commit', (sandbox) => sandbox.update((state) => { state.git.commit = NEXT_COMMIT; }), [], /different commit/],
    ['a failed release check (production unchanged)', (sandbox) => {
      sandbox.update((state) => { state.git.commit = NEXT_COMMIT; });
      buildArtifact(sandbox.artifactDir, NEXT_COMMIT, { status: 'failed' });
    }, [], /release-check receipt is not passing/],
    ['a deleted queue', (sandbox) => sandbox.update((state) => { delete state.queues['oi-acme-analysis-dlq']; }), [], /queue oi-acme-analysis-dlq: recorded in the receipt, missing/],
    ['a missing secret', (sandbox) => sandbox.update((state) => { delete state.workers['oi-acme'].secrets.RATE_LIMIT_SALT; }), [], /secret RATE_LIMIT_SALT: missing/],
    ['a hand-edited installation config', (sandbox) => {
      const file = path.join(sandbox.installDir(), 'wrangler.jsonc');
      writeFileSync(file, readFileSync(file, 'utf8').replace(/"WORKSPACE_ID": "ws_[a-f0-9]+"/, `"WORKSPACE_ID": "ws_${'0'.repeat(32)}"`));
    }, [], /installation config vars\.WORKSPACE_ID/],
    ['a missing Worker', (sandbox) => sandbox.update((state) => { delete state.workers['oi-acme']; }), [], /was not found/],
    ['an account change', null, ['--account-id', 'b'.repeat(32)], /update refused:\n\s+- account: installed a{32}, requested b{32}/],
    ['a queue deleted and recreated under the same name', (sandbox) => sandbox.update((state) => {
      state.queues['oi-acme-analysis'] = { id: 'recreated-queue', createdAt: new Date().toISOString() };
    }), [], /queue oi-acme-analysis: id recreated-queue differs from the recorded/],
  ]) {
    test(`update refuses ${label} without deploying`, async (t) => {
      const sandbox = await installed(t);
      prepare?.(sandbox);
      const deploys = sandbox.state().deploys.length;
      const bulk = sandbox.state().secretBulkCalls.length;
      const run = await sandbox.run('update', [...UPDATE, ...args]);
      assert.equal(run.code, 2, run.output);
      assert.match(run.stderr, pattern);
      assert.equal(sandbox.state().deploys.length, deploys);
      assert.equal(sandbox.state().secretBulkCalls.length, bulk);
    });
  }

  test('update requires an explicit existing-install identity', async (t) => {
    const sandbox = await createSandbox(t);
    sandbox.update((state) => {
      state.workers['oi-acme'] = { secrets: {}, deployments: [{ at: '2026-01-01' }], vars: {} };
    });
    const run = await sandbox.run('update', UPDATE);
    assert.equal(run.code, 2, run.output);
    assert.match(run.stderr, /explicit existing-install identity/);
    assert.deepEqual(mutations(sandbox.state()), []);
  });

  test('update refuses an installation that has not finished installing', async (t) => {
    const sandbox = await createSandbox(t, { state: { failures: [{ at: 'deploy', when: 'before' }] } });
    assert.notEqual((await sandbox.run('apply', applyArgs(sandbox), { input: stdinSecrets() })).code, 0);
    const run = await sandbox.run('update', UPDATE);
    assert.equal(run.code, 2);
    assert.match(run.stderr, /not fully installed; run resume first/);
  });

  test('update --change-provider adds only the new provider key and switches AI_PROVIDER', async (t) => {
    const sandbox = await installed(t);
    const before = sandbox.state();
    sandbox.newCommit(NEXT_COMMIT);
    const run = await sandbox.run('update', [...UPDATE, '--provider', 'claude', '--change-provider', '--secrets-stdin'], {
      input: JSON.stringify({ ANTHROPIC_API_KEY: 'sk-ant-fixture-0123456789abcdef' }),
    });
    assert.equal(run.code, 0, run.output);
    const after = sandbox.state();
    assert.equal(after.secretBulkCalls.length, before.secretBulkCalls.length + 1);
    assert.deepEqual(after.secretBulkCalls.at(-1).names, ['ANTHROPIC_API_KEY']);
    const secrets = after.workers['oi-acme'].secrets;
    for (const [name, hash] of Object.entries(before.workers['oi-acme'].secrets)) assert.equal(secrets[name], hash, `${name} unchanged`);
    assert.equal(after.deploys.at(-1).vars.AI_PROVIDER, 'claude');
    const { AI_PROVIDER: _new, ...rest } = after.deploys.at(-1).vars;
    const { AI_PROVIDER: _old, ...previous } = before.deploys.at(-1).vars;
    assert.deepEqual(rest, previous);
    const receipt = sandbox.receipt();
    assert.equal(receipt.provider, 'claude');
    assert.deepEqual(receipt.providerHistory.map(({ from, to }) => [from, to]), [['gemini', 'claude']]);
    assertNoSecretLeak(sandbox, [run], ['sk-ant-fixture-0123456789abcdef']);
  });

  test('plan on an installed system reports reuse, refused changes and drift without writing', async (t) => {
    const sandbox = await installed(t);
    const before = sandbox.state();
    const receiptText = readFileSync(path.join(sandbox.installDir(), 'receipt.json'), 'utf8');
    const run = await sandbox.run('plan', ['--install', 'acme', '--env', 'production', '--jurisdiction', 'none', '--provider', 'openai', '--json']);
    assert.equal(run.code, 0, run.output);
    const plan = JSON.parse(run.stdout);
    assert.equal(plan.status, 'complete');
    assert.deepEqual(plan.resources.map((resource) => resource.action), ['reuse', 'reuse', 'reuse']);
    assert.equal(plan.secrets.alreadySet.length, 7);
    assert.deepEqual(plan.secrets.generate, []);
    assert.equal(plan.vars.WORKSPACE_BOOTSTRAP, '');
    assert.equal(plan.vars.APP_BASE_URL, ORIGIN);
    assert.match(plan.notes.join('\n'), /jurisdiction: installed eu; changing it is a data migration/);
    assert.match(plan.notes.join('\n'), /needs update --change-provider/);
    assert.equal(mutations(sandbox.state()).length, mutations(before).length);
    assert.equal(readFileSync(path.join(sandbox.installDir(), 'receipt.json'), 'utf8'), receiptText);

    sandbox.update((state) => { delete state.queues['oi-acme-analysis-dlq']; });
    const drifted = JSON.parse((await sandbox.run('plan', ['--install', 'acme', '--env', 'production', '--json'])).stdout);
    assert.equal(drifted.status, 'drift');
    assert.deepEqual(drifted.drift, ['oi-acme-analysis-dlq']);
  });

  for (const [label, maintenance, importTarget] of [
    ['a drained workspace (RUNBOOK: drain before deploy)', 'draining', false],
    ['a frozen import target', 'frozen', true],
  ]) {
    test(`update of ${label} deploys and reports the hold with exit 3, not a rollback`, async (t) => {
      const sandbox = await createSandbox(t, {});
      const install = await sandbox.run('apply', applyArgs(sandbox, { extra: importTarget ? ['--import-target'] : [] }), { input: stdinSecrets() });
      assert.equal(install.code, 0, install.output);
      sandbox.update((state) => { for (const object of Object.values(state.objects)) object.maintenance = maintenance; });
      sandbox.newCommit(NEXT_COMMIT);
      const deploys = sandbox.state().deploys.length;
      const run = await sandbox.run('update', UPDATE);
      assert.equal(run.code, 3, run.output);
      assert.equal(sandbox.state().deploys.length, deploys + 1);
      assert.match(run.stdout, /Deployed 333333333333 to oi-acme; the workspace is held in a maintenance state/);
      assert.match(run.stdout, /Run verify after reopening it/);
      assert.doesNotMatch(run.output, /Roll forward|rollback procedure/);
      assert.equal(sandbox.receipt().lastVerification.status, 'held-maintenance');
      assert.equal(sandbox.receipt().deployments.at(-1).commit, NEXT_COMMIT);
    });
  }

  test('update after an import target was reopened expects ready like any installation', async (t) => {
    const sandbox = await createSandbox(t, {});
    assert.equal((await sandbox.run('apply', applyArgs(sandbox, { extra: ['--import-target'] }), { input: stdinSecrets() })).code, 0);
    sandbox.update((state) => { for (const object of Object.values(state.objects)) object.maintenance = 'open'; });
    sandbox.newCommit(NEXT_COMMIT);
    const run = await sandbox.run('update', UPDATE);
    assert.equal(run.code, 0, run.output);
  });

  test('update with only receipt.json restored regenerates the installation config before any wrangler call uses it', async (t) => {
    const sandbox = await installed(t);
    rmSync(path.join(sandbox.installDir(), 'wrangler.jsonc'));
    sandbox.newCommit(NEXT_COMMIT);
    const before = sandbox.state().invocations.length;
    const run = await sandbox.run('update', UPDATE);
    assert.equal(run.code, 0, run.output);
    assert.match(run.stdout, /Regenerated the missing installation config/);
    const calls = sandbox.state().invocations.slice(before).filter((entry) => entry.argv.includes('--config'));
    assert.ok(calls.length > 0);
    // The fake wrangler fails like wrangler 4.136.3 when --config names a missing file.
    assert.ok(existsSync(path.join(sandbox.installDir(), 'wrangler.jsonc')));
    const [previous, latest] = sandbox.state().deploys.slice(-2);
    assert.deepEqual(latest.vars, previous.vars);
  });

  test('verify reports a ready installation and is read-only', async (t) => {
    const sandbox = await installed(t);
    const receiptFile = path.join(sandbox.installDir(), 'receipt.json');
    const receiptText = readFileSync(receiptFile, 'utf8');
    const before = sandbox.state();
    const run = await sandbox.run('verify', ['--install', 'acme', '--env', 'production', '--json']);
    assert.equal(run.code, 0, run.output);
    const result = JSON.parse(run.stdout);
    assert.equal(result.status, 'ready');
    assert.equal(result.origin, ORIGIN);
    assert.ok(result.checks.every((check) => check.ok));
    assert.equal(result.config.ok, true);
    assert.ok(result.limitations.some((line) => /binding presence only/.test(line)));
    assert.ok(result.limitations.some((line) => /alarm/.test(line)));
    assert.ok(result.limitations.some((line) => /deployed version and remote vars\/secrets are not read back/.test(line)));
    assert.ok(!result.limitations.some((line) => /custom origin/.test(line)), 'no custom-origin caveat for a workers.dev origin');
    assert.deepEqual(result.targets, [{ role: 'worker', url: ORIGIN, status: 'ready' }]);
    assert.match(run.stderr, /Not verified by this command/);
    assert.equal(readFileSync(receiptFile, 'utf8'), receiptText);
    const after = sandbox.state();
    assert.equal(mutations(after).length, mutations(before).length);
    assert.deepEqual(
      after.http.requests.slice(before.http.requests.length).map((request) => request.path),
      ['/api/health/ready', '/api/config/readiness', '/api/config/mode'],
    );
  });

  for (const [label, change, pattern, code] of [
    ['a not-ready workspace', (state) => { state.http.forceNotReady = true; }, /NOT READY/, 1],
    ['an unreachable origin', (state) => { state.http.down = true; }, /UNREACHABLE/, 1],
    ['a Redis requirement', (state) => { state.http.extraErrors = ['missing_standalone_redis_url']; }, /✗ readiness\.noRedisErrors/, 1],
    ['a missing binding', (state) => { state.http.extraErrors = ['missing_analysis_queue_binding']; }, /missing_analysis_queue_binding/, 1],
  ]) {
    test(`verify fails clearly on ${label}`, async (t) => {
      const sandbox = await installed(t);
      sandbox.update(change);
      const run = await sandbox.run('verify', ['--install', 'acme', '--env', 'production']);
      assert.equal(run.code, code, run.output);
      assert.match(run.stdout, pattern);
    });
  }

  test('verify fails when the installation config no longer matches the receipt', async (t) => {
    const sandbox = await installed(t);
    const file = path.join(sandbox.installDir(), 'wrangler.jsonc');
    writeFileSync(file, readFileSync(file, 'utf8').replace('"oi-acme-analysis-dlq"', '"renamed-dlq"'));
    const run = await sandbox.run('verify', ['--install', 'acme', '--env', 'production', '--json']);
    assert.equal(run.code, 1);
    const result = JSON.parse(run.stdout);
    assert.equal(result.status, 'config-mismatch');
    assert.match(result.config.diffs.join('\n'), /queue consumers/);
  });

  test('verify cannot pass without the Worker\'s own workers.dev URL', async (t) => {
    const sandbox = await installed(t);
    const file = path.join(sandbox.installDir(), 'receipt.json');
    const receipt = JSON.parse(readFileSync(file, 'utf8'));
    receipt.workersDevUrl = 'https://oi-other.fixture-sub.workers.dev';
    writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
    const run = await sandbox.run('verify', ['--install', 'acme', '--env', 'production', '--json']);
    assert.equal(run.code, 1, run.output);
    const result = JSON.parse(run.stdout);
    assert.equal(result.status, 'not-ready');
    assert.equal(result.checks.find((check) => check.id === 'worker.url').ok, false);
  });

  test('verify refuses an installation without an origin or receipt', async (t) => {
    const sandbox = await createSandbox(t, { state: { deploy: { refusePendingOrigin: true } } });
    const missing = await sandbox.run('verify', ['--install', 'acme', '--env', 'production']);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /no receipt/);
    // A deploy script that refuses an empty origin stops the installation before one exists.
    assert.notEqual((await sandbox.run('apply', applyArgs(sandbox), { input: stdinSecrets() })).code, 0);
    const noOrigin = await sandbox.run('verify', ['--install', 'acme', '--env', 'production']);
    assert.equal(noOrigin.code, 1);
    assert.match(noOrigin.stderr, /has no origin recorded yet; it is not ready/);
  });
});
