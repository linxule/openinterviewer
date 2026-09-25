// update (SETUP-01, SETUP-02, SETUP-05): deploy a new checked artifact to an
// existing installation, or run one explicit key operation.
// Regenerates the installation config from the current template + receipt,
// refuses on drift, never rotates generated secrets or the epoch, and never
// deletes resources; provider keys, the Run token and the administrator
// password rotate only on an explicit operation.
//
// Operations, at most one per run:
//   (none)                      deploy the current artifact
//   --change-provider           switch AI_PROVIDER (adds its key if unbound), then deploy
//   --add-provider-key <p[,p]>  bind the named provider keys; no deploy
//   --rotate-provider-key <p>   replace one bound provider key; no deploy
//   --change-ai-transport       switch AI_TRANSPORT (--ai-transport <t>); to the
//                               Cloudflare AI Gateway: provision or adopt the
//                               gateway, bind the Run token if unbound; then deploy
//   --rotate-ai-gateway-token   replace the bound Run token (probed first); no deploy
//   --rotate-admin-password     replace ADMIN_PASSWORD; no deploy
//   --forget-provider-key <p[,p]> drop non-default providers from providerKeys
//                               once their keys are observed deleted by hand
//                               (wrangler secret delete); no upload, no deploy
// Each operation that writes remote state records a pendingChange in the
// receipt before its first remote write and clears it once its effect is
// observed, so rerunning the same update finishes it. --forget-provider-key
// writes no remote state: its one receipt write is the whole effect.

import { artifactStatus } from './artifact.mjs';
import { checkToolEnvironment, deployInstallation, ensureConfigFile, gatewayApiFor, resolveAccount, saveReceipt, wranglerFor } from './context.mjs';
import {
  GATEWAY_TOKEN_SECRET,
  GATEWAY_TRANSPORT,
  HELD,
  InstallerError,
  PASSWORD_SECRET,
  PROVIDER_KEYS,
  REFUSED,
  parseProviderList,
  requiredSecretNames,
  validateAiTransport,
  validateJurisdiction,
  validateOrigin,
  validateProvider,
} from './model.mjs';
import { CLOCK_SKEW_MS, gatewayOwnership } from './ownership.mjs';
import { assertIndependent, readProtectedInput } from './secrets.mjs';
import { acquireLock, assertNoPendingChange, buildInstallationConfig, gatewayTokenRecorded, identityDiff, installationIdentity, markPhase, readInstallationConfig, readReceipt } from './state.mjs';
import { assertNoForeignGateway, ensureGateway, gatewaySettingsPolicy, probeGateway } from './gateway.mjs';
import { printVerification, summarizeVerification } from './report.mjs';
import { verifyInstallation } from './verify.mjs';

const refuse = (message, hints = []) => new InstallerError(message, { exitCode: REFUSED, hints });
const now = () => new Date().toISOString();
const DEPLOY_MESSAGE = /^openinterviewer ([0-9a-f]{12})$/;
const OPERATIONS = ['change-provider', 'add-provider-key', 'rotate-provider-key', 'change-ai-transport', 'rotate-ai-gateway-token', 'rotate-admin-password', 'forget-provider-key'];
/** Operations that upload secrets only and never deploy (keyOperation). */
const KEY_OPERATIONS = ['add-provider-key', 'rotate-provider-key', 'rotate-ai-gateway-token', 'rotate-admin-password'];

/**
 * Researcher sessions are JWTs signed with SESSION_SECRET and carry no trace
 * of the password (src/lib/auth.ts), so a new ADMIN_PASSWORD ends none of them.
 */
export const ADMIN_PASSWORD_SESSION_NOTES = [
  'Researcher sessions signed in before this rotation stay valid until they expire (up to 7 days after sign-in): a session is signed with SESSION_SECRET, not the password, and sign-out only clears the cookie in that browser.',
  'The installer never rotates SESSION_SECRET. To end every researcher session after a leaked password, see RUNBOOK.md, administrator password.',
];

/**
 * What a transport switch means for consent (RT-11, D9; RUNBOOK, transport
 * switch). Printed before --change-ai-transport acts.
 */
export const TRANSPORT_CONSENT_NOTES = {
  [GATEWAY_TRANSPORT]: [
    'Consent (RT-11): participants who consented under direct transport are not covered by the gateway. Their next greeting or interview turn gets 409 TRANSPORT_NOT_DISCLOSED until they reopen the link and accept the Cloudflare AI Gateway notice; their saves still succeed.',
    'Interviews consented under direct are analyzed, retried, aggregated and used for follow-up only on direct: on the gateway their queued analysis finishes failed (transport-not-disclosed, no provider request) and those researcher actions are refused (409).',
    'New consents disclose Cloudflare AI Gateway (processing possibly outside the EU); approved studies may need an ethics amendment for that notice.',
    'Drain first: set the workspace to draining and wait for no pending, claimed or started jobs and no active sessions (up to the 4-hour consent lifetime), then run this, then reopen (RUNBOOK, transport switch).',
  ],
  direct: [
    'Consent (RT-11): direct transport covers every disclosure, so sessions and interviews consented under the gateway continue, sent straight to each provider. New consents show the direct notice; a consent page opened under the gateway notice gets 409 DISCLOSURE_CHANGED and is reopened.',
    'The Run token stays bound and the gateway is kept (the installer never deletes one); switching back to the gateway reuses both.',
  ],
};

