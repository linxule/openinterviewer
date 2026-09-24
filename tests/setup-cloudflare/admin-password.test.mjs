// update --rotate-admin-password: one upload of ADMIN_PASSWORD, no deploy,
// the same preconditions, pendingChange and secretEvents as the other key
// operations. Against the simulated account only.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { digest } from './fixtures/fake-state.mjs';
import { PASSWORD, applyArgs, assertNoSecretLeak, createSandbox, mutations, stdinSecrets } from './helpers.mjs';

const UPDATE = ['--install', 'acme', '--env', 'production', '--yes'];
const ROTATE = [...UPDATE, '--rotate-admin-password', '--secrets-stdin'];
const NEW_PASSWORD = 'rotated-horse-battery-staple-42';
const input = (value = NEW_PASSWORD) => JSON.stringify({ ADMIN_PASSWORD: value });
const deploymentId = (index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

async function installed(t) {
  const sandbox = await createSandbox(t);
  const run = await sandbox.run('apply', applyArgs(sandbox), { input: stdinSecrets() });
  assert.equal(run.code, 0, run.output);
  return sandbox;
}

const receiptText = (sandbox) => readFileSync(path.join(sandbox.installDir(), 'receipt.json'), 'utf8');
const bulkCalls = (sandbox) => sandbox.state().secretBulkCalls;

describe('setup:cloudflare update --rotate-admin-password', { concurrency: 6 }, () => {
  test('replaces ADMIN_PASSWORD alone in one upload, deploys nothing and records the event without the value', async (t) => {
    const sandbox = await installed(t);
    const before = sandbox.state();
    const run = await sandbox.run('update', [...ROTATE, '--json'], { input: input() });
    assert.equal(run.code, 0, run.output);
    const after = sandbox.state();
    assert.equal(after.deploys.length, before.deploys.length, 'no deploy');
    assert.equal(after.secretBulkCalls.length, before.secretBulkCalls.length + 1);
    assert.deepEqual(after.secretBulkCalls.at(-1).names, ['ADMIN_PASSWORD']);
    const secrets = after.workers['oi-acme'].secrets;
    assert.equal(secrets.ADMIN_PASSWORD, digest(NEW_PASSWORD));
    for (const [name, hash] of Object.entries(before.workers['oi-acme'].secrets)) {
      if (name !== 'ADMIN_PASSWORD') assert.equal(secrets[name], hash, `${name} unchanged`);
    }
    assert.deepEqual(after.workers['oi-acme'].vars, before.workers['oi-acme'].vars, 'no var changes');

    const receipt = sandbox.receipt();
    assert.equal(receipt.pendingChange, undefined);
    assert.equal(receipt.secretEvents.length, 1);
    const { at, ...event } = receipt.secretEvents[0];
    assert.deepEqual(event, { kind: 'rotate-admin-password', names: ['ADMIN_PASSWORD'], uploaded: ['ADMIN_PASSWORD'], deploymentId: deploymentId(4) });
    assert.ok(Number.isFinite(Date.parse(at)));
    assert.equal(receipt.lastVerification.status, 'ready');

    const result = JSON.parse(run.stdout);
    assert.equal(result.operation, 'rotate-admin-password');
    assert.equal(result.status, 'ready');
    assert.match(run.stderr, /Researcher sessions signed in before this rotation stay valid until they expire \(up to 7 days after sign-in\)/);
    assert.match(run.stderr, /Rotated ADMIN_PASSWORD on oi-acme/);

    // The recorded deployment satisfies the next key operation's version check.
    const again = await sandbox.run('update', ROTATE, { input: input('rotated-again-battery-staple-43') });
    assert.equal(again.code, 0, again.output);
    assert.equal(sandbox.state().deploys.length, before.deploys.length);
    assert.equal(sandbox.receipt().secretEvents.length, 2);
    assertNoSecretLeak(sandbox, [run, again], [NEW_PASSWORD, 'rotated-again-battery-staple-43']);
  });

  test('refuses while the newest deployment is not a checked release (a manual wrangler secret put), until update redeploys', async (t) => {
    const sandbox = await installed(t);
    // The owner's manual rotation on 24 September 2026: triggered_by "secret", no workers/message.
    sandbox.update((state) => {
      const worker = state.workers['oi-acme'];
      worker.secrets.ADMIN_PASSWORD = digest('set-by-hand-battery-staple-99');
      worker.deployments.push({ at: new Date().toISOString(), triggeredBy: 'secret' });
    });
    const bulk = bulkCalls(sandbox).length;
    const text = receiptText(sandbox);
    const refused = await sandbox.run('update', ROTATE, { input: input() });
    assert.equal(refused.code, 2, refused.output);
    assert.match(refused.stderr, /is neither a deploy\.mjs release nor one this installer recorded/);
    assert.match(refused.stderr, /Redeploy a checked release first/);
    assert.equal(bulkCalls(sandbox).length, bulk, 'nothing uploaded');
    assert.equal(receiptText(sandbox), text, 'receipt untouched');

    // A dashboard deploy is refused the same way.
    sandbox.update((state) => { state.workers['oi-acme'].deployments.push({ at: new Date().toISOString(), message: 'hotfix from the dashboard' }); });
    assert.equal((await sandbox.run('update', ROTATE, { input: input() })).code, 2);

    const redeploy = await sandbox.run('update', UPDATE);
    assert.equal(redeploy.code, 0, redeploy.output);
    const rotated = await sandbox.run('update', ROTATE, { input: input() });
    assert.equal(rotated.code, 0, rotated.output);
    assert.equal(sandbox.state().workers['oi-acme'].secrets.ADMIN_PASSWORD, digest(NEW_PASSWORD));
    assertNoSecretLeak(sandbox, [refused, redeploy, rotated], [NEW_PASSWORD, 'set-by-hand-battery-staple-99']);
  });

  test('refuses while another update operation is pending, and a pending rotation refuses every other command', async (t) => {
    const sandbox = await installed(t);
    sandbox.update((state) => { state.failures.push({ at: 'secret bulk', when: 'after' }); });
    const provider = await sandbox.run('update', [...UPDATE, '--rotate-provider-key', 'gemini', '--secrets-stdin'], { input: JSON.stringify({ GEMINI_API_KEY: 'AIzaFixtureRotatedKey-9876543210' }) });
    assert.equal(provider.code, 1, provider.output);
    assert.equal(sandbox.receipt().pendingChange.kind, 'rotate-provider-key');

    const bulk = bulkCalls(sandbox).length;
    const refused = await sandbox.run('update', ROTATE, { input: input() });
    assert.equal(refused.code, 2, refused.output);
    assert.match(refused.stderr, /rotating the gemini key, started at .* has not finished/);
    assert.equal(bulkCalls(sandbox).length, bulk);
    assert.equal(sandbox.receipt().pendingChange.kind, 'rotate-provider-key');
    const finished = await sandbox.run('update', [...UPDATE, '--rotate-provider-key', 'gemini', '--secrets-stdin'], { input: JSON.stringify({ GEMINI_API_KEY: 'AIzaFixtureRotatedKey-9876543210' }) });
    assert.equal(finished.code, 0, finished.output);

    // Now the other way round: a pending password rotation.
    sandbox.update((state) => { state.failures.push({ at: 'secret bulk', when: 'after' }); });
    const interrupted = await sandbox.run('update', ROTATE, { input: input() });
    assert.equal(interrupted.code, 1, interrupted.output);
    assert.equal(sandbox.receipt().pendingChange.kind, 'rotate-admin-password');
    const others = [
      ['update', UPDATE, undefined],
      ['update', [...UPDATE, '--rotate-provider-key', 'gemini', '--secrets-stdin'], JSON.stringify({ GEMINI_API_KEY: 'AIzaFixtureRotatedKey-0000000000' })],
      ['update', [...UPDATE, '--add-provider-key', 'openai', '--secrets-stdin'], JSON.stringify({ OPENAI_API_KEY: 'sk-fixture-openai-0123456789ab' })],
      ['config', ['--install', 'acme', '--env', 'production'], undefined],
      ['resume', ['--install', 'acme', '--env', 'production', '--yes'], undefined],
    ];
    for (const [command, args, stdin] of others) {
      const run = await sandbox.run(command, args, { input: stdin });
      assert.equal(run.code, 2, `${command} ${args.join(' ')}\n${run.output}`);
      assert.match(run.stderr, /rotating the administrator password \(ADMIN_PASSWORD\), started at .* has not finished/);
      assert.match(run.stderr, /update --rotate-admin-password --yes with the new password/);
    }
    const plan = JSON.parse((await sandbox.run('plan', ['--install', 'acme', '--env', 'production', '--json'])).stdout);
    assert.match(plan.notes.join('\n'), /administrator password: a rotation has not finished; finish it with update --rotate-admin-password/);
    assertNoSecretLeak(sandbox, [provider, refused, finished, interrupted], [NEW_PASSWORD, 'AIzaFixtureRotatedKey-9876543210']);
  });

  test('a lost reply after the upload landed: rerunning finishes with one secretEvent', async (t) => {
    const sandbox = await installed(t);
    sandbox.update((state) => { state.failures.push({ at: 'secret bulk', when: 'after' }); });
    const first = await sandbox.run('update', ROTATE, { input: input() });
    assert.equal(first.code, 1, first.output);
    assert.match(first.stderr, /rerun update --rotate-admin-password with the new password to finish it/);
    const pending = sandbox.receipt().pendingChange;
    assert.equal(pending.kind, 'rotate-admin-password');
    assert.equal(pending.deploymentBefore, deploymentId(3));
    assert.deepEqual(Object.keys(pending).sort(), ['deploymentBefore', 'kind', 'startedAt']);
    assert.equal(sandbox.state().workers['oi-acme'].secrets.ADMIN_PASSWORD, digest(NEW_PASSWORD), 'the upload landed');
    assert.deepEqual(sandbox.receipt().secretEvents, []);

    // The newest deployment is now the interrupted upload's own (no message), accepted while finishing it.
    const again = await sandbox.run('update', ROTATE, { input: input() });
    assert.equal(again.code, 0, again.output);
    const receipt = sandbox.receipt();
    assert.equal(receipt.pendingChange, undefined);
    assert.equal(receipt.secretEvents.length, 1);
    assert.equal(receipt.secretEvents[0].kind, 'rotate-admin-password');
    assert.deepEqual(receipt.secretEvents[0].uploaded, ['ADMIN_PASSWORD']);
    assert.equal(receipt.secretEvents[0].deploymentId, deploymentId(5), 'the deployment the finishing upload created');
    assert.equal(sandbox.state().workers['oi-acme'].secrets.ADMIN_PASSWORD, digest(NEW_PASSWORD));
    assert.equal(sandbox.state().deploys.length, 3, 'still only the three apply deploys');
    // Afterwards an ordinary key operation passes the version check again.
    const provider = await sandbox.run('update', [...UPDATE, '--rotate-provider-key', 'gemini', '--secrets-stdin'], { input: JSON.stringify({ GEMINI_API_KEY: 'AIzaFixtureRotatedKey-9876543210' }) });
    assert.equal(provider.code, 0, provider.output);
    assertNoSecretLeak(sandbox, [first, again, provider], [NEW_PASSWORD, 'AIzaFixtureRotatedKey-9876543210']);
  });

  const tooLong = `p${'a'.repeat(1100)}`;
  for (const [label, args, stdin, pattern, value] of [
    ['an empty password', ROTATE, input(''), /ADMIN_PASSWORD is blank/, null],
    ['a password shorter than 16 characters', ROTATE, input('short-pass-1234'), /ADMIN_PASSWORD must contain at least 16 characters/, 'short-pass-1234'],
    ['a password with surrounding whitespace', ROTATE, input(` ${NEW_PASSWORD}`), /ADMIN_PASSWORD has leading or trailing whitespace/, NEW_PASSWORD],
    ['a placeholder password', ROTATE, input('change-me-battery-staple-00'), /ADMIN_PASSWORD still contains a template placeholder/, 'change-me-battery-staple-00'],
    ['a password whose sign-in body exceeds 1 KiB', ROTATE, input(tooLong), /ADMIN_PASSWORD is too long: its sign-in request body would be 1116 bytes/, tooLong],
    ['a non-string password', ROTATE, JSON.stringify({ ADMIN_PASSWORD: 12345678901234567 }), /ADMIN_PASSWORD is blank/, null],
    ['stdin without the password', ROTATE, '{}', /--secrets-stdin input lacks ADMIN_PASSWORD/, null],
    ['stdin with another credential', ROTATE, JSON.stringify({ ADMIN_PASSWORD: NEW_PASSWORD, GEMINI_API_KEY: 'AIzaFixtureRotatedKey-9876543210' }), /unexpected names: GEMINI_API_KEY/, NEW_PASSWORD],
    ['stdin that is not JSON', ROTATE, NEW_PASSWORD, /--secrets-stdin input is not valid JSON/, NEW_PASSWORD],
    ['no protected input (no --secrets-stdin and no terminal)', [...UPDATE, '--rotate-admin-password'], input(), /credentials need protected input/, NEW_PASSWORD],
    ['two operations at once', [...ROTATE, '--rotate-provider-key', 'gemini'], input(), /update runs one operation at a time; got --rotate-provider-key and --rotate-admin-password/, NEW_PASSWORD],
    ['no --yes', ['--install', 'acme', '--env', 'production', '--rotate-admin-password', '--secrets-stdin'], input(), /--yes is required/, NEW_PASSWORD],
  ]) {
    test(`refuses ${label} before anything is written`, async (t) => {
      const sandbox = await installed(t);
      const before = mutations(sandbox.state()).length;
      const secret = sandbox.state().workers['oi-acme'].secrets.ADMIN_PASSWORD;
      const text = receiptText(sandbox);
      const run = await sandbox.run('update', args, { input: stdin });
      assert.equal(run.code, 2, run.output);
      assert.match(run.stderr, pattern);
      assert.equal(mutations(sandbox.state()).length, before, 'no remote write');
      assert.equal(sandbox.state().workers['oi-acme'].secrets.ADMIN_PASSWORD, secret);
      assert.equal(receiptText(sandbox), text, 'receipt untouched (no pendingChange)');
      if (value) assert.ok(!run.output.includes(value), 'the refused value is not echoed');
    });
  }

  test('apply, resume and config refuse --rotate-admin-password; the value never reaches them', async (t) => {
    const fresh = await createSandbox(t);
    const apply = await fresh.run('apply', applyArgs(fresh, { extra: ['--rotate-admin-password'] }), { input: stdinSecrets() });
    assert.equal(apply.code, 2, apply.output);
    assert.match(apply.stderr, /--rotate-admin-password is an update option; apply and resume never change .* the administrator password/);
    assert.deepEqual(mutations(fresh.state()), []);

    const sandbox = await installed(t);
    const resume = await sandbox.run('resume', ['--install', 'acme', '--env', 'production', '--yes', '--rotate-admin-password']);
    assert.equal(resume.code, 2, resume.output);
    assert.match(resume.stderr, /--rotate-admin-password is an update option/);
    const config = await sandbox.run('config', ['--install', 'acme', '--env', 'production', '--rotate-admin-password']);
    assert.equal(config.code, 2, config.output);
    assert.match(config.stderr, /takes no --rotate-admin-password/);
    assert.equal(sandbox.state().workers['oi-acme'].secrets.ADMIN_PASSWORD, digest(PASSWORD));
  });
});
