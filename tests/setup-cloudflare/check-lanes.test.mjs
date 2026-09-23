// check:cloudflare lane environments (VERIFY-01) and the test runtimes'
// compatibility settings. check.mjs runs from a copy in a temporary git
// repository with a recording `npm` first on PATH, so no lane really runs.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { credentialNames } from '../../scripts/cloudflare/credential-env.mjs';
import { ROOT, readJsonc, sha256Tree } from '../../scripts/cloudflare/lib.mjs';

function write(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** A committed copy of check.mjs and its imports, with a built-artifact manifest for HEAD. */
function checkCheckout(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'oi-check-lanes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo');
  for (const name of ['check.mjs', 'lib.mjs', 'credential-env.mjs']) {
    mkdirSync(path.join(repo, 'scripts', 'cloudflare'), { recursive: true });
    copyFileSync(path.join(ROOT, 'scripts', 'cloudflare', name), path.join(repo, 'scripts', 'cloudflare', name));
  }
  write(path.join(repo, '.gitignore'), 'dist\n');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd: repo,
    env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1' },
    encoding: 'utf8',
  });
  git('init', '-q');
  git('add', '.');
  git('commit', '-q', '-m', 'fixture');
  const commit = git('rev-parse', 'HEAD').trim();
  const artifact = path.join(repo, 'dist', 'cloudflare', 'artifact');
  write(path.join(artifact, 'worker', 'worker.js'), 'export default {};\n');
  write(path.join(artifact, 'manifest.json'), JSON.stringify({
    source: { commit, dirty: false },
    artifact: { workerSha256: sha256Tree(path.join(artifact, 'worker')).sha256, assetsSha256: 'fixture' },
  }));
  // The recording npm: every lane's argv and complete environment, then success.
  const log = path.join(dir, 'lanes.ndjson');
  write(path.join(dir, 'record-lane.mjs'), [
    "import { appendFileSync } from 'node:fs';",
    `appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }) + '\\n');`,
    '',
  ].join('\n'));
  write(path.join(dir, 'bin', 'npm'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(dir, 'record-lane.mjs'))} "$@"\n`);
  chmodSync(path.join(dir, 'bin', 'npm'), 0o755);
  return {
    dir,
    repo,
    lanes: () => readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)),
    receipt: () => JSON.parse(readFileSync(path.join(artifact, 'receipt.json'), 'utf8')),
  };
}

const PLANTED = {
  CLOUDFLARE_API_TOKEN: 'cf-planted-token-value-3b9e',
  CLAUDE_CODE_MESSAGING_TOKEN: 'messaging-planted-value-81aa',
  OPENAI_API_KEY: 'sk-planted-provider-value-5c20',
};

test('check:cloudflare runs every lane without credential-like variables, names them once, and keeps what lanes need', (t) => {
  const box = checkCheckout(t);
  const kept = {
    PATH: `${path.join(box.dir, 'bin')}${path.delimiter}${process.env.PATH}`,
    HOME: box.dir,
    TMPDIR: os.tmpdir(),
    CI: 'true',
    LANG: 'en_US.UTF-8',
    PLAYWRIGHT_BROWSERS_PATH: path.join(box.dir, 'browsers'),
    REDIS_URL: 'redis://127.0.0.1:6390',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const lanes = ['installer', 'redis-crash', 'redis-inventory', 'build:node-gateway'];
  const run = spawnSync(process.execPath, ['scripts/cloudflare/check.mjs', '--skip-build', '--only', lanes.join(',')], {
    cwd: box.repo,
    env: { ...kept, ...PLANTED },
    encoding: 'utf8',
  });
  const output = `${run.stdout}\n${run.stderr}`;
  // A partial (--only) run never writes a passing receipt.
  assert.equal(run.status, 1, output);
  assert.equal(box.receipt().status, 'partial');
  assert.deepEqual(box.receipt().lanes.map((lane) => [lane.lane, lane.exitCode]), lanes.map((name) => [name, 0]));

  const notice = 'Lanes run without credential-like environment variables; removed (names only): CLAUDE_CODE_MESSAGING_TOKEN, CLOUDFLARE_API_TOKEN, OPENAI_API_KEY';
  assert.equal(output.split(notice).length - 1, 1, `the removed names are printed exactly once:\n${output}`);

  const recorded = box.lanes();
  assert.deepEqual(recorded.map((lane) => lane.argv.join(' ')), [
    'run test:setup:cloudflare',
    'run test:redis-crash',
    'run test:inventory:redis',
    'run build',
  ]);
  for (const [index, lane] of recorded.entries()) {
    for (const name of Object.keys(PLANTED)) assert.equal(Object.hasOwn(lane.env, name), false, `${lanes[index]} received ${name}`);
    const text = JSON.stringify(lane.env);
    for (const value of [...Object.values(PLANTED)]) assert.equal(text.includes(value), false, `${lanes[index]} received a scrubbed value`);
    for (const name of ['PATH', 'HOME', 'TMPDIR', 'CI', 'LANG', 'PLAYWRIGHT_BROWSERS_PATH']) {
      assert.equal(lane.env[name], kept[name], `${lanes[index]} keeps ${name}`);
    }
  }
  for (const value of Object.values(PLANTED)) assert.equal(output.includes(value), false, 'the check printed a value');

  const byLane = Object.fromEntries(recorded.map((lane, index) => [lanes[index], lane.env]));
  // REDIS_URL as before: inherited, except the lanes that own a disposable redis-server.
  assert.equal(byLane.installer.REDIS_URL, kept.REDIS_URL);
  assert.equal(byLane['redis-crash'].REDIS_URL, '');
  assert.equal(byLane['redis-inventory'].REDIS_URL, '');
  // Build lanes still receive their synthetic fixture values, and only those.
  assert.equal(byLane['build:node-gateway'].ADMIN_PASSWORD, 'gateway-build-admin-password');
  assert.deepEqual(credentialNames(byLane['build:node-gateway']), [
    'ADMIN_PASSWORD', 'KV_REST_API_TOKEN', 'KV_REST_API_URL', 'PARTICIPANT_TOKEN_SECRET', 'SESSION_SECRET',
  ]);
  for (const name of ['installer', 'redis-crash', 'redis-inventory']) assert.deepEqual(credentialNames(byLane[name]), [], name);
});

test('the release check lists the Redis inventory lane next to the other Redis lanes', () => {
  const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'cloudflare', 'check.mjs'), '--list'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const names = run.stdout.trim().split('\n').map((line) => line.split(': ')[0]);
  assert.deepEqual(names.slice(names.indexOf('redis-contract'), names.indexOf('redis-contract') + 4), [
    'redis-contract', 'redis-crash', 'adversarial', 'redis-inventory',
  ]);
  assert.match(run.stdout, /^redis-inventory: npm run test:inventory:redis$/m);
  const scripts = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
  assert.equal(scripts['test:inventory:redis'], 'vitest run --config vitest.integration.config.mts tests/integration/inventoryRedis.test.ts');
});

test('every local Worker runtime uses the production compatibility date and flags', () => {
  const production = readJsonc(path.join(ROOT, 'wrangler.jsonc'));
  assert.ok(production.compatibility_flags.includes('global_fetch_strictly_public'));
  for (const file of ['cloudflare/test/wrangler.test.jsonc', 'cloudflare/test/wrangler.artifact.jsonc']) {
    const config = readJsonc(path.join(ROOT, file));
    assert.equal(config.compatibility_date, production.compatibility_date, file);
    assert.deepEqual([...config.compatibility_flags].sort(), [...production.compatibility_flags].sort(), file);
  }
});
