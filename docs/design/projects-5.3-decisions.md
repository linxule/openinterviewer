# Owner/lead decisions on projects-5.3-design.md (2026-10-10)

projects-5.3-design.md stands except where this file overrides it. Goal: a lean 5.3.0. Where the design adds
machinery to protect against harmless outcomes, cut it.

1. **No project-create idempotency receipts.** No `project-create` receipt family on either backend, no
   `project-create-receipts` Redis hash, no receipts in backup/inventory. `POST /api/projects` takes `{ name }`
   and no Idempotency-Key. A duplicate empty project after a lost reply is harmless (rename/delete). The client
   disables the button while pending and reloads the list after an ambiguous result.
2. **Fences: deletion only.** Assigning/ungrouping a study must refuse while the study is being deleted (Redis:
   the `oi:smg:` mutation-guard state; Durable: `isFenced`) and must refuse for a missing study. An interview
   completion in flight (`study-persisting`) does NOT block assignment or project deletion: membership is not
   part of the study record. Do not reuse STUDY_CAS_LUA wholesale if that also checks `study-persisting`; reuse
   only its guard check (export a smaller shared prelude if needed, without changing existing behavior).
3. **+ Study is two steps, no pending-assignment records.** `/setup?projectId=<id>`: after the study is created,
   PUT the membership. If the PUT fails, still navigate to the study and show a one-line notice:
   "Study saved, but it was not added to <project>. Move it from the study list." No draft-session receipt,
   no retry machinery.
4. **No old-artifact restart harness.** Keep the runner-level `MIGRATIONS.slice(0, 2)` refusal test. The lead
   will do a one-off manual 5.2-artifact refusal check. Do not touch tests/cloudflare-restart/runner.mjs or lane.ts.
5. **Concurrency:** last writer wins for rename/assign. No CSRF/origin change (cookie is SameSite=Strict).
6. **Bounds:** keep the design's 1,000 projects / 1,000 studies. Names 1-200 chars, trimmed, no control chars,
   duplicates allowed.
7. **Project export is in 5.3** with the design's distinct final marker and one-study-at-a-time streaming, 500
   interviews total. (Second round; see below.)
8. Everything else (migration 3 with minReaderVersion 3, membership removal inside study deletion and sample
   clear, backup format 3 with strict format/schema pairs and v1/v2 import, Redis keys `project:<id>`,
   `all-projects`, `study-project:<studyId>`, purge integration, inventory families, hosted 501 refusal, parity
   contract scenarios) stands as designed.
