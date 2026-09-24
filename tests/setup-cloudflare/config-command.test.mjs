// setup:cloudflare config: rewrites an installation's wrangler config from its
// receipt (the file CI promotion deploys as CLOUDFLARE_INSTALL_CONFIG) with no
// remote call, and only for an installation whose bootstrap was cleared.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { ROOT, readJsonc } from '../../scripts/cloudflare/lib.mjs';
import { configDrift } from '../../scripts/cloudflare/deploy.mjs';
import { checkDeployedConfig } from '../../scripts/cloudflare/installer/verify.mjs';
import { applyArgs, createSandbox, stdinSecrets } from './helpers.mjs';

const CONFIG = ['--install', 'acme', '--env', 'production'];

async function installed(t) {
  const sandbox = await createSandbox(t);
  const run = await sandbox.run('apply', applyArgs(sandbox), { input: stdinSecrets() });
  assert.equal(run.code, 0, run.output);
  return sandbox;
}

/** Remote activity: every wrangler/deploy/git invocation and every request to the fake origin. */
const remote = (sandbox) => {
  const state = sandbox.state();
  return { invocations: state.invocations.length, requests: state.http.requests.length, deploys: state.deploys.length };
};

describe('setup:cloudflare config', { concurrency: 4 }, () => {
  test('regenerates the installation config from the receipt: no remote call, no bootstrap, drift-free, accepted by deploy --check-config', async (t) => {
    const sandbox = await installed(t);
    const file = path.join(sandbox.installDir(), 'wrangler.jsonc');
    const deployed = sandbox.config();
    const receiptText = readFileSync(path.join(sandbox.installDir(), 'receipt.json'), 'utf8');
    rmSync(file);
    const before = remote(sandbox);

    const run = await sandbox.run('config', CONFIG);
    assert.equal(run.code, 0, run.output);
    assert.equal(run.stdout.trim().split('\n').at(-1), file, 'the last line is the config path');
    assert.deepEqual(remote(sandbox), before, 'config makes no wrangler, deploy, git or HTTP call');
    assert.equal(readFileSync(path.join(sandbox.installDir(), 'receipt.json'), 'utf8'), receiptText, 'the receipt is unchanged');

    const config = sandbox.config();
    assert.deepEqual(config, deployed, 'the same config the installer last deployed');
    assert.equal(config.vars.WORKSPACE_BOOTSTRAP, '');
    const template = readJsonc(path.join(ROOT, 'wrangler.jsonc'));
    assert.deepEqual(configDrift(template, config), []);
    assert.deepEqual(checkDeployedConfig({ template, config }).diffs, []);
    // The CI promotion job's first step accepts it as it is.
    const check = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'cloudflare', 'deploy.mjs'), '--install', file, '--check-config'], {
      cwd: ROOT,
      env: { PATH: process.env.PATH },
      encoding: 'utf8',
    });
    assert.equal(check.status, 0, `${check.stdout}\n${check.stderr}`);
  });

  test('rewrites a hand-edited config and reports its path as JSON', async (t) => {
    const sandbox = await installed(t);
    const file = path.join(sandbox.installDir(), 'wrangler.jsonc');
    const deployed = sandbox.config();
    writeFileSync(file, readFileSync(file, 'utf8').replace(/"WORKSPACE_ID": "ws_[a-f0-9]+"/, `"WORKSPACE_ID": "ws_${'0'.repeat(32)}"`));
    const before = remote(sandbox);

    const run = await sandbox.run('config', [...CONFIG, '--json']);
    assert.equal(run.code, 0, run.output);
    assert.deepEqual(JSON.parse(run.stdout), {
      command: 'config',
      install: 'acme',
      env: 'production',
      path: file,
      worker: deployed.name,
      appBaseUrl: deployed.vars.APP_BASE_URL,
      provider: 'gemini',
      providerKeys: ['gemini'],
      aiTransport: 'direct',
      aiGateway: null,
    });
    assert.deepEqual(sandbox.config(), deployed);
    assert.deepEqual(remote(sandbox), before);
  });

  for (const [label, edit] of [
    ['before bootstrap-clear', (receipt) => { delete receipt.phases['bootstrap-clear']; delete receipt.phases.verify; }],
    ['with bootstrap-clear but no workspace-init (still bootstrapping)', (receipt) => { delete receipt.phases['workspace-init']; }],
  ]) {
    test(`refuses an incomplete installation ${label} and writes nothing`, async (t) => {
      const sandbox = await installed(t);
      const receiptFile = path.join(sandbox.installDir(), 'receipt.json');
      const receipt = sandbox.receipt();
      edit(receipt);
      writeFileSync(receiptFile, JSON.stringify(receipt, null, 2));
      const file = path.join(sandbox.installDir(), 'wrangler.jsonc');
      rmSync(file);
      const before = remote(sandbox);

      const run = await sandbox.run('config', CONFIG);
      assert.equal(run.code, 2, run.output);
      assert.match(run.stderr, /is not complete: WORKSPACE_BOOTSTRAP has not been cleared/);
      assert.equal(existsSync(file), false, 'no config is written');
      assert.deepEqual(remote(sandbox), before);
    });
  }

  test('refuses a missing receipt and options that request a change', async (t) => {
    const sandbox = await createSandbox(t);
    const missing = await sandbox.run('config', CONFIG);
    assert.equal(missing.code, 2, missing.output);
    assert.match(missing.stderr, /no receipt for acme \(production\)/);

    const changing = await sandbox.run('config', [...CONFIG, '--provider', 'openai', '--yes']);
    assert.equal(changing.code, 2, changing.output);
    assert.match(changing.stderr, /takes no --provider, --yes/);
    assert.equal(sandbox.state().invocations.length, 0);
  });
});
