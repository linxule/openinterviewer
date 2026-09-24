#!/usr/bin/env node
// setup:cloudflare (SETUP-01, SETUP-02, SETUP-03, SETUP-05, SETUP-07): the
// deterministic installer for Cloudflare standalone installations.
//
//   npm run setup:cloudflare -- <plan|apply|resume|verify|update|config> --install <name> --env <production|staging> [options]
//   npm run setup:cloudflare -- verify --config <installation wrangler.jsonc> [--wait-seconds <n>] [--json]
//
// Secrets are generated here or read from stdin JSON / a hidden prompt, and
// reach Cloudflare only through `wrangler secret bulk` on stdin. They are
// never written to the receipt, the installation config, logs or argv. The AI
// Gateway management token (CF_AI_GATEWAY_ADMIN_TOKEN) is read from this
// process's environment only and never leaves it except as the Authorization
// of its own Cloudflare API calls.
// Reference: docs/operations/cloudflare-migration/INSTALLER.md

import path from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT, readJsonc } from './lib.mjs';
import { applyCommand } from './installer/apply.mjs';
import { configCommand } from './installer/config.mjs';
import { Reporter, createContext, gatewayApiFor, parseWaitSeconds } from './installer/context.mjs';
import { InstallerError, HELD, REFUSED } from './installer/model.mjs';
import { planCommand } from './installer/plan.mjs';
import { printVerification } from './installer/report.mjs';
import { readReceipt } from './installer/state.mjs';
import { updateCommand } from './installer/update.mjs';
import { verifyConfiguredOrigin, verifyInstallation } from './installer/verify.mjs';

const USAGE = `Usage: npm run setup:cloudflare -- <command> --install <name> --env <production|staging> [options]
       npm run setup:cloudflare -- verify --config <installation wrangler.jsonc> [--wait-seconds <n>] [--json]

Commands
  plan      read-only: resources, vars, secret names, billing, jurisdiction, artifact readiness
  apply     fresh installation (needs --provider, --jurisdiction, --yes); on an existing receipt behaves as resume
  resume    continue an interrupted apply from its first incomplete phase (--yes)
  verify    read-only readiness check of the deployed installation (--json for machine output);
            with --config and no --install/--env: the config's APP_BASE_URL, without a receipt
            (for a deploy made outside the installer, such as the CI promotion job)
  update    deploy the current checked artifact to an existing installation (--yes), or run one
            provider-key operation (--add-provider-key, --rotate-provider-key), --rotate-ai-gateway-token
            or --rotate-admin-password without deploying, or switch --change-provider / --change-ai-transport
  config    local only: (re)write cloudflare/installations/<install>-<env>/wrangler.jsonc from
            the receipt and print its path; refused until the bootstrap was cleared. This is the
            file to store as CLOUDFLARE_INSTALL_CONFIG for the CI promotion job

Options
  --install <name>              installation name: 1-24 of [a-z0-9-] (required)
  --env <production|staging>    environment (required); staging uses separate resources
  --provider <name>             gemini | claude | openai | openrouter: the default provider (AI_PROVIDER), whose key is required
  --provider-keys <p[,p]|all>   apply only: the provider keys to bind (default: the --provider key); must include --provider
  --ai-transport <t>            direct (default) | cloudflare-gateway: send provider requests through the
                                installation's own Cloudflare AI Gateway (apply; update with --change-ai-transport).
                                cloudflare-gateway needs CF_AI_GATEWAY_ADMIN_TOKEN (AI Gateway Read + Edit) in the
                                environment and CF_AI_GATEWAY_TOKEN (the Run token) on protected input
  --jurisdiction <eu|fedramp|none>  Durable Object storage jurisdiction (explicit on first apply; recommended eu)
  --origin <https://host>       final origin; otherwise the workers.dev URL is discovered from the first deploy
  --account-id <id>             Cloudflare account (must be accessible to wrangler)
  --import-target               initialize the fresh workspace in 'recovery' for an operational import
  --secrets-stdin               read {"ADMIN_PASSWORD": ..., "<PROVIDER>_API_KEY": ..., ...} as JSON from stdin
                                (plus "CF_AI_GATEWAY_TOKEN" with cloudflare-gateway; update operations: only the named keys,
                                or {"ADMIN_PASSWORD": ...} alone with --rotate-admin-password)
  --operator-token-file <path>  write the generated OPERATOR_TOKEN once (mode 0600, outside the repository)
  --reveal-operator-token       print the generated OPERATOR_TOKEN once (interactive terminal only)
  --change-provider             update only: switch AI_PROVIDER (adds that provider's key if absent)
  --add-provider-key <p[,p]>    update only: bind the named provider keys; one secret upload, no deploy
  --rotate-provider-key <p>     update only: replace one bound provider key; one secret upload, no deploy
  --change-ai-transport         update only, with --ai-transport: switch AI_TRANSPORT (provisions or adopts the
                                gateway and binds the Run token when needed), then deploy
  --rotate-ai-gateway-token     update only: replace the bound Run token after probing it; no deploy
  --rotate-admin-password       update only: replace ADMIN_PASSWORD (stdin JSON or a hidden prompt, asked twice);
                                no deploy; existing researcher sessions stay valid until they expire
  --yes                         confirm the reviewed plan (apply, resume, update)
  --json                        machine-readable result on stdout (progress goes to stderr)
  --wait-seconds <n>            readiness wait budget (default 180; verify: 0)
  --config <path>               verify only: an installation config to check without a receipt
  --state-dir <dir>             installation state (default cloudflare/installations, gitignored)
  --artifact-dir <dir>          release artifact (default dist/cloudflare/artifact)
  --wrangler <path>             wrangler executable (default node_modules/.bin/wrangler)
  --deploy-script <path>        deploy script (default scripts/cloudflare/deploy.mjs)
  --git <path>                  git executable (default git)
`;