/** The one operation this run performs (see the header). */
function selectOperation(options, receipt) {
  if (options['provider-keys'] !== undefined) {
    throw refuse('--provider-keys applies to a fresh apply only', ['Bind another key on an installed system with update --add-provider-key <provider>.']);
  }
  const given = OPERATIONS.filter((name) => options[name] !== undefined);
  if (given.length > 1) {
    throw refuse(`update runs one operation at a time; got ${given.map((name) => `--${name}`).join(' and ')}`);
  }
  if (options['add-provider-key'] !== undefined) {
    return { kind: 'add-provider-key', providers: parseProviderList(options['add-provider-key'], '--add-provider-key') };
  }
  if (options['rotate-provider-key'] !== undefined) {
    const providers = options['rotate-provider-key'].trim() === 'all' ? [] : parseProviderList(options['rotate-provider-key'], '--rotate-provider-key');
    if (providers.length !== 1) throw refuse('--rotate-provider-key takes exactly one provider');
    return { kind: 'rotate-provider-key', provider: providers[0] };
  }
  if (options['forget-provider-key'] !== undefined) {
    // `all` would always include the default provider, whose key stays.
    if (options['forget-provider-key'].trim() === 'all') throw refuse('--forget-provider-key takes provider names, not all');
    return { kind: 'forget-provider-key', providers: parseProviderList(options['forget-provider-key'], '--forget-provider-key') };
  }
  if (options['change-provider']) {
    if (!options.provider) throw refuse('--change-provider requires --provider <name>');
    return { kind: 'provider', provider: options.provider };
  }
  if (options['change-ai-transport']) {
    if (!options['ai-transport']) throw refuse('--change-ai-transport requires --ai-transport <direct|cloudflare-gateway>');
    return { kind: 'ai-transport', to: options['ai-transport'] };
  }
  if (options['rotate-ai-gateway-token']) return { kind: 'rotate-ai-gateway-token' };
  if (options['rotate-admin-password']) return { kind: 'rotate-admin-password' };
  return { kind: 'deploy', provider: receipt.provider };
}

function finishes(operation, options) {
  return (pending) => {
    switch (pending.kind) {
      case 'provider':
        return operation.kind === 'provider' && options.provider === pending.to;
      case 'add-provider-key':
        return operation.kind === 'add-provider-key' && operation.providers.join(',') === pending.providers.join(',');
      case 'rotate-provider-key':
        return operation.kind === 'rotate-provider-key' && operation.provider === pending.provider;
      case 'ai-transport':
        // Finishing it, or abandoning it by deploying the transport it started from.
        return operation.kind === 'ai-transport' && (operation.to === pending.to || operation.to === pending.from);
      case 'rotate-ai-gateway-token':
        return operation.kind === 'rotate-ai-gateway-token';
      case 'rotate-admin-password':
        return operation.kind === 'rotate-admin-password';
      default:
        return false;
    }
  };
}

/**
 * Read-only drift checks shared by every operation: Worker and queues as
 * recorded, every required secret bound, the installation config on the
 * receipt's side (or, while a provider or transport change is pending, on
 * either side), and, on the Cloudflare AI Gateway transport with the
 * management token, the gateway policy (never corrected here). The keys
 * --forget-provider-key is about to drop (`forgetting`) may be missing.
 * Returns the bound secret names.
 */
