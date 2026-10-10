# Development and verification

This guide is for contributors. It covers the verification commands, the test lanes, the paid live-provider smoke test, releases, the provider contract and the project structure. Read [`CONTRIBUTING.md`](../CONTRIBUTING.md) and [`AGENTS.md`](../AGENTS.md) first: `AGENTS.md` holds the architecture map, trust boundaries and focused test gates.

## Run the checks

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

Cloudflare lanes need no account or credentials. Everything runs in local workerd with synthetic fixtures:

```bash
npm run test:cloudflare             # real local Durable Object SQLite, alarms and Queue batches
npm run test:contract:redis         # the shared WorkspaceStore scenarios and the Node sign-in budget on disposable Redis
npm run test:setup:cloudflare       # installer against a fake wrangler
npm run build:cloudflare
npm run test:cloudflare:artifact    # the built Worker artifact in local workerd
npm run test:e2e:cloudflare         # browser journeys against the built artifact
npm run test:inventory:redis        # the old-Upstash inventory tool (TRANSITION.md) on disposable Redis
npm run preview:cloudflare          # click through the built artifact locally (synthetic provider)
npm run check:cloudflare            # all of the above plus the existing matrix, on one artifact
```

You do not need to unset credentials first. The artifact, Cloudflare browser and restart launchers remove credential-like environment variables from their own process before wrangler loads. These are names that, in any letter case, contain `API_KEY`, `API_TOKEN`, `ACCOUNT_ID`, `SECRET`, `PASSWORD`, `KV_REST`, `UPSTASH` or `OIDC`, or end in `_TOKEN`. The launchers print the names they removed, never the values. The Worker under test receives only synthetic bindings. `check:cloudflare` removes the same variables from every lane and the build, and prints the names once.

## What the browser suite covers

The browser suite covers the keyless demo plus standalone direct and Gateway research workflows: study creation, participant-link exchange, consent, interview, saving, deferred analysis, researcher recovery and review, and export.

The workflow tests run the real application APIs with synthetic provider HTTP responses and a fresh disposable Redis instance per test. They need Docker or a local `redis-server`. Inherited `REDIS_URL` or Redis attestation configuration is refused. Test-only servers use fixture credentials and Next's test proxy; the deployed application does not enable that proxy. These tests verify application behavior, not live provider availability, model quality or hosted OAuth onboarding.

Production logs are allowlisted JSON and never contain prompts, keys or bodies. An `interview.analysis` event with `reason: corrupt-record` means a stored interview record was refused for structural reasons and left unchanged. It is not a Redis outage (`reason: unavailable`) and will not resolve by retrying. Real-Redis crash and shared-BYOS adversarial jobs also refuse inherited production Redis connections.

## Run the paid live-provider smoke test

Live-provider compatibility is a separate, paid check that the fixture suites cannot make. `tests/smoke/provider-provenance.smoke.test.ts` runs one real synthesis call through the direct adapter for a single provider and confirms the served response names a model.

Set `SMOKE_EXPLORATION=1` to add one exploration call; authorize 2 paid calls for that opt-in. Each test allows one HTTP attempt, disables automatic retries and uses synthetic interviews only:

```bash
SMOKE_PROVIDER=gemini GEMINI_API_KEY=... npx vitest run --config vitest.smoke.config.mts
```

It refuses to run with more than one provider credential present, writes nothing, and prints only provider, requested and served model, and a failure class.

## Releases and deployment

