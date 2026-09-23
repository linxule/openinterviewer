# Cloudflare migration plan review — 23 September 2026

Verdict: keep the proposed architecture and begin with the bounded runtime prototype when implementation is authorized. The review found seven missing contracts in the plan. They are now specified in the [revised plan](2026-09-23-cloudflare-migration-plan.md), but remain unimplemented and untested. Following Xule's acceptance, the [Claude implementation package](cloudflare-migration/README.md) owns the full specification; this document records the earlier review and its reasoning.

Three independent agents reviewed architecture/scope, durable analysis jobs, and deployment/operations. The lead checked the findings against source and current official documentation. This is a design review of source baseline `4d3076528681862cda21d0b2c80d1ae2ce9faeda`; it makes no finding about an existing Cloudflare deployment. No application changes, tests, credentials, provider calls, account access, or deployment occurred.

## Accepted findings

| Priority | Gap and concrete consequence | Required correction and verification |
| --- | --- | --- |
| P1 before deployment | Unpromoted code could still reach production storage or enqueue production work through configured bindings. | Disable production Version URLs initially; isolate any enabled preview's resources and secrets. Demonstrate that preview/unpromoted endpoints cannot mutate production. |
| P2 | Existing admission code trusts Vercel/forwarded headers. Copying it to Workers can let a caller choose a different client budget identity. | Establish identity at the trusted runtime entrypoint; test conflicting headers, missing identity, IPv6 and Worker subrequests. Other session/link/study budgets remain independent. |
| P2 | Identifier-only jobs do not say which study configuration to use. A later edit could silently change the requested provider/model or mislabel the analysis revision. | Freeze server-owned configuration, resolved requested model/provider, and revision per generation. Test edits before execution and before attachment. Fetch secrets only when executing. |
| P2 | One idempotency key deduplicates one request, but two different retry actions could allocate competing paid attempts. | Atomically permit one pending/running generation per interview; return existing work for racing actions and already-complete for completed analysis. Test two keys racing the automatic initial job. |
| P2 | Separate GitHub checks and Cloudflare push deployment could race, releasing a failed or unchecked commit. | Choose one deployment owner, bind promotion to the exact checked revision/artifact, and prove a failed check leaves production unchanged. Include a workable update path for button installations. |
| P2 | A previous compatible application version might not be eligible for native rollback after resource lifecycle changes. | Distinguish code, SQL schema and DO lifecycle releases. Preserve compatibility/resources and rehearse N−1 → N → N−1 with pending jobs; use a separate procedure for lifecycle changes. |
| P2 scope | Retaining Redis, hosted and Gateway while adding Workers could accidentally promise every runtime/storage/transport combination. | Publish the bounded support matrix before refactoring: existing deployments continue; the initial Workers target is standalone + DO + direct. Unsupported combinations fail setup/readiness. |

P1 denotes a release-blocking policy gap if left unresolved, not a currently observed production incident. The other findings should be encoded in the relevant implementation contracts before those features are built.

## Evidence and adjudication

**Preview isolation:** Cloudflare distinguishes Version URLs from branch Previews. Version URLs use the uploaded version's resources. Branch Previews can automatically isolate same-Worker DO storage, while Queue producer bindings select a queue by name. The original review's caution was valid; the plan now states this distinction rather than treating every preview as identical. [Version URLs](https://developers.cloudflare.com/workers/ci-cd/builds/#disconnecting-builds), [Preview resources](https://developers.cloudflare.com/workers/previews/resources/).

**Request identity:** the selectors in [rateLimit.ts](../../src/lib/rateLimit.ts) and [platformAiRateLimit.ts](../../src/lib/platformAiRateLimit.ts) prefer `x-vercel-forwarded-for`, then the first forwarded address. Cloudflare retains an existing XFF chain, and its client-IP behavior varies for Worker subrequests. This supports a runtime-specific trust boundary rather than a new generic header fallback. The hosted limiter is evidence of a shared assumption; hosted-on-Workers remains outside this migration. [Header contract](https://developers.cloudflare.com/fundamentals/reference/http-headers/).

**Analysis configuration:** today's [save route](../../src/app/api/interviews/save/route.ts) captures the canonical study for deferred work; the [researcher analysis route](../../src/app/api/interviews/[id]/analyze/route.ts) captures it at the retry request. [interviewAnalysis.ts](../../src/lib/interviewAnalysis.ts) uses that object for both provider inputs and stored revision. The [study update route](../../src/app/api/studies/[id]/route.ts) permits confirmed edits after interviews exist, so the delayed-edit scenario is reachable. Generation snapshots preserve this behavior.

**Competing attempts:** the claim script in [kv.ts](../../src/lib/kv.ts) returns busy for an unexpired running claim and done for completed analysis. [analysisState.ts](../../src/lib/analysisState.ts) includes running records in those awaiting analysis, making a batch/detail race realistic. The new job allocator must preserve this exclusion before invoking a provider, in addition to fencing result attachment.

**Release gate:** [.github/workflows/ci.yml](../../.github/workflows/ci.yml) has quality/browser/Redis gates, but no Cloudflare promotion job; [package.json](../../package.json) currently builds with `next build`. Cloudflare Git integration can deploy on push, so the present checks do not establish the proposed release dependency. [Git integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/).

**Rollback:** Cloudflare documents restrictions after DO class lifecycle changes and deletion of resources used by a rollback target. Stored schema compatibility also needs testing because code rollback does not rewind data. The plan now requires a proven target rather than assuming a prior version will be usable. [Rollback limits](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/#bindings).

**Scope:** [mode.ts](../../src/lib/mode.ts) currently distinguishes only standalone and hosted, and [researcherContext.ts](../../src/lib/researcherContext.ts) exposes a Redis client. A central capability choice is needed before replacing that boundary. The support table is a proposed planning constraint, pending the user's broader product-scope decision.

A smaller lifecycle clarification was also accepted: define receipt/job retention and cancellation; missing or deleted jobs must be acknowledged without creating work. The review did not establish a current interview-deletion bug, so this remains an implementation requirement rather than a reported defect.

## Architectural judgment and remaining uncertainty

SQLite DO remains a reasonable first choice for the existing conditional transactions. One object per standalone workspace matches the current coordination boundary. The reviews found no evidence requiring D1 or a second authoritative database; D1 remains the fallback comparison if the prototype exposes disproportionate operational costs.

The outbox and Queue serve the requirement that saved transcripts retain recoverable analysis work after the HTTP request ends. They add implementation work, but low traffic does not eliminate response-loss and paid-retry hazards. Keep provider calls outside the storage object and retain the conservative unknown-outcome policy. One job invocation must not be described as one HTTP request or exactly-once billing: SDK retry behavior still needs verification.

The largest maintenance tradeoff is supporting two backends. This migration consolidates this deployment's infrastructure while initially increasing code and test coverage obligations. Keeping the matrix narrow, leaving Redis mechanics inside its adapter, and avoiding a simultaneous hosted redesign make that cost explicit.

Proceed one gate at a time: first prove a clean locked build, Next proxy/auth, trusted request identity, custom fetch/Queue/DO composition, and local persistence in the actual Worker runtime. Reassess effort after that evidence, before the broad storage refactor. Fresh button installation, origin bootstrap, export memory, restoration and a gated update path remain release gates; documentation alone does not establish them.

The record disposition decision is still open. Implement an Upstash importer only if the later authorized inventory identifies records to preserve. Do not interpret low use as permission to erase data. Application changes and production migration remain outside this review.
