# OpenInterviewer agent guide

This is the canonical repository guide for coding agents and contributors. `README.md` owns product, setup, environment, and operator guidance. Keep this file focused on code navigation, trust boundaries, and verification; do not copy volatile deployment IDs, model availability claims, or test counts into it.

## Start here

1. Run `git status --short --branch` and preserve unrelated work. The local `.claude/` directory is user-owned unless the user explicitly puts it in scope.
2. Read the relevant implementation and its paired tests before editing. Do not infer current production state from source code.
3. Use Node 24.19+ (`.nvmrc` and `.node-version` are `24.19.0`) and npm. `package-lock.json` is authoritative.
4. For Next.js behavior, consult the version-matched guides in `node_modules/next/dist/docs/`; this is Next.js 16, not an older App Router contract.
5. Never use production credentials, real participant content, or a writable production database for tests.

## Sources of truth

- Product journeys, environment variables, privacy boundaries, and release/rollback guidance: `README.md`
- Contributor workflow: `CONTRIBUTING.md`
- Commands and dependency versions: `package.json`
- Environment template: `.env.example`
- Deployability contract: `scripts/check-setup.mjs`
- Cloudflare standalone specifications, design record, runbook, installer contract and evidence: `docs/operations/cloudflare-migration/` (`IMPLEMENTATION.md` holds the binding decisions; `evidence/DEVIATIONS.md` lists every departure from the specifications)
- CI gates and safe hosted build fixtures: `.github/workflows/ci.yml`
- Shared domain shapes: `src/types.ts`
- Design direction and UI vocabulary: `docs/design/DIRECTION-final.md` (decided), `docs/design/initiative-*-brief.md` and `docs/design/slice-*-spec.md` (per-slice implementation contracts). The design law is lint-enforced in `eslint.config.mjs`: no Tailwind default palette, no raw `font-serif`, and the wine/ochre custom properties reach the UI only through primitives in `src/components/ui/`.

Production is external state. Verify it through the deployment provider and public readiness endpoints; do not preserve a live snapshot in repository guidance.

## Product surfaces

- Public landing: `src/app/page.tsx` -> `src/components/Landing.tsx`
- Keyless synthetic demo: `src/app/demo/page.tsx` -> `src/components/DemoSimulation.tsx`
- Self-host guide: `src/app/self-host/page.tsx`
- Researcher workspace: `src/app/{login,onboarding,studies,setup,dashboard,settings}`
- Participant link entry: `src/app/p/page.tsx`, serving every `/p/<code>` through a rewrite in `next.config.js` so the client router's state and request headers never hold the code; hand-over to consent in `src/lib/participantLinkHandover.ts`
- Participant phases: `src/app/{consent,interview,synthesis,export}`
- Authenticated sample-workspace seed: `src/app/api/demo/seed/route.ts` and `src/lib/demoData.ts`

The sample-workspace seed is not the public demo. `/demo` is component-memory-only: it performs no authentication, API, provider, or persistence request.

## Architecture map

### Deployment and request authority

- Mode resolution: `src/lib/mode.ts`
- Configuration/readiness: `src/lib/hostedConfig.ts`, `src/lib/appBaseUrl.ts`, `src/lib/platformSchema.ts`
- Session and participant-cookie contracts: `src/lib/auth.ts`
- Page protection: `src/proxy.ts`, `src/lib/researcherAccess.ts`
- Researcher/participant request contexts: `src/lib/researcherContext.ts`
- Runtime target, capabilities, Worker invocation context, admission identity and the not-ready gate: `src/lib/runtime/`
- Operator credential and routes (Cloudflare only): `src/lib/operatorAuth.ts`, `src/app/api/operator/`

