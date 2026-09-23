# 02 — Workspace storage

Status: implementation specification, 23 September 2026. Baseline: `4d3076528681862cda21d0b2c80d1ae2ce9faeda`. This document specifies work for Claude; it does not claim that the implementation exists. Read the package index and [analysis jobs](03-analysis-jobs.md) together with this contract.

## Boundary and ownership

Implement a domain-level `WorkspaceStorePort`, with a Redis implementation wrapping existing operations and a Cloudflare implementation invoking the exported `WorkspaceStore` Durable Object through `WORKSPACE_STORE`. Suggested module boundary: `src/lib/storage/{types,resolve,redis,cloudflare}.ts`, with Worker-only object/schema code outside the portable interface. Final filenames may differ; keep the dependency direction explicit.

`DEPLOYMENT_TARGET=node|cloudflare` defaults to `node`. Central resolution permits the existing Node standalone/direct or Gateway and hosted/BYOS/direct combinations; Cloudflare permits standalone/DO/direct. Storage follows that resolution. Missing bindings or unsupported combinations fail setup and requests; they never instantiate a Redis fallback. Do not branch independently in every route.

Use one stable server-owned workspace identity per installation and separate namespaces for local, staging and production. HTTP inputs never select an object, namespace or SQL table. Apply the installation's jurisdiction consistently in HTTP, Queue, alarm and operator paths. Recommend EU in the installation plan; select the actual jurisdiction before first object creation, record it in the receipt and preserve it on update. Changing jurisdiction can select a different object, so it is a migration, not a routing preference. This restricts the object's execution/storage, not all edge or provider processing. [Cloudflare data location](https://developers.cloudflare.com/durable-objects/reference/data-location/)

Route handlers retain authentication, request parsing and HTTP translation. The store repeats mutable authority checks at the write boundary using verified session identity, expected study revision, link identity and consent binding. A previously loaded study is not proof that it remains writable. No public SQL endpoint, arbitrary key API, provider call or credential storage belongs inside the object.

Retain `RedisPort`, Lua, wire parsers and repair guards inside the Redis implementation. Hosted account ownership, encrypted connections and cross-database operation reconciliation remain in `platformDb*` and `studyOperationReconciler.ts`; do not port or replace their saga. Expose the resolved domain store from request context while keeping Redis access confined to legacy control-plane/backend code.

## Domain operations and results

Define discriminated results per operation, not one union where every status is legal everywhere. Preserve current HTTP mappings. `not-found` means a confirmed miss; `unavailable` means storage could not establish a result; `ambiguous` means a mutation may have committed. Corrupt analysis remains an unchanged-record refusal, logged through the existing allowlist as `corrupt-record` and publicly mapped to retryable unavailability.

| Operation group | Required behavior |
| --- | --- |
| `getStudy`, `listStudies`, `getInterview`, `listInterviews`, `getAggregate` | Checked reads; bound collection sizes; retain explicit `too-large` and unavailable outcomes. |
| `createStudy`, `replaceStudyConfig`, `setStudyLinksEnabled`, `deleteStudy` | Operation receipt/fingerprint; expected-revision mutation; created/replayed/conflict/stale/deleted outcomes. Edits increment revision and invalidate previous participant authority. |
| `createParticipantLink`, `resolveParticipantLink`, `listParticipantLinks`, `revokeParticipantLink` | Current study/revision gate, expiry and revocation, existing quota, one-time return of opaque code. Persist its digest, never the raw code. |
| `recordConsent`, `verifyConsent`, `admitParticipantRequest` | Session/revision/hash binding; unchanged acceptance timestamp on replay; atomic check-all then consume-all budgets. |
| `persistCompletedInterview` | Immutable submission plus exactly one initial job, completion count, lock state and save admission in one transaction. |
| Analysis methods | `acceptAnalysisRetry`, `readAnalysisStatus`, `claimAnalysisJob`, `markAnalysisStarted`, `finishAnalysisJob`, as specified in document 03. |
| `saveAggregate`, `deleteInterview`, `seedSampleWorkspace`, `clearSampleWorkspace` | Existing aggregate replacement semantics; deletion fences; fixture-specific operations without a general overwrite escape hatch. |

Only complete domain operations cross the adapter boundary. A caller cannot reproduce completion by chaining insert, counter and enqueue methods. Separate Node's synchronous analysis executor from Cloudflare's durable job capability centrally; a Redis adapter must not grow a fictional Queue implementation.

Keep deterministic fingerprints and IDs stable across uncertain responses. A failed RPC after submission is not evidence of rollback. Replaying the same operation key/fingerprint returns its original result, without incrementing counters or creating another job; a different fingerprint conflicts. Capture randomness and time outside any retried transaction callback. Do not wrap arbitrary mutations in automatic retries with newly generated IDs.

## Schema and logical constraints

Use numbered SQL migrations and bound parameters. The following is the required logical schema; physical columns may be refined while preserving these constraints:

| Table | Required keys and constraints |
| --- | --- |
| `workspace_meta`, `schema_migrations` | Installation identity, schema/read compatibility, research mutation sequence, maintenance state (`open`, `draining`, `frozen`, `recovery`); unique immutable migration version/checksum. External recovery epoch remains deployment configuration, not authority stored here. |
| `studies` | Primary ID; validated config JSON; integer revision at least 1; server timestamps; link state; lock/count fields; deletion marker. Config identity agrees with row identity. |
| `interviews` | Primary ID; study ID; immutable submission JSON and fingerprint; completion timestamps, captured study revision, consent evidence and conducting-provider fields. Index `(study_id, created_at, id)`. |
| `analysis` | One row per interview; mutable projection/current generation; monotonic bounded attempts, claim/lease fields, validated synthesis and actual provenance. Its absence on supported legacy input is distinct from malformed state. |
| `analysis_jobs` | Unique job ID and `(interview_id, generation)`; immutable generation inputs and requested provider/model; state, dispatch/deadline/claim fields. At most one active generation per interview, enforced transactionally and with a suitable uniqueness constraint. |
| `aggregates` | One current value per study; complete validated aggregate JSON, source interview IDs/revision and provenance; existing 256,000-byte serialized ceiling. |
| `participant_links`, `consents` | Digest keys, indexed study/revision, revocation and absolute expiry; consent accepted time/hash/session binding. |
| `idempotency_receipts` | Unique `(operation_family, scoped_key_digest)`; fingerprint, target ID, result/deleted disposition, original timestamps and absolute expiry. |
| `budget_windows`, `budget_members` | Salted scope identities, window definition, count/expiry; unique submission membership prevents duplicate save charging. |

Validate cross-row identities and JSON shapes in addition to SQL constraints. Preserve empty arrays/objects, Unicode, optional legacy fields and absence of provenance; never backfill historical provider metadata from current configuration. Internal identifiers, generations, counters and timestamps must stay within JavaScript safe-integer bounds. A malformed counter is corrupt; a valid exhausted counter refuses further attempts without relabeling corruption.

Keep transcript data separate from mutable synthesis. Reconstruct the existing `StoredInterview` public shape at reads so current UI/export consumers do not see SQL internals. New rows must satisfy both existing request/synthesis limits and measured assembled-row limits. Cloudflare currently limits SQLite rows/strings/BLOBs to 2 MB and a paid object to 10 GB; measure maximum valid fixtures and imports instead of assuming the request limit alone proves fit. [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)

Aggregate persistence remains latest-value replacement, without new history or revision-CAS semantics. Preserve its recorded source IDs/revision and refuse a deleted target rather than creating an orphan after a concurrent deletion.

## Transactions and durable wake-up

SQL-only operations use `ctx.storage.transactionSync()` with synchronous reads/validation/writes. Do not issue SQL `BEGIN` or `SAVEPOINT`. Fully consume each bounded SQL cursor before an `await`; carrying a cursor across awaits does not preserve snapshot isolation. [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

Completion performs, within one transaction:

1. Resolve exact replay/conflict identity and current authority under the existing participant disclosure rules. A replay never refreshes consent or authorizes new writes after revocation.
2. Validate study/link/revision/consent and every save budget. Freeze the canonical study configuration, revision, resolved requested provider/model and immutable input references for the initial generation.
3. Insert the immutable transcript, fingerprint, analysis projection and initial job; charge unique admission membership; update the study's count/lock and research mutation sequence.
4. Register the earliest required recovery alarm before committing. Return `created` only when the storage operation is acknowledged. Duplicate replay verifies the existing job invariant without creating a second generation.

Prototype the supported asynchronous form `ctx.storage.transaction(async () => { /* synchronous SQL */; await ctx.storage.setAlarm(earliestDue); })`. Cloudflare documents that SQLite transactions include operations directly on `ctx.storage`, including SQL. This is the implementation hypothesis to prove with failure injection, not permission to put `setAlarm()` inside `transactionSync()`. The callback performs storage operations only. Test rollback after SQL, failure at alarm registration, object restart after commit before RPC response, and earlier/later competing alarm deadlines. If the pinned runtime cannot establish joint durability, stop this slice and report the evidence; do not ship a post-commit wake-up gap. [Transaction API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transaction)

One scheduler owns the object's single alarm, combining dispatch, unfinished-job reconciliation and bounded cleanup. It must retain the earliest necessary wake-up and arrange the next recovery before external Queue I/O. At-least-once alarm delivery and the platform's finite automatic retries are not a substitute for the durable scheduling protocol in document 03. [Alarm behavior](https://developers.cloudflare.com/durable-objects/api/alarms/)

## Expiry, deletion and sample data

Check absolute expiry during access even when cleanup is delayed. Preserve the existing four-hour consent lifetime and seven-day create/operation receipts. Link expiration remains the original absolute timestamp or no expiration. Preserve current limiter algorithms separately: greeting/interview windows begin at first consumption; save admission uses fixed window membership. Do not replace either with a superficially similar counter. Replays/imports do not renew lifetimes. Cleanup processes bounded indexed batches and reschedules remaining work.

Preserve the existing researcher rule that ordinary study deletion refuses a study containing interviews. This migration does not introduce a populated-study deletion endpoint. For an already authorized deletion path, such as exact sample-fixture cleanup or an existing internal interview deletion operation, first atomically make the target inaccessible and fence its jobs. Use a durable tombstone and bounded child cleanup if needed rather than loading all content in one invocation. Every consumer/attach/read checks the tombstone; delayed messages acknowledge without recreating records. Delete only the authorized target's transcript, analysis, aggregate, links, consent and sample metadata within its defined cascade. Retain minimal operation receipts through their replay horizon; never recycle IDs. Cleanup restart must not expose partly deleted data or prevent another study's legitimate work.

The authenticated sample-workspace API is a real storage surface. Replace its direct Redis-key manipulation with backend operations. Seed only the known synthetic fixture set, refuse collisions, preserve the configured provider selection, and never call a model merely to seed. Cloudflare can seed this bounded set atomically. Clearing sample data cancels associated jobs and removes derived aggregates/links through the same deletion rules; it cannot delete arbitrary `demo-*` records selected by caller input. Keep the public `/demo` entirely in component memory.

## Collections, aggregate analysis and export

Preserve route limits and explicit overflow responses, including export's 500-interview ceiling and aggregate/follow-up's 1,000-record reads. Do not truncate to make a Worker fit. Implement deterministic keyset pagination with bounded row/byte batches, selecting only fields each caller needs. Aggregate/follow-up must assemble their existing logical inputs within tested memory/token constraints or return an explicit established limit error; moving a huge `Promise.all` behind the interface is insufficient.

For Cloudflare researcher exports, use a research mutation sequence captured at start, checked with each page and once before archive completion. Increment it on every exported-content mutation, including analysis attachment/deletion/aggregate writes. Any change invalidates the export: report retry before response headers when possible, otherwise fail the stream and omit successful archive finalization. The client must not offer a failed partial download as complete. This provides an optimistic coherent snapshot without retaining a database cursor across network awaits or blocking collection. Stream compression/output with bounded memory while preserving the existing ZIP/CSV/JSON content and formula protection.

Portable operational backup is separate: under the persisted maintenance/write fence, export every authoritative table with a versioned manifest, counts, SHA-256 checksums and completion trailer, excluding secrets. Each bounded page checks the same maintenance epoch/revision watermark. Import into a fresh isolated object, validate references and exact lifetimes, and keep dispatch suspended for reconciliation. Its release/restore procedure is defined in the verification/cutover specification. Upstash import is conditional on the later authorized inventory; do not build it or inspect production merely to satisfy this storage slice.

## Migrations and acceptance

Run small schema migrations before serving object methods, with constructor initialization gated by `blockConcurrencyWhile` only for bounded storage work. Unknown newer schemas refuse readiness and mutation. Use additive columns/tables and resumable backfills for upgrades; define supported reader/writer versions. Never mark a migration complete before its data/constraints are valid. N−1 rollback must remain compatible with N's pending jobs and schema throughout the rollback window. DO class/namespace migrations are separate from SQL migrations.

| ID | Required acceptance evidence |
| --- | --- |
| ST-01 | Both adapters pass shared domain scenarios; existing Redis/Lua wire and crash-cut suites remain independent and pass. No hosted saga semantics change. |
| ST-02 | Concurrent same/different-fingerprint completions yield one immutable transcript, one charge, one initial job and correct count; lost response replays without duplication. |
| ST-03 | Edit/revoke/expire/delete races refuse unauthorized writes; consent timestamp and expiry do not renew on replay. |
| ST-04 | Real local Worker transaction/alarm failure cuts prove no committed nonterminal job lacks recovery, including object restart and duplicate save. |
| ST-05 | Malformed analysis/identity yields unchanged records and sanitized corrupt diagnosis; supported legacy absence and valid exhausted counters retain distinct behavior. |
| ST-06 | Budget denial mutates no scope; concurrent admissions and fixed-window duplicate saves preserve existing limits. |
| ST-07 | Tombstoned deletion survives restart; delayed completion/Queue delivery cannot resurrect data; sample clear cannot affect real studies. |
| ST-08 | Maximum valid payloads, collection overflow, Unicode/empty-shape/provenance round trips and paginated exports pass in workerd with measured bounded memory. Concurrent export mutation produces failure, not a valid partial archive. |
| ST-09 | Fresh schema, interrupted migration, unsupported future schema and compatible N−1 → N → N−1 are exercised with pending jobs. |
| ST-10 | Portable backup/import reproduces synthetic counts/checksums/references and original expiries without resuming uncertain paid work; fresh namespace cannot access another installation. |

Baseline implementation anchors: `src/lib/{kv,redisPort,kvClient,researcherContext,canonicalStudy,participantLinks,participantConsent,createIdempotency,rateLimit}.ts`, `src/lib/platformDb*.ts`, `src/types.ts`, `src/app/api/interviews/{save,export}/route.ts`, and `src/app/api/demo/seed/route.ts`. Read paired tests before extraction, especially `tests/unit/{kv.atomicPersistence,kv.analysisAttach,kv.createDeleteReceipts,kv.checkedCollections,kv.aggregatePersistence,participantConsent,participantLinks.authority,rateLimit.participant,api.study.createIdempotency,api.export.csvFormulas}.test.ts` and `tests/integration/redis.crashCuts.test.ts`. Share behavioral assertions; keep assertions about Lua commands exclusive to Redis.
