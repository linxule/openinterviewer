#!/usr/bin/env node
// Stand-in for scripts/cloudflare/deploy.mjs. It applies the same config
// checks as the real script (its configDrift(), missingInstallationVars() and
// bootstrapProblems(), so a set WORKSPACE_BOOTSTRAP needs --bootstrap),
// records what it was given, marks the Worker deployed in the fake
// account (with deploy.mjs's `openinterviewer <commit12>` message) and prints
// wrangler 4.136.3-shaped output: the bindings table, which echoes var
// values truncated at 40 characters (printBindings), then the
// `Deployed <name> triggers` block with a deterministic workers.dev URL.
//
// state.deploy.refusePendingOrigin simulates a deploy script that refuses an
// empty APP_BASE_URL even in a bootstrap config (the installer must then stop
// cleanly and ask for --origin). The default matches deploy.mjs.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, parseJsonc } from '../../../scripts/cloudflare/lib.mjs';
import { bootstrapProblems, missingInstallationVars, realConfigDrift } from './deploy-config-drift.mjs';
import { invocation, readState, takeFailure, writeState } from './fake-state.mjs';

const argv = process.argv.slice(2);
const state = readState();
state.invocations.push(invocation('deploy', argv));

const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
function finish(code, stdout = '', stderr = '') {
  writeState(state);
  if (stdout) process.stdout.write(`${stdout}\n`);
  if (stderr) process.stderr.write(`${stderr}\n`);
  process.exit(code);
}

const installPath = flag('--install');
if (!installPath) finish(1, '', 'error: --install <installation wrangler config> is required');
const install = parseJsonc(readFileSync(path.resolve(ROOT, installPath), 'utf8'));
const template = parseJsonc(readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8'));

const problems = [];
const drift = realConfigDrift(template, install);
if (drift.length > 0) problems.push(`installation config drifts from wrangler.jsonc in: ${drift.join(', ')}`);
const missing = missingInstallationVars(install.vars);
if (state.deploy.refusePendingOrigin && !install.vars?.APP_BASE_URL && !missing.includes('APP_BASE_URL')) missing.unshift('APP_BASE_URL');
for (const name of missing) problems.push(`installation var ${name} is empty`);
problems.push(...bootstrapProblems(install.vars, { bootstrap: argv.includes('--bootstrap') }));
if (problems.length > 0) {
  finish(1, '', `${problems.map((problem) => `  ✗ ${problem}`).join('\n')}\nerror: deploy preconditions failed; nothing was uploaded`);
}
if (!argv.includes('--confirm')) finish(0, '• Dry run complete; nothing was uploaded.');

const when = takeFailure(state, 'deploy', install.name);
if (when === 'before') finish(1, '', `✘ [ERROR] injected deploy failure for ${install.name}`);

// state.deploy.plantFile: another local user creates this path during the
// deploy (a race against the installer's earlier path check).
if (state.deploy.plantFile) writeFileSync(state.deploy.plantFile, 'planted\n');

const artifactDir = flag('--artifact') ? path.resolve(ROOT, flag('--artifact')) : path.join(ROOT, 'dist', 'cloudflare', 'artifact');
const manifest = JSON.parse(readFileSync(path.join(artifactDir, 'manifest.json'), 'utf8'));
const message = `openinterviewer ${manifest.source.commit.slice(0, 12)}`;

const worker = state.workers[install.name] ?? { secrets: {}, deployments: [] };
worker.draft = false;
worker.vars = install.vars;
worker.accountId = install.account_id;
worker.queues = install.queues;
worker.deployments.push({ at: new Date().toISOString(), vars: install.vars, message });
state.workers[install.name] = worker;
state.deploys.push({ name: install.name, account_id: install.account_id, vars: install.vars, queues: install.queues, argv, message });

const truncate = (value) => (value.length < 40 ? value : `${value.slice(0, 37)}...`);
const lines = [
  `• Deploying ${install.name} from artifact fixture`,
  'Your Worker has access to the following bindings:',
  'Binding                                        Resource',
  'env.WORKSPACE_STORE (WorkspaceStore)           Durable Object',
  `env.ANALYSIS_QUEUE (${install.queues.producers[0].queue})   Queue`,
  ...Object.entries(install.vars).map(([name, value]) => `env.${name} ("${truncate(String(value))}")   Environment Variable`),
  '',
  `Uploaded ${install.name} (1.00 sec)`,
  `Deployed ${install.name} triggers (0.50 sec)`,
];
if (install.workers_dev !== false) lines.push(`  https://${install.name}.${state.subdomain}.workers.dev`);
lines.push(`  Producer for ${install.queues.producers[0].queue}`, `  Consumer for ${install.queues.consumers[0].queue}`);
lines.push(`Current Version ID: ${String(state.deploys.length).padStart(8, '0')}-0000-4000-8000-000000000000`);
if (when === 'after') finish(1, lines.join('\n'), '✘ [ERROR] injected lost reply after upload');
finish(0, lines.join('\n'));