`standalone` uses one administrator session plus deployment-owned Upstash credentials and either direct provider keys or Vercel AI Gateway/OIDC. Cloudflare standalone (`DEPLOYMENT_TARGET=cloudflare`) uses one administrator session, one SQLite-backed Durable Object per installation for every research record, a Queue for analysis, and the installation's own provider keys, sent directly or through the installation's Cloudflare AI Gateway (`AI_TRANSPORT=cloudflare-gateway`, RT-11); it has no Redis, Vercel AI Gateway or hosted mode, and its validation is production-strict whatever `NODE_ENV` reports. `hosted` uses OAuth accounts, a platform control-plane Redis database, encrypted researcher BYOS credentials, direct native provider adapters, and a distinct researcher-owned Redis database for research records.

### Storage and tenancy

- Researcher studies/interviews and atomic Redis scripts: `src/lib/kv.ts`
- Field-level JSON patching inside Redis Lua (preserves untouched value types): `src/lib/studyJsonLua.ts`
- Redis client construction, cache lifecycle, and Upstash URL validation: `src/lib/kvClient.ts`
- Public Redis port and node-redis test adapter: `src/lib/redisPort.ts`, `src/lib/redisNodeAdapter.ts`
- Closed Redis wire parsers: `src/lib/wire/`
- Hosted accounts, ownership, quotas, and operation records: `src/lib/platformDb.ts`, `src/lib/platformDb.operations.ts`, `src/lib/platformDb.accountDelete.ts`
- Create idempotency mapping: `src/lib/createIdempotency.ts`
- Hosted owned-study collection loading: `src/lib/ownedStudies.ts`
- Hosted credential envelopes: `src/lib/crypto.ts`
- Cross-database study-operation repair: `src/lib/studyOperationReconciler.ts`
- Disposable Redis fault harness: `tests/helpers/disposableRedis.ts`, `tests/helpers/faultManifest.ts`
- Portable research-store port, analysis protocol and backend selection: `src/lib/storage/` (`types.ts`, `analysisProtocol.ts`, `resolve.ts`, Redis adapter `redis.ts`, Durable Object client `durableObject.ts`)
- Cloudflare Worker entry (OpenNext wrapper, Queue handler): `cloudflare/worker.ts`; it strips the reserved `x-openinterviewer-internal-*` headers from every request before OpenNext with `cloudflare/internalHeaders.ts`
- `WorkspaceStore` Durable Object and its domain modules (schema, studies, links, completion, analysis jobs, single-alarm scheduler, export snapshots, maintenance/backup/import, login budget): `cloudflare/workspace/`
- Queue consumer and queued provider execution policy: `cloudflare/analysis/`
- Operational backup format: `src/lib/backup/format.ts`

The Worker-only graph (`cloudflare/analysis/consumer.ts`, `cloudflare/workspace/WorkspaceStore.ts`) must never reach Next.js, Redis modules, the Upstash client or hosted platform code; `scripts/cloudflare/check-import-boundary.mjs` enforces this. Durable Object state changes that must happen together (rows, mutation sequence, alarm) happen in one storage transaction; never split them across RPC calls.

Queued analysis never retries a provider request automatically: the SDK retry policy is zero, a request that may have reached the provider (timeout, network loss, HTTP 5xx after start) becomes `recovery-required`, and only a researcher action with an `Idempotency-Key` and the expected generation starts another paid attempt. Keep Queue messages identifier-only.