async function checkDrift(ctx, receipt, wrangler, account, pending, { gatewayApi, checkGateway, forgetting = [] }) {
  const { names } = receipt;
  ctx.out.step(`Checking ${names.worker} for drift`);
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
  for (const name of requiredSecretNames(receipt.providerKeys, receipt.aiTransport)) {
    if (!bound?.has(name) && !forgetting.includes(name)) drift.push(`secret ${name}: missing on ${names.worker}`);
  }
  if (onDisk) {
    // An interrupted provider or transport change may have left the config on either side.
    const providers = [receipt.provider, ...(pending?.kind === 'provider' ? [pending.to] : [])];
    const transports = [receipt.aiTransport, ...(pending?.kind === 'ai-transport' && receipt.aiGateway ? [pending.to] : [])];
    const sides = providers.flatMap((provider) => transports.map((aiTransport) => ({ provider, aiTransport }))).map((side) => {
      const expected = buildInstallationConfig(ctx.template, receipt, { bootstrap: '', ...side });
      const vars = Object.keys(expected.vars).filter((name) => Object.hasOwn(onDisk.vars ?? {}, name));
      const pick = (identity) => ({ ...identity, vars: Object.fromEntries(vars.map((name) => [name, identity.vars[name]])) });
      return identityDiff(pick(installationIdentity(expected)), pick(installationIdentity(onDisk)));
    });
    if (!sides.some((diffs) => diffs.length === 0)) {
      for (const diff of sides[0]) drift.push(`installation config ${diff}`);
    }
  }
  if (checkGateway) {
    const id = receipt.aiGateway.id;
    if (gatewayApi) {
      const gateway = await gatewayApi.getGateway(id);
      if (!gateway) drift.push(`AI Gateway ${id}: recorded in the receipt, missing in the account (never recreated by update)`);
      else {
        const verdict = gatewayOwnership(gateway, receipt.aiGateway);
        if (!verdict.owned) drift.push(`AI Gateway ${id}: ${verdict.reason}`);
        const policy = gatewaySettingsPolicy(gateway, { id });
        for (const refusal of policy.refusals) drift.push(`AI Gateway ${id}: ${refusal}`);
        for (const warning of policy.warnings) ctx.out.line(`Warning: AI Gateway ${id}: ${warning}.`);
      }
    } else {
      ctx.out.line(`Note: the settings of AI Gateway ${id} were not checked: CF_AI_GATEWAY_ADMIN_TOKEN (AI Gateway Read) is not set for this run.`);
    }
  }
  if (drift.length > 0) {
    // A non-default key deleted on purpose is recorded with --forget-provider-key (together with any being forgotten now).
    const forget = Object.keys(PROVIDER_KEYS).filter((provider) => forgetting.includes(PROVIDER_KEYS[provider])
      || (receipt.providerKeys.includes(provider) && provider !== receipt.provider && !bound?.has(PROVIDER_KEYS[provider])));
    const deleted = forget.some((provider) => !forgetting.includes(PROVIDER_KEYS[provider]));
    throw refuse(`drift detected; nothing was changed:\n  - ${drift.join('\n  - ')}`, [
      'Restore the recorded state (or the receipt) deliberately, then rerun update.',
      ...(deleted ? [`If a provider key was deleted on purpose (wrangler secret delete), record that with update --forget-provider-key ${forget.join(',')} --yes.`] : []),
    ]);
  }
  // A provider key bound outside the installer's records is reported, never
  // adopted or removed: the receipt cannot vouch for its value.
  const expectedKeys = new Set([
    ...receipt.providerKeys,
    ...(pending?.kind === 'provider' ? [pending.to] : []),
    ...(pending?.kind === 'add-provider-key' ? pending.providers : []),
  ].map((provider) => PROVIDER_KEYS[provider]));
  const unrecorded = Object.values(PROVIDER_KEYS).filter((name) => bound?.has(name) && !expectedKeys.has(name));
  if (unrecorded.length > 0) {
    ctx.out.line(`Warning: ${unrecorded.join(', ')} ${unrecorded.length === 1 ? 'is' : 'are'} bound to ${names.worker} but not recorded in the receipt's providerKeys; the installer neither uses nor changes ${unrecorded.length === 1 ? 'it' : 'them'}.`);
  }
  if (bound?.has(GATEWAY_TOKEN_SECRET) && !gatewayTokenRecorded(receipt)) {
    ctx.out.line(`Warning: ${GATEWAY_TOKEN_SECRET} is bound to ${names.worker} but this installer never set or probed it (no receipt record); the installer neither uses nor changes it, and refuses to switch to the Cloudflare AI Gateway while it is bound.`);
  }
  return bound;
}

/**
 * A secret upload deploys a new Worker version built from the latest one
 * (gw-final §11 item 12, UNVERIFIED on Cloudflare). Before a secret-only
 * operation the newest deployment must be a checked release or one this
 * installer observed: it carries deploy.mjs's `openinterviewer <commit>`
 * message (an installer update or the CI promotion, which both deploy a
 * checked artifact through deploy.mjs), or it is the deployment recorded
 * after the previous key operation, or,
 * while finishing a pending key operation, a deployment without a deploy
 * message made since that operation started (its own upload, whose reply was
 * lost). It must also serve a single version. Returns the newest
 * deployment's id.
 */
