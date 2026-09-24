// apply / resume (SETUP-01, SETUP-02, SETUP-03). Every phase is recorded in
// the receipt only after its effect is observed, and each phase is safe to
// replay: resume continues from the first incomplete phase using the receipt
// plus observed remote state. Nothing is ever deleted.

import { artifactStatus } from './artifact.mjs';
import {
  assertOriginUnique,
  assertOwnWorkersDevOrigin,
  checkToolEnvironment,
  deployInstallation,
  ensureConfigFile,
  gatewayApiFor,
  resolveAccount,
  saveReceipt,
  wranglerFor,
  writeConfig,
} from './context.mjs';
import {
  GATEWAY_TOKEN_SECRET,
  GATEWAY_TRANSPORT,
  InstallerError,
  REFUSED,
  deriveNames,
  isOwnWorkersDevHost,
  isWorkersDevOrigin,
  parseProviderList,
  requiredSecretNames,
  validateAiTransport,
  validateJurisdiction,
  validateOrigin,
  validateProvider,
  validateProviderKeys,
} from './model.mjs';
import {
  assertIndependent,
  composeSecretSet,
  epochFingerprint,
  generateEpoch,
  generateWorkspaceId,
  readProtectedInput,
  resolveOperatorTokenFile,
  suppliedSecretNames,
  writeOperatorTokenFile,
} from './secrets.mjs';
import { dropAttempt, queueOwnership, recordAttempt, workerOwnership } from './ownership.mjs';
import { acquireLock, assertNoPendingChange, firstIncompletePhase, markPhase, newReceipt, phaseDone, readReceipt } from './state.mjs';
import { ensureGateway, runGatewayProbe } from './gateway.mjs';
import { ownWorkerUrl, pollDeployment, verifyInstallation } from './verify.mjs';
import { printVerification, summarizeVerification } from './report.mjs';

const refuse = (message, hints = []) => new InstallerError(message, { exitCode: REFUSED, hints });
const now = () => new Date().toISOString();

const UPDATE_ONLY_OPTIONS = ['change-provider', 'add-provider-key', 'rotate-provider-key', 'change-ai-transport', 'rotate-ai-gateway-token'];

/**
 * The provider keys to bind: the receipt's on resume, otherwise
 * --provider-keys (default: the --provider key alone). Validated before any
 * remote write.
 */
function requestedProviderKeys(options, receipt) {
  if (receipt) return receipt.providerKeys;
  if (options['provider-keys'] === undefined) return [options.provider];
  return validateProviderKeys(parseProviderList(options['provider-keys'], '--provider-keys'), options.provider);
}

