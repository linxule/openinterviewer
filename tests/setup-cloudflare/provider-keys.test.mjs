// Provider keys (gw-final D10, design C key operations): receipt format 2,
// several keys bound at apply, and keys added or rotated later with one
// secret upload and no deploy. Against the simulated account only.

import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ROOT, readJsonc } from '../../scripts/cloudflare/lib.mjs';
import { buildInstallationConfig, migrateReceipt, readReceipt } from '../../scripts/cloudflare/installer/state.mjs';
import { digest } from './fixtures/fake-state.mjs';
import { PROVIDER_KEY, applyArgs, assertNoSecretLeak, createSandbox, mutations, stdinSecrets } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const V1_STAGING = path.join(HERE, 'fixtures', 'receipt-v1-staging.json');
const template = readJsonc(path.join(ROOT, 'wrangler.jsonc'));
const UPDATE = ['--install', 'acme', '--env', 'production', '--yes'];
const KEYS = {
  ANTHROPIC_API_KEY: 'sk-ant-fixture-claude-0123456789',
  OPENAI_API_KEY: 'sk-fixture-openai-0123456789ab',
  OPENROUTER_API_KEY: 'sk-or-fixture-openrouter-012345',
};

async function installed(t, extra = [], secrets = {}) {
  const sandbox = await createSandbox(t);
  const run = await sandbox.run('apply', applyArgs(sandbox, { extra }), { input: stdinSecrets(secrets) });
  assert.equal(run.code, 0, run.output);
  return sandbox;
}

const bulkCalls = (sandbox) => sandbox.state().secretBulkCalls;

describe('receipt format 2', () => {
  test('the committed v1 fixture carries only synthetic identifiers (the repository is public)', () => {
    const v1 = JSON.parse(readFileSync(V1_STAGING, 'utf8'));
    assert.equal(new URL(v1.origin).hostname.endsWith('.example.com'), true, v1.origin);
    assert.equal(new URL(v1.workersDevUrl).hostname, `${v1.names.worker}.example.workers.dev`);
    for (const deployment of v1.deployments) assert.equal(deployment.appBaseUrl, v1.origin);
    assert.equal(v1.accountId, '0123456789abcdef0123456789abcdef');
    assert.equal(v1.names.worker, `oi-${v1.install}-staging`);
    assert.equal(v1.install, 'example-studio');
  });

  test('the staging-shaped v1 receipt migrates in memory without losing or changing any recorded fact', () => {
    const v1 = JSON.parse(readFileSync(V1_STAGING, 'utf8'));
    assert.equal(v1.formatVersion, 1);
    const v2 = migrateReceipt(structuredClone(v1));
    assert.equal(v2.formatVersion, 2);
    assert.deepEqual(v2.providerKeys, ['gemini']);
    assert.equal(v2.aiTransport, 'direct');
    assert.deepEqual(v2.secretEvents, []);
    assert.equal(v2.pendingChange, undefined);
    const { formatVersion: _a, providerKeys: _b, aiTransport: _c, secretEvents: _d, ...rest } = v2;
    const { formatVersion: _e, ...original } = v1;
    assert.deepEqual(rest, original);
    // The new fields sit next to the provider they describe.
    assert.deepEqual(Object.keys(v2).slice(Object.keys(v2).indexOf('provider'), Object.keys(v2).indexOf('provider') + 3), ['provider', 'providerKeys', 'aiTransport']);
  });

  test('a v1 provider history and an unfinished v1 provider change migrate to key sets and a pending change', () => {
    const v1 = JSON.parse(readFileSync(V1_STAGING, 'utf8'));
    const switched = migrateReceipt({ ...structuredClone(v1), provider: 'claude', providerHistory: [{ from: 'gemini', to: 'claude', at: '2026-09-24T10:00:00.000Z' }] });
    assert.deepEqual(switched.providerKeys, ['gemini', 'claude'], 'update --change-provider never deleted the old key');
    const pending = migrateReceipt({ ...structuredClone(v1), pendingProviderChange: { from: 'gemini', to: 'openai', startedAt: '2026-09-24T10:00:00.000Z' } });
    assert.deepEqual(pending.pendingChange, { kind: 'provider', from: 'gemini', to: 'openai', startedAt: '2026-09-24T10:00:00.000Z' });
    assert.equal(Object.hasOwn(pending, 'pendingProviderChange'), false);
    assert.deepEqual(pending.providerKeys, ['gemini'], 'the target key joins only when the change finishes');
  });

  test('an inconsistent or unknown receipt is refused', async (t) => {
    const sandbox = await installed(t);
    const file = path.join(sandbox.installDir(), 'receipt.json');
    const receipt = JSON.parse(readFileSync(file, 'utf8'));
    for (const [label, broken, pattern] of [
      ['a key set without the default provider', { ...receipt, providerKeys: ['claude'] }, /lacks the default provider gemini/],
      ['an unknown transport', { ...receipt, aiTransport: 'gateway' }, /aiTransport "gateway" is not supported/],
      ['a future format', { ...receipt, formatVersion: 3 }, /unsupported formatVersion 3/],
    ]) {
      writeFileSync(file, `${JSON.stringify(broken, null, 2)}\n`);
      assert.throws(() => readReceipt(file), pattern, label);
      const run = await sandbox.run('verify', ['--install', 'acme', '--env', 'production']);
      assert.equal(run.code, 2, `${label}\n${run.output}`);
    }
  });
});

