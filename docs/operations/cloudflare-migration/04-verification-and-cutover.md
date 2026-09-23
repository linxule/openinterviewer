# Verification, release and cutover specification

This document owns cross-system acceptance and operator procedures. The [runtime](01-runtime-and-installation.md), [storage](02-storage.md), [jobs](03-analysis-jobs.md) and [UI slice](../../design/slice-cloudflare-analysis-spec.md) own their detailed contracts. Status: specified; none of these new Cloudflare gates has been executed.

## VERIFY-01 — Local test environment and real boundaries

Use Node 24.19+ and a clean `npm ci`. Pin the adapter, Wrangler and compatible Workers test integration in the lockfile; record the runtime compatibility date. Keep existing test commands working. Add explicit package commands for Cloudflare build, domain/runtime tests, production-artifact browser tests and a combined local release check; publish their exact names in the implementation report and CI.

Use `@cloudflare/vitest-plugin` for actual local Worker/SQLite bindings. Its storage isolation is per test file, so tests sharing a file must reset deliberately. Use `createTestHarness()` for the production artifact where compatible, or the pinned adapter's real local production preview with equivalent event/binding coverage. A Node mock of SQLite, a mocked internal save/analyze API, or a Next development server does not satisfy this gate. [Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/) · [Production-build harness](https://developers.cloudflare.com/workers/testing/test-harness/)

Every runner owns a unique temporary persistence directory and knows which processes/files it created. Restart tests reopen that same directory; unrelated tests use a fresh one. Reject inherited provider/cloud credentials, `.dev.vars`/dotenv secrets, remote bindings and unexpected runtime network requests. Inject synthetic provider HTTP at the network boundary and permit only the specific local harness traffic. Never borrow production data for fixtures. Keep failure injection/test endpoints out of deployable application routes.

Failure tests must distinguish a real committed transaction with a lost reply from a transaction rolled back by throwing inside it. Supply a fault manifest naming the cut, durable evidence, expected reply and next action. Termination/restart tests must observe persisted state after the process has restarted, not merely reconstruct an in-memory fake.

## VERIFY-02 — Supported release matrix

| Lane | Mandatory evidence |
| --- | --- |
| Existing quality | `npm run check`, `npm run test:setup`, production dependency audit at the existing CI threshold, `git diff --check` |
| Existing builds/setup | Standalone direct, standalone Gateway, hosted direct; reuse safe fixture environments from `.github/workflows/ci.yml` |
| Existing browser/storage | `npm run test:e2e`, `npm run test:redis-crash`, `npm run test:adversarial` using disposable Redis |
| Cloudflare configuration | Supported target resolves without Redis; unsupported target/mode/transport, missing bindings, schema mismatch, placeholder/reused secrets and invalid origin fail correctly |
| Cloudflare production artifact | Real OpenNext/custom entrypoint build and local execution of fetch/Queue/DO; auth/proxy/assets/crypto and each provider adapter's synthetic HTTP contract |
| Shared storage behavior | Same business scenarios run on Redis wrapper and local DO, with backend-specific fault cases separate |
| Durable jobs/API | Every `JOB`/`API` acceptance case, including request-count assertions at the provider fixture |
| Cloudflare browser/UI | Complete researcher and participant flows through real handlers/storage, plus the design slice's accessibility/mobile cases |
| Operational tooling | Local export/import, rejected incomplete import, schema upgrade/replay, install/update dry-run and interrupted setup fixtures |

Run focused tests during implementation, then one complete matrix on the integrated release candidate. Repeat only affected gates after subsequent changes, and finish with evidence covering the final revision. Do not count unrelated test totals as proof of the new runtime.

## VERIFY-03 — End-to-end acceptance scenarios

| Case | Observable result |
| --- | --- |
| Researcher starts a study | Sign in; create with retry key; refresh/list/edit; revisions advance; old link/session authority becomes invalid |
| Participant completes | Exchange opaque link; consent recorded; greet/interview; transcript save returns before blocked synthesis fixture is released; close tab; researcher eventually sees persisted analysis |
| Parallel tabs/preview | Participant selectors remain isolated; wrong audience/study/tab fails; researcher preview invokes only its allowed provider path and creates no research record/count/job |
| Failed analysis | Provider exception/invalid response leaves immutable transcript; safe failure copy; intentional retry uses one generation and current accepted configuration |
| Ambiguous execution | Crash after start marker; no automatic second provider invocation; researcher sees recovery state and explicit retry-cost explanation |
| Concurrent retries | Detail + batch + automatic job race; one active generation; lost POST acknowledgement reuses the same action key; no paid call from polling |
| Data/configuration race | Confirmed study edit during queue delay and between provider result/attach preserves frozen input/revision/provenance for that generation |
| Storage uncertainty | Before-commit failure vs after-commit response loss; existing records never replaced by a successful empty list; corruption remains unchanged and safely logged |
| Boundaries | Maximum valid transcript/synthesis/aggregate; real memory/CPU behavior for existing 500-record export and 1,000-record reads where used; no silent reduction of limits |
| Export/follow-up | Pending and completed interviews, Unicode and empty structures round-trip; CSV formula protection; aggregate selection/freshness and follow-up provider/provenance preserved |
| Fixture lifecycle | Authenticated sample seed and cleanup affect only intended sample records; delayed Queue delivery after cleanup cannot recreate them; public demo remains fully keyless |
| Restart/expiry | Consent/link/budget/receipt deadlines enforced without cleanup; restart preserves both jobs and wake-up; duplicate cleanup/migration remains safe |

