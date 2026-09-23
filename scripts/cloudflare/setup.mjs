#!/usr/bin/env node
// setup:cloudflare (SETUP-01, SETUP-02, SETUP-03, SETUP-05, SETUP-07): the
// deterministic installer for Cloudflare standalone installations.
//
//   npm run setup:cloudflare -- <plan|apply|resume|verify|update> --install <name> --env <production|staging> [options]
//
// Secrets are generated here or read from stdin JSON / a hidden prompt, and
// reach Cloudflare only through `wrangler secret bulk` on stdin. They are
// never written to the receipt, the installation config, logs or argv.
// Reference: docs/operations/cloudflare-migration/INSTALLER.md

import { parseArgs } from 'node:util';
import { applyCommand } from './installer/apply.mjs';
import { createContext } from './installer/context.mjs';
import { InstallerError, HELD, REFUSED } from './installer/model.mjs';
import { planCommand } from './installer/plan.mjs';
import { printVerification } from './installer/report.mjs';
import { readReceipt } from './installer/state.mjs';
import { updateCommand } from './installer/update.mjs';
import { verifyInstallation } from './installer/verify.mjs';

const USAGE = `Usage: npm run setup:cloudflare -- <command> --install <name> --env <production|staging> [options]

Commands
  plan      read-only: resources, vars, secret names, billing, jurisdiction, artifact readiness
  apply     fresh installation (needs --provider, --jurisdiction, --yes); on an existing receipt behaves as resume
  resume    continue an interrupted apply from its first incomplete phase (--yes)
  verify    read-only readiness check of the deployed installation (--json for machine output)
  update    deploy the current checked artifact to an existing installation (--yes)

Options
  --install <name>              installation name: 1-24 of [a-z0-9-] (required)
  --env <production|staging>    environment (required); staging uses separate resources
  --provider <name>             gemini | claude | openai | openrouter
  --jurisdiction <eu|fedramp|none>  Durable Object storage jurisdiction (explicit on first apply; recommended eu)
  --origin <https://host>       final origin; otherwise the workers.dev URL is discovered from the first deploy
  --account-id <id>             Cloudflare account (must be accessible to wrangler)
  --import-target               initialize the fresh workspace in 'recovery' for an operational import
  --secrets-stdin               read {"ADMIN_PASSWORD": ..., "<PROVIDER>_API_KEY": ...} as JSON from stdin
  --operator-token-file <path>  write the generated OPERATOR_TOKEN once (mode 0600, outside the repository)
  --reveal-operator-token       print the generated OPERATOR_TOKEN once (interactive terminal only)
  --change-provider             update only: switch AI_PROVIDER (adds that provider's key if absent)
  --yes                         confirm the reviewed plan (apply, resume, update)
  --json                        machine-readable result on stdout (progress goes to stderr)
  --wait-seconds <n>            readiness wait budget (default 180)
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
  yes: { type: 'boolean' },
  json: { type: 'boolean' },
  'wait-seconds': { type: 'string' },
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
  const result = await verifyInstallation({ template: ctx.template, receipt, configPath: ctx.paths.config, waitSeconds });
  printVerification(ctx.out, result);
  ctx.out.result(result);
  if (result.status === 'ready') return 0;
  return result.status === 'held-maintenance' ? HELD : 1;
}

const COMMANDS = {
  plan: planCommand,
  apply: applyCommand,
  resume: applyCommand,
  verify: verifyCommand,
  update: updateCommand,
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
