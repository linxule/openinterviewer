# Claude implementation handoff

Paste the assignment below into Claude while working in `/Users/xulelin/Documents/Apps/openinterviewer`.

---

Implement the Cloudflare migration specified in `docs/operations/cloudflare-migration/README.md`. Read its linked runtime, storage, analysis-jobs, verification/cutover and researcher UI specifications, plus `AGENTS.md`, before editing. The specifications incorporate an independent architecture/operations/jobs critique; follow their behavioral contracts rather than only the older high-level plan.

Build the complete locally verified release candidate through M6. Start with the M0 runtime proof, then continue through the domain abstraction, SQLite DO backend, durable Queue analysis, complete standalone route integration, asynchronous researcher UI, operator/backup tooling, deployment scripts, self-host documentation and thin agent setup skill. Preserve Node/Vercel standalone Redis direct/Gateway and hosted BYOS direct behavior. New Cloudflare support is standalone + SQLite DO + direct providers, with one deployable Worker. Do not expand to hosted-on-Cloudflare or replace the framework without presenting evidence for a design amendment.

Use an isolated checkout/branch based on the main commit containing this specification package. Inspect the actual current HEAD and dirty files, and preserve unrelated work and the user-owned `.claude/` directory. The committed specifications will be present in the new worktree; no manual document copying is needed. The application baseline reviewed for the specification is `4d3076528681862cda21d0b2c80d1ae2ce9faeda`; the later `dc5c542` changes only the Dependabot Tailwind update policy. Reconcile any further source changes before implementing. Node 24.19+, npm and the lockfile are authoritative. Parallel agents are fine with explicit file ownership and one integrator for shared contexts/routes/types.

Important contracts include: immutable transcripts and atomic consent/revision/admission checks; commit plus durable wake-up; frozen per-generation analysis inputs; one active generation despite different retry keys; no automatic provider repeat after unknown execution; generation/claim/recovery-epoch fencing; trusted Cloudflare client identity; isolated previews; and promotion of only the checked revision/artifact. Keep the full existing verification matrix and add real local Worker/SQLite and production-artifact browser coverage. Do not mock internal save/analyze APIs or replace provider failure with invented content.

Implement and exercise operator/install tooling with synthetic local fixtures. Prepare remote staging, deploy-button, PITR, provider and cutover rehearsals, clearly marking each unexecuted gate. Do not fetch 1Password credentials, call paid providers, read/mutate production data, provision resources, publish a deploy button as tested, or deploy production without my explicit authorization for those actions in this task. Follow my current instructions for commits/pushes. Lack of credentials should not block local implementation.

Use coherent reviewable increments. Resolve routine implementation details without repeatedly asking me. If a required platform mechanism is unsupported, document the exact failed probe and smallest safe alternative; do not silently weaken the contract or report an unrun gate as passing.

When ready for Codex review, return:

1. Branch, base/head commits and scoped diff summary.
2. Milestone and requirement-to-test evidence map, including exact final commands/results.
3. Pinned adapter/runtime versions, bundle/resource measurements, and real fault-cut/provider-request-count evidence.
4. API/configuration/schema changes, installer/update/restore behavior and any specification deviations.
5. Remaining remote-only gates, operational decisions, and the next concrete authorized actions needed for production.

Keep secrets, participant content, opaque tokens, raw SDK errors and environment dumps out of the report.

---

Codex review should assess the actual implementation and evidence before deciding the production strategy. The earlier plan and this assignment do not constitute live migration completion.
