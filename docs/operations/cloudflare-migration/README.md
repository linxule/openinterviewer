# Cloudflare migration: implementation plan and specification

Status: ready for implementation handoff, 23 September 2026. Application baseline: `4d3076528681862cda21d0b2c80d1ae2ce9faeda`. No implementation or deployment has been performed for this specification.

Xule accepted the reviewed recommendations and will have Claude implement them; Codex will review the result and advise on subsequent strategy. This package turns the earlier [architecture plan](../2026-09-23-cloudflare-migration-plan.md) and [independent critique](../2026-09-23-cloudflare-plan-review.md) into build contracts. These specifications take precedence over the earlier plan where they make a decision more precise. Repository `AGENTS.md` and existing security/product invariants continue to apply.

## Intended result

Run the existing standalone OpenInterviewer product on Cloudflare without Upstash: researcher login, study management, opaque participant links, consent, live interviews, immutable transcript saves, reliable deferred analysis, researcher recovery, aggregate/follow-up work, and exports. Provide a tested self-host installation/update path and a Deploy to Cloudflare button when its acceptance tests pass, with an agent setup skill using the same scripts.

The migration preserves the current Next.js application and design system. It introduces a native transactional backend and a durable analysis path. It does not promise a storage-client substitution, lower total engineering effort, exactly-once provider billing, or a demonstrated Cloudflare build before the feasibility gate passes.

## Read and build in this order

| Specification | Owns |
| --- | --- |
| [01 — Runtime and installation](01-runtime-and-installation.md) | Configuration, OpenNext entrypoint, request identity, bindings, secrets, readiness, button and installer/skill |
| [02 — Storage](02-storage.md) | Domain interface, Redis compatibility, SQLite schema, atomicity, expiry and data operations |
| [03 — Analysis jobs](03-analysis-jobs.md) | Outbox/alarm/Queue protocol, paid-call boundaries, HTTP/client contract and recovery |
| [Researcher UI slice](../../design/slice-cloudflare-analysis-spec.md) | User-visible queued/running/failure states, copy and accessibility |
| [04 — Verification and cutover](04-verification-and-cutover.md) | Test matrix, evidence, release gating, backup/restore, production transition and rollback |
| [Claude handoff](CLAUDE-HANDOFF.md) | Paste-ready implementation assignment and review-return format |

Requirements use stable prefixes: `RT`, `SETUP`, `ST`, `JOB`, `API`, `UI-CF`, `VERIFY`, and `OPS`. Tests should cite the relevant requirement in their title or nearby description. An implementation report must link each acceptance requirement to evidence or explicitly mark it unverified; repeating this checklist is not evidence.

## Chosen boundaries

| Decision | Contract |
| --- | --- |
| Product scope | Standalone-first. Hosted BYOS and existing Redis installations remain supported. |
| Runtime selector | Add `DEPLOYMENT_TARGET=node\|cloudflare`; absent means `node` for backward compatibility. Unknown values fail setup/readiness. |
| Supported combinations | Node/Vercel standalone + Redis + current direct/Gateway options; Node/Vercel hosted + platform/BYOS Redis + direct; Cloudflare standalone + SQLite DO + direct. |
| Capability resolution | Existing `DEPLOYMENT_MODE` and `AI_TRANSPORT` remain. Derive storage centrally from the validated target/mode. No independently selectable hidden Redis fallback on Cloudflare. |
| Worker packaging | One deployable Worker: OpenNext `fetch`, independent `queue`, exported `WorkspaceStore` DO class. Split Workers only for a demonstrated constraint. |
| Bindings | `WORKSPACE_STORE` and `ANALYSIS_QUEUE`; physical resource names vary by installation/environment. Adapter-required assets/cache bindings must be documented separately. |
| Storage boundary | One SQLite object per standalone workspace, selected from a stable server-owned installation identity. Browser input never chooses another workspace/object. |
| AI execution | Existing direct native adapters, same study-selected provider/model and validation/provenance. Queue-only synthesis receives an explicit no-SDK-retry execution policy. |
| Background scope | Per-interview post-save analysis and researcher retry move to durable jobs. Connected live interview, preview, aggregate and follow-up requests retain their current product behavior, subject to runtime tests. |
| Recovery | External `ANALYSIS_RECOVERY_EPOCH` and explicit activation after restore; ordinary requests cannot change the epoch. |
| Release isolation | Disable production Version URLs/branch previews initially. Full remote staging uses a separate Worker, storage namespace, Queue and secrets. |
| UI | Existing components/primitives and design direction; additive analysis behavior only. |

