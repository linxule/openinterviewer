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
- CI gates and safe hosted build fixtures: `.github/workflows/ci.yml`
- Shared domain shapes: `src/types.ts`

Production is external state. Verify it through the deployment provider and public readiness endpoints; do not preserve a live snapshot in repository guidance.

## Product surfaces

- Public landing: `src/app/page.tsx` -> `src/components/Landing.tsx`
- Keyless synthetic demo: `src/app/demo/page.tsx` -> `src/components/DemoSimulation.tsx`
- Self-host guide: `src/app/self-host/page.tsx`
- Researcher workspace: `src/app/{login,onboarding,studies,setup,dashboard,settings}`
- Participant link entry: `src/app/p/[token]/page.tsx`
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

`standalone` uses one administrator session plus deployment-owned Upstash credentials and either direct provider keys or Vercel AI Gateway/OIDC. `hosted` uses OAuth accounts, a platform control-plane Redis database, encrypted researcher BYOS credentials, direct native provider adapters, and a distinct researcher-owned Redis database for research records.

### Storage and tenancy

- Researcher studies/interviews and atomic Redis scripts: `src/lib/kv.ts`
- Redis client construction, cache lifecycle, and Upstash URL validation: `src/lib/kvClient.ts`
- Public Redis port and node-redis test adapter: `src/lib/redisPort.ts`, `src/lib/redisNodeAdapter.ts`
- Closed Redis wire parsers: `src/lib/wire/`
- Hosted accounts, ownership, quotas, and operation records: `src/lib/platformDb.ts`, `src/lib/platformDb.operations.ts`, `src/lib/platformDb.accountDelete.ts`
- Create idempotency mapping: `src/lib/createIdempotency.ts`
- Hosted owned-study collection loading: `src/lib/ownedStudies.ts`
- Hosted credential envelopes: `src/lib/crypto.ts`
- Cross-database study-operation repair: `src/lib/studyOperationReconciler.ts`
- Disposable Redis fault harness: `tests/helpers/disposableRedis.ts`, `tests/helpers/faultManifest.ts`

Hosted study create/delete is a durable cross-database operation. Preserve the operation marker/tombstone and reconciliation protocol; a superficially simpler sequence can reintroduce orphaned ownership or BYOS records.

### Participant and AI flow

- Opaque participant links: `src/lib/participantLinks.ts`
- Server-recorded consent: `src/lib/participantConsent.ts`
- Canonical study loading: `src/lib/canonicalStudy.ts`
- Synthesis/save binding: `src/lib/synthesisReceipt.ts`, `src/lib/interviewSubmission.ts`
- Bounded request parsing: `src/lib/requestBody.ts`
- Providers and prompts: `src/lib/providers/`, `src/lib/prompts/`, `src/lib/ai.ts`
- Transport selection and Gateway model mapping: `src/lib/aiTransport.ts`, `src/lib/providers/gateway.ts`
- Provider result validation/errors: `src/lib/providerValidation.ts`, `src/lib/providerErrors.ts`
- Evidence citation matching (render-time classification; verdicts never stored): `src/lib/evidence.ts`
- Participant and hosted platform limits: `src/lib/rateLimit.ts`, `src/lib/platformAiRateLimit.ts`
- Browser API clients: `src/services/`
- Session-scoped workflow state: `src/store.ts`

The participant sequence is link exchange -> HttpOnly participant session -> consent -> greeting/interview -> synthesis receipt -> immutable save. Every participant route must re-resolve authority and the server-owned current study revision before provider use or persistence.

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
- User-provided Redis URLs remain restricted to HTTPS Upstash hosts; preserve bounded validation deadlines.
- AI/provider failure is an error. Never substitute a plausible research response, synthesis, or greeting.
- Completion persistence and study mutation remain atomic and idempotent under retries and concurrency.
- Editing a study advances its revision and invalidates older participant authority.
- Synthesis provenance must record the provider and model actually used, which may differ from the interview-turn model.

## Change map and focused gates

| Area | Primary paths | Minimum focused verification |
| --- | --- | --- |
| Public demo | `DemoSimulation.tsx`, `app/demo`, demo tests | accessibility unit test + `npm run test:e2e` |
| Mode/setup | `mode.ts`, `hostedConfig.ts`, checker/env/docs | mode/config/setup tests + standalone and hosted builds |
| Auth/participant authority | `auth.ts`, `proxy.ts`, `researcherContext.ts`, participant libraries | matching auth/consent/link tests + `npm run check` |
| Storage/tenancy | `kv.ts`, `kvClient.ts`, `platformDb.ts`, reconciler | atomicity/tenancy/saga tests + `npm run check` |
| Providers/provenance | `aiTransport.ts`, `providers/`, `prompts/`, interview/synthesis routes | transport/provider/provenance tests + direct/Gateway build contracts + `npm run check` |
| Structured request logs | `src/lib/requestLog.ts`, `providerErrors.ts`, API catch sites | `requestLog.test.ts` + `providerErrors.test.ts` + health/config contract tests |
| Participant/preview headers | `src/services/participantHeaders.ts`, `interviewApi.ts`, `storageService.ts`, `Consent.tsx` | `participantHeaders.test.ts` + `participantSessionHeaders.test.ts` + consent/isolation suites |
| Researcher UI | components, services, page entry | paired component/API tests; inspect 375px when layout changes |

Tests live in two tiers. `tests/unit/` runs under the base vitest config (jsdom) and mirrors the security or product boundary it protects; prefer a realistic regression at that boundary over snapshots of implementation detail. `tests/integration/` runs under `vitest.integration.config.mts` (node environment) against a runner-owned disposable `redis-server` via `tests/helpers/disposableRedis.ts` — it must never connect to an inherited, shared, or production Redis. Use `npm run test:redis-crash` and `npm run test:adversarial` for these suites; they need a local `redis-server` binary (or the CI container) and are the only place real-wire crash-cut and cross-tenant claims are actually exercised.

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
git diff --check
```

For a hosted build, use the non-secret fixture environment from `.github/workflows/ci.yml`; never borrow live credentials. After multi-surface or security-sensitive changes, run the full CI-equivalent matrix rather than only the focused test.

## Local and generated paths

- Preserve `.claude/` unless explicitly authorized; it is not part of the application contract.
- Never commit or print `.env*.local`. `.env.example` contains names and safe placeholders only.
- `.vercel/project.json` is an ignored local project link, not deployment truth.
- `.next/`, `next-env.d.ts`, `tsconfig.tsbuildinfo`, `playwright-report/`, `test-results/`, and `node_modules/` are generated.
- Keep the Next-managed block in `CLAUDE.md`; `next dev` may restore it.

## Definition of done

- Preserve unrelated dirty files and review the scoped diff.
- Add or update the smallest realistic regression for changed behavior.
- Run focused verification, then the proportional full gate.
- Update `README.md`, `.env.example`, and this guide only when their contracts actually changed.
- Report remaining operational or migration caveats explicitly.
- Do not commit, push, merge, deploy, rotate credentials, or mutate external data without user authorization.
