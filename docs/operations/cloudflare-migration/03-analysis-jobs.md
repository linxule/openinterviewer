# Durable analysis jobs and researcher API

Status: implementation specification, not implemented. Applies to `DEPLOYMENT_TARGET=cloudflare`, standalone mode and direct AI transport. The default `node` target retains the existing synchronous researcher analysis and Redis implementation. Read [02-storage.md](02-storage.md) for authority, schema and transaction contracts; [the analysis UI slice](../../design/slice-cloudflare-analysis-spec.md) owns presentation and copy.

## Ownership and persisted state

**JOB-01 — One storage authority.** The single deployed OpenNext Worker exports `WorkspaceStore`, delegates HTTP to OpenNext, and handles `queue()` independently. Its `WORKSPACE_STORE` binding resolves the configured workspace; `ANALYSIS_QUEUE` transports work identifiers. Provider HTTP runs in the Queue handler, outside the DO, SQL transactions and `blockConcurrencyWhile`. Participant save atomically persists the transcript and initial job; its success response remains unchanged. Cloudflare must not also invoke the existing `after()` analysis path.

**JOB-02 — Identity and frozen inputs.** Each interview has a monotonically increasing safe-integer `generation`, initially 1 for a newly saved transcript; legacy records without a job use generation 0. Each generation receives a random `jobId`, never reused. Persist:

- `interviewId`, `studyId`, `generation`, `jobId`, `recoveryEpoch`, creation/update timestamps;
- immutable server-owned study configuration, study revision, resolved requested provider and explicit model, plus an input-schema version;
- state, random claim token, lease deadline, provider-started timestamp, next due time, dispatch/pre-start recovery counters and coarse terminal failure;
- terminal result/attachment receipt, allowing response-loss reconciliation.

The initial generation captures save-time configuration; an eligible researcher retry captures acceptance-time configuration. Resolve environment/default model selection before persistence, then require that explicit model during execution. Never substitute later study configuration or deployment defaults. The transcript, behavior and profile come from the immutable interview identified by the job. Keys are read from current Worker secrets only at execution and never copied to job rows, messages or logs. Missing credentials end the generation with a recorded coarse provider failure without a provider request. Study edits do not invalidate already accepted analysis; deletion does.

**JOB-03 — State machine.** Internal states and public projections are:

| Internal state | Meaning | Existing interview `analysis.status` |
| --- | --- | --- |
| `pending` | Durable work awaiting delivery/claim | `pending` |
| `claimed` | Exclusive pre-call lease | `running` |
| `started` | Provider-start marker committed | `running` |
| `complete` | Valid synthesis and provenance attached atomically | `complete` |
| `failed` | Persisted known failure; explicit retry eligible | `failed` |
| `recovery-required` | Paid outcome uncertain; explicit retry eligible | `failed` |
| `cancelled` | Parent deleted/cancelled; never executable | No surviving interview projection required |

Only `pending → claimed → started → complete/failed` is the normal execution path. Expired `claimed` may return to `pending` with a new claim token; expired `started` becomes `recovery-required`, never automatically `pending`. After start, timeout, unavailable transport and unclassified exceptions also become recovery-required immediately when storage acknowledges the transition. Config/rate-limit rejection, invalid output and oversized synthesis may record known failure. Terminal states cannot be reopened: an explicit retry allocates another generation. Completed interviews return already-complete. Preserve the existing failure-kind enum; uncertain execution projects `failureKind: 'timeout'`, `recoveryRequired: true`. Add optional `generation` and `recoveryRequired` fields to `InterviewAnalysisState`; do not enlarge its status enum or expose claim/epoch fields in the new status API.

**JOB-04 — Allocation and fencing.** At most one pending/claimed/started generation exists per interview, enforced in the allocation transaction. `acceptAnalysisRetry` checks authority, parent existence, idempotency receipt, completed result, active generation, then expected generation and eligibility. Different request keys racing active work return that same work; they cannot create a competing paid attempt. A terminal generation only permits allocation when `expectedGeneration` equals the stored current generation. An unsynthesized legacy interview with no job also permits explicit generation-1 allocation with `expectedGeneration: 0`. Never use this branch to erase restored/imported execution uncertainty. Store the accepted key-to-generation receipt atomically. Replay uses the receipt, never allocates again, and returns the referenced generation's current outcome.