For each case, assertions cover storage state and absence/presence of provider calls, not only status text. Use existing strong tests as anchors: `tests/integration/redis.crashCuts.test.ts`, `tests/unit/api.save.idempotent.test.ts`, `tests/unit/participantConsent.test.ts`, `tests/unit/kv.analysisAttach.test.ts`, `tests/unit/analysisApi.test.ts`, and the researcher component suites.

## VERIFY-04 — Remote staging and installation gates

Prepare remote rehearsals during local implementation; execute them only with the selected account and authorization. Use a separately named staging Worker with its own DO namespace, Queue, signing secrets and synthetic records. Branch Previews currently cannot register as Queue consumers, so a Preview URL alone cannot prove the full background flow. [Preview Queue limitation](https://developers.cloudflare.com/workers/previews/resources/#queue-consumers)

The staging report must cover real canonical-origin cookies/proxy behavior, Queue dispatch/consumer registration, actual alarm wake-up after inactivity, protected logs, schema initialization, operational restore and a clean installation under customized resource names. Repeat install/update without creating duplicate resources or rotating secrets. Interrupt setup after a resource is created; resuming must recover the known installation without adopting unrelated resources. Record costs/configuration only in safe terms.

Run a deliberate failing release check through the selected deployment mechanism: no promotion occurs, no production binding is used, and no privileged deploy credential is exposed to untrusted PR code. For the maintained instance, CI checks and promotion must identify the same commit/artifact. For self-host installations, verify the documented update path rather than assuming cloned branch protection or independent CI statuses gate Workers Builds.

Live provider validation remains separate from synthetic compatibility tests. Before any paid smoke, name the provider/model, planned invocation count, SDK retry policy and output/deadline bounds; use only explicitly requested credentials. Capture metadata/classification only. Test each provider that the deployment will actually use; do not mark uncalled providers live-verified. This migration does not alter actual-model provenance requirements to make a smoke pass.

## OPS-01 — Maintenance and writer authority

Implement persisted workspace maintenance modes: `open`, `draining`, `frozen`, and `recovery`. These are operator states, never values accepted from a participant request.

- `open`: normal behavior.
- `draining`: refuse new participant link exchanges/collection starts and new researcher mutations, including explicit analysis retries. Existing authorized participant sessions may consent, call their current interview provider and save under the usual authority checks; their saves may create initial analysis jobs. Existing and such newly accepted completion jobs may settle. Protect the administrative read/backup path.
- `frozen`: all research mutations, new claims/provider starts, result writes and alarm dispatch are fenced. Operator inspection/export remains available. Complete or explicitly classify in-flight attempts before entering this state; do not infer completion from an elapsed timer.
- `recovery`: same research write hold while restore/import validation and controlled epoch activation occur. No ordinary call can resume work or change the recovery epoch.

All affected handlers and store methods enforce the state, including cleanup/seed, aggregate/follow-up and Queue callbacks. Transitions are authenticated, explicit, compare the expected previous state/version, and are audit-logged without content. A missed response is resolved by reading the recorded transition; it must not undo a newer operator decision. Provide an operator command surface, not a publicly unauthenticated maintenance route.

For the old Vercel/Redis deployment, a new flag alone cannot fence older immutable deployments or already-running callbacks. The cutover runbook must select and rehearse a storage-access barrier or disable every writer, including alternate URLs, and retain an authorized read/export path if needed. Verify a deliberately late old write is refused. DNS changes are not this barrier.

## OPS-02 — Operational backup and import

Researcher ZIP exports remain a product feature. Define a separate versioned operational format covering every authoritative record family: workspace/schema metadata, studies/revisions, immutable interviews and fingerprints, analysis/provenance, aggregates, links/digests, consent, unexpired receipts/budgets, jobs and maintenance/recovery metadata. Never export API keys, session-signing secrets, cookie values or reusable credential envelopes into this format.

For v1, take operational exports from a quiesced `frozen` workspace. Use bounded pages under a fixed maintenance epoch/revision watermark; verify that watermark on every page. Do not treat a SQL cursor resumed after `await` as a stable snapshot. Manifest fields include format version, schema version, source identity, export timestamp, record-family counts, chunk order/checksums and an explicit completion trailer. A missing chunk/trailer, count mismatch, changed watermark or checksum failure rejects the backup. Export values preserve JSON types and absolute expiry timestamps. [SQL cursor consistency](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

An interrupted export leaves a visibly incomplete artifact and reports the workspace's held state. Resuming normal service is an explicit controlled operation. Save the artifact only to the operator's chosen protected destination; no automatic upload or repository artifact containing participant data. A checksum checks corruption, not authorization or encryption; destination protection is an operator requirement.

Import into a fresh isolated empty workspace under `recovery`. Validate format/schema, unique identities, references, sizes, counters, checksums and lifetimes before activation. Import is resumable by manifest/chunk identity; duplicate chunks must not duplicate records. Corruption reports contain counts and safe error classes, not record contents. Do not silently repair, discard or truncate. Preserve expired authority as expired; copying must not renew it. Validate restored behavior with synthetic data in tests, and compare production metadata only within the approved live procedure.

The portable DO export/import is required even for an empty-start deployment. An Upstash-specific importer is conditional on the real data decision. Its mapping must additionally resolve Redis-specific guards/indexes/unfinished operations rather than copying them as Cloudflare jobs.

## OPS-03 — Restore and application rollback

PITR is a separate remote rehearsal; current SQLite DO recovery is not available in the local runtime. First suspend dispatch/consumption and fence writers, including old executions and alternate versions. Record external epoch, backup/bookmark and rollback target. Deploy and verify a new `ANALYSIS_RECOVERY_EPOCH` outside the database **before** restoring storage: a restored database can resurrect an old open state and alarm. The Worker-environment/activated-epoch mismatch must block those callbacks. Restore, then explicitly activate/reconcile through the controlled protocol in the jobs specification while still held. Ordinary RPCs cannot re-adopt an older epoch. Reconcile all restored nonterminal jobs conservatively because external calls and Queue deliveries were not rewound. Replay old messages and late results in the rehearsal; neither may trigger a paid call or attach a stale result. Only then resume work. [DO recovery API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api)

Classify each release as code-only, compatible SQLite schema/job-protocol change, or DO resource lifecycle change. A rollback target must retain the current secrets, recovery epoch and operational controls, and read the stored schema/job versions. Rehearse N−1 → N → N−1 with pending and completed jobs. Native rollback can be unavailable after class lifecycle changes or removal of bound resources, so record whether the tested procedure is native rollback, a compatible redeploy, or forward-fix. Keep required resources throughout the rollback window. [Worker rollback restrictions](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/#bindings)

Do not run mixed application versions against incompatible state. No gradual percentage deployment for the first migration; later use needs its own evidence. Neither code rollback nor DNS rollback is a database restore.

## OPS-04 — Production transition runbook

| Step | Required evidence before continuing |
| --- | --- |
| Select target | Account, stable origin, resource ownership/names, placement, usage headroom and protected backup destination recorded; old links/hostname treatment decided |
| Inventory old storage | Authorized metadata-only counts/schema/sizes/pending operations and orphan scan; no participant bodies or tokens printed; current availability refreshed |
| Choose data path | Explicit clean-start decision or approved preservation scope; no assumption that low use means empty |
| Rehearse | Same code/configuration shape passes isolated staging install, failure recovery, backup/import, writer fencing and rollback cases |
| Drain if needed | Stop new collection starts, allow existing sessions to finish; account for unsaved browser-only answers as well as saved records |
| Fence old writers | All old deployment URLs/aliases/callbacks lose write authority; verify late writes refused before final snapshot |
| Prepare destination | Clean empty workspace or validated full operational import; unresolved jobs classified; schema/secrets/origin/epoch ready; keep writes held |
| Switch | Confirm destination and public routing; permit Cloudflare writes only after the old writer fence is proven; verify controlled end-to-end production acceptance |
| Observe | Readiness, failure classes, queue/backlog ages and completed results match expectations; no unexpected Redis requests or duplicate paid attempts |
| Retire later | Remove this deployment's old connection/resources only after accepted data disposition and recovery period; retain any agreed redirect-only origin |

The old `vercel.app` hostname cannot become a Cloudflare-owned domain. If old entry links must survive, use a redirect-only origin for safe entry pages backed by preserved link records; do not redirect mutation POSTs or unsaved active interviews. Host cookies do not migrate, so plan researcher sign-in and participant re-entry.

Before any Cloudflare production write, the old deployment may be a fallback only if it remains available and its data untouched. After new writes, pointing back to stale Redis hides those writes. Prefer compatible Cloudflare code or forward-fix; reversing storage requires a tested reverse transfer or an explicitly accepted disposition. Upstash availability must be refreshed because the prior inactivity warning made indefinite retention uncertain.

## VERIFY-05 — Completion and evidence boundaries

Claude's local release candidate is complete when the documented local matrix passes on its final revision, all application surfaces are integrated, operator/installer tooling exists and is locally exercised, and the review packet maps requirements to evidence. Remote-only gates may remain pending without obstructing that handoff, but production migration and publication of an untested deploy button remain incomplete.

Codex's subsequent review should check the actual diff, reproduce the highest-risk local fault/authority cases, examine the installer/deployment graph and classify residual risks. Agree live actions from that concrete result. No aggregate test count, successful build or synthetic fixture alone proves live provider compatibility, protected backups, Queue scheduling after inactivity, or production cutover safety.
