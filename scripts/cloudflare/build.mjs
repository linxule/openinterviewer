#!/usr/bin/env node
// build:cloudflare (RT-04). Builds the one deployable Worker artifact and a
// non-secret release manifest. Never provisions, never deploys, never reads
// credentials. The artifact directory is what tests and deploy both consume:
//
//   dist/cloudflare/artifact/worker/   wrangler --dry-run bundle (main + modules)
//   dist/cloudflare/artifact/assets/   static assets
//   dist/cloudflare/artifact/manifest.json
//
// Usage: node scripts/cloudflare/build.mjs [--config wrangler.jsonc] [--skip-next-build]

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  ROOT,
  binPath,
  fail,
  gitState,
  installedVersion,
  minimalEnv,
  readJsonc,
  run,
  secretBearingLocalFiles,
  sha256File,
  sha256Tree,
  treeBytes,
} from './lib.mjs';

const args = process.argv.slice(2);
const configArg = args.includes('--config') ? args[args.indexOf('--config') + 1] : 'wrangler.jsonc';
const skipNextBuild = args.includes('--skip-next-build');
const configPath = path.resolve(ROOT, configArg);
const artifactDir = path.join(ROOT, 'dist', 'cloudflare', 'artifact');

const secretFiles = secretBearingLocalFiles();
if (secretFiles.length > 0) {
  fail(
    `refusing to build: ${secretFiles.join(', ')} present in the project root. OpenNext inlines .env* values into the `
      + 'Worker bundle at build time. Move them out of this checkout (or build from a clean checkout).',
  );
}
if (!existsSync(configPath)) fail(`wrangler config not found: ${configArg}`);

const config = readJsonc(configPath);
const buildEnv = minimalEnv({
  // Prerendered researcher shells call isHostedMode() at build time.
  DEPLOYMENT_TARGET: 'cloudflare',
  DEPLOYMENT_MODE: 'standalone',
  AI_TRANSPORT: 'direct',
});

console.log('• OpenNext build');
const openNextArgs = ['build', '--config', configPath];
if (skipNextBuild) openNextArgs.push('--skipNextBuild');
await run(binPath('opennextjs-cloudflare'), openNextArgs, { env: buildEnv });

const nextEnvFile = path.join(ROOT, '.open-next', 'cloudflare', 'next-env.mjs');
const nextEnv = readFileSync(nextEnvFile, 'utf8');
if (!/^export const production = \{\};\s*export const development = \{\};\s*export const test = \{\};\s*$/.test(nextEnv)) {
  fail('.open-next/cloudflare/next-env.mjs is not empty: build-time environment values would ship in the Worker.');
}

console.log('• Bundling Worker (wrangler --dry-run, no upload)');
rmSync(artifactDir, { recursive: true, force: true });
mkdirSync(artifactDir, { recursive: true });
const workerDir = path.join(artifactDir, 'worker');
await run(binPath('wrangler'), ['deploy', '--dry-run', '--config', configPath, '--outdir', workerDir], {
  env: minimalEnv({ OPEN_NEXT_DEPLOY: 'true' }),
});
const assetsSource = path.resolve(path.dirname(configPath), config.assets.directory);
const assetsDir = path.join(artifactDir, 'assets');
cpSync(assetsSource, assetsDir, { recursive: true });

const mainName = `${path.parse(config.main).name}.js`;
if (!existsSync(path.join(workerDir, mainName))) fail(`bundle entry ${mainName} missing from ${workerDir}`);

const schemaModule = await import(path.join(ROOT, 'cloudflare', 'workspace', 'schema.ts'));
const git = gitState();
const worker = sha256Tree(workerDir);
const assets = sha256Tree(assetsDir);
const manifest = {
  formatVersion: 1,
  builtAt: new Date().toISOString(),
  source: { commit: git.commit, dirty: git.dirty },
  lockfileSha256: sha256File(path.join(ROOT, 'package-lock.json')),
  templateConfigSha256: sha256File(configPath),
  artifact: {
    main: mainName,
    workerSha256: worker.sha256,
    workerFiles: worker.files,
    workerBytes: treeBytes(workerDir),
    assetsSha256: assets.sha256,
    assetsFiles: assets.files,
    assetsBytes: treeBytes(assetsDir),
  },
  schema: {
    current: schemaModule.CURRENT_SCHEMA_VERSION,
    minReadable: schemaModule.MIN_READABLE_SCHEMA_VERSION,
  },
  runtime: {
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
  },
  toolchain: {
    node: process.versions.node,
    next: installedVersion('next'),
    opennext: installedVersion('@opennextjs/cloudflare'),
    wrangler: installedVersion('wrangler'),
    workerd: installedVersion('workerd'),
  },
  testReceipt: null,
};
writeFileSync(path.join(artifactDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
// The upload is the modules (wrangler's Total Upload, the size the 64 MiB limit
// counts); the source map and wrangler's README stay local.
const modules = { files: 0, bytes: 0 };
let sourceMapBytes = 0;
for (const entry of readdirSync(workerDir, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const bytes = statSync(path.join(entry.parentPath, entry.name)).size;
  if (entry.name.endsWith('.map')) sourceMapBytes += bytes;
  else if (entry.name !== 'README.md') {
    modules.files += 1;
    modules.bytes += bytes;
  }
}
const mib = (bytes) => `${(bytes / 1048576).toFixed(2)} MiB`;
console.log(
  `• Artifact ready: ${path.relative(ROOT, artifactDir)} (worker modules ${mib(modules.bytes)} in ${modules.files} files, `
    + `source map ${mib(sourceMapBytes)} not uploaded; source ${git.commit.slice(0, 12)}${git.dirty ? ' dirty' : ''})`,
);
