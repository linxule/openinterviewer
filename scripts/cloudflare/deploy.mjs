#!/usr/bin/env node
// deploy:cloudflare (RT-04, SETUP-05). Uploads a previously built and checked
// artifact for one installation. It never rebuilds source, never provisions
// resources and never reads or prints secrets.
//
// Preconditions (all enforced):
//  - dist/cloudflare/artifact/manifest.json exists and matches the current
//    clean checkout (commit, lockfile, template config) and the bundle on disk;
//  - dist/cloudflare/artifact/receipt.json records a passing local release
//    check (npm run check:cloudflare) for this exact artifact;
//  - the installation config differs from wrangler.jsonc only in
//    installation-owned fields (names, vars values, routes);
//  - --confirm is given (otherwise --dry-run semantics apply).
//
// Usage:
//   node scripts/cloudflare/deploy.mjs --install <installation wrangler.jsonc> [--dry-run | --confirm]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  ROOT,
  binPath,
  fail,
  gitState,
  minimalEnv,
  readJsonc,
  run,
  sha256File,
  sha256Tree,
} from './lib.mjs';

const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const installPath = option('--install');
const artifactDir = path.resolve(ROOT, option('--artifact') ?? 'dist/cloudflare/artifact');
const confirm = args.includes('--confirm');
const dryRun = args.includes('--dry-run') || !confirm;
const allowDirtyForDryRun = args.includes('--allow-dirty-dry-run');

if (!installPath) fail('--install <installation wrangler config> is required');

// Fields an installation may set; everything else must equal the template.
const INSTALLATION_OWNED = new Set(['name', 'vars', 'routes', 'workers_dev', 'account_id', 'queues']);
const QUEUE_NAME_FIELDS = new Set(['queue', 'dead_letter_queue']);

export function configDrift(template, install) {
  const diffs = [];
  const keys = new Set([...Object.keys(template), ...Object.keys(install)]);
  for (const key of keys) {
    if (key === '$schema') continue;
    if (INSTALLATION_OWNED.has(key)) continue;
    if (JSON.stringify(template[key]) !== JSON.stringify(install[key])) diffs.push(key);
  }
  const stripNames = (queues) => JSON.stringify(queues, (k, v) => (QUEUE_NAME_FIELDS.has(k) ? '<name>' : v));
  if (stripNames(template.queues) !== stripNames(install.queues)) diffs.push('queues (settings other than names)');
  const templateVars = Object.keys(template.vars ?? {}).sort().join(',');
  const installVars = Object.keys(install.vars ?? {}).sort().join(',');
  if (templateVars !== installVars) diffs.push('vars (names)');
  return diffs;
}

function verifyArtifact() {
  const manifestPath = path.join(artifactDir, 'manifest.json');
  const receiptPath = path.join(artifactDir, 'receipt.json');
  if (!existsSync(manifestPath)) fail('no artifact manifest; run npm run build:cloudflare');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const problems = [];
  const git = gitState();
  if (manifest.source.commit !== git.commit) problems.push('artifact was built from a different commit');
  if (manifest.source.dirty) problems.push('artifact was built from a dirty tree');
  if (git.dirty && !(dryRun && allowDirtyForDryRun)) problems.push('checkout has uncommitted tracked changes');
  if (manifest.lockfileSha256 !== sha256File(path.join(ROOT, 'package-lock.json'))) problems.push('package-lock.json changed since build');
  if (manifest.templateConfigSha256 !== sha256File(path.join(ROOT, 'wrangler.jsonc'))) problems.push('wrangler.jsonc changed since build');
  const worker = sha256Tree(path.join(artifactDir, 'worker'));
  const assets = sha256Tree(path.join(artifactDir, 'assets'));
  if (worker.sha256 !== manifest.artifact.workerSha256) problems.push('worker bundle differs from manifest');
  if (assets.sha256 !== manifest.artifact.assetsSha256) problems.push('assets differ from manifest');
  if (!existsSync(receiptPath)) {
    problems.push('no passing release-check receipt; run npm run check:cloudflare');
  } else {
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    if (receipt.status !== 'passed') problems.push('release-check receipt is not passing');
    if (receipt.artifact?.workerSha256 !== manifest.artifact.workerSha256) problems.push('receipt belongs to another artifact');
    if (receipt.source?.commit !== manifest.source.commit) problems.push('receipt belongs to another commit');
  }
  return { manifest, problems };
}

const template = readJsonc(path.join(ROOT, 'wrangler.jsonc'));
const install = readJsonc(path.resolve(ROOT, installPath));
const drift = configDrift(template, install);
const { manifest, problems } = verifyArtifact();
if (drift.length > 0) problems.push(`installation config drifts from wrangler.jsonc in: ${drift.join(', ')}`);
for (const required of ['APP_BASE_URL', 'WORKSPACE_ID', 'AI_PROVIDER']) {
  if (!install.vars?.[required]) problems.push(`installation var ${required} is empty`);
}
if (problems.length > 0 && !(dryRun && allowDirtyForDryRun && problems.every((p) => /dirty|receipt/.test(p)))) {
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  fail('deploy preconditions failed; nothing was uploaded');
}

// Deploy exactly the prebuilt bundle (same derivation as createTestHarness's
// prebuiltWorkerDir): no bundling, additional modules found in the bundle dir.
const deployDir = path.join(ROOT, 'dist', 'cloudflare', 'deploy');
mkdirSync(deployDir, { recursive: true });
const derived = {
  ...install,
  main: path.join(artifactDir, 'worker', manifest.artifact.main),
  base_dir: path.join(artifactDir, 'worker'),
  no_bundle: true,
  find_additional_modules: true,
  rules: [{ type: 'CompiledWasm', globs: ['**/*.wasm'], fallthrough: true }],
  assets: { ...install.assets, directory: path.join(artifactDir, 'assets') },
};
delete derived.$schema;
const derivedPath = path.join(deployDir, `${install.name}.deploy.json`);
writeFileSync(derivedPath, `${JSON.stringify(derived, null, 2)}\n`);

const wranglerArgs = [
  'deploy',
  '--config', derivedPath,
  // Deploy never provisions: resources are created by setup:cloudflare apply.
  '--experimental-provision=false',
  '--experimental-auto-create=false',
  '--strict',
  '--message', `openinterviewer ${manifest.source.commit.slice(0, 12)}`,
];
if (dryRun) wranglerArgs.push('--dry-run');

console.log(`• ${dryRun ? 'Validating (dry run)' : 'Deploying'} ${install.name} from artifact ${manifest.artifact.workerSha256.slice(0, 12)}`);
const env = minimalEnv({ OPEN_NEXT_DEPLOY: 'true' });
for (const name of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) {
  if (!dryRun && process.env[name]) env[name] = process.env[name];
}
await run(binPath('wrangler'), wranglerArgs, { env });
console.log(dryRun ? '• Dry run complete; nothing was uploaded.' : '• Deploy complete. Run setup:cloudflare verify next.');