function checkArguments(ctx, receipt) {
  const { options } = ctx;
  for (const name of UPDATE_ONLY_OPTIONS) {
    if (options[name] !== undefined) throw refuse(`--${name} is an update option; apply and resume never change provider keys, the provider or the AI transport`);
  }
  if (options.provider !== undefined) validateProvider(options.provider);
  if (options['ai-transport'] !== undefined) validateAiTransport(options['ai-transport']);
  if (options.jurisdiction !== undefined) validateJurisdiction(options.jurisdiction);
  const origin = options.origin !== undefined ? validateOrigin(options.origin) : null;
  if (!receipt) {
    if (ctx.command === 'resume') {
      throw refuse(`no receipt at ${ctx.paths.receipt}: there is nothing to resume`, ['Start a fresh installation with apply.']);
    }
    if (!options.provider) throw refuse('a fresh installation needs --provider <gemini|claude|openai|openrouter>');
    requestedProviderKeys(options, null);
    if (!options.jurisdiction) {
      throw refuse('a fresh installation needs an explicit --jurisdiction <eu|fedramp|none> (recommended: eu)', [
        'The jurisdiction fixes where the Durable Object stores data and cannot be changed by update.',
      ]);
    }
    return origin;
  }
  assertNoPendingChange(receipt);
  if (options['provider-keys'] !== undefined) {
    const given = parseProviderList(options['provider-keys'], '--provider-keys');
    if (given.join(',') !== receipt.providerKeys.join(',')) {
      throw refuse(`--provider-keys ${given.join(',')} differs from the installation's provider keys ${receipt.providerKeys.join(',')}`, [
        'Add a key to a completed installation with update --add-provider-key <provider>.',
      ]);
    }
  }
  if (options['ai-transport'] && options['ai-transport'] !== receipt.aiTransport) {
    throw refuse(`--ai-transport ${options['ai-transport']} differs from the installation's AI transport ${receipt.aiTransport}`, [
      'Change the transport of a completed installation with update --change-ai-transport --ai-transport <direct|cloudflare-gateway>.',
    ]);
  }
  if (options.provider && options.provider !== receipt.provider) {
    throw refuse(`--provider ${options.provider} differs from the installed provider ${receipt.provider}`, [
      'Switch providers on a completed installation with update --change-provider.',
    ]);
  }
  if (options.jurisdiction && options.jurisdiction !== receipt.jurisdiction) {
    throw refuse(`--jurisdiction ${options.jurisdiction} differs from the installed jurisdiction ${receipt.jurisdiction}; changing it is a data migration`);
  }
  if (options['import-target'] && receipt.bootstrap !== 'recovery') {
    throw refuse('--import-target can only be chosen when the installation is first applied');
  }
  if (origin && origin !== receipt.origin && receipt.phases.origin) {
    throw refuse(`the origin is fixed at ${receipt.origin}; changing it is a separate operation, not a resume`);
  }
  return origin;
}

async function collectSecretInput(ctx, receipt, providerKeys, aiTransport) {
  const { options } = ctx;
  const tokenFile = options['operator-token-file']
    ? resolveOperatorTokenFile(options['operator-token-file'], {
      root: ctx.root,
      stateDir: ctx.stateDir,
      // Only a file this installation actually wrote may be rewritten.
      previousFile: receipt?.operatorToken?.writtenAt ? receipt.operatorToken.file : null,
    })
    : null;
  if (options['reveal-operator-token'] && (!process.stdout.isTTY || options.json)) {
    throw refuse('--reveal-operator-token prints the token only to an interactive terminal (and not with --json)', [
      'Use --operator-token-file <path outside the repository> instead.',
    ]);
  }
  if (!tokenFile && !options['reveal-operator-token']) {
    throw refuse('choose where the generated OPERATOR_TOKEN goes before anything is created', [
      '--operator-token-file <path outside the repository> writes it once with mode 0600,',
      'or --reveal-operator-token prints it once to an interactive terminal.',
    ]);
  }
  const supplied = await readProtectedInput(suppliedSecretNames(providerKeys, aiTransport), { fromStdin: Boolean(options['secrets-stdin']) });
  for (const value of Object.values(supplied)) ctx.registry.add(value);
  assertIndependent(supplied);
  return { supplied, tokenFile };
}

export async function applyCommand(ctx) {
  const { options, out } = ctx;
  let receipt = readReceipt(ctx.paths.receipt);
  const fresh = !receipt;
  const explicitOrigin = checkArguments(ctx, receipt);
  if (!options.yes) throw refuse('--yes is required to confirm the reviewed plan (run plan first)');

  if (receipt && !firstIncompletePhase(receipt)) {
    out.line(`Installation ${ctx.install} (${ctx.environment}) is complete; nothing to do.`);
    out.line(`Run verify to re-check ${receipt.origin}, or update to deploy a new release.`);
    out.result({ command: ctx.command, status: 'complete', changed: false, receipt: ctx.paths.receipt });
    return 0;
  }

  const release = acquireLock(ctx.paths.lock);
  try {
    return await runPhases(ctx, { receipt, fresh, explicitOrigin });
  } finally {
    release();
  }
}

