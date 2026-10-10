# Hosted researcher accounts

Hosted mode is a multi-tenant service. A platform operator configures the application once, and each researcher signs in and brings their own AI and storage credentials. Hosted mode runs on the Node/Vercel target only, not on Cloudflare. The project's own instance does not offer hosted accounts, and the project does not currently operate one.

This page covers the researcher journey, the operator's configuration, migrating from pre-opaque-link releases, and the runbook for a future hosted cutover.

## How researchers use a hosted account

Researchers should not need the Vercel dashboard or deployment environment variables. The researcher journey is:

1. Sign in with an OAuth provider offered on the login page.
2. Complete the in-app onboarding.
3. Add at least one researcher-owned AI key: Google Gemini, Anthropic Claude, OpenAI, or OpenRouter.
4. Add a researcher-owned Upstash Redis REST URL and REST token.
5. Validate and save the credentials.
6. Create and save a study, generate a participant link, and share it.

Hosted researcher BYOS intentionally uses the direct provider adapters (`AI_TRANSPORT=direct`). This keeps each request bound to that researcher's encrypted credential and keeps full Gemini, Claude, OpenAI and OpenRouter support. The platform operator's Gateway balance or provider keys never substitute for a missing researcher credential.

### How researcher credentials are handled

The setup UI uses password inputs and never returns stored credential values to the browser. Credentials are encrypted before being stored in the platform database. The application's server functions must decrypt them to make a request on the researcher's behalf, so encryption at rest is not end-to-end encryption.

AI providers receive the prompts and interview content needed to generate a response, under the researcher's provider account and terms. Upstash stores the study and interview records under the researcher's account.

All 4 AI keys belong in the authenticated onboarding or account-connections UI. In hosted mode, deployment-owner `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `OPENROUTER_API_KEY` values are ignored for researcher work. The application never falls back to them when a researcher's key is absent.

Testing, saving and completing onboarding can each revalidate credentials. One setup pass may therefore make several provider model-list requests and Redis pings. Those requests are rate-limited but may count against provider quotas. The repository-local [setup checker](../self-hosting-node.md#check-your-setup) never contacts those services.

## Hosted platform operator requirements

The operator, not each researcher, must configure:

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

Generate a credential-encryption key with `openssl rand -base64 32`. Keep every old key in the keyring until all credentials written with it have been rotated. `CREDENTIAL_ENCRYPTION_KEY` is the legacy, unversioned migration variable. Keep it only while old records still need to be read, then remove it.

Generate `SESSION_SECRET`, `PARTICIPANT_TOKEN_SECRET` and `RATE_LIMIT_SALT` independently with `openssl rand -hex 32`. Do not reuse any value across purposes or environments.

Create separate OAuth applications for staging and production. Their callback URLs are:

```text
https://YOUR_ORIGIN/api/auth/oauth/google/callback
https://YOUR_ORIGIN/api/auth/oauth/github/callback
```

Do not use `NEXT_PUBLIC_` for credentials or signing keys. `APP_BASE_URL` is intentionally server-only.

Check the configuration with `npm run setup:check -- --mode hosted --production --json`.

## Migrating pre-opaque-link deployments

This section applies only to releases that minted signed-JWT share URLs before the opaque-link security rebuild. Those historical links cannot be converted into the current opaque, revision-bound link records, including old links configured to never expire. Current standalone and hosted deployments use the same opaque-link contract.

Before cutover:

1. Inventory active legacy studies and notify researchers that new participant URLs are required.
2. Stop or explicitly close legacy collection and export the studies/interviews needed for retention.
3. Preserve the legacy deployment and its Redis configuration unchanged for a bounded rollback/export window.
4. Generate and distribute new opaque links only after the hosted study is active.

Do not point legacy and hosted releases at the same writable keyspace. A rollback restores the old deployment and its original storage. It does not merge interviews collected by both generations. Export any hosted data needed before rolling back.

## Future hosted cutover runbook

No deploy command in this repository performs the cutover automatically. Hosted v2 isolation uses a schema-lineage sentinel. Absence of `study-ops:v2` is not proof that a prefix or database is safe.

1. Set a new `PLATFORM_KEY_PREFIX` or a new platform Redis before enabling v2. Never share a production write namespace with staging or a pre-v2 keyspace.
2. Set `PLATFORM_SCHEMA_LINEAGE=v2-clean` only after attesting that this prefix/database has no v1 `study-operation` / `study-operations` / pre-authority-leak owner rows. Hosted production `npm run setup:check -- --mode hosted --production` fails if lineage would HOLD.
3. Unset `PLATFORM_SCHEMA_LINEAGE` after the sentinel exists (optional); bootstrap remains idempotent on GET.
4. Do not roll back the deployment to pre-v2 after researchers have v2 data. Roll forward, or take hosted APIs offline. Unknown lineage is HOLD: readiness is false and writes return 503 `schema-hold`.
5. Account deletion is journaled, resume-safe, and does not wipe BYOS.
6. Credential cache eviction is isolate-local; TTL is 5 minutes; the account-deletion journal fails closed across isolates.
7. Real-Redis tests never point at production and never `FLUSHDB` a preexisting URL. They create a disposable instance (or an attested CI service) and brand the adapter with a runner-minted token.

Create staging-only OAuth clients and scope environment variables to the staging project. Before promoting a production candidate, verify `/demo`, OAuth, onboarding, 2 isolated researcher accounts, opaque-link exchange, consent, interview completion, export, and account deletion resume. Do not reuse real participant content.

This runbook is for the first hosted-mode infrastructure cutover, not every application release. For ordinary releases, see [releases and deployment](../development.md#releases-and-deployment).
