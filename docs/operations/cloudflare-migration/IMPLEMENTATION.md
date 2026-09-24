# Cloudflare migration: implementation design

Status: implementation record for branch `feat/cloudflare-standalone`. This document records how the specification package in this directory is realized in code, which decisions the specification left open, and every deliberate deviation. The specifications remain the behavioral contract; where this document is more precise it records an implementation decision, not a change of requirement. Evidence lives in [`evidence/`](evidence/).

## 1. Module map and dependency direction

```
src/lib/runtime/            portable (no Workers imports), used by Node and Worker code
  target.ts                 DEPLOYMENT_TARGET resolution
  capabilities.ts           central target/mode/transport/storage/analysisExecution matrix (RT-01)
  workerInvocation.ts       per-invocation Worker env + admission identity accessor (RT-05, RT-07)
  clientAddress.ts          IP normalization and Cloudflare/Node identity adapters (RT-07)
  readinessGate.ts          not-ready gate for mutating and provider routes on Cloudflare (F10)
src/lib/providers/endpoint.ts   Cloudflare provider routes: explicit per-adapter endpoints, direct or Cloudflare AI
                            Gateway (RT-11), the exact cf-aig-* header set, refused SDK environment overrides,
                            covers(); shared by readiness, the fetch path and the Queue consumer
src/lib/transportDisclosure.ts  consent coverage of the current provider transport on participant and researcher routes
src/lib/storage/            backend-neutral domain boundary
  types.ts                  WorkspaceStorePort and per-operation result unions
  redis.ts                  Redis implementation wrapping kv.ts / participantLinks.ts / … (Node only)
  durableObject.ts          RPC client for the WorkspaceStore Durable Object (Worker only at runtime); assembles
                            keyset-paged interview lists and study lists in the requested view, summary items or
                            whole studies (pages of ≤ 12 MiB and ≤ 4 MiB of stored bytes respectively, ≤ 16 MiB per
                            list, else 413)
  resolve.ts                one factory choosing the store from resolved capabilities
  analysisProtocol.ts       job states, message envelope, public projection, constants (portable)
src/lib/backup/format.ts    operational backup format v1: families, chunk/manifest/trailer records, validator
                            (portable; the operator CLI loads it too)
src/lib/export/             researcher ZIP export: entry builders shared by both targets (interviewExport.ts)
                            and the streaming ZIP writer (zipStream.ts)
src/app/api/interviews/export/route.ts
                            Node: JSZip over ≤ 500 interviews. Cloudflare: streamed from an export snapshot in
                            pages of 50 rows / 4 MiB of stored bytes (the object caps pages at 200 rows / 16 MiB)
src/lib/ownedStudies.ts     also the Cloudflare aggregate/follow-up input pager: pages of 100 rows / 4 MiB,
                            ≤ 16 MiB serialized input, ≤ 1,000 interviews
src/lib/operatorAuth.ts, src/app/api/operator/   operator credential and routes (§6)
open-next.config.ts         selects the backpressure wrapper below (config validation disabled; see DEVIATIONS)
cloudflare/                 Worker-only sources (own tsconfig; never imported by src/)
  worker.ts                 custom entrypoint: fetch → OpenNext, queue → analysis consumer, exports WorkspaceStore
  internalHeaders.ts        withoutInternalHeaders(): strips x-openinterviewer-internal-* before OpenNext
  opennext/backpressureWrapper.ts   OpenNext server wrapper that honours response backpressure and errors
                            the body when the route's stream fails
  workspace/                the SQLite Durable Object and its domain transactions (incl. login.ts, operator.ts)
  analysis/                 Queue consumer and provider execution policy
  test/                     non-deployable test entries/configs
scripts/cloudflare/         build, check (release matrix + receipt), deploy, preview, setup (installer/*.mjs),
                            operator CLI, import-boundary check, inventory-redis (old Upstash, OPS-04)
skills/openinterviewer-cloudflare/   agent skill that drives scripts/cloudflare (SETUP-06)
```

Rules:

- `src/**` never imports `cloudflare/**`, `cloudflare:*` modules or `@opennextjs/cloudflare`. Worker values reach Next code only through `workerInvocation.ts`, which reads a `globalThis` accessor installed by `cloudflare/worker.ts`.
- `cloudflare/**` may import portable `src/lib/**` modules (types, validation, prompts, providers). It must not import `kv.ts`, `kvClient.ts`, `participantLinks.ts` runtime code or anything that constructs Redis.
- `kvClient.ts` refuses to construct any Redis client when the Worker runtime marker is present, independent of configuration (fence, not fallback).

