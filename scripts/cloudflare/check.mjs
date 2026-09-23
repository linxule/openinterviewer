#!/usr/bin/env node
// check:cloudflare (VERIFY-02). The combined local release check for one
// built artifact. Runs the full supported matrix — existing Node lanes and the
// Cloudflare lanes — against the current clean commit and the artifact in
// dist/cloudflare/artifact, then writes dist/cloudflare/artifact/receipt.json.
// deploy:cloudflare refuses to upload an artifact without a passing receipt
// for the same commit and bundle.
//
// Usage: node scripts/cloudflare/check.mjs [--skip-build] [--only <lane,...>] [--list]
// Lanes that need a local redis-server (or Docker) and Playwright browsers are
// included; a failing prerequisite fails the check rather than being skipped.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, fail, gitState, run, sha256Tree } from './lib.mjs';

const args = process.argv.slice(2);
const skipBuild = args.includes('--skip-build');
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;

const NODE_BUILD_FIXTURES = {
  'build:node-standalone': { DEPLOYMENT_MODE: 'standalone', AI_TRANSPORT: 'direct' },
  'build:node-gateway': {
    VERCEL: '1', DEPLOYMENT_MODE: 'standalone', AI_TRANSPORT: 'gateway', AI_PROVIDER: 'gemini',
    APP_BASE_URL: 'https://gateway-build.example.org', ADMIN_PASSWORD: 'gateway-build-admin-password',
    SESSION_SECRET: 'gateway-build-session-secret-1234567890',
    PARTICIPANT_TOKEN_SECRET: 'gateway-build-participant-secret-1234567890',
    RATE_LIMIT_SALT: 'gateway-build-rate-limit-salt-1234567890',
    KV_REST_API_URL: 'https://build-test.upstash.io', KV_REST_API_TOKEN: 'gateway-build-redis-token',
  },
  'build:node-hosted': {
    DEPLOYMENT_MODE: 'hosted', AI_TRANSPORT: 'direct', APP_BASE_URL: 'https://hosted-build.example.org',
    SESSION_SECRET: 'hosted-build-session-secret-1234567890',
    PARTICIPANT_TOKEN_SECRET: 'hosted-build-participant-secret-1234567890',
    RATE_LIMIT_SALT: 'hosted-build-rate-limit-salt-1234567890',
    PLATFORM_KV_REST_API_URL: 'https://build-test.upstash.io', PLATFORM_KV_REST_API_TOKEN: 'hosted-build-platform-token',
    PLATFORM_KEY_PREFIX: 'build-test', PLATFORM_SCHEMA_LINEAGE: 'v2-clean',
    CREDENTIAL_ENCRYPTION_KEYS: '{"build-test":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}',
    CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: 'build-test',
    GOOGLE_CLIENT_ID: 'hosted-build-google-client', GOOGLE_CLIENT_SECRET: 'hosted-build-google-secret',
  },
};

// Order matters only for speed of feedback; every lane must pass.
const LANES = [
  { name: 'sync-artifacts+lint+typecheck+unit', cmd: ['npm', 'run', 'check'] },
  { name: 'setup-checker', cmd: ['npm', 'run', 'test:setup'] },
  { name: 'installer', cmd: ['npm', 'run', 'test:setup:cloudflare'] },
  { name: 'audit-production', cmd: ['npm', 'audit', '--omit=dev', '--audit-level=high'] },
  { name: 'diff-check', cmd: ['git', 'diff', '--check'] },
  { name: 'workers-runtime', cmd: ['npm', 'run', 'test:cloudflare'] },
  { name: 'worker-import-boundary', cmd: ['node', 'scripts/cloudflare/check-import-boundary.mjs'] },
  { name: 'redis-contract', cmd: ['npm', 'run', 'test:contract:redis'] },
  { name: 'redis-crash', cmd: ['npm', 'run', 'test:redis-crash'], env: { REDIS_URL: '' } },
  { name: 'adversarial', cmd: ['npm', 'run', 'test:adversarial'], env: { REDIS_URL: '' } },
  ...Object.entries(NODE_BUILD_FIXTURES).map(([name, env]) => ({ name, cmd: ['npm', 'run', 'build'], env })),
  { name: 'node-browser', cmd: ['npm', 'run', 'test:e2e'] },
  { name: 'cloudflare-artifact', cmd: ['npm', 'run', 'test:cloudflare:artifact'], needsArtifact: true },
  { name: 'cloudflare-restart', cmd: ['npm', 'run', 'test:cloudflare:restart'], needsArtifact: true },
  { name: 'cloudflare-browser', cmd: ['npm', 'run', 'test:e2e:cloudflare'], needsArtifact: true },
];

if (args.includes('--list')) {
  for (const lane of LANES) console.log(`${lane.name}: ${lane.cmd.join(' ')}`);
  process.exit(0);
}

const git = gitState();
if (git.dirty) fail('check:cloudflare requires a clean checkout (commit or stash tracked changes first)');

if (!skipBuild) {
  console.log('• Building the artifact');
  await run('node', ['scripts/cloudflare/build.mjs']);
}
const artifactDir = path.join(ROOT, 'dist', 'cloudflare', 'artifact');
const manifestPath = path.join(artifactDir, 'manifest.json');
if (!existsSync(manifestPath)) fail('no artifact; run npm run build:cloudflare');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (manifest.source.commit !== git.commit || manifest.source.dirty) {
  fail('artifact was not built from the current clean commit; rebuild without --skip-build');
}
const worker = sha256Tree(path.join(artifactDir, 'worker'));
if (worker.sha256 !== manifest.artifact.workerSha256) fail('artifact bundle differs from its manifest');

const results = [];
let failed = false;
for (const lane of LANES) {
  if (only && !only.has(lane.name)) continue;
  const started = Date.now();
  console.log(`\n• ${lane.name}: ${lane.cmd.join(' ')}`);
  try {
    // Lanes inherit the environment deliberately: Playwright/Redis need PATH,
    // HOME and CI flags. They never need credentials; build lanes add only
    // their synthetic fixture values.
    await run(lane.cmd[0], lane.cmd.slice(1), { env: { ...process.env, ...(lane.env ?? {}) } });
    results.push({ lane: lane.name, command: lane.cmd.join(' '), exitCode: 0, durationMs: Date.now() - started });
  } catch (error) {
    failed = true;
    results.push({ lane: lane.name, command: lane.cmd.join(' '), exitCode: error.code ?? 1, durationMs: Date.now() - started });
    console.error(`✗ ${lane.name} failed`);
  }
}

const after = gitState();
if (after.commit !== git.commit || after.dirty) {
  failed = true;
  console.error('✗ the checkout changed while checks ran');
}

const receipt = {
  formatVersion: 1,
  status: failed || only ? (failed ? 'failed' : 'partial') : 'passed',
  checkedAt: new Date().toISOString(),
  source: { commit: git.commit },
  artifact: { workerSha256: manifest.artifact.workerSha256, assetsSha256: manifest.artifact.assetsSha256 },
  lanes: results,
};
writeFileSync(path.join(artifactDir, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`\n${receipt.status === 'passed' ? '✓' : '✗'} release check ${receipt.status}: ${results.filter((r) => r.exitCode === 0).length}/${results.length} lanes passed`);
process.exit(receipt.status === 'passed' ? 0 : 1);
