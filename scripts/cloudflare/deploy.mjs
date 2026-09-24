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
//  - the AI transport vars pass the Worker's own route validation (RT-11):
//    direct with both gateway identifiers empty, or cloudflare-gateway with a
//    32-hex account ID and a gateway ID other than `default`; otherwise the
//    uploaded Worker would report not-ready;
//  - WORKSPACE_BOOTSTRAP is empty unless --bootstrap is given, which only the
//    installer passes, for the deploys that initialize a fresh workspace
//    (gap review F2): any other deploy of a bootstrap config could make an
//    empty writable workspace after an identity or jurisdiction change;
//  - --confirm is given (otherwise --dry-run semantics apply).
//
// Usage:
//   node scripts/cloudflare/deploy.mjs --install <installation wrangler.jsonc> [--dry-run | --confirm] [--artifact <dir>]
//   node scripts/cloudflare/deploy.mjs --install <installation wrangler.jsonc> --check-config
// --check-config validates only the installation config (template drift,
// required vars, AI transport, bootstrap) and needs no artifact; nothing is
// uploaded.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
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
  isMain,
} from './lib.mjs';
import { ACCOUNT_ID_PATTERN, GATEWAY_ID_PATTERN } from './installer/model.mjs';

// Fields an installation may set; everything else must equal the template.
const INSTALLATION_OWNED = new Set(['name', 'vars', 'routes', 'workers_dev', 'account_id', 'queues']);
const QUEUE_NAME_FIELDS = new Set(['queue', 'dead_letter_queue']);

/** WORKSPACE_BOOTSTRAP values that initialize a fresh workspace object. */
export const BOOTSTRAP_VALUES = ['open', 'recovery'];

export function parseDeployArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      install: { type: 'string' },
      artifact: { type: 'string' },
      confirm: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      'allow-dirty-dry-run': { type: 'boolean' },
      bootstrap: { type: 'boolean' },
      'check-config': { type: 'boolean' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values.install) throw new Error('--install <installation wrangler config> is required');
  const dryRun = Boolean(values['dry-run']) || !values.confirm;
  return {
    installPath: values.install,
    artifactDir: path.resolve(ROOT, values.artifact ?? 'dist/cloudflare/artifact'),
    dryRun,
    allowDirtyForDryRun: Boolean(values['allow-dirty-dry-run']),
    bootstrap: Boolean(values.bootstrap),
    checkConfig: Boolean(values['check-config']),
  };
}

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

/**
 * Installation vars that must be set. APP_BASE_URL may be empty only in a
 * bootstrap configuration (WORKSPACE_BOOTSTRAP open|recovery): the installer's
 * first deploy discovers the workers.dev origin, and until an origin is set
 * the Worker reports not-ready and refuses participant and researcher writes.
 * With AI_TRANSPORT=cloudflare-gateway both gateway identifiers are required
 * too (RT-11).
 */
export function missingInstallationVars(vars = {}) {
  const bootstrapping = BOOTSTRAP_VALUES.includes(vars.WORKSPACE_BOOTSTRAP);
  const required = bootstrapping ? ['WORKSPACE_ID', 'AI_PROVIDER'] : ['APP_BASE_URL', 'WORKSPACE_ID', 'AI_PROVIDER'];
  if (routeTransport(vars) === 'cloudflare-gateway') required.push('CF_AI_GATEWAY_ACCOUNT_ID', 'CF_AI_GATEWAY_ID');
  return required.filter((name) => !vars[name]);
}

// Mirrors src/lib/providers/endpoint.ts (providerRouteErrors), which the
// Worker's readiness applies; tests/unit/installerGatewayContract.test.ts
// keeps the two equal.
const varText = (value) => (typeof value === 'string' ? value : '');

/** The transport the Worker resolves: trimmed; unset or empty is direct. */
function routeTransport(vars) {
  const raw = vars.AI_TRANSPORT;
  const transport = typeof raw === 'string' ? raw.trim() : raw;
  return transport === undefined || transport === '' ? 'direct' : transport;
}