Do not build D1 plus DO, a general job platform, multi-tenant Cloudflare hosting, a new authentication system, a new AI gateway, or a framework rewrite as part of the first implementation. Keep existing hosted reconciliation and Redis-specific failure protocols inside their present backend.

## Milestones and integration sequence

| Milestone | Deliverables | Exit evidence |
| --- | --- | --- |
| M0 — Baseline and feasibility | Isolated clean Node 24.19+ checkout, locked dependencies, pinned OpenNext/Wrangler/runtime date, minimal custom Worker and local transaction/alarm/Queue probes | Actual production artifact runs public/auth/proxy routes, canonical request identity, assets, crypto and provider HTTP fixtures; transaction/alarm rollback and restart behavior established. Record chosen versions and failures. |
| M1 — Domain boundary | Backend-neutral operation/result types, capability factory, existing Redis wrapper, initial SQLite migrations and workspace identity | Existing behavior preserved by shared contract scenarios. Hosted sagas remain intact. No Cloudflare request can construct/use a Redis fallback. |
| M2 — Storage vertical slice | Study → link → consent → immutable save plus initial job → claim → synthetic result attach → researcher read/export | Real local SQLite concurrency, revision/revocation, corruption, expiry, response-loss and restart scenarios pass. |
| M3 — Durable analysis | Dispatcher, one alarm scheduler, Queue handler, active-generation exclusion, frozen inputs, conservative unknown-outcome handling, recovery epoch | Every `JOB` fault cut has an observed result; provider fixture request counts establish retry policy. No automatic repeat after provider-started uncertainty. |
| M4 — Complete application | Remaining standalone routes, readiness/setup, analysis v2 client/polling, researcher UI, sample workspace and export memory behavior | Real browser journey on built Worker; closing the participant tab does not abandon saved work. Auth, preview, aggregate/follow-up and sample cleanup remain correct. |
| M5 — Operator and self-host package | Local/release scripts, gated CI, install/update/partial recovery, operational export/import, restore tooling, skill, README/self-host docs | Local release matrix passes. Remote-only cases have a prepared rehearsal and remain explicitly pending until executed. Button is published only after actual install validation. |
| M6 — Reviewable release candidate | Scoped commits/diff, requirement/evidence map, operator runbook, limits and remaining decisions | Claude returns the review packet below. Codex independently reviews the diff and failure behavior before production strategy is finalized. |
| M7 — Authorized live transition | Account/origin selection, staging rehearsals, record disposition, writer fence, cutover and eventual retirement | `OPS` gates pass; one production writer; recovery target and limitations recorded. |

M0 is a stop/go technical gate, not a separate permission ceremony. Continue local implementation through M6 once its evidence passes. If it fails, investigate the exact incompatibility and report a bounded alternative before changing the architecture. A switch to vinext, D1, multiple Workers or hosted scope needs an explicit design amendment with tradeoffs; do not silently widen the implementation.

Use coherent commits or review units, not a single inseparable rewrite. One integrator owns request contexts, capability resolution, shared route contracts and the final CI matrix. Storage, jobs and UI work may proceed in parallel once their types are agreed; assign distinct files and do not let multiple workers rewrite `kv.ts` or the same route concurrently. Do not create a new permission request for routine local decisions already covered by the implementation assignment.

## Route and component coverage

Completing only the save/analyze path is insufficient. Use this inventory to close remaining Redis assumptions. Prefixes below are relative to `src/app`; inspect current source again if HEAD changes.

