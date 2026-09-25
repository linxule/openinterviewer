# Cloudflare installer (`setup:cloudflare`)

The installer creates and updates an OpenInterviewer standalone installation on Cloudflare: one Worker (OpenNext fetch, analysis Queue consumer and the `WorkspaceStore` Durable Object), one analysis Queue and its dead-letter queue, and, on the Cloudflare AI Gateway transport, the installation's own AI Gateway. It implements `SETUP-01`, `SETUP-02`, `SETUP-03`, `SETUP-08` and the local parts of `SETUP-07` in [01 — runtime and installation](01-runtime-and-installation.md). `SETUP-05` (one deployment owner): the installer owns every installation, including the project's maintained instance ([Maintained instance](#maintained-instance)). An installation may instead hand deployment to the `promote-cloudflare` CI job after the installer has created it ([Optional: CI-owned deployment](#optional-ci-owned-deployment)). Maintenance, backup, restore and rollback procedures are in [RUNBOOK.md](RUNBOOK.md).

Status: exercised only against a simulated account (a fake `wrangler`, a fake deploy script, a local fake origin and a local fake of the Cloudflare API's AI Gateway routes and the gateway endpoint; `npm run test:setup:cloudflare`). It has not run against a real Cloudflare account. See [What is and is not verified](#what-is-and-is-not-verified).

## Before you start

- Node 24.19+ and `npm ci` in a clean checkout of the commit you will deploy. Clean means no uncommitted changes and no untracked files that `.gitignore` does not cover (`git status --porcelain --untracked-files=normal`). Keep files you add for the installation, such as an `op inject` template, outside the checkout. In a dirty checkout:
  - `build:cloudflare` still builds, but records `"dirty": true` in the artifact manifest and its `Artifact ready` line shows `source <commit> dirty`. Such an artifact is never deployable.
  - `check:cloudflare` refuses before any lane: `error: check:cloudflare requires a clean checkout: commit, stash (git stash -u) or remove uncommitted and untracked files first`.
  - `deploy:cloudflare` lists `✗ checkout has uncommitted or untracked files` and ends with `error: deploy preconditions failed; nothing was uploaded`.
  - `plan` reports the artifact as `not ready` with the line `checkout has uncommitted or untracked files`. `apply`, `resume` and `update` refuse (exit 2) before any remote write with `error: the release artifact is not ready for deployment`, followed by that line.
- `wrangler` authenticated for the target account: `node_modules/.bin/wrangler login` (default config location), or `CLOUDFLARE_API_TOKEN` in the environment. The exact minimal API-token permissions are a remote rehearsal item.
- Every wrangler the installer starts, including the one inside `deploy.mjs`, gets the same environment: a minimal base plus `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The installer ignores, and reports that it ignored, `XDG_CONFIG_HOME`, the proxy variables and `NODE_EXTRA_CA_CERTS`, because `deploy.mjs` does not forward them. It refuses a non-public `CLOUDFLARE_COMPLIANCE_REGION`. An environment that needs these settings is unsupported until both allowlists are extended together.
- A checked release artifact for the current clean commit: `npm run build:cloudflare`, then `npm run check:cloudflare`, the local release check that writes a passing `dist/cloudflare/artifact/receipt.json` (it rebuilds the artifact unless given `-- --skip-build`). `plan` reports readiness; `apply` and `update` refuse without it.
- An administrator password of at least 16 characters and the API key of the default provider you select (`--provider`). You may bind the keys of the other providers too, at install (`--provider-keys`) or later (`update --add-provider-key`). Every credential must be independent. The password also has a maximum. Cloudflare sign-in reads at most 1 KiB of request body, so the installer refuses a password whose sign-in body (`JSON.stringify({ password })`, UTF-8) is over 1,024 bytes. That allows 1,009 ASCII characters, and fewer with multi-byte characters or characters JSON escapes (`"`, `\`, control characters, unpaired surrogates). `npm run setup:check -- --target cloudflare` reports a longer one as `env.ADMIN_PASSWORD.too_long`, and the deployed Worker reports a longer bound value as the readiness error `admin_password_too_long`.
- For the Cloudflare AI Gateway transport (`--ai-transport cloudflare-gateway`, RT-11), two more credentials:
  - `CF_AI_GATEWAY_ADMIN_TOKEN`, in the installer's environment only: a Cloudflare API token for the installation's account with AI Gateway Read and Edit (the API reference names the permission "AI Gateway Write"; the exact minimal set is a remote gate). The installer creates and reads the gateway with it. It is never bound to the Worker, passed to `wrangler` or `deploy.mjs`, written to a file or printed; `wrangler login` OAuth has no AI Gateway scope, so wrangler's own credentials cannot do this.
  - `CF_AI_GATEWAY_TOKEN`, on protected input like the other credentials: an AI Gateway Run token the Worker sends as `cf-aig-authorization`. Create it in the dashboard (AI → AI Gateway → Create authentication token) for this account. It can send through every gateway in the account (Cloudflare does not scope it to one). At least 32 characters, no whitespace, independent of every other credential.
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
| `update` | Deploys the current checked artifact to an existing installation (`--yes`), runs one provider-key, Run-token or administrator-password operation without deploying ([Provider keys](#provider-keys), [Administrator password](#administrator-password)), or switches the provider or the AI transport and deploys ([AI transport](#ai-transport-cloudflare-ai-gateway)). |
| `config` | Local only. Rewrites the installation config from the receipt and the current `wrangler.jsonc` and prints its path; no wrangler, deploy, git or network call ([Config only](#config-only-config)). |

| Option | Meaning |
| --- | --- |
| `--install <name>` | 1–24 of `[a-z0-9-]`, starting and ending with a letter or digit; the `-staging` suffix is reserved. |
| `--env <production\|staging>` | Staging always gets a separate Worker, Queue, DLQ, secrets, workspace and origin. |
| `--provider <gemini\|claude\|openai\|openrouter>` | The installation's default provider (`AI_PROVIDER`: the sample study and studies without their own provider); its key is always required. |
| `--provider-keys <p[,p…]\|all>` | `apply` only: the provider keys to bind, comma-separated or `all`. Defaults to the `--provider` key and must include it. On `resume` it must match the receipt. |
| `--ai-transport <direct\|cloudflare-gateway>` | `apply`: the installation's AI transport (default `direct`); on `resume` it must match the receipt. `update`: the target of `--change-ai-transport`. `cloudflare-gateway` needs `CF_AI_GATEWAY_ADMIN_TOKEN` in the environment and `CF_AI_GATEWAY_TOKEN` on protected input. The Vercel `gateway` value is refused (Node only). |
| `--jurisdiction <eu\|fedramp\|none>` | Required explicitly on first apply (recommended `eu`). Recorded and never changed by `update`. |
| `--origin <https://host>` | Final origin. Without it the `workers.dev` URL is discovered from the first deploy. HTTPS only; no credentials, path, query, fragment, IP address or local host. |
| `--account-id <id>` | Required when the credentials can reach several accounts. Must match the receipt and `CLOUDFLARE_ACCOUNT_ID` if set. |
| `--import-target` | Initialize the fresh workspace in `recovery` for an operational import (RUNBOOK). |
| `--secrets-stdin` | Read `{"ADMIN_PASSWORD": "...", "<PROVIDER>_API_KEY": "...", ...}` from stdin: exactly the password, one key per `--provider-keys` entry and, with `cloudflare-gateway`, `CF_AI_GATEWAY_TOKEN` (update operations: exactly the named keys, the Run token, or the password alone). Without it, a no-echo terminal prompt asks (the password twice). |
| `--operator-token-file <path>` | Write the generated `OPERATOR_TOKEN` once, mode 0600. Must be outside the repository and the state directory, in an existing directory other users cannot write to (or one with the sticky bit). The file is created exclusively and never through a symbolic link. |
| `--reveal-operator-token` | Print the generated `OPERATOR_TOKEN` once; only to an interactive terminal and not with `--json`. |
| `--change-provider` | `update` only, with `--provider <name>`: switch `AI_PROVIDER`; asks for that provider's key (stdin JSON with `--secrets-stdin`, or a prompt) only if it is not bound, and records it in `providerKeys`. |
| `--add-provider-key <p[,p…]>` | `update` only: bind the named provider keys in one secret upload; no deploy. |
| `--rotate-provider-key <p>` | `update` only: replace one recorded provider key in one secret upload; no deploy. |
| `--change-ai-transport` | `update` only, with `--ai-transport <t>`: switch `AI_TRANSPORT`, then deploy ([AI transport](#ai-transport-cloudflare-ai-gateway)). |
| `--rotate-ai-gateway-token` | `update` only: replace the bound Run token after probing the new one; one secret upload; no deploy. |
| `--rotate-admin-password` | `update` only: replace `ADMIN_PASSWORD` (stdin JSON with `--secrets-stdin`, or the hidden prompt, asked twice); one secret upload; no deploy ([Administrator password](#administrator-password)). |
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

To bind several providers' keys at once, add `--provider-keys` (for example `--provider-keys all`) and put every key in the stdin JSON: `{"ADMIN_PASSWORD": …, "GEMINI_API_KEY": …, "ANTHROPIC_API_KEY": …, "OPENAI_API_KEY": …, "OPENROUTER_API_KEY": …}`. They go up in the same single `wrangler secret bulk` call.

To send provider requests through the installation's own Cloudflare AI Gateway (RT-11), add `--ai-transport cloudflare-gateway`, put the Run token in the stdin JSON as `CF_AI_GATEWAY_TOKEN`, and give the management token to the installer process only:

```bash
# ~/secure/cf-admin.env (outside the checkout): CF_AI_GATEWAY_ADMIN_TOKEN=op://<vault>/<item>/credential
op inject -i ~/secure/secrets.tpl.json | op run --env-file ~/secure/cf-admin.env -- \
  npm run setup:cloudflare -- apply --install acme --env production --provider gemini --provider-keys all \
  --ai-transport cloudflare-gateway --jurisdiction eu --operator-token-file ~/secure/acme-operator-token \
  --secrets-stdin --yes
```

`plan --ai-transport cloudflare-gateway` lists the gateway (read only with the management token), the two gateway vars and `CF_AI_GATEWAY_TOKEN`, and notes that AI Gateway is not covered by `--jurisdiction` (Cloudflare may process requests at any location), that the Run token is account-wide, and that provider billing is unchanged (each request carries the installation's own key; no Unified Billing or stored keys).

Omit `--secrets-stdin` to type the credentials at a hidden prompt. On success the installer prints the URL, Worker/Queue names, deployed commit, receipt path and the verification limitations.

## Phases

Each phase is recorded in `receipt.phases` only after its effect is observed, and every phase is safe to replay.

| # | Phase | Effect | Observed by |
| --- | --- | --- | --- |
| 1 | `preflight` | Environment allowlist check; `wrangler whoami`; account, provider, jurisdiction and origin checks; artifact readiness when a deploy is pending; collision check on a fresh install; credentials and operator-token destination read and validated. No remote write. | command results |
| 2 | `identity` | Derives names; generates `WORKSPACE_ID` (`ws_` + 32 hex) and `ANALYSIS_RECOVERY_EPOCH` (`ep_` + 32 hex). The receipt (workspace ID, epoch fingerprint) is written before any remote write. | receipt on disk |
| 3 | `resources` | Refuses any existing queue this installation cannot show it created; then `wrangler queues create` for each absent queue, recording the attempt first and the queue id after. | `wrangler queues list` (all pages) |
| 4 | `ai-gateway` | `cloudflare-gateway` only; a direct installation never records it. Reads the gateway (id = the Worker name). If absent: supersedes a recorded gateway that no longer exists (deleted by hand; its record moves to `aiGateway.superseded`), records an attempt, creates it once with `authentication: true`, `collect_logs: false`, `cache_ttl: 0`, `cache_invalidate_on_update: false`, rate limiting 0 and `byok_only: true` (retries, DLP, Guardrails, Logpush, OTel, `store_id` and `zdr` unset), and reads it back. If present: adopts it only on evidence ([below](#interruption-and-resume)). Refuses a gateway whose settings break the policy ([AI Gateway policy](#ai-gateway-policy)) and never changes or deletes it. Records the settings digest. Probes it without a provider call: with no token it must answer 401 `AiGatewayError` 2009, with the supplied Run token 400 `AiGatewayError` (no provider key); anything else, including any 2xx, stops the installer. | Cloudflare API `GET …/ai-gateway/gateways/<id>`; the gateway endpoint |
| 5 | `config` | Writes the installation `wrangler.jsonc` (on the gateway: `AI_TRANSPORT=cloudflare-gateway`, `CF_AI_GATEWAY_ACCOUNT_ID` = the account, `CF_AI_GATEWAY_ID` = the gateway; otherwise both empty). | local |
| 6 | `deploy-initial` | Refuses an existing Worker this installation cannot show it deployed; records the attempt, then `deploy.mjs --install <config> --confirm --bootstrap` with `WORKSPACE_BOOTSTRAP=open` (`recovery` for an import target). Records the `workers.dev` URL from the `Deployed <worker> triggers` block of the output. | `wrangler deployments list --name <worker>` |
| 7 | `secrets` | Generates `SESSION_SECRET`, `PARTICIPANT_TOKEN_SECRET`, `RATE_LIMIT_SALT`, `OPERATOR_TOKEN` (32 random bytes each, base64url); writes the operator token file; sends them with `ADMIN_PASSWORD`, every `--provider-keys` key, the Run token (gateway) and the epoch in one `wrangler secret bulk` call on stdin. | `wrangler secret list` (names) |
| 8 | `origin` | Discovered: the output URL must be `https://<worker>.<subdomain>.workers.dev`. Explicit `workers.dev` origins must equal that URL. Sets `APP_BASE_URL` and redeploys if the deployed value differs. | deploy output |
| 9 | `workspace-init` | Polls the Worker's own `workers.dev` URL, never the origin, until its fresh object initialized under the bootstrap state (`recovery`: readiness reports only `workspace_maintenance`). Keeps polling within `--wait-seconds` while readiness reports `workspace_uninitialized` or `workspace_unconfigured`: right after `wrangler secret bulk` the object can briefly run the version whose env has no epoch yet (seen on staging, 24 September 2026). Stops at once on `workspace_identity_mismatch`, `workspace_recovery_epoch_mismatch` or `workspace_schema_unsupported`. Redeploys with the bootstrap state first if the running version no longer carries it (re-bootstrap only). | readiness endpoints at `workers.dev` |
| 10 | `bootstrap-clear` | Sets `WORKSPACE_BOOTSTRAP=''` and redeploys without `--bootstrap` (gap review F2). | deploy result |
| 11 | `verify` | The `verify` checks; an import target may be held in `recovery`. A custom origin must answer by now. On the gateway with the management token, also the gateway settings and zero stored logs. | readiness endpoints; Cloudflare API |

Every deploy whose config still carries a bootstrap value passes `--bootstrap` to `deploy.mjs`; those are phases 6, 8 and 9. `deploy.mjs` refuses `WORKSPACE_BOOTSTRAP` `open` or `recovery` without that flag, and any other non-empty value always. Before it rewrites the config, the installer refuses (exit 2) any other deploy while the receipt lacks `workspace-init`.

Names: Worker `oi-<install>` (`oi-<install>-staging`), Queue `<worker>-analysis`, DLQ `<worker>-analysis-dlq`, AI Gateway `<worker>` (so staging has its own; never `default`). They are derived on first apply and afterwards read from the receipt.

## Interruption and resume

Run `resume` with the same `--install`/`--env`. If the secrets phase had not completed, pass the credentials again and an operator-token destination (`--operator-token-file`, which may be the same path if this installation wrote it, or `--reveal-operator-token`). Rules:

- The workspace ID and names are never regenerated.
- The epoch exists only in memory until the secrets phase completes. If apply stops before the secrets were bound, resume generates a fresh epoch and records its fingerprint before uploading. Once bound, the epoch and the generated secrets are never regenerated or rotated by apply, resume or update; a provider key is replaced only by `update --rotate-provider-key`, and the administrator password only by `update --rotate-admin-password`.
- The installer never adopts unrelated resources and never deletes anything. A receipt attempt marker alone never proves ownership, because it is written before the remote call and survives calls that never landed. An existing resource with an installation name counts as this installation's only on evidence:
  - Queue: its id matches the id recorded when this installation created it. Or, after a lost reply, the queue's `created_on` from `queues list` falls within a recorded create attempt: from 5 minutes before the attempt to 2 minutes (the wrangler call timeout) plus 5 minutes after it.
  - Worker: it was observed after this installation's own completed deploy. Or, after a lost reply, every deployment in `deployments list` falls within a recorded deploy attempt window (15-minute deploy timeout, ±5 minutes). Any deployment message on it must also be `openinterviewer <commit>` for an attempted commit.
  - AI Gateway: it was observed by this installation before and still has the `created_at` recorded then. Or, after a lost reply, its `created_at` falls within a recorded create attempt: from 5 minutes before the attempt to 30 seconds (the API call timeout) plus 5 minutes after it. The account's `default` gateway is never adopted. A fresh `apply` refuses an existing gateway with the installation's id before any remote write (collision).
  - Secrets: kept only when the whole set is bound and this installation recorded an upload attempt.
- A create that provably did nothing leaves no attempt behind. This covers a queue name reported as taken, which is a collision, a gateway create answered 409, and a `deploy.mjs` refusal before upload ("nothing was uploaded").
- The gateway phase needs the Run token from the same run's protected input, and the management token; resume therefore asks for the credentials again whenever that phase had not completed (it always precedes `secrets`). A resume whose gateway phase completed earlier but whose `secrets` phase is pending also reads the Run token again, and probes it before any further write: a token the gateway rejects is refused and never uploaded. The gateway create is never retried within a run; reads are retried up to three times on a network failure, 429 or 5xx.
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

- `receipt.json` (format 2): `formatVersion`, `install`, `env`, `accountId`, `names`, `workspaceId`, `jurisdiction`, `provider` (the default provider), `providerKeys` (every provider whose key the installation binds; always includes `provider`), `aiTransport` (`direct` or `cloudflare-gateway`), `aiGateway` (only once the installation has used the gateway: `id` = the Worker name, `accountId`, `attempts` [`at`], `createdAt` (Cloudflare's, when first observed), `observedAt`, `settingsDigest` (`sha256:` + 16 hex of the policy fields), `settingsCheckedAt`, `probedAt`, and `superseded` [`createdAt`, `observedAt`, `attempts`, `missingAt`] for a recorded gateway that was deleted by hand and replaced; kept after a switch back to direct), `aiTransportHistory` (after `--change-ai-transport`: `from`, `to`, `at`), `bootstrap`, `origin`/`originSource`, `workersDevUrl`, `epochFingerprint` (`sha256:` + 16 hex of the epoch), `resources` (per name: `kind`, `attempts` [`at`, and `commit` for the Worker], queue `id`, `createdAt`, `observedAt`), `secrets` (`attemptedAt`, `epochGeneratedAt`), `operatorToken` (destination, path only, `writtenAt`), `providerHistory` (after `--change-provider`), `secretEvents` (key, token and password operations: `kind` (`add-provider-key`, `rotate-provider-key`, `ai-transport`, `rotate-ai-gateway-token` or `rotate-admin-password`), secret `names`, `uploaded`, `at`, `attemptedAt` when a rerun found an interrupted upload landed, and the `deploymentId` the upload created, if any; never values), `pendingChange` (only while an update operation is unfinished: `kind` `provider` with `from`/`to`, `add-provider-key` with `providers`, `rotate-provider-key` with `provider`, `ai-transport` with `from`/`to` and, once its token upload started, `tokenUploadAt`, `rotate-ai-gateway-token`, or `rotate-admin-password`; plus `startedAt`, and `deploymentBefore` for the key, token and password operations), `phases` (a direct installation has no `ai-gateway` entry: that phase counts as done once `resources` is), `deployments` (`purpose`: `initial`, `origin`, `workspace-init`, `bootstrap-clear`, `update`; `commit`, `workerSha256`, `appBaseUrl`, `bootstrap`, `provider`, `providerKeys`, `aiTransport`, `at`), `lastVerification` (status, failed check ids, targets), timestamps.
- `receipt.format1.json` (only for an installation first set up before format 2): the format-1 receipt migrated last, byte for byte, kept for a rollback to a pre-format-2 release. An earlier, different copy is moved aside as `receipt.format1.<n>.json`; no copy is ever overwritten.
- `wrangler.jsonc`: the current template with installation-owned fields only (`name`, `account_id`, vars values, queue names). It passes `deploy.mjs`'s `configDrift()`. Do not edit it; `update` regenerates it and refuses if it was changed, and `config` rewrites it without deploying.

A format-1 receipt (installers before 24 September 2026) is read and migrated in memory, and written back as format 2 by the next command that saves the receipt: `providerKeys` becomes its `provider` plus every provider in `providerHistory` (a provider change never deleted the old key), `aiTransport` becomes `direct`, `secretEvents` starts empty, and an unfinished `pendingProviderChange` becomes a `pendingChange` of kind `provider`. Nothing else changes. `verify` and `plan` read it without writing. A receipt with an unknown format, one whose `providerKeys` lacks `provider`, one with `cloudflare-gateway` but no `aiGateway`, or one whose `aiGateway` names another id or account, is refused (exit 2).

The migration is one-way except for one file. An installer from before format 2 refuses a format-2 receipt (`unsupported formatVersion 2`), so before the first save overwrites a format-1 `receipt.json`, the installer copies its exact bytes, with the same file mode, to `receipt.format1.json` in the same directory. After a rollback and a return forward, the next migration makes the copy the format-1 receipt the older installer left, with its deployments, and moves the earlier copy aside as `receipt.format1.<n>.json`; identical bytes are not copied again, and no copy is ever overwritten. Back it up with the receipt; without it a pre-format-2 release cannot be rolled back to with its own installer. Rolling back with it, what the older installer does and does not know, and returning forward are in the [runbook](RUNBOOK.md#rolling-back-to-a-release-before-receipt-format-2).

After an operator rotates the epoch during a restore (RUNBOOK, OPS-03), `epochFingerprint` no longer describes the bound epoch; the installer never reads or changes the epoch.

## Update

`update` requires the receipt, a completed installation (through `bootstrap-clear`), `--yes` and a ready artifact. It first checks, read-only, that:

- the Worker exists;
- both queues exist with the ids recorded at creation;
- every required secret name is bound, including every recorded provider key (a provider key bound on the Worker but not recorded in `providerKeys` is reported as a warning, and never used or changed);
- the installation config still matches the receipt (a missing config is regenerated from the receipt);
- on the gateway transport, when `CF_AI_GATEWAY_ADMIN_TOKEN` is set: the gateway exists, is the one recorded (same `created_at`) and meets the [policy](#ai-gateway-policy). Drift is refused; the installer never corrects it. Without the token `update` says the gateway was not checked. A bound `CF_AI_GATEWAY_TOKEN` on an installation that never used the gateway is reported like an unrecorded provider key.

It then regenerates the config from the current template plus the receipt (`WORKSPACE_BOOTSTRAP=''`), deploys, records the deployment and runs `verify`.

It refuses without deploying:

- a jurisdiction change (a data migration);
- an origin change or an account change;
- `--import-target`;
- a provider change without `--change-provider`;
- any drift.

It never creates or deletes anything, and never rotates the generated secrets or the epoch. Provider keys and the administrator password change only on an explicit operation: `--change-provider --provider <name>` uploads the new provider's key alone when it is not yet bound, the key operations below upload only the keys they name, and `--rotate-admin-password` uploads only the password. `update` runs one operation at a time.

A provider change is resumable. After the checks above and after reading the new key, `update` records a `pendingChange` of kind `provider` in the receipt, before it uploads the key or deploys. The receipt's `provider` and `providerHistory` change only after the deploy succeeds, in the same write that clears the record. If the change stops part way (a failed upload, a failed deploy, or a lost reply after the upload landed), rerun the same command, `update --provider <name> --change-provider --yes`. The installation config may then name either provider of the pending change. Any other difference is still drift. A key that is already bound is not asked for again, and the redeploy is safe after a lost reply. The history gets one entry, and the new provider joins `providerKeys`. While a change is pending, `update` refuses every other request (a plain update, another provider or the old one), and so do `resume`, `apply` and `config`, with the command that finishes it. `plan` lists it in `notes`. To go back, finish the change, then run `update --change-provider` to the old provider. Both keys stay bound, so no key is asked for.

After the deploy:

- A workspace the operator left `draining`, `frozen` or in `recovery` gives exit 3 with the deployed version. The RUNBOOK drains before a deploy. Run `verify` after reopening.
- Any other verification failure gives exit 1 with the rollback pointer.

Roll back a code-only release by running `update` from the older commit (RUNBOOK, OPS-03). An installation deployed by CI rolls back through CI instead ([below](#optional-ci-owned-deployment)).

### Provider keys

```bash
# Bind more providers' keys: one secret upload, no deploy, no config change.
op inject -i ~/secure/keys.tpl.json | npm run setup:cloudflare -- update --install acme --env production \
  --add-provider-key claude,openai --secrets-stdin --yes      # stdin: {"ANTHROPIC_API_KEY": …, "OPENAI_API_KEY": …}
# Replace one recorded key.
op inject -i ~/secure/gemini.tpl.json | npm run setup:cloudflare -- update --install acme --env production \
  --rotate-provider-key gemini --secrets-stdin --yes          # stdin: {"GEMINI_API_KEY": …}
```

- `--add-provider-key` refuses a provider already recorded (use `--rotate-provider-key`) and a key already bound on the Worker without a record: the receipt cannot vouch for its value, so delete it deliberately (`wrangler secret delete`) and add it again. `--rotate-provider-key` refuses a provider that is not recorded.
- Both run the drift checks above, need no release artifact and never deploy: Cloudflare applies a secret by deploying a new version of the Worker. Because that version is built from the Worker's latest version, both first require the newest deployment to be a checked release: it carries `deploy.mjs`'s `openinterviewer <commit>` message (an installer deploy or the CI promotion), or it is the deployment recorded after the previous key operation. A dashboard deploy, `wrangler rollback`, gradual deployment or manual `wrangler secret put` (for example the point-in-time restore's epoch rotation: its deployment carries `workers/triggered_by` `secret` and no message, observed 24 September 2026) is refused (exit 2); redeploy a checked release first (a plain `update`, or the CI promotion on an installation deployed by CI; after a restore, only once it is activated: RUNBOOK, point-in-time restore step 9).
- Each validates the new values (not blank, no whitespace, no placeholder, independent of each other), records a `pendingChange` before the upload, reads the names back, then records the event and the new `providerKeys` and runs `verify`. A lost reply or failed upload leaves the change pending: rerun the same command. A pending add does not ask again for a key whose upload landed; a pending rotation asks for the new key again. While it is pending, every other `update`, `resume`, `apply` and `config` refuses with the command that finishes it.
- The Worker reads keys per request, so a new or rotated key serves without a redeploy. `CLOUDFLARE_INSTALL_CONFIG` does not change: it holds vars, not secrets. Studies can use a newly bound provider at once; the study editor offers only providers whose key is bound.
- Removing a key is manual: `wrangler secret delete <NAME> --name <worker>` makes `update` report drift until the receipt is restored to match. A `--forget-provider-key` operation is not implemented yet.
- `update --rotate-ai-gateway-token --secrets-stdin --yes` (stdin `{"CF_AI_GATEWAY_TOKEN": …}`) replaces the Run token the same way. It needs a gateway this installation recorded and a bound token. Before anything is recorded or uploaded it probes the gateway with the new token (400 `AiGatewayError` expected, no provider key sent); a token the gateway does not accept is refused with nothing uploaded. It needs no management token.

### Administrator password

```bash
# Replace ADMIN_PASSWORD: one secret upload, no deploy, no config change.
op inject -i ~/secure/admin-password.tpl.json | npm run setup:cloudflare -- update --install acme --env production \
  --rotate-admin-password --secrets-stdin --yes             # stdin: {"ADMIN_PASSWORD": …}
# Or type it at the hidden prompt (asked twice):
npm run setup:cloudflare -- update --install acme --env production --rotate-admin-password --yes
```

- It is a key operation like `--rotate-provider-key`: the same drift checks, no release artifact, no deploy, and the same newest-deployment rule (a checked release, or the deployment recorded after the previous key operation). A manual `wrangler secret put ADMIN_PASSWORD` is exactly the kind of deployment that rule refuses; this operation replaces that manual procedure.
- The new password is read and validated before anything is recorded or uploaded, with apply's rules: at least 16 characters, a sign-in body of at most 1,024 bytes, not blank, no surrounding whitespace, no control characters, no template placeholder. With `--secrets-stdin` the JSON must hold `ADMIN_PASSWORD` and nothing else; without it the hidden prompt asks twice and refuses entries that differ. A refused value is never echoed, and nothing is written. The installer cannot read the bound generated secrets, so it cannot check that the password differs from them; the Worker can: a reused value makes readiness report `secrets_not_independent` and the verification after the upload fail (exit 1). Rotate again with an independent value.
- It records a `pendingChange` of kind `rotate-admin-password` before the upload, uploads `ADMIN_PASSWORD` alone through `wrangler secret bulk` on stdin, reads the names back, then records a `secretEvents` entry (`kind` `rotate-admin-password`, `names` and `uploaded` `["ADMIN_PASSWORD"]`, `at`, the `deploymentId` the upload created) in the same write that clears the pending record, and runs `verify`. The value is never written to the receipt, the config or output. A failed upload or a lost reply leaves the rotation pending: rerun the same command with the new password (the bound value may already be the new one or still the old one; uploading it again settles it). While it is pending, every other `update`, `resume`, `apply` and `config` refuses with that command, and `plan` lists it in `notes`.
- The Worker reads `ADMIN_PASSWORD` from its environment on each sign-in, so the new password applies once the new version serves; nothing is redeployed and `CLOUDFLARE_INSTALL_CONFIG` does not change.
- **Existing researcher sessions are not ended.** A researcher session is a JWT signed with `SESSION_SECRET` that carries no trace of the password (`src/lib/auth.ts`), valid for 7 days from sign-in; sign-out only deletes the cookie in that browser. Sessions signed in before the rotation therefore keep working until they expire, including a session opened with a leaked password. Operator routes additionally require a sign-in from the last 15 minutes, so an old session loses operator access within 15 minutes of its sign-in. The installer never rotates `SESSION_SECRET`; ending every session is a manual step (RUNBOOK, [administrator password](RUNBOOK.md#administrator-password)). The installer prints this after a rotation.

### AI transport (Cloudflare AI Gateway)

```bash
# direct → gateway: provisions or adopts the gateway, binds the Run token if it is not bound, deploys.
echo '{"CF_AI_GATEWAY_TOKEN": "…"}' | op run --env-file ~/secure/cf-admin.env -- npm run setup:cloudflare -- update \
  --install acme --env production --change-ai-transport --ai-transport cloudflare-gateway --secrets-stdin --yes
# gateway → direct: deploys with both gateway vars empty; needs no credential.
npm run setup:cloudflare -- update --install acme --env production --change-ai-transport --ai-transport direct --yes
```

- **To the gateway.** After the drift checks, a read-only check refuses a gateway with the installation's id that it cannot show it created. It reads the Run token only if `CF_AI_GATEWAY_TOKEN` is not bound, records a `pendingChange` of kind `ai-transport`, runs the [`ai-gateway` phase](#phases) (create or adopt, policy, probes), uploads the token alone, deploys with the gateway vars, records the `ai-gateway` phase and the history entry, and runs `verify` for the new transport. If the token was already bound (for example after a switch back to direct), it is kept and only the unauthenticated probe runs, because the installer cannot read the bound value; rotate it to probe a new one. A bound token is kept only when the receipt vouches for it (this installer probed or uploaded one); a token bound outside the installer is refused before any write: delete it (`wrangler secret delete CF_AI_GATEWAY_TOKEN`) and rerun with the token on protected input. If the recorded gateway was deleted by hand while on direct, the switch creates a new one and records it in its place.
- **To direct.** Deploys with `CF_AI_GATEWAY_ACCOUNT_ID` and `CF_AI_GATEWAY_ID` empty. The Run token stays bound (the Worker never sends it on direct) and the gateway is kept: the installer never deletes one. Switching back reuses both without input.
- **Consent (RT-11, D9).** Before acting, the installer prints what the switch means for participants (RUNBOOK, transport switch):
  - to the gateway: sessions consented under direct get 409 `TRANSPORT_NOT_DISCLOSED` on their next greeting or interview turn until the participant reopens the link and accepts the gateway notice; their saves succeed; interviews consented under direct are analyzed, retried, aggregated and used for follow-up only on direct. New consents disclose Cloudflare AI Gateway, which may process responses outside the EU; approved studies may need an ethics amendment for that notice.
  - to direct: covered for every consent, so gateway-consented sessions and interviews continue, sent straight to each provider; a consent page opened under the gateway notice gets 409 `DISCLOSURE_CHANGED` and is reopened.
  - Drain first (`draining`, then wait for no pending, claimed or started jobs and no active sessions, up to the 4-hour consent lifetime), switch, then reopen. The installer prints this rule but does not enforce it; the Worker enforces coverage either way.
- **Interruption.** A failed create, probe, upload or deploy leaves the change pending. Rerun the same command to finish it: an observed gateway is adopted, not created again, and a bound token is not asked for again. Rerunning with the transport it started from abandons it instead (deploys that transport again, no history entry). While it is pending, every other `update`, `resume`, `apply` and `config` refuses with those two commands.
- **CI.** On an installation deployed by CI, regenerate `CLOUDFLARE_INSTALL_CONFIG` with `config` after a transport change ([below](#optional-ci-owned-deployment)); key, token and password operations need no regeneration.

### AI Gateway policy

The installer uses a gateway only when it meets this policy (gw-final D7); it refuses (exit 2) otherwise and never changes (`PUT`) or deletes a gateway. Correct a refused setting deliberately in the dashboard (AI → AI Gateway → the gateway → Settings) and rerun.

- Refused: another id or the account's default gateway; `authentication` not `true`; `collect_logs` not `false`; `byok_only` not `true`; `cache_ttl` other than 0 or unset; `retry_max_attempts` other than unset or 1; `logpush` on; DLP configured (unless disabled); Guardrails with any category; any OTel exporter; a `store_id`.
- Warned: non-zero rate limiting (the gateway may answer 429 before the installation's own limits), spend limits, Stripe usage events, `log_classification`, `internal` other than absent or `false`, and any field the installer does not know (listed by name).
- Undocumented: the API also returns `internal` and `wholesale`, which its reference does not describe (seen as `false` and `true`, September 2026). `wholesale` is not checked: `byok_only` must be `true` and every request carries `cf-aig-no-wholesale: true`, so Unified Billing is never used whatever it says.
- The Worker sends `cf-aig-collect-log: false`, `cf-aig-skip-cache: true`, `cf-aig-max-attempts: 1` and `cf-aig-no-wholesale: true` on every request regardless (RT-11), so the gateway settings are a second line of defence.

## Config only (`config`)

```bash
npm run setup:cloudflare -- config --install <name> --env <production|staging> [--json] [--state-dir <dir>]
```

`config` rewrites `<state-dir>/<install>-<env>/wrangler.jsonc` from `receipt.json` and the current `wrangler.jsonc`, the same file `update` generates, with `WORKSPACE_BOOTSTRAP` `""`. It prints the file's path as the last line of stdout; with `--json`, stdout carries one JSON result with `path`, `worker`, `appBaseUrl`, `provider`, `providerKeys`, `aiTransport` and `aiGateway` (the gateway id, or null). The file passes `deploy.mjs --check-config` as written. `config` makes no wrangler, deploy, git or network call, leaves the receipt unchanged and holds the installation lock while it writes.

It refuses (exit 2) and writes nothing:

- without a receipt (`no receipt for <install> (<env>) at …`);
- when the receipt lacks `bootstrap-clear`, or records it without `workspace-init` (`installation <install> (<env>) is not complete: WORKSPACE_BOOTSTRAP has not been cleared`). Finish the installation with `resume` first;
- with any option that asks for a change: `--provider`, `--provider-keys`, `--jurisdiction`, `--origin`, `--account-id`, `--import-target`, `--secrets-stdin`, `--operator-token-file`, `--reveal-operator-token`, `--change-provider`, `--add-provider-key`, `--rotate-provider-key`, `--ai-transport`, `--change-ai-transport`, `--rotate-ai-gateway-token`, `--rotate-admin-password` or `--yes`;
- when the generated config fails the local check that `verify --config` applies.
- while an update operation is pending (`pendingChange` in the receipt): finish it first with the command the refusal names.

Use it to produce `CLOUDFLARE_INSTALL_CONFIG` for an installation deployed by CI ([below](#optional-ci-owned-deployment)), and to replace a lost or hand-edited config without deploying.

## Verify

`verify` reads `/api/health/ready`, `/api/config/readiness` and `/api/config/mode` from the Worker's own `workers.dev` URL. The deploy output ties that URL to this Worker's name. When the origin is a custom domain, it also reads them from the origin, and both must report the same state. It also compares the local installation config with the receipt.

It requires:

- `ready: true`, `target: cloudflare`, and the `workspaceStore` and `analysisQueue` checks;
- `mode: standalone`, `analysisExecution: queued-v2`, and `aiTransport` equal to the receipt's transport;
- no readiness errors and no Redis checks or error codes;
- on the gateway transport, when `CF_AI_GATEWAY_ADMIN_TOKEN` (AI Gateway Read suffices) is set for the run: `gateway.settings` (the gateway exists, is the recorded one and meets the [policy](#ai-gateway-policy); a settings digest that changed since it was recorded is noted) and `gateway.logs` (the logs listing reports a count, and it is 0). A failure gives the status `gateway-mismatch` (exit 1). Without the token, verify states that the gateway was not read.

A workspace whose only readiness error is `workspace_maintenance` is reported as held (exit 3) only when everything else identifies this installation, including `/api/config/mode` reporting `standalone`, `queued-v2` and the expected `aiTransport`. A held Worker on another transport is not ready (exit 1), like a ready one.

Without a recorded `workers.dev` URL of this Worker it reports not-ready: the template keeps `workers_dev: true`, and every deploy re-enables it. It never authenticates, writes, dispatches work or calls a provider, and never prints secrets.

### Verify without a receipt (`--config`)

```bash
npm run setup:cloudflare -- verify --config <installation wrangler.jsonc> [--wait-seconds <n>] [--json]
```

This form checks a deploy made outside the installer, such as the CI promotion. It reads no receipt and writes nothing.

- **Config checks.** The required vars are set. `WORKSPACE_BOOTSTRAP` is empty. The config selects `cloudflare`/`standalone`, and either `direct` with both gateway vars empty or `cloudflare-gateway` with a 32-hex account ID and a gateway ID other than `default` (the Worker's own route rules). `deploy.mjs` refuses the same var sets before upload. `WORKSPACE_ID` is `ws_` followed by 32 hex characters. The jurisdiction is `eu`, `fedramp` or empty. `APP_BASE_URL` is HTTPS. Template drift is also reported.
- **Readiness.** It probes `APP_BASE_URL` with the same readiness rules as `verify`, expecting the config's `AI_TRANSPORT`. A held workspace ends the wait; a held workspace reporting another transport is not ready.
- **Exit codes.** `0` ready. `1` not ready, or a config problem. `2` refused: a missing file, or options other than `--json` and `--wait-seconds`. `3` held.
- **Limits.**
  - The receipt is not read or updated.
  - The deployed version and remote vars or secrets are not read back.
  - Without a receipt, the Worker's own `workers.dev` URL is unknown, so another Worker answering `APP_BASE_URL` would look the same.
  - On a `cloudflare-gateway` config, the gateway's settings and stored logs are never read (no receipt ties the gateway to the installation, and no Cloudflare API call is made, even with `CF_AI_GATEWAY_ADMIN_TOKEN` set), and pass-through and the Run token are not exercised. The result lists both limitations.

It does not verify (remote gates in [04 — verification and cutover](04-verification-and-cutover.md), `VERIFY-04`):

- Queue consumption: `analysisQueue` is binding presence only.
- Durable Object alarm wake-up after inactivity.
- Protected logs (no invocation logs or raw participant URLs).
- Point-in-time recovery and operational restore.
- Live provider compatibility (needs a separately authorized smoke).
- Canonical-origin cookies, sign-in and the participant flow.
- The deployed version and remote vars or secrets. `Version` is the last deploy this installer recorded, so a CI promotion, a `wrangler rollback` or a dashboard deploy goes unnoticed.
- For a custom origin: that the origin is routed to this Worker. Another Worker answering the origin looks the same. The public endpoints expose no installation fingerprint to compare.
- On the gateway transport: pass-through per provider (no request reaches a provider), and the bound Run token (its value is not readable, so it is not probed).

## Maintained instance

The project's own production installation is installer-owned, like any other (owner decision, 24 September 2026; DEVIATIONS, SETUP-05). The owner deploys each release from their workstation, which keeps the receipt in a state directory outside the checkout:

```bash
# On a clean checkout of the release commit:
npm ci
npm run check:cloudflare
npm run setup:cloudflare -- update --install <install> --env production --state-dir <dir> --yes
```

Key, token, password, provider and transport operations run the same way, with the same `--state-dir`. A rollback is `update` from the older commit (RUNBOOK, OPS-03). The `promote-cloudflare` job is not used for this instance and stays unconfigured:

- one operator deploys it, so CI would add no second person;
- no long-lived Cloudflare deploy token is kept in GitHub;
- the repository is public, and the job reads the installation config (account id, workspace id, `workers.dev` name) from plain Actions variables, which would appear in public run logs;
- installer deploys keep the receipt's `deployments`, and the `Version` that `verify` reports, current; CI deploys do not.

The installer remains the one deployment owner, deploys only the checked artifact, and Workers Builds stays disconnected, so `SETUP-05` still holds.

## Optional: CI-owned deployment

An installation can make the `promote-cloudflare` job in `.github/workflows/ci.yml` its one deployment owner instead of the installer. The project's own instance does not ([above](#maintained-instance)); the job stays in the workflow, unconfigured and never run, for installations that choose it. Its variables are not masked, so in a public repository the installation config can appear in run logs. The installation is created once with `setup:cloudflare apply`, like any other. From then on CI deploys it and a workstation does not, with two exceptions: a provider change (`update --change-provider`) and a transport change (`update --change-ai-transport`) are made from the workstation that holds the receipt, which binds the new key or Run token when needed and deploys. Hold CI promotions while it runs, then update the variable below. Operating it (dispatch, outcomes, cancelled deploys, rollback) is described in [RUNBOOK.md](RUNBOOK.md#optional-ci-owned-deployment). The job has only been checked statically; it has never run on GitHub Actions.

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
- **After `update --change-ai-transport`.** Likewise for `AI_TRANSPORT` and the two gateway vars: CI would otherwise deploy the previous transport again. Key, token and password operations change no var and need no regeneration.
- **After any release that changes `wrangler.jsonc` outside the installation-owned fields (`name`, var values, `routes`, `workers_dev`, `account_id`, queue names), for example the compatibility date or flags, Durable Object migrations or bindings, var names or queue settings.** The config check (`configDrift` in `deploy.mjs`) then refuses the stored copy (`installation config drifts from wrangler.jsonc in: …`). Run `config` from a checkout of that release; it regenerates the file without deploying.
- **Never with a bootstrap value.** `config` never writes one. The job refuses a bootstrap config before the release check, and `deploy.mjs` refuses it again before upload.

### What the job checks

The steps run in this order:

1. **Required jobs.** The quality, browser, redis-crash, adversarial and cloudflare jobs of the same run must pass for the dispatched `main` commit.
2. **Config check.** `node scripts/cloudflare/deploy.mjs --install <config> --check-config` runs before `npm ci` and uploads nothing. It checks template drift, the required vars (`APP_BASE_URL`, `WORKSPACE_ID`, `AI_PROVIDER`), the AI transport vars under the Worker's own route rules (`direct` with both gateway vars empty, or `cloudflare-gateway` with a 32-hex account ID and a gateway ID other than `default`) and an empty `WORKSPACE_BOOTSTRAP`. A config the Worker would report not-ready for its transport is refused before upload, here and in the deploy itself.
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
- For a custom domain on your zone, check Pseudo IPv4 (zone Network settings) first: `RT-07` forbids only `overwrite_header`, which is a zone-wide change to make deliberately.
- For the Cloudflare AI Gateway transport: create the management token (AI Gateway Read + Edit on the account) and the Run token (dashboard, AI Gateway → Create authentication token). The installer never creates tokens.
- Do not connect Workers Builds to this Worker: `SETUP-05` requires one deployment owner, either the installer or the CI promotion job.
- For an installation that chooses CI ownership, the one-time setup of the CI job ([above](#optional-ci-owned-deployment)).

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
  - reports a drained or frozen workspace as held;
  - finishes an interrupted `--change-provider` when rerun (deploy failed before upload, lost reply after it, lost key-upload reply) with one history entry, refuses other commands while it is pending, and still refuses unrelated drift.
- Provider keys (`tests/setup-cloudflare/provider-keys.test.mjs`):
  - `apply --provider-keys all` sends every key in the one bulk upload and records them; a key set without the default provider, a missing or unexpected stdin key and a reused value are refused before any remote write;
  - `update --add-provider-key` and `--rotate-provider-key` upload exactly the named keys, never deploy, leave every other secret digest unchanged, finish when rerun after a lost reply, refuse other commands while pending, refuse a key bound without a record, and refuse while the newest deployment is not a checked release;
  - `update --rotate-admin-password` (`tests/setup-cloudflare/admin-password.test.mjs`) uploads `ADMIN_PASSWORD` alone, never deploys, leaves every other secret digest and var unchanged, records one `secretEvents` entry without the value, refuses while the newest deployment is a manual `wrangler secret put` or a dashboard deploy and succeeds after a plain `update`, refuses while another operation is pending and makes every other command refuse while it is pending, finishes with one event when rerun after a lost upload reply, and refuses an empty, short, padded, placeholder, over-long or non-string password, a missing or extra stdin name, non-JSON stdin and a missing protected input before any write; the value appears in no file, argv, child environment or output;
  - a format-1 receipt with the exact structure of the staging receipt of 24 September 2026 (every identifier, hash and host replaced with a synthetic value) migrates without changing any recorded fact, and its first `--add-provider-key` binds the other three keys with no deploy.
- Refused before any write: collisions, drift (including a recreated queue), jurisdiction, provider, origin and account changes, invalid credentials, and a non-public compliance region.
- Staging is isolated.
- Generated configs pass the real `deploy.mjs` `configDrift()`.
- The installer's deploys pass `--bootstrap` exactly for fresh, import-target and re-bootstrap initialization, and `update` never passes it. `update` refuses a receipt with inconsistent phases and leaves the config unchanged. The fake deploy enforces the same rule through the real `bootstrapProblems()`.
- AI Gateway (`tests/setup-cloudflare/ai-gateway.test.mjs`, against a local fake of the Cloudflare API and the gateway endpoint):
  - a fresh gateway apply creates the gateway once with exactly the D7 body, reads it back, probes it twice with no provider credential (the second with exactly the Worker's six `cf-aig-*` headers), binds the Run token in the one bulk upload and deploys the gateway vars; the management token and the Run token never appear in argv, a child environment, a file or output; the installer never sends `PUT`, `PATCH` or `DELETE`;
  - refused before any remote write: no management token, no or a short Run token, a Run token reusing another credential, the Vercel `gateway` value, and an existing gateway without evidence;
  - a create whose reply is lost is adopted in the same run and on resume, never created twice; one created outside every recorded attempt is refused;
  - a created gateway whose settings drift is refused, kept and adopted once fixed; each refused setting (logging, caching, retries, DLP, Guardrails, Logpush, authentication, `byok_only`, OTel, `store_id`) makes `update` refuse without deploying and `verify` report `gateway-mismatch`; warnings do not; stored logs fail `verify`;
  - a probe answered with a 2xx or a provider-shaped error stops the installer before any secret upload;
  - `--change-ai-transport` both directions, again to the gateway (adopted, token kept), the consent notes, the refusals, an interrupted change finishing or being abandoned, and `--rotate-ai-gateway-token` refusing a token the probe rejects;
  - a gateway deleted by hand while on direct is recreated by the next switch (also after a lost create reply) and accepted by later `update` and `verify`; a resume probes the Run token it is given and refuses one the gateway rejects before any upload; a switch refuses a Run token bound outside the installer; a switch whose token upload reply was lost records the binding when it finishes; `plan` lists the gateway as not checked during a Cloudflare API outage;
  - the installer's probe headers, identifier patterns and route rules equal the Worker's (`tests/unit/installerGatewayContract.test.ts`).
- `verify --config`:
  - reports ready, not ready, held and each config problem; a held or ready Worker reporting another AI transport than the config is not ready (as for `verify` against the receipt);
  - is read-only, and on a gateway config makes no Cloudflare API call and lists the gateway limitations;
  - refuses a missing file or mixed options.
- `config` (`tests/setup-cloudflare/config-command.test.mjs`):
  - after the config is deleted or hand-edited, rewrites it identical to the one the installer deployed, and the result passes the real `deploy.mjs --check-config`;
  - makes no wrangler, deploy or git invocation and no HTTP request, and leaves the receipt byte-identical;
  - refuses, writing nothing, before `bootstrap-clear`, with `bootstrap-clear` but no `workspace-init`, without a receipt and with a change option.
- An untracked source file in the checkout makes `apply` refuse before any remote write.
- `deploy.mjs` itself, in temporary checkouts (`tests/setup-cloudflare/deploy.test.mjs`):
  - every artifact precondition (commit, dirty flags, lockfile, template, bundle hashes, receipt);
  - the `--bootstrap` rule;
  - the AI transport vars in both directions (gateway identifiers on direct, missing or malformed identifiers on `cloudflare-gateway`), refused by `--check-config` and by a full deploy before upload, and equal to the Worker's route rules (`tests/unit/installerGatewayContract.test.ts`);
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

- Real `wrangler` output and error codes against a live account: the queues table and its `created_on` format, `[code: 10007]`, `[code: 11009]`, and `secret list` JSON. (That `deployments list --json` carries `workers/message` = `openinterviewer <commit>` on `deploy.mjs` deployments, and no message with `workers/triggered_by` `secret` on a `wrangler secret put` deployment, was observed on the staging account on 24 September 2026; DEVIATIONS, SETUP-02 key operations.)
- That `wrangler secret bulk` on a deployed Worker deploys a new version built from the latest version, and that the deployment it creates carries no `workers/message` annotation, as the `secret put` one does not (the fake models both).
- Real uploads and the deploy output URL format.
- Durable Object initialization under a real bootstrap.
- Custom-domain routing and token permissions.
- Every Cloudflare AI Gateway API and endpoint shape (remote gates in DEVIATIONS, SETUP-08): the 404 of a missing gateway, the 409 of a taken id, the response fields a new gateway reports, the logs listing's `result_info.total_count`, and the probe answers (401 `AiGatewayError` 2009 without a token; 400 `AiGatewayError` with a Run token and no provider key).
- The optional CI promotion on GitHub Actions (not used by the maintained instance): the environment's protection rules, the token's permissions, and a real dispatch, deploy and readiness check.

These belong to the staging rehearsal (`VERIFY-04`: clean install under custom names, repeated install/update without duplicates or rotation, and interrupted setup recovery).
