// Shared command context: resolved paths and tools, account resolution,
// receipt persistence and the deploy step used by apply/resume/update.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT, readJsonc } from '../lib.mjs';
import {
  InstallerError,
  REFUSED,
  isOwnWorkersDevHost,
  isWorkersDevOrigin,
  validateAccountId,
  validateEnvironment,
  validateInstallName,
  workersDevUrlFromOutput,
} from './model.mjs';
import {
  SecretRegistry,
  buildInstallationConfig,
  installPaths,
  listReceipts,
  writeInstallationConfig,
  writeReceipt,
} from './state.mjs';
import { FORWARDED_ENV, Wrangler, runDeploy, unforwardedEnvironment } from './tools.mjs';

export class Reporter {
  constructor({ json }) {
    this.json = json;
    // With --json, stdout carries exactly one JSON document.
    this.stream = json ? process.stderr : process.stdout;
  }

  line(text = '') {
    this.stream.write(`${text}\n`);
  }

  step(text) {
    this.line(`• ${text}`);
  }

  result(value) {
    if (this.json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  }
}

export function parseWaitSeconds(raw) {
  const waitSeconds = Number(raw);
  if (raw === '' || !Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 3600) {
    throw new InstallerError('--wait-seconds must be between 0 and 3600', { exitCode: REFUSED });
  }
  return waitSeconds;
}

export function createContext(command, options) {
  const install = validateInstallName(options.install);
  const environment = validateEnvironment(options.env);
  if (options['account-id'] !== undefined) validateAccountId(options['account-id']);
  const stateDir = path.resolve(options['state-dir'] ?? path.join(ROOT, 'cloudflare', 'installations'));
  const waitSeconds = parseWaitSeconds(options['wait-seconds'] ?? '180');
  const templatePath = path.join(ROOT, 'wrangler.jsonc');
  return {
    command,
    options,
    install,
    environment,
    stateDir,
    paths: installPaths(stateDir, install, environment),
    root: ROOT,
    template: readJsonc(templatePath),
    waitSeconds,
    wranglerPath: path.resolve(options.wrangler ?? path.join(ROOT, 'node_modules', '.bin', 'wrangler')),
    gitPath: options.git ? path.resolve(options.git) : 'git',
    deployScript: path.resolve(options['deploy-script'] ?? path.join(ROOT, 'scripts', 'cloudflare', 'deploy.mjs')),
    artifactDir: path.resolve(options['artifact-dir'] ?? path.join(ROOT, 'dist', 'cloudflare', 'artifact')),
    registry: new SecretRegistry(),
    out: new Reporter({ json: Boolean(options.json) }),
    _wrangler: null,
  };
}

export function wranglerFor(ctx) {
  ctx._wrangler ??= new Wrangler({ executable: ctx.wranglerPath, cwd: ctx.root });
  return ctx._wrangler;
}

/**
 * Every wrangler the installer starts, including the one inside deploy.mjs,
 * gets the same environment allowlist (tools.mjs FORWARDED_ENV). Settings
 * outside it are reported as ignored; a non-public compliance region is
 * refused because ignoring it would silently target the public API.
 */
export function checkToolEnvironment(ctx) {
  const ignored = unforwardedEnvironment();
  const region = process.env.CLOUDFLARE_COMPLIANCE_REGION;
  if (region && region !== 'public') {
    throw new InstallerError(`CLOUDFLARE_COMPLIANCE_REGION=${region} is not supported: scripts/cloudflare/deploy.mjs does not forward it to wrangler`, {
      exitCode: REFUSED,
      hints: [
        'The installer refuses rather than create queues and secrets in one API region and deploy through another.',
        `deploy.mjs forwards only ${FORWARDED_ENV.join(' and ')}; extend both allowlists together before using a compliance region.`,
      ],
    });
  }
  const dropped = ignored.filter((name) => name !== 'CLOUDFLARE_COMPLIANCE_REGION');
  if (dropped.length > 0) {
    ctx.out.line(`Note: ignoring ${dropped.join(', ')}: deploy.mjs does not forward them to wrangler, so no installer wrangler call uses them either.`);
  }
}

/**
 * Pick the target account from `wrangler whoami`. An explicit --account-id,
 * the receipt and CLOUDFLARE_ACCOUNT_ID must all agree; with several
 * accessible accounts and no explicit choice the installer refuses.
 */
export function resolveAccount(whoami, { requested, receiptAccount, envAccount }) {
  if (requested && receiptAccount && requested !== receiptAccount) {
    throw new InstallerError(`--account-id ${requested} differs from the receipt's account ${receiptAccount}`, { exitCode: REFUSED });
  }
  const chosen = requested ?? receiptAccount ?? envAccount ?? (whoami.accounts.length === 1 ? whoami.accounts[0].id : null);
  if (!chosen) {
    throw new InstallerError(`wrangler can access ${whoami.accounts.length} accounts; choose one with --account-id`, {
      exitCode: REFUSED,
      hints: whoami.accounts.map((account) => `${account.id}  ${account.name}`),
    });
  }
  if (envAccount && envAccount !== chosen) {
    throw new InstallerError(`CLOUDFLARE_ACCOUNT_ID (${envAccount}) differs from the installation account ${chosen}`, { exitCode: REFUSED });
  }
  const account = whoami.accounts.find((entry) => entry.id === chosen);
  if (!account) {
    throw new InstallerError(`account ${chosen} is not accessible with the current wrangler credentials`, { exitCode: REFUSED });
  }
  return account;
}

/** Origins are never shared between installations (SETUP-05: staging has its own). */
export function assertOriginUnique(ctx, origin) {
  if (!origin) return;
  for (const other of listReceipts(ctx.stateDir)) {
    if (other.install === ctx.install && other.env === ctx.environment) continue;
    if (other.origin === origin) {
      throw new InstallerError(`origin ${origin} already belongs to installation ${other.install} (${other.env})`, { exitCode: REFUSED });
    }
  }
}

/** Explicit workers.dev origins must name this installation's Worker. */
export function assertOwnWorkersDevOrigin(origin, worker) {
  if (origin && isWorkersDevOrigin(origin) && !isOwnWorkersDevHost(new URL(origin).hostname, worker)) {
    throw new InstallerError(`origin ${origin} is not a workers.dev URL of Worker ${worker}`, { exitCode: REFUSED });
  }
}

export function saveReceipt(ctx, receipt) {
  writeReceipt(ctx.paths.receipt, receipt, ctx.registry);
}

export function bootstrapFor(receipt) {
  return receipt.phases['workspace-init'] ? '' : receipt.bootstrap;
}

export function writeConfig(ctx, receipt, { provider = receipt.provider } = {}) {
  const config = buildInstallationConfig(ctx.template, receipt, { bootstrap: bootstrapFor(receipt), provider });
  writeInstallationConfig(ctx.paths.config, config, receipt, ctx.registry);
  return config;
}

/**
 * wrangler calls that pass --config need the installation config on disk
 * (real wrangler fails on a missing file). When only receipt.json was
 * restored, regenerate it from the receipt and the current template.
 */
export function ensureConfigFile(ctx, receipt) {
  if (existsSync(ctx.paths.config)) return false;
  writeConfig(ctx, receipt);
  ctx.out.step(`Regenerated the missing installation config ${ctx.paths.config} from the receipt`);
  return true;
}

const NOTHING_UPLOADED = /deploy preconditions failed; nothing was uploaded/;

/** The only deploys whose config may carry WORKSPACE_BOOTSTRAP (before workspace-init completes). */
export const BOOTSTRAP_PURPOSES = ['initial', 'origin', 'workspace-init'];

/**
 * Regenerate the installation config from the current template + receipt,
 * run the deploy script and record the deployment. The deploy script
 * enforces the artifact, clean-checkout and config-drift preconditions,
 * and accepts a set WORKSPACE_BOOTSTRAP only with --bootstrap, which is
 * passed exactly when this config carries one.
 * A failure carries `nothingUploaded` when deploy.mjs refused locally,
 * before wrangler ran.
 */
export async function deployInstallation(ctx, receipt, { purpose, artifact, provider = receipt.provider }) {
  // Checked before the config is rewritten, so a refusal leaves it untouched.
  if (bootstrapFor(receipt) !== '' && !BOOTSTRAP_PURPOSES.includes(purpose)) {
    throw new InstallerError(`refusing to deploy (${purpose}) with WORKSPACE_BOOTSTRAP '${bootstrapFor(receipt)}': the receipt records no workspace-init phase`, {
      exitCode: REFUSED,
      hints: ['Only the initial, origin and workspace-init deploys may bootstrap a workspace. Check the receipt phases (INSTALLER.md, re-bootstrap).'],
    });
  }
  const config = writeConfig(ctx, receipt, { provider });
  const bootstrap = config.vars.WORKSPACE_BOOTSTRAP !== '';
  ctx.out.step(`Deploying ${config.name} (${purpose}; APP_BASE_URL ${config.vars.APP_BASE_URL || 'not set yet'}, WORKSPACE_BOOTSTRAP '${config.vars.WORKSPACE_BOOTSTRAP}')`);
  const result = await runDeploy({
    script: ctx.deployScript,
    configPath: ctx.paths.config,
    artifactDir: ctx.options['artifact-dir'] ? ctx.artifactDir : undefined,
    cwd: ctx.root,
    accountId: receipt.accountId,
    bootstrap,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.code !== 0) {
    const nothingUploaded = NOTHING_UPLOADED.test(output);
    let error;
    if (nothingUploaded && /installation var APP_BASE_URL is empty/.test(output)) {
      error = new InstallerError('the deploy script refuses a configuration without APP_BASE_URL, so the workers.dev origin cannot be discovered by deploying first', {
        hints: [
          `Resume with an explicit origin: --origin https://${config.name}.<account-subdomain>.workers.dev (the subdomain is shown under Workers & Pages → Account details) or your custom domain.`,
          `Nothing was uploaded and the ${purpose === 'initial' ? 'deploy-initial' : purpose} phase was not recorded; the identity, queues and config recorded so far are kept for resume.`,
        ],
      });
    } else {
      error = new InstallerError(`deploy (${purpose}) failed with exit ${result.code}`, {
        hints: [
          nothingUploaded ? 'deploy.mjs refused before uploading anything.' : 'The upload may or may not have landed.',
          'The step was not recorded; fix the cause above and run resume (or update) again.',
        ],
      });
    }
    error.nothingUploaded = nothingUploaded;
    throw error;
  }
  const url = workersDevUrlFromOutput(output, config.name);
  if (url) receipt.workersDevUrl = url;
  receipt.deployments.push({
    purpose,
    commit: artifact.commit,
    workerSha256: artifact.workerSha256,
    appBaseUrl: config.vars.APP_BASE_URL,
    bootstrap: config.vars.WORKSPACE_BOOTSTRAP,
    provider,
    at: new Date().toISOString(),
  });
  saveReceipt(ctx, receipt);
  return { url, config };
}
