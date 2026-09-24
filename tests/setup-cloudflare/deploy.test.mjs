// scripts/cloudflare/deploy.mjs itself (RT-04, gap review F2): the artifact
// preconditions against synthetic manifests and receipts, the bootstrap
// guard and the config-only mode. The installer tests use a fake deploy
// script, so these are the direct tests of the real one. Nothing here runs
// wrangler: every CLI case is refused (or is --check-config) before upload.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  bootstrapProblems,
  installationConfigProblems,
  missingInstallationVars,
  parseDeployArgs,
  transportVarProblems,
  verifyArtifact,
  waivedForDryRun,
} from '../../scripts/cloudflare/deploy.mjs';
import { ROOT, readJsonc, sha256File, sha256Tree } from '../../scripts/cloudflare/lib.mjs';
import { deriveNames } from '../../scripts/cloudflare/installer/model.mjs';
import { generateWorkspaceId } from '../../scripts/cloudflare/installer/secrets.mjs';
import { buildInstallationConfig, newReceipt } from '../../scripts/cloudflare/installer/state.mjs';

const DEPLOY = path.join(ROOT, 'scripts', 'cloudflare', 'deploy.mjs');
const COMMIT = 'c'.repeat(40);
const template = readJsonc(path.join(ROOT, 'wrangler.jsonc'));

