---
name: openinterviewer-cloudflare
description: Install, update or verify an OpenInterviewer standalone deployment on Cloudflare (one Worker + WorkspaceStore Durable Object + analysis Queue) by running the repository's checked-in installer. Use when someone asks to deploy, install, set up, update, redeploy or check OpenInterviewer on Cloudflare or Workers. Not for Vercel/Node deployments, hosted (multi-tenant) mode, DNS changes or deleting infrastructure.
---

# OpenInterviewer on Cloudflare

You operate the checked-in installer. You never improvise a second deployment path: no hand-written `wrangler deploy`, no dashboard edits, no resource creation outside `npm run setup:cloudflare`. The authoritative references are `docs/operations/cloudflare-migration/INSTALLER.md` (commands, phases, state files) and `docs/operations/cloudflare-migration/RUNBOOK.md` (maintenance, backup, restore, rollback).

## Hard rules

- Obtain explicit authorization from the person before any action that touches their Cloudflare account, creates billable resources, deploys, or uses a provider key. A plan is read-only and needs no authorization beyond running it.
- Credentials: follow the person's credential policy. Fetch a secret only when they explicitly ask you to, never enumerate a vault, and pass secrets to the installer only through `--secrets-stdin` (JSON on stdin). Never put a secret in a command-line argument, environment dump, file in the repository, log or chat message.
- Never delete resources, change DNS or custom domains, rotate secrets or the recovery epoch, change the storage jurisdiction, or run a paid provider smoke test unless the person asks for that specific action.
- Use the existing `wrangler login` session (`node_modules/.bin/wrangler whoami` shows it) or a `CLOUDFLARE_API_TOKEN` the person already exported. If there is neither, ask the person to run `node_modules/.bin/wrangler login` themselves. When the session reaches several accounts, ask which one and pass `--account-id`.
- Report unverified things as unverified. `verify` proves configuration and readiness only; it does not prove Queue consumption after inactivity, protected logs, restores, live provider compatibility, or that a custom domain routes to this Worker.

## 1. Establish intent and target

Ask only what you cannot determine:

- Install or update? For an update, the installation name and environment must match an existing receipt in `cloudflare/installations/<install>-<env>/receipt.json`.
- Installation name (`[a-z0-9-]`, 1–24 characters) and environment (`production` or `staging`). Staging is always a separate Worker, Queue, Durable Object namespace, secrets and origin.
- Fresh install only: the AI provider (`gemini`, `claude`, `openai` or `openrouter`), the Durable Object jurisdiction (`eu` recommended, `fedramp`, or `none`; it cannot be changed later without a migration), and whether a final HTTPS origin already exists (otherwise the `workers.dev` origin is discovered from the first deploy). A custom domain is attached by the person in the dashboard after the first deploy; the installer never changes DNS or routes.
- Restoring data into a new installation is a separate path: install with `--import-target` and follow RUNBOOK OPS-02/OPS-03.

## 2. Prepare the checked artifact

From a clean checkout of the intended commit:

```bash
npm ci
npm run build:cloudflare      # never provisions or deploys
npm run check:cloudflare      # full local matrix (rebuilds unless -- --skip-build); writes the receipt deploy requires
```

`build:cloudflare` refuses to run while any `.env*` or `.dev.vars*` file other than the `.example` templates is in the repository root (OpenNext would embed its values). Ask the person to move it out of the checkout; never delete or read it yourself. `npm run preview:cloudflare` runs the built artifact locally with synthetic provider responses and no credentials if the person wants to look before installing.

## 3. Plan (read-only)

```bash
npm run setup:cloudflare -- plan --install <name> --env <env> [--provider <p>] [--jurisdiction <j>] [--origin https://…]
```

Show the person the resources, variables, secret names, billing notes and any collision or drift the plan reports. A reported collision means a resource with the derived name exists without a matching receipt: stop and ask; never adopt it.

## 4. Apply, resume or update (after authorization)

Fresh install:

```bash
<password and provider key JSON> | npm run setup:cloudflare -- apply --install <name> --env <env> \
  --provider <p> --jurisdiction <j> [--origin https://…] --secrets-stdin --yes \
  --operator-token-file <path outside the repository>
```

The JSON on stdin is `{"ADMIN_PASSWORD": "…", "<PROVIDER>_API_KEY": "…"}` (for example from `op inject`, run by the person or with their explicit authorization). The installer generates the session, participant, rate-limit and operator secrets and the recovery epoch itself. Tell the person where the operator token file was written and that it is needed for maintenance, backup and restore; suggest moving it into their password manager. Never read the token file.

Interrupted install: `npm run setup:cloudflare -- resume --install <name> --env <env> [--secrets-stdin --operator-token-file <path>] --yes`. The credentials and an operator-token destination are needed again only if the secrets phase had not completed. It continues from the first incomplete phase without duplicating resources or rotating secrets that were already set, and refuses any resource it cannot prove it created. A refusal is a stop-and-ask, never a reason to delete or rename something.

Update an existing installation (same commit rules: build and check first):

```bash
npm run setup:cloudflare -- update --install <name> --env <env> --yes
```

Update refuses configuration drift, identity or jurisdiction changes and an unready artifact before deploying. Switching providers needs `--change-provider --provider <p>`, the new key on stdin (`--secrets-stdin`) when it is not already bound, and the person's explicit request. Exit 3 means the new version is deployed but the workspace is held by an operator (`draining`, `frozen` or `recovery`); report it and run `verify` after they reopen it.

## 5. Verify and hand off

```bash
npm run setup:cloudflare -- verify --install <name> --env <env> --json
```

Report, concisely:

- canonical URL (`APP_BASE_URL`) and the deployed commit / artifact hash from the receipt;
- the receipt path and resource names (no secret values);
- verification results, and the remote gates still open (Queue consumption after inactivity, alarm wake-up, protected logs, backup/restore rehearsal, provider smoke) from `docs/operations/cloudflare-migration/04-verification-and-cutover.md`.

If `verify` fails, report the failing check and the installer's suggested next step. Do not retry deploys in a loop, and do not re-bootstrap a workspace yourself: INSTALLER.md describes the only safe re-bootstrap case, and it requires the person's decision.