Pushes to `main` deploy nothing. The maintainer deploys each release with the Cloudflare installer, staging first, after the full local release check on a clean checkout of the release commit (see [Maintained instance](operations/cloudflare-migration/INSTALLER.md#maintained-instance)). A Node/Vercel self-hoster who connects Vercel's Git integration gets production deploys from `main` and previews from other branches; `vercel.json` skips `dependabot/**` branches.

For ordinary updates, use a reviewed pull request and require CI before merging to `main`.

- On Cloudflare, run `npm run check:cloudflare` on a clean checkout of the release commit. Then run `npm run setup:cloudflare -- update` for staging, check it, and then production. `update` runs `verify` itself.
- On Vercel, verify the production deployment the Git integration created from `main` and scan runtime errors.

The [hosted cutover runbook](operations/hosted.md#future-hosted-cutover-runbook) is for the first hosted-mode infrastructure cutover, not every application release.

Release notes are in [`docs/releases/`](releases/). For the maintained Cloudflare installation's dated rollout evidence and remaining follow-ups, see the [September 30 release status](operations/cloudflare-migration/evidence/V5-STATUS-2026-09-30.md). It separates completed work, unverified limits and optional deployment paths. Use the [runtime checks](../README.md#check-a-running-instance) for current health.

## Provider API and model contract

This applies to both targets, except where a transport is named.

The Vercel transport uses [`ai`](https://ai-sdk.dev/docs) with [Vercel AI Gateway](https://vercel.com/docs/ai-gateway), strict `Output.object` JSON Schema, project OIDC (or `AI_GATEWAY_API_KEY` off Vercel), creator-endpoint pinning, and no model fallback. The direct transport keeps first-class native adapters:

- Google Gemini uses [`@google/genai`](https://ai.google.dev/gemini-api/docs/libraries) and the Interactions API with `store: false` and a JSON response schema.
- Anthropic Claude uses [`@anthropic-ai/sdk`](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript), the Messages API, and native structured output through `output_config.format`.
- OpenAI uses the official [`openai`](https://github.com/openai/openai-node) SDK, the [Responses API](https://developers.openai.com/api/docs/guides/migrate-to-responses), strict structured output, and `store: false`.
- OpenRouter uses the official [`@openrouter/sdk`](https://openrouter.ai/docs/client-sdks/typescript/overview) stable Chat API. Its routing policy sets strict JSON Schema, `require_parameters`, `data_collection: "deny"`, zero-data-retention (`zdr`), and no model fallback.

OpenRouter is a routing service. Interview content is sent to the selected upstream inference endpoint under the researcher's OpenRouter account. The application records the OpenRouter adapter, requested model, resolved response model and routed upstream provider in generation provenance. Provenance is written server-side when the deferred analysis attaches its result; the browser never supplies it. Privacy and structured-output routing constraints can make some models unavailable. The application reports that as a provider error instead of silently relaxing the policy.

### Default models

Claude and OpenAI defaults were updated against the official [Claude Sonnet 5.5](https://platform.claude.com/docs/en/models/sonnet-5-5/overview) and [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol) documentation on September 29, 2026. Without an environment or per-study override, new studies default to `gemini-3.8-flash`, `claude-sonnet-5-5`, `gpt-6.1-sol` and `openai/gpt-5.6-terra`, respectively. Gemini and OpenRouter defaults are unchanged from the August 14, 2026 catalog review. Existing saved studies keep their configured models, and legacy catalog IDs remain accepted.

- GPT-6 Luna is available as a lower-cost OpenAI choice.
- GPT-6.1 Sol requires reasoning: turning extra reasoning off selects `low`, not the unsupported `none`.
- Sonnet 5.5 uses `between_tools` when extra reasoning is off.
- The native Sonnet ID maps to `anthropic/claude-sonnet-5.5` on Vercel Gateway.
- OpenRouter offers curated entries plus a bounded `provider/model` slug. It does not support `openrouter/auto` or promise that every catalog model satisfies this application's strict-schema and zero-data-retention requirements.

## Project structure

```text
src/
├── app/                 Next.js pages and API routes
│   ├── api/             Auth, onboarding, studies, links, interviews, and synthesis
│   ├── demo/            Keyless scripted demo
│   └── p/               Opaque participant-link entry (/p/<code>, rewritten in next.config.js)
├── components/          Researcher and participant UI
├── lib/                 Auth, storage, provider, validation, and tenancy logic
├── services/            Browser-side API clients
├── store.ts             Participant/researcher client state
└── types.ts             Shared domain types

cloudflare/              Worker entry, Durable Object workspace, analysis Queue consumer, OpenNext wrapper
scripts/cloudflare/      Build, release check, deploy, installer (setup:cloudflare) and operator CLI
scripts/check-setup.mjs  Redacted local setup diagnostics
scripts/check-sync-artifacts.mjs  Fails the check gate on iCloud sync-conflict copies
docs/                    Research, self-hosting, hosted operations and development guides
docs/operations/cloudflare-migration/  Installer, runbook, transition and evidence for the Cloudflare target
docs/releases/           Release notes
skills/                  Agent skill for installing and operating a Cloudflare instance
tests/                   Unit, integration, Workers, artifact and browser regressions
wrangler.jsonc           Cloudflare Worker template (installations are generated from it)
```
