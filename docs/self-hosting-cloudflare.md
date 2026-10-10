# Self-host on Cloudflare

Cloudflare is the recommended target for a standalone instance, and the project's own instance runs this way. One Worker runs the Next.js app, a SQLite Durable Object workspace stores every research record, and a Queue runs background analysis. A guided installer (`npm run setup:cloudflare`) plans, applies, resumes, updates and verifies each installation.

This page covers what you need and the main steps. The [installer guide](operations/cloudflare-migration/INSTALLER.md) is the full reference for every command and option. The [operator runbook](operations/cloudflare-migration/RUNBOOK.md) covers maintenance modes, operational backup/import, restore and rollback.

## How the Cloudflare target works

The Next.js app runs through [OpenNext](https://opennext.js.org/cloudflare). Provider keys belong to the installation. They are sent directly or through the installation's own Cloudflare AI Gateway (`--ai-transport cloudflare-gateway`: logging, caching, retries and fallback off; see [AI transport in the installer guide](operations/cloudflare-migration/INSTALLER.md#ai-transport-cloudflare-ai-gateway)).

Vercel AI Gateway and hosted researcher accounts are not available on this target. Design, limits and every deviation from the migration specification are recorded in [`docs/operations/cloudflare-migration/`](operations/cloudflare-migration/IMPLEMENTATION.md).

On Cloudflare, analysis after a participant saves runs as a background job. The [research guide explains its states](research-guide.md#what-participants-do), including "needs recovery".

## What you need

- A Cloudflare account with Workers, Durable Objects and Queues.
- `npx wrangler login`.
- The key of the default provider (`--provider`). You can also add the keys of the other providers with `--provider-keys`, or later with `update --add-provider-key`, without a redeploy.
- An administrator password of 16 characters or more whose sign-in body fits Cloudflare's 1 KiB limit. That is at most 1,009 ASCII characters, and fewer with multi-byte or JSON-escaped characters. The installer refuses a longer one, and `npm run setup:check -- --target cloudflare` reports it as `env.ADMIN_PASSWORD.too_long`.
- For the local release check: a clean checkout (no uncommitted changes and no untracked files outside `.gitignore`), a local `redis-server` (or Docker) and Playwright browsers.

## Choose a Workers plan

Worker size does not decide the plan. The bundle is about 27 MiB uncompressed and 5.3 MiB gzip (27,403 KiB and 5,440 KiB in September 2026; `build:cloudflare` prints it as `Total Upload`). Since [September 4, 2026](https://developers.cloudflare.com/changelog/post/2026-09-04-increased-worker-size-limit/), the [Worker size limit](https://developers.cloudflare.com/workers/platform/limits/#worker-size) is 64 MiB uncompressed on both Free and Paid, with no compressed limit. Under the earlier compressed limits (3 MB Free, 10 MB Paid), this bundle would have needed Workers Paid.

Workers Paid is still recommended. The Free plan allows [10 ms of CPU time](https://developers.cloudflare.com/workers/platform/limits/#cpu-time) per HTTP request, which server rendering is unlikely to fit (not measured on a live Worker). Your provider bills provider usage separately.

## Install

Use the checked-in tooling. It never provisions or deploys implicitly.

```bash
npm ci
npm run build:cloudflare                  # builds dist/cloudflare/artifact; refuses if .env*/.dev.vars files are present
npm run check:cloudflare -- --skip-build  # full local release matrix on that artifact; writes the receipt deploy requires
npm run setup:cloudflare -- plan --install <name> --env production --provider openai --jurisdiction eu
# Credentials come from your secret manager on stdin. The template holds op:// references only
# and lives outside the checkout: an untracked file there makes the checkout dirty and apply refuses.
op inject -i ~/secure/secrets.tpl.json | npm run setup:cloudflare -- apply --install <name> --env production --provider openai \
  --jurisdiction eu --secrets-stdin --yes --operator-token-file <path outside this repository>
npm run setup:cloudflare -- verify --install <name> --env production
```

To try the application locally first, without any account or credentials, run `npm ci && npm run build:cloudflare && npm run preview:cloudflare`. The built Worker runs in local workerd with synthetic provider responses and throwaway storage.

### Set the origin

Without `--origin`, the installer discovers the Worker's `workers.dev` URL from the first deploy. It keeps the app not-ready until that origin is set. To use a custom domain, pass `--origin https://…` and attach the domain to the Worker in the Cloudflare dashboard. The installer never changes DNS or routes.

### Keep credentials out of the checkout

The JSON on stdin holds only `{"ADMIN_PASSWORD": "…", "OPENAI_API_KEY": "…"}`, plus one key per extra provider named with `--provider-keys`. Never keep it in a file inside the checkout, where `git add` can pick it up. Instead, do one of these:

- pipe it from a secret manager as above: the template holds references such as `{{ op://<vault>/<item>/password }}`, not values, and is kept outside the checkout like any other file you add
- drop `--secrets-stdin` and type the values at the installer's hidden prompt

If you must use a file, keep it outside the repository and delete it afterwards.

The installer generates the session, participant, rate-limit and operator secrets and the recovery epoch. It sends all secrets to Cloudflare through stdin. It records a non-secret receipt in `cloudflare/installations/`.

### Choose the jurisdiction before the first install

Choose the Durable Object jurisdiction (`eu` recommended) before the first install. It restricts where the workspace is stored, not where every request or provider call is processed. Changing it later is a migration.

Staging is always a separately named Worker with its own storage, Queue, secrets and origin.

### Why there is no Deploy to Cloudflare button

A one-click Deploy to Cloudflare button is not offered. The button deploys through Workers Builds, which would become a second deployment owner. It also cannot perform the installer's secret generation or its origin and workspace bootstrap. The guided installer is the supported path (see `SETUP-04` in [DEVIATIONS.md](operations/cloudflare-migration/evidence/DEVIATIONS.md)). A button will be published only after a complete fresh-account installation through it has been tested.

## Update and operate

Updates use `setup:cloudflare -- update`. Interrupted installs use `resume`. Run `npm run check:cloudflare` on a clean checkout of the release commit first, then update staging, check it, and then production. `update` runs `verify` itself.

The project's own production installation is deployed the same way, with `update` from the owner's workstation after `npm run check:cloudflare` (see [Maintained instance](operations/cloudflare-migration/INSTALLER.md#maintained-instance)). The `promote-cloudflare` job in `.github/workflows/ci.yml` is an unconfigured option for installations that choose CI ownership (see [Optional: CI-owned deployment](operations/cloudflare-migration/INSTALLER.md#optional-ci-owned-deployment)).

Operator actions use `npm run operator:cloudflare`, which needs the administrator password and the generated operator token. They include maintenance modes, operational backup/import, point-in-time restore and recovery activation. The [operator runbook](operations/cloudflare-migration/RUNBOOK.md) describes each one.

A coding agent can drive the same commands with [`skills/openinterviewer-cloudflare`](../skills/openinterviewer-cloudflare/SKILL.md).

Before upgrading or rolling back, check the release-specific warnings:

- [5.3 projects upgrade](research-guide.md#upgrading-to-53): back up first; schema 3 is forward-only
- [interview languages](research-guide.md#interview-languages): do not roll back past 5.1 while a study with a language setting is collecting
- [device voice input](research-guide.md#rolling-back-a-device-mode-study-to-53): set affected studies to Off before rolling back to 5.3

To check configuration without deploying, run `npm run setup:check -- --target cloudflare` (see [setup diagnostics](self-hosting-node.md#check-your-setup)). To move an existing Node/Vercel deployment to Cloudflare, follow the [transition runbook](operations/cloudflare-migration/TRANSITION.md).