async function assertLatestDeploymentRecorded(receipt, wrangler, pending) {
  const deployments = await wrangler.deployments(receipt.names.worker);
  const latest = Array.isArray(deployments) ? deployments.at(-1) : null;
  const lastDeploy = receipt.deployments.at(-1);
  const hints = [
    'A secret upload deploys a new version from the Worker\'s latest version, so the installer refuses while that version was not deployed from a checked artifact (a dashboard deploy, wrangler rollback or gradual deployment).',
    'Redeploy a checked release first (update without a key operation, or the CI promotion on an installation that CI deploys), then retry.',
  ];
  if (!latest || !lastDeploy) throw refuse(`${receipt.names.worker} lists no deployment this installer recorded`, hints);
  const versions = Array.isArray(latest.versions) ? latest.versions : [];
  if (versions.length !== 1 || versions[0]?.percentage !== 100) {
    throw refuse(`the newest deployment of ${receipt.names.worker} does not serve a single version at 100%`, hints);
  }
  const message = DEPLOY_MESSAGE.exec(latest.annotations?.['workers/message'] ?? '');
  // A forget event records no deployment of its own (the delete was manual).
  const lastEvent = receipt.secretEvents.findLast((event) => event.kind !== 'forget-provider-key');
  const byMessage = Boolean(message);
  const byEvent = Boolean(lastEvent?.deploymentId) && lastEvent.deploymentId === latest.id && lastEvent.at >= lastDeploy.at;
  const created = Date.parse(latest.created_on ?? '');
  const byPending = Boolean(pending) && pending.kind !== 'provider'
    && latest.id !== pending.deploymentBefore
    && latest.annotations?.['workers/message'] === undefined
    && Number.isFinite(created) && created >= Date.parse(pending.startedAt) - CLOCK_SKEW_MS;
  if (!byMessage && !byEvent && !byPending) {
    throw refuse(`the newest deployment of ${receipt.names.worker} (${latest.id}, ${latest.created_on ?? 'unknown time'}) is neither a deploy.mjs release nor one this installer recorded`, hints);
  }
  return latest.id ?? null;
}

async function newestDeploymentId(receipt, wrangler) {
  const deployments = await wrangler.deployments(receipt.names.worker);
  return Array.isArray(deployments) ? deployments.at(-1)?.id ?? null : null;
}

async function finishWithVerification(ctx, receipt, { operation, version, onHeldLines, failure, onFailureHints, doneLine, gatewayApi = null }) {
  // Held is accepted as a settled outcome: the RUNBOOK drains the
  // workspace before a deploy, so a held workspace is expected here.
  const verification = await verifyInstallation({
    template: ctx.template,
    receipt,
    configPath: ctx.paths.config,
    waitSeconds: ctx.waitSeconds,
    acceptHeld: true,
    gatewayApi,
  });
  receipt.lastVerification = summarizeVerification(verification);
  saveReceipt(ctx, receipt);
  printVerification(ctx.out, verification);
  ctx.out.result({
    command: 'update',
    operation,
    status: verification.status,
    changed: true,
    origin: receipt.origin,
    names: receipt.names,
    version,
    providerKeys: receipt.providerKeys,
    aiTransport: receipt.aiTransport,
    receipt: ctx.paths.receipt,
    verification,
  });
  if (verification.status === 'held-maintenance') {
    for (const line of onHeldLines) ctx.out.line(line);
    return HELD;
  }
  if (!verification.ok) {
    throw new InstallerError(`${failure} but verification failed (${verification.status})`, { hints: onFailureHints });
  }
  ctx.out.line(doneLine);
  return 0;
}

/**
 * --add-provider-key / --rotate-provider-key / --rotate-ai-gateway-token /
 * --rotate-admin-password: one secret upload, no deploy. A new Run token is
 * probed against the gateway before anything is recorded or uploaded; a new
 * password passes the same validation as apply's.
 */
