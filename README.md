# OpenInterviewer

OpenInterviewer is an open-source platform for adaptive, AI-assisted qualitative interviews. Researchers configure a study, share an opaque participant link, and review transcripts and synthesis in a dashboard.

There are three deliberately different ways to use it:

| Journey | Credentials | Persistence | Intended use |
| --- | --- | --- | --- |
| **Keyless public demo** (`/demo`) | None | None | See the participant and analysis experience with scripted sample data |
| **Hosted researcher account** | Sign in, then add your own AI and Upstash credentials in the UI | Your Upstash database | Run research without administering a Vercel project |
| **Self-hosted standalone** | Configure server-only environment variables | Your deployment's Upstash database | Operate the full application and infrastructure yourself |

The demo is not a disguised live interview: it is deterministic, does not call an AI provider, and does not save data. Real interviews require a researcher-owned provider account and storage.

## 1. Try the keyless demo

Open `/demo` on a running instance. No login, provider key, or database is required.

The demo:

- lets visitors steer a fictional participant through three questions with fixed, branching responses;
- ends in an illustrative researcher note with an exact transcript quote, interpretation, nuance, and hypothesis to test;
- makes no AI-provider or persistence request;
- accepts no visitor-written interview content and keeps its selected path in component memory only; and
- is safe to run while the real provider and storage configuration is absent.

Every response, follow-up, and insight is pre-written and visibly labeled as synthetic. The demo is useful for understanding the participant-to-researcher workflow, not model quality, latency, or provider availability.

## 2. Use a hosted researcher account

In hosted mode, the platform operator configures the application once. Researchers should not need the Vercel dashboard or deployment environment variables.

The researcher journey is:

1. Sign in with an OAuth provider offered on the login page.
2. Complete the in-app onboarding.
3. Add at least one researcher-owned AI key: Google Gemini or Anthropic Claude.
4. Add a researcher-owned Upstash Redis REST URL and REST token.
5. Validate and save the credentials.
6. Create and save a study, generate a participant link, and share it.

The setup UI uses password inputs and never returns stored credential values to the browser. Credentials are encrypted before being stored in the platform database. They must be decrypted by the application's server functions when making a request on the researcher's behalf; encryption at rest is not end-to-end encryption. AI providers receive the prompts and interview content required to generate a response, under the researcher's provider account and terms. Upstash stores the study and interview records under the researcher's account.

Credential validation in the onboarding UI contacts the selected service and may count against its quota. The repository-local setup checker described below never contacts those services.

### Hosted platform operator requirements

Hosted mode is multi-tenant infrastructure. The operator, not each researcher, must configure:

| Variable | Requirement |
| --- | --- |
| `DEPLOYMENT_MODE` | `hosted` |
| `APP_BASE_URL` | Stable HTTPS origin used for OAuth callbacks and participant links |
| `SESSION_SECRET` | Independent random value, at least 32 characters |
| `PARTICIPANT_TOKEN_SECRET` | Different independent random value, at least 32 characters |
| `RATE_LIMIT_SALT` | A third independent random value, at least 32 characters |
| `PLATFORM_KV_REST_API_URL` | Platform-owned Upstash REST URL for accounts, encrypted credentials, ownership, and link records |
| `PLATFORM_KV_REST_API_TOKEN` | Write-capable token for that platform database |
| `PLATFORM_KEY_PREFIX` | Environment-specific namespace such as `staging` or `production` |
| `CREDENTIAL_ENCRYPTION_KEYS` | JSON object mapping key IDs to base64-encoded 32-byte AES keys |
| `CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID` | Key ID used for new credential writes |
| `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` | Optional OAuth pair; configure at least one complete OAuth provider |
| `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` | Optional OAuth pair; configure at least one complete OAuth provider |

Example keyring shape, with the real key omitted:

```env
CREDENTIAL_ENCRYPTION_KEYS={"2026-08":"BASE64_32_BYTE_KEY"}
CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID=2026-08
```

Generate a credential-encryption key with `openssl rand -base64 32`. Keep every old key in the keyring until all credentials written with it have been rotated. `CREDENTIAL_ENCRYPTION_KEY` is the legacy, unversioned migration variable; retain it only while old records still need to be read, then remove it.

Create separate OAuth applications for staging and production. Their callback URLs are:

