// Release-gate helpers in scripts/cloudflare: what counts as a clean
// checkout, checkouts whose path needs URL encoding, and build options.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { openNextBuildArgs, parseBuildArgs } from '../../scripts/cloudflare/build.mjs';
import { ROOT, gitState } from '../../scripts/cloudflare/lib.mjs';
import { gitState as installerGitState } from '../../scripts/cloudflare/installer/tools.mjs';

function tempDir(t, prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** A committed repository with a .gitignore like the project's; the user's git config is not consulted. */
function tempRepo(t) {
  const dir = tempDir(t, 'oi-git-');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1' },
    encoding: 'utf8',
  });
  git('init', '-q');
  write(path.join(dir, '.gitignore'), 'dist\n.next\n.open-next\n');
  write(path.join(dir, 'src', 'app', 'page.tsx'), 'export default function Page() { return null; }\n');
  git('add', '.');
  git('commit', '-q', '-m', 'fixture');
  return { dir, git, head: git('rev-parse', 'HEAD').trim() };
}

const both = async (dir) => [gitState(dir), await installerGitState('git', dir)];

test('a clean checkout, or one with only ignored files, is clean for build, check, deploy and the installer', async (t) => {
  const repo = tempRepo(t);
  for (const state of await both(repo.dir)) assert.deepEqual(state, { commit: repo.head, dirty: false });
  write(path.join(repo.dir, 'dist', 'cloudflare', 'artifact', 'manifest.json'), '{}\n');
  write(path.join(repo.dir, '.next', 'BUILD_ID'), 'x\n');
  for (const state of await both(repo.dir)) assert.deepEqual(state, { commit: repo.head, dirty: false });
});

test('an untracked, non-ignored file makes the checkout dirty (it would ship in the artifact)', async (t) => {
  const repo = tempRepo(t);
  write(path.join(repo.dir, 'src', 'app', 'api', 'debug', 'route.ts'), 'export const GET = () => new Response("debug");\n');
  for (const state of await both(repo.dir)) assert.deepEqual(state, { commit: repo.head, dirty: true });
});

test('status.showUntrackedFiles=no in the repository config cannot hide untracked files', async (t) => {
  const repo = tempRepo(t);
  repo.git('config', 'status.showUntrackedFiles', 'no');
  write(path.join(repo.dir, 'public', 'draft.txt'), 'draft\n');
  for (const state of await both(repo.dir)) assert.equal(state.dirty, true);
});

test('a modified tracked file makes the checkout dirty', async (t) => {
  const repo = tempRepo(t);
  write(path.join(repo.dir, 'src', 'app', 'page.tsx'), 'export default function Page() { return "changed"; }\n');
  for (const state of await both(repo.dir)) assert.equal(state.dirty, true);
});

// A checkout path whose file URL is percent-encoded (space and '#').
function boundaryCheckout(t, consumerSource) {
  const base = tempDir(t, 'oi-boundary-');
  const repo = path.join(base, 'dir with space #1', 'repo');
  for (const name of ['lib.mjs', 'check-import-boundary.mjs']) {
    mkdirSync(path.join(repo, 'scripts', 'cloudflare'), { recursive: true });
    copyFileSync(path.join(ROOT, 'scripts', 'cloudflare', name), path.join(repo, 'scripts', 'cloudflare', name));
  }
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(repo, 'node_modules'), 'dir');
  write(path.join(repo, 'cloudflare', 'tsconfig.json'), '{ "compilerOptions": { "paths": { "@/*": ["../src/*"] } } }\n');
  write(path.join(repo, 'cloudflare', 'analysis', 'consumer.ts'), consumerSource);
  write(path.join(repo, 'cloudflare', 'workspace', 'WorkspaceStore.ts'), 'export class WorkspaceStore {}\n');
  write(path.join(repo, 'src', 'lib', 'kvClient.ts'), 'export const redisClient = () => "redis";\n');
  return repo;
}

const runBoundary = (repo) => spawnSync(process.execPath, [path.join(repo, 'scripts', 'cloudflare', 'check-import-boundary.mjs')], { cwd: repo, encoding: 'utf8' });

test('lib.mjs ROOT is the real checkout directory when its path needs URL encoding', async (t) => {
  const repo = boundaryCheckout(t, 'export const consume = () => 1;\n');
  const lib = await import(pathToFileURL(path.join(repo, 'scripts', 'cloudflare', 'lib.mjs')).href);
  assert.equal(lib.ROOT, realpathSync(repo));
  assert.ok(existsSync(path.join(lib.ROOT, 'cloudflare', 'tsconfig.json')));
});

test('the import-boundary lane checks the graph from a checkout path that needs URL encoding', (t) => {
  const clean = runBoundary(boundaryCheckout(t, 'export const consume = () => 1;\n'));
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /✓ Worker-only graph .* reaches no Next, Redis or hosted modules/);

  const violating = runBoundary(boundaryCheckout(t, 'import { redisClient } from "../../src/lib/kvClient";\nexport const consume = () => redisClient();\n'));
  assert.equal(violating.status, 1, `the violation must fail the lane (stdout: ${violating.stdout})`);
  assert.match(violating.stderr, /✗ cloudflare\/analysis\/consumer\.ts reaches .*src\/lib\/kvClient\.ts \(Redis client factory\)/);
});

test('build:cloudflare always runs the Next build and refuses unknown options such as --skip-next-build', () => {
  assert.throws(() => parseBuildArgs(['--skip-next-build']), /Unknown option '--skip-next-build'/);
  assert.throws(() => parseBuildArgs(['stray']), /positional/i);
  assert.deepEqual(parseBuildArgs([]), { configArg: 'wrangler.jsonc' });
  assert.deepEqual(parseBuildArgs(['--config', 'other.jsonc']), { configArg: 'other.jsonc' });
  assert.deepEqual(openNextBuildArgs('/checkout/wrangler.jsonc'), ['build', '--config', '/checkout/wrangler.jsonc']);
});
