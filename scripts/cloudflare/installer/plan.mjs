// plan (SETUP-01): read-only. Lists resources to create or reuse, vars,
// secret names, billing and jurisdiction notes and artifact readiness.
// Writes nothing locally or remotely.

import { artifactStatus } from './artifact.mjs';
import { assertOwnWorkersDevOrigin, checkToolEnvironment, gatewayApiFor, resolveAccount, wranglerFor } from './context.mjs';
import {
  EPOCH_SECRET,
  GATEWAY_ADMIN_TOKEN_ENV,
  GATEWAY_TOKEN_SECRET,
  GATEWAY_TRANSPORT,
  GENERATED_SECRETS,
  JURISDICTIONS,
  PASSWORD_SECRET,
  PHASES,
  PROVIDER_KEYS,
  RECOMMENDED_JURISDICTION,
  REFUSED,
  deriveNames,
  parseProviderList,
  validateAiTransport,
  validateJurisdiction,
  validateOrigin,
  validateProvider,
  validateProviderKeys,
} from './model.mjs';
import { gatewayOwnership, queueOwnership, workerOwnership } from './ownership.mjs';
import { firstIncompletePhase, listReceipts, readReceipt } from './state.mjs';

export const BILLING_NOTES = [
  'Workers Paid is recommended: the Free plan limits CPU time to 10 ms per request, too little for this application.',
  'Durable Object (SQLite) requests/storage and Queue operations count against your Workers plan; existing account usage is not assumed unused.',
  'AI provider usage is billed separately by the provider, to the API key you supply.',
];

/** Printed for the Cloudflare AI Gateway transport (RT-11, SETUP-08). */
export const GATEWAY_NOTES = [
  'AI Gateway is not covered by --jurisdiction: Cloudflare may process requests at any location, including outside the EU (the consent notice says so).',
  'The AI Gateway Run token (CF_AI_GATEWAY_TOKEN) can send through every gateway in this account; create it for this account only.',
  'Provider billing is unchanged: each request carries the installation\'s own provider key; no Unified Billing, stored keys or Cloudflare credits are used.',
  `The gateway is created and read with ${GATEWAY_ADMIN_TOKEN_ENV} (AI Gateway Read + Edit), held only in the installer's environment; it is never deleted by the installer.`,
];

export function jurisdictionNote(value) {
  if (!value) return `not chosen yet — apply requires an explicit --jurisdiction (recommended: ${RECOMMENDED_JURISDICTION})`;
  const base = 'restricts where the Durable Object stores workspace data; it does not restrict where requests run, where Queue messages (identifiers only) or logs are processed, or where the AI provider processes content';
  if (value === 'none') return `none: no storage restriction. Setting one later is a data migration (update refuses it).`;
  return `${value}: ${base}. Changing it later is a data migration (update refuses it).`;
}

function resourceAction({ exists, owned, created }) {
  if (exists) return owned ? 'reuse' : 'COLLISION';
  return created ? 'MISSING (drift)' : 'create';
}