/**
 * The AI transport vars the Worker would refuse (RT-11): an unknown
 * AI_TRANSPORT, gateway identifiers on direct
 * (`cf_ai_gateway_config_without_transport`), or malformed identifiers on
 * cloudflare-gateway. Empty identifiers on the gateway are reported by
 * missingInstallationVars. The Run token is a secret and is not checked here.
 */
export function transportVarProblems(vars = {}) {
  const transport = routeTransport(vars);
  const account = varText(vars.CF_AI_GATEWAY_ACCOUNT_ID);
  const gateway = varText(vars.CF_AI_GATEWAY_ID);
  if (transport === 'direct') {
    return account !== '' || gateway !== ''
      ? ['installation vars CF_AI_GATEWAY_ACCOUNT_ID and CF_AI_GATEWAY_ID must be empty with AI_TRANSPORT direct (the Worker would report cf_ai_gateway_config_without_transport)']
      : [];
  }
  if (transport !== 'cloudflare-gateway') {
    return [`installation var AI_TRANSPORT is ${JSON.stringify(vars.AI_TRANSPORT)}; it must be direct or cloudflare-gateway`];
  }
  const problems = [];
  // The Worker reads a non-string var as '' and then refuses it on the gateway,
  // so a number or boolean here must not pass as present.
  for (const name of ['CF_AI_GATEWAY_ACCOUNT_ID', 'CF_AI_GATEWAY_ID']) {
    if (vars[name] !== undefined && typeof vars[name] !== 'string') problems.push(`installation var ${name} must be a string with AI_TRANSPORT cloudflare-gateway`);
  }
  if (account !== '' && !ACCOUNT_ID_PATTERN.test(account)) problems.push('installation var CF_AI_GATEWAY_ACCOUNT_ID is not a 32-character lowercase hexadecimal account ID');
  if (gateway !== '' && (!GATEWAY_ID_PATTERN.test(gateway) || gateway === 'default')) problems.push('installation var CF_AI_GATEWAY_ID is not a gateway id other than default');
  return problems;
}

/** WORKSPACE_BOOTSTRAP must be empty unless this is an installer bootstrap deploy (--bootstrap). */
export function bootstrapProblems(vars = {}, { bootstrap = false } = {}) {
  const value = vars.WORKSPACE_BOOTSTRAP ?? '';
  if (value === '') return [];
  if (!BOOTSTRAP_VALUES.includes(value)) {
    return [`installation var WORKSPACE_BOOTSTRAP is ${JSON.stringify(value)}; it must be empty (or open|recovery in an installer bootstrap deploy)`];
  }
  if (!bootstrap) {
    return [
      `installation var WORKSPACE_BOOTSTRAP is "${value}": only the installer's bootstrap deploys (--bootstrap) may set it; `
        + 'deploy the installer-generated config from after bootstrap-clear, where it is empty',
    ];
  }
  return [];
}

/** Every precondition on the installation config itself (no artifact, no git). */
export function installationConfigProblems(template, install, { bootstrap = false } = {}) {
  const problems = [];
  const drift = configDrift(template, install);
  if (drift.length > 0) problems.push(`installation config drifts from wrangler.jsonc in: ${drift.join(', ')}`);
  for (const name of missingInstallationVars(install.vars)) problems.push(`installation var ${name} is empty`);
  problems.push(...transportVarProblems(install.vars));
  problems.push(...bootstrapProblems(install.vars, { bootstrap }));
  return problems;
}

function readJsonFile(file) {
  try {
    return { value: JSON.parse(readFileSync(file, 'utf8')) };
  } catch {
    return { value: null };
  }
}

/**
 * Artifact preconditions against a checkout (`root`) and its git state
 * (`git` = { commit, dirty }). Returns the manifest (null when unreadable)
 * and every problem found; an empty list means the artifact may be deployed.
 * `allowDirtyCheckout` waives only the checkout's own dirty state.
 */
