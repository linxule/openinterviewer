// update --forget-provider-key: after a manual `wrangler secret delete`, drop
// non-default providers from the receipt once their keys are observed gone. The
// installer never deletes a secret, uploads nothing and deploys nothing.
// Against the simulated account only.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { digest } from './fixtures/fake-state.mjs';
import { applyArgs, assertNoSecretLeak, createSandbox, mutations, stdinSecrets } from './helpers.mjs';

const UPDATE = ['--install', 'acme', '--env', 'production', '--yes'];
const FORGET = (provider) => [...UPDATE, '--forget-provider-key', provider];
const KEYS = {
  ANTHROPIC_API_KEY: 'sk-ant-fixture-claude-0123456789',
  OPENAI_API_KEY: 'sk-fixture-openai-0123456789ab',
};

async function installed(t, keys = 'gemini,openai') {
  const sandbox = await createSandbox(t);
  const secrets = Object.fromEntries(Object.entries(KEYS).filter(([name]) => (name === 'OPENAI_API_KEY' && keys.includes('openai')) || (name === 'ANTHROPIC_API_KEY' && keys.includes('claude'))));
  const run = await sandbox.run('apply', applyArgs(sandbox, { extra: ['--provider-keys', keys] }), { input: stdinSecrets(secrets) });
  assert.equal(run.code, 0, run.output);
  return sandbox;
}

/** The operator's `wrangler secret delete`: the name goes and, as for a put, a secret-triggered deployment appears. */
function deleteByHand(sandbox, name, { deploys = true } = {}) {
  sandbox.update((state) => {
    const worker = state.workers['oi-acme'];
    delete worker.secrets[name];
    if (deploys) worker.deployments.push({ at: new Date().toISOString(), triggeredBy: 'secret' });
  });
}

const receiptText = (sandbox) => readFileSync(path.join(sandbox.installDir(), 'receipt.json'), 'utf8');
const secretCommands = (sandbox, verb) => sandbox.state().invocations.filter((entry) => entry.tool === 'wrangler' && entry.argv[0] === 'secret' && entry.argv[1] === verb);

