// plan / apply / resume against a simulated Cloudflare account. Asserts on
// the fake account's recorded effects (queue creations, secret uploads,
// deploys, argv) and on local state, not only on exit codes.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { ROOT, readJsonc } from '../../scripts/cloudflare/lib.mjs';
import { realConfigDrift } from './fixtures/deploy-config-drift.mjs';
import { ALL_SECRET_NAMES, PASSWORD, applyArgs, assertNoSecretLeak, buildArtifact, createSandbox, mutations, resumeArgs, stdinSecrets } from './helpers.mjs';

const template = readJsonc(path.join(ROOT, 'wrangler.jsonc'));
const digest = (value) => createHash('sha256').update(value).digest('hex');
const ORIGIN = 'https://oi-acme.fixture-sub.workers.dev';

// Every test owns an isolated sandbox, so they run concurrently.
describe('setup:cloudflare plan, apply and resume', { concurrency: 6 }, () => {
  test('plan is read-only and reports a new installation', async (t) => {
    const sandbox = await createSandbox(t);
    const run = await sandbox.run('plan', ['--install', 'acme', '--env', 'production', '--provider', 'gemini', '--json']);
    assert.equal(run.code, 0, run.output);
    const plan = JSON.parse(run.stdout);
    assert.equal(plan.status, 'new');
    assert.deepEqual(plan.resources.map((resource) => [resource.name, resource.action]), [
      ['oi-acme', 'create'],
      ['oi-acme-analysis', 'create'],
      ['oi-acme-analysis-dlq', 'create'],
    ]);
    assert.deepEqual(plan.secrets.request, ['ADMIN_PASSWORD', 'GEMINI_API_KEY']);
    assert.equal(plan.artifact.ready, true);
    assert.equal(plan.jurisdiction.value, null);
    assert.match(plan.billing.join(' '), /10 ms/);
    assert.equal(existsSync(sandbox.stateDir), false, 'plan must not create the state directory');
    const state = sandbox.state();
    assert.deepEqual(mutations(state), []);
    assert.deepEqual(state.http.requests, []);
    assert.deepEqual(Object.keys(state.workers), []);
  });

  test('fresh apply creates resources once, uploads every secret in one call and bootstraps the origin and workspace', async (t) => {
    const sandbox = await createSandbox(t);
    const run = await sandbox.run('apply', applyArgs(sandbox), { input: stdinSecrets() });
    assert.equal(run.code, 0, run.output);
    const state = sandbox.state();

    assert.deepEqual(state.queueCreates, ['oi-acme-analysis', 'oi-acme-analysis-dlq']);
    assert.equal(state.secretBulkCalls.length, 1);
    assert.deepEqual(state.secretBulkCalls[0].names, ALL_SECRET_NAMES);
    const bulk = state.invocations.filter((entry) => entry.argv[0] === 'secret' && entry.argv[1] === 'bulk');
    assert.equal(bulk.length, 1);
    assert.deepEqual(bulk[0].argv.slice(0, 4), ['secret', 'bulk', '--name', 'oi-acme']);

    // Initial deploy without origin, origin redeploy, bootstrap-clear redeploy.
    assert.deepEqual(state.deploys.map((deploy) => [deploy.vars.APP_BASE_URL, deploy.vars.WORKSPACE_BOOTSTRAP]), [
      ['', 'open'],
      [ORIGIN, 'open'],
      [ORIGIN, ''],
    ]);
    for (const deploy of state.deploys) {
      assert.equal(deploy.name, 'oi-acme');
      assert.equal(deploy.account_id, 'a'.repeat(32));
      assert.ok(deploy.argv.includes('--confirm'));
    }
    const objects = Object.values(state.objects);
    assert.equal(objects.length, 1, 'exactly one workspace object initialized');
    assert.equal(objects[0].bootstrap, 'open');

    const receipt = sandbox.receipt();
    assert.equal(receipt.origin, ORIGIN);
    assert.equal(receipt.originSource, 'workers.dev');
    assert.match(receipt.workspaceId, /^ws_[a-f0-9]{32}$/);
    assert.deepEqual(Object.keys(receipt.phases), ['preflight', 'identity', 'resources', 'config', 'deploy-initial', 'secrets', 'origin', 'workspace-init', 'bootstrap-clear', 'verify']);
    assert.deepEqual(receipt.deployments.map((entry) => entry.purpose), ['initial', 'origin', 'bootstrap-clear']);
    assert.equal(receipt.lastVerification.status, 'ready');

    const [uploaded] = sandbox.capturedSecrets();
    assert.equal(receipt.epochFingerprint, `sha256:${digest(uploaded.ANALYSIS_RECOVERY_EPOCH).slice(0, 16)}`);
    assert.match(uploaded.ANALYSIS_RECOVERY_EPOCH, /^ep_[a-f0-9]{32}$/);
    for (const name of ['SESSION_SECRET', 'PARTICIPANT_TOKEN_SECRET', 'RATE_LIMIT_SALT', 'OPERATOR_TOKEN']) {
      assert.match(uploaded[name], /^[A-Za-z0-9_-]{43}$/);
    }
    assert.equal(new Set(Object.values(uploaded)).size, 7);
    assert.equal(uploaded.ADMIN_PASSWORD, PASSWORD);

    assert.equal(statSync(sandbox.tokenFile).mode & 0o777, 0o600);
    assert.equal(readFileSync(sandbox.tokenFile, 'utf8').trim(), uploaded.OPERATOR_TOKEN);

    const config = sandbox.config();
    assert.deepEqual(realConfigDrift(template, config), []);
    assert.equal(config.vars.WORKSPACE_BOOTSTRAP, '');
    assert.equal(config.vars.APP_BASE_URL, ORIGIN);
    assert.equal(config.vars.WORKSPACE_ID, receipt.workspaceId);
    assert.deepEqual(state.workers['oi-acme'].vars, config.vars);

    assertNoSecretLeak(sandbox, [run]);
  });

  test('a deploy script that refuses an empty APP_BASE_URL stops discovery cleanly and resume --origin completes', async (t) => {
    const sandbox = await createSandbox(t, { state: { deploy: { refusePendingOrigin: true } } });
    const first = await sandbox.run('apply', applyArgs(sandbox), { input: stdinSecrets() });
    assert.notEqual(first.code, 0);
    assert.match(first.stderr, /refuses a configuration without APP_BASE_URL/);
    assert.match(first.stderr, /--origin https:\/\/oi-acme\.<account-subdomain>\.workers\.dev/);
    let state = sandbox.state();
    assert.deepEqual(state.deploys, []);
    assert.deepEqual(state.secretBulkCalls, []);
    assert.equal(sandbox.receipt().phases['deploy-initial'], undefined);

    const resumed = await sandbox.run('resume', ['--install', 'acme', '--env', 'production', '--origin', ORIGIN, '--operator-token-file', sandbox.tokenFile, '--secrets-stdin', '--yes'], { input: stdinSecrets() });
    assert.equal(resumed.code, 0, resumed.output);
    state = sandbox.state();
    assert.deepEqual(state.queueCreates, ['oi-acme-analysis', 'oi-acme-analysis-dlq']);
    assert.deepEqual(state.deploys.map((deploy) => [deploy.vars.APP_BASE_URL, deploy.vars.WORKSPACE_BOOTSTRAP]), [[ORIGIN, 'open'], [ORIGIN, '']]);
    assert.equal(sandbox.receipt().originSource, 'explicit');
    assert.equal(state.secretBulkCalls.length, 1);
  });

  test('an explicit custom origin is used from the first deploy; the workspace is initialized through the Worker\'s own URL', async (t) => {
    const sandbox = await createSandbox(t);
    const run = await sandbox.run('apply', applyArgs(sandbox, { extra: ['--origin', 'https://interviews.example.org'] }), { input: stdinSecrets() });
    assert.equal(run.code, 0, run.output);
    const state = sandbox.state();
    assert.deepEqual(state.deploys.map((deploy) => [deploy.vars.APP_BASE_URL, deploy.vars.WORKSPACE_BOOTSTRAP]), [
      ['https://interviews.example.org', 'open'],
      ['https://interviews.example.org', ''],
    ]);
    const receipt = sandbox.receipt();
    assert.equal(receipt.workersDevUrl, ORIGIN);
    // workspace-init polls the Worker itself; verify probes the Worker and the origin.
    assert.equal(state.http.requests[0].origin, ORIGIN, 'the first readiness request is workspace-init at the Worker');
    assert.deepEqual([...new Set(state.http.requests.map((request) => request.origin))].sort(), ['https://interviews.example.org', ORIGIN]);
    assert.match(run.stdout, /Routing of the custom origin to this Worker is not proven/);
    assert.deepEqual(receipt.lastVerification.targets, [{ role: 'worker', status: 'ready' }, { role: 'origin', status: 'ready' }]);
  });

  test('an explicit workers.dev origin that the deploy does not confirm is refused until corrected', async (t) => {
    const sandbox = await createSandbox(t);
    const wrong = 'https://oi-acme.other-sub.workers.dev';
    const first = await sandbox.run('apply', applyArgs(sandbox, { extra: ['--origin', wrong] }), { input: stdinSecrets() });
    assert.equal(first.code, 2, first.output);
    assert.match(first.stderr, /deploy reports https:\/\/oi-acme\.fixture-sub\.workers\.dev/);
    assert.equal(sandbox.receipt().phases.origin, undefined);
    const foreign = await sandbox.run('resume', ['--install', 'acme', '--env', 'production', '--origin', 'https://someone-else.fixture-sub.workers.dev', '--yes']);
    assert.equal(foreign.code, 2);
    assert.match(foreign.stderr, /not a workers\.dev URL of Worker oi-acme/);
    const fixed = await sandbox.run('resume', ['--install', 'acme', '--env', 'production', '--origin', ORIGIN, '--yes']);
    assert.equal(fixed.code, 0, fixed.output);
    assert.deepEqual(sandbox.state().deploys.map((deploy) => deploy.vars.APP_BASE_URL), [wrong, ORIGIN, ORIGIN]);
    assert.equal(sandbox.state().secretBulkCalls.length, 1);
  });

  test('interrupted resources phase (before the DLQ is created) resumes without duplicate queues', async (t) => {
    const sandbox = await createSandbox(t, { state: { failures: [{ at: 'queues create', target: 'oi-acme-analysis-dlq', when: 'before' }] } });
    const first = await sandbox.run('apply', applyArgs(sandbox), { input: stdinSecrets() });
    assert.notEqual(first.code, 0);
    const receipt = sandbox.receipt();
    assert.ok(receipt.phases.identity);
    assert.equal(receipt.phases.resources, undefined);
    assert.equal(receipt.resources['oi-acme-analysis-dlq'].id, undefined, 'a create that did not land records no id');
    const resumed = await sandbox.run('resume', resumeArgs(sandbox), { input: stdinSecrets() });
    assert.equal(resumed.code, 0, resumed.output);
    const state = sandbox.state();
    assert.deepEqual(state.queueCreates, ['oi-acme-analysis', 'oi-acme-analysis-dlq']);
    assert.equal(state.secretBulkCalls.length, 1);
    assert.equal(sandbox.receipt().workspaceId, receipt.workspaceId, 'the workspace identity is never regenerated');
    assert.equal(sandbox.receipt().resources['oi-acme-analysis-dlq'].id, state.queues['oi-acme-analysis-dlq'].id);
  });

  test('a queue create whose reply is lost is recognized by its creation time and never created twice', async (t) => {
    const sandbox = await createSandbox(t, { state: { failures: [{ at: 'queues create', target: 'oi-acme-analysis-dlq', when: 'after' }] } });
    const run = await sandbox.run('apply', applyArgs(sandbox), { input: stdinSecrets() });
    assert.equal(run.code, 0, run.output);
    const state = sandbox.state();
    assert.deepEqual(state.queueCreates, ['oi-acme-analysis', 'oi-acme-analysis-dlq']);
    const record = sandbox.receipt().resources['oi-acme-analysis-dlq'];
    assert.equal(record.id, state.queues['oi-acme-analysis-dlq'].id);
    assert.equal(record.createdAt, undefined, 'the lost reply was never observed as a successful create');
    assert.ok(record.observedAt);
  });

  test('interrupted initial deploy resumes without duplicating resources', async (t) => {
    const sandbox = await createSandbox(t, { state: { failures: [{ at: 'deploy', when: 'before' }] } });
    const first = await sandbox.run('apply', applyArgs(sandbox), { input: stdinSecrets() });
    assert.notEqual(first.code, 0);
    assert.match(first.stderr, /deploy \(initial\) failed/);
    assert.deepEqual(sandbox.state().deploys, []);
    const resumed = await sandbox.run('resume', ['--install', 'acme', '--env', 'production', '--operator-token-file', sandbox.tokenFile, '--secrets-stdin', '--yes'], { input: stdinSecrets() });
    assert.equal(resumed.code, 0, resumed.output);
    const state = sandbox.state();
    assert.equal(state.queueCreates.length, 2);
    assert.equal(state.deploys.length, 3);
    assert.equal(state.secretBulkCalls.length, 1);
  });

  test('a deploy whose reply is lost is replayed idempotently, never treated as foreign', async (t) => {
    const sandbox = await createSandbox(t, { state: { failures: [{ at: 'deploy', when: 'after' }] } });
    const first = await sandbox.run('apply', applyArgs(sandbox), { input: stdinSecrets() });
    assert.notEqual(first.code, 0);
    const resumed = await sandbox.run('resume', ['--install', 'acme', '--env', 'production', '--operator-token-file', sandbox.tokenFile, '--secrets-stdin', '--yes'], { input: stdinSecrets() });
    assert.equal(resumed.code, 0, resumed.output);
    assert.equal(sandbox.state().queueCreates.length, 2);
  });

  test('secrets interrupted before upload: resume uploads once with a fresh epoch (never set before)', async (t) => {
    const sandbox = await createSandbox(t, { state: { failures: [{ at: 'secret bulk', when: 'before' }] } });
    const first = await sandbox.run('apply', applyArgs(sandbox), { input: stdinSecrets() });
    assert.notEqual(first.code, 0);
    const interrupted = sandbox.receipt();
    assert.ok(interrupted.phases['deploy-initial']);
    assert.equal(interrupted.phases.secrets, undefined);
    assert.equal(sandbox.state().secretBulkCalls.length, 0);

    const resumed = await sandbox.run('resume', ['--install', 'acme', '--env', 'production', '--operator-token-file', sandbox.tokenFile, '--secrets-stdin', '--yes'], { input: stdinSecrets() });
    assert.equal(resumed.code, 0, resumed.output);
    const state = sandbox.state();
    assert.equal(state.secretBulkCalls.length, 1);
    const receipt = sandbox.receipt();
    const [uploaded] = sandbox.capturedSecrets();
    assert.notEqual(receipt.epochFingerprint, interrupted.epochFingerprint, 'an epoch that was never set is regenerated on resume');
    assert.equal(receipt.epochFingerprint, `sha256:${digest(uploaded.ANALYSIS_RECOVERY_EPOCH).slice(0, 16)}`);
    assert.equal(state.workers['oi-acme'].secrets.ANALYSIS_RECOVERY_EPOCH, digest(uploaded.ANALYSIS_RECOVERY_EPOCH));
    assert.equal(readFileSync(sandbox.tokenFile, 'utf8').trim(), uploaded.OPERATOR_TOKEN);
    assertNoSecretLeak(sandbox, [first, resumed]);
  });

  test('secrets uploaded but reply lost: resume keeps them and never regenerates the epoch', async (t) => {
    const sandbox = await createSandbox(t, { state: { failures: [{ at: 'secret bulk', when: 'after' }] } });
    const first = await sandbox.run('apply', applyArgs(sandbox), { input: stdinSecrets() });
    assert.notEqual(first.code, 0);
    const interrupted = sandbox.receipt();
    const hashes = { ...sandbox.state().workers['oi-acme'].secrets };
    assert.equal(sandbox.state().secretBulkCalls.length, 1);

    // No credential input is needed: the bound secrets are kept.
    const resumed = await sandbox.run('resume', ['--install', 'acme', '--env', 'production', '--yes']);
    assert.equal(resumed.code, 0, resumed.output);
    assert.match(resumed.stdout, /keeping them \(not regenerated\)/);
    const state = sandbox.state();
    assert.equal(state.secretBulkCalls.length, 1);
    assert.deepEqual(state.workers['oi-acme'].secrets, hashes);
    assert.equal(sandbox.receipt().epochFingerprint, interrupted.epochFingerprint);
    assertNoSecretLeak(sandbox, [first, resumed]);
  });

  test('apply and resume on a completed installation are no-ops', async (t) => {
    const sandbox = await createSandbox(t);
    assert.equal((await sandbox.run('apply', applyArgs(sandbox), { input: stdinSecrets() })).code, 0);
    const before = sandbox.state();
    const receiptText = readFileSync(path.join(sandbox.installDir(), 'receipt.json'), 'utf8');
    for (const [command, args] of [
      ['apply', applyArgs(sandbox)],
      ['resume', ['--install', 'acme', '--env', 'production', '--yes']],
    ]) {
      const run = await sandbox.run(command, args, { input: stdinSecrets() });
      assert.equal(run.code, 0, run.output);
      assert.match(run.stdout, /nothing to do/);
    }
    const after = sandbox.state();
    assert.equal(after.invocations.length, before.invocations.length, 'no tool was invoked');
    assert.deepEqual(after.secretBulkCalls, before.secretBulkCalls);
    assert.equal(readFileSync(path.join(sandbox.installDir(), 'receipt.json'), 'utf8'), receiptText);
  });

  for (const [label, seed] of [
    ['a queue', (state) => { state.queues['oi-acme-analysis'] = { id: 'foreign', createdAt: '2026-01-01' }; }],
    ['a dead-letter queue on a later page', (state) => {
      state.queuePageSize = 1;
      for (const name of ['aaa', 'bbb', 'oi-acme-analysis-dlq', 'zzz']) state.queues[name] = { id: name, createdAt: '2026-01-01' };
    }],
    ['a Worker', (state) => { state.workers['oi-acme'] = { secrets: {}, deployments: [{ at: '2026-01-01' }], vars: {} }; }],
  ]) {
    test(`a name collision with ${label} and no receipt is refused by plan and apply`, async (t) => {
      const sandbox = await createSandbox(t);
      sandbox.update(seed);
      const plan = await sandbox.run('plan', ['--install', 'acme', '--env', 'production']);
      assert.equal(plan.code, 2, plan.output);
      assert.match(plan.stdout, /COLLISION/);
      const apply = await sandbox.run('apply', applyArgs(sandbox), { input: stdinSecrets() });
      assert.equal(apply.code, 2, apply.output);
      assert.match(apply.stderr, /collision: .*no receipt claims them/);
      assert.deepEqual(mutations(sandbox.state()), []);
      assert.equal(existsSync(path.join(sandbox.installDir(), 'receipt.json')), false);
      assert.equal(existsSync(sandbox.tokenFile), false);
    });
  }

  for (const [label, change, pattern, secretOverrides = {}] of [
    ['an unready artifact', (sandbox) => sandbox.update((state) => { state.git.dirty = true; }), /uncommitted tracked changes/],
    ['an artifact built from another commit', (sandbox) => sandbox.update((state) => { state.git.commit = '2'.repeat(40); }), /different commit/],
    ['a failed release check', (sandbox) => buildArtifact(sandbox.artifactDir, sandbox.state().git.commit, { status: 'failed' }), /release-check receipt is not passing/],
    ['a short password', null, /at least 16/, { ADMIN_PASSWORD: 'too-short' }],
    ['a template password', null, /placeholder/, { ADMIN_PASSWORD: 'changeme-changeme-changeme' }],
    ['a reused credential', null, /reuses the value of ADMIN_PASSWORD/, { GEMINI_API_KEY: PASSWORD }],
    ['an unexpected credential name', null, /unexpected names: OPENAI_API_KEY/, { OPENAI_API_KEY: 'sk-fixture-0123456789abcdef' }],
    ['an operator token path inside the repository', (sandbox, args) => { args[args.indexOf(sandbox.tokenFile)] = path.join(ROOT, 'operator-token.txt'); }, /outside the repository/],
    ['a missing operator token destination', (sandbox, args) => { args.splice(args.indexOf('--operator-token-file'), 2); }, /choose where the generated OPERATOR_TOKEN goes/],
    ['reveal without a terminal', (sandbox, args) => { args.push('--reveal-operator-token'); }, /interactive terminal/],
    ['a missing jurisdiction', (sandbox, args) => { args.splice(args.indexOf('--jurisdiction'), 2); }, /explicit --jurisdiction/],
    ['a missing --yes', (sandbox, args) => { args.splice(args.indexOf('--yes'), 1); }, /--yes is required/],
  ]) {
    test(`apply refuses ${label} before any remote write`, async (t) => {
      const sandbox = await createSandbox(t);
      const args = applyArgs(sandbox);
      change?.(sandbox, args);
      const run = await sandbox.run('apply', args, { input: stdinSecrets(secretOverrides) });
      assert.notEqual(run.code, 0, run.output);
      assert.match(run.stderr, pattern);
      assert.deepEqual(mutations(sandbox.state()), []);
      assert.equal(existsSync(path.join(sandbox.installDir(), 'receipt.json')), false);
      assert.equal(existsSync(path.join(ROOT, 'operator-token.txt')), false);
    });
  }

  test('staging uses separate names, state, identity and origin', async (t) => {
    const sandbox = await createSandbox(t);
    const production = await sandbox.run('apply', applyArgs(sandbox, { extra: ['--origin', 'https://interviews.example.org'] }), { input: stdinSecrets() });
    assert.equal(production.code, 0, production.output);
    const sameOrigin = await sandbox.run('apply', [
      '--install', 'acme', '--env', 'staging', '--provider', 'gemini', '--jurisdiction', 'eu',
      '--origin', 'https://interviews.example.org', '--operator-token-file', path.join(sandbox.dir, 'staging-token.txt'), '--secrets-stdin', '--yes',
    ], { input: stdinSecrets() });
    assert.equal(sameOrigin.code, 2);
    assert.match(sameOrigin.stderr, /already belongs to installation acme \(production\)/);

    const staging = await sandbox.run('apply', [
      '--install', 'acme', '--env', 'staging', '--provider', 'gemini', '--jurisdiction', 'eu',
      '--operator-token-file', path.join(sandbox.dir, 'staging-token.txt'), '--secrets-stdin', '--yes',
    ], { input: stdinSecrets({ ADMIN_PASSWORD: 'a-different-staging-password' }) });
    assert.equal(staging.code, 0, staging.output);
    const prodReceipt = sandbox.receipt('acme', 'production');
    const stagingReceipt = sandbox.receipt('acme', 'staging');
    assert.deepEqual(stagingReceipt.names, { worker: 'oi-acme-staging', queue: 'oi-acme-staging-analysis', deadLetterQueue: 'oi-acme-staging-analysis-dlq' });
    assert.equal(stagingReceipt.origin, 'https://oi-acme-staging.fixture-sub.workers.dev');
    assert.notEqual(stagingReceipt.workspaceId, prodReceipt.workspaceId);
    assert.notEqual(stagingReceipt.epochFingerprint, prodReceipt.epochFingerprint);
    const state = sandbox.state();
    assert.deepEqual(state.queueCreates, ['oi-acme-analysis', 'oi-acme-analysis-dlq', 'oi-acme-staging-analysis', 'oi-acme-staging-analysis-dlq']);
    assert.deepEqual(state.secretBulkCalls.map((call) => call.worker), ['oi-acme', 'oi-acme-staging']);
    const [prodSecrets, stagingSecrets] = sandbox.capturedSecrets();
    for (const name of ['SESSION_SECRET', 'PARTICIPANT_TOKEN_SECRET', 'RATE_LIMIT_SALT', 'OPERATOR_TOKEN', 'ANALYSIS_RECOVERY_EPOCH']) {
      assert.notEqual(prodSecrets[name], stagingSecrets[name]);
    }
    assert.equal(Object.keys(state.objects).length, 2);
  });

  test('an import target initializes in recovery, clears the bootstrap and reports the hold', async (t) => {
    const sandbox = await createSandbox(t);
    const run = await sandbox.run('apply', applyArgs(sandbox, { extra: ['--import-target'] }), { input: stdinSecrets() });
    assert.equal(run.code, 0, run.output);
    assert.match(run.stdout, /held in recovery awaiting import/);
    const state = sandbox.state();
    assert.deepEqual(Object.values(state.objects).map((object) => object.maintenance), ['recovery']);
    assert.equal(state.deploys.at(-1).vars.WORKSPACE_BOOTSTRAP, '');
    assert.equal(sandbox.receipt().bootstrap, 'recovery');
    const verify = await sandbox.run('verify', ['--install', 'acme', '--env', 'production']);
    assert.equal(verify.code, 3, verify.output);
    assert.match(verify.stdout, /HELD/);
  });

  test('with several accessible accounts the account must be chosen and is pinned everywhere', async (t) => {
    const second = { id: 'b'.repeat(32), name: 'Second Account' };
    const sandbox = await createSandbox(t, { state: { accounts: [{ id: 'a'.repeat(32), name: 'Fixture Account' }, second] } });
    const ambiguous = await sandbox.run('apply', applyArgs(sandbox), { input: stdinSecrets() });
    assert.equal(ambiguous.code, 2);
    assert.match(ambiguous.stderr, /choose one with --account-id/);
    assert.deepEqual(mutations(sandbox.state()), []);
    const run = await sandbox.run('apply', applyArgs(sandbox, { extra: ['--account-id', second.id] }), { input: stdinSecrets() });
    assert.equal(run.code, 0, run.output);
    assert.equal(sandbox.receipt().accountId, second.id);
    assert.equal(sandbox.config().account_id, second.id);
    const wrangler = sandbox.state().invocations.filter((entry) => entry.tool === 'wrangler' && entry.argv[0] !== 'whoami');
    assert.ok(wrangler.every((entry) => entry.env.includes('CLOUDFLARE_ACCOUNT_ID')));
  });
});