async function keyOperation(ctx, receipt, wrangler, bound, operation, pending, { gatewayApi = null } = {}) {
  const { names } = receipt;
  const token = operation.kind === 'rotate-ai-gateway-token';
  const password = operation.kind === 'rotate-admin-password';
  const providers = token || password ? [] : operation.kind === 'add-provider-key' ? operation.providers : [operation.provider];
  const keyNames = token ? [GATEWAY_TOKEN_SECRET] : password ? [PASSWORD_SECRET] : providers.map((provider) => PROVIDER_KEYS[provider]);
  const label = token ? 'the AI Gateway Run token' : password ? 'the administrator password (ADMIN_PASSWORD)' : keyNames.join(', ');
  let upload;
  if (operation.kind === 'add-provider-key') {
    if (!pending) {
      const taken = keyNames.filter((name) => bound.has(name));
      if (taken.length > 0) {
        throw refuse(`${taken.join(', ')} ${taken.length === 1 ? 'is' : 'are'} already bound to ${names.worker} without an installer record; refusing to overwrite`, [
          'Inspect with wrangler secret list. Delete it deliberately (wrangler secret delete) and add it again, so the receipt vouches for its value.',
        ]);
      }
    }
    // Finishing a pending add: a key whose upload landed is not requested again.
    upload = keyNames.filter((name) => !bound.has(name));
  } else {
    if (token && !bound.has(GATEWAY_TOKEN_SECRET)) {
      throw refuse(`${GATEWAY_TOKEN_SECRET} is not bound to ${names.worker}; there is no Run token to rotate`, [
        'Bind one by switching to the gateway: update --change-ai-transport --ai-transport cloudflare-gateway.',
      ]);
    }
    upload = keyNames;
  }

  // Nothing to upload (a pending add whose upload landed) needs no version check.
  const deploymentBefore = upload.length > 0
    ? await assertLatestDeploymentRecorded(receipt, wrangler, pending)
    : pending?.deploymentBefore ?? null;
  let supplied = {};
  if (upload.length > 0) {
    ctx.out.step(`${operation.kind === 'add-provider-key' ? 'Adding' : 'Rotating'} ${upload.join(', ')} on ${names.worker} (no other secret changes, no deploy)`);
    supplied = await readProtectedInput(upload, { fromStdin: Boolean(ctx.options['secrets-stdin']) });
    for (const value of Object.values(supplied)) ctx.registry.add(value);
    assertIndependent(supplied);
  }
  if (token) {
    const probe = await probeGateway({ accountId: receipt.accountId, gatewayId: receipt.aiGateway.id, runToken: supplied[GATEWAY_TOKEN_SECRET] });
    for (const check of probe.checks) ctx.out.line(`  ${check.ok ? '✓' : '✗'} ${check.id.padEnd(30)} ${check.detail}`);
    if (!probe.ok) {
      throw refuse(`the new Run token was not accepted by AI Gateway ${receipt.aiGateway.id} as the probe expects; nothing was uploaded`, [
        'Create the token with AI Gateway Run on this account (dashboard: AI Gateway → the gateway → Create authentication token), then retry.',
      ]);
    }
  }
  if (!pending) {
    if (operation.kind === 'add-provider-key') receipt.pendingChange = { kind: 'add-provider-key', providers, startedAt: now(), deploymentBefore };
    else if (token) receipt.pendingChange = { kind: 'rotate-ai-gateway-token', startedAt: now(), deploymentBefore };
    else if (password) receipt.pendingChange = { kind: 'rotate-admin-password', startedAt: now(), deploymentBefore };
    else receipt.pendingChange = { kind: 'rotate-provider-key', provider: operation.provider, startedAt: now(), deploymentBefore };
    saveReceipt(ctx, receipt);
  }
  const retryHint = operation.kind === 'add-provider-key'
    ? `The key operation is recorded as pending in the receipt; rerun update --add-provider-key ${providers.join(',')} to finish it.`
    : token
      ? 'The rotation is recorded as pending in the receipt; rerun update --rotate-ai-gateway-token with the new token to finish it.'
      : password
        ? 'The rotation is recorded as pending in the receipt; rerun update --rotate-admin-password with the new password to finish it.'
        : `The rotation is recorded as pending in the receipt; rerun update --rotate-provider-key ${operation.provider} with the new key to finish it.`;
  try {
    if (upload.length > 0) {
      await wrangler.putSecrets(names.worker, ctx.paths.config, supplied);
      const after = await wrangler.secretNames(names.worker, ctx.paths.config);
      const missing = keyNames.filter((name) => !after?.has(name));
      if (missing.length > 0) throw new InstallerError(`${missing.join(', ')} not observed after upload`);
    }
  } catch (error) {
    if (error instanceof InstallerError) error.hints = [...error.hints, retryHint];
    throw error;
  }
  const deploymentAfter = await newestDeploymentId(receipt, wrangler);
  if (operation.kind === 'add-provider-key') {
    receipt.providerKeys = Object.keys(PROVIDER_KEYS).filter((provider) => receipt.providerKeys.includes(provider) || providers.includes(provider));
  }
  if (token) receipt.aiGateway.probedAt = now();
  receipt.secretEvents.push({
    kind: operation.kind,
    names: keyNames,
    uploaded: upload,
    at: now(),
    deploymentId: deploymentAfter && deploymentAfter !== (pending?.deploymentBefore ?? deploymentBefore) ? deploymentAfter : null,
  });
  delete receipt.pendingChange;
  saveReceipt(ctx, receipt);

  const version = receipt.deployments.at(-1)?.commit ?? null;
  const verb = operation.kind === 'add-provider-key' ? 'Added' : 'Rotated';
  if (password) for (const line of ADMIN_PASSWORD_SESSION_NOTES) ctx.out.line(line);
  return finishWithVerification(ctx, receipt, {
    operation: operation.kind,
    version,
    gatewayApi,
    onHeldLines: [
      `${verb} ${label} on ${names.worker}; the workspace is held in a maintenance state (draining, frozen or recovery).`,
      'Run verify after reopening it (RUNBOOK.md, maintenance modes).',
    ],
    failure: `update ${verb.toLowerCase()} ${label}`,
    onFailureHints: [`${token ? 'The token' : password ? 'The password' : 'The key'} is bound; check the readiness errors above (for example a placeholder value) and rotate it if needed.`],
    doneLine: token
      ? `Rotated the AI Gateway Run token on ${names.worker}. No redeploy or config regeneration is needed.`
      : password
        ? `Rotated ADMIN_PASSWORD on ${names.worker}; sign in with the new password (the operator CLI too). No redeploy or config regeneration is needed.`
        : `${verb} ${keyNames.join(', ')} on ${names.worker}; provider keys: ${receipt.providerKeys.join(', ')}. No redeploy or config regeneration is needed.`,
  });
}