export function verifyArtifact({ root = ROOT, artifactDir, git, allowDirtyCheckout = false }) {
  const problems = [];
  if (git.dirty && !allowDirtyCheckout) problems.push('checkout has uncommitted or untracked files');
  const manifestPath = path.join(artifactDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    problems.push('no artifact manifest; run npm run build:cloudflare');
    return { manifest: null, problems };
  }
  const manifest = readJsonFile(manifestPath).value;
  if (!manifest || typeof manifest !== 'object') {
    problems.push('artifact manifest is not valid JSON');
    return { manifest: null, problems };
  }
  if (manifest.source?.commit !== git.commit) problems.push('artifact was built from a different commit');
  if (manifest.source?.dirty) problems.push('artifact was built from a dirty tree');
  if (manifest.lockfileSha256 !== sha256File(path.join(root, 'package-lock.json'))) problems.push('package-lock.json changed since build');
  if (manifest.templateConfigSha256 !== sha256File(path.join(root, 'wrangler.jsonc'))) problems.push('wrangler.jsonc changed since build');
  for (const [dir, field, label] of [['worker', 'workerSha256', 'worker bundle differs'], ['assets', 'assetsSha256', 'assets differ']]) {
    const full = path.join(artifactDir, dir);
    if (!existsSync(full)) problems.push(`artifact ${dir}/ directory is missing`);
    else if (sha256Tree(full).sha256 !== manifest.artifact?.[field]) problems.push(`${label} from manifest`);
  }
  const receiptPath = path.join(artifactDir, 'receipt.json');
  if (!existsSync(receiptPath)) {
    problems.push('no passing release-check receipt; run npm run check:cloudflare');
  } else {
    const receipt = readJsonFile(receiptPath).value;
    if (!receipt || typeof receipt !== 'object') {
      problems.push('release-check receipt is not valid JSON');
    } else {
      if (receipt.status !== 'passed') problems.push('release-check receipt is not passing');
      if (receipt.artifact?.workerSha256 !== manifest.artifact?.workerSha256) problems.push('receipt belongs to another artifact');
      if (receipt.source?.commit !== manifest.source?.commit) problems.push('receipt belongs to another commit');
    }
  }
  return { manifest, problems };
}

/** --dry-run --allow-dirty-dry-run validates a work-in-progress build: only dirty-tree and receipt problems are waived. */
export function waivedForDryRun(problems) {
  return problems.every((problem) => /dirty|receipt/.test(problem));
}

function refuse(problems) {
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  fail('deploy preconditions failed; nothing was uploaded');
}

async function main(argv) {
  let options;
  try {
    options = parseDeployArgs(argv);
  } catch (error) {
    fail(error.message);
  }
  const template = readJsonc(path.join(ROOT, 'wrangler.jsonc'));
  const installFile = path.resolve(ROOT, options.installPath);
  let install;
  try {
    install = readJsonc(installFile);
  } catch (error) {
    fail(`installation config ${installFile} is not readable JSONC (${error.code ?? error.name})`);
  }
  if (!install || typeof install !== 'object' || Array.isArray(install)) fail(`installation config ${installFile} is not a JSON object`);
  const configProblems = installationConfigProblems(template, install, { bootstrap: options.bootstrap });
  if (options.checkConfig) {
    if (configProblems.length > 0) refuse(configProblems);
    console.log(`• Installation config for ${install.name} passes the deploy preconditions (template, vars${options.bootstrap ? '' : ', no bootstrap'}).`);
    return;
  }

  const { manifest, problems } = verifyArtifact({
    root: ROOT,
    artifactDir: options.artifactDir,
    git: gitState(),
    allowDirtyCheckout: options.dryRun && options.allowDirtyForDryRun,
  });
  problems.push(...configProblems);
  if (!manifest || (problems.length > 0 && !(options.dryRun && options.allowDirtyForDryRun && waivedForDryRun(problems)))) {
    refuse(problems);
  }

  // Deploy exactly the prebuilt bundle (same derivation as createTestHarness's
  // prebuiltWorkerDir): no bundling, additional modules found in the bundle dir.
  const { artifactDir, dryRun } = options;
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
}

if (isMain(import.meta)) await main(process.argv.slice(2));
