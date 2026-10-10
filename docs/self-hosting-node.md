# Self-host on Node or Vercel

The Node/Vercel target runs the same application as Cloudflare on Vercel or any Node host. It stores research records in your own Upstash Redis database. It is also the only target for hosted researcher accounts (see the [hosted operations guide](operations/hosted.md)).

This page covers requirements, local setup, production variables, a Vercel deploy and the setup checker.

## Requirements

- Node.js 24.19 or newer (`.nvmrc` and `.node-version` are included)
- either Vercel AI Gateway authentication or one Google Gemini, Anthropic Claude, OpenAI, or OpenRouter API key
- one Upstash Redis database with its REST URL and write-capable REST token
- a stable HTTPS origin for production

Storage is required for real studies and interviews. The app does not auto-create, auto-connect or silently substitute a database. Create Upstash Redis yourself, directly in Upstash or through the Vercel Marketplace, then configure the exact REST variables below.

## Local setup

```bash
git clone https://github.com/linxule/openinterviewer.git
cd openinterviewer
npm ci
cp .env.example .env.local
```

Edit `.env.local` and configure the standalone section. Generate each secret independently. Do not reuse the admin password or any signing or rate-limit secret:

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

Open `http://localhost:3000`. The researcher dashboard uses `ADMIN_PASSWORD`. Participant access uses opaque links exchanged for short-lived, HttpOnly session cookies.

Sign-in counts failed attempts in Redis, so it needs the Upstash variables and `RATE_LIMIT_SALT`. Without them it answers 503 (see [security and data boundaries](../README.md#security-and-data-boundaries)).

## Production variables

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

Voice transcription by the installation and a non-English analysis language need further variables. See [voice input](research-guide.md#voice-input) and [interview languages](research-guide.md#interview-languages).

### Choose a transport

- `AI_TRANSPORT=gateway` is the streamlined Vercel path. The AI SDK authenticates deployed functions with project OIDC, so no provider key is required. OpenInterviewer supports Gemini, Claude and OpenAI through Gateway. It pins each request to the model creator's endpoint, disables model fallback and SDK retries, requests no-prompt-training routing, and records the requested model, resolved response model and routed provider. OpenRouter is not exposed in this mode.
- `AI_TRANSPORT=direct` keeps the portable native adapters. Configure at least one matching provider key. This is required for hosted researcher BYOS and for OpenRouter.

A per-study selection can override `AI_PROVIDER`, but it must be available through the active transport. Each provider-specific model variable takes precedence over the legacy `AI_MODEL` migration fallback.

The study's configured provider and model, the researcher's own choice, drive interview turns, per-interview synthesis, aggregate analysis and follow-up generation alike. There is no separate fixed synthesis model. Provenance records the requested model and the provider-reported response model actually used. Model availability changes, so verify the IDs currently enabled on your provider account rather than relying on an old list in the documentation. The [provider API and model contract](development.md#provider-api-and-model-contract) lists the current defaults.

For a production readiness check:

```bash
npm run setup:check -- --mode standalone --production
```

## Deploy on Vercel

1. Import the repository into a new Vercel project.
2. Create an Upstash Redis database separately and obtain its REST URL and write token.
3. Set `AI_TRANSPORT=gateway` to use Vercel OIDC and Gateway credits, or keep `direct` and add a matching provider key. Add every other required standalone variable to the intended Vercel environment. Use the interactive `vercel env add NAME` command or the project's environment-variable settings; avoid putting secret values in shell history.
4. Keep Preview and Production storage and secrets separate.
5. Deploy a preview first and run the production-mode setup checker against an environment file pulled for that project, if desired.
6. Put a project-scoped monthly AI Gateway budget in place before public interviews. Verify login, study save, participant consent, one interview, export, expiry and revocation before assigning the production domain.

`vercel env pull .env.local` overwrites that file. Keep manual local-only overrides in `.env.development.local`, or back them up before pulling. Never commit any `.env*.local` file.

If you connect Vercel's Git integration, it deploys production from `main` and previews from other branches. `vercel.json` skips `dependabot/**` branches. After a release, verify the production deployment the Git integration created from `main` and scan runtime errors.

Before upgrading or rolling back, check the release-specific warnings for [5.3 projects](research-guide.md#upgrading-to-53), [interview languages](research-guide.md#interview-languages) and [device voice input](research-guide.md#rolling-back-a-device-mode-study-to-53).

## Check your setup

The setup checker is designed for people and coding agents:

```bash
# Keyless demo prerequisites
npm run setup:check -- --mode demo

# Local standalone .env files
npm run setup:check -- --mode standalone

# A specific production file
npm run setup:check -- --mode standalone --production --env-file .env.production.local

# Hosted operator configuration, redacted JSON output
npm run setup:check -- --mode hosted --production --json

# Cloudflare: an env file kept outside the checkout plus wrangler.jsonc bindings and queue settings
npm run setup:check -- --target cloudflare --env-file ~/secure/openinterviewer.cloudflare.env
```

It validates the Node version, required variable names, URL and key shapes, OAuth pairs, and secret independence. It reads the same local env-file family used for development. It never prints values, writes secrets, makes network requests, provisions resources or calls a paid model. A nonzero exit status means setup is incomplete.