Scope the key digest by workspace, study and interview, and bind its receipt to the API version/expected-generation fingerprint. Reusing that scoped key with different intent returns `409 ANALYSIS_REQUEST_KEY_CONFLICT`; do not replay another request's result or allocate work. A read-only status failure never changes the receipt.

Use `WorkspaceStorePort` domain methods `acceptAnalysisRetry`, `readAnalysisStatus`, `claimAnalysisJob`, `markAnalysisStarted`, and `finishAnalysisJob`; initial save shares the allocation helper. Every mutating job RPC validates workspace, parent, current generation, job ID, recovery epoch and, once claimed, claim token. Attachment additionally checks the unexpired lease, schema, synthesis size and provenance. It writes synthesis, actual execution provenance, the frozen study revision and terminal receipt together, advances the research mutation sequence, and leaves immutable interview content untouched. Structural corruption is a no-write outcome with existing `corrupt-record` telemetry.

## Transactions, delivery and uncertain outcomes

**JOB-05 — Durable wake-up.** No committed nonterminal job may lack a durable future wake-up. Prototype `ctx.storage.transaction(async () => { /* SQL mutation */ await ctx.storage.setAlarm(nextDue); })` for operations coupling jobs and alarms. SQLite transactions encompass `ctx.storage` operations; `transactionSync` cannot contain awaited alarm calls. Require real-runtime rollback, response-loss and restart tests before adopting this pattern. Queue sends are outside the transaction. The prototype fails if a save can commit without its alarm; do not replace the requirement with scheduling after acknowledgement. [SQLite transaction API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transaction)

**JOB-06 — One scheduler.** The DO's one alarm serves dispatch, lease watchdog and bounded expiry cleanup. Before external Queue I/O, commit the next recovery due time and alarm. Send the identifier-only envelope below; then conditionally record dispatch acknowledgement. Failed/lost sends can duplicate delivery. A successfully sent but unclaimed job remains watchdog-visible. Recompute the minimum due time transactionally after every relevant mutation; do not overwrite an earlier deadline. Process at most 25 due rows per alarm invocation and rearm immediately when more remain.

```ts
type AnalysisMessageV1 = {
  v: 1;
  workspaceId: string;
  interviewId: string;
  jobId: string;
  generation: number;
  recoveryEpoch: string;
};
```

Validate the closed message shape and configured workspace before RPC. No transcript, study configuration, participant code, credential or provider output belongs in Queue/dead-letter payloads. Invalid, deleted, cancelled, superseded and terminal deliveries are acknowledged without creating records. Unknown schema versions enter the isolated dead-letter/recovery path for operator diagnosis; they must not invoke providers.