## 2. Capability resolution (RT-01, RT-08)

`DEPLOYMENT_TARGET` accepts exactly `node` or `cloudflare`; absent means `node`. Supported matrix:

| target | mode | transport | storage | analysisExecution |
| --- | --- | --- | --- | --- |
| node | standalone | direct \| gateway | `redis` | `synchronous` |
| node | hosted | direct | `redis-byos` | `synchronous` |
| cloudflare | standalone | direct \| cloudflare-gateway | `workspace-do` | `queued-v2` |

`cloudflare` is production-strict: its validation never consults `NODE_ENV`. Evidence: in the Worker, `process.env.NODE_ENV` is undefined at runtime for aliased reads (OpenNext only replaces the literal expression), so `mode.ts`, `appBaseUrl.ts` and `hostedConfig.ts` would otherwise treat a Worker as development and fail open. On Cloudflare a missing `DEPLOYMENT_MODE`, `APP_BASE_URL` or HTTPS origin is an error.

Cloudflare configuration (non-secret `vars` unless noted):

| Name | Purpose |
| --- | --- |
| `DEPLOYMENT_TARGET=cloudflare`, `DEPLOYMENT_MODE=standalone`, `AI_TRANSPORT=direct\|cloudflare-gateway` | capability selection (RT-11: `cloudflare-gateway` sends each provider request through the installation's own Cloudflare AI Gateway) |
| `CF_AI_GATEWAY_ACCOUNT_ID`, `CF_AI_GATEWAY_ID` | with `cloudflare-gateway`: the account (32 hex) and the installation's gateway (the Worker name, never `default`); empty on direct. The installer provisions the gateway (SETUP-08, INSTALLER.md) |
| `APP_BASE_URL` | stable HTTPS origin (workers.dev allowed) |
| `AI_PROVIDER` | the installation's default provider (sample seed, legacy studies) |
| `WORKSPACE_ID` | stable installation workspace identity, `ws_` + 32 hex; selects the DO by name |
| `WORKSPACE_JURISDICTION` | `eu`, `fedramp` or empty; applied in every stub lookup |
| `WORKSPACE_BOOTSTRAP` | `open` or `recovery` only while the installer initializes a fresh object; empty otherwise. `deploy.mjs` accepts a set value only with `--bootstrap`, which the installer passes for its initial, origin and workspace-init deploys; the CI promotion never does |
| secrets | `ADMIN_PASSWORD` (16 characters minimum; at most a 1 KiB sign-in body, §6), `SESSION_SECRET`, `PARTICIPANT_TOKEN_SECRET`, `RATE_LIMIT_SALT`, `OPERATOR_TOKEN`, each bound provider key (any of the four; the `AI_PROVIDER` key is required), `CF_AI_GATEWAY_TOKEN` (the AI Gateway Run token, required with `cloudflare-gateway`, allowed but never sent on direct), and `ANALYSIS_RECOVERY_EPOCH` (`ep_` + 32 hex). The epoch's value is not sensitive. It is a secret binding so that `wrangler rollback` to a version from before a rotation lists it as a changed secret and asks for confirmation. That prompt is a warning, not a guard: it defaults to yes and is answered yes automatically without a TTY or in CI (RUNBOOK OPS-03) |
| bindings | `WORKSPACE_STORE` (DO), `ANALYSIS_QUEUE` (producer) |

Readiness: `/api/config/readiness` keeps its 200 contract and gains `analysisExecution`; `/api/health/ready` returns 503 when configuration, bindings or the bounded (2 s) DO readiness RPC fail. Cloudflare health adds `checks.workspaceStore` and `checks.analysisQueue` (binding presence only) and never reports Redis. Readiness never dispatches, writes or calls a provider.

### Cloudflare AI Gateway transport (RT-11)

Owner amendment, 24 September 2026 (design record gw-final, decisions D1–D14). Every departure and every live fact still unconfirmed is in [DEVIATIONS.md](evidence/DEVIATIONS.md).

| Decision | Implementation |
| --- | --- |
| D1 Transport value | `AI_TRANSPORT=cloudflare-gateway` on the Cloudflare target only. Vercel `gateway` stays Node-only (`unsupported_cloudflare_transport`); Node refuses `cloudflare-gateway` (`invalid_ai_transport`, check-setup `env.AI_TRANSPORT.cloudflare_only`). |
| D2 One source of truth | `activeAITransport()` in `src/lib/runtime/capabilities.ts`; Node callers keep their previous rule. |
| D3, D4 Route | The four native adapters, each on its provider-native path under `https://gateway.ai.cloudflare.com/v1/{CF_AI_GATEWAY_ACCOUNT_ID}/{CF_AI_GATEWAY_ID}/{google-ai-studio,anthropic,openai,openrouter}`. Code builds the URL from validated identifiers; there is no configurable URL and no unified, universal or dynamic route. |
| D5 Explicit endpoints | On Cloudflare every adapter, direct too, gets an explicit endpoint and credential options; 23 SDK environment names are refused (`provider_sdk_env_override`). |
| D6 Headers | Exactly `cf-aig-authorization`, `cf-aig-collect-log: false`, `cf-aig-collect-log-payload: false`, `cf-aig-skip-cache: true`, `cf-aig-max-attempts: 1`, `cf-aig-no-wholesale: true`; none on direct. Anthropic and OpenAI get a `fetch` wrapper and OpenRouter a `beforeRequest` hook that replace any other `cf-aig-*` header. |
| D7, D13 Gateway | One per installation (id = the Worker name, never `default`), created by the installer's `ai-gateway` phase with authentication on, logs, caching and retries off and `byok_only`, adopted only on recorded evidence, never updated or deleted (SETUP-08, [INSTALLER.md](INSTALLER.md#ai-gateway-policy)). |
| D8 Keys | Provider keys stay Worker secrets sent on each request; no stored gateway keys and no Unified Billing. The Run token `CF_AI_GATEWAY_TOKEN` is a separate secret, independent of every other one. |
| D9 Consent | The link exchange discloses `effectiveTransport(route, provider)`; consent, the saved interview (`consentTransport`) and each frozen analysis input (`disclosedTransport`) record it. A provider call carrying participant content runs only when `covers(disclosed, current)`: the current route is direct or equals the disclosed one (`src/lib/transportDisclosure.ts`, the Queue consumer and the object). |
| D10 Key set | Any subset of the four keys; `AI_PROVIDER` is the default provider and its key is required. |
| D11 Provenance | `aiTransport: 'cloudflare-gateway'` on interview, aggregate and follow-up provenance, from the endpoint the adapter used. The served model still comes from the response body. |
| D12 Errors | Classification unchanged; `provider.failure` logs add `origin: 'gateway'` for an `AiGatewayError` body. |
| D14 Gemini seam | `effectiveTransport(route, provider)` returns the route's transport for every provider today; it is the place to keep Gemini direct if the S1 gate fails. |

The Queue consumer checks the capability, the route and consent coverage before the start marker; a failed check finishes the generation failed/provider with zero provider requests (`provider-route-invalid`, `transport-not-disclosed`). There is no fallback from the gateway to direct.

## 3. Worker entry, invocation context and identity (RT-02, RT-05, RT-07, RT-10)

`cloudflare/worker.ts`:

1. Installs the runtime marker and the invocation accessor once per isolate.
2. `fetch`: refuses (503, no OpenNext) unless `env.DEPLOYMENT_TARGET === 'cloudflare'`; derives the admission identity from `CF-Connecting-IP` only (normalized; `CF-Worker` present → `subrequest`); removes the reserved `x-openinterviewer-internal-*` header namespace from the incoming request (`withoutInternalHeaders`, `cloudflare/internalHeaders.ts`); runs OpenNext inside `AsyncLocalStorage` holding `{ env, identity, source: 'fetch' }`.
3. `queue`: validates and processes analysis messages with explicit `env` (never an HTTP request).
4. Exports `WorkspaceStore`.

Identity is carried by `AsyncLocalStorage`, not by a header, so a browser cannot forge it. Normalization: strict dotted-quad IPv4; IPv6 parsed and re-serialized in full 8-group lowercase form; IPv4-mapped IPv6 collapses to IPv4; lists, ports, brackets, zone suffixes and whitespace are invalid. Invalid/missing identity uses the salted `unknown` bucket and emits one bounded `admission.identity` diagnostic without the address. Participant greeting/interview/save refuse `subrequest` identity (403) before provider use or persistence. On Cloudflare `RATE_LIMIT_SALT` is mandatory (no fallback chain). Node keeps its existing header chain unchanged.

Logs: `observability.logs.invocation_logs` is disabled in `wrangler.jsonc` because automatic invocation logs capture `/p/<code>` and `/api/generate-link?token=` URLs; application structured events remain.

## 4. Storage boundary (ST)

`ResearcherContext` gains `store: WorkspaceStorePort`. Standalone routes (Node and Cloudflare) use `context.store`; hosted-only saga paths keep `context.kvClient`. On Cloudflare `kvClient` is a fence whose every method throws `RedisAccessFencedError` without I/O.

Port operations keep the existing result unions and HTTP mappings. Composite operations (create with idempotency, completion with admission and initial job, sample seed/clear) are single port methods. Analysis job methods (`acceptAnalysisRetry`, `readAnalysisStatus`), export snapshots (`beginExport`, `readExportPage`, `verifyExportSequence`) and aggregate-input paging (`readAggregateInputs`) exist only on the durable capability (`DurableWorkspaceStorePort`); `claimAnalysisJob`, `markAnalysisStarted` and `finishAnalysisJob` are DO RPCs used only by the Queue consumer. The Redis store does not implement jobs. Sign-in attempts use a separate port (`LoginAttemptBudgetPort`, §6).

### Durable Object schema (logical)

`workspace_meta` (singleton), `schema_migrations`, `studies`, `interviews`, `analysis`, `analysis_jobs`, `aggregates`, `participant_links`, `consents`, `idempotency_receipts`, `budget_windows`, `budget_members`, `deletion_fences`, `operator_audit`, `login_attempts`. All timestamps are integer epoch ms; JSON columns store the exact text written; SQL uses bound parameters only. `operator_audit` and `login_attempts` are per-object operational state: they are not backup families and do not advance the research mutation sequence. Export snapshots and the Queue consumer-contact marker live in the object's synchronous KV storage, outside SQL and backups.

### Migrations (ST-09)

Numbered migrations live in `cloudflare/workspace/schema.ts` as `Migration` records; only migration 1 exists and it is unreleased. A migration declares reader compatibility with the optional `Migration.minReaderVersion`, which the checksum (statements only) does not cover. The runner (`cloudflare/workspace/migrate.ts`) applies each pending migration in its own `transactionSync` together with its ledger row `schema_migrations(version, checksum, applied_at, min_reader_version)`. A build serves a database only when the ledger has no gap, every migration it knows has a matching checksum, and every applied migration it does not know declares `min_reader_version` at or below the build's highest migration. `min_reader_version` defaults to the migration's own version, so older builds refuse; a migration lowers it only for changes older builds can ignore (nullable or defaulted columns, tables they never read) while still serving the newer build's pending jobs. A refused database is `schema-unsupported`: readiness fails, reads and mutations refuse, and the alarm re-arms hourly. The artifact manifest records `schema.current` (highest migration) and `schema.minReadable` (oldest stored schema the build reads). `tests/workers/schema.migrations.test.ts` rehearses N−1 → N → N−1 → N with a synthetic additive migration.

### Decisions on recorded Redis behavior

| Redis behavior (evidence: storage catalog) | DO behavior | Redis wrapper |
| --- | --- | --- |
| Refused populated delete leaves an in-flight guard that blocks later saves/edits | refusal has no side effects | unchanged; documented residual |
| Create-idempotency index is lifetime-bounded at 100 | quota counts only unexpired (7-day) receipts | unchanged; documented residual |
| Save admission check and charge are separate scripts (concurrent overshoot) | check-all then charge-all in one transaction | unchanged; documented residual |
| P1 crash without retry blocks the study | impossible (one transaction) | unchanged |
| Completion does not re-check link/consent at the write | re-checks link active/unexpired, study revision, links enabled and consent binding | route-level checks retained |
| Link creation does not check study/revision | checks study exists, revision current, links enabled | route-level checks retained |
| Aggregate save accepts a deleted study | refuses deleted/missing target | unchanged |
| Sample clear leaves aggregate/links | clear cascades fixture aggregate, links, consent, jobs; refuses if participant interviews exist in the fixture study | adds aggregate removal only |
| Deleting an unknown study returns deleted | same (idempotent) | same |
| Replay of a committed save after revoke/edit/delete is refused | same order: authority before duplicate detection | same |

### Transactions

SQL-only operations use `transactionSync`. Operations that create or change a nonterminal job use `ctx.storage.transaction(async () => { SQL; await setAlarm(min) })`, proven locally in M0. Randomness (IDs, claim nonces) and the operation timestamp are captured before the transaction callback.

## 5. Durable analysis (JOB, API)

Implemented exactly as `03-analysis-jobs.md` with these constants in `analysisProtocol.ts`: claim lease 180 s, synthesis deadline 120 s, attach margin 20 s, dispatch budget 16 attempts / 24 h, backoff 5 s·2ⁿ⁻¹ capped at 30 min, watchdog 5 min, 25 due rows per alarm, retry receipts 7 days, terminal job detail pruned after 30 days.

Provider outcome classification under the queued policy:

| Outcome | Job result | Public projection |
| --- | --- | --- |
| Valid synthesis within size | `complete` | complete |
| `config` (400/401/402/403/404/422), `rate-limited` (429), missing key before start | `failed/provider` | failed |
| Invalid or oversized output | `failed/invalid-output` or `failed/too-large` | failed |
| Timeout, abort, network failure, 5xx, unclassified exception after start | `recovery-required` | failed, `failureKind: 'timeout'`, `recoveryRequired: true` |

5xx responses are treated as uncertain because the specification limits known failures to configuration, rate-limit, invalid-output and size rejections.

## 6. Operator surface (OPS)

Operator actions are served by six routes under `/api/operator/` on the Cloudflare target only (404 on Node). There is no unauthenticated maintenance route. Authority (`src/lib/operatorAuth.ts`, gap F5) is checked in this order, before any storage call:

1. `OPERATOR_TOKEN` is bound in the invocation env, at least 32 characters and not a template value (else 503 `OPERATOR_NOT_CONFIGURED`);
2. `Authorization: Bearer <token>` matches it in constant time: SHA-256 digests of both values compared with `timingSafeEqual` (else 401 `OPERATOR_UNAUTHORIZED` with `WWW-Authenticate: Bearer`);
3. a valid standalone researcher session cookie (else 401 `SIGN_IN_REQUIRED`) issued within the last 15 minutes (else 403 `RECENT_SIGN_IN_REQUIRED`).

| Route | Effect | Outcomes |
| --- | --- | --- |
| `GET /api/operator/status` | Maintenance state/version, schema version, activated epoch and whether it matches the deployment, record counts, job counts, scheduled alarm | 200; 503 `WORKSPACE_HELD`, `WORKSPACE_UNAVAILABLE` |
| `POST /api/operator/maintenance` `{expectedState, expectedVersion, nextState, classifyInFlight?}` | Compare-and-set transition | 200 `transitioned` or `already` (replay of the recorded transition); 409 `MAINTENANCE_CONFLICT` (with the current state/version), `ANALYSIS_IN_FLIGHT`, `INVALID_TRANSITION`; 503 `DEPLOYMENT_NOT_READY`, `WORKSPACE_HELD`, `OUTCOME_UNKNOWN` |
| `GET /api/operator/backup?family=&cursor=&watermark=` | One backup page; the watermark `<maintenanceVersion>:<mutationSeq>` from the first page is required on every later page | 200; 400; 409 `NOT_FROZEN` (not `frozen` or `recovery`), `WATERMARK_CHANGED`; 503 `WORKSPACE_HELD`, `WORKSPACE_UNAVAILABLE` |
| `POST /api/operator/backup/import` `{manifest, chunk \| null, finalize?}` | One chunk, idempotent by `(family, index)` under one manifest digest, or finalize (counts, references, identities) | 200 `accepted` or `finalized`; 422 `IMPORT_REJECTED` (error class and counts only); 409 `WORKSPACE_NOT_EMPTY`, `NOT_RECOVERY`; 503 `WORKSPACE_HELD`, `OUTCOME_UNKNOWN` |
| `POST /api/operator/recovery/restore` `{expectedState, expectedVersion, bookmark \| at}` (`at` in epoch ms) | Schedules a point-in-time restore of the object for its next session, then restarts the object after replying. Every refusal comes before any point-in-time storage call. It requires `frozen` or `recovery` at exactly the expected state and version, exactly one of a bookmark or a time (within 30 days and not in the future), and a bound epoch that is valid, differs from the activated one and was never activated there. It writes nothing | 200 `scheduled` `{bookmark, undoBookmark}`; 409 `MAINTENANCE_CONFLICT` (with the current state/version), `NOT_HELD`, `EPOCH_NOT_ROTATED`; 422 `BOOKMARK_REFUSED`; 503 `WORKSPACE_HELD`, `OUTCOME_UNKNOWN` |
| `POST /api/operator/recovery/activate` `{expectedActivatedEpoch}` | Reconciles every restored unfinished generation to recovery-required, then activates the epoch from the Worker's secret binding (never from the request) | 200 `activated` or `already-active`; 409 `EPOCH_CONFLICT`, `NOT_RECOVERY`; 503 `WORKSPACE_HELD`, `OUTCOME_UNKNOWN` |

Every route may also answer 400 `INVALID_REQUEST`, 415 (POST without `application/json`), 413 (maintenance, restore and activation bodies above 1 KiB, import bodies above 24 MiB), 503 `WORKSPACE_NOT_CONFIGURED` (missing binding) and 500 `INTERNAL`. Responses are JSON with `Cache-Control: no-store`; every decision is logged once as an allowlisted `operator.action` event without content, and the object writes an `operator_audit` row for each transition, import and activation. A scheduled restore writes no audit row, because the restore would rewind it; it is logged as `operator.action` with operation `restore.schedule` instead. Its request label is operation `recovery.restore`, a member of the `OperatorOperation` union in `src/lib/operatorAuth.ts`. A held 503 carries the public `reason` and, for the authenticated operator only, the exact `holdReason`.

Readiness-gate exemptions (F10, `src/app/api/operator/_lib/http.ts`): the status and backup reads, backup import, recovery activation (both act only inside the `recovery` hold, which the object enforces), the point-in-time restore (only inside the `frozen` or `recovery` hold with the epoch already rotated) and transitions that tighten the hold (open → draining, any state → frozen or recovery) skip `deploymentNotReadyResponse`, so a not-ready installation can be diagnosed, backed up and restored. A transition that resumes work (to `open`, or `frozen` → `draining`) passes the gate first, so a not-ready deployment is never reopened.

The object allows open → draining; draining → open or frozen; frozen → open or draining; recovery → frozen or open; and any state → recovery. Entering `frozen` with claimed or started attempts is refused unless `classifyInFlight` returns claims to `pending` and marks started attempts recovery-required. Leaving `recovery` is refused while an import is in progress. While the activated epoch differs from the deployment's, every target except `recovery` is refused as held. A transition that resumes work re-arms the scheduler in the same storage transaction. `scripts/cloudflare/operator.mjs` (`npm run operator:cloudflare`) drives these routes; see [RUNBOOK.md](RUNBOOK.md).

### Sign-in budget

On Cloudflare, `POST /api/auth` reads at most 1 KiB of body as it streams in (413 above), takes `ADMIN_PASSWORD` from the invocation env and asks the object to admit the attempt before comparing the password (`cloudflare/workspace/login.ts`). The body bound is `MAX_CLOUDFLARE_LOGIN_BODY_BYTES` in `src/lib/loginBody.ts`. It gives the password a maximum: the UTF-8 size of `JSON.stringify({ password })` must stay within 1,024 bytes, which allows 1,009 ASCII characters and fewer when characters are multi-byte or escaped by JSON. The installer (`scripts/cloudflare/installer/model.mjs`, `MAX_LOGIN_BODY_BYTES`) and the operator CLI refuse a longer password, `setup:check --target cloudflare` reports it as `env.ADMIN_PASSWORD.too_long`, and readiness reports it as `admin_password_too_long`. The Login form sets no length limit, because it does not know the target and Node has no body bound; on Cloudflare it shows the 413 "Request body is too large". Admission is atomic: in one transaction it refuses when either fixed window is full, otherwise counts the attempt in both. The windows are 10 attempts per client key per 15 minutes (the key is an HMAC under `RATE_LIMIT_SALT` of the full normalized IPv4 or IPv6 address, or the shared `unknown` or `subrequest` scope, so no address reaches storage; see DEVIATIONS.md for the open /64 question) and 200 across all clients per hour; each opens at its first counted attempt and later attempts never extend it. A refused attempt counts in neither window. A limit returns 429 with `Retry-After` (the later window end); an unavailable budget returns 503 (fail closed). A correct password refunds its attempt. A refund that is lost leaves the attempt counted, and sign-in still succeeds. Sign-in is not gated on readiness or maintenance; the object refuses it only when the schema is unsupported.

## 7. Decisions from the independent gap review

An adversarial review of the specification against code and platform facts (23 September 2026) found no blocker and twelve major gaps. Decisions:

| Gap | Decision |
| --- | --- |
| Fresh-object bootstrap (F2) | An empty object initializes only when `WORKSPACE_BOOTSTRAP` is `open` or `recovery`. Otherwise every call is held with `workspace-uninitialized`, so identity, jurisdiction or Worker-name drift can never create an empty writable workspace. The installer sets it for the first deployment (or an import target) and clears it afterwards. `deploy.mjs` accepts a set value only with `--bootstrap`, which only the installer's initial, origin and workspace-init deploys pass, so a copied bootstrap config (for example in the CI promotion) is refused before upload. |
| Epoch rollback (F4) | `ANALYSIS_RECOVERY_EPOCH` is a secret binding. Across a modified secret, `wrangler rollback` lists the secret and asks for confirmation (API code 10220), whereas a var would roll back silently. The prompt defaults to yes and is answered yes automatically without a TTY or in CI (wrangler 4.136.3, `confirm2`), so it is a warning, not a guard. The RUNBOOK therefore forbids any rollback between an epoch rotation and its activation, and re-checks `epoch.configuredMatches` after the restore (OPS-03). |
| Operator credential (F5) | Operator routes require a constant-time match of a separate installer-generated `OPERATOR_TOKEN` secret **and** a researcher session issued within 15 minutes (§6). Cloudflare adds a DO-backed sign-in attempt budget and a 1 KiB login body, which bounds `ADMIN_PASSWORD` (§6). |
| Deploy provisioning (F3) | `deploy:cloudflare` uploads the prebuilt `--dry-run` bundle with `no_bundle` + `find_additional_modules` (the same derivation `createTestHarness` uses), passes `--config` (bypassing OpenNext delegation), `--experimental-provision=false --experimental-auto-create=false --strict`. Locally proven by wrangler dry run; real upload is a remote gate. |
| Dispatch budget vs backlog (F6) | The watchdog charges the dispatch budget only if no consumer contact has been recorded since the job's last send; healthy backlog defers without charging. The 24-hour pre-start cap remains. |
| Export livelock (F1) | Export captures the ordered interview key set and each row's analysis state at start. Pages overlay the captured analysis state (analysis only moves forward; transcripts are immutable; syntheses are write-once), and invalidate only on deletion of a captured row or replacement of a captured aggregate. Streaming ZIP; an invalidated stream errors, never closes cleanly: the OpenNext backpressure wrapper errors the response body, and the browser client refuses any download that lacks the ZIP end record. |
| Batch eligibility (F8) | Cloudflare batches select generation-0 `not-scheduled`, persisted `failed` and recovery-required items (with the disclosure); active generations are shown as a separate queued/running count. The durable projection omits claim fields. |
| Not-ready gate (F10) | Mutating and provider routes on the Cloudflare target call one readiness gate (configuration, including runtime placeholder-secret detection) before storage or provider use; the DO gate repeats identity/epoch/maintenance checks. |
| Backup watermark (F11) | `frozen` and `recovery` suspend all alarm work (dispatch, watchdog and cleanup) except re-arming, so `(maintenance_version, mutation_seq)` is a complete watermark while held. |
| Queue graph (F12) | `providerErrorResponse` moves to a route-only module so the Queue bundle never imports `next/*`; an import-boundary test covers `cloudflare/worker.ts`. |
| Poison job rows (F13) | Corrupt due job rows are quarantined out of the due scan (the row itself is never patched) with count-only telemetry. |
| Lease clock (F14) | Claim, start and finish decisions use the object's own clock; caller time is advisory. |
| Maintenance for paid no-write calls (F26) | Researcher preview (synthesis, greeting and interview preview) and follow-up generation are allowed in `open` and `draining` and refused in `frozen`/`recovery`; link exchange is refused in `draining`. Aggregate synthesis is a researcher mutation (it ends in the aggregate write): it is refused in `draining`, `frozen` and `recovery` before the provider is paid. |
| Import mapping (F7) | Any importer maps Node analysis states: none/`pending` with 0 attempts → generation 0 not-scheduled; synthesis/`complete` → generation 0 complete; `failed` → generation-0 synthetic terminal failed job (never enqueued); `running` or `pending` with attempts → generation-0 synthetic recovery-required. Attempts copy verbatim. |

## 8. Deviations register

Maintained in [`evidence/DEVIATIONS.md`](evidence/DEVIATIONS.md). Each entry states the requirement, the evidence and the chosen alternative.
