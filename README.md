# OpenInterviewer

OpenInterviewer is an open-source platform for adaptive, AI-assisted qualitative interviews. Researchers configure a study, share an opaque participant link, and review transcripts and synthesis in a dashboard.

Contributing or working with a coding agent? Start with [`CONTRIBUTING.md`](CONTRIBUTING.md) and the repository map in [`AGENTS.md`](AGENTS.md).

There are three deliberately different ways to use it:

| Journey | Credentials | Persistence | Intended use |
| --- | --- | --- | --- |
| **Keyless public demo** (`/demo`) | None | None | See the participant and analysis experience with scripted sample data |
| **Hosted researcher account** | Sign in, then add your own AI and Upstash credentials in the UI | Your Upstash database | Run research without administering a Vercel project |
| **Self-hosted standalone** | Vercel AI Gateway/OIDC or server-side provider keys | Your deployment's Upstash database | Operate the full application and infrastructure yourself |

The demo is not a disguised live interview: it is deterministic, does not call an AI provider, and does not save data. Real interviews require configured inference access and storage.

## Public deployment checks

The canonical site is [openinterviewer.vercel.app](https://openinterviewer.vercel.app), and its public `/demo` is designed to work without provider or storage configuration. Deployment mode and persistent-workspace health are runtime state, so check them instead of preserving a dated snapshot in this README:

- `/api/config/mode` reports the active mode and whether the configuration shape is valid;
- `/api/config/readiness` exposes the same safe configuration contract for setup UI; and
- `/api/health/ready` additionally checks the mode-specific database and returns `503` when the application cannot serve persistent researcher workflows.

## 1. Try the keyless demo

Open `/demo` on a running instance. No login, provider key, or database is required.

The demo:

- lets visitors steer a fictional participant through three questions with fixed, branching responses;
- ends in an illustrative researcher note with an exact transcript quote, interpretation, nuance, and hypothesis to test;
- makes no AI-provider or persistence request;
- accepts no visitor-written interview content and keeps its selected path in component memory only; and
- is safe to run while the real provider and storage configuration is absent.

Every response, follow-up, and insight is pre-written and visibly labeled as synthetic. The demo is useful for understanding the participant-to-researcher workflow, not model quality, latency, or provider availability.

The authenticated researcher workspace also offers **Load Sample**, which writes a synthetic study and interviews to that researcher's configured Upstash database so dashboard and aggregate-analysis screens can be explored. It is storage-backed sample data and does not power the public `/demo`. Loading or clearing the sample makes no AI call; generating new aggregate or follow-up analysis uses the configured provider and may count against its quota.

## 2. Use a hosted researcher account

In hosted mode, the platform operator configures the application once. Researchers should not need the Vercel dashboard or deployment environment variables.

Hosted researcher BYOS intentionally uses the direct provider adapters (`AI_TRANSPORT=direct`). This keeps each request bound to that researcher's encrypted credential and retains full Gemini, Claude, OpenAI, and OpenRouter support. The platform operator's Gateway balance or provider keys never substitute for a missing researcher credential.

The researcher journey is:

1. Sign in with an OAuth provider offered on the login page.
2. Complete the in-app onboarding.
3. Add at least one researcher-owned AI key: Google Gemini, Anthropic Claude, OpenAI, or OpenRouter.
4. Add a researcher-owned Upstash Redis REST URL and REST token.
5. Validate and save the credentials.
6. Create and save a study, generate a participant link, and share it.

The setup UI uses password inputs and never returns stored credential values to the browser. Credentials are encrypted before being stored in the platform database. They must be decrypted by the application's server functions when making a request on the researcher's behalf; encryption at rest is not end-to-end encryption. AI providers receive the prompts and interview content required to generate a response, under the researcher's provider account and terms. Upstash stores the study and interview records under the researcher's account.

All four AI keys belong in the authenticated onboarding or account-connections UI. In hosted mode, deployment-owner `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `OPENROUTER_API_KEY` values are ignored for researcher work; the application never falls back to them when a researcher's key is absent.

Testing, saving, and completing onboarding can each revalidate credentials, so one setup pass may make several provider model-list requests and Redis pings. Those requests are rate-limited but may count against provider quotas. The repository-local setup checker described below never contacts those services.

### Hosted platform operator requirements

Hosted mode is multi-tenant infrastructure. The operator, not each researcher, must configure:

| Variable | Requirement |
| --- | --- |
| `DEPLOYMENT_MODE` | `hosted` |
| `AI_TRANSPORT` | `direct`; hosted researcher BYOS does not use platform Gateway credentials |
| `APP_BASE_URL` | Stable HTTPS origin used for OAuth callbacks and participant links |
| `SESSION_SECRET` | Independent random value, at least 32 characters |
| `PARTICIPANT_TOKEN_SECRET` | Different independent random value, at least 32 characters |
| `RATE_LIMIT_SALT` | A third independent random value, at least 32 characters |
| `PLATFORM_KV_REST_API_URL` | Platform-owned Upstash REST URL for accounts, encrypted credentials, ownership, and link records |
| `PLATFORM_KV_REST_API_TOKEN` | Write-capable token for that platform database |
| `PLATFORM_KEY_PREFIX` | Environment-specific namespace such as `staging` or `production` |
| `CREDENTIAL_ENCRYPTION_KEYS` | JSON object mapping key IDs to base64-encoded 32-byte AES keys |
| `CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID` | Key ID used for new credential writes |
| `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` | One supported OAuth pair; at least one complete pair is required |
| `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` | One supported OAuth pair; either provider may be omitted when the other pair is complete |

Example keyring shape, with the real key omitted:

```env
CREDENTIAL_ENCRYPTION_KEYS={"2026-08":"BASE64_32_BYTE_KEY"}
CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID=2026-08
```

Generate a credential-encryption key with `openssl rand -base64 32`. Keep every old key in the keyring until all credentials written with it have been rotated. `CREDENTIAL_ENCRYPTION_KEY` is the legacy, unversioned migration variable; retain it only while old records still need to be read, then remove it.

Generate `SESSION_SECRET`, `PARTICIPANT_TOKEN_SECRET`, and `RATE_LIMIT_SALT` independently with `openssl rand -hex 32`. Do not reuse any value across purposes or environments.

Create separate OAuth applications for staging and production. Their callback URLs are:

```text
https://YOUR_ORIGIN/api/auth/oauth/google/callback
https://YOUR_ORIGIN/api/auth/oauth/github/callback
```

Do not use `NEXT_PUBLIC_` for credentials or signing keys. `APP_BASE_URL` is intentionally server-only.

## 3. Run a self-hosted standalone instance

### Requirements

- Node.js 24.15 or newer (`.nvmrc` and `.node-version` are included)
- either Vercel AI Gateway authentication or one Google Gemini, Anthropic Claude, OpenAI, or OpenRouter API key
- one Upstash Redis database with its REST URL and write-capable REST token
- a stable HTTPS origin for production

Storage is required for real studies and interviews. The app does not auto-create, auto-connect, or silently substitute a database. Create Upstash Redis yourself, whether directly in Upstash or through the Vercel Marketplace, then configure the exact REST variables below.

### Local setup

```bash
git clone https://github.com/linxule/openinterviewer.git
cd openinterviewer
npm ci
cp .env.example .env.local
```

Edit `.env.local` and configure the standalone section. Generate each secret independently; do not reuse the admin password or any signing/rate-limit secret:

```bash
openssl rand -base64 24   # ADMIN_PASSWORD
openssl rand -hex 32      # SESSION_SECRET
openssl rand -hex 32      # PARTICIPANT_TOKEN_SECRET
openssl rand -hex 32      # RATE_LIMIT_SALT
```

Then validate names and value shapes without revealing values or calling a provider:

```bash
npm run setup:check -- --mode standalone
npm run dev
```

Open `http://localhost:3000`. The researcher dashboard uses `ADMIN_PASSWORD`; participant access uses opaque links exchanged for short-lived, HttpOnly session cookies.

### Standalone production variables

| Variable | Requirement |
| --- | --- |
| `DEPLOYMENT_MODE` | `standalone` |
| `APP_BASE_URL` | Canonical HTTPS origin, for example `https://interviews.example.org` |
| `ADMIN_PASSWORD` | Independent researcher login password; minimum 16 characters |
| `SESSION_SECRET` | Independent random value, at least 32 characters |
| `PARTICIPANT_TOKEN_SECRET` | Different independent random value, at least 32 characters |
| `RATE_LIMIT_SALT` | A third independent random value, at least 32 characters |
| `KV_REST_API_URL` | Your Upstash REST URL (`https://…upstash.io`) |
| `KV_REST_API_TOKEN` | Write-capable REST token |
| `AI_TRANSPORT` | `direct` (default) or `gateway`; hosted researcher BYOS requires `direct` |
| `AI_GATEWAY_API_KEY` | Gateway authentication outside Vercel; optional on Vercel because the AI SDK uses project OIDC |
| `AI_GATEWAY_ZERO_DATA_RETENTION` | Optional `true`/`false` Gateway routing filter; enable only on a Vercel plan that supports request-scoped ZDR |
| `GEMINI_API_KEY` | Required for Gemini when `AI_TRANSPORT=direct` |
| `ANTHROPIC_API_KEY` | Required for Claude when `AI_TRANSPORT=direct` |
| `OPENAI_API_KEY` | Required for OpenAI when `AI_TRANSPORT=direct` |
| `OPENROUTER_API_KEY` | Required for OpenRouter, which is direct-only |
| `AI_PROVIDER` | Optional default: `gemini`, `claude`, `openai`, or `openrouter`; omitted means `gemini` |
| `GEMINI_MODEL` / `CLAUDE_MODEL` / `OPENAI_MODEL` / `OPENROUTER_MODEL` | Optional provider-specific interview-turn model override |

Choose one transport:

- `AI_TRANSPORT=gateway` is the streamlined Vercel path. The AI SDK authenticates deployed functions with project OIDC, so no provider key is required. OpenInterviewer supports Gemini, Claude, and OpenAI through Gateway, pins each request to the model creator's endpoint, disables model fallback and SDK retries, requests no-prompt-training routing, and records the requested model, resolved response model, and routed provider. OpenRouter is not exposed in this mode.
- `AI_TRANSPORT=direct` keeps the portable native adapters. Configure at least one matching provider key. This is required for hosted researcher BYOS and for OpenRouter.

A per-study selection can override `AI_PROVIDER`, but it must be available through the active transport. Each provider-specific model variable takes precedence over the legacy `AI_MODEL` migration fallback. The study model controls interview turns; synthesis, aggregate analysis, and follow-up generation use the provider-specific synthesis model defined in source and record actual execution provenance. Model availability changes, so verify the IDs currently enabled on your provider account rather than relying on an old README list.

### Provider API and model contract

The Vercel transport uses [`ai`](https://ai-sdk.dev/docs) with [Vercel AI Gateway](https://vercel.com/docs/ai-gateway), strict `Output.object` JSON Schema, project OIDC (or `AI_GATEWAY_API_KEY` off Vercel), creator-endpoint pinning, and no model fallback. The direct transport retains first-class native adapters:

- Google Gemini uses [`@google/genai`](https://ai.google.dev/gemini-api/docs/libraries) and the Interactions API with `store: false` and a JSON response schema.
- Anthropic Claude uses [`@anthropic-ai/sdk`](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript), the Messages API, and native structured output through `output_config.format`.
- OpenAI uses the official [`openai`](https://github.com/openai/openai-node) SDK, the [Responses API](https://developers.openai.com/api/docs/guides/migrate-to-responses), strict structured output, and `store: false`.
- OpenRouter uses the official [`@openrouter/sdk`](https://openrouter.ai/docs/client-sdks/typescript/overview) stable Chat API. Its routing policy sets strict JSON Schema, `require_parameters`, `data_collection: "deny"`, zero-data-retention (`zdr`), and no model fallback.

OpenRouter is a routing service: interview content is sent to the selected upstream inference endpoint under the researcher's OpenRouter account. The application records the OpenRouter adapter, requested model, resolved response model, and routed upstream provider in generation provenance. Synthesis receipts sign that provenance so a later save cannot substitute it. Privacy and structured-output routing constraints can make some models unavailable; the application reports that as a provider error instead of silently relaxing the policy.

The built-in model catalog was reviewed against the official [Gemini](https://ai.google.dev/gemini-api/docs/models), [Claude](https://platform.claude.com/docs/en/about-claude/models/overview), [OpenAI](https://developers.openai.com/api/docs/models), and [OpenRouter](https://openrouter.ai/models) catalogs on **2026-08-14**. Without an environment or per-study override, the built-in defaults are `gemini-3.7-flash`, `claude-sonnet-5`, `gpt-5.6-terra`, and `openai/gpt-5.6-terra`, respectively. Existing saved studies that use the catalogued Gemini 2.5/3.1 or Claude 4.5 model IDs remain accepted; changing a default does not rewrite them. OpenRouter offers curated entries plus a bounded `provider/model` slug, but it does not support `openrouter/auto` or promise that every catalog model satisfies this application's strict-schema and zero-data-retention requirements.

For a production readiness check:

```bash
npm run setup:check -- --mode standalone --production
```

### Deploy standalone on Vercel

1. Import the repository into a new Vercel project.
2. Create an Upstash Redis database separately and obtain its REST URL and write token.
3. Set `AI_TRANSPORT=gateway` to use Vercel OIDC and Gateway credits, or keep `direct` and add a matching provider key. Add every other required standalone variable to the intended Vercel environment. Use the interactive `vercel env add NAME` command or the project's environment-variable settings; avoid putting secret values in shell history.
4. Keep Preview and Production storage and secrets separate.
5. Deploy a preview first and run the production-mode setup checker against an environment file pulled for that project, if desired.
6. Put a project-scoped monthly AI Gateway budget in place before public interviews. Verify login, study save, participant consent, one interview, export, expiry, and revocation before assigning the production domain.

`vercel env pull .env.local` overwrites that file. Keep manual local-only overrides in `.env.development.local`, or back them up before pulling. Never commit any `.env*.local` file.

## Setup diagnostics

The checker is designed for people and coding agents:

```bash
# Keyless demo prerequisites
npm run setup:check -- --mode demo

# Local standalone .env files
npm run setup:check -- --mode standalone

# A specific production file
npm run setup:check -- --mode standalone --production --env-file .env.production.local

# Hosted operator configuration, redacted JSON output
npm run setup:check -- --mode hosted --production --json
```

It validates the Node version, required variable names, URL/key shapes, OAuth pairs, and secret independence. It reads the same local env-file family used for development, but it never prints values, writes secrets, makes network requests, provisions resources, or calls a paid model. A nonzero exit status means setup is incomplete.

## Research workflow

For researchers:

1. Create and save a study.
2. Configure questions, profile fields, provider/model, consent text, and link expiry.
3. Generate an opaque participant link from the saved revision.
4. Share the link and collect interviews.
5. Review individual transcripts and synthesis.
6. Run aggregate analysis and export research records.
7. Disable links when collection pauses or ends.

For participants:

1. Open the study link.
2. Review the study information and give consent.
3. Complete the adaptive interview.
4. Choose **Continue to save interview** and wait for **Interview submitted** before closing the tab.

Finalization generates the synthesis and then saves the interview. If either step fails, keep the tab open and use **Retry finalization** or **Retry save**. A successful synthesis alone is not a save confirmation. Researchers can download the saved transcript and JSON from the interview detail view. Researcher previews do not store research records; if preview analysis fails, **Export transcript** still opens the transcript download.

Editing a study advances its revision and invalidates links and participant sessions issued for the previous revision. Generate and distribute a new link after a consequential edit.

## Security and data boundaries

- Provider and storage credentials stay server-side; no secret belongs in a `NEXT_PUBLIC_` variable.
- Hosted credentials are encrypted at rest with a versioned AES-256-GCM keyring.
- Researcher and participant sessions use separate signing secrets and token types.
- Participant URLs contain high-entropy opaque codes, not study configuration or reusable API bearer JWTs.
- The opaque code is exchanged for a short-lived HttpOnly, `SameSite=Strict` cookie and removed from the address bar.
- Participant APIs resolve the live, server-owned study revision and recheck link status.
- AI failures are errors, not fabricated research responses.
- Researchers remain responsible for consent language, retention, deletion, provider terms, and applicable research/privacy governance.

Do not place real credentials in issues, logs, screenshots, chat transcripts, or diagnostic output.

## Migrating pre-opaque-link deployments

This section applies only to releases that minted signed-JWT share URLs before the opaque-link security rebuild. Those historical links cannot be converted into the current opaque, revision-bound link records, including old links configured to never expire. Current standalone and hosted deployments use the same opaque-link contract.

Before cutover:

1. Inventory active legacy studies and notify researchers that new participant URLs are required.
2. Stop or explicitly close legacy collection and export the studies/interviews needed for retention.
3. Preserve the legacy deployment and its Redis configuration unchanged for a bounded rollback/export window.
4. Generate and distribute new opaque links only after the hosted study is active.

Do not point legacy and hosted releases at the same writable keyspace. A rollback restores the old deployment and its original storage; it does not merge interviews collected by both generations. Export any hosted data needed before rolling back.

## Future hosted cutover runbook

No deploy command in this repository performs the cutover automatically. Hosted v2 isolation uses a schema-lineage sentinel. Absence of `study-ops:v2` is not proof that a prefix or database is safe.

1. Set a new `PLATFORM_KEY_PREFIX` or a new platform Redis before enabling v2. Never share a production write namespace with staging or a pre-v2 keyspace.
2. Set `PLATFORM_SCHEMA_LINEAGE=v2-clean` only after attesting that this prefix/database has no v1 `study-operation` / `study-operations` / pre-authority-leak owner rows. Hosted production `npm run setup:check -- --mode hosted --production` fails if lineage would HOLD.
3. Unset `PLATFORM_SCHEMA_LINEAGE` after the sentinel exists (optional); bootstrap remains idempotent on GET.
4. Do not roll back the deployment to pre-v2 after researchers have v2 data. Roll forward, or take hosted APIs offline. Unknown lineage is HOLD: readiness is false and writes return 503 `schema-hold`.
5. Account deletion is journaled, resume-safe, and does not wipe BYOS.
6. Credential cache eviction is isolate-local; TTL is 5 minutes; the account-deletion journal fails closed across isolates.
7. Real-Redis tests never point at production and never `FLUSHDB` a preexisting URL. They create a disposable instance (or an attested CI service) and brand the adapter with a runner-minted token.

Create staging-only OAuth clients, scope environment variables to the staging project, and verify `/demo`, OAuth, onboarding, two isolated researcher accounts, opaque-link exchange, consent, interview completion, export, and account deletion resume before promoting a production candidate. Do not reuse real participant content.

## Development and verification

```bash
npm ci
npx playwright install chromium
npm run lint
npm run typecheck
npm test
npm run test:setup
npm run setup:check -- --mode demo
npm run build
npm run test:e2e
npm run test:redis-crash
npm run test:adversarial
git diff --check
```

The browser suite covers the keyless demo plus standalone direct and Gateway research workflows: study creation, participant-link exchange, consent, interview, synthesis, saving, researcher review, and export. The workflow tests run the real application APIs with synthetic provider HTTP responses and a fresh disposable Redis instance per test. They require Docker or a local `redis-server`; inherited `REDIS_URL` or Redis attestation configuration is refused. Test-only servers use fixture credentials and Next's test proxy; the deployed application does not enable that proxy. These tests verify application behavior, not live provider availability, model quality, or hosted OAuth onboarding.

Production logs are allowlisted JSON and never contain prompts, keys, or bodies. Real-Redis crash and shared-BYOS adversarial jobs also refuse inherited production Redis connections.

For ordinary updates to an already configured deployment, use a reviewed pull request, require the CI and preview checks, merge to `main`, then verify the exact Git-backed production deployment on the canonical domain and scan runtime errors. The longer runbook above is for the first hosted-mode infrastructure cutover, not every application release.

## Project structure

```text
src/
├── app/                 Next.js pages and API routes
│   ├── api/             Auth, onboarding, studies, links, interviews, and synthesis
│   ├── demo/            Keyless scripted demo
│   └── p/[token]/       Opaque participant-link entry
├── components/          Researcher and participant UI
├── lib/                 Auth, storage, provider, validation, and tenancy logic
├── services/            Browser-side API clients
├── store.ts             Participant/researcher client state
└── types.ts             Shared domain types

scripts/check-setup.mjs  Redacted local setup diagnostics
tests/                   Unit and browser regressions
```

## License

MIT