async function runPhases(ctx, { receipt: initialReceipt, fresh, explicitOrigin }) {
  const { options, out, registry } = ctx;
  let receipt = initialReceipt;
  const wrangler = wranglerFor(ctx);
  const pending = (phase) => !phaseDone(receipt, phase);

  // ---------- preflight ----------
  out.step(`Preflight for ${ctx.install} (${ctx.environment})`);
  checkToolEnvironment(ctx);
  const account = resolveAccount(await wrangler.whoami(), {
    requested: options['account-id'],
    receiptAccount: receipt?.accountId,
    envAccount: process.env.CLOUDFLARE_ACCOUNT_ID,
  });
  wrangler.useAccount(account.id);
  const names = receipt?.names ?? deriveNames(ctx.install, ctx.environment);
  const provider = receipt?.provider ?? options.provider;
  const providerKeys = requestedProviderKeys(options, receipt);
  const aiTransport = receipt?.aiTransport ?? options['ai-transport'] ?? 'direct';
  const gatewayTransport = aiTransport === GATEWAY_TRANSPORT;
  assertOwnWorkersDevOrigin(explicitOrigin, names.worker);
  assertOriginUnique(ctx, explicitOrigin ?? receipt?.origin);
  // The management token is needed while the gateway phase is pending, and
  // is used for the final gateway checks when present.
  const gatewayPending = gatewayTransport && (!receipt || pending('ai-gateway'));
  const gatewayApi = gatewayTransport
    ? gatewayApiFor(ctx, account.id, { requiredFor: gatewayPending ? 'the Cloudflare AI Gateway transport (--ai-transport cloudflare-gateway)' : null })
    : null;

  let artifact = null;
  if (['deploy-initial', 'origin', 'workspace-init', 'bootstrap-clear'].some(pending)) {
    artifact = await artifactStatus({ root: ctx.root, artifactDir: ctx.artifactDir, git: ctx.gitPath });
    if (!artifact.ready) {
      throw refuse('the release artifact is not ready for deployment', [
        ...artifact.problems,
        'Build and check it for the current clean commit (npm run build:cloudflare, then the local release check), then retry.',
      ]);
    }
  }

  if (fresh) {
    const queues = await wrangler.listQueues();
    const taken = [names.queue, names.deadLetterQueue].filter((name) => queues.has(name));
    if ((await wrangler.deployments(names.worker)) !== null) taken.unshift(names.worker);
    if (gatewayTransport && (await gatewayApi.getGateway(names.worker)) !== null) taken.push(`AI Gateway ${names.worker}`);
    if (taken.length > 0) {
      throw refuse(`collision: ${taken.join(', ')} already exist in account ${account.id} and no receipt claims them`, [
        'The installer never adopts unrelated resources.',
        `If they belong to this installation, restore its receipt.json into ${ctx.paths.dir} and run resume; otherwise choose another --install name.`,
      ]);
    }
  }

  // Credentials are collected and validated before any remote write, except
  // when an earlier attempt's upload is already observable (lost reply):
  // those secrets are kept, so no new input is needed.
  let secretInput = null;
  if (pending('secrets')) {
    let alreadyBound = false;
    if (receipt?.secrets?.attemptedAt && receipt.phases['deploy-initial']) {
      ensureConfigFile(ctx, receipt);
      const bound = await wrangler.secretNames(names.worker, ctx.paths.config);
      alreadyBound = Boolean(bound) && requiredSecretNames(providerKeys, aiTransport).every((name) => bound.has(name));
    }
    if (!alreadyBound) secretInput = await collectSecretInput(ctx, receipt, providerKeys, aiTransport);
  }

  // ---------- identity ----------
  let epoch = null;
  if (fresh) {
    out.step('Generating installation identity');
    epoch = registry.add(generateEpoch());
    receipt = newReceipt({
      install: ctx.install,
      environment: ctx.environment,
      accountId: account.id,
      names,
      workspaceId: generateWorkspaceId(),
      jurisdiction: options.jurisdiction,
      provider,
      providerKeys,
      aiTransport,
      origin: explicitOrigin ?? '',
      bootstrap: options['import-target'] ? 'recovery' : 'open',
    });
    receipt.epochFingerprint = epochFingerprint(epoch);
    receipt.secrets.epochGeneratedAt = now();
    markPhase(receipt, 'preflight');
    markPhase(receipt, 'identity');
    // Persisted before any remote write.
    saveReceipt(ctx, receipt);
  } else {
    markPhase(receipt, 'preflight');
    if (explicitOrigin && explicitOrigin !== receipt.origin) {
      receipt.origin = explicitOrigin;
      receipt.originSource = 'explicit';
    }
    saveReceipt(ctx, receipt);
    out.step(`Resuming at phase ${firstIncompletePhase(receipt)}`);
  }

  // ---------- resources ----------
  if (pending('resources')) {
    const queueNames = [names.queue, names.deadLetterQueue];
    const assertOwnedQueue = (name, row) => {
      const verdict = queueOwnership(row, receipt.resources[name]);
      if (!verdict.owned) {
        throw refuse(`queue ${name} exists but this installation cannot show that it created it (${verdict.reason}); refusing to adopt it`, [
          'The installer never adopts unrelated resources.',
          `If the queue is unrelated, choose another --install name. If it is this installation's (for example a create whose reply was lost, seen with a skewed clock), delete it deliberately and run resume.`,
        ]);
      }
    };
    let rows = await wrangler.listQueues();
    // Refuse every detectable collision before creating anything.
    for (const name of queueNames) if (rows.has(name)) assertOwnedQueue(name, rows.get(name));
    for (const name of queueNames) {
      const kind = name === names.queue ? 'queue' : 'dead-letter-queue';
      if (!rows.has(name)) {
        out.step(`Creating queue ${name}`);
        const attempt = recordAttempt(receipt, name, kind);
        saveReceipt(ctx, receipt);
        const created = await wrangler.createQueue(name);
        if (created.nameTaken) {
          // This call created nothing: the name belongs to a queue that was
          // not listed a moment ago. Never let this attempt vouch for it.
          dropAttempt(receipt, name, attempt);
          saveReceipt(ctx, receipt);
        }
        rows = await wrangler.listQueues();
        if (created.ok && rows.has(name)) {
          // Created by this call: Cloudflare refuses a create for a taken name.
          const record = receipt.resources[name];
          record.id = rows.get(name).id;
          record.createdAt ??= now();
          record.observedAt ??= now();
          saveReceipt(ctx, receipt);
          continue;
        }
        if (!rows.has(name)) {
          if (created.nameTaken) {
            throw refuse(`collision: queue ${name} is reported as taken but is not listed in account ${account.id}`, [
              'The installer never adopts unrelated resources. Investigate the queue, then run resume, or choose another --install name.',
            ]);
          }
          throw created.error ?? new InstallerError(`queue ${name} not observed after creation; run resume`);
        }
        // A failed create whose queue is listed now: a lost reply only if
        // its creation time falls inside a recorded attempt.
        assertOwnedQueue(name, rows.get(name));
      }
      const record = receipt.resources[name];
      record.id ??= rows.get(name).id;
      record.observedAt ??= now();
      saveReceipt(ctx, receipt);
    }
    markPhase(receipt, 'resources');
    saveReceipt(ctx, receipt);
  }

  // ---------- ai-gateway (cloudflare-gateway only) ----------
  // A Run token is probed before it can be uploaded (gw-final §5): by the
  // gateway phase, or, when that phase finished in an earlier run, here, so a
  // resume never binds a token this run did not see accepted.
  const runToken = secretInput?.supplied?.[GATEWAY_TOKEN_SECRET] ?? null;
  if (pending('ai-gateway')) {
    if (!runToken) throw new InstallerError('internal error: the gateway phase needs the Run token from this run\'s protected input');
    await ensureGateway({ receipt, api: gatewayApi, runToken, save: () => saveReceipt(ctx, receipt), out });
    markPhase(receipt, 'ai-gateway');
    saveReceipt(ctx, receipt);
  } else if (runToken) {
    const probe = await runGatewayProbe({ receipt, runToken, out });
    if (!probe.ok) {
      throw refuse(`the supplied Run token was not accepted by AI Gateway ${receipt.aiGateway.id} as the probe expects; nothing further was changed and no secret was uploaded`, [
        'Supply a token with AI Gateway Run on this account (dashboard: AI Gateway → the gateway → Create authentication token), then run resume again.',
      ]);
    }
    saveReceipt(ctx, receipt);
  }

  // ---------- config ----------
  if (pending('config')) {
    writeConfig(ctx, receipt);
    markPhase(receipt, 'config');
    saveReceipt(ctx, receipt);
    out.step(`Wrote installation config ${ctx.paths.config}`);
  }

  // ---------- deploy-initial ----------
  if (pending('deploy-initial')) {
    const existing = await wrangler.deployments(names.worker);
    if (existing !== null) {
      const verdict = workerOwnership(existing, receipt.resources[names.worker]);
      if (!verdict.owned) {
        throw refuse(`Worker ${names.worker} exists but this installation cannot show that it deployed it (${verdict.reason}); refusing to adopt it`, [
          'The installer never adopts unrelated resources: choose another --install name, or investigate the Worker first.',
        ]);
      }
    }
    const attempt = recordAttempt(receipt, names.worker, 'worker', { commit: artifact.commit });
    saveReceipt(ctx, receipt);
    try {
      await deployInstallation(ctx, receipt, { purpose: 'initial', artifact });
    } catch (error) {
      if (error.nothingUploaded) {
        dropAttempt(receipt, names.worker, attempt);
        saveReceipt(ctx, receipt);
      }
      throw error;
    }
    if (!(await wrangler.workerExists(names.worker))) {
      throw new InstallerError(`deploy reported success but Worker ${names.worker} is not observable yet; run resume`);
    }
    receipt.resources[names.worker].observedAt ??= now();
    markPhase(receipt, 'deploy-initial');
    saveReceipt(ctx, receipt);
  }

  // ---------- secrets ----------
  if (pending('secrets')) {
    ensureConfigFile(ctx, receipt);
    const required = requiredSecretNames(providerKeys, aiTransport);
    const present = await wrangler.secretNames(names.worker, ctx.paths.config);
    if (present === null) throw new InstallerError(`Worker ${names.worker} was not found while setting secrets; run resume`);
    const have = required.filter((name) => present.has(name));
    if (have.length === required.length) {
      if (!receipt.secrets.attemptedAt) {
        throw refuse(`secrets are already bound to ${names.worker} but this installation never set them; refusing to continue`);
      }
      // An earlier attempt's upload landed although its reply was lost:
      // keep what is bound; never regenerate or rotate.
      out.step('Secrets from the interrupted attempt are bound; keeping them (not regenerated)');
      if (receipt.operatorToken?.destination === 'terminal') {
        out.line(`  The OPERATOR_TOKEN from that attempt was never shown. Rotate it with wrangler secret put OPERATOR_TOKEN --name ${names.worker} if you need operator access.`);
      }
    } else if (have.length > 0) {
      throw refuse(`only some installation secrets are bound to ${names.worker} (${have.join(', ')}); refusing to overwrite them`, [
        `Inspect with wrangler secret list --name ${names.worker}. Remove the partial set deliberately, then run resume.`,
      ]);
    } else {
      if (!secretInput) throw new InstallerError('bound secrets changed during this run; run resume again');
      if (!epoch) {
        // Rule: until the secrets phase completes, the epoch exists only in
        // memory; an interrupted apply therefore gets a fresh one here.
        epoch = registry.add(generateEpoch());
        receipt.epochFingerprint = epochFingerprint(epoch);
        receipt.secrets.epochGeneratedAt = now();
      }
      const values = composeSecretSet({ supplied: secretInput.supplied, providerKeys, epoch, aiTransport });
      for (const value of Object.values(values)) registry.add(value);
      receipt.secrets.attemptedAt = now();
      receipt.operatorToken = secretInput.tokenFile
        ? { destination: 'file', file: secretInput.tokenFile.file, writtenAt: null }
        : { destination: 'terminal', file: null, writtenAt: null };
      saveReceipt(ctx, receipt);
      if (secretInput.tokenFile) {
        writeOperatorTokenFile(secretInput.tokenFile, values.OPERATOR_TOKEN);
        receipt.operatorToken.writtenAt = now();
        saveReceipt(ctx, receipt);
      }
      out.step(`Setting ${Object.keys(values).length} secrets on ${names.worker} in one bulk upload (names: ${Object.keys(values).sort().join(', ')})`);
      await wrangler.putSecrets(names.worker, ctx.paths.config, values);
      const after = await wrangler.secretNames(names.worker, ctx.paths.config);
      const missing = required.filter((name) => !after?.has(name));
      if (missing.length > 0) throw new InstallerError(`secrets not observed after upload: ${missing.join(', ')}; run resume`);
      if (options['reveal-operator-token']) {
        process.stdout.write(`\nOPERATOR_TOKEN (shown once; store it in your password manager now):\n${values.OPERATOR_TOKEN}\n\n`);
      } else {
        out.line(`  OPERATOR_TOKEN written once to ${secretInput.tokenFile.file} (mode 0600). Move it into your password manager.`);
      }
    }
    markPhase(receipt, 'secrets');
    saveReceipt(ctx, receipt);
  }

  // ---------- origin ----------
  if (pending('origin')) {
    if (!receipt.origin) {
      const url = receipt.workersDevUrl;
      if (!url || !isOwnWorkersDevHost(new URL(url).hostname, names.worker)) {
        throw new InstallerError(`the deploy output did not include a workers.dev URL for ${names.worker}`, {
          hints: [
            'Check that the account has a workers.dev subdomain (Workers & Pages → Account details) and run resume,',
            'or resume with --origin <final https origin>.',
          ],
        });
      }
      receipt.origin = validateOrigin(url);
      receipt.originSource = 'workers.dev';
      assertOriginUnique(ctx, receipt.origin);
      saveReceipt(ctx, receipt);
      out.step(`Discovered origin ${receipt.origin}`);
    }
    const last = receipt.deployments.at(-1);
    if (!last || last.appBaseUrl !== receipt.origin) await deployInstallation(ctx, receipt, { purpose: 'origin', artifact });
    if (isWorkersDevOrigin(receipt.origin) && receipt.workersDevUrl !== receipt.origin) {
      throw refuse(`the deploy reports ${receipt.workersDevUrl ?? 'no workers.dev URL'} for ${names.worker}, not ${receipt.origin}`, [
        'Resume with the --origin the deploy reports (or your custom domain).',
      ]);
    }
    markPhase(receipt, 'origin');
    saveReceipt(ctx, receipt);
  }

  // ---------- workspace-init ----------
  // Probed through the Worker's own workers.dev URL, never the origin: a
  // custom origin may still be routed elsewhere (or nowhere), and another
  // Worker answering it must not let this Worker's bootstrap be cleared
  // before its own workspace object initialized (gap review F2).
  if (pending('workspace-init')) {
    const workerUrl = ownWorkerUrl(receipt);
    if (!workerUrl) {
      throw new InstallerError(`no workers.dev URL of ${names.worker} is recorded, so its workspace cannot be initialized through the Worker itself`, {
        hints: [
          'The template deploys with workers_dev: true and the deploy output lists the URL under "Deployed <worker> triggers".',
          'Check that the account has a workers.dev subdomain (Workers & Pages → Account details) and the deploy output, then run resume.',
        ],
      });
    }
    const last = receipt.deployments.at(-1);
    if (!last || last.bootstrap !== receipt.bootstrap || last.appBaseUrl !== receipt.origin) {
      // Only after a deliberate re-bootstrap (INSTALLER.md): the running
      // version no longer carries the bootstrap state.
      await deployInstallation(ctx, receipt, { purpose: 'workspace-init', artifact });
    }
    const held = receipt.bootstrap === 'recovery';
    out.step(`Waiting for the workspace to initialize under WORKSPACE_BOOTSTRAP=${receipt.bootstrap} at ${workerUrl} (up to ${ctx.waitSeconds}s)`);
    const result = await pollDeployment(workerUrl, {
      waitSeconds: ctx.waitSeconds,
      aiTransport: receipt.aiTransport,
      accept: (evaluation) => evaluation.status === 'ready' || (held && evaluation.status === 'held-maintenance'),
    });
    if (result.terminal) {
      throw new InstallerError(`the workspace refused initialization: ${result.terminal}`, {
        hints: ['Identity, jurisdiction or epoch configuration does not match the object; do not retry blindly. See INSTALLER.md.'],
      });
    }
    if (!(result.status === 'ready' || (held && result.status === 'held-maintenance'))) {
      throw new InstallerError(`the workspace did not report initialized at ${workerUrl} within ${ctx.waitSeconds}s (${result.status})`, {
        hints: [
          ...(result.errors.length ? [`readiness errors: ${result.errors.join(', ')}`] : []),
          ...(result.errors.includes('workspace_unconfigured')
            ? ['workspace_unconfigured: the running version does not see WORKSPACE_ID or the recovery epoch yet (a version from before the secret upload); it clears once the new version serves.']
            : []),
          'Run resume to continue waiting.',
        ],
      });
    }
    markPhase(receipt, 'workspace-init');
    saveReceipt(ctx, receipt);
  }

  // ---------- bootstrap-clear ----------
  if (pending('bootstrap-clear')) {
    const last = receipt.deployments.at(-1);
    if (!last || last.bootstrap !== '' || last.appBaseUrl !== receipt.origin) {
      await deployInstallation(ctx, receipt, { purpose: 'bootstrap-clear', artifact });
    }
    markPhase(receipt, 'bootstrap-clear');
    saveReceipt(ctx, receipt);
  }

  // ---------- verify ----------
  const acceptHeld = receipt.bootstrap === 'recovery';
  const verification = await verifyInstallation({
    template: ctx.template,
    receipt,
    configPath: ctx.paths.config,
    waitSeconds: ctx.waitSeconds,
    acceptHeld,
    gatewayApi,
  });
  receipt.lastVerification = summarizeVerification(verification);
  saveReceipt(ctx, receipt);
  printVerification(out, verification);
  if (!verification.ok) {
    const customOrigin = receipt.origin !== verification.workersDevUrl;
    throw new InstallerError(`verification failed (${verification.status}); the verify phase is not recorded`, {
      hints: [
        ...(customOrigin ? [`A custom origin must be routed to ${names.worker} (Worker → Settings → Domains & Routes) before verify can pass; the workspace itself is already initialized.`] : []),
        'Fix the failing checks above and run resume.',
      ],
    });
  }
  markPhase(receipt, 'verify');
  saveReceipt(ctx, receipt);

  out.line('');
  out.line(verification.status === 'held-maintenance'
    ? `Installation ${ctx.install} (${ctx.environment}) is installed; its workspace is held in recovery awaiting import.`
    : `Installation ${ctx.install} (${ctx.environment}) is ready.`);
  out.line(`  URL        ${receipt.origin}`);
  out.line(`  Worker     ${names.worker}   Queue ${names.queue}   DLQ ${names.deadLetterQueue}`);
  out.line(`  AI         ${receipt.aiTransport === GATEWAY_TRANSPORT ? `through Cloudflare AI Gateway ${receipt.aiGateway.id}` : 'direct to each provider'} (default provider ${receipt.provider}; keys ${receipt.providerKeys.join(', ')})`);
  out.line(`  Version    ${receipt.deployments.at(-1)?.commit ?? 'unknown'} (last deploy recorded by this installer)`);
  out.line(`  Receipt    ${ctx.paths.receipt}`);
  if (acceptHeld) out.line('  Next       import the operational backup and activate the recovery epoch (OPS-02/OPS-03).');
  out.result({
    command: ctx.command,
    status: verification.status,
    changed: true,
    origin: receipt.origin,
    names,
    aiTransport: receipt.aiTransport,
    aiGateway: receipt.aiGateway?.id ?? null,
    version: receipt.deployments.at(-1)?.commit ?? null,
    receipt: ctx.paths.receipt,
    limitations: verification.limitations,
  });
  return 0;
}