describe('setup:cloudflare provider keys', { concurrency: 6 }, () => {
  test('apply --provider-keys all binds every key in the one bulk upload and records them', async (t) => {
    const sandbox = await installed(t, ['--provider-keys', 'all'], KEYS);
    const [bulk, ...others] = bulkCalls(sandbox);
    assert.equal(others.length, 0);
    assert.deepEqual(bulk.names, [
      'ADMIN_PASSWORD', 'ANALYSIS_RECOVERY_EPOCH', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY',
      'OPENROUTER_API_KEY', 'OPERATOR_TOKEN', 'PARTICIPANT_TOKEN_SECRET', 'RATE_LIMIT_SALT', 'SESSION_SECRET',
    ]);
    const secrets = sandbox.state().workers['oi-acme'].secrets;
    for (const [name, value] of Object.entries(KEYS)) assert.equal(secrets[name], digest(value));
    const receipt = sandbox.receipt();
    assert.equal(receipt.formatVersion, 2);
    assert.equal(receipt.provider, 'gemini');
    assert.deepEqual(receipt.providerKeys, ['gemini', 'claude', 'openai', 'openrouter']);
    assert.equal(sandbox.config().vars.AI_PROVIDER, 'gemini');
    assert.deepEqual(receipt.deployments.at(-1).providerKeys, ['gemini', 'claude', 'openai', 'openrouter']);
    assertNoSecretLeak(sandbox, [], Object.values(KEYS));
  });

  for (const [label, extra, input, pattern] of [
    ['a key set without the default provider', ['--provider-keys', 'claude'], stdinSecrets({ ANTHROPIC_API_KEY: KEYS.ANTHROPIC_API_KEY }), /must include the default provider gemini/],
    ['an unknown provider', ['--provider-keys', 'gemini,mistral'], stdinSecrets(), /unknown provider "mistral"/],
    ['stdin without one of the requested keys', ['--provider-keys', 'gemini,openai'], stdinSecrets(), /--secrets-stdin input lacks OPENAI_API_KEY/],
    ['stdin with a key that was not requested', [], stdinSecrets({ OPENAI_API_KEY: KEYS.OPENAI_API_KEY }), /unexpected names: OPENAI_API_KEY/],
    ['a reused key value', ['--provider-keys', 'gemini,openai'], stdinSecrets({ OPENAI_API_KEY: PROVIDER_KEY }), /reuses the value/],
    ['a key operation on apply', ['--add-provider-key', 'openai'], stdinSecrets(), /--add-provider-key is an update option/],
  ]) {
    test(`apply refuses ${label} before any remote write`, async (t) => {
      const sandbox = await createSandbox(t);
      const run = await sandbox.run('apply', applyArgs(sandbox, { extra }), { input });
      assert.equal(run.code, 2, run.output);
      assert.match(run.stderr, pattern);
      assert.deepEqual(mutations(sandbox.state()), []);
    });
  }

  test('update --add-provider-key uploads only the named keys, deploys nothing and records them', async (t) => {
    const sandbox = await installed(t);
    const before = sandbox.state();
    const run = await sandbox.run('update', [...UPDATE, '--add-provider-key', 'openrouter,claude', '--secrets-stdin', '--json'], {
      input: JSON.stringify({ ANTHROPIC_API_KEY: KEYS.ANTHROPIC_API_KEY, OPENROUTER_API_KEY: KEYS.OPENROUTER_API_KEY }),
    });
    assert.equal(run.code, 0, run.output);
    const after = sandbox.state();
    assert.equal(after.deploys.length, before.deploys.length, 'no deploy');
    assert.equal(after.secretBulkCalls.length, before.secretBulkCalls.length + 1);
    assert.deepEqual(after.secretBulkCalls.at(-1).names, ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']);
    for (const [name, hash] of Object.entries(before.workers['oi-acme'].secrets)) assert.equal(after.workers['oi-acme'].secrets[name], hash, `${name} unchanged`);
    const receipt = sandbox.receipt();
    assert.deepEqual(receipt.providerKeys, ['gemini', 'claude', 'openrouter']);
    assert.equal(receipt.provider, 'gemini');
    assert.equal(receipt.pendingChange, undefined);
    assert.equal(receipt.secretEvents.length, 1);
    assert.deepEqual(receipt.secretEvents[0].names, ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']);
    assert.equal(receipt.secretEvents[0].deploymentId, '00000000-0000-4000-8000-000000000004', 'the deployment the upload created');
    const result = JSON.parse(run.stdout);
    assert.equal(result.operation, 'add-provider-key');
    assert.equal(result.status, 'ready');
    assert.deepEqual(result.providerKeys, ['gemini', 'claude', 'openrouter']);

    // Recorded keys are never added twice; a second key operation still passes the version check.
    const again = await sandbox.run('update', [...UPDATE, '--add-provider-key', 'claude', '--secrets-stdin'], { input: JSON.stringify({ ANTHROPIC_API_KEY: 'sk-ant-other-0123456789abcdef' }) });
    assert.equal(again.code, 2, again.output);
    assert.match(again.stderr, /claude is already recorded .* Replace a bound key with --rotate-provider-key/);
    const openai = await sandbox.run('update', [...UPDATE, '--add-provider-key', 'openai', '--secrets-stdin'], { input: JSON.stringify({ OPENAI_API_KEY: KEYS.OPENAI_API_KEY }) });
    assert.equal(openai.code, 0, openai.output);
    assert.deepEqual(sandbox.receipt().providerKeys, ['gemini', 'claude', 'openai', 'openrouter']);
    assert.equal(sandbox.state().deploys.length, before.deploys.length);
    assertNoSecretLeak(sandbox, [run, again, openai], [...Object.values(KEYS), 'sk-ant-other-0123456789abcdef']);
  });

  test('an interrupted --add-provider-key finishes on rerun without asking again for a key that landed', async (t) => {
    const sandbox = await installed(t);
    sandbox.update((state) => { state.failures.push({ at: 'secret bulk', when: 'after' }); });
    const args = [...UPDATE, '--add-provider-key', 'openai', '--secrets-stdin'];
    const first = await sandbox.run('update', args, { input: JSON.stringify({ OPENAI_API_KEY: KEYS.OPENAI_API_KEY }) });
    assert.equal(first.code, 1, first.output);
    assert.match(first.stderr, /rerun update --add-provider-key openai to finish it/);
    assert.deepEqual(sandbox.receipt().pendingChange.providers, ['openai']);
    assert.deepEqual(sandbox.receipt().providerKeys, ['gemini']);

    for (const [command, other] of [['update', UPDATE], ['update', [...UPDATE, '--rotate-provider-key', 'gemini']], ['config', ['--install', 'acme', '--env', 'production']]]) {
      const refused = await sandbox.run(command, other);
      assert.equal(refused.code, 2, refused.output);
      assert.match(refused.stderr, /adding the openai provider key\(s\), started at .* has not finished/);
    }

    const bulk = bulkCalls(sandbox).length;
    const again = await sandbox.run('update', [...UPDATE, '--add-provider-key', 'openai']);
    assert.equal(again.code, 0, again.output);
    assert.equal(bulkCalls(sandbox).length, bulk, 'the landed key is not uploaded again');
    const receipt = sandbox.receipt();
    assert.deepEqual(receipt.providerKeys, ['gemini', 'openai']);
    assert.equal(receipt.pendingChange, undefined);
    assert.deepEqual(receipt.secretEvents.at(-1).uploaded, []);
    // The deployment the interrupted upload created (apply made four before it).
    assert.equal(receipt.secretEvents.at(-1).deploymentId, '00000000-0000-4000-8000-000000000004');
    // The next key operation accepts that recorded deployment.
    const rotate = await sandbox.run('update', [...UPDATE, '--rotate-provider-key', 'openai', '--secrets-stdin'], { input: JSON.stringify({ OPENAI_API_KEY: 'sk-fixture-openai-rotated-01234' }) });
    assert.equal(rotate.code, 0, rotate.output);
  });

  test('an interrupted --rotate-provider-key finishes on rerun with the new key', async (t) => {
    const sandbox = await installed(t);
    sandbox.update((state) => { state.failures.push({ at: 'secret bulk', when: 'after' }); });
    const args = [...UPDATE, '--rotate-provider-key', 'gemini', '--secrets-stdin'];
    const input = JSON.stringify({ GEMINI_API_KEY: 'AIzaFixtureRotatedKey-9876543210' });
    const first = await sandbox.run('update', args, { input });
    assert.equal(first.code, 1, first.output);
    assert.equal(sandbox.receipt().pendingChange.kind, 'rotate-provider-key');
    const again = await sandbox.run('update', args, { input });
    assert.equal(again.code, 0, again.output);
    assert.equal(sandbox.receipt().pendingChange, undefined);
    assert.equal(sandbox.state().workers['oi-acme'].secrets.GEMINI_API_KEY, digest('AIzaFixtureRotatedKey-9876543210'));
    assert.equal(sandbox.state().deploys.length, 3, 'still only the three apply deploys');
  });

  test('update --rotate-provider-key replaces one recorded key and nothing else, with no deploy', async (t) => {
    const sandbox = await installed(t, ['--provider-keys', 'gemini,openai'], { OPENAI_API_KEY: KEYS.OPENAI_API_KEY });
    const before = sandbox.state();
    const rotated = 'AIzaFixtureRotatedKey-9876543210';
    const run = await sandbox.run('update', [...UPDATE, '--rotate-provider-key', 'gemini', '--secrets-stdin'], { input: JSON.stringify({ GEMINI_API_KEY: rotated }) });
    assert.equal(run.code, 0, run.output);
    const after = sandbox.state();
    assert.equal(after.deploys.length, before.deploys.length);
    assert.deepEqual(after.secretBulkCalls.at(-1).names, ['GEMINI_API_KEY']);
    const secrets = after.workers['oi-acme'].secrets;
    assert.equal(secrets.GEMINI_API_KEY, digest(rotated));
    for (const [name, hash] of Object.entries(before.workers['oi-acme'].secrets)) {
      if (name !== 'GEMINI_API_KEY') assert.equal(secrets[name], hash, `${name} unchanged`);
    }
    assert.deepEqual(sandbox.receipt().providerKeys, ['gemini', 'openai']);
    assert.equal(sandbox.receipt().secretEvents.at(-1).kind, 'rotate-provider-key');

    const again = await sandbox.run('update', [...UPDATE, '--rotate-provider-key', 'openai', '--secrets-stdin'], { input: JSON.stringify({ OPENAI_API_KEY: 'sk-fixture-openai-rotated-01234' }) });
    assert.equal(again.code, 0, again.output);
    assertNoSecretLeak(sandbox, [run, again], [rotated, KEYS.OPENAI_API_KEY, 'sk-fixture-openai-rotated-01234']);
  });

  for (const [label, args, input, pattern] of [
    ['two operations at once', ['--add-provider-key', 'openai', '--rotate-provider-key', 'gemini'], '{}', /one operation at a time/],
    ['a key change combined with --change-provider', ['--provider', 'claude', '--change-provider', '--add-provider-key', 'openai'], '{}', /one operation at a time/],
    ['rotating an unrecorded key', ['--rotate-provider-key', 'claude', '--secrets-stdin'], JSON.stringify({ ANTHROPIC_API_KEY: KEYS.ANTHROPIC_API_KEY }), /claude is not recorded .* Bind it with --add-provider-key/],
    ['rotating several keys at once', ['--rotate-provider-key', 'gemini,claude'], '{}', /exactly one provider/],
    ['--provider-keys on update', ['--provider-keys', 'all'], '{}', /--provider-keys applies to a fresh apply only/],
    ['stdin with a key that was not named', ['--add-provider-key', 'openai', '--secrets-stdin'], JSON.stringify({ OPENAI_API_KEY: KEYS.OPENAI_API_KEY, ANTHROPIC_API_KEY: KEYS.ANTHROPIC_API_KEY }), /unexpected names: ANTHROPIC_API_KEY/],
    ['a placeholder key', ['--add-provider-key', 'openai', '--secrets-stdin'], JSON.stringify({ OPENAI_API_KEY: 'your-openai-key' }), /OPENAI_API_KEY still contains a template placeholder/],
  ]) {
    test(`update refuses ${label} without any upload or deploy`, async (t) => {
      const sandbox = await installed(t);
      const before = mutations(sandbox.state()).length;
      const receiptText = readFileSync(path.join(sandbox.installDir(), 'receipt.json'), 'utf8');
      const run = await sandbox.run('update', [...UPDATE, ...args], { input });
      assert.equal(run.code, 2, run.output);
      assert.match(run.stderr, pattern);
      assert.equal(mutations(sandbox.state()).length, before);
      assert.equal(readFileSync(path.join(sandbox.installDir(), 'receipt.json'), 'utf8'), receiptText);
    });
  }

  test('a key bound outside the installer is reported by update, and never overwritten by --add-provider-key', async (t) => {
    const sandbox = await installed(t);
    sandbox.update((state) => { state.workers['oi-acme'].secrets.OPENAI_API_KEY = digest('set-by-hand'); });
    const plain = await sandbox.run('update', UPDATE);
    assert.equal(plain.code, 0, plain.output);
    assert.match(plain.stdout, /Warning: OPENAI_API_KEY is bound to oi-acme but not recorded in the receipt's providerKeys/);
    const bulk = bulkCalls(sandbox).length;
    const add = await sandbox.run('update', [...UPDATE, '--add-provider-key', 'openai', '--secrets-stdin'], { input: JSON.stringify({ OPENAI_API_KEY: KEYS.OPENAI_API_KEY }) });
    assert.equal(add.code, 2, add.output);
    assert.match(add.stderr, /OPENAI_API_KEY is already bound to oi-acme without an installer record; refusing to overwrite/);
    assert.equal(bulkCalls(sandbox).length, bulk);
    assert.equal(sandbox.receipt().pendingChange, undefined);
  });

  test('a recorded provider key missing on the Worker is drift', async (t) => {
    const sandbox = await installed(t, ['--provider-keys', 'gemini,openai'], { OPENAI_API_KEY: KEYS.OPENAI_API_KEY });
    sandbox.update((state) => { delete state.workers['oi-acme'].secrets.OPENAI_API_KEY; });
    const run = await sandbox.run('update', UPDATE);
    assert.equal(run.code, 2, run.output);
    assert.match(run.stderr, /secret OPENAI_API_KEY: missing on oi-acme/);
  });

  test('a key operation refuses while the newest deployment is not a checked release, until one is deployed', async (t) => {
    const sandbox = await installed(t);
    // A dashboard deploy or wrangler rollback the installer did not make.
    sandbox.update((state) => { state.workers['oi-acme'].deployments.push({ at: new Date().toISOString(), message: 'hotfix from the dashboard' }); });
    const args = [...UPDATE, '--rotate-provider-key', 'gemini', '--secrets-stdin'];
    const input = JSON.stringify({ GEMINI_API_KEY: 'AIzaFixtureRotatedKey-9876543210' });
    const bulk = bulkCalls(sandbox).length;
    const refused = await sandbox.run('update', args, { input });
    assert.equal(refused.code, 2, refused.output);
    assert.match(refused.stderr, /is neither a deploy\.mjs release nor one this installer recorded/);
    assert.match(refused.stderr, /Redeploy a checked release first/);
    assert.equal(bulkCalls(sandbox).length, bulk);
    assert.equal(sandbox.receipt().pendingChange, undefined);

    sandbox.update((state) => {
      const last = state.workers['oi-acme'].deployments.at(-1);
      last.message = undefined;
    });
    // Also refused: a deployment without any message that no key operation recorded.
    assert.equal((await sandbox.run('update', args, { input })).code, 2);

    assert.equal((await sandbox.run('update', UPDATE)).code, 0);
    const rotated = await sandbox.run('update', args, { input });
    assert.equal(rotated.code, 0, rotated.output);

    // A deploy.mjs release this receipt did not record (the CI promotion of a newer commit) is a checked release.
    sandbox.update((state) => { state.workers['oi-acme'].deployments.push({ at: new Date().toISOString(), message: `openinterviewer ${'4'.repeat(12)}` }); });
    const afterPromotion = await sandbox.run('update', [...UPDATE, '--rotate-provider-key', 'gemini', '--secrets-stdin'], { input: JSON.stringify({ GEMINI_API_KEY: 'AIzaFixtureRotatedAgain-012345678' }) });
    assert.equal(afterPromotion.code, 0, afterPromotion.output);
  });

  test('after a manual wrangler secret put (the restore\'s epoch rotation) key operations refuse until update redeploys', async (t) => {
    const sandbox = await installed(t);
    // As observed on Cloudflare: workers/triggered_by "secret", no workers/message (RUNBOOK, point-in-time restore step 9).
    sandbox.update((state) => {
      const worker = state.workers['oi-acme'];
      worker.secrets.ANALYSIS_RECOVERY_EPOCH = digest(`ep_${'e'.repeat(32)}`);
      worker.deployments.push({ at: new Date().toISOString(), triggeredBy: 'secret' });
    });
    for (const [flag, input] of [
      [['--rotate-provider-key', 'gemini'], { GEMINI_API_KEY: 'AIzaFixtureRotatedKey-9876543210' }],
      [['--add-provider-key', 'openai'], { OPENAI_API_KEY: KEYS.OPENAI_API_KEY }],
    ]) {
      const bulk = bulkCalls(sandbox).length;
      const refused = await sandbox.run('update', [...UPDATE, ...flag, '--secrets-stdin'], { input: JSON.stringify(input) });
      assert.equal(refused.code, 2, refused.output);
      assert.match(refused.stderr, /is neither a deploy\.mjs release nor one this installer recorded/);
      assert.equal(bulkCalls(sandbox).length, bulk, 'nothing uploaded');
    }
    const redeploy = await sandbox.run('update', UPDATE);
    assert.equal(redeploy.code, 0, redeploy.output);
    assert.equal(sandbox.state().workers['oi-acme'].secrets.ANALYSIS_RECOVERY_EPOCH, digest(`ep_${'e'.repeat(32)}`), 'the rotated epoch stays bound');
    const added = await sandbox.run('update', [...UPDATE, '--add-provider-key', 'openai', '--secrets-stdin'], { input: JSON.stringify({ OPENAI_API_KEY: KEYS.OPENAI_API_KEY }) });
    assert.equal(added.code, 0, added.output);
  });

  test('the staging-shaped v1 receipt upgrades on its first key operation and binds the other three keys without a deploy', async (t) => {
    const v1 = JSON.parse(readFileSync(V1_STAGING, 'utf8'));
    const sandbox = await createSandbox(t, { state: { accounts: [{ id: v1.accountId, name: 'Staging fixture' }], subdomain: 'example' } });
    const dir = sandbox.installDir('example-studio', 'staging');
    mkdirSync(dir, { recursive: true });
    copyFileSync(V1_STAGING, path.join(dir, 'receipt.json'));
    chmodSync(path.join(dir, 'receipt.json'), 0o600);
    const vars = buildInstallationConfig(template, migrateReceipt(structuredClone(v1)), { bootstrap: '' }).vars;
    sandbox.update((state) => {
      for (const [name, record] of Object.entries(v1.resources)) {
        if (record.kind !== 'worker') state.queues[name] = { id: record.id, createdAt: record.createdAt };
      }
      state.workers[v1.names.worker] = {
        draft: false,
        vars,
        secrets: Object.fromEntries(['ADMIN_PASSWORD', 'SESSION_SECRET', 'PARTICIPANT_TOKEN_SECRET', 'RATE_LIMIT_SALT', 'OPERATOR_TOKEN', 'ANALYSIS_RECOVERY_EPOCH', 'GEMINI_API_KEY']
          .map((name) => [name, digest(`staging-${name}`)])),
        deployments: v1.deployments.map((entry) => ({ at: entry.at, vars, message: `openinterviewer ${entry.commit.slice(0, 12)}` })),
      };
      state.objects[`${v1.names.worker}|${v1.workspaceId}|eu`] = { maintenance: 'open', bootstrap: 'open', initializedAt: v1.phases['workspace-init'] };
    });

    const run = await sandbox.run('update', ['--install', 'example-studio', '--env', 'staging', '--add-provider-key', 'claude,openai,openrouter', '--secrets-stdin', '--yes'], {
      input: JSON.stringify(KEYS),
    });
    assert.equal(run.code, 0, run.output);
    const state = sandbox.state();
    assert.deepEqual(state.deploys, [], 'no deploy');
    assert.deepEqual(state.secretBulkCalls.map((call) => call.names), [['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY']]);
    const receipt = sandbox.receipt('example-studio', 'staging');
    assert.equal(receipt.formatVersion, 2);
    assert.deepEqual(receipt.providerKeys, ['gemini', 'claude', 'openai', 'openrouter']);
    assert.equal(receipt.provider, 'gemini');
    for (const field of ['workspaceId', 'epochFingerprint', 'names', 'origin', 'workersDevUrl', 'resources', 'phases', 'deployments', 'operatorToken', 'secrets', 'createdAt']) {
      assert.deepEqual(receipt[field], v1[field], `${field} preserved`);
    }
    assert.equal(receipt.lastVerification.status, 'ready');
    assert.deepEqual(JSON.parse(readFileSync(V1_STAGING, 'utf8')), v1, 'the fixture itself is untouched');
    assertNoSecretLeak(sandbox, [run], Object.values(KEYS));

    // The migration kept the original for a rollback to a pre-format-2 release: byte-identical, same mode.
    const copy = path.join(dir, 'receipt.format1.json');
    const original = readFileSync(V1_STAGING);
    assert.deepEqual(readFileSync(copy), original, 'receipt.format1.json is the original v1 receipt, byte for byte');
    assert.equal(statSync(copy).mode & 0o777, 0o600, 'the copy keeps the receipt\'s mode');
    const first = statSync(copy);

    // Later saves of the format-2 receipt leave the copy alone.
    const again = await sandbox.run('update', ['--install', 'example-studio', '--env', 'staging', '--yes']);
    assert.equal(again.code, 0, again.output);
    assert.equal(statSync(copy).ino, first.ino, 'written exactly once');
    assert.deepEqual(readFileSync(copy), original);

    // Rolled back and forward again: the older installer recorded its own deployments in the restored
    // format-1 receipt. The next migration keeps that newer receipt as the copy (a second rollback needs
    // it) and moves the earlier, different copy aside instead of overwriting it.
    const rolledBack = { ...JSON.parse(original.toString('utf8')), updatedAt: '2026-10-01T00:00:00.000Z' };
    const rolledBackText = `${JSON.stringify(rolledBack, null, 2)}\n`;
    writeFileSync(path.join(dir, 'receipt.json'), rolledBackText, { mode: 0o600 });
    const forward = await sandbox.run('update', ['--install', 'example-studio', '--env', 'staging', '--yes']);
    assert.equal(forward.code, 0, forward.output);
    assert.equal(sandbox.receipt('example-studio', 'staging').formatVersion, 2, 're-migrated');
    assert.equal(readFileSync(copy, 'utf8'), rolledBackText, 'the copy is the format-1 receipt migrated last');
    assert.deepEqual(readFileSync(path.join(dir, 'receipt.format1.1.json')), original, 'the earlier copy is kept aside, unchanged');

    // Migrating the same format-1 bytes again adds no further copy.
    writeFileSync(path.join(dir, 'receipt.json'), rolledBackText, { mode: 0o600 });
    const same = await sandbox.run('update', ['--install', 'example-studio', '--env', 'staging', '--yes']);
    assert.equal(same.code, 0, same.output);
    assert.equal(existsSync(path.join(dir, 'receipt.format1.2.json')), false, 'identical bytes are not copied twice');
  });

  test('a receipt created as format 2 never gets a format-1 copy', async (t) => {
    const sandbox = await installed(t);
    assert.equal((await sandbox.run('update', UPDATE)).code, 0);
    assert.equal(existsSync(path.join(sandbox.installDir(), 'receipt.format1.json')), false);
  });

  test('plan lists every provider key an apply will request, and the recorded ones afterwards', async (t) => {
    const sandbox = await createSandbox(t);
    const fresh = JSON.parse((await sandbox.run('plan', ['--install', 'acme', '--env', 'production', '--provider', 'claude', '--provider-keys', 'claude,gemini', '--json'])).stdout);
    assert.deepEqual(fresh.secrets.request, ['ADMIN_PASSWORD', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY']);
    assert.deepEqual(fresh.providerKeys, ['gemini', 'claude']);
    assert.equal(fresh.vars.AI_PROVIDER, 'claude');
    const bad = await sandbox.run('plan', ['--install', 'acme', '--env', 'production', '--provider', 'claude', '--provider-keys', 'gemini']);
    assert.equal(bad.code, 2, bad.output);

    assert.equal((await sandbox.run('apply', applyArgs(sandbox, { extra: ['--provider-keys', 'gemini,openai'] }), { input: stdinSecrets({ OPENAI_API_KEY: KEYS.OPENAI_API_KEY }) })).code, 0);
    const installedPlan = JSON.parse((await sandbox.run('plan', ['--install', 'acme', '--env', 'production', '--provider-keys', 'all', '--json'])).stdout);
    assert.deepEqual(installedPlan.providerKeys, ['gemini', 'openai']);
    assert.ok(installedPlan.secrets.alreadySet.includes('OPENAI_API_KEY'));
    assert.match(installedPlan.notes.join('\n'), /provider keys: installed gemini, openai; add one with update --add-provider-key/);
  });
});