describe('setup:cloudflare update --forget-provider-key', { concurrency: 6 }, () => {
  test('after a manual delete, drops the provider and records the event; no upload, no deploy, drift clears', async (t) => {
    const sandbox = await installed(t);
    deleteByHand(sandbox, 'OPENAI_API_KEY');

    // Before the forget, the missing recorded key is drift.
    const drift = await sandbox.run('update', UPDATE);
    assert.equal(drift.code, 2, drift.output);
    assert.match(drift.stderr, /secret OPENAI_API_KEY: missing on oi-acme/);
    assert.match(drift.stderr, /If a provider key was deleted on purpose \(wrangler secret delete\), record that with update --forget-provider-key openai --yes/);

    const before = sandbox.state();
    const run = await sandbox.run('update', [...FORGET('openai'), '--json']);
    assert.equal(run.code, 0, run.output);
    const after = sandbox.state();
    assert.deepEqual(mutations(after), mutations(before), 'no deploy, no secret upload, no queue or gateway write');
    assert.equal(after.deploys.length, before.deploys.length);
    assert.deepEqual(secretCommands(sandbox, 'delete'), [], 'the installer never deletes a secret');
    assert.deepEqual(after.workers['oi-acme'].secrets, before.workers['oi-acme'].secrets);
    assert.deepEqual(after.workers['oi-acme'].vars, before.workers['oi-acme'].vars);

    const receipt = sandbox.receipt();
    assert.deepEqual(receipt.providerKeys, ['gemini']);
    assert.equal(receipt.provider, 'gemini');
    assert.equal(receipt.pendingChange, undefined);
    assert.equal(receipt.secretEvents.length, 1);
    const { at, ...event } = receipt.secretEvents[0];
    assert.deepEqual(event, { kind: 'forget-provider-key', names: ['OPENAI_API_KEY'], uploaded: [], deploymentId: null });
    assert.ok(Number.isFinite(Date.parse(at)));
    assert.equal(receipt.lastVerification.status, 'ready');

    const result = JSON.parse(run.stdout);
    assert.equal(result.operation, 'forget-provider-key');
    assert.equal(result.status, 'ready');
    assert.deepEqual(result.providerKeys, ['gemini']);
    assert.match(run.stderr, /Forgot OPENAI_API_KEY on oi-acme; provider keys: gemini/);

    // The drift check no longer requires or reports the key, and verify passes.
    const plain = await sandbox.run('update', UPDATE);
    assert.equal(plain.code, 0, plain.output);
    assert.doesNotMatch(plain.output, /OPENAI_API_KEY/);
    const verify = await sandbox.run('verify', ['--install', 'acme', '--env', 'production']);
    assert.equal(verify.code, 0, verify.output);
    assertNoSecretLeak(sandbox, [drift, run, plain, verify], Object.values(KEYS));
  });

  test('a repeat run after success refuses and changes nothing', async (t) => {
    const sandbox = await installed(t);
    deleteByHand(sandbox, 'OPENAI_API_KEY');
    const first = await sandbox.run('update', FORGET('openai'));
    assert.equal(first.code, 0, first.output);
    const text = receiptText(sandbox);
    const invocations = sandbox.state().invocations.length;
    const again = await sandbox.run('update', FORGET('openai'));
    assert.equal(again.code, 2, again.output);
    assert.match(again.stderr, /openai is not recorded \(gemini\); it was forgotten at \S+, nothing to do/);
    assert.equal(receiptText(sandbox), text, 'receipt untouched');
    assert.equal(sandbox.state().invocations.length, invocations, 'refused before any wrangler call');
  });

  test('refuses while the key is still bound, with the delete command, and changes nothing', async (t) => {
    const sandbox = await installed(t);
    const before = mutations(sandbox.state()).length;
    const text = receiptText(sandbox);
    const run = await sandbox.run('update', FORGET('openai'));
    assert.equal(run.code, 2, run.output);
    assert.match(run.stderr, /OPENAI_API_KEY is still bound to oi-acme; the installer never deletes a secret, so nothing was changed/);
    assert.match(run.stderr, /wrangler secret delete OPENAI_API_KEY --name oi-acme/);
    assert.match(run.stderr, /rerun update --forget-provider-key openai --yes/);
    assert.equal(receiptText(sandbox), text, 'receipt untouched');
    assert.equal(mutations(sandbox.state()).length, before);
    assert.deepEqual(secretCommands(sandbox, 'delete'), []);
    assert.equal(sandbox.state().workers['oi-acme'].secrets.OPENAI_API_KEY, digest(KEYS.OPENAI_API_KEY), 'still bound');
  });

  test('exempts only the named keys from the drift check; two deleted keys are forgotten in one run', async (t) => {
    const sandbox = await installed(t, 'gemini,claude,openai');
    deleteByHand(sandbox, 'OPENAI_API_KEY');
    deleteByHand(sandbox, 'ANTHROPIC_API_KEY');
    const text = receiptText(sandbox);
    const run = await sandbox.run('update', FORGET('openai'));
    assert.equal(run.code, 2, run.output);
    assert.match(run.stderr, /drift detected; nothing was changed/);
    assert.match(run.stderr, /secret ANTHROPIC_API_KEY: missing on oi-acme/);
    assert.doesNotMatch(run.stderr, /secret OPENAI_API_KEY: missing/);
    assert.match(run.stderr, /record that with update --forget-provider-key claude,openai --yes/);
    assert.equal(receiptText(sandbox), text);

    const both = await sandbox.run('update', FORGET('openai,claude'));
    assert.equal(both.code, 0, both.output);
    const receipt = sandbox.receipt();
    assert.deepEqual(receipt.providerKeys, ['gemini']);
    assert.equal(receipt.secretEvents.length, 1);
    assert.deepEqual(receipt.secretEvents[0].names, ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
  });

  test('a partly deleted list refuses and names only the keys still bound', async (t) => {
    const sandbox = await installed(t, 'gemini,claude,openai');
    deleteByHand(sandbox, 'OPENAI_API_KEY');
    const text = receiptText(sandbox);
    const run = await sandbox.run('update', FORGET('claude,openai'));
    assert.equal(run.code, 2, run.output);
    assert.match(run.stderr, /ANTHROPIC_API_KEY is still bound to oi-acme/);
    assert.match(run.stderr, /wrangler secret delete ANTHROPIC_API_KEY --name oi-acme/);
    assert.doesNotMatch(run.stderr, /wrangler secret delete OPENAI_API_KEY/);
    assert.match(run.stderr, /rerun update --forget-provider-key claude,openai --yes/);
    assert.equal(receiptText(sandbox), text);
  });

  test('the delete\'s deployment blocks the next key operation until update redeploys; a key can be added back', async (t) => {
    const sandbox = await installed(t);
    deleteByHand(sandbox, 'OPENAI_API_KEY');
    assert.equal((await sandbox.run('update', FORGET('openai'))).code, 0);
    const rotateArgs = [...UPDATE, '--rotate-provider-key', 'gemini', '--secrets-stdin'];
    const rotateInput = JSON.stringify({ GEMINI_API_KEY: 'AIzaFixtureRotatedKey-9876543210' });
    const refused = await sandbox.run('update', rotateArgs, { input: rotateInput });
    assert.equal(refused.code, 2, refused.output);
    assert.match(refused.stderr, /is neither a deploy\.mjs release nor one this installer recorded/);
    assert.equal((await sandbox.run('update', UPDATE)).code, 0);
    const rotated = await sandbox.run('update', rotateArgs, { input: rotateInput });
    assert.equal(rotated.code, 0, rotated.output);
    const added = await sandbox.run('update', [...UPDATE, '--add-provider-key', 'openai', '--secrets-stdin'], { input: JSON.stringify({ OPENAI_API_KEY: 'sk-fixture-openai-readded-0123' }) });
    assert.equal(added.code, 0, added.output);
    assert.deepEqual(sandbox.receipt().providerKeys, ['gemini', 'openai']);
    assertNoSecretLeak(sandbox, [refused, rotated, added], ['AIzaFixtureRotatedKey-9876543210', 'sk-fixture-openai-readded-0123']);
  });

  test('a forget event does not hide the previous key operation\'s recorded deployment', async (t) => {
    const sandbox = await installed(t);
    const rotateArgs = [...UPDATE, '--rotate-provider-key', 'gemini', '--secrets-stdin'];
    assert.equal((await sandbox.run('update', rotateArgs, { input: JSON.stringify({ GEMINI_API_KEY: 'AIzaFixtureRotatedKey-9876543210' }) })).code, 0);
    // A delete that made no deployment of its own: the rotation's deployment is still the newest.
    deleteByHand(sandbox, 'OPENAI_API_KEY', { deploys: false });
    assert.equal((await sandbox.run('update', FORGET('openai'))).code, 0);
    const again = await sandbox.run('update', rotateArgs, { input: JSON.stringify({ GEMINI_API_KEY: 'AIzaFixtureRotatedAgain-012345678' }) });
    assert.equal(again.code, 0, again.output);
    assert.deepEqual(sandbox.receipt().secretEvents.map((entry) => entry.kind), ['rotate-provider-key', 'forget-provider-key', 'rotate-provider-key']);
  });

  for (const [label, keys, args, pattern] of [
    ['an unknown provider', 'gemini,openai', FORGET('mistral'), /--forget-provider-key: unknown provider "mistral"/],
    ['all providers', 'gemini,openai', FORGET('all'), /--forget-provider-key takes provider names, not all/],
    ['a list with the default provider', 'gemini,claude,openai', FORGET('openai,gemini'), /gemini is the default provider \(AI_PROVIDER\)/],
    ['a provider that is not recorded', 'gemini,openai', FORGET('claude'), /claude is not recorded \(gemini, openai\); there is nothing to forget/],
    ['the default provider', 'gemini,openai', FORGET('gemini'), /gemini is the default provider \(AI_PROVIDER\)\. Switch the default first/],
    ['the last remaining key', 'gemini', FORGET('gemini'), /forgetting gemini would leave no provider key/],
    ['another key operation at once', 'gemini,openai', [...FORGET('openai'), '--rotate-provider-key', 'gemini'], /update runs one operation at a time; got --rotate-provider-key and --forget-provider-key/],
    ['a provider change at once', 'gemini,openai', [...FORGET('openai'), '--provider', 'openai', '--change-provider'], /update runs one operation at a time; got --change-provider and --forget-provider-key/],
    ['no --yes', 'gemini,openai', ['--install', 'acme', '--env', 'production', '--forget-provider-key', 'openai'], /--yes is required/],
  ]) {
    test(`refuses ${label} before any wrangler call`, async (t) => {
      const sandbox = await installed(t, keys);
      if (keys.includes('openai')) deleteByHand(sandbox, 'OPENAI_API_KEY');
      const invocations = sandbox.state().invocations.length;
      const text = receiptText(sandbox);
      const run = await sandbox.run('update', args);
      assert.equal(run.code, 2, run.output);
      assert.match(run.stderr, pattern);
      assert.equal(sandbox.state().invocations.length, invocations, 'no wrangler, deploy or git call');
      assert.equal(receiptText(sandbox), text, 'receipt untouched');
    });
  }

  test('refuses while another update operation is pending', async (t) => {
    const sandbox = await installed(t);
    sandbox.update((state) => { state.failures.push({ at: 'secret bulk', when: 'after' }); });
    const input = JSON.stringify({ GEMINI_API_KEY: 'AIzaFixtureRotatedKey-9876543210' });
    const interrupted = await sandbox.run('update', [...UPDATE, '--rotate-provider-key', 'gemini', '--secrets-stdin'], { input });
    assert.equal(interrupted.code, 1, interrupted.output);
    deleteByHand(sandbox, 'OPENAI_API_KEY', { deploys: false });
    const text = receiptText(sandbox);
    const run = await sandbox.run('update', FORGET('openai'));
    assert.equal(run.code, 2, run.output);
    assert.match(run.stderr, /rotating the gemini key, started at .* has not finished/);
    assert.equal(receiptText(sandbox), text);
    assert.deepEqual(sandbox.receipt().providerKeys, ['gemini', 'openai']);
  });

  test('apply, resume and config refuse --forget-provider-key', async (t) => {
    const fresh = await createSandbox(t);
    const apply = await fresh.run('apply', applyArgs(fresh, { extra: ['--forget-provider-key', 'openai'] }), { input: stdinSecrets() });
    assert.equal(apply.code, 2, apply.output);
    assert.match(apply.stderr, /--forget-provider-key is an update option/);
    assert.deepEqual(mutations(fresh.state()), []);

    const sandbox = await installed(t);
    const resume = await sandbox.run('resume', ['--install', 'acme', '--env', 'production', '--yes', '--forget-provider-key', 'openai']);
    assert.equal(resume.code, 2, resume.output);
    assert.match(resume.stderr, /--forget-provider-key is an update option/);
    const config = await sandbox.run('config', ['--install', 'acme', '--env', 'production', '--forget-provider-key', 'openai']);
    assert.equal(config.code, 2, config.output);
    assert.match(config.stderr, /takes no --forget-provider-key/);
    assert.deepEqual(sandbox.receipt().providerKeys, ['gemini', 'openai']);
  });
});