/**
 * --forget-provider-key <p[,p]>: after the operator deleted the keys by hand
 * (`wrangler secret delete`), drop the providers from providerKeys once every
 * name is observed gone. The installer never deletes a secret itself; while
 * any of them is bound nothing changes. No upload, no deploy, no
 * pendingChange: the one atomic receipt write (providerKeys and the event
 * together) is the whole effect, so an interrupted run leaves nothing half done.
 */
async function forgetOperation(ctx, receipt, bound, operation, { gatewayApi = null } = {}) {
  const { names } = receipt;
  const { providers } = operation;
  const keyNames = providers.map((provider) => PROVIDER_KEYS[provider]);
  const stillBound = keyNames.filter((name) => bound.has(name));
  if (stillBound.length > 0) {
    throw refuse(`${stillBound.join(', ')} ${stillBound.length === 1 ? 'is' : 'are'} still bound to ${names.worker}; the installer never deletes a secret, so nothing was changed`, [
      'Delete deliberately first:',
      ...stillBound.map((name) => `  wrangler secret delete ${name} --name ${names.worker}`),
      `Then rerun update --forget-provider-key ${providers.join(',')} --yes.`,
    ]);
  }
  ctx.out.step(`Forgetting ${keyNames.join(', ')}: observed deleted from ${names.worker} (no secret changes, no deploy)`);
  receipt.providerKeys = receipt.providerKeys.filter((entry) => !providers.includes(entry));
  receipt.secretEvents.push({ kind: operation.kind, names: keyNames, uploaded: [], at: now(), deploymentId: null });
  saveReceipt(ctx, receipt);

  const version = receipt.deployments.at(-1)?.commit ?? null;
  return finishWithVerification(ctx, receipt, {
    operation: operation.kind,
    version,
    gatewayApi,
    onHeldLines: [
      `Forgot ${keyNames.join(', ')} on ${names.worker}; the workspace is held in a maintenance state (draining, frozen or recovery).`,
      'Run verify after reopening it (RUNBOOK.md, maintenance modes).',
    ],
    failure: `update forgot ${keyNames.join(', ')}`,
    onFailureHints: ['The receipt no longer records the key; check the readiness errors above.'],
    doneLine: `Forgot ${keyNames.join(', ')} on ${names.worker}; provider keys: ${receipt.providerKeys.join(', ')}. If the manual delete deployed a new Worker version (as a secret put does), the next key operation refuses until a plain update redeploys a checked release.`,
  });
}

/**
 * --change-ai-transport --ai-transport <t>: resumable through a pendingChange
 * of kind `ai-transport`, recorded before the first remote write. To the
 * gateway: ensure the installation's gateway (create or adopt on evidence,
 * policy, probes), upload the Run token only when it is not bound, deploy
 * with the gateway vars and mark the ai-gateway phase. To direct: deploy with
 * both gateway vars empty; the token and the gateway are kept.
 * Rerunning with the pending change's origin transport abandons it.
 */
