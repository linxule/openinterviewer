// config: (re)write an installation's wrangler config from its receipt and
// the current wrangler.jsonc, with no remote call. This is the file a deploy
// owner outside the installer (the CI promotion job's
// CLOUDFLARE_INSTALL_CONFIG) must deploy, so it is written only for a
// complete installation whose WORKSPACE_BOOTSTRAP was cleared.

import { bootstrapFor } from './context.mjs';
import { InstallerError, REFUSED } from './model.mjs';
import { acquireLock, buildInstallationConfig, readReceipt, writeInstallationConfig } from './state.mjs';
import { checkDeployedConfig } from './verify.mjs';

/** Options that request a change; config never changes an installation. */
const CHANGE_OPTIONS = [
  'provider', 'jurisdiction', 'origin', 'account-id', 'import-target', 'secrets-stdin',
  'operator-token-file', 'reveal-operator-token', 'change-provider', 'yes',
];

export async function configCommand(ctx) {
  const given = CHANGE_OPTIONS.filter((name) => ctx.options[name] !== undefined);
  if (given.length > 0) {
    throw new InstallerError(`config only rewrites the installation config from the receipt; it takes no ${given.map((name) => `--${name}`).join(', ')}`, {
      exitCode: REFUSED,
      hints: ['Change an installation with update (for example update --change-provider), then run config again.'],
    });
  }
  const receipt = readReceipt(ctx.paths.receipt);
  if (!receipt) {
    throw new InstallerError(`no receipt for ${ctx.install} (${ctx.environment}) at ${ctx.paths.receipt}`, {
      exitCode: REFUSED,
      hints: ['config needs the installation receipt; pass --state-dir if it lives elsewhere.'],
    });
  }
  if (!receipt.phases?.['bootstrap-clear'] || bootstrapFor(receipt) !== '') {
    throw new InstallerError(`installation ${ctx.install} (${ctx.environment}) is not complete: WORKSPACE_BOOTSTRAP has not been cleared`, {
      exitCode: REFUSED,
      hints: ['Finish it with resume first. A config that still bootstraps must never be deployed outside the installer.'],
    });
  }
  const config = buildInstallationConfig(ctx.template, receipt, { bootstrap: bootstrapFor(receipt) });
  // The same local check verify --config applies after a CI deploy.
  const local = checkDeployedConfig({ template: ctx.template, config });
  if (!local.ok || local.templateDrift.length > 0) {
    throw new InstallerError(`the installation config generated from the receipt fails its own check:\n  - ${[...local.diffs, ...local.templateDrift.map((key) => `template drift: ${key}`)].join('\n  - ')}`, {
      exitCode: REFUSED,
    });
  }
  const release = acquireLock(ctx.paths.lock);
  try {
    writeInstallationConfig(ctx.paths.config, config, receipt, ctx.registry);
  } finally {
    release();
  }
  ctx.out.step(`Wrote the installation config of ${ctx.install} (${ctx.environment}) from its receipt and wrangler.jsonc; nothing remote was called`);
  ctx.out.line(ctx.paths.config);
  ctx.out.result({
    command: 'config',
    install: ctx.install,
    env: ctx.environment,
    path: ctx.paths.config,
    worker: config.name,
    appBaseUrl: config.vars.APP_BASE_URL,
    provider: config.vars.AI_PROVIDER,
  });
  return 0;
}
