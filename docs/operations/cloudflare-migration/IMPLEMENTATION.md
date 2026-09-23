# Cloudflare migration: implementation design

Status: implementation record for branch `feat/cloudflare-standalone`. This document records how the specification package in this directory is realized in code, which decisions the specification left open, and every deliberate deviation. The specifications remain the behavioral contract; where this document is more precise it records an implementation decision, not a change of requirement. Evidence lives in [`evidence/`](evidence/).

## 1. Module map and dependency direction

```
src/lib/runtime/            portable (no Workers imports), used by Node and Worker code
  target.ts                 DEPLOYMENT_TARGET resolution
  capabilities.ts           central target/mode/transport/storage/analysisExecution matrix (RT-01)
  workerInvocation.ts       per-invocation Worker env + admission identity accessor (RT-05, RT-07)
  clientAddress.ts          IP normalization and Cloudflare/Node identity adapters (RT-07)
src/lib/storage/            backend-neutral domain boundary
  types.ts                  WorkspaceStorePort and per-operation result unions
  redis.ts                  Redis implementation wrapping kv.ts / participantLinks.ts / … (Node only)
  durableObject.ts          RPC client for the WorkspaceStore Durable Object (Worker only at runtime)
  resolve.ts                one factory choosing the store from resolved capabilities
  analysisProtocol.ts       job states, message envelope, public projection, constants (portable)
cloudflare/                 Worker-only sources (own tsconfig; never imported by src/)
  worker.ts                 custom entrypoint: fetch → OpenNext, queue → analysis consumer, exports WorkspaceStore
  workspace/                the SQLite Durable Object and its domain transactions
  analysis/                 Queue consumer and provider execution policy
  test/                     non-deployable test entries/configs
scripts/cloudflare/         build, deploy, setup (installer), operator and manifest tooling
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
| cloudflare | standalone | direct | `workspace-do` | `queued-v2` |

`cloudflare` is production-strict: its validation never consults `NODE_ENV`. Evidence: in the Worker, `process.env.NODE_ENV` is undefined at runtime for aliased reads (OpenNext only replaces the literal expression), so `mode.ts`, `appBaseUrl.ts` and `hostedConfig.ts` would otherwise treat a Worker as development and fail open. On Cloudflare a missing `DEPLOYMENT_MODE`, `APP_BASE_URL` or HTTPS origin is an error.

Cloudflare configuration (non-secret `vars` unless noted):

| Name | Purpose |
| --- | --- |
| `DEPLOYMENT_TARGET=cloudflare`, `DEPLOYMENT_MODE=standalone`, `AI_TRANSPORT=direct` | capability selection |
| `APP_BASE_URL` | stable HTTPS origin (workers.dev allowed) |
| `AI_PROVIDER` | the installation's default provider (sample seed, legacy studies) |
| `WORKSPACE_ID` | stable installation workspace identity, `ws_` + 32 hex; selects the DO by name |
| `WORKSPACE_JURISDICTION` | `eu`, `fedramp` or empty; applied in every stub lookup |
| `WORKSPACE_BOOTSTRAP` | `open` or `recovery` only while the installer initializes a fresh object; empty otherwise |
| secrets | `ADMIN_PASSWORD`, `SESSION_SECRET`, `PARTICIPANT_TOKEN_SECRET`, `RATE_LIMIT_SALT`, `OPERATOR_TOKEN`, the selected provider key, and `ANALYSIS_RECOVERY_EPOCH` (`ep_` + 32 hex; a secret binding only so `wrangler rollback` cannot silently reinstate an older epoch — its value is not sensitive) |
| bindings | `WORKSPACE_STORE` (DO), `ANALYSIS_QUEUE` (producer) |

Readiness: `/api/config/readiness` keeps its 200 contract and gains `analysisExecution`; `/api/health/ready` returns 503 when configuration, bindings or the bounded (2 s) DO readiness RPC fail. Cloudflare health adds `checks.workspaceStore` and `checks.analysisQueue` (binding presence only) and never reports Redis. Readiness never dispatches, writes or calls a provider.

## 3. Worker entry, invocation context and identity (RT-02, RT-05, RT-07, RT-10)

`cloudflare/worker.ts`:

1. Installs the runtime marker and the invocation accessor once per isolate.
2. `fetch`: refuses (503, no OpenNext) unless `env.DEPLOYMENT_TARGET === 'cloudflare'`; derives the admission identity from `CF-Connecting-IP` only (normalized; `CF-Worker` present → `subrequest`); removes the reserved `x-openinterviewer-internal-*` header namespace from the incoming request; runs OpenNext inside `AsyncLocalStorage` holding `{ env, identity, source: 'fetch' }`.
3. `queue`: validates and processes analysis messages with explicit `env` (never an HTTP request).
4. Exports `WorkspaceStore`.

Identity is carried by `AsyncLocalStorage`, not by a header, so a browser cannot forge it. Normalization: strict dotted-quad IPv4; IPv6 parsed and re-serialized in full 8-group lowercase form; IPv4-mapped IPv6 collapses to IPv4; lists, ports, brackets, zone suffixes and whitespace are invalid. Invalid/missing identity uses the salted `unknown` bucket and emits one bounded `admission.identity` diagnostic without the address. Participant greeting/interview/save refuse `subrequest` identity (403) before provider use or persistence. On Cloudflare `RATE_LIMIT_SALT` is mandatory (no fallback chain). Node keeps its existing header chain unchanged.

Logs: `observability.logs.invocation_logs` is disabled in `wrangler.jsonc` because automatic invocation logs capture `/p/<code>` and `/api/generate-link?token=` URLs; application structured events remain.

## 4. Storage boundary (ST)

`ResearcherContext` gains `store: WorkspaceStorePort`. Standalone routes (Node and Cloudflare) use `context.store`; hosted-only saga paths keep `context.kvClient`. On Cloudflare `kvClient` is a fence whose every method throws `RedisAccessFencedError` without I/O.

Port operations keep the existing result unions and HTTP mappings. Composite operations (create with idempotency, completion with admission and initial job, sample seed/clear) are single port methods. Analysis job methods (`acceptAnalysisRetry`, `readAnalysisStatus`) exist only on the durable capability; `claimAnalysisJob`, `markAnalysisStarted` and `finishAnalysisJob` are DO RPCs used only by the Queue consumer. The Redis store does not implement jobs.

### Durable Object schema (logical)

`workspace_meta` (singleton), `schema_migrations`, `studies`, `interviews`, `analysis`, `analysis_jobs`, `aggregates`, `participant_links`, `consents`, `idempotency_receipts`, `budget_windows`, `budget_members`, `tombstones`, `operator_audit`. All timestamps are integer epoch ms; JSON columns store the exact text written; SQL uses bound parameters only.

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

Operator actions (maintenance transitions, operational backup export/import, recovery-epoch activation) are served by `/api/operator/*` on the Cloudflare target only. Authority: a standalone researcher session issued within the last 15 minutes plus `X-OpenInterviewer-Operator: 1`; no new secret is introduced. Every transition is a compare-and-set on `{state, version}`, audit-logged without content. `scripts/cloudflare/operator.mjs` reads the admin password from stdin, signs in and drives these endpoints. There is no unauthenticated maintenance route.

## 7. Decisions from the independent gap review

An adversarial review of the specification against code and platform facts (23 September 2026) found no blocker and twelve major gaps. Decisions:

| Gap | Decision |
| --- | --- |
| Fresh-object bootstrap (F2) | An empty object initializes only when `WORKSPACE_BOOTSTRAP` is `open` or `recovery`. Otherwise every call is held with `workspace-uninitialized`, so identity, jurisdiction or Worker-name drift can never create an empty writable workspace. The installer sets it for the first deployment (or an import target) and clears it afterwards. |
| Epoch rollback (F4) | `ANALYSIS_RECOVERY_EPOCH` is a secret binding; wrangler refuses rollback across modified secrets without confirmation. |
| Operator credential (F5) | Operator routes require a constant-time match of a separate installer-generated `OPERATOR_TOKEN` secret **and** a researcher session issued within 15 minutes. Cloudflare adds a DO-backed login attempt budget and a bounded login body. |
| Deploy provisioning (F3) | `deploy:cloudflare` uploads the prebuilt `--dry-run` bundle with `no_bundle` + `find_additional_modules` (the same derivation `createTestHarness` uses), passes `--config` (bypassing OpenNext delegation), `--experimental-provision=false --experimental-auto-create=false --strict`. Locally proven by wrangler dry run; real upload is a remote gate. |
| Dispatch budget vs backlog (F6) | The watchdog charges the dispatch budget only if no consumer contact has been recorded since the job's last send; healthy backlog defers without charging. The 24-hour pre-start cap remains. |
| Export livelock (F1) | Export captures the ordered interview key set and each row's analysis state at start. Pages overlay the captured analysis state (analysis only moves forward; transcripts are immutable; syntheses are write-once), and invalidate only on deletion of a captured row or replacement of a captured aggregate. Streaming ZIP; an invalidated stream errors, never closes cleanly. |
| Batch eligibility (F8) | Cloudflare batches select generation-0 `not-scheduled`, persisted `failed` and recovery-required items (with the disclosure); active generations are shown as a separate queued/running count. The durable projection omits claim fields. |
| Not-ready gate (F10) | Mutating and provider routes on the Cloudflare target call one readiness gate (configuration, including runtime placeholder-secret detection) before storage or provider use; the DO gate repeats identity/epoch/maintenance checks. |
| Backup watermark (F11) | `frozen` and `recovery` suspend all alarm work (dispatch, watchdog and cleanup) except re-arming, so `(maintenance_version, mutation_seq)` is a complete watermark while held. |
| Queue graph (F12) | `providerErrorResponse` moves to a route-only module so the Queue bundle never imports `next/*`; an import-boundary test covers `cloudflare/worker.ts`. |
| Poison job rows (F13) | Corrupt due job rows are quarantined out of the due scan (the row itself is never patched) with count-only telemetry. |
| Lease clock (F14) | Claim, start and finish decisions use the object's own clock; caller time is advisory. |
| Maintenance for paid no-write calls (F26) | Researcher preview and follow-up generation are allowed in `draining`, refused in `frozen`/`recovery`; link exchange is refused in `draining`. |
| Import mapping (F7) | Any importer maps Node analysis states: none/`pending` with 0 attempts → generation 0 not-scheduled; synthesis/`complete` → generation 0 complete; `failed` → generation-0 synthetic terminal failed job (never enqueued); `running` or `pending` with attempts → generation-0 synthetic recovery-required. Attempts copy verbatim. |

## 8. Deviations register

Maintained in [`evidence/DEVIATIONS.md`](evidence/DEVIATIONS.md). Each entry states the requirement, the evidence and the chosen alternative.
