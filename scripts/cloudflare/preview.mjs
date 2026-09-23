#!/usr/bin/env node
// preview:cloudflare (RT-04). Runs the prebuilt production artifact from
// dist/cloudflare/artifact in local workerd, through the same harness as the
// Cloudflare browser lane: real OpenNext handlers, WorkspaceStore SQLite,
// alarms and a local Queue consumer. It needs no credentials and makes no
// provider or Cloudflare request: provider calls get synthetic OpenAI
// responses, every other outbound request is refused, and storage is
// discarded on exit. It never builds, provisions or deploys.
//
// Usage: npm run preview:cloudflare [-- --port <port>]

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, fail, gitState } from './lib.mjs';

const args = process.argv.slice(2);
const port = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : 8787;
if (!Number.isInteger(port) || port < 1 || port > 65535) fail('--port must be an integer between 1 and 65535');

const manifestPath = path.join(ROOT, 'dist', 'cloudflare', 'artifact', 'manifest.json');
if (!existsSync(manifestPath)) fail('no artifact; run npm run build:cloudflare first');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const git = gitState();
if (manifest.source?.commit !== git.commit || manifest.source?.dirty || git.dirty) {
  console.warn('! The artifact does not match the current clean commit; rebuild to preview current source.');
}

console.log(`• Previewing artifact ${manifest.artifact.workerSha256.slice(0, 12)} in local workerd on http://127.0.0.1:${port}`);
console.log('  Synthetic provider responses only; no credentials; storage is discarded on exit.');
console.log('  Researcher password (synthetic fixture): e2e-cloudflare-admin-password');

const child = spawn(process.execPath, [path.join(ROOT, 'tests', 'e2e-cloudflare', 'server.mjs'), String(port)], {
  cwd: ROOT,
  stdio: 'inherit',
});
const forward = (signal) => () => child.kill(signal);
process.on('SIGINT', forward('SIGINT'));
process.on('SIGTERM', forward('SIGTERM'));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