function tempDir(t, prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A checkout root with a lockfile and template, and a checked artifact for COMMIT. */
function artifactFixture(t) {
  const root = tempDir(t, 'oi-deploy-');
  writeFileSync(path.join(root, 'package-lock.json'), '{ "lockfileVersion": 3 }\n');
  writeFileSync(path.join(root, 'wrangler.jsonc'), '{ "name": "template" }\n');
  const artifactDir = path.join(root, 'dist', 'cloudflare', 'artifact');
  mkdirSync(path.join(artifactDir, 'worker'), { recursive: true });
  mkdirSync(path.join(artifactDir, 'assets'), { recursive: true });
  writeFileSync(path.join(artifactDir, 'worker', 'worker.js'), 'export default {};\n');
  writeFileSync(path.join(artifactDir, 'assets', 'index.txt'), 'asset\n');
  const workerSha256 = sha256Tree(path.join(artifactDir, 'worker')).sha256;
  const assetsSha256 = sha256Tree(path.join(artifactDir, 'assets')).sha256;
  const fixture = {
    root,
    artifactDir,
    git: { commit: COMMIT, dirty: false },
    file: (name) => path.join(artifactDir, name),
    json(name, mutate) {
      const value = JSON.parse(readFileSync(fixture.file(name), 'utf8'));
      mutate(value);
      writeFileSync(fixture.file(name), `${JSON.stringify(value)}\n`);
    },
    check(options = {}) {
      return verifyArtifact({ root, artifactDir, git: fixture.git, ...options });
    },
  };
  writeFileSync(fixture.file('manifest.json'), `${JSON.stringify({
    formatVersion: 1,
    source: { commit: COMMIT, dirty: false },
    lockfileSha256: sha256File(path.join(root, 'package-lock.json')),
    templateConfigSha256: sha256File(path.join(root, 'wrangler.jsonc')),
    artifact: { main: 'worker.js', workerSha256, assetsSha256 },
  })}\n`);
  writeFileSync(fixture.file('receipt.json'), `${JSON.stringify({
    formatVersion: 1,
    status: 'passed',
    source: { commit: COMMIT },
    artifact: { workerSha256, assetsSha256 },
  })}\n`);
  return fixture;
}

test('verifyArtifact accepts a checked artifact for the current clean commit', (t) => {
  const fixture = artifactFixture(t);
  const { manifest, problems } = fixture.check();
  assert.deepEqual(problems, []);
  assert.equal(manifest.source.commit, COMMIT);
});

for (const [label, change, expected] of [
  ['a dirty checkout', (f) => { f.git = { ...f.git, dirty: true }; }, ['checkout has uncommitted or untracked files']],
  ['a missing manifest', (f) => rmSync(f.file('manifest.json')), ['no artifact manifest; run npm run build:cloudflare']],
  ['an unreadable manifest', (f) => writeFileSync(f.file('manifest.json'), '{ not json'), ['artifact manifest is not valid JSON']],
  ['an artifact from another commit', (f) => { f.git = { ...f.git, commit: 'd'.repeat(40) }; }, ['artifact was built from a different commit']],
  ['an artifact built from a dirty tree', (f) => f.json('manifest.json', (m) => { m.source.dirty = true; }), ['artifact was built from a dirty tree']],
  ['a changed lockfile', (f) => writeFileSync(path.join(f.root, 'package-lock.json'), '{ "lockfileVersion": 3, "x": 1 }\n'), ['package-lock.json changed since build']],
  ['a changed template', (f) => writeFileSync(path.join(f.root, 'wrangler.jsonc'), '{ "name": "changed" }\n'), ['wrangler.jsonc changed since build']],
  ['a modified worker bundle', (f) => writeFileSync(path.join(f.artifactDir, 'worker', 'worker.js'), 'export default { tampered: true };\n'), ['worker bundle differs from manifest']],
  ['an extra worker module', (f) => writeFileSync(path.join(f.artifactDir, 'worker', 'extra.js'), 'export {};\n'), ['worker bundle differs from manifest']],
  ['modified assets', (f) => writeFileSync(path.join(f.artifactDir, 'assets', 'index.txt'), 'changed\n'), ['assets differ from manifest']],
  ['a missing worker directory', (f) => rmSync(path.join(f.artifactDir, 'worker'), { recursive: true }), ['artifact worker/ directory is missing']],
  ['a missing assets directory', (f) => rmSync(path.join(f.artifactDir, 'assets'), { recursive: true }), ['artifact assets/ directory is missing']],
  ['no release-check receipt', (f) => rmSync(f.file('receipt.json')), ['no passing release-check receipt; run npm run check:cloudflare']],
  ['an unreadable receipt', (f) => writeFileSync(f.file('receipt.json'), 'nope'), ['release-check receipt is not valid JSON']],
  ['a failed release check', (f) => f.json('receipt.json', (r) => { r.status = 'failed'; }), ['release-check receipt is not passing']],
  ['a partial release check (--only)', (f) => f.json('receipt.json', (r) => { r.status = 'partial'; }), ['release-check receipt is not passing']],
  ['a receipt for another artifact', (f) => f.json('receipt.json', (r) => { r.artifact.workerSha256 = '0'.repeat(64); }), ['receipt belongs to another artifact']],
  ['a receipt for another commit', (f) => f.json('receipt.json', (r) => { r.source.commit = 'e'.repeat(40); }), ['receipt belongs to another commit']],
]) {
  test(`verifyArtifact refuses ${label}`, (t) => {
    const fixture = artifactFixture(t);
    change(fixture);
    assert.deepEqual(fixture.check().problems, expected);
  });
}

test('the dry-run exemption waives only the checkout, dirty-tree and receipt problems', (t) => {
  const fixture = artifactFixture(t);
  fixture.git = { ...fixture.git, dirty: true };
  fixture.json('manifest.json', (m) => { m.source.dirty = true; });
  rmSync(fixture.file('receipt.json'));
  const { problems } = fixture.check({ allowDirtyCheckout: true });
  assert.deepEqual(problems, ['artifact was built from a dirty tree', 'no passing release-check receipt; run npm run check:cloudflare']);
  assert.equal(waivedForDryRun(problems), true);
  for (const problem of [
    'artifact was built from a different commit',
    'worker bundle differs from manifest',
    'installation var APP_BASE_URL is empty',
    ...bootstrapProblems({ WORKSPACE_BOOTSTRAP: 'open' }),
  ]) assert.equal(waivedForDryRun([...problems, problem]), false, problem);
});

// ---------- installation config and the bootstrap guard ----------

function installationConfig(bootstrap, overrides = {}) {
  const receipt = newReceipt({
    install: 'acme',
    environment: 'production',
    accountId: 'a'.repeat(32),
    names: deriveNames('acme', 'production'),
    workspaceId: generateWorkspaceId(),
    jurisdiction: 'eu',
    provider: 'gemini',
    origin: 'https://interviews.example.org',
    bootstrap: 'open',
  });
  const config = buildInstallationConfig(template, receipt, { bootstrap });
  config.vars = { ...config.vars, ...overrides };
  return config;
}

test('WORKSPACE_BOOTSTRAP is accepted only empty, or open|recovery with --bootstrap', () => {
  assert.deepEqual(bootstrapProblems({ WORKSPACE_BOOTSTRAP: '' }), []);
  assert.deepEqual(bootstrapProblems({ WORKSPACE_BOOTSTRAP: '' }, { bootstrap: true }), []);
  for (const value of ['open', 'recovery']) {
    assert.match(bootstrapProblems({ WORKSPACE_BOOTSTRAP: value }).join('\n'), new RegExp(`WORKSPACE_BOOTSTRAP is "${value}": only the installer's bootstrap deploys \\(--bootstrap\\)`));
    assert.deepEqual(bootstrapProblems({ WORKSPACE_BOOTSTRAP: value }, { bootstrap: true }), []);
  }
  for (const value of ['OPEN', 'yes', ' open']) {
    assert.match(bootstrapProblems({ WORKSPACE_BOOTSTRAP: value }, { bootstrap: true }).join('\n'), /must be empty/, value);
  }
  // APP_BASE_URL may be empty only while bootstrapping.
  assert.deepEqual(missingInstallationVars({ WORKSPACE_ID: 'ws_x', AI_PROVIDER: 'gemini', WORKSPACE_BOOTSTRAP: 'open' }), []);
  assert.deepEqual(missingInstallationVars({ WORKSPACE_ID: 'ws_x', AI_PROVIDER: 'gemini', WORKSPACE_BOOTSTRAP: '' }), ['APP_BASE_URL']);
});

test('installationConfigProblems combines template drift, required vars and the bootstrap guard', () => {
  assert.deepEqual(installationConfigProblems(template, installationConfig('')), []);
  assert.deepEqual(installationConfigProblems(template, installationConfig('open'), { bootstrap: true }), []);
  assert.equal(installationConfigProblems(template, installationConfig('open')).length, 1);
  const drifted = { ...installationConfig(''), compatibility_date: '2000-01-01' };
  assert.deepEqual(installationConfigProblems(template, drifted), ['installation config drifts from wrangler.jsonc in: compatibility_date']);
  assert.deepEqual(installationConfigProblems(template, installationConfig('', { APP_BASE_URL: '' })), ['installation var APP_BASE_URL is empty']);
});

const GATEWAY_VARS = { AI_TRANSPORT: 'cloudflare-gateway', CF_AI_GATEWAY_ACCOUNT_ID: 'a'.repeat(32), CF_AI_GATEWAY_ID: 'oi-acme' };

// RT-11: the rules of src/lib/providers/endpoint.ts providerRouteErrors, both directions.
const TRANSPORT_REFUSALS = [
  ['gateway identifiers on direct', { CF_AI_GATEWAY_ACCOUNT_ID: 'a'.repeat(32), CF_AI_GATEWAY_ID: 'oi-acme' }, /CF_AI_GATEWAY_ACCOUNT_ID and CF_AI_GATEWAY_ID must be empty with AI_TRANSPORT direct/],
  ['a gateway id alone on direct', { CF_AI_GATEWAY_ID: 'oi-acme' }, /must be empty with AI_TRANSPORT direct/],
  ['gateway identifiers with an empty AI_TRANSPORT (direct)', { AI_TRANSPORT: '', CF_AI_GATEWAY_ACCOUNT_ID: 'a'.repeat(32) }, /must be empty with AI_TRANSPORT direct/],
  ['the gateway without identifiers', { AI_TRANSPORT: 'cloudflare-gateway' }, /installation var CF_AI_GATEWAY_ACCOUNT_ID is empty[\s\S]*installation var CF_AI_GATEWAY_ID is empty/],
  ['the gateway without a gateway id', { ...GATEWAY_VARS, CF_AI_GATEWAY_ID: '' }, /installation var CF_AI_GATEWAY_ID is empty/],
  ['the gateway with a padded transport and no identifiers', { AI_TRANSPORT: ' cloudflare-gateway ' }, /installation var CF_AI_GATEWAY_ID is empty/],
  ['the default gateway', { ...GATEWAY_VARS, CF_AI_GATEWAY_ID: 'default' }, /CF_AI_GATEWAY_ID is not a gateway id other than default/],
  ['a malformed gateway id', { ...GATEWAY_VARS, CF_AI_GATEWAY_ID: 'Oi_Acme' }, /CF_AI_GATEWAY_ID is not a gateway id other than default/],
  ['an uppercase account id', { ...GATEWAY_VARS, CF_AI_GATEWAY_ACCOUNT_ID: 'A'.repeat(32) }, /CF_AI_GATEWAY_ACCOUNT_ID is not a 32-character lowercase hexadecimal account ID/],
  ['a padded account id (used unmodified)', { ...GATEWAY_VARS, CF_AI_GATEWAY_ACCOUNT_ID: ` ${'a'.repeat(32)}` }, /CF_AI_GATEWAY_ACCOUNT_ID is not a 32-character/],
  ['the Vercel gateway transport', { AI_TRANSPORT: 'gateway' }, /installation var AI_TRANSPORT is "gateway"; it must be direct or cloudflare-gateway/],
];

test('installationConfigProblems refuses AI transport vars the Worker would refuse, and accepts both valid transports', () => {
  assert.deepEqual(installationConfigProblems(template, installationConfig('')), []);
  assert.deepEqual(installationConfigProblems(template, installationConfig('', GATEWAY_VARS)), []);
  assert.deepEqual(transportVarProblems({ AI_TRANSPORT: 'direct', CF_AI_GATEWAY_ACCOUNT_ID: '', CF_AI_GATEWAY_ID: '' }), []);
  assert.deepEqual(transportVarProblems({}), [], 'unset is direct, as in the Worker');
  for (const [label, overrides, pattern] of TRANSPORT_REFUSALS) {
    assert.match(installationConfigProblems(template, installationConfig('', overrides)).join('\n'), pattern, label);
  }
});

test('deploy.mjs --check-config and a full deploy refuse a transport mismatch before upload', async (t) => {
  const fixture = artifactFixture(t);
  const gateway = await runDeploy(['--install', writeConfig(fixture.root, 'gateway.jsonc', installationConfig('', GATEWAY_VARS)), '--check-config']);
  assert.equal(gateway.code, 0, gateway.stderr);
  for (const [label, overrides, pattern] of TRANSPORT_REFUSALS) {
    const file = writeConfig(fixture.root, 'mismatch.jsonc', installationConfig('', overrides));
    const checked = await runDeploy(['--install', file, '--check-config']);
    assert.equal(checked.code, 1, label);
    assert.match(checked.stderr, pattern, label);
    assert.match(checked.stderr, /deploy preconditions failed; nothing was uploaded/, label);
  }
  const [, overrides, pattern] = TRANSPORT_REFUSALS[0];
  const full = await runDeploy(['--install', writeConfig(fixture.root, 'mismatch.jsonc', installationConfig('', overrides)), '--artifact', fixture.artifactDir, '--confirm']);
  assert.equal(full.code, 1);
  assert.match(full.stderr, pattern);
  assert.doesNotMatch(full.stdout, /Deploying|Validating/);
});

test('deploy arguments are strict; --dry-run is the default without --confirm', () => {
  assert.throws(() => parseDeployArgs([]), /--install/);
  assert.throws(() => parseDeployArgs(['--install', 'x.jsonc', '--skip-checks']), /Unknown option '--skip-checks'/);
  assert.throws(() => parseDeployArgs(['--install', 'x.jsonc', 'extra']), /positional/i);
  assert.equal(parseDeployArgs(['--install', 'x.jsonc']).dryRun, true);
  assert.equal(parseDeployArgs(['--install', 'x.jsonc', '--confirm']).dryRun, false);
  assert.equal(parseDeployArgs(['--install', 'x.jsonc', '--confirm', '--dry-run']).dryRun, true);
  assert.equal(parseDeployArgs(['--install', 'x.jsonc', '--confirm']).bootstrap, false);
  assert.equal(parseDeployArgs(['--install', 'x.jsonc', '--confirm', '--bootstrap']).bootstrap, true);
  assert.equal(parseDeployArgs(['--install', 'x.jsonc', '--artifact', '/tmp/a']).artifactDir, path.resolve('/tmp/a'));
});

function runDeploy(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DEPLOY, ...args], { cwd: ROOT, env: { PATH: process.env.PATH, HOME: os.tmpdir() }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function writeConfig(dir, name, config) {
  const file = path.join(dir, name);
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}

test('deploy.mjs --check-config refuses a bootstrap config unless --bootstrap is given', async (t) => {
  const dir = tempDir(t, 'oi-deploy-config-');
  const cleared = writeConfig(dir, 'cleared.jsonc', installationConfig(''));
  const bootstrap = writeConfig(dir, 'bootstrap.jsonc', installationConfig('open'));

  const ok = await runDeploy(['--install', cleared, '--check-config']);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /passes the deploy preconditions/);

  const refused = await runDeploy(['--install', bootstrap, '--check-config']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /✗ installation var WORKSPACE_BOOTSTRAP is "open": only the installer's bootstrap deploys \(--bootstrap\)/);
  assert.match(refused.stderr, /deploy preconditions failed; nothing was uploaded/);

  const installer = await runDeploy(['--install', bootstrap, '--check-config', '--bootstrap']);
  assert.equal(installer.code, 0, installer.stderr);

  const incomplete = await runDeploy(['--install', writeConfig(dir, 'no-origin.jsonc', installationConfig('', { APP_BASE_URL: '' })), '--check-config']);
  assert.equal(incomplete.code, 1);
  assert.match(incomplete.stderr, /installation var APP_BASE_URL is empty/);

  // An unset repository variable writes an empty file.
  writeFileSync(path.join(dir, 'empty.jsonc'), '');
  const empty = await runDeploy(['--install', path.join(dir, 'empty.jsonc'), '--check-config']);
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /installation config .*empty\.jsonc is not readable JSONC/);

  const unknown = await runDeploy(['--install', cleared, '--check-config', '--force']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /Unknown option '--force'/);
});

test('a full deploy lists the bootstrap refusal with the artifact problems and uploads nothing', async (t) => {
  const fixture = artifactFixture(t);
  const bootstrap = writeConfig(fixture.root, 'bootstrap.jsonc', installationConfig('recovery'));
  const derivedFile = path.join(ROOT, 'dist', 'cloudflare', 'deploy', 'oi-acme.deploy.json');
  const before = existsSync(derivedFile) ? readFileSync(derivedFile, 'utf8') : null;
  const result = await runDeploy(['--install', bootstrap, '--artifact', fixture.artifactDir, '--confirm']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /✗ installation var WORKSPACE_BOOTSTRAP is "recovery": only the installer's bootstrap deploys/);
  // The fixture's commit is not this checkout's, so this never reaches wrangler.
  assert.match(result.stderr, /✗ artifact was built from a different commit/);
  assert.match(result.stderr, /deploy preconditions failed; nothing was uploaded/);
  assert.doesNotMatch(result.stdout, /Deploying|Validating/);
  assert.equal(existsSync(derivedFile) ? readFileSync(derivedFile, 'utf8') : null, before, 'no derived deploy config was written');
});