async function transportOperation(ctx, receipt, wrangler, bound, operation, pending, { gatewayApi, artifact }) {
  const { names } = receipt;
  const to = operation.to;
  const from = receipt.aiTransport;
  for (const line of TRANSPORT_CONSENT_NOTES[to]) ctx.out.line(line);
  let supplied = null;
  if (to === GATEWAY_TRANSPORT) {
    // Read-only: an unrelated gateway is refused before anything is recorded.
    await assertNoForeignGateway({ api: gatewayApi, names, accountId: receipt.accountId, record: receipt.aiGateway ?? null });
    if (!bound.has(GATEWAY_TOKEN_SECRET)) {
      ctx.out.step(`Adding ${GATEWAY_TOKEN_SECRET} for the Cloudflare AI Gateway transport (no other secret changes)`);
      supplied = await readProtectedInput([GATEWAY_TOKEN_SECRET], { fromStdin: Boolean(ctx.options['secrets-stdin']) });
      for (const value of Object.values(supplied)) ctx.registry.add(value);
    } else if (!gatewayTokenRecorded(receipt)) {
      // The same provenance rule as --add-provider-key: after this switch the
      // Worker sends the bound value, so it must be one the installer vouches for.
      throw refuse(`${GATEWAY_TOKEN_SECRET} is already bound to ${names.worker} without an installer record (never set or probed by this installer); refusing to switch the Worker to a Run token nobody checked`, [
        `Inspect with wrangler secret list --name ${names.worker}. Delete it deliberately (wrangler secret delete ${GATEWAY_TOKEN_SECRET} --name ${names.worker}),`,
        'then rerun this switch with the Run token on protected input: it is probed before it is uploaded.',
      ]);
    } else {
      ctx.out.line(`Note: ${GATEWAY_TOKEN_SECRET} is already bound and is kept; its value cannot be read, so only the unauthenticated probe runs (rotate it with --rotate-ai-gateway-token to probe a new one).`);
      if (pending?.tokenUploadAt && !receipt.secretEvents.some((event) => event.kind === 'ai-transport' && event.at >= pending.startedAt)) {
        // The interrupted run's upload landed although its reply was lost: record when it was bound.
        receipt.secretEvents.push({ kind: 'ai-transport', names: [GATEWAY_TOKEN_SECRET], uploaded: [], attemptedAt: pending.tokenUploadAt, at: now(), deploymentId: null });
        saveReceipt(ctx, receipt);
      }
    }
  }
  if (!pending) {
    receipt.pendingChange = { kind: 'ai-transport', from, to, startedAt: now() };
    saveReceipt(ctx, receipt);
  }
  try {
    if (to === GATEWAY_TRANSPORT) {
      await ensureGateway({
        receipt,
        api: gatewayApi,
        runToken: supplied?.[GATEWAY_TOKEN_SECRET] ?? null,
        save: () => saveReceipt(ctx, receipt),
        out: ctx.out,
      });
      if (supplied) {
        receipt.pendingChange.tokenUploadAt = now();
        saveReceipt(ctx, receipt);
        await wrangler.putSecrets(names.worker, ctx.paths.config, supplied);
        const after = await wrangler.secretNames(names.worker, ctx.paths.config);
        if (!after?.has(GATEWAY_TOKEN_SECRET)) throw new InstallerError(`${GATEWAY_TOKEN_SECRET} not observed after upload`);
        receipt.secretEvents.push({ kind: 'ai-transport', names: [GATEWAY_TOKEN_SECRET], uploaded: [GATEWAY_TOKEN_SECRET], at: now(), deploymentId: null });
        saveReceipt(ctx, receipt);
      }
    }
    await deployInstallation(ctx, receipt, { purpose: 'update', artifact, aiTransport: to });
  } catch (error) {
    if (error instanceof InstallerError) {
      error.hints = [...error.hints, `The AI transport change to ${to} is recorded as pending in the receipt; rerun update --change-ai-transport --ai-transport ${to} to finish it.`];
    }
    throw error;
  }
  if (to === GATEWAY_TRANSPORT) markPhase(receipt, 'ai-gateway');
  if (to !== from) receipt.aiTransportHistory = [...(receipt.aiTransportHistory ?? []), { from, to, at: now() }];
  receipt.aiTransport = to;
  delete receipt.pendingChange;
  saveReceipt(ctx, receipt);

  return finishWithVerification(ctx, receipt, {
    operation: 'change-ai-transport',
    version: artifact.commit,
    gatewayApi,
    onHeldLines: [
      `Deployed ${artifact.commit.slice(0, 12)} to ${names.worker} with AI_TRANSPORT=${to}; the workspace is held in a maintenance state (draining, frozen or recovery).`,
      'Reopen it when ready (RUNBOOK.md, transport switch), then run verify.',
    ],
    failure: `update switched ${names.worker} to ${to}`,
    onFailureHints: ['Check the readiness errors above. Switching back to direct is always covered by consent.'],
    doneLine: `Switched ${names.worker} to AI_TRANSPORT=${to}. Regenerate CLOUDFLARE_INSTALL_CONFIG with config if CI deploys this installation.`,
  });
}