const OPTIONS = {
  install: { type: 'string' },
  env: { type: 'string' },
  provider: { type: 'string' },
  jurisdiction: { type: 'string' },
  origin: { type: 'string' },
  'account-id': { type: 'string' },
  'import-target': { type: 'boolean' },
  'secrets-stdin': { type: 'boolean' },
  'operator-token-file': { type: 'string' },
  'reveal-operator-token': { type: 'boolean' },
  'change-provider': { type: 'boolean' },
  'provider-keys': { type: 'string' },
  'add-provider-key': { type: 'string' },
  'rotate-provider-key': { type: 'string' },
  'ai-transport': { type: 'string' },
  'change-ai-transport': { type: 'boolean' },
  'rotate-ai-gateway-token': { type: 'boolean' },
  'rotate-admin-password': { type: 'boolean' },
  yes: { type: 'boolean' },
  json: { type: 'boolean' },
  'wait-seconds': { type: 'string' },
  config: { type: 'string' },
  'state-dir': { type: 'string' },
  'artifact-dir': { type: 'string' },
  wrangler: { type: 'string' },
  'deploy-script': { type: 'string' },
  git: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

async function verifyCommand(ctx) {
  const receipt = readReceipt(ctx.paths.receipt);
  if (!receipt) {
    throw new InstallerError(`no receipt for ${ctx.install} (${ctx.environment}) at ${ctx.paths.receipt}`, {
      exitCode: REFUSED,
      hints: ['verify needs the installation receipt; pass --state-dir if it lives elsewhere.'],
    });
  }
  if (!receipt.origin) {
    throw new InstallerError(`installation ${ctx.install} (${ctx.environment}) has no origin recorded yet; it is not ready`, {
      hints: ['Finish the installation with resume (or resume --origin <https://...>).'],
    });
  }
  const waitSeconds = ctx.options['wait-seconds'] === undefined ? 0 : ctx.waitSeconds;
  // Gateway settings and stored logs are read only with the management token.
  const gatewayApi = receipt.aiTransport === 'cloudflare-gateway' ? gatewayApiFor(ctx, receipt.accountId) : null;
  const result = await verifyInstallation({ template: ctx.template, receipt, configPath: ctx.paths.config, waitSeconds, gatewayApi });
  printVerification(ctx.out, result);
  ctx.out.result(result);
  if (result.status === 'ready') return 0;
  return result.status === 'held-maintenance' ? HELD : 1;
}

// Options verify --config accepts; everything else needs a receipt.
const CONFIG_VERIFY_OPTIONS = new Set(['config', 'json', 'wait-seconds']);

async function verifyConfigCommand(values) {
  const extra = Object.keys(values).filter((name) => values[name] !== undefined && !CONFIG_VERIFY_OPTIONS.has(name));
  if (extra.length > 0) {
    throw new InstallerError(`verify --config checks a config file without a receipt; it takes no ${extra.map((name) => `--${name}`).join(', ')}`, {
      exitCode: REFUSED,
      hints: ['For an installation with a receipt, run verify --install <name> --env <env> instead.'],
    });
  }
  const out = new Reporter({ json: Boolean(values.json) });
  const result = await verifyConfiguredOrigin({
    template: readJsonc(path.join(ROOT, 'wrangler.jsonc')),
    configPath: path.resolve(values.config),
    waitSeconds: values['wait-seconds'] === undefined ? 0 : parseWaitSeconds(values['wait-seconds']),
  });
  printVerification(out, result);
  out.result(result);
  if (result.status === 'ready') return 0;
  return result.status === 'held-maintenance' ? HELD : 1;
}

const COMMANDS = {
  plan: planCommand,
  apply: applyCommand,
  resume: applyCommand,
  verify: verifyCommand,
  update: updateCommand,
  config: configCommand,
};

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw new InstallerError(`${error.message}\n\n${USAGE}`, { exitCode: REFUSED });
  }
  const { values, positionals } = parsed;
  if (values.help || positionals.length === 0) {
    process.stdout.write(USAGE);
    return values.help ? 0 : REFUSED;
  }
  const [command, ...extra] = positionals;
  if (!Object.hasOwn(COMMANDS, command) || extra.length > 0) {
    throw new InstallerError(`unknown command "${positionals.join(' ')}"\n\n${USAGE}`, { exitCode: REFUSED });
  }
  if (values.config !== undefined) {
    if (command !== 'verify') throw new InstallerError('--config is only valid with verify', { exitCode: REFUSED });
    return verifyConfigCommand(values);
  }
  return COMMANDS[command](createContext(command, values));
}

process.once('SIGINT', () => process.exit(130));
process.once('SIGTERM', () => process.exit(143));

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof InstallerError) {
    process.stderr.write(`error: ${error.message}\n`);
    for (const hint of error.hints) process.stderr.write(`  ${hint}\n`);
    process.exitCode = error.exitCode;
  } else {
    // Name and message only: a stack is printed on request (OI_SETUP_DEBUG=1).
    const detail = process.env.OI_SETUP_DEBUG === '1' ? error?.stack : `${error?.name ?? 'Error'}: ${error?.message ?? error}`;
    process.stderr.write(`error: unexpected failure: ${detail}\n`);
    process.exitCode = 1;
  }
}