```text
https://YOUR_ORIGIN/api/auth/oauth/google/callback
https://YOUR_ORIGIN/api/auth/oauth/github/callback
```

Do not use `NEXT_PUBLIC_` for credentials or signing keys. `APP_BASE_URL` is intentionally server-only.

## 3. Run a self-hosted standalone instance

### Requirements

- Node.js 24.15 or newer (`.nvmrc` and `.node-version` are included)
- one Gemini or Anthropic API key
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
| `ADMIN_PASSWORD` | Independent researcher login password; 16+ characters recommended |
| `SESSION_SECRET` | Independent random value, at least 32 characters |
| `PARTICIPANT_TOKEN_SECRET` | Different independent random value, at least 32 characters |
| `RATE_LIMIT_SALT` | A third independent random value, at least 32 characters |
| `KV_REST_API_URL` | Your Upstash REST URL (`https://…upstash.io`) |
| `KV_REST_API_TOKEN` | Write-capable REST token |
| `GEMINI_API_KEY` | Required when using Gemini |
| `ANTHROPIC_API_KEY` | Required when using Claude |
| `AI_PROVIDER` | Optional default: `gemini` or `claude` |
| `GEMINI_MODEL` / `CLAUDE_MODEL` | Optional provider-specific model override |

Configure at least one AI provider. A per-study selection can override the environment default, but the matching key must exist. Model availability changes; use a model ID currently enabled on your provider account rather than relying on an old README list.

For a production readiness check:

```bash
npm run setup:check -- --mode standalone --production
```

### Deploy standalone on Vercel

1. Import the repository into a new Vercel project.
2. Create an Upstash Redis database separately and obtain its REST URL and write token.
3. Add every required standalone variable to the intended Vercel environment. Use the interactive `vercel env add NAME` command or the project's environment-variable settings; avoid putting secret values in shell history.
4. Keep Preview and Production storage and secrets separate.
5. Deploy a preview first and run the production-mode setup checker against an environment file pulled for that project, if desired.
6. Verify login, study save, participant consent, one interview, export, expiry, and revocation before assigning the production domain.

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
4. Submit the completed interview.

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

## Hosted cutover and legacy links

The hosted architecture intentionally retires links minted by the legacy standalone deployment. Old signed-JWT links cannot be converted into the new opaque, revision-bound link records, including old links configured to never expire.

Before cutover:

1. Inventory active legacy studies and notify researchers that new participant URLs are required.
2. Stop or explicitly close legacy collection and export the studies/interviews needed for retention.
3. Preserve the legacy deployment and its Redis configuration unchanged for a bounded rollback/export window.
4. Generate and distribute new opaque links only after the hosted study is active.

Do not point legacy and hosted releases at the same writable keyspace. A rollback restores the old deployment and its original storage; it does not merge interviews collected by both generations. Export any hosted data needed before rolling back.

## Vercel blue/green release checklist

No deploy command in this repository performs the cutover automatically. For a hosted release:

1. Create a separate staging Vercel project with a stable staging domain.
2. Use a separate platform Redis database, or at minimum a unique `PLATFORM_KEY_PREFIX`; never share a production write namespace.
3. Create staging-only OAuth clients with exact staging callback URLs.
4. Scope all staging environment variables to the staging project and run `npm run setup:check -- --mode hosted --production` without exposing values.
5. Deploy without attaching the production domain.
6. Verify `/demo`, OAuth failure and success paths, onboarding, credential replacement/clear, and two researcher accounts with isolated storage.
7. For each test account, verify study create/edit, opaque-link exchange, consent, interview completion, export, expiry, revocation, and account logout.
8. Create the production candidate without changing the production alias. Use production-only OAuth clients, secrets, key prefix/database, and `APP_BASE_URL`.
9. Record the current production deployment and environment snapshot as the exact rollback target.
10. Promote the verified candidate, then run a small post-cutover smoke test. Do not reuse real participant content.
11. If rollback is necessary, restore the previous deployment/domain and its matching environment/storage together. Keep hosted data isolated and export it separately.
12. After the rollback window, remove legacy access deliberately, rotate superseded signing/encryption keys, and document the retirement.

## Development and verification

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run test:setup
npm run build
npm run test:e2e
```

The browser regression proves that the keyless demo does not contact application AI APIs or external services.

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