const FOREIGN_WORKER = { secrets: { FOREIGN_SECRET: 'f'.repeat(64) }, deployments: [{ at: '2026-01-01T00:00:00.000Z', message: 'someone else' }], vars: { FOREIGN: '1' } };
const FOREIGN_QUEUE = { id: 'foreign-queue', createdAt: '2026-01-01T00:00:00.000Z', foreign: true };

function assertUntouchedForeign(sandbox, before) {
  const after = sandbox.state();
  assert.deepEqual(mutations(after).slice(mutations(before).length), [], 'resume made no remote write');
  if (after.workers['oi-acme']?.vars?.FOREIGN) assert.deepEqual(Object.keys(after.workers['oi-acme'].secrets), ['FOREIGN_SECRET']);
}

// Regression tests for resume-time ownership (SETUP-01, VERIFY-04): a receipt
// attempt marker alone must never let resume adopt a resource.
describe('setup:cloudflare resume never adopts unrelated resources', { concurrency: 6 }, () => {
  test('a local deploy.mjs refusal leaves no Worker attempt, and a Worker that appears later is refused', async (t) => {
    // A deploy script that refuses an empty APP_BASE_URL before any upload.
    const sandbox = await createSandbox(t, { state: { deploy: { refusePendingOrigin: true } } });
    const first = await sandbox.run('apply', applyArgs(sandbox), { input: stdinSecrets() });
    assert.equal(first.code, 1, first.output);
    assert.match(first.stderr, /Nothing was uploaded and the deploy-initial phase was not recorded/);
    assert.equal(sandbox.receipt().resources['oi-acme'], undefined, 'no attempt recorded for a deploy that never ran');
    sandbox.update((state) => { state.workers['oi-acme'] = structuredClone(FOREIGN_WORKER); });
    const before = sandbox.state();
    const resumed = await sandbox.run('resume', resumeArgs(sandbox, ['--origin', ORIGIN]), { input: stdinSecrets() });
    assert.equal(resumed.code, 2, resumed.output);
    assert.match(resumed.stderr, /Worker oi-acme exists but this installation cannot show that it deployed it \(no receipt record/);
    assertUntouchedForeign(sandbox, before);
  });

  test('a Worker upload that failed in wrangler keeps its attempt, but an older foreign Worker is still refused', async (t) => {
    const sandbox = await createSandbox(t, { state: { failures: [{ at: 'deploy', when: 'before' }] } });
    const first = await sandbox.run('apply', applyArgs(sandbox), { input: stdinSecrets() });
    assert.equal(first.code, 1, first.output);
    assert.equal(sandbox.receipt().resources['oi-acme'].attempts.length, 1);
    sandbox.update((state) => { state.workers['oi-acme'] = structuredClone(FOREIGN_WORKER); });
    const before = sandbox.state();
    const resumed = await sandbox.run('resume', resumeArgs(sandbox), { input: stdinSecrets() });
    assert.equal(resumed.code, 2, resumed.output);
    assert.match(resumed.stderr, /outside every recorded deploy attempt/);
    assertUntouchedForeign(sandbox, before);
    const plan = await sandbox.run('plan', ['--install', 'acme', '--env', 'production', '--json']);
    assert.equal(plan.code, 2);
    assert.equal(JSON.parse(plan.stdout).resources[0].action, 'COLLISION');
  });

  test('a Worker created in the attempt window by someone else is refused by its deployment message', async (t) => {
    const sandbox = await createSandbox(t, { state: { failures: [{ at: 'deploy', when: 'before' }] } });
    assert.equal((await sandbox.run('apply', applyArgs(sandbox), { input: stdinSecrets() })).code, 1);
    sandbox.update((state) => {
      state.workers['oi-acme'] = { ...structuredClone(FOREIGN_WORKER), deployments: [{ at: new Date().toISOString(), message: 'dashboard edit' }] };
    });
    const before = sandbox.state();
    const resumed = await sandbox.run('resume', resumeArgs(sandbox), { input: stdinSecrets() });
    assert.equal(resumed.code, 2, resumed.output);
    assert.match(resumed.stderr, /deployment message "dashboard edit" was not sent by this installation/);
    assertUntouchedForeign(sandbox, before);
  });

  test('a queue create that failed before landing never vouches for a queue that appears later', async (t) => {
    const sandbox = await createSandbox(t, { state: { failures: [{ at: 'queues create', target: 'oi-acme-analysis', when: 'before' }] } });
    assert.equal((await sandbox.run('apply', applyArgs(sandbox), { input: stdinSecrets() })).code, 1);
    assert.deepEqual(sandbox.state().queueCreates, []);
    sandbox.update((state) => { state.queues['oi-acme-analysis'] = { ...FOREIGN_QUEUE }; });
    const before = sandbox.state();
    const resumed = await sandbox.run('resume', resumeArgs(sandbox), { input: stdinSecrets() });
    assert.equal(resumed.code, 2, resumed.output);
    assert.match(resumed.stderr, /queue oi-acme-analysis exists but this installation cannot show that it created it \(created 2026-01-01.*outside every recorded create attempt/);
    assertUntouchedForeign(sandbox, before);
    assert.equal(sandbox.receipt().resources['oi-acme-analysis'].id, undefined);
    assert.equal(sandbox.receipt().resources['oi-acme-analysis'].observedAt, undefined);
  });

  test('a queue name taken between listing and creating is a collision, and resume keeps refusing it', async (t) => {
    const sandbox = await createSandbox(t, { state: { failures: [{ at: 'queues create', target: 'oi-acme-analysis', when: 'race' }] } });
    const first = await sandbox.run('apply', applyArgs(sandbox), { input: stdinSecrets() });
    assert.equal(first.code, 2, first.output);
    assert.match(first.stderr, /queue oi-acme-analysis exists but this installation cannot show that it created it \(no receipt record/);
    assert.equal(sandbox.receipt().resources['oi-acme-analysis'], undefined, 'the failed attempt created nothing and is forgotten');
    const before = sandbox.state();
    const resumed = await sandbox.run('resume', resumeArgs(sandbox), { input: stdinSecrets() });
    assert.equal(resumed.code, 2, resumed.output);
    assertUntouchedForeign(sandbox, before);
    assert.equal(sandbox.state().queues['oi-acme-analysis'].id, 'foreign-race-queue');
  });

  test('after the identity phase, a foreign queue with no receipt record is refused', async (t) => {
    // The preflight collision check passes; the resources phase's listing fails.
    const sandbox = await createSandbox(t, { state: { failures: [{ at: 'queues list', skip: 1 }] } });
    assert.equal((await sandbox.run('apply', applyArgs(sandbox), { input: stdinSecrets() })).code, 1);
    assert.ok(sandbox.receipt().phases.identity);
    assert.deepEqual(sandbox.receipt().resources, {});
    sandbox.update((state) => { state.queues['oi-acme-analysis-dlq'] = { ...FOREIGN_QUEUE }; });
    const before = sandbox.state();
    const resumed = await sandbox.run('resume', resumeArgs(sandbox), { input: stdinSecrets() });
    assert.equal(resumed.code, 2, resumed.output);
    assert.match(resumed.stderr, /queue oi-acme-analysis-dlq exists .* \(no receipt record/);
    assertUntouchedForeign(sandbox, before);
  });

  test('after the identity phase, a foreign Worker with no receipt record is refused', async (t) => {
    // The preflight collision check passes; deploy-initial's listing fails.
    const sandbox = await createSandbox(t, { state: { failures: [{ at: 'deployments list', skip: 1 }] } });
    assert.equal((await sandbox.run('apply', applyArgs(sandbox), { input: stdinSecrets() })).code, 1);
    assert.ok(sandbox.receipt().phases.config);
    assert.equal(sandbox.receipt().resources['oi-acme'], undefined);
    sandbox.update((state) => { state.workers['oi-acme'] = structuredClone(FOREIGN_WORKER); });
    const before = sandbox.state();
    const resumed = await sandbox.run('resume', resumeArgs(sandbox), { input: stdinSecrets() });
    assert.equal(resumed.code, 2, resumed.output);
    assert.match(resumed.stderr, /Worker oi-acme exists .* \(no receipt record/);
    assertUntouchedForeign(sandbox, before);
  });

  for (const [label, seed, pattern] of [
    ['a complete secret set this installation never uploaded', (worker) => {
      for (const name of ALL_SECRET_NAMES) worker.secrets[name] = digest(`foreign-${name}`);
    }, /secrets are already bound to oi-acme but this installation never set them/],
    ['a partial secret set', (worker) => { worker.secrets.SESSION_SECRET = digest('foreign'); }, /only some installation secrets are bound to oi-acme \(SESSION_SECRET\); refusing to overwrite them/],
  ]) {
    test(`resume refuses ${label}`, async (t) => {
      // Interrupted in the secrets phase before its upload was attempted.
      const sandbox = await createSandbox(t, { state: { failures: [{ at: 'secret list' }] } });
      assert.equal((await sandbox.run('apply', applyArgs(sandbox), { input: stdinSecrets() })).code, 1);
      const interrupted = sandbox.receipt();
      assert.ok(interrupted.phases['deploy-initial']);
      assert.equal(interrupted.secrets.attemptedAt, null);
      sandbox.update((state) => seed(state.workers['oi-acme']));
      const hashes = { ...sandbox.state().workers['oi-acme'].secrets };
      const resumed = await sandbox.run('resume', resumeArgs(sandbox), { input: stdinSecrets() });
      assert.equal(resumed.code, 2, resumed.output);
      assert.match(resumed.stderr, pattern);
      assert.deepEqual(sandbox.state().secretBulkCalls, []);
      assert.deepEqual(sandbox.state().workers['oi-acme'].secrets, hashes);
      assert.equal(sandbox.receipt().phases.secrets, undefined);
    });
  }

  test('resume refuses a different --jurisdiction (a data migration) before any remote call', async (t) => {
    const sandbox = await createSandbox(t, { state: { failures: [{ at: 'deploy', when: 'before' }] } });
    assert.equal((await sandbox.run('apply', applyArgs(sandbox), { input: stdinSecrets() })).code, 1);
    const before = sandbox.state();
    const resumed = await sandbox.run('resume', resumeArgs(sandbox, ['--jurisdiction', 'none']), { input: stdinSecrets() });
    assert.equal(resumed.code, 2, resumed.output);
    assert.match(resumed.stderr, /--jurisdiction none differs from the installed jurisdiction eu; changing it is a data migration/);
    assert.equal(sandbox.state().invocations.length, before.invocations.length, 'no tool was invoked');
  });
});

// Regression tests for the origin binding (gap review F2) and the shared
// deploy environment.
describe('setup:cloudflare origin binding and tool environment', { concurrency: 6 }, () => {
  test('a custom origin answered by another installation cannot stand in for this Worker\'s workspace', async (t) => {
    const sandbox = await createSandbox(t);
    const origin = 'https://interviews.example.org';
    assert.equal((await sandbox.run('apply', applyArgs(sandbox, { extra: ['--origin', origin] }), { input: stdinSecrets() })).code, 0);
    // A second checkout (separate state dir, so no shared-receipt check) installs staging on the same origin.
    const bin = path.join(sandbox.dir, 'bin');
    const staging = await sandbox.run('apply', [
      '--install', 'acme', '--env', 'staging', '--provider', 'gemini', '--jurisdiction', 'eu', '--origin', origin,
      '--operator-token-file', path.join(sandbox.dir, 'staging-token'), '--secrets-stdin', '--yes',
      '--state-dir', path.join(sandbox.dir, 'other-state'), '--wrangler', path.join(bin, 'wrangler.mjs'),
      '--deploy-script', path.join(bin, 'deploy.mjs'), '--git', path.join(bin, 'git.mjs'),
      '--artifact-dir', sandbox.artifactDir, '--wait-seconds', '1',
    ], { input: stdinSecrets({ ADMIN_PASSWORD: 'another-staging-password-1' }), extraArgs: false });
    assert.equal(staging.code, 0, staging.output);
    const state = sandbox.state();
    const initialized = Object.keys(state.objects).map((key) => key.split('|')[0]).sort();
    assert.deepEqual(initialized, ['oi-acme', 'oi-acme-staging'], 'staging initialized its own workspace object before clearing its bootstrap');
    assert.equal(state.workers['oi-acme-staging'].vars.WORKSPACE_BOOTSTRAP, '');
    assert.match(staging.stdout, /Routing of the custom origin to this Worker is not proven/);
  });

  test('an unrouted custom origin does not block workspace initialization; verify waits for routing', async (t) => {
    const origin = 'https://interviews.example.org';
    const sandbox = await createSandbox(t, { state: { http: { forceNotReady: false, requests: [], unroutedHosts: ['interviews.example.org'] } } });
    const first = await sandbox.run('apply', applyArgs(sandbox, { extra: ['--origin', origin] }), { input: stdinSecrets() });
    assert.equal(first.code, 1, first.output);
    assert.match(first.stderr, /A custom origin must be routed to oi-acme/);
    const receipt = sandbox.receipt();
    assert.ok(receipt.phases['workspace-init']);
    assert.ok(receipt.phases['bootstrap-clear']);
    assert.equal(receipt.phases.verify, undefined);
    assert.equal(Object.keys(sandbox.state().objects).length, 1);
    const deploys = sandbox.state().deploys.length;
    sandbox.update((state) => { state.http.unroutedHosts = []; });
    const resumed = await sandbox.run('resume', ['--install', 'acme', '--env', 'production', '--yes']);
    assert.equal(resumed.code, 0, resumed.output);
    assert.equal(sandbox.state().deploys.length, deploys, 'routing needed no further deploy');
  });

  test('verify reports not-ready when the origin and the Worker disagree', async (t) => {
    const origin = 'https://interviews.example.org';
    const sandbox = await createSandbox(t);
    assert.equal((await sandbox.run('apply', applyArgs(sandbox, { extra: ['--origin', origin] }), { input: stdinSecrets() })).code, 0);
    // The Worker's own workspace is gone while something else still answers the origin.
    sandbox.update((state) => {
      state.objects = {};
      state.workers.impostor = { ...structuredClone(state.workers['oi-acme']), vars: { ...state.workers['oi-acme'].vars, WORKSPACE_BOOTSTRAP: 'open' } };
      const { 'oi-acme': own, ...rest } = state.workers;
      state.workers = { impostor: rest.impostor, 'oi-acme': own };
    });
    const run = await sandbox.run('verify', ['--install', 'acme', '--env', 'production', '--json']);
    assert.equal(run.code, 1, run.output);
    const result = JSON.parse(run.stdout);
    assert.deepEqual(result.targets.map(({ role, status }) => [role, status]), [['worker', 'not-ready'], ['origin', 'ready']]);
    assert.equal(result.checks.find((check) => check.id === 'origin.agreesWithWorker').ok, false);
    assert.deepEqual(result.readinessErrors, ['workspace_uninitialized']);
  });

  test('a completed installation whose workspace is gone can be re-bootstrapped deliberately', async (t) => {
    const sandbox = await createSandbox(t);
    assert.equal((await sandbox.run('apply', applyArgs(sandbox), { input: stdinSecrets() })).code, 0);
    sandbox.update((state) => { state.objects = {}; });
    const verify = await sandbox.run('verify', ['--install', 'acme', '--env', 'production']);
    assert.equal(verify.code, 1);
    assert.match(verify.stdout, /workspace_uninitialized/);
    // The documented procedure: remove the last three phases, then resume.
    const file = path.join(sandbox.installDir(), 'receipt.json');
    const receipt = JSON.parse(readFileSync(file, 'utf8'));
    for (const phase of ['workspace-init', 'bootstrap-clear', 'verify']) delete receipt.phases[phase];
    writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
    const before = sandbox.state();
    const resumed = await sandbox.run('resume', ['--install', 'acme', '--env', 'production', '--yes']);
    assert.equal(resumed.code, 0, resumed.output);
    const after = sandbox.state();
    assert.deepEqual(after.deploys.slice(before.deploys.length).map((deploy) => deploy.vars.WORKSPACE_BOOTSTRAP), ['open', '']);
    assert.equal(Object.keys(after.objects).length, 1);
    assert.deepEqual(after.secretBulkCalls, before.secretBulkCalls, 'no secret or epoch was regenerated');
    assert.deepEqual(sandbox.receipt().deployments.slice(-2).map((entry) => entry.purpose), ['workspace-init', 'bootstrap-clear']);
    assertNoSecretLeak(sandbox, [verify, resumed]);
  });

  test('deploy.mjs and every wrangler call receive the same environment allowlist', async (t) => {
    const sandbox = await createSandbox(t);
    const env = { HTTPS_PROXY: 'http://127.0.0.1:9', XDG_CONFIG_HOME: path.join(sandbox.dir, 'xdg'), NODE_EXTRA_CA_CERTS: '/nonexistent.pem', CLOUDFLARE_API_TOKEN: 'fixture-api-token' };
    const run = await sandbox.run('apply', applyArgs(sandbox), { input: stdinSecrets(), env });
    assert.equal(run.code, 0, run.output);
    assert.match(run.stdout, /ignoring XDG_CONFIG_HOME, HTTPS_PROXY, NODE_EXTRA_CA_CERTS/);
    const invocations = sandbox.state().invocations;
    const envOf = (entry) => entry.env.join(',');
    const deploys = invocations.filter((entry) => entry.tool === 'deploy');
    const wrangler = invocations.filter((entry) => entry.tool === 'wrangler' && entry.argv[0] !== 'whoami');
    assert.ok(deploys.length > 0 && wrangler.length > 0);
    for (const entry of [...deploys, ...wrangler]) assert.equal(envOf(entry), envOf(deploys[0]), `${entry.tool} ${entry.argv.slice(0, 2).join(' ')}`);
    for (const name of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) assert.ok(deploys[0].env.includes(name));
    for (const name of Object.keys(env).filter((key) => key !== 'CLOUDFLARE_API_TOKEN')) {
      assert.ok(invocations.every((entry) => !entry.env.includes(name)), `${name} reached a child`);
    }
    assertNoSecretLeak(sandbox, [run]);
  });

  test('an operator token file planted after preflight is never written or adopted', async (t) => {
    const sandbox = await createSandbox(t);
    sandbox.update((state) => { state.deploy.plantFile = sandbox.tokenFile; });
    const first = await sandbox.run('apply', applyArgs(sandbox), { input: stdinSecrets() });
    assert.equal(first.code, 2, first.output);
    assert.match(first.stderr, /appeared or became a link after it was checked/);
    assert.equal(readFileSync(sandbox.tokenFile, 'utf8'), 'planted\n');
    assert.deepEqual(sandbox.state().secretBulkCalls, [], 'no secret was uploaded without a stored operator token');
    assert.equal(sandbox.receipt().operatorToken.writtenAt, null);
    // The planted file never becomes "this installation's" file on resume.
    sandbox.update((state) => { state.deploy.plantFile = null; });
    const resumed = await sandbox.run('resume', resumeArgs(sandbox), { input: stdinSecrets() });
    assert.equal(resumed.code, 2, resumed.output);
    assert.match(resumed.stderr, /already exists; choose a new path/);
    assert.equal(readFileSync(sandbox.tokenFile, 'utf8'), 'planted\n');
    const other = path.join(sandbox.dir, 'operator-token-2.txt');
    const fixed = await sandbox.run('resume', ['--install', 'acme', '--env', 'production', '--operator-token-file', other, '--secrets-stdin', '--yes'], { input: stdinSecrets() });
    assert.equal(fixed.code, 0, fixed.output);
    assert.equal(readFileSync(other, 'utf8').trim(), sandbox.capturedSecrets()[0].OPERATOR_TOKEN);
    assertNoSecretLeak(sandbox, [first, resumed, fixed]);
  });

  test('a non-public compliance region is refused before any remote write', async (t) => {
    const sandbox = await createSandbox(t);
    const run = await sandbox.run('apply', applyArgs(sandbox), { input: stdinSecrets(), env: { CLOUDFLARE_COMPLIANCE_REGION: 'fedramp_high' } });
    assert.equal(run.code, 2, run.output);
    assert.match(run.stderr, /CLOUDFLARE_COMPLIANCE_REGION=fedramp_high is not supported/);
    assert.deepEqual(sandbox.state().invocations, []);
  });
});