export async function updateCommand(ctx) {
  const { options } = ctx;
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
  if (options['ai-transport'] !== undefined) validateAiTransport(options['ai-transport']);
  const operation = selectOperation(options, receipt);
  const pending = assertNoPendingChange(receipt, { finishes: finishes(operation, options) });

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
    if (operation.kind === 'provider') provider = options.provider;
    else requested.push(`provider: installed ${receipt.provider}, requested ${options.provider}. Pass --change-provider to switch AI_PROVIDER (no other secret changes).`);
  }
  if (operation.kind === 'add-provider-key' && !pending) {
    const recorded = operation.providers.filter((entry) => receipt.providerKeys.includes(entry));
    if (recorded.length > 0) {
      requested.push(`provider keys: ${recorded.join(', ')} ${recorded.length === 1 ? 'is' : 'are'} already recorded (${receipt.providerKeys.join(', ')}). Replace a bound key with --rotate-provider-key.`);
    }
  }
  if (operation.kind === 'rotate-provider-key' && !receipt.providerKeys.includes(operation.provider)) {
    requested.push(`provider keys: ${operation.provider} is not recorded (${receipt.providerKeys.join(', ')}). Bind it with --add-provider-key.`);
  }
  if (operation.kind === 'forget-provider-key') {
    for (const forget of operation.providers.filter((entry) => !receipt.providerKeys.includes(entry))) {
      const forgotten = receipt.secretEvents.findLast((event) => event.kind === 'forget-provider-key' && event.names?.includes(PROVIDER_KEYS[forget]));
      requested.push(`provider keys: ${forget} is not recorded (${receipt.providerKeys.join(', ')}); ${forgotten ? `it was forgotten at ${forgotten.at}, nothing to do` : 'there is nothing to forget'}.`);
    }
    if (receipt.providerKeys.every((entry) => operation.providers.includes(entry))) {
      requested.push(`provider keys: forgetting ${operation.providers.join(', ')} would leave no provider key; an installation always keeps its default provider's key.`);
    } else if (operation.providers.includes(receipt.provider)) {
      requested.push(`provider keys: ${receipt.provider} is the default provider (AI_PROVIDER). Switch the default first with --provider <other> --change-provider (a deploy), then forget ${receipt.provider}.`);
    }
  }
  if (options['ai-transport'] && options['ai-transport'] !== receipt.aiTransport && operation.kind !== 'ai-transport') {
    requested.push(`AI transport: installed ${receipt.aiTransport}, requested ${options['ai-transport']}. Pass --change-ai-transport to switch it.`);
  }
  if (operation.kind === 'ai-transport' && !pending && operation.to === receipt.aiTransport) {
    requested.push(`AI transport: the installation already uses ${receipt.aiTransport}.`);
  }
  if (operation.kind === 'rotate-ai-gateway-token' && !receipt.aiGateway?.observedAt) {
    requested.push('AI Gateway Run token: this installation has no AI Gateway recorded. Switch to it with --change-ai-transport --ai-transport cloudflare-gateway.');
  }
  if (requested.length > 0) throw refuse(`update refused:\n  - ${requested.join('\n  - ')}`);

  // The management token stays in this process (never forwarded or written).
  // It is required to provision the gateway and used, when present, to check it.
  const toGateway = operation.kind === 'ai-transport' && operation.to === GATEWAY_TRANSPORT;
  const gatewayApi = toGateway || receipt.aiTransport === GATEWAY_TRANSPORT
    ? gatewayApiFor(ctx, receipt.accountId, { requiredFor: toGateway ? 'switching to the Cloudflare AI Gateway transport' : null })
    : null;
  const checkGateway = receipt.aiTransport === GATEWAY_TRANSPORT && operation.kind !== 'ai-transport';

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
    const forgetting = operation.kind === 'forget-provider-key' ? operation.providers.map((entry) => PROVIDER_KEYS[entry]) : [];
    const bound = await checkDrift(ctx, receipt, wrangler, account, pending, { gatewayApi, checkGateway, forgetting });

    if (operation.kind === 'forget-provider-key') {
      return await forgetOperation(ctx, receipt, bound, operation, { gatewayApi });
    }
    if (KEY_OPERATIONS.includes(operation.kind)) {
      return await keyOperation(ctx, receipt, wrangler, bound, operation, pending, { gatewayApi });
    }

    const artifact = await artifactStatus({ root: ctx.root, artifactDir: ctx.artifactDir, git: ctx.gitPath });
    if (!artifact.ready) {
      throw refuse('the release artifact is not ready for deployment', [
        ...artifact.problems,
        'Build and check it for the current clean commit, then rerun update.',
      ]);
    }

    if (operation.kind === 'ai-transport') {
      return await transportOperation(ctx, receipt, wrangler, bound, operation, pending, { gatewayApi, artifact });
    }

    // The key is read and validated before anything is recorded or uploaded.
    const newKey = provider !== receipt.provider ? PROVIDER_KEYS[provider] : null;
    let supplied = null;
    if (newKey && !bound.has(newKey)) {
      ctx.out.step(`Adding ${newKey} for provider ${provider} (no other secret changes)`);
      supplied = await readProtectedInput([newKey], { fromStdin: Boolean(options['secrets-stdin']) });
      for (const value of Object.values(supplied)) ctx.registry.add(value);
    }
    if (newKey && !pending) {
      receipt.pendingChange = { kind: 'provider', from: receipt.provider, to: provider, startedAt: now() };
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
      receipt.providerHistory = [...(receipt.providerHistory ?? []), { from: receipt.provider, to: provider, at: now() }];
      receipt.provider = provider;
      if (!receipt.providerKeys.includes(provider)) {
        receipt.providerKeys = Object.keys(PROVIDER_KEYS).filter((entry) => receipt.providerKeys.includes(entry) || entry === provider);
      }
      delete receipt.pendingChange;
      saveReceipt(ctx, receipt);
    }

    return await finishWithVerification(ctx, receipt, {
      operation: newKey ? 'change-provider' : 'deploy',
      version: artifact.commit,
      gatewayApi,
      onHeldLines: [
        `Deployed ${artifact.commit.slice(0, 12)} to ${names.worker}; the workspace is held in a maintenance state (draining, frozen or recovery).`,
        'Run verify after reopening it (RUNBOOK.md, maintenance modes).',
      ],
      failure: `update deployed ${artifact.commit.slice(0, 12)}`,
      onFailureHints: ['Roll forward with a fix, or follow the rollback procedure in 04-verification-and-cutover.md (OPS-03).'],
      doneLine: `Updated ${names.worker} to ${artifact.commit.slice(0, 12)}.`,
    });
  } finally {
    release();
  }
}
