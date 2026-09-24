// update and verify against a simulated Cloudflare account.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { readJsonc } from '../../scripts/cloudflare/lib.mjs';
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

/** The deployed Worker (not the local config) switched to a valid Cloudflare AI Gateway route. */
function onGateway(state) {
  const worker = state.workers['oi-acme'];
  Object.assign(worker.vars, { AI_TRANSPORT: 'cloudflare-gateway', CF_AI_GATEWAY_ACCOUNT_ID: 'a'.repeat(32), CF_AI_GATEWAY_ID: 'oi-acme' });
  worker.secrets.CF_AI_GATEWAY_TOKEN = 'fixture-digest';
}

function holdOnGateway(state) {
  onGateway(state);
  for (const object of Object.values(state.objects)) object.maintenance = 'draining';
}

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
    assert.equal(latest.argv.includes('--bootstrap'), false, 'an update never passes --bootstrap');
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

  // An interrupted --change-provider: the receipt records the pending change
  // before any remote write, and rerunning the same update finishes it.
  const CLAUDE_KEY = 'sk-ant-fixture-0123456789abcdef';
  const CHANGE = [...UPDATE, '--provider', 'claude', '--change-provider', '--secrets-stdin'];
  async function interruptedChange(t, when, at = 'deploy') {
    const sandbox = await installed(t);
    sandbox.newCommit(NEXT_COMMIT);
    sandbox.update((state) => { state.failures.push({ at, when }); });
    const run = await sandbox.run('update', CHANGE, { input: JSON.stringify({ ANTHROPIC_API_KEY: CLAUDE_KEY }) });
    assert.equal(run.code, 1, run.output);
    assert.match(run.stderr, /rerun this update \(--provider claude --change-provider\)/);
    const receipt = sandbox.receipt();
    assert.equal(receipt.provider, 'gemini');
    assert.equal(receipt.providerHistory, undefined);
    assert.deepEqual([receipt.pendingChange.kind, receipt.pendingChange.from, receipt.pendingChange.to], ['provider', 'gemini', 'claude']);
    return { sandbox, run };
  }

  for (const [label, at, when, deployed, config] of [
    ['a deploy that failed before upload', 'deploy', 'before', 'gemini', 'claude'],
    ['a lost reply after the upload landed', 'deploy', 'after', 'claude', 'claude'],
    ['a lost reply from the key upload', 'secret bulk', 'after', 'gemini', 'gemini'],
  ]) {
    test(`update --change-provider resumes after ${label} and records the change once`, async (t) => {
      const { sandbox, run: first } = await interruptedChange(t, when, at);
      assert.equal(sandbox.state().workers['oi-acme'].vars.AI_PROVIDER, deployed);
      assert.equal(sandbox.config().vars.AI_PROVIDER, config);
      const bulk = sandbox.state().secretBulkCalls.length;
      const deploys = sandbox.state().deploys.length;

      const again = await sandbox.run('update', CHANGE);
      assert.equal(again.code, 0, again.output);
      assert.doesNotMatch(again.output, /drift detected/);
      const state = sandbox.state();
      assert.equal(state.secretBulkCalls.length, bulk, 'the bound key is not uploaded again');
      assert.equal(state.deploys.length, deploys + 1);
      assert.equal(state.deploys.at(-1).vars.AI_PROVIDER, 'claude');
      const receipt = sandbox.receipt();
      assert.equal(receipt.provider, 'claude');
      assert.equal(receipt.pendingChange, undefined);
      assert.deepEqual(receipt.providerKeys, ['gemini', 'claude']);
      assert.deepEqual(receipt.providerHistory.map(({ from, to }) => [from, to]), [['gemini', 'claude']]);

      const plain = await sandbox.run('update', UPDATE);
      assert.equal(plain.code, 0, plain.output);
      assert.equal(sandbox.receipt().providerHistory.length, 1, 'no duplicate history entry');
      assertNoSecretLeak(sandbox, [first, again, plain], [CLAUDE_KEY]);
    });
  }

  test('a pending provider change refuses any other change or command until it is finished', async (t) => {
    const { sandbox } = await interruptedChange(t, 'after');
    const configText = readFileSync(path.join(sandbox.installDir(), 'wrangler.jsonc'), 'utf8');
    const receiptText = readFileSync(path.join(sandbox.installDir(), 'receipt.json'), 'utf8');
    const deploys = sandbox.state().deploys.length;
    const bulk = sandbox.state().secretBulkCalls.length;
    for (const [command, args] of [
      ['update', [...UPDATE, '--provider', 'openai', '--change-provider', '--secrets-stdin']],
      ['update', [...UPDATE, '--provider', 'gemini', '--change-provider']],
      ['update', UPDATE],
      ['resume', ['--install', 'acme', '--env', 'production', '--yes']],
      ['config', ['--install', 'acme', '--env', 'production']],
    ]) {
      const run = await sandbox.run(command, args, { input: JSON.stringify({ OPENAI_API_KEY: 'sk-fixture-openai-0123456789' }) });
      assert.equal(run.code, 2, `${command} ${args.join(' ')}\n${run.output}`);
      assert.match(run.stderr, /provider change from gemini to claude .*has not finished/);
      assert.match(run.stderr, /update --provider claude --change-provider/);
    }
    const plan = await sandbox.run('plan', ['--install', 'acme', '--env', 'production', '--json']);
    assert.equal(plan.code, 0, plan.output);
    assert.ok(JSON.parse(plan.stdout).notes.some((note) => /change from gemini to claude has not finished/.test(note)));
    assert.equal(sandbox.state().deploys.length, deploys);
    assert.equal(sandbox.state().secretBulkCalls.length, bulk);
    assert.equal(readFileSync(path.join(sandbox.installDir(), 'wrangler.jsonc'), 'utf8'), configText);
    assert.equal(readFileSync(path.join(sandbox.installDir(), 'receipt.json'), 'utf8'), receiptText);
  });

  for (const [label, edit] of [
    ['an unrelated hand edit', (text) => text.replace(/"WORKSPACE_ID": "ws_[a-f0-9]+"/, `"WORKSPACE_ID": "ws_${'0'.repeat(32)}"`)],
    ['a provider on neither side of the change', (text) => text.replace('"AI_PROVIDER": "claude"', '"AI_PROVIDER": "openai"')],
  ]) {
    test(`a pending provider change still refuses ${label} in the installation config`, async (t) => {
      const { sandbox } = await interruptedChange(t, 'before');
      const file = path.join(sandbox.installDir(), 'wrangler.jsonc');
      writeFileSync(file, edit(readFileSync(file, 'utf8')));
      const deploys = sandbox.state().deploys.length;
      const run = await sandbox.run('update', CHANGE);
      assert.equal(run.code, 2, run.output);
      assert.match(run.stderr, /drift detected; nothing was changed:\n\s+- installation config vars\.(WORKSPACE_ID|AI_PROVIDER)/);
      assert.equal(sandbox.state().deploys.length, deploys);
      assert.equal(sandbox.receipt().provider, 'gemini');
    });
  }

  test('without a pending change, a config already switched to another provider is drift', async (t) => {
    const sandbox = await installed(t);
    const file = path.join(sandbox.installDir(), 'wrangler.jsonc');
    writeFileSync(file, readFileSync(file, 'utf8').replace('"AI_PROVIDER": "gemini"', '"AI_PROVIDER": "claude"'));
    sandbox.newCommit(NEXT_COMMIT);
    const deploys = sandbox.state().deploys.length;
    const run = await sandbox.run('update', CHANGE, { input: JSON.stringify({ ANTHROPIC_API_KEY: CLAUDE_KEY }) });
    assert.equal(run.code, 2, run.output);
    assert.match(run.stderr, /installation config vars\.AI_PROVIDER: expected "gemini", found "claude"/);
    assert.equal(sandbox.state().deploys.length, deploys);
    assert.equal(sandbox.receipt().pendingChange, undefined, 'a refused update records no pending change');
  });

  test('a provider change whose key input is rejected records nothing and changes nothing', async (t) => {
    const sandbox = await installed(t);
    sandbox.newCommit(NEXT_COMMIT);
    const receiptText = readFileSync(path.join(sandbox.installDir(), 'receipt.json'), 'utf8');
    const deploys = sandbox.state().deploys.length;
    const run = await sandbox.run('update', CHANGE, { input: JSON.stringify({}) });
    assert.notEqual(run.code, 0, run.output);
    assert.match(run.stderr, /ANTHROPIC_API_KEY/);
    assert.equal(readFileSync(path.join(sandbox.installDir(), 'receipt.json'), 'utf8'), receiptText);
    assert.equal(sandbox.state().deploys.length, deploys);
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

  for (const [label, prepare, code, status] of [
    ['a held workspace', (state) => { for (const object of Object.values(state.objects)) object.maintenance = 'draining'; }, 3, 'held-maintenance'],
    ['a held workspace whose Worker runs another AI transport', holdOnGateway, 1, 'not-ready'],
    ['a ready Worker on another AI transport', onGateway, 1, 'not-ready'],
  ]) {
    test(`verify reports ${label} as ${status}`, async (t) => {
      const sandbox = await installed(t);
      sandbox.update(prepare);
      const run = await sandbox.run('verify', ['--install', 'acme', '--env', 'production', '--json']);
      assert.equal(run.code, code, run.output);
      const result = JSON.parse(run.stdout);
      assert.equal(result.status, status);
      assert.equal(result.aiTransport, 'direct');
      assert.deepEqual(result.config.diffs, []);
      assert.equal(result.checks.find((check) => check.id === 'mode.matches').detail.includes(`aiTransport=${status === 'not-ready' ? 'cloudflare-gateway' : 'direct'}`), true);
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

  for (const [label, edit, pattern] of [
    ['gateway identifiers on a direct installation', (vars) => ({ ...vars, CF_AI_GATEWAY_ACCOUNT_ID: 'a'.repeat(32), CF_AI_GATEWAY_ID: 'oi-acme' }), /vars\.CF_AI_GATEWAY_ACCOUNT_ID[\s\S]*vars\.CF_AI_GATEWAY_ID/],
    ['the gateway transport on a direct installation', (vars) => ({ ...vars, AI_TRANSPORT: 'cloudflare-gateway' }), /vars\.AI_TRANSPORT/],
  ]) {
    test(`verify reports config-mismatch for ${label} (RT-11)`, async (t) => {
      const sandbox = await installed(t);
      const file = path.join(sandbox.installDir(), 'wrangler.jsonc');
      const config = readJsonc(file);
      config.vars = edit(config.vars);
      writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
      const run = await sandbox.run('verify', ['--install', 'acme', '--env', 'production', '--json']);
      assert.equal(run.code, 1, run.output);
      const result = JSON.parse(run.stdout);
      assert.equal(result.status, 'config-mismatch');
      assert.match(result.config.diffs.join('\n'), pattern);
    });
  }

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

  test('update never deploys a bootstrap config, even from a receipt whose phases are inconsistent', async (t) => {
    const sandbox = await installed(t);
    const file = path.join(sandbox.installDir(), 'receipt.json');
    const receipt = JSON.parse(readFileSync(file, 'utf8'));
    delete receipt.phases['workspace-init'];
    writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
    const configText = readFileSync(path.join(sandbox.installDir(), 'wrangler.jsonc'), 'utf8');
    sandbox.newCommit(NEXT_COMMIT);
    const deploys = sandbox.state().deploys.length;
    const run = await sandbox.run('update', UPDATE);
    assert.equal(run.code, 2, run.output);
    assert.match(run.stderr, /refusing to deploy \(update\) with WORKSPACE_BOOTSTRAP 'open'/);
    assert.equal(sandbox.state().deploys.length, deploys);
    assert.equal(readFileSync(path.join(sandbox.installDir(), 'wrangler.jsonc'), 'utf8'), configText, 'the installation config is left as it was');
  });

  // verify --config: the receipt-less check the CI promotion job runs after
  // deploying vars.CLOUDFLARE_INSTALL_CONFIG.
  const promoted = (sandbox, mutate = () => {}) => {
    const config = sandbox.config();
    mutate(config);
    const file = path.join(sandbox.dir, 'promoted wrangler.json');
    writeFileSync(file, JSON.stringify(config));
    return file;
  };

  test('verify --config probes the configured APP_BASE_URL like verify, without reading or writing a receipt', async (t) => {
    const sandbox = await installed(t);
    const receiptText = readFileSync(path.join(sandbox.installDir(), 'receipt.json'), 'utf8');
    const before = sandbox.state();
    const run = await sandbox.run('verify', ['--config', promoted(sandbox), '--json'], { extraArgs: false });
    assert.equal(run.code, 0, run.output);
    const result = JSON.parse(run.stdout);
    assert.equal(result.source, 'config');
    assert.equal(result.status, 'ready');
    assert.equal(result.worker, 'oi-acme');
    assert.deepEqual(result.targets, [{ role: 'origin', url: ORIGIN, status: 'ready' }]);
    assert.deepEqual(result.config, { ok: true, diffs: [], templateDrift: [] });
    assert.deepEqual(result.checks.filter((check) => !check.ok), []);
    assert.deepEqual(result.checks.map((check) => check.id).sort(), [
      'health.analysisQueue', 'health.configuration', 'health.noRedis', 'health.ready', 'health.response', 'health.target', 'health.workspaceStore',
      'mode.matches', 'mode.response', 'readiness.analysisExecution', 'readiness.mode', 'readiness.noRedisErrors', 'readiness.ready', 'readiness.response',
    ]);
    assert.ok(result.limitations.some((line) => /no installer receipt is read or updated/.test(line)));
    assert.ok(result.limitations.some((line) => /Only APP_BASE_URL is probed/.test(line)));
    assert.match(run.stderr, /from .*promoted wrangler\.json \(no receipt\)/);
    assert.equal(readFileSync(path.join(sandbox.installDir(), 'receipt.json'), 'utf8'), receiptText);
    const after = sandbox.state();
    assert.equal(mutations(after).length, mutations(before).length);
    assert.deepEqual(
      after.http.requests.slice(before.http.requests.length).map((request) => [request.origin, request.path]),
      [[ORIGIN, '/api/health/ready'], [ORIGIN, '/api/config/readiness'], [ORIGIN, '/api/config/mode']],
    );
  });

  for (const [label, prepare, mutate, code, status, detail] of [
    ['a bootstrap config', null, (config) => { config.vars.WORKSPACE_BOOTSTRAP = 'open'; }, 1, 'config-mismatch', /WORKSPACE_BOOTSTRAP is "open"/],
    ['a config without an origin', null, (config) => { config.vars.APP_BASE_URL = ''; }, 1, 'config-mismatch', /vars\.APP_BASE_URL is empty/],
    ['a non-HTTPS origin', null, (config) => { config.vars.APP_BASE_URL = 'http://interviews.example.org'; }, 1, 'config-mismatch', /vars\.APP_BASE_URL: /],
    ['a Node deployment target', null, (config) => { config.vars.DEPLOYMENT_TARGET = 'node'; }, 1, 'config-mismatch', /vars\.DEPLOYMENT_TARGET: expected "cloudflare"/],
    ['a malformed workspace id', null, (config) => { config.vars.WORKSPACE_ID = 'ws_nope'; }, 1, 'config-mismatch', /vars\.WORKSPACE_ID is not ws_/],
    ['an unsupported jurisdiction', null, (config) => { config.vars.WORKSPACE_JURISDICTION = 'us'; }, 1, 'config-mismatch', /vars\.WORKSPACE_JURISDICTION "us" is not eu, fedramp or empty/],
    // RT-11 both directions: the Worker would report not-ready after a CI promotion of either config.
    ['gateway identifiers on direct', null, (config) => { config.vars.CF_AI_GATEWAY_ACCOUNT_ID = 'a'.repeat(32); config.vars.CF_AI_GATEWAY_ID = 'oi-acme'; }, 1, 'config-mismatch', /must be empty with AI_TRANSPORT "direct"/],
    ['a gateway account id alone on direct', null, (config) => { config.vars.CF_AI_GATEWAY_ACCOUNT_ID = 'a'.repeat(32); }, 1, 'config-mismatch', /must be empty with AI_TRANSPORT "direct"/],
    ['the gateway transport without identifiers', null, (config) => { config.vars.AI_TRANSPORT = 'cloudflare-gateway'; }, 1, 'config-mismatch', /vars\.CF_AI_GATEWAY_ACCOUNT_ID is empty[\s\S]*vars\.CF_AI_GATEWAY_ID is empty/],
    ['the gateway transport with the default gateway', null, (config) => { Object.assign(config.vars, { AI_TRANSPORT: 'cloudflare-gateway', CF_AI_GATEWAY_ACCOUNT_ID: 'a'.repeat(32), CF_AI_GATEWAY_ID: 'default' }); }, 1, 'config-mismatch', /CF_AI_GATEWAY_ID is not a gateway id other than default/],
    ['the gateway transport with a malformed account id', null, (config) => { Object.assign(config.vars, { AI_TRANSPORT: 'cloudflare-gateway', CF_AI_GATEWAY_ACCOUNT_ID: 'A'.repeat(32), CF_AI_GATEWAY_ID: 'oi-acme' }); }, 1, 'config-mismatch', /CF_AI_GATEWAY_ACCOUNT_ID is not a 32-character/],
    ['a not-ready deployment', (state) => { state.http.forceNotReady = true; }, null, 1, 'not-ready', null],
    ['an origin no Worker answers', null, (config) => { config.vars.APP_BASE_URL = 'https://elsewhere.example.org'; }, 1, 'not-ready', null],
    ['a held (drained) workspace', (state) => { for (const object of Object.values(state.objects)) object.maintenance = 'draining'; }, null, 3, 'held-maintenance', null],
    // RT-11: a held Worker on another transport than the config is not "held", it is not ready.
    ['a held workspace whose Worker runs the gateway transport', (state) => { holdOnGateway(state); }, null, 1, 'not-ready', null],
    ['a ready Worker on the gateway transport', (state) => { onGateway(state); }, null, 1, 'not-ready', null],
  ]) {
    test(`verify --config reports ${label}`, async (t) => {
      const sandbox = await installed(t);
      if (prepare) sandbox.update(prepare);
      const before = sandbox.state().http.requests.length;
      const run = await sandbox.run('verify', ['--config', promoted(sandbox, mutate ?? undefined), '--wait-seconds', '2', '--json'], { extraArgs: false });
      assert.equal(run.code, code, run.output);
      const result = JSON.parse(run.stdout);
      assert.equal(result.status, status);
      if (detail) assert.match(result.config.diffs.join('\n'), detail);
      if (status === 'held-maintenance') {
        assert.equal(sandbox.state().http.requests.length - before, 3, 'a held workspace settles the wait after one probe');
      }
    });
  }

  test('verify --config refuses a missing config and options that need a receipt', async (t) => {
    const sandbox = await installed(t);
    const missing = await sandbox.run('verify', ['--config', path.join(sandbox.dir, 'absent.json')], { extraArgs: false });
    assert.equal(missing.code, 2, missing.output);
    assert.match(missing.stderr, /absent\.json does not exist/);
    const mixed = await sandbox.run('verify', ['--config', promoted(sandbox), '--install', 'acme', '--env', 'production'], { extraArgs: false });
    assert.equal(mixed.code, 2, mixed.output);
    assert.match(mixed.stderr, /takes no --install, --env/);
    const other = await sandbox.run('plan', ['--config', promoted(sandbox), '--install', 'acme', '--env', 'production'], { extraArgs: false });
    assert.equal(other.code, 2, other.output);
    assert.match(other.stderr, /--config is only valid with verify/);
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