**JOB-07 — Bounded transport recovery.** Initial configuration: consumer batch size 1, concurrency 1, maximum 3 transport retries with 30-second delay and a dedicated dead-letter queue. Explicitly acknowledge each handled message; do not let one caught provider failure retry a batch. Outbox recovery is authoritative after Queue retention/dead-lettering. Before provider start, allow at most 16 dispatch/recovery attempts or 24 hours since allocation, whichever comes first. Increment the durable budget once per send reservation or expired-unstarted-claim recovery; busy/duplicate deliveries consume none. Retry unacknowledged dispatch with exponential backoff from 5 seconds capped at 30 minutes; acknowledged-but-unclaimed delivery gets its first watchdog check after 5 minutes. Exhaustion records `failed/storage` and stops automatic work. These are configurable tested constants, not participant request authority lifetimes. [Queue handlers and acknowledgements](https://developers.cloudflare.com/queues/configuration/javascript-apis/)

An alarm failure must attempt to persist a future alarm before returning; platform retries alone are finite. Surface sustained scheduler failure through count-only telemetry and operator readiness/health diagnostics. Storage/platform outages can delay liveness; never claim guaranteed progress through an unavailable platform. [Alarm retry behavior](https://developers.cloudflare.com/durable-objects/api/alarms/)

**JOB-08 — Start permission and response loss.** Allocate a fresh claim nonce per consumer invocation. Claim lease is 180 seconds; synthesis deadline is 120 seconds, including SDK work. Immediately before provider HTTP, `markAnalysisStarted` must durably confirm that invocation's claim and enough remaining lease for the deadline plus attachment margin. Increment analysis attempts when a claim is first accepted, with `lastAttemptAt`; a transport replay of that claim does not increment again. Attempts count claims, not guaranteed provider bills.

| Uncertain boundary | Required behavior |
| --- | --- |
| Save/retry allocation response lost | Replay stable submission/request identity and recover committed generation |
| Claim response lost | Same live invocation queries/replays its nonce; another invocation cannot assume ownership |
| Start-marker response lost | Same invocation, which has not called the provider, may confirm its marker; otherwise do not call |
| Process dies after start marker | No new invocation adopts permission to call; watchdog records recovery-required |
| Provider returns but attachment response lost | Read terminal receipt; retry the same validated result/claim within the lease if still eligible; never call provider again |
| Lease/generation/epoch changed | Drop stale result/failure; no second write or provider call |

If storage cannot confirm an outcome after start, delivery may be acknowledged only once a durable watchdog still covers it; otherwise retry transport without reissuing provider HTTP. Do not convert an uncertain attach into a falsely confirmed failure. At lease expiry, late results are rejected and the researcher sees recovery-required. Abort is best effort: provider completion/billing may still occur remotely.

**JOB-09 — SDK policy.** Introduce an explicit `queued-synthesis` execution policy on provider construction/calls; its automatic HTTP retries are zero. Preserve existing policies for participant interviews, greetings and synchronous legacy paths. For the locked SDKs, verify the exact per-call controls: Anthropic/OpenAI `maxRetries: 0`, Gemini Interactions `maxRetries: 0`, OpenRouter `retries: { strategy: 'none' }`. Treat those names as version-checked implementation anchors, not a reason to upgrade SDKs. Test transport errors, 429, 5xx and timeouts with request-counting fixtures proving one outbound synthesis request. No model/provider fallback, hidden structured-output repair call or automatic restart is allowed. Output validation and actual served-model provenance remain mandatory. This prevents application retries; it does not promise exactly-once billing inside a provider.

**JOB-10 — Retention and restore.** Keep the current terminal generation metadata and synthesis for the interview lifetime. Retain retry receipts for 7 days; expired keys still cannot allocate over a different `expectedGeneration`. Older terminal job detail may be pruned after 30 days; no nonterminal job expires by cleanup. Parent deletion atomically cancels/removes jobs, retaining only minimal deleted-disposition receipts through their replay horizon. Old deliveries never recreate them.

`ANALYSIS_RECOVERY_EPOCH` is a generated deployment value outside the restorable DO database. Persist the activated epoch in the DO and every job. Normal RPC/alarm entry checks the current Worker environment, activated DO epoch and message/claim epoch together; mismatch rejects work and never adopts an epoch from a request. Restore holds dispatch and consumers, drains/fences old executions, deploys and verifies the new external epoch before restoring storage, then invokes a restricted operator-only activation procedure. Restored alarms and an old stored open state remain inert under that mismatch. Activation reconciles every restored nonterminal generation to recovery-required before enabling execution: restored start markers may have been rewound. Reject all old envelopes/claims/results. New explicit retries receive the new epoch. Ordinary code rollback must preserve the current epoch; rolling back configuration to an old epoch is forbidden. Test this under the restoration procedure in the operations specification.

## HTTP and client contract

**API-01 — Additive version handshake.** Keep `POST /api/interviews/{id}/analyze?studyId={id}`. On Cloudflare require:

```http
X-OpenInterviewer-Analysis-Version: 2
Idempotency-Key: <client-generated UUID>
Content-Type: application/json

{"expectedGeneration":1}
```

The key represents one intentional action, not each network attempt. Strictly validate a nonnegative safe-integer generation and UUID, with a small bounded body. Missing/unsupported version returns `409 {"code":"ANALYSIS_CLIENT_UPDATE_REQUIRED","error":"Reload this page to analyze interviews."}` before job mutation. This prevents cached older clients starting work and then misreading a new response. Node continues its existing synchronous path and may ignore these additive fields; the new client still parses its legacy outcomes.

Authorize a researcher and matching study/interview on every POST and GET; participant cookies/links confer no access. Preserve authenticated cookie protections and existing request admission; do not add permissive cross-origin access. Never accept configuration, model, workspace selection or provider keys from the body. Unknown allocation commit returns 503 with `retryable: true`; retry uses the same key/body. Mismatched terminal `expectedGeneration` returns 409 `ANALYSIS_STATE_CHANGED` without allocation; refresh before another intentional action. The new client selects this protocol only when the safe public configuration advertises `analysisExecution: 'queued-v2'` (RT-08), and obtains the expected generation from confirmed server state.

**API-02 — Closed response projection.** Add read-only `GET` on the same URL, returning current state without synthesis, job IDs, claim tokens or epoch. All responses use `Cache-Control: no-store`; reads never allocate, dispatch or retry. Authoritative missing parent is 404, denied access 401/403, admission failure 429, storage/corruption 503. Retain existing `STUDY_OPERATION_PENDING` handling for Node hosted mode.

| Outcome | HTTP/body |
| --- | --- |
| Accepted or existing active work | POST 202 / GET 200: `{status:'pending', generation, phase:'queued'|'running', pollAfterMs:2000}` |
| Eligible legacy interview with no job | GET 200 only: `{status:'pending', generation:0, phase:'not-scheduled'}` |
| Attached result | 200: `{status:'complete', generation}` |
| POST against completed interview | 200: `{status:'already-complete', generation}` |
| Persisted terminal failure | 200: `{status:'failed', generation, failureKind, recoveryRequired:boolean}` |

Generation 0 is valid for a legacy interview without jobs; `not-scheduled` enables an explicit Analyze action, without polling. Imported/restored execution uncertainty must instead project recovery-required. `analysisApi.ts` remains the single parsing boundary, adding pending outcomes and `getInterviewAnalysisStatus`; do not duplicate parsers in screens. Preserve distinction between recorded failure and request failure. No error message/cause/provider response passes through this projection.

**API-03 — Polling and action identity.** After 202, poll serially after 2 seconds, every 2 seconds through 30 seconds, then every 5 seconds through a 180-second wall-clock budget. Validate/clamp any suggested interval to 2–10 seconds. Pause while hidden/offline; on return perform one GET and continue only within the remaining budget. Cancel polling on unmount. After budget exhaustion retain “awaiting” state and allow a read-only refresh; do not POST automatically. Adopt a newer returned generation, reject responses older than the displayed generation, and never regress terminal state to pending within a generation.

Keep the action key/body in component/service state across uncertain request retries; allocate a fresh key only for another intentional retry after a refreshed eligible terminal state. Reload can recover through GET without a key. Disable duplicate presses while the action is being submitted/observed, but rely on server exclusion for competing tabs.

**API-04 — Batch semantics.** Retain the 25-interview batch cap and sequential execution. Pending waits for a persisted terminal outcome before the next interview. Complete/already-complete increments finished progress; persisted failed also increments finished and failure counts, then continues. Request/auth/rate/storage error stops immediately and preserves loaded records. Poll budget exhaustion stops before scheduling remaining interviews and displays the still-pending item separately; accepted is never counted as analyzed. Node's legacy `busy` stops the batch as awaiting; do not send Cloudflare-only polling to an older Node server. A later user-triggered batch may resume from refreshed states.

## Required fault evidence

Map tests to the requirement IDs above; use actual local DO transactions/Queue handlers and synthetic provider HTTP. Keep existing Redis behavioral gates.

| Test | Injection/assertion |
| --- | --- |
| JOB-01/05 | Kill before commit, between SQL/alarm, after commit/before reply; one transcript/job and durable wake-up or no commit |
| JOB-02 | Edit config/default model before claim and attach; frozen inputs/revision, actual provenance |
| JOB-04 | Initial job plus two retry keys race; one active generation and at most one provider request |
| JOB-06/07 | Lost send ACK, duplicate/out-of-order delivery, dead-letter/retention loss, retry exhaustion; bounded recovery |
| JOB-08 | Lost claim/start/attach replies and crashes at each cut; fence stale successes and failures |
| JOB-09 | Each adapter's timeout/429/5xx fixture produces one HTTP request under queued policy |
| JOB-10 | Delete while queued/running; late messages/results do not resurrect records; restore rejects old epoch |
| API-01/02 | Old cached client, foreign study, participant session, malformed response, unknown commit, expired key; legacy no-job GET → explicit generation-1 allocation → completion |
| API-03/04 | Hidden/offline/unmount, terminal response races, two tabs, pending batch timeout, failure continue/request stop |

These tests establish application behavior. Live-provider compatibility and staging PITR require their separately authorized execution gates; neither is established by this specification.