The interview analysis attach script distinguishes two non-writes: `unavailable` (transport or transient; retryable) and `corrupt` (the stored record's identity members or `analysis` state are not the shape the script owns). A corrupt record is never patched, is logged as `reason: corrupt-record`, and is reported to callers as `unavailable` so the researcher response stays retryable. Keep the two tags separate; folding `corrupt` into `unavailable` hides record faults behind outage alerts.

Hosted study create/delete is a durable cross-database operation. Preserve the operation marker/tombstone and reconciliation protocol; a superficially simpler sequence can reintroduce orphaned ownership or BYOS records.

### Participant and AI flow

- Opaque participant links: `src/lib/participantLinks.ts`
- Server-recorded consent: `src/lib/participantConsent.ts`
- Consent coverage of the provider transport (Cloudflare; disclosed transport vs the current route): `src/lib/transportDisclosure.ts`
- Canonical study loading: `src/lib/canonicalStudy.ts`
- Save validation and deferred analysis: `src/lib/interviewSubmission.ts`, `src/lib/interviewAnalysis.ts`, `src/lib/analysisState.ts`
- Server-generated synthesis provenance: `src/lib/synthesisProvenance.ts`
- Bounded request parsing: `src/lib/requestBody.ts`
- Providers and prompts: `src/lib/providers/`, `src/lib/prompts/`, `src/lib/ai.ts`, `src/lib/interviewerManner.ts`
- Transport selection and Gateway model mapping: `src/lib/aiTransport.ts`, `src/lib/providers/gateway.ts`
- Cloudflare provider endpoints (explicit per-adapter endpoints, direct or Cloudflare AI Gateway routes with the exact `cf-aig-*` header set, route resolution shared by readiness, the fetch path and the Queue consumer, refused SDK environment overrides, `covers()`): `src/lib/providers/endpoint.ts`
- Provider result validation/errors: `src/lib/providerValidation.ts`, `src/lib/providerErrors.ts`
- Evidence citation matching (render-time classification; verdicts never stored): `src/lib/evidence.ts`
- Participant and hosted platform limits: `src/lib/rateLimit.ts`, `src/lib/platformAiRateLimit.ts`
- Browser API clients: `src/services/`
- Session-scoped workflow state: `src/store.ts`, persisted through `src/lib/tolerantSessionStorage.ts` (a failed write leaves the session in memory only)

On Cloudflare the participant sequence is the same, with analysis queued by the completion transaction and executed in the background by the Queue consumer. The participant sequence is link exchange -> HttpOnly participant session -> consent -> greeting/interview -> transcript save -> deferred analysis. The saved transcript is immutable; analysis attaches under an atomic claim and can be retried by the researcher. Every participant route must re-resolve authority and the server-owned current study revision before provider use or persistence.

## Non-negotiable invariants

- Browser-supplied study configuration, provider/model choice, identity, timestamps, synthesis, and ownership are untrusted.
- Researcher and participant sessions use different secrets, audiences, types, and cookies. Never restore the old `ADMIN_PASSWORD` signing fallback.
- Participant URLs contain only opaque high-entropy codes. Do not put study configuration or reusable bearer credentials back in URLs or browser storage.
- The non-secret participant session selector must accompany participant API calls so parallel tabs remain isolated.
- Consent is a server record bound to participant session, study revision, and consent hash. Client Zustand state alone is not consent authority.
- Researcher preview may call the real provider but must not persist or increment study results.
- Study revision, link status, ownership, consent, rate limits, and storage uncertainty fail closed.
- Hosted provider resolution must never fall back to platform-owner API keys.
- Hosted researcher BYOS remains on `AI_TRANSPORT=direct`. Standalone Gateway requests pin one creator endpoint, configure no model fallback, and keep actual execution provenance.
- Cloudflare AI Gateway requests go only to the installation's gateway on each provider's native path, carry exactly the six `cf-aig-*` headers, never fall back to direct on a malformed configuration, and record `aiTransport`. A provider call carrying participant content runs only when the transport disclosed at consent covers the current one (direct always does).
- User-provided Redis URLs remain restricted to HTTPS Upstash hosts; preserve bounded validation deadlines.
- AI/provider failure is an error. Never substitute a plausible research response, synthesis, or greeting.
- Completion persistence and study mutation remain atomic and idempotent under retries and concurrency.
- Editing a study advances its revision and invalidates older participant authority.
- Synthesis (per-interview synthesis, aggregate synthesis, follow-up generation) uses the study's own configured provider and model — never a fixed override. Synthesis provenance must record the provider and model actually used, which may differ from the requested model when the provider serves a specific dated snapshot.

## Change map and focused gates

| Area | Primary paths | Minimum focused verification |
| --- | --- | --- |
| Public demo | `DemoSimulation.tsx`, `app/demo`, demo tests | accessibility unit test + `npm run test:e2e` |
| Mode/setup | `mode.ts`, `hostedConfig.ts`, checker/env/docs | mode/config/setup tests + standalone and hosted builds |
| Auth/participant authority | `auth.ts`, `proxy.ts`, `researcherContext.ts`, participant libraries | matching auth/consent/link tests + `npm run check` |
| Storage/tenancy | `kv.ts`, `kvClient.ts`, `platformDb.ts`, reconciler | atomicity/tenancy/saga tests + `npm run check` |
| Providers/provenance | `aiTransport.ts`, `providers/`, `prompts/`, interview/synthesis routes | transport/provider/provenance tests + direct/Gateway build contracts + `npm run check` |
| Completion and export | `Synthesis.tsx`, `interviewAnalysis.ts`, save/analyze/export routes, `storageService.ts` | lifecycle/save/analysis tests + `npm run test:e2e` through researcher and participant workflows |
| Structured request logs | `src/lib/requestLog.ts`, `providerErrors.ts`, API catch sites | `requestLog.test.ts` + `providerErrors.test.ts` + health/config contract tests |
| Participant/preview headers | `src/services/participantHeaders.ts`, `interviewApi.ts`, `storageService.ts`, `Consent.tsx` | `participantHeaders.test.ts` + `participantSessionHeaders.test.ts` + consent/isolation suites |
| Researcher UI | components, services, page entry | paired component/API tests; inspect 375px when layout changes |
| Cloudflare runtime/storage | `cloudflare/`, `src/lib/runtime/`, `src/lib/storage/`, `researcherContext.ts` | `npm run test:cloudflare` + `npm run test:contract:redis` + `npm run typecheck` + `node scripts/cloudflare/check-import-boundary.mjs` + `npm run check` |
| Cloudflare artifact, installer and operations | `scripts/cloudflare/`, `wrangler.jsonc`, `src/app/api/operator/`, `docs/operations/cloudflare-migration/` | `npm run build:cloudflare` + `npm run test:cloudflare:artifact` + `npm run test:e2e:cloudflare` + `npm run test:setup:cloudflare` |
| Design system | `src/components/ui/`, `src/app/globals.css`, `src/fonts/`, `tailwind.config.ts`, `eslint.config.mjs` | `tests/unit/ui.*.test.tsx`; new visual vocabulary is added as a primitive here, never inline in a screen; changes follow a `docs/design/slice-*-spec.md` |

Vitest tests live in two tiers. `tests/unit/` runs under the base vitest config (jsdom) and mirrors the security or product boundary it protects; prefer a realistic regression at that boundary over snapshots of implementation detail. `tests/integration/` runs under `vitest.integration.config.mts` (node environment) against a runner-owned disposable `redis-server` via `tests/helpers/disposableRedis.ts` — it must never connect to an inherited, shared, or production Redis. Use `npm run test:redis-crash`, `npm run test:adversarial` and `npm run test:inventory:redis` (the OPS-04 Upstash inventory tool) for these suites; they need a local `redis-server` binary (or the CI container) and are the only place real-wire crash-cut and cross-tenant claims are actually exercised.

Cloudflare adds four tiers, all credential-free. `tests/workers/` runs inside workerd through `@cloudflare/vitest-plugin` (`vitest.workers.config.mts`, `cloudflare/test/`) with the same wrangler and workerd pins as production; it owns the Durable Object, scheduler, fault-cut and provider-request-count claims, and `tests/workers/contract.durable.test.ts` shares its scenarios with the Redis contract in `tests/integration/`. `tests/cloudflare-artifact/` and `tests/e2e-cloudflare/` run the built bundle in `dist/cloudflare/artifact` (never a separate development build) through wrangler's test harness; outbound requests are proxied through Node, where only synthetic provider responses answer and every other destination is refused and recorded. The launchers of those two lanes and of `tests/cloudflare-restart/` (`tests/cloudflare-artifact/harness.ts`, `tests/e2e-cloudflare/server.mjs`, `tests/cloudflare-restart/runner.mjs`) remove credential-like environment variables from their own process before wrangler is loaded and print the removed names, never values; the restart runner is also spawned with an allowlisted environment. `npm run check:cloudflare` removes them from every lane's environment and the build's, and prints the names once. The Worker under test receives only the synthetic bindings its launcher passes. One rule defines "credential-like" for all of them: `CREDENTIAL_NAME` in `scripts/cloudflare/credential-env.mjs`. A session that exports such a variable, such as a messaging token, can run these lanes without unsetting it. `tests/setup-cloudflare/` exercises the installer against fake wrangler and Cloudflare API boundaries. `npm run check:cloudflare` runs the full supported matrix against a clean commit (untracked files that are not ignored count as dirty) and writes the receipt that `npm run deploy:cloudflare` verifies.

`tests/smoke/` is a third, paid tier and is excluded from `npm run check`: `vitest.smoke.config.mts` runs one live `synthesizeInterview` through the real direct adapter to confirm the served response names a model. It is gated on `SMOKE_PROVIDER`, refuses if any other provider credential is present, forces direct transport and standalone mode, constructs no store client, and reports metadata or a failure class only. Run it when a provider adapter, SDK, or the provenance requirement changes; fixtures cannot establish live-provider compatibility.

`tests/e2e/` runs the browser journeys with real application API handlers and disposable Redis; only external provider HTTP responses are synthetic. `tests/e2e/server.mjs` builds and boots the production app with a blank, credential-free fixture environment (one server per transport) and `tests/e2e/workflow-fixture.ts` intercepts Upstash and provider HTTP at Next's test-mode boundary — together they are the sanctioned way to exercise the full researcher and participant workflow locally without any real credentials. Keep the Next test proxy confined to its test-only server launcher. Do not mock internal save/analyze APIs in the completion regression: it must exercise transcript persistence, deferred analysis, and researcher recovery across that boundary. The keyless demo regression still requires no API or external requests.

## Canonical commands

```bash
npm ci
npm run setup:check -- --mode demo
npm run setup:check -- --mode standalone
npm run check
npm run test:setup
DEPLOYMENT_MODE=standalone npm run build
npm run test:e2e
npm run test:redis-crash
npm run test:adversarial
npm run test:inventory:redis
npm run test:cloudflare
npm run test:contract:redis
npm run build:cloudflare
npm run test:cloudflare:artifact
npm run test:e2e:cloudflare
npm run test:setup:cloudflare
npm run check:cloudflare
git diff --check
```

For a hosted build, use the non-secret fixture environment from `.github/workflows/ci.yml`; never borrow live credentials. After multi-surface or security-sensitive changes, run the full CI-equivalent matrix rather than only the focused test.

## Local and generated paths

- Preserve `.claude/` unless explicitly authorized; it is not part of the application contract.
- Never commit or print `.env*.local`. `.env.example` contains names and safe placeholders only.
- `.vercel/project.json` is an ignored local project link, not deployment truth.
- `.open-next/`, `.wrangler/` and `dist/cloudflare/` are generated. `npm run build:cloudflare` refuses to build while any `.env*` or `.dev.vars*` file other than the `.example` templates is in the repository root, because OpenNext would inline its values into the Worker.
- `.next/`, `next-env.d.ts`, `tsconfig.tsbuildinfo`, `playwright-report/`, `test-results/`, and `node_modules/` are generated.
- Keep the Next-managed block in `CLAUDE.md`; `next dev` may restore it.
- The checkout lives in iCloud Drive, which leaves sync-conflict copies named `<file> 2.<ext>` anywhere, including `.next/types/` and `tests/`. `npm run check` starts with `scripts/check-sync-artifacts.mjs`, which fails on any such file; delete them, never commit them.

## Definition of done

- Preserve unrelated dirty files and review the scoped diff.
- Add or update the smallest realistic regression for changed behavior.
- Run focused verification, then the proportional full gate.
- Update `README.md`, `.env.example`, and this guide only when their contracts actually changed.
- Report remaining operational or migration caveats explicitly.
- Do not commit, push, merge, deploy, rotate credentials, or mutate external data without user authorization.
