// update (SETUP-01, SETUP-05): deploy a new checked artifact to an existing
// installation. Regenerates the installation config from the current
// template + receipt, refuses on drift, never rotates secrets or the epoch
// and never deletes resources. A provider change is recorded in the receipt
// as pendingProviderChange before its first remote write and finalized only
// after its deploy succeeded, so rerunning the same update finishes it.

import { artifactStatus } from './artifact.mjs';
import { checkToolEnvironment, deployInstallation, ensureConfigFile, resolveAccount, saveReceipt, wranglerFor } from './context.mjs';
import {
  HELD,
  InstallerError,
  PROVIDER_KEYS,
  REFUSED,
  requiredSecretNames,
  validateJurisdiction,
  validateOrigin,
  validateProvider,
} from './model.mjs';
import { readProtectedInput } from './secrets.mjs';
import { acquireLock, assertNoPendingProviderChange, buildInstallationConfig, identityDiff, installationIdentity, readInstallationConfig, readReceipt } from './state.mjs';
import { printVerification, summarizeVerification } from './report.mjs';
import { verifyInstallation } from './verify.mjs';

const refuse = (message, hints = []) => new InstallerError(message, { exitCode: REFUSED, hints });

export async function updateCommand(ctx) {
  const { options, out } = ctx;
  const receipt = readReceipt(ctx.paths.receipt);
  if (!receipt) {
    throw refuse(`no receipt for ${ctx.install} (${ctx.environment}) at ${ctx.paths.receipt}`, [
      'update needs an explicit existing-install identity: restore this installation\'s receipt.json (and wrangler.jsonc),',
      'or use plan/apply for a new installation. Existing resources with matching names are never adopted.',
    ]);
  }
  if (!receipt.phases['bootstrap-clear']) {
    throw refuse(`installation ${ctx.install} (${ctx.environment}) is not fully installed; run resume first`);
  }
  if (!options.yes) throw refuse('--yes is required to confirm the reviewed update');
  if (options.provider !== undefined) validateProvider(options.provider);
  if (options.jurisdiction !== undefined) validateJurisdiction(options.jurisdiction);
  if (options['change-provider'] && !options.provider) throw refuse('--change-provider requires --provider <name>');
  const pending = assertNoPendingProviderChange(receipt, {
    finishing: Boolean(options['change-provider']) && options.provider === receipt.pendingProviderChange?.to,
  });

  const requested = [];
  if (options.jurisdiction && options.jurisdiction !== receipt.jurisdiction) {
    requested.push(`jurisdiction: installed ${receipt.jurisdiction}, requested ${options.jurisdiction}. Changing it selects a new Durable Object location — a data migration, not an update.`);
  }
  if (options['import-target']) requested.push('--import-target only applies when an installation is first applied.');
  if (options.origin !== undefined && validateOrigin(options.origin) !== receipt.origin) {
    requested.push(`origin: installed ${receipt.origin}, requested ${validateOrigin(options.origin)}. Changing the origin is a separate operation.`);
  }
  if (options['account-id'] && options['account-id'] !== receipt.accountId) {
    requested.push(`account: installed ${receipt.accountId}, requested ${options['account-id']}.`);
  }
  let provider = receipt.provider;
  if (options.provider && options.provider !== receipt.provider) {
    if (options['change-provider']) provider = options.provider;
    else requested.push(`provider: installed ${receipt.provider}, requested ${options.provider}. Pass --change-provider to switch AI_PROVIDER (no other secret changes).`);
  }
  if (requested.length > 0) throw refuse(`update refused:\n  - ${requested.join('\n  - ')}`);

  checkToolEnvironment(ctx);
  const release = acquireLock(ctx.paths.lock);
  try {
    const wrangler = wranglerFor(ctx);
    const account = resolveAccount(await wrangler.whoami(), {
      requested: options['account-id'],
      receiptAccount: receipt.accountId,
      envAccount: process.env.CLOUDFLARE_ACCOUNT_ID,
    });
    wrangler.useAccount(account.id);
    const { names } = receipt;

    out.step(`Checking ${names.worker} for drift`);
    if (!(await wrangler.workerExists(names.worker))) {
      throw refuse(`Worker ${names.worker} recorded in the receipt was not found in account ${account.id}`, [
        'update never recreates an installation. Investigate before continuing.',
      ]);
    }
    const drift = [];
    const queues = await wrangler.listQueues();
    for (const name of [names.queue, names.deadLetterQueue]) {
      const recordedId = receipt.resources?.[name]?.id;
      if (!queues.has(name)) drift.push(`queue ${name}: recorded in the receipt, missing in the account (not recreated automatically)`);
      else if (recordedId && queues.get(name).id !== recordedId) {
        drift.push(`queue ${name}: id ${queues.get(name).id} differs from the recorded ${recordedId} (deleted and recreated?)`);
      }
    }
    // Compared against the regenerated config below; wrangler's --config
    // must name an existing file.
    const onDisk = readInstallationConfig(ctx.paths.config);
    ensureConfigFile(ctx, receipt);
    const bound = await wrangler.secretNames(names.worker, ctx.paths.config);
    const newKey = provider !== receipt.provider ? PROVIDER_KEYS[provider] : null;
    for (const name of requiredSecretNames(receipt.provider)) {
      if (!bound?.has(name)) drift.push(`secret ${name}: missing on ${names.worker}`);
    }
    if (onDisk) {
      // An interrupted provider change may have left the config on either side.
      const sides = [receipt.provider, ...(pending ? [pending.to] : [])].map((side) => {
        const expected = buildInstallationConfig(ctx.template, receipt, { bootstrap: '', provider: side });
        const vars = Object.keys(expected.vars).filter((name) => Object.hasOwn(onDisk.vars ?? {}, name));
        const pick = (identity) => ({ ...identity, vars: Object.fromEntries(vars.map((name) => [name, identity.vars[name]])) });
        return identityDiff(pick(installationIdentity(expected)), pick(installationIdentity(onDisk)));
      });
      if (!sides.some((diffs) => diffs.length === 0)) {
        for (const diff of sides[0]) drift.push(`installation config ${diff}`);
      }
    }
    if (drift.length > 0) {
      throw refuse(`drift detected; nothing was changed:\n  - ${drift.join('\n  - ')}`, [
        'Restore the recorded state (or the receipt) deliberately, then rerun update.',
      ]);
    }

    const artifact = await artifactStatus({ root: ctx.root, artifactDir: ctx.artifactDir, git: ctx.gitPath });
    if (!artifact.ready) {
      throw refuse('the release artifact is not ready for deployment', [
        ...artifact.problems,
        'Build and check it for the current clean commit, then rerun update.',
      ]);
    }

    // The key is read and validated before anything is recorded or uploaded.
    let supplied = null;
    if (newKey && !bound.has(newKey)) {
      out.step(`Adding ${newKey} for provider ${provider} (no other secret changes)`);
      supplied = await readProtectedInput([newKey], { fromStdin: Boolean(options['secrets-stdin']) });
      for (const value of Object.values(supplied)) ctx.registry.add(value);
    }
    if (newKey && !pending) {
      receipt.pendingProviderChange = { from: receipt.provider, to: provider, startedAt: new Date().toISOString() };
      saveReceipt(ctx, receipt);
    }
    try {
      if (supplied) {
        await wrangler.putSecrets(names.worker, ctx.paths.config, supplied);
        const after = await wrangler.secretNames(names.worker, ctx.paths.config);
        if (!after?.has(newKey)) throw new InstallerError(`${newKey} not observed after upload`);
      }
      await deployInstallation(ctx, receipt, { purpose: 'update', artifact, provider });
    } catch (error) {
      if (newKey && error instanceof InstallerError) {
        error.hints = [...error.hints, `The provider change to ${provider} is recorded as pending in the receipt; rerun this update (--provider ${provider} --change-provider) to finish it.`];
      }
      throw error;
    }
    if (newKey) {
      receipt.providerHistory = [...(receipt.providerHistory ?? []), { from: receipt.provider, to: provider, at: new Date().toISOString() }];
      receipt.provider = provider;
      delete receipt.pendingProviderChange;
      saveReceipt(ctx, receipt);
    }

    // Held is accepted as a settled outcome: the RUNBOOK drains the
    // workspace before a deploy, so a held workspace is expected here.
    const verification = await verifyInstallation({
      template: ctx.template,
      receipt,
      configPath: ctx.paths.config,
      waitSeconds: ctx.waitSeconds,
      acceptHeld: true,
    });
    receipt.lastVerification = summarizeVerification(verification);
    saveReceipt(ctx, receipt);
    printVerification(out, verification);
    out.result({
      command: 'update',
      status: verification.status,
      changed: true,
      origin: receipt.origin,
      names,
      version: artifact.commit,
      receipt: ctx.paths.receipt,
      verification,
    });
    if (verification.status === 'held-maintenance') {
      out.line(`Deployed ${artifact.commit.slice(0, 12)} to ${names.worker}; the workspace is held in a maintenance state (draining, frozen or recovery).`);
      out.line('Run verify after reopening it (RUNBOOK.md, maintenance modes).');
      return HELD;
    }
    if (!verification.ok) {
      throw new InstallerError(`update deployed ${artifact.commit.slice(0, 12)} but verification failed (${verification.status})`, {
        hints: ['Roll forward with a fix, or follow the rollback procedure in 04-verification-and-cutover.md (OPS-03).'],
      });
    }
    out.line(`Updated ${names.worker} to ${artifact.commit.slice(0, 12)}.`);
    return 0;
  } finally {
    release();
  }
}