| Surface | Required behavior on Cloudflare |
| --- | --- |
| `/api/auth`, `/api/auth/me`, `src/proxy.ts`, login/setup/settings | Standalone sessions, independent secrets, page/API protection, truthful storage/provider setup; no hosted OAuth requirement |
| `/api/config/{mode,status,readiness}`, `/api/health/ready` | Validated target capabilities and bounded native-store readiness; safe public fields only |
| `/api/studies`, `/api/studies/[id]` | Read/create/edit/link-status/delete with current confirmations, revisions, operation idempotency and failure semantics |
| `/api/generate-link`, `/api/studies/[id]/participant-links`, `/p/[token]` | Opaque entry codes, server-authorized exchange/revocation and tab-isolated participant cookies |
| `/api/consent`, `/api/greeting`, `/api/interview` | Current study/link/session/consent checks, trusted network identity and atomic budgets before provider calls |
| `/api/interviews/save` | Immutable save-first response, atomic completion/admission/job, no post-response provider dependency |
| `/api/interviews`, `/api/interviews/[id]`, `/api/interviews/[id]/analyze` | Checked collections, ownership, public state projection and v2 durable researcher analysis |
| `/api/synthesis` | Researcher preview remains non-persistent and uses the configured provider; existing participant access rules preserved |
| `/api/synthesis/aggregate`, `/api/studies/[id]/aggregate`, `/api/studies/[id]/generate-followup` | Study-selected models, aggregate freshness/provenance, bounded store reads and existing follow-up rules |
| `/api/interviews/export` | Existing researcher export formats, provenance and formula safety within Worker memory limits |
| `/api/demo/seed` POST/DELETE | Authenticated fixture seed and scoped cleanup through domain operations, including cancellation of fixture jobs; never broad storage deletion |
| Public `/demo` | Component-memory-only; zero auth/API/provider/persistence calls |
| Hosted account/onboarding/OAuth/reconciliation APIs | Existing Node behavior retained; Cloudflare standalone does not activate them or require platform credentials |
| `StudyDetail`, `InterviewDetail`, `analysisApi`, analysis selectors | New durable state and polling contract; same Node synchronous outcome support |
| README, environment examples, self-host page, setup checker, contributor/agent guidance | Update only changed contracts; remove Redis requirements from the Cloudflare journey, preserve them where still applicable |

Search for direct Redis access in routes and shared libraries after integration. A static import can be legitimate for the retained adapter; a successful browser test with no Redis requests is stronger evidence than a renamed client. Include sample-data cleanup, create-idempotency resolution, rate limits and health checks in this audit.

## Decisions that remain operational

Local work proceeds with synthetic fixtures. Before live provisioning/cutover, record the selected Cloudflare account, hostname, desired storage jurisdiction, backup destination/retention, resource naming, existing usage headroom, provider smoke budget, and whether old participant links need continuity. EU DO placement is the proposed default, not a claim that all processing stays in the EU.

Production record disposition remains undecided. Prepare both clean-start and preserve-data runbooks; build an Upstash-specific importer only if the authorized inventory identifies data to retain. Portable Cloudflare operational backup/restore is required for either path. Keep the existing database untouched until its disposition is agreed.

This handoff does not fetch credentials or authorize production mutations. The implementation assignment can authorize local code, tests and commits; live access, paid calls and deployment follow Xule's explicit instructions in that task. A lack of live credentials must not stop the local release candidate or be reported as a passing live gate.

## Review return packet

Return the branch/base/head, changed-file summary, milestone status, exact verification commands/results and requirement-to-test links. Include pinned runtime versions, generated bundle measurements, fault-cut/provider-count evidence, the configuration/API/schema changes, and a list of remote-only gates still outstanding. Identify any deviations from these specifications with evidence and rationale. Provide a runbook describing the next authorized live actions, not a claim that implementation alone completed migration.

Keep participant content, credentials, raw SDK errors, environment dumps and opaque link codes out of the report. The reviewer should be able to reproduce local verification from a clean checkout without any real account or provider credentials.
