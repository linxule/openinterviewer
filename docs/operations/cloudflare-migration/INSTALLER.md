# Cloudflare installer (`setup:cloudflare`)

The installer creates and updates an OpenInterviewer standalone installation on Cloudflare: one Worker (OpenNext fetch, analysis Queue consumer and the `WorkspaceStore` Durable Object), one analysis Queue and its dead-letter queue. It implements `SETUP-01`, `SETUP-02`, `SETUP-03` and the local parts of `SETUP-07` in [01 — runtime and installation](01-runtime-and-installation.md). `SETUP-05` (one deployment owner) is split between two owners. The installer owns a self-hosted installation. The CI promotion job owns the project's maintained instance after the installer has created it ([Maintained instance: CI promotion](#maintained-instance-ci-promotion)). Maintenance, backup, restore and rollback procedures are in [RUNBOOK.md](RUNBOOK.md).

Status: exercised only against a simulated account (a fake `wrangler`, a fake deploy script and a local fake origin; `npm run test:setup:cloudflare`). It has not run against a real Cloudflare account. See [What is and is not verified](#what-is-and-is-not-verified).

## Before you start

- Node 24.19+ and `npm ci` in a clean checkout of the commit you will deploy. Clean means no uncommitted changes and no untracked files that `.gitignore` does not cover (`git status --porcelain --untracked-files=normal`). Keep files you add for the installation, such as an `op inject` template, outside the checkout. In a dirty checkout:
  - `build:cloudflare` still builds, but records `"dirty": true` in the artifact manifest and its `Artifact ready` line shows `source <commit> dirty`. Such an artifact is never deployable.
  - `check:cloudflare` refuses before any lane: `error: check:cloudflare requires a clean checkout: commit, stash (git stash -u) or remove uncommitted and untracked files first`.
  - `deploy:cloudflare` lists `✗ checkout has uncommitted or untracked files` and ends with `error: deploy preconditions failed; nothing was uploaded`.
  - `plan` reports the artifact as `not ready` with the line `checkout has uncommitted or untracked files`. `apply`, `resume` and `update` refuse (exit 2) before any remote write with `error: the release artifact is not ready for deployment`, followed by that line.
- `wrangler` authenticated for the target account: `node_modules/.bin/wrangler login` (default config location), or `CLOUDFLARE_API_TOKEN` in the environment. The exact minimal API-token permissions are a remote rehearsal item.
- Every wrangler the installer starts, including the one inside `deploy.mjs`, gets the same environment: a minimal base plus `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The installer ignores, and reports that it ignored, `XDG_CONFIG_HOME`, the proxy variables and `NODE_EXTRA_CA_CERTS`, because `deploy.mjs` does not forward them. It refuses a non-public `CLOUDFLARE_COMPLIANCE_REGION`. An environment that needs these settings is unsupported until both allowlists are extended together.
- A checked release artifact for the current clean commit: `npm run build:cloudflare`, then `npm run check:cloudflare`, the local release check that writes a passing `dist/cloudflare/artifact/receipt.json` (it rebuilds the artifact unless given `-- --skip-build`). `plan` reports readiness; `apply` and `update` refuse without it.
- An administrator password of at least 16 characters and the API key of the one provider you select. Every credential must be independent. The password also has a maximum. Cloudflare sign-in reads at most 1 KiB of request body, so the installer refuses a password whose sign-in body (`JSON.stringify({ password })`, UTF-8) is over 1,024 bytes. That allows 1,009 ASCII characters, and fewer with multi-byte characters or characters JSON escapes (`"`, `\`, control characters, unpaired surrogates). `npm run setup:check -- --target cloudflare` reports a longer one as `env.ADMIN_PASSWORD.too_long`, and the deployed Worker reports a longer bound value as the readiness error `admin_password_too_long`.
- Credentials never go in a file inside the checkout. Pipe them from a secret manager (below) or type them at the hidden prompt.
- A Workers Paid plan is recommended: the Free plan limits CPU time to 10 ms per request. Worker size does not force it: the [limit](https://developers.cloudflare.com/workers/platform/limits/#worker-size) is 64 MiB uncompressed on both plans, and `build:cloudflare` prints the bundle's `Total Upload`. Durable Object and Queue usage counts against your plan. Provider usage is billed separately by the provider.

## Commands

```bash
npm run setup:cloudflare -- <command> --install <name> --env <production|staging> [options]
```

| Command | Effect |
| --- | --- |
| `plan` | Read-only. Resources to create, reuse or that collide; vars; secret names; billing and jurisdiction notes; artifact readiness. Exit 2 on a collision. |
| `apply` | Fresh installation. Needs `--provider`, `--jurisdiction`, `--yes`, a credential source and an operator-token destination. On an existing receipt it behaves as `resume`. |
| `resume` | Continues an interrupted `apply` from the first incomplete phase (`--yes`). A no-op on a completed installation. |
| `verify` | Read-only readiness check of the deployed installation. `--json` prints the machine result. With `--config <file>` and no `--install`/`--env`, it checks an installation config without a receipt ([Verify](#verify)). |
| `update` | Deploys the current checked artifact to an existing installation (`--yes`). |
| `config` | Local only. Rewrites the installation config from the receipt and the current `wrangler.jsonc` and prints its path; no wrangler, deploy, git or network call ([Config only](#config-only-config)). |

| Option | Meaning |
| --- | --- |
| `--install <name>` | 1–24 of `[a-z0-9-]`, starting and ending with a letter or digit; the `-staging` suffix is reserved. |
| `--env <production\|staging>` | Staging always gets a separate Worker, Queue, DLQ, secrets, workspace and origin. |
| `--provider <gemini\|claude\|openai\|openrouter>` | The installation's `AI_PROVIDER` and the one native key requested. |
| `--jurisdiction <eu\|fedramp\|none>` | Required explicitly on first apply (recommended `eu`). Recorded and never changed by `update`. |
| `--origin <https://host>` | Final origin. Without it the `workers.dev` URL is discovered from the first deploy. HTTPS only; no credentials, path, query, fragment, IP address or local host. |
| `--account-id <id>` | Required when the credentials can reach several accounts. Must match the receipt and `CLOUDFLARE_ACCOUNT_ID` if set. |
| `--import-target` | Initialize the fresh workspace in `recovery` for an operational import (RUNBOOK). |
| `--secrets-stdin` | Read `{"ADMIN_PASSWORD": "...", "<PROVIDER>_API_KEY": "..."}` from stdin. Without it, a no-echo terminal prompt asks (the password twice). |
| `--operator-token-file <path>` | Write the generated `OPERATOR_TOKEN` once, mode 0600. Must be outside the repository and the state directory, in an existing directory other users cannot write to (or one with the sticky bit). The file is created exclusively and never through a symbolic link. |
| `--reveal-operator-token` | Print the generated `OPERATOR_TOKEN` once; only to an interactive terminal and not with `--json`. |
| `--change-provider` | `update` only, with `--provider <name>`: switch `AI_PROVIDER`; asks for that provider's key (stdin JSON with `--secrets-stdin`, or a prompt) only if it is not bound. |
| `--yes` | Confirms the reviewed plan; required by `apply`, `resume` and `update`. |
| `--wait-seconds <n>` | Readiness wait budget (default 180). `verify` waits only when given. |
| `--config <file>` | `verify` only: an installation config to check without a receipt. Accepts only `--json` and `--wait-seconds` besides. |
| `--json` | One JSON document on stdout; progress goes to stderr. |
| `--state-dir`, `--artifact-dir` | Defaults `cloudflare/installations` (gitignored) and `dist/cloudflare/artifact`. |
| `--wrangler`, `--deploy-script`, `--git` | Substitute executables. Used by the tests; operators keep the defaults. |

Exit codes: `0` success, `1` failure, `2` refused (usage, collision, drift, invalid input, missing identity), `3` the workspace is held in a maintenance state (`verify`, or `update` after a successful deploy).

## Fresh installation

```bash
npm run setup:cloudflare -- plan --install acme --env production --provider gemini --jurisdiction eu

# Credentials from 1Password without touching disk or argv. The template holds op:// references only
# and lives outside the checkout (an untracked file in the checkout makes apply refuse):
#   ~/secure/secrets.tpl.json: {"ADMIN_PASSWORD": "{{ op://<vault>/<item>/password }}", "GEMINI_API_KEY": "{{ op://<vault>/<item>/credential }}"}
op inject -i ~/secure/secrets.tpl.json | npm run setup:cloudflare -- apply --install acme --env production \
  --provider gemini --jurisdiction eu --operator-token-file ~/secure/acme-operator-token \
  --secrets-stdin --yes
```

Omit `--secrets-stdin` to type the credentials at a hidden prompt. On success the installer prints the URL, Worker/Queue names, deployed commit, receipt path and the verification limitations.

## Phases

Each phase is recorded in `receipt.phases` only after its effect is observed, and every phase is safe to replay.

| # | Phase | Effect | Observed by |
| --- | --- | --- | --- |
| 1 | `preflight` | Environment allowlist check; `wrangler whoami`; account, provider, jurisdiction and origin checks; artifact readiness when a deploy is pending; collision check on a fresh install; credentials and operator-token destination read and validated. No remote write. | command results |
| 2 | `identity` | Derives names; generates `WORKSPACE_ID` (`ws_` + 32 hex) and `ANALYSIS_RECOVERY_EPOCH` (`ep_` + 32 hex). The receipt (workspace ID, epoch fingerprint) is written before any remote write. | receipt on disk |
| 3 | `resources` | Refuses any existing queue this installation cannot show it created; then `wrangler queues create` for each absent queue, recording the attempt first and the queue id after. | `wrangler queues list` (all pages) |
| 4 | `config` | Writes the installation `wrangler.jsonc`. | local |
| 5 | `deploy-initial` | Refuses an existing Worker this installation cannot show it deployed; records the attempt, then `deploy.mjs --install <config> --confirm --bootstrap` with `WORKSPACE_BOOTSTRAP=open` (`recovery` for an import target). Records the `workers.dev` URL from the `Deployed <worker> triggers` block of the output. | `wrangler deployments list --name <worker>` |
| 6 | `secrets` | Generates `SESSION_SECRET`, `PARTICIPANT_TOKEN_SECRET`, `RATE_LIMIT_SALT`, `OPERATOR_TOKEN` (32 random bytes each, base64url); writes the operator token file; sends them with `ADMIN_PASSWORD`, the provider key and the epoch in one `wrangler secret bulk` call on stdin. | `wrangler secret list` (names) |
| 7 | `origin` | Discovered: the output URL must be `https://<worker>.<subdomain>.workers.dev`. Explicit `workers.dev` origins must equal that URL. Sets `APP_BASE_URL` and redeploys if the deployed value differs. | deploy output |
| 8 | `workspace-init` | Polls the Worker's own `workers.dev` URL, never the origin, until its fresh object initialized under the bootstrap state (`recovery`: readiness reports only `workspace_maintenance`). Redeploys with the bootstrap state first if the running version no longer carries it (re-bootstrap only). | readiness endpoints at `workers.dev` |
| 9 | `bootstrap-clear` | Sets `WORKSPACE_BOOTSTRAP=''` and redeploys without `--bootstrap` (gap review F2). | deploy result |
| 10 | `verify` | The `verify` checks; an import target may be held in `recovery`. A custom origin must answer by now. | readiness endpoints |

Every deploy whose config still carries a bootstrap value passes `--bootstrap` to `deploy.mjs`; those are phases 5, 7 and 8. `deploy.mjs` refuses `WORKSPACE_BOOTSTRAP` `open` or `recovery` without that flag, and any other non-empty value always. Before it rewrites the config, the installer refuses (exit 2) any other deploy while the receipt lacks `workspace-init`.

Names: Worker `oi-<install>` (`oi-<install>-staging`), Queue `<worker>-analysis`, DLQ `<worker>-analysis-dlq`. They are derived on first apply and afterwards read from the receipt.

## Interruption and resume

Run `resume` with the same `--install`/`--env`. If the secrets phase had not completed, pass the credentials again and an operator-token destination (`--operator-token-file`, which may be the same path if this installation wrote it, or `--reveal-operator-token`). Rules:

- The workspace ID and names are never regenerated.
- The epoch exists only in memory until the secrets phase completes. If apply stops before the secrets were bound, resume generates a fresh epoch and records its fingerprint before uploading. Once bound, the epoch and all secrets are never regenerated or rotated by apply, resume or update.
- The installer never adopts unrelated resources and never deletes anything. A receipt attempt marker alone never proves ownership, because it is written before the remote call and survives calls that never landed. An existing resource with an installation name counts as this installation's only on evidence:
  - Queue: its id matches the id recorded when this installation created it. Or, after a lost reply, the queue's `created_on` from `queues list` falls within a recorded create attempt: from 5 minutes before the attempt to 2 minutes (the wrangler call timeout) plus 5 minutes after it.
  - Worker: it was observed after this installation's own completed deploy. Or, after a lost reply, every deployment in `deployments list` falls within a recorded deploy attempt window (15-minute deploy timeout, ±5 minutes). Any deployment message on it must also be `openinterviewer <commit>` for an attempted commit.
  - Secrets: kept only when the whole set is bound and this installation recorded an upload attempt.
- A create that provably did nothing leaves no attempt behind. This covers a queue name reported as taken, which is a collision, and a `deploy.mjs` refusal before upload ("nothing was uploaded").
- Limit: someone else creating a resource with the same derived name within those minutes of an interrupted attempt looks the same as a lost reply. The 5-minute margin covers clock differences between this machine and Cloudflare. If a resource that is yours is refused because of a larger clock difference, delete it deliberately and run resume.
- If only some installation secrets are bound, resume refuses; inspect with `wrangler secret list` and resolve deliberately.
- If the secrets upload landed but its reply was lost, resume keeps the bound secrets without asking for credentials. An `OPERATOR_TOKEN` that was to be shown on the terminal was then never shown: rotate it with `wrangler secret put OPERATOR_TOKEN --name <worker>`.
- The `--operator-token-file` is rewritten on resume only if this installation wrote it (`operatorToken.writtenAt`), and only while it is still the same private regular file. A file that appeared at the path after preflight is never written and never adopted; choose another path.
- `--origin` may be supplied or corrected on resume until the `origin` phase completes; afterwards the origin is fixed.
- If the installation config was lost but `receipt.json` was kept, `resume` and `update` regenerate the config from the receipt before any wrangler call that reads it.
- One setup run per installation: `<state-dir>/.<install>-<env>.lock`. Delete it only if no setup process is running.

### Re-bootstrapping a workspace

The installer never re-bootstraps a completed installation on its own: F2 exists so that drift cannot create an empty writable workspace. Re-bootstrap only when `verify` reports `workspace_uninitialized` at the Worker's own `workers.dev` URL, the receipt's `workspaceId`, jurisdiction and names match the installation config, and no data is expected in the object (for example, the namespace was deleted). Do not re-bootstrap for `workspace_identity_mismatch`, `workspace_recovery_epoch_mismatch` or `workspace_schema_unsupported`; those are configuration or restore problems (RUNBOOK). To proceed, remove all three of `workspace-init`, `bootstrap-clear` and `verify` from `receipt.phases` and run `resume --yes`. A receipt that still records `bootstrap-clear` without `workspace-init` is inconsistent. `update` refuses it (exit 2, "refusing to deploy (update) with WORKSPACE_BOOTSTRAP …") before anything is deployed or rewritten. It redeploys with the recorded bootstrap state, waits for the object at `workers.dev`, clears the bootstrap and verifies. Secrets and the epoch are unchanged. To restore data, create an import target instead (`--import-target`, RUNBOOK OPS-02/OPS-03).

## State files

`<state-dir>/<install>-<env>/` (default `cloudflare/installations/`, gitignored) holds no secret values. Back it up: the receipt is the existing-install identity that `update` and `resume` require.

- `receipt.json`: `formatVersion`, `install`, `env`, `accountId`, `names`, `workspaceId`, `jurisdiction`, `provider`, `bootstrap`, `origin`/`originSource`, `workersDevUrl`, `epochFingerprint` (`sha256:` + 16 hex of the epoch), `resources` (per name: `kind`, `attempts` [`at`, and `commit` for the Worker], queue `id`, `createdAt`, `observedAt`), `secrets` (`attemptedAt`, `epochGeneratedAt`), `operatorToken` (destination, path only, `writtenAt`), `providerHistory` (after `--change-provider`), `phases`, `deployments` (`purpose`: `initial`, `origin`, `workspace-init`, `bootstrap-clear`, `update`; `commit`, `workerSha256`, `appBaseUrl`, `bootstrap`, `provider`, `at`), `lastVerification` (status, failed check ids, targets), timestamps.
- `wrangler.jsonc`: the current template with installation-owned fields only (`name`, `account_id`, vars values, queue names). It passes `deploy.mjs`'s `configDrift()`. Do not edit it; `update` regenerates it and refuses if it was changed, and `config` rewrites it without deploying.

After an operator rotates the epoch during a restore (RUNBOOK, OPS-03), `epochFingerprint` no longer describes the bound epoch; the installer never reads or changes the epoch.

## Update

`update` requires the receipt, a completed installation (through `bootstrap-clear`), `--yes` and a ready artifact. It first checks, read-only, that:

- the Worker exists;
- both queues exist with the ids recorded at creation;
- every required secret name is bound;
- the installation config still matches the receipt (a missing config is regenerated from the receipt).

It then regenerates the config from the current template plus the receipt (`WORKSPACE_BOOTSTRAP=''`), deploys, records the deployment and runs `verify`.

It refuses without deploying:

- a jurisdiction change (a data migration);
- an origin change or an account change;
- `--import-target`;
- a provider change without `--change-provider`;
- any drift.

It never creates, deletes or rotates anything. The one exception: `--change-provider --provider <name>` uploads the new provider's key alone when it is not yet bound.

After the deploy:

- A workspace the operator left `draining`, `frozen` or in `recovery` gives exit 3 with the deployed version. The RUNBOOK drains before a deploy. Run `verify` after reopening.
- Any other verification failure gives exit 1 with the rollback pointer.

Roll back a code-only release by running `update` from the older commit (RUNBOOK, OPS-03). The maintained instance rolls back through CI instead ([below](#maintained-instance-ci-promotion)).

## Config only (`config`)

```bash
npm run setup:cloudflare -- config --install <name> --env <production|staging> [--json] [--state-dir <dir>]
```

`config` rewrites `<state-dir>/<install>-<env>/wrangler.jsonc` from `receipt.json` and the current `wrangler.jsonc`, the same file `update` generates, with `WORKSPACE_BOOTSTRAP` `""`. It prints the file's path as the last line of stdout; with `--json`, stdout carries one JSON result with `path`, `worker`, `appBaseUrl` and `provider`. The file passes `deploy.mjs --check-config` as written. `config` makes no wrangler, deploy, git or network call, leaves the receipt unchanged and holds the installation lock while it writes.

It refuses (exit 2) and writes nothing:

- without a receipt (`no receipt for <install> (<env>) at …`);
- when the receipt lacks `bootstrap-clear`, or records it without `workspace-init` (`installation <install> (<env>) is not complete: WORKSPACE_BOOTSTRAP has not been cleared`). Finish the installation with `resume` first;
- with any option that asks for a change: `--provider`, `--jurisdiction`, `--origin`, `--account-id`, `--import-target`, `--secrets-stdin`, `--operator-token-file`, `--reveal-operator-token`, `--change-provider` or `--yes`;
- when the generated config fails the local check that `verify --config` applies.

Use it to produce `CLOUDFLARE_INSTALL_CONFIG` for the CI promotion ([below](#maintained-instance-ci-promotion)), and to replace a lost or hand-edited config without deploying.

## Verify

`verify` reads `/api/health/ready`, `/api/config/readiness` and `/api/config/mode` from the Worker's own `workers.dev` URL. The deploy output ties that URL to this Worker's name. When the origin is a custom domain, it also reads them from the origin, and both must report the same state. It also compares the local installation config with the receipt.

It requires:

- `ready: true`, `target: cloudflare`, and the `workspaceStore` and `analysisQueue` checks;
- `mode: standalone`, `analysisExecution: queued-v2`, `aiTransport: direct`;
- no readiness errors and no Redis checks or error codes.

Without a recorded `workers.dev` URL of this Worker it reports not-ready: the template keeps `workers_dev: true`, and every deploy re-enables it. It never authenticates, writes, dispatches work or calls a provider, and never prints secrets.

### Verify without a receipt (`--config`)

```bash
npm run setup:cloudflare -- verify --config <installation wrangler.jsonc> [--wait-seconds <n>] [--json]
```

This form checks a deploy made outside the installer, such as the CI promotion. It reads no receipt and writes nothing.

- **Config checks.** The required vars are set. `WORKSPACE_BOOTSTRAP` is empty. The config selects `cloudflare`/`standalone`/`direct`. `WORKSPACE_ID` is `ws_` followed by 32 hex characters. The jurisdiction is `eu`, `fedramp` or empty. `APP_BASE_URL` is HTTPS. Template drift is also reported.
- **Readiness.** It probes `APP_BASE_URL` with the same readiness rules as `verify`. A held workspace ends the wait.
- **Exit codes.** `0` ready. `1` not ready, or a config problem. `2` refused: a missing file, or options other than `--json` and `--wait-seconds`. `3` held.
- **Limits.**
  - The receipt is not read or updated.
  - The deployed version and remote vars or secrets are not read back.
  - Without a receipt, the Worker's own `workers.dev` URL is unknown, so another Worker answering `APP_BASE_URL` would look the same.

It does not verify (remote gates in [04 — verification and cutover](04-verification-and-cutover.md), `VERIFY-04`):

- Queue consumption: `analysisQueue` is binding presence only.
- Durable Object alarm wake-up after inactivity.
- Protected logs (no invocation logs or raw participant URLs).
- Point-in-time recovery and operational restore.
- Live provider compatibility (needs a separately authorized smoke).
- Canonical-origin cookies, sign-in and the participant flow.
- The deployed version and remote vars or secrets. `Version` is the last deploy this installer recorded, so a CI promotion, a `wrangler rollback` or a dashboard deploy goes unnoticed.
- For a custom origin: that the origin is routed to this Worker. Another Worker answering the origin looks the same. The public endpoints expose no installation fingerprint to compare.

## Maintained instance: CI promotion

The project's own production installation has one deployment owner once it is installed: the `promote-cloudflare` job in `.github/workflows/ci.yml`. The installation is created once with `setup:cloudflare apply`, like any other. From then on CI deploys it and a workstation does not, with one exception: a provider change is made with `update --change-provider` from the workstation that holds the receipt, which binds the new key when needed and deploys. Hold CI promotions while it runs, then update the variable below. Operating it (dispatch, outcomes, cancelled deploys, rollback) is described in [RUNBOOK.md](RUNBOOK.md#maintained-instance-ci-promotion). The job has only been checked statically; it has never run on GitHub Actions.

### One-time setup

Configure the following in the GitHub repository settings:

| Item | Kind | Value |
| --- | --- | --- |
| `cloudflare-production` | Environment (Settings → Environments) | Required reviewers, so the job waits for approval before it starts. Limit deployment branches to `main`. |
| `CLOUDFLARE_API_TOKEN` | Environment secret | An API token limited to the installation's account and able to deploy this Worker. The minimal permission set is a remote rehearsal item; record it once staging establishes it. Only the deploy step receives the token: the release check and the verify step run without it. |
| `CLOUDFLARE_ACCOUNT_ID` | Environment variable | The installation's account id (the receipt's `accountId`). |
| `CLOUDFLARE_INSTALL_CONFIG` | Environment variable | The complete contents of the file that `npm run setup:cloudflare -- config --install <install> --env production` writes and whose path it prints (`cloudflare/installations/<install>-production/wrangler.jsonc`). `config` refuses until `receipt.phases` includes `bootstrap-clear` and `workspace-init`, so the file always has `WORKSPACE_BOOTSTRAP` `""`. It holds no secrets: names, vars and queue names only. |

Keep `CLOUDFLARE_INSTALL_CONFIG` current by running `config` again and replacing the variable with the new file:

- **After `update --change-provider`.** The receipt and the local config switch `AI_PROVIDER`, but the variable does not. CI would then deploy the old provider again. Both keys stay bound, so readiness would not notice.
- **After any release that changes `wrangler.jsonc` outside the installation-owned fields (`name`, var values, `routes`, `workers_dev`, `account_id`, queue names), for example the compatibility date or flags, Durable Object migrations or bindings, var names or queue settings.** The config check (`configDrift` in `deploy.mjs`) then refuses the stored copy (`installation config drifts from wrangler.jsonc in: …`). Run `config` from a checkout of that release; it regenerates the file without deploying.
- **Never with a bootstrap value.** `config` never writes one. The job refuses a bootstrap config before the release check, and `deploy.mjs` refuses it again before upload.

### What the job checks

The steps run in this order:

1. **Required jobs.** The quality, browser, redis-crash, adversarial and cloudflare jobs of the same run must pass for the dispatched `main` commit.
2. **Config check.** `node scripts/cloudflare/deploy.mjs --install <config> --check-config` runs before `npm ci` and uploads nothing. It checks template drift, the required vars (`APP_BASE_URL`, `WORKSPACE_ID`, `AI_PROVIDER`) and an empty `WORKSPACE_BOOTSTRAP`.
3. **Release check.** `npm run check:cloudflare` builds the artifact from the clean checkout, runs the full release matrix including the restart lane, and writes the receipt.
4. **Deploy.** `npm run deploy:cloudflare -- --install <config> --confirm`, never with `--bootstrap`. Before uploading, it re-checks the config, the passing receipt and the artifact against the checkout: commit, lockfile, template, bundle hashes, and a clean tree including untracked files.
5. **Readiness.** `node scripts/cloudflare/setup.mjs verify --config <config> --wait-seconds 180` checks readiness at `APP_BASE_URL`. Exit 3 (held) becomes a warning; any other failure fails the job.

The job does not:

- **Update the installer receipt.** The receipt's `deployments`, and the `Version` that `verify --install` reports, stay at the last installer deploy. Keep the receipt anyway: it is the installation identity that `update` and `resume` require.
- **Compare against the receipt.** It skips the checks `update` makes there: queue ids, bound secret names and installation identity.
- **Prove the origin.** It does not show that `APP_BASE_URL` is served by this Worker.
- **Prepare the deploy.** It does not drain the workspace or record the RUNBOOK's pre-deploy items.

## Manual steps outside the installer

- A Workers Paid subscription (recommended; billing is not automated).
- A `workers.dev` subdomain for the account, if none is registered (Workers & Pages → Account details), before origin discovery.
- Custom-domain origins: attach the domain to the Worker (Worker → Settings → Domains & Routes) after the first deploy. The workspace is initialized and its bootstrap cleared through the Worker's `workers.dev` URL. The final `verify` phase then waits for the origin to answer; run `resume` once the domain is routed. The installer never changes DNS or routes.
- For a custom domain on your zone, turn Pseudo IPv4 off (zone Network settings) as `RT-07` requires.
- Do not connect Workers Builds to this Worker: `SETUP-05` requires one deployment owner, either the installer or the CI promotion job.
- For the maintained instance, the one-time CI promotion setup ([below](#maintained-instance-ci-promotion)).

## Origin discovery

Without `--origin`, the first deploy goes out with an empty `APP_BASE_URL` and the installer reads the Worker's `workers.dev` URL from the `Deployed <worker> triggers` block of the deploy output. `deploy.mjs` accepts an empty `APP_BASE_URL` only in a bootstrap configuration (`WORKSPACE_BOOTSTRAP` `open` or `recovery`), which it in turn accepts only with the installer's `--bootstrap`; until the origin phase sets it, the Worker reports not-ready and refuses participant and researcher writes. If a deploy script refuses the empty origin anyway, the installer stops with nothing uploaded and asks for `--origin https://oi-<install>.<subdomain>.workers.dev` (checked against the deploy output) or a custom domain.

## What is and is not verified

Locally (`npm run test:setup:cloudflare`, simulated account):

- `plan` writes nothing.
- A fresh apply:
  - creates each queue once;
  - uploads all seven secret names in one stdin call;
  - never places a secret value in argv, in any child environment variable, in the receipt, in the config or in output;
  - discovers the origin;
  - initializes the workspace through the Worker's own URL, then clears the bootstrap.
- Resume after an interruption:
  - after interruptions before and after queue creation, deploy and secret upload, it continues without duplicates or rotation;
  - it refuses a foreign queue, Worker or secret set, whether a receipt record is absent or the timestamps and message do not match;
  - it refuses a queue name taken during creation;
  - it refuses a jurisdiction change;
  - it never writes to or adopts an operator-token path planted after preflight.
- A custom origin answered by another installation does not stand in for this Worker's workspace.
- Repeated apply/resume is a no-op.
- `update`:
  - keeps names, vars and secret digests;
  - regenerates a lost config;
  - reports a drained or frozen workspace as held.
- Refused before any write: collisions, drift (including a recreated queue), jurisdiction, provider, origin and account changes, invalid credentials, and a non-public compliance region.
- Staging is isolated.
- Generated configs pass the real `deploy.mjs` `configDrift()`.
- The installer's deploys pass `--bootstrap` exactly for fresh, import-target and re-bootstrap initialization, and `update` never passes it. `update` refuses a receipt with inconsistent phases and leaves the config unchanged. The fake deploy enforces the same rule through the real `bootstrapProblems()`.
- `verify --config`:
  - reports ready, not ready, held and each config problem;
  - is read-only;
  - refuses a missing file or mixed options.
- `config` (`tests/setup-cloudflare/config-command.test.mjs`):
  - after the config is deleted or hand-edited, rewrites it identical to the one the installer deployed, and the result passes the real `deploy.mjs --check-config`;
  - makes no wrangler, deploy or git invocation and no HTTP request, and leaves the receipt byte-identical;
  - refuses, writing nothing, before `bootstrap-clear`, with `bootstrap-clear` but no `workspace-init`, without a receipt and with a change option.
- An untracked source file in the checkout makes `apply` refuse before any remote write.
- `deploy.mjs` itself, in temporary checkouts (`tests/setup-cloudflare/deploy.test.mjs`):
  - every artifact precondition (commit, dirty flags, lockfile, template, bundle hashes, receipt);
  - the `--bootstrap` rule;
  - `--check-config`;
  - strict argument parsing.
- The CI workflow, statically (`tests/setup-cloudflare/ci-workflow.test.mjs`):
  - the promotion job's condition, needs and step order;
  - that no step passes `--bootstrap`;
  - which runs may cancel which, by GitHub's documented concurrency rules.

  No Actions runner or dispatch was used.

The fake wrangler follows wrangler 4.136.3 (checked against its `--help` and `wrangler-dist/cli.js`):

- it accepts only each command's flags;
- it fails on a missing `--config` file;
- it prefers a config `account_id` over `CLOUDFLARE_ACCOUNT_ID`.

The fake deploy prints the bindings table with var values before the triggers block.

Not verified:

- Real `wrangler` output and error codes against a live account: the queues table and its `created_on` format, `[code: 10007]`, `[code: 11009]`, `secret list` JSON, and whether `deployments list --json` carries the `workers/message` annotation on deployments. Ownership falls back to timestamps alone without that annotation.
- Real uploads and the deploy output URL format.
- Durable Object initialization under a real bootstrap.
- Custom-domain routing and token permissions.
- The CI promotion on GitHub Actions: the environment's protection rules, the token's permissions, and a real dispatch, deploy and readiness check.

These belong to the staging rehearsal (`VERIFY-04`: clean install under custom names, repeated install/update without duplicates or rotation, and interrupted setup recovery).