export async function planCommand(ctx) {
  const { options, out } = ctx;
  if (options.provider !== undefined) validateProvider(options.provider);
  if (options.jurisdiction !== undefined) validateJurisdiction(options.jurisdiction);
  if (options['ai-transport'] !== undefined) validateAiTransport(options['ai-transport']);
  const receipt = readReceipt(ctx.paths.receipt);
  checkToolEnvironment(ctx);
  const wrangler = wranglerFor(ctx);
  const account = resolveAccount(await wrangler.whoami(), {
    requested: options['account-id'],
    receiptAccount: receipt?.accountId,
    envAccount: process.env.CLOUDFLARE_ACCOUNT_ID,
  });
  wrangler.useAccount(account.id);
  const names = receipt?.names ?? deriveNames(ctx.install, ctx.environment);
  const requestedOrigin = options.origin !== undefined ? validateOrigin(options.origin) : null;
  const origin = receipt?.phases?.origin ? receipt.origin : requestedOrigin ?? (receipt?.origin || null);
  assertOwnWorkersDevOrigin(origin, names.worker);
  const provider = receipt?.provider ?? options.provider ?? null;
  const requestedKeys = options['provider-keys'] !== undefined ? parseProviderList(options['provider-keys'], '--provider-keys') : null;
  if (!receipt && requestedKeys && provider) validateProviderKeys(requestedKeys, provider);
  const providerKeys = receipt?.providerKeys ?? requestedKeys ?? (provider ? [provider] : null);
  const jurisdiction = receipt?.jurisdiction ?? options.jurisdiction ?? null;
  const aiTransport = receipt?.aiTransport ?? options['ai-transport'] ?? 'direct';
  const gatewayTransport = aiTransport === GATEWAY_TRANSPORT;
  const notes = [];
  if (receipt && options['ai-transport'] && options['ai-transport'] !== receipt.aiTransport) {
    notes.push(`AI transport: installed ${receipt.aiTransport}; switching to ${options['ai-transport']} needs update --change-ai-transport`);
  }
  if (receipt && requestedKeys && requestedKeys.join(',') !== receipt.providerKeys.join(',')) {
    notes.push(`provider keys: installed ${receipt.providerKeys.join(', ')}; add one with update --add-provider-key <provider> (no deploy)`);
  }
  if (receipt && options.provider && options.provider !== receipt.provider) {
    notes.push(`provider: installed ${receipt.provider}; switching to ${options.provider} needs update --change-provider`);
  }
  const pendingChange = receipt?.pendingChange;
  if (pendingChange?.kind === 'provider') {
    const { from, to } = pendingChange;
    notes.push(`provider: a change from ${from} to ${to} has not finished; finish it with update --provider ${to} --change-provider`);
  } else if (pendingChange?.kind === 'add-provider-key') {
    notes.push(`provider keys: adding ${pendingChange.providers.join(', ')} has not finished; finish it with update --add-provider-key ${pendingChange.providers.join(',')}`);
  } else if (pendingChange?.kind === 'rotate-provider-key') {
    notes.push(`provider keys: rotating ${pendingChange.provider} has not finished; finish it with update --rotate-provider-key ${pendingChange.provider}`);
  } else if (pendingChange?.kind === 'ai-transport') {
    notes.push(`AI transport: a change from ${pendingChange.from} to ${pendingChange.to} has not finished; finish it with update --change-ai-transport --ai-transport ${pendingChange.to}`);
  } else if (pendingChange?.kind === 'rotate-ai-gateway-token') {
    notes.push('AI Gateway Run token: a rotation has not finished; finish it with update --rotate-ai-gateway-token');
  }
  if (receipt && options.jurisdiction && options.jurisdiction !== receipt.jurisdiction) {
    notes.push(`jurisdiction: installed ${receipt.jurisdiction}; changing it is a data migration that update refuses`);
  }
  if (receipt?.phases?.origin && requestedOrigin && requestedOrigin !== receipt.origin) {
    notes.push(`origin: installed ${receipt.origin}; changing it is a separate operation that apply/update refuse`);
  }

  // Same ownership evidence resume applies (ownership.mjs): a receipt
  // attempt marker alone never makes an existing resource this installation's.
  const queues = await wrangler.listQueues();
  const deployments = await wrangler.deployments(names.worker);
  const record = (name) => receipt?.resources?.[name];
  const queueResource = (kind, name) => {
    const row = queues.get(name);
    const verdict = row ? queueOwnership(row, record(name)) : null;
    return { kind, name, exists: Boolean(row), owned: Boolean(verdict?.owned), reason: verdict?.reason ?? null, created: Boolean(record(name)?.id || record(name)?.createdAt) };
  };
  const workerVerdict = deployments !== null ? workerOwnership(deployments, record(names.worker)) : null;
  const resources = [
    {
      kind: 'worker',
      name: names.worker,
      exists: deployments !== null,
      owned: Boolean(workerVerdict?.owned),
      reason: workerVerdict?.reason ?? null,
      created: Boolean(receipt?.phases?.['deploy-initial']),
    },
    queueResource('queue', names.queue),
    queueResource('dead-letter-queue', names.deadLetterQueue),
  ].map((resource) => ({ ...resource, action: resourceAction(resource) }));
  if (gatewayTransport || receipt?.aiGateway) {
    // Read only with the management token; the gateway id is the Worker name.
    const api = gatewayApiFor(ctx, account.id);
    const created = Boolean(receipt?.aiGateway?.observedAt);
    const unchecked = (why) => ({ kind: 'ai-gateway', name: names.worker, exists: null, owned: null, reason: null, created, action: `not checked (${why})` });
    if (api) {
      let gateway;
      let failure = null;
      try {
        gateway = await api.getGateway(names.worker);
      } catch (error) {
        failure = error;
      }
      if (failure) {
        resources.push(unchecked(failure.message));
      } else {
        const verdict = gateway ? gatewayOwnership(gateway, receipt?.aiGateway) : null;
        const resource = { kind: 'ai-gateway', name: names.worker, exists: Boolean(gateway), owned: Boolean(verdict?.owned), reason: verdict?.reason ?? null, created };
        // On direct transport a recorded gateway deleted in the dashboard is
        // not drift: the next switch to the gateway creates a new one.
        const action = !gateway && created && !gatewayTransport ? 'absent (a switch to cloudflare-gateway creates a new one)' : resourceAction(resource);
        resources.push({ ...resource, action });
      }
    } else {
      resources.push(unchecked(`${GATEWAY_ADMIN_TOKEN_ENV} not set`));
    }
  }

  const collisions = resources.filter((resource) => resource.action === 'COLLISION').map((resource) => resource.name);
  const drift = resources.filter((resource) => resource.action.startsWith('MISSING')).map((resource) => resource.name);
  const originOwner = origin
    ? listReceipts(ctx.stateDir).find((other) => other.origin === origin && !(other.install === ctx.install && other.env === ctx.environment))
    : null;
  if (originOwner) collisions.push(`origin ${origin} (installation ${originOwner.install}/${originOwner.env})`);

  const nextPhase = receipt ? firstIncompletePhase(receipt) : PHASES[0];
  let status;
  if (collisions.length > 0) status = 'collision';
  else if (!receipt) status = 'new';
  else if (drift.length > 0) status = 'drift';
  else status = nextPhase ? 'in-progress' : 'complete';

  const secretsSet = Boolean(receipt?.phases?.secrets);
  const keyNames = [
    ...(providerKeys ? providerKeys.map((entry) => PROVIDER_KEYS[entry]) : ['<selected provider key>']),
    ...(gatewayTransport ? [GATEWAY_TOKEN_SECRET] : []),
  ];
  const bootstrap = receipt?.bootstrap ?? (options['import-target'] ? 'recovery' : 'open');
  const vars = {
    DEPLOYMENT_TARGET: 'cloudflare',
    DEPLOYMENT_MODE: 'standalone',
    AI_TRANSPORT: aiTransport,
    AI_PROVIDER: provider ?? '<--provider>',
    CF_AI_GATEWAY_ACCOUNT_ID: gatewayTransport ? account.id : '',
    CF_AI_GATEWAY_ID: gatewayTransport ? names.worker : '',
    APP_BASE_URL: origin ?? '<workers.dev URL discovered after the first deploy>',
    WORKSPACE_ID: receipt?.workspaceId ?? '<generated once at apply>',
    WORKSPACE_JURISDICTION: jurisdiction ? JURISDICTIONS[jurisdiction] : '<--jurisdiction>',
    WORKSPACE_BOOTSTRAP: receipt?.phases?.['workspace-init'] ? '' : `${bootstrap} while initializing, then ''`,
  };
  const artifact = await artifactStatus({ root: ctx.root, artifactDir: ctx.artifactDir, git: ctx.gitPath });

  const plan = {
    command: 'plan',
    install: ctx.install,
    env: ctx.environment,
    stateDir: ctx.paths.dir,
    account: { id: account.id, name: account.name },
    status,
    nextPhase,
    names,
    resources,
    collisions,
    drift,
    durableObject: 'WorkspaceStore (SQLite) namespace, created by the first deploy (migration v1); selected by WORKSPACE_ID',
    vars,
    providerKeys,
    aiTransport,
    secrets: secretsSet
      ? { alreadySet: [PASSWORD_SECRET, ...GENERATED_SECRETS, EPOCH_SECRET, ...keyNames], generate: [], request: [] }
      : { alreadySet: [], generate: [...GENERATED_SECRETS, EPOCH_SECRET], request: [PASSWORD_SECRET, ...keyNames] },
    jurisdiction: { value: jurisdiction, recommended: RECOMMENDED_JURISDICTION, note: jurisdictionNote(jurisdiction) },
    billing: BILLING_NOTES,
    aiGateway: gatewayTransport ? GATEWAY_NOTES : [],
    artifact: { ready: artifact.ready, commit: artifact.commit, problems: artifact.problems },
    notes,
  };

  out.line(`Cloudflare installation plan (read-only) — ${ctx.install} (${ctx.environment})`);
  out.line(`  Account      ${account.name} (${account.id})`);
  out.line(`  State        ${ctx.paths.dir}${receipt ? '' : ' (no receipt yet)'}`);
  out.line(`  Status       ${status}${status === 'in-progress' ? ` (next phase: ${nextPhase})` : ''}`);
  out.line('Resources');
  for (const resource of resources) {
    out.line(`  ${resource.kind.padEnd(18)} ${resource.name.padEnd(40)} ${resource.action}${resource.action === 'COLLISION' && resource.reason ? ` (${resource.reason})` : ''}`);
  }
  out.line(`  ${'durable object'.padEnd(18)} ${plan.durableObject}`);
  out.line('Vars');
  for (const [name, value] of Object.entries(vars)) out.line(`  ${name.padEnd(24)} ${value === '' ? "''" : value}`);
  out.line('Secrets (names only; values never displayed)');
  if (secretsSet) out.line(`  already set, never rotated by apply; provider keys rotate only with update --rotate-provider-key: ${plan.secrets.alreadySet.join(', ')}`);
  else {
    out.line(`  generated at apply: ${plan.secrets.generate.join(', ')}`);
    out.line(`  you supply (stdin JSON or hidden prompt): ${plan.secrets.request.join(', ')}`);
  }
  out.line(`Jurisdiction  ${plan.jurisdiction.note}`);
  out.line('Billing');
  for (const note of BILLING_NOTES) out.line(`  - ${note}`);
  if (gatewayTransport) {
    out.line('AI Gateway');
    for (const note of GATEWAY_NOTES) out.line(`  - ${note}`);
  }
  out.line(`Artifact      ${artifact.ready ? `ready (${artifact.commit})` : 'not ready'}`);
  for (const problem of artifact.problems) out.line(`  - ${problem}`);
  for (const note of notes) out.line(`Note          ${note}`);
  if (collisions.length > 0) {
    out.line('');
    out.line(`COLLISION: ${collisions.join(', ')} exist without evidence that this installation created them.`);
    out.line('The installer never adopts unrelated resources: restore the matching receipt.json or choose another --install name.');
  } else if (drift.length > 0) {
    out.line('');
    out.line(`DRIFT: ${drift.join(', ')} recorded in the receipt but missing in the account. Investigate before update/resume.`);
  } else if (status === 'new') {
    out.line('');
    out.line('Next: npm run setup:cloudflare -- apply '
      + `--install ${ctx.install} --env ${ctx.environment} --provider ${provider ?? '<provider>'} `
      + `${providerKeys && providerKeys.length > 1 ? `--provider-keys ${providerKeys.join(',')} ` : ''}`
      + `${gatewayTransport ? '--ai-transport cloudflare-gateway ' : ''}`
      + `--jurisdiction ${jurisdiction ?? RECOMMENDED_JURISDICTION} --operator-token-file <path outside the repo> --secrets-stdin --yes`);
  } else if (status === 'in-progress') {
    out.line('');
    out.line(`Next: npm run setup:cloudflare -- resume --install ${ctx.install} --env ${ctx.environment} --yes`);
  }
  out.result(plan);
  return collisions.length > 0 ? REFUSED : 0;
}
