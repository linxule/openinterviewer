# Projects — implementation design for 5.3.0

Baseline: inspected checkout `1ee54c5`, `main`, package version 5.2.0 (`package.json:3`). This is a design, not an implementation or deployment receipt. Only this document was written; no application code, tests, configuration, or Git state was changed. No runtime tests were run.

Evidence convention: references are repository-relative `path:line` anchors read in this checkout. **UNVERIFIED — proposed** marks new behavior, names, limits, or implementation choices, rather than existing functionality. All new files and new symbols below are proposals and have no current-tree line numbers. User-decided constraints are identified separately. Production state and compatibility of an actual historical binary were not tested.

## 1. Files to add/change and implementation shape

### Decided scope and invariants

- Standalone Node/Redis and Cloudflare/SQLite first. Hosted projects are refused, not silently stored in a shared BYOS namespace.
- One named project may contain many studies; a study has at most one project. No membership means Ungrouped. Deleting a project removes membership, never studies or interviews.
- Project assignment is researcher organization, not study configuration. Never change study JSON, study revision, study timestamps, consent hashes, participant links/sessions, analysis provenance, or saved transcripts when assigning/unassigning.
- Cloudflare migration 3 adds `projects` and `study_projects`; existing `studies` columns remain unchanged. Backup format 3 appends row families. Format-2 backups import with project families empty.
- Schema 3 is forward-only relative to 5.2. A 5.2 build must refuse that workspace, even though the SQL change is additive.

The existing non-revision-bumping comparison is `setStudyLinksEnabled`: Redis patches only link status and `updatedAt` (`src/lib/kv.ts:1605`); Durable calls `mutateStudy(..., false)` (`cloudflare/workspace/studies.ts:504`). Projects go further: do not call either study-config mutator or patch the study at all. Normal config changes calculate an incremented revision and update the study row (`cloudflare/workspace/studies.ts:434`).

### UNVERIFIED — proposed domain and port

New `Project = { id, name, createdAt, updatedAt }`, with server-generated UUID ID and safe integer millisecond timestamps. New `StudyProjectMembership = { studyId, projectId }`; null is an API command to delete a membership, never a persisted null membership. Names are trimmed, 1–200 UTF-16 code units, no control characters; duplicates are permitted and identity always uses ID. Escape names in exports, render as text in UI. No researcher ID is stored in these standalone records.

Add a new required `projects: ProjectsStorePort` property to the common store. New methods: `list`, `read`, `create`, `rename`, `delete`, `assignStudy`. `list` returns a bounded, atomic snapshot of project metadata and membership mappings, not study configurations. `read` returns one project and its bounded study-ID roster. New outcomes distinguish not-found, study-not-found, conflict, persist-guard, too-large/quota, held, unavailable, and ambiguous; create additionally has key-reuse/key-consumed. Validate full payloads and requested identities, not just status tags. All methods refuse hosted use at the adapter boundary.

Proposed bounds: 1,000 projects and 1,000 studies for interactive project listing/deletion/roster reads; 100 live project-create receipts; 7-day receipt horizon. These bounds are new, not a claim about existing project capacity. Existing study listing requests 1,000 records (`src/app/api/studies/route.ts:156`), while create receipts already use 100 and seven days (`src/lib/createIdempotency.ts:15`; `cloudflare/workspace/studies.ts:24`). Refuse oversize operations rather than truncate. Assignment and study purge remain available individually even if the project listing bound is exceeded.

### Production file manifest

Every entry in this table describes future implementation work, **UNVERIFIED — proposed**, unless explicitly marked unchanged. Test files are enumerated in section 5; those are part of the complete change manifest as well.

| File / current anchor | Add/change |
| --- | --- |
| **New** `src/lib/projects/types.ts` | Pure project shapes, limits, store inputs/outcomes and `ProjectsStorePort`; no Next, Redis, or provider imports. Keep these separate from `StudyConfig` and `StoredStudy`. |
| **New** `src/lib/projects/validation.ts` | Shared closed-record/name/ID/time validators, including RPC and backup-domain validation where portable. |
| **New** `src/lib/projects/http.ts` | Shared route guard, bounded project-body readers and outcome-to-HTTP mapping; hosted refusal before BYOS resolution. This is a new helper, not an existing origin-check helper. |
| **New** `src/lib/projects/idempotency.ts` | Project-domain fingerprint and scoped digest; reuse UUID parsing but not study receipt shapes or study fingerprints. |
| `src/lib/storage/types.ts:271` | Add the required project sub-port. Existing study and participant method signatures remain unchanged. Update typed store fixtures as compiler errors identify them. |
| **New** `src/lib/storage/redisProjects.ts` | Project keys, bounded Lua operations, closed reply decoding, and ambiguous-commit handling. No read/modify/write of a study JSON document. |
| `src/lib/kv.ts:1576` | Export the existing `STUDY_CAS_LUA` prelude for exact reuse in project assignment and project-delete preflight; preserve its current behavior and key positions. The shared purge is already imported here (`src/lib/kv.ts:24`). |
| `src/lib/storage/redisStudyPurge.ts:4` | Validate the membership key type and delete the membership inside shared auxiliary purge, covering both empty and populated study deletions. |
| `src/lib/storage/redis.ts:170` | Construct the project sub-port using the supplied Redis client; extend the standalone-only operation guard (`src/lib/storage/redis.ts:83`). Do not resolve a global fallback client. |
| `src/lib/storage/durableObject.ts:384` | Add project RPC wrappers through the existing `call` boundary, with full new payload validation; reads map uncertain RPC replies to unavailable, writes to ambiguous. |
| `cloudflare/workspace/schema.ts:192` | Append migration 3 with explicit `minReaderVersion: 3`; preserve migrations 1/2 byte-for-byte. |
| **New** `cloudflare/workspace/projects.ts` | SQLite project CRUD, roster/list reads, receipt-backed create, assignment, bound checks, maintenance gates and mutation-sequence updates in transactions. |
| `cloudflare/workspace/WorkspaceStore.ts:113` | Add additive project RPC entry points, all behind `requireInitialized`; dispatch to the new domain module. |
| `cloudflare/workspace/rpcTypes.ts:1` | Add clone-safe project RPC shapes only where they differ from the portable project port; share portable shapes directly otherwise. Preserve old wire shapes. |
| `cloudflare/workspace/studies.ts:528` | Delete `study_projects` inside the existing successful study-deletion transaction, before parent deletion at `cloudflare/workspace/studies.ts:573`. Refused deletion must preserve membership. |
| `cloudflare/workspace/sample.ts:214` | Also delete memberships for studies actually removed by sample clear; this is a separate deletion path. Preserve the project and unrelated memberships. |
| `src/lib/backup/format.ts:20` | Format 3, append two closed row families, explicit version-to-family/schema compatibility, retain v1/v2 readers. |
| `cloudflare/workspace/operator.ts:599` | Add reference/identity checks and explicit legacy-import compatibility; missing legacy families must be empty on target. |
| `scripts/cloudflare/inventory-redis.mjs:431` | Register new primary/index/receipt families, metadata-only projections, orphan/invalid counters, completeness and research-data reporting. |
| **New** `src/app/api/projects/route.ts` | GET list and POST idempotent create. |
| **New** `src/app/api/projects/[id]/route.ts` | PATCH rename and DELETE ungrouping deletion. |
| **New** `src/app/api/studies/[id]/project/route.ts` | PUT assign/unassign; no study configuration endpoint reuse. |
| **New** `src/app/api/projects/[id]/export/route.ts` | GET project transcript Markdown, authorized through the project guard. |
| **New** `src/lib/export/studyTranscriptsSource.ts` | Extract reusable authorized-store, per-study export-source preparation from the existing export route; sources expose count, stream and final validation. Do not call HTTP route handlers from another route. |
| `src/app/api/interviews/export/route.ts:280` | Use that extracted source without changing the current study-export contract; retain Node deletion recheck and Durable snapshot behavior. |
| **New** `src/lib/export/projectTranscriptsMarkdown.ts` | Concatenate the shared per-study streams, enforce total limits/backpressure, and write/check a distinct project completion sentinel. |
| **New** `src/services/projectService.ts` | Typed project API client, stable create-intent key, explicit error mapping and checked project download. Reuse the outcome conventions at `src/services/storageService.ts:21` and filename handling at `src/services/storageService.ts:312`. |
| `src/components/StudyList.tsx:13` | Project loading, disclosure groups, Ungrouped, create-project action, per-project + Study, rename/delete/export menus and study move/unassign control. Preserve existing row actions and hosted flat view. |
| `src/components/StudySetup.tsx:626` | Read project creation intent separately from study config; after successful study creation, assign once through the new endpoint. Preserve the saved study on assignment failure and expose a retry-assignment action. |
| `src/lib/studyDraftSession.ts:69` | Include the target project in new-study intent identity; record a completed-study/pending-assignment receipt so reloading after partial success does not create a duplicate study. Never store a bearer credential. |
| `playwright.config.ts:31` | Include the new projects spec in the standalone-gateway testMatch; direct already discovers it. |
| `tests/cloudflare-restart/runner.mjs:55`, `tests/cloudflare-restart/lane.ts:74` | Test-only explicit selection of current and retained historical artifacts for the schema refusal rehearsal; maintain allowlisted environments and runner-owned state. |
| **New** `docs/design/slice-projects-spec.md` | Bind grouped-register interaction, focus behavior, mobile layout, copy and reused primitives before UI implementation. |
| `package.json:3`, `package-lock.json:3`, `package-lock.json:9` | Owner release step: version 5.3.0; no dependency upgrade required by this design. |
| **New** `docs/releases/v5.3.0.md`; `README.md:5` | Release note/link, standalone scope, grouping/export behavior, limits and forward-only schema warning. |
| `docs/operations/cloudflare-migration/RUNBOOK.md:301` | Add concrete 5.2/schema2 → 5.3/schema3 forward-only procedure and backup compatibility matrix. |
| `docs/operations/cloudflare-migration/IMPLEMENTATION.md:183` | Record format-3/import behavior alongside operator contracts; no new operator HTTP route required. |
| `AGENTS.md:22` | Future scoped guide update: project domain/storage navigation and no-revision/no-participant-authority invariant. No live state or test counts. |

No changes planned to provider adapters/prompts, participant routes, hosted saga/platform schema, or environment templates. No changes required to `wrangler.jsonc:64`: its `v1` migration creates the SQLite-backed class and is not the application SQL migration number. No mechanical `v3` Wrangler tag. `CURRENT_SCHEMA_VERSION` is derived from the final migration (`cloudflare/workspace/schema.ts:214`), and the artifact build reads that constant (`scripts/cloudflare/build.mjs:121`), so no hard-coded build version edit is needed.

### UNVERIFIED — proposed UI behavior

Keep the existing register rows and responsive columns (`src/components/StudyList.tsx:295`). Each project is a section with a disclosure button (`aria-expanded`, `aria-controls`), study count, + Study, and a labelled ··· menu containing Rename, Export transcripts, Delete project. Show empty projects. Ungrouped is an explicit section, including its empty state. Add a top-level New project action. Add “Move to project…” and “Ungroup” to study actions; do not require drag-and-drop.

Use existing Button/Notice/etc. imports (`src/components/StudyList.tsx:11`), native form fields and current tokens. No new visual primitive is required for the minimal design. Preserve ArrowUp/ArrowDown row navigation (`src/components/StudyList.tsx:173`), Escape/focus restoration (`src/components/StudyList.tsx:390`), keyboard menu access, and 44px touch targets. Collapsing a section containing focus moves focus to its disclosure button. Collapse state may remain component-local; no new persistence requirement.

Delete confirmation: “Delete this project? Its studies will move to Ungrouped. No study or interview will be deleted.” Disable repeated actions while pending; after ambiguous writes reload state, do not show assumed success or automatically repeat a stale command. Never interpret a failed project fetch as every study becoming ungrouped. A project snapshot and study list can race: a missing membership target or unmatched study-ID roster triggers a visible refresh-needed state, not a guessed grouping. Newly created studies after the captured project roster require a reload before grouping is asserted.

Mode handling must be tri-state (loading/standalone/hosted-or-unavailable) for projects. The current mode fetch defaults to false on error (`src/components/StudyList.tsx:63`); do not use that fallback as authority to enable project controls. Hosted retains the current flat list and reconciliation path, and makes no project requests.

“+ Study” opens `/setup?projectId=<id>` as a non-secret UI intent. Keep the existing POST study contract and idempotency behavior unchanged (`src/services/storageService.ts:84`; `src/app/api/studies/route.ts:535`). After create success, remember the returned study ID before attempting assignment; then call PUT membership. Only after both steps succeed show grouped success/navigation. If project deletion, outage or guard refusal intervenes, say “Study saved; project assignment did not finish,” preserve the study ID and offer Retry assignment or Continue ungrouped. Never compensate by deleting the study. Modify the current immediate-success navigation (`src/components/StudySetup.tsx:652`). A reopened pending assignment is read back before retry; source duplicate/follow-up relationships do not implicitly confer project membership.

## 2. Migration SQL, schema versions and rollback

### UNVERIFIED — proposed migration 3

Append `{ version: 3, name: 'standalone research projects', minReaderVersion: 3, statements: [...] }`. SQL:

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
);
CREATE INDEX projects_by_created ON projects (created_at, id);
CREATE TABLE study_projects (
  study_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL
);
CREATE INDEX study_projects_by_project ON study_projects (project_id, study_id);
```

Application validation also enforces safe integers, UUID project IDs, study IDs, whitespace/control rules and the stricter JS name bound. SQL `length` and JS UTF-16 lengths differ; accept only values that pass both. Preserve the eight existing study columns (`cloudflare/workspace/schema.ts:36`; `src/lib/backup/format.ts:55`). No ALTER of `studies`, no config rewrite/backfill: all existing studies initially ungrouped.

No foreign keys are proposed: current study-related tables use explicit domain transactions and restore reference checks (`cloudflare/workspace/schema.ts:50`; `cloudflare/workspace/operator.ts:599`). Both parent existence checks and membership writes happen in the same transaction. This choice requires exhaustive purge and import tests, not reliance on cascading DDL.

Use `gate(ws, 'read')` for project reads and `gate(ws, 'researcher-mutation')` for writes (`cloudflare/workspace/context.ts:102`). Recheck study existence and `isFenced` (`cloudflare/workspace/studies.ts:123`) for assignment. A missing/fenced study is not recreated. Transactions serialize with completion; there is no Redis-style multi-command completion window to invent on Durable. Project CRUD and effective membership changes call `bumpMutationSeq` (`cloudflare/workspace/context.ts:125`) once, but never study mutation methods. No-op rename/assignment does not advance sequence or timestamps.

Project create uses `idempotency_receipts` with **new** operation family `project-create`. Follow the current atomic receipt pattern (`cloudflare/workspace/studies.ts:358`), but use project shapes, independent receipt quota and name fingerprint. If a wake-up is required, use `storage.transaction(async)` and await `armAlarmNoLaterThan` in that same transaction (`cloudflare/workspace/context.ts:132`). The scheduler already expires all receipt families (`cloudflare/workspace/scheduler.ts:364`); no scheduler code change is needed merely to add this family. Preserve consumed create-key authority after project deletion, with `result_json = NULL` and the original expiry. No `project` addition to the released deletion-fence CHECK is necessary: IDs cannot be client-selected, assignment/rename require a live project, and create receipts stop replay resurrection during the horizon.

Delete project in one transaction: gate, validate/read project, collect affected membership count under bounds, remove its memberships, remove project, scrub its create receipts to deleted, bump sequence and schedule receipt cleanup if needed. Do not invoke study deletion, touch participant links, or cancel analysis jobs. Study deletion adds `DELETE FROM study_projects WHERE study_id = ?` to its existing transaction; sample clear does the same for its actually deleted fixture studies. The existing absent-study delete shortcut (`cloudflare/workspace/studies.ts:540`) should also remove a stray membership if present, with a sequence bump only for actual cleanup; legitimate new writes cannot create such an orphan.

### Verified refusal mechanism and required release behavior

The runner stores `min_reader_version` in the ledger (`cloudflare/workspace/migrate.ts:23`), checks an unknown migration against the build's highest known version (`cloudflare/workspace/migrate.ts:48`), and returns `schema-unsupported / newer-incompatible` before applying anything if the stored minimum reader is higher. Migration SQL and its ledger entry commit together (`cloudflare/workspace/migrate.ts:63`). Checksums cover SQL statements only (`cloudflare/workspace/schema.ts:218`); do not edit released statements or weaken their reader minimum.

Today migration 2 explicitly sets reader minimum 2 because older builds omit notebook data on deletion/export/backup (`cloudflare/workspace/schema.ts:192`). This is the same reason migration 3 needs minimum 3: 5.2 does not purge or back up memberships/projects. **UNVERIFIED — compatibility conclusion from current runner:** given a ledger row `(version=3, min_reader_version=3)`, the current 5.2 build's highest version 2 will refuse. This has not been executed against a saved 5.2 artifact in this task; section 5 specifies that rehearsal.

`WorkspaceStore.initialize` converts migration refusal to its held initialization state (`cloudflare/workspace/WorkspaceStore.ts:56`). `requireInitialized` preserves it (`cloudflare/workspace/WorkspaceStore.ts:93`); readiness returns held (`cloudflare/workspace/WorkspaceStore.ts:107`), study reads return unavailable and mutations return held (`cloudflare/workspace/WorkspaceStore.ts:115`). New project RPCs must use the same guards. Routes can map holds through `workspaceHeldResponse`, producing 503/no-store (`src/lib/canonicalStudy.ts:175`). An old route/bundle must not write through this hold. Existing tests include refusal of reads, mutations and dispatch (`tests/workers/schema.migrations.test.ts:154`).

Keep `MIN_READABLE_SCHEMA_VERSION = 1` (`cloudflare/workspace/schema.ts:216`) because the new build can migrate older workspaces. It is not permission for an older build to read newer data; that distinction is already documented (`docs/operations/cloudflare-migration/RUNBOOK.md:305`). Artifact metadata becomes `schema.current = 3`, `schema.minReadable = 1` automatically.

**UNVERIFIED — proposed release procedure:** drain ongoing analysis, freeze and validate a pre-upgrade format-2 backup; deploy the checked 5.3 artifact, verify migration/readiness and project behavior, then reopen. After schema 3 has been applied, fix forward. Do not lower the ledger minimum, remove migration 3, delete project tables, or run mixed versions to obtain an apparent rollback. Restoring a pre-upgrade backup to a separate old-schema recovery installation is disaster recovery with explicit loss of post-backup writes, not an in-place rollback. Actual deploy/recovery remains owner work, not authorized by this design task.

Node has no equivalent workspace-wide project schema reader gate in the inspected adapter (`src/lib/storage/redis.ts:179`). **UNVERIFIED — operational conclusion:** rolling Node back to 5.2 would hide project data and permit old deletion code to leave orphan memberships; prohibit that operationally for this release. This document does not claim an unmodified 5.2 Node binary can be made to refuse new Redis keys. The mandated automatic schema-3 refusal applies to the Durable workspace.

## 3. Redis keys and Lua changes

### UNVERIFIED — proposed key contract

| Key | Type/value | Lifetime and role |
| --- | --- | --- |
| `project:<id>` | string, new `oi:project:` prefix plus closed Project JSON | Persistent project metadata; no study/config content. |
| `all-projects` | set of project IDs | Persistent complete project index, maintained atomically with primary rows. |
| `study-project:<studyId>` | string containing validated project UUID | Persistent single membership; absence means ungrouped. |
| `project-create-receipts` | **New additional bookkeeping key**, hash of scoped key digest → new closed prefixed receipt JSON | Up to 100 live receipts, each with absolute `expiresAt`; expired fields removed within guarded Lua. Needed to match create idempotency without writing study JSON or reusing study receipts. |

Receipt shape includes fingerprint, original project result, project ID, created/deleted disposition and expiry. Deleted receipts retain no name/result content. Scope the new digest/fingerprint to projects, so the same raw UUID can safely create one study and one project. Reuse `parseIdempotencyKey` (`src/lib/createIdempotency.ts:180`) and SHA-256 domain-separation pattern (`src/lib/createIdempotency.ts:186`); do not reuse `createFingerprint`, which is explicitly tied to study config (`src/lib/createIdempotency.ts:199`). No key-level expiry on a hash containing mixed receipt lifetimes; logical expiry is checked on every access. Independent live receipt quota must match Durable behavior.

No reverse membership index is introduced for v5.3. Project list/delete/read scans the bounded `all-studies` set inside Lua and reads each membership key. This preserves the decided three research-key families, with the explicit extra receipt bookkeeping family above. It is O(workspace studies), not O(project studies); maximums must be checked before `SMEMBERS`/large assembly. Do not use production `KEYS`, whole-database `SCAN`, or follow arbitrary IDs stored in malformed data.

### Existing fences that must be reused

`studyCasKeys` supplies study, `study-persisting`, and mutation-guard keys (`src/lib/kv.ts:1568`). `STUDY_CAS_LUA` refuses when the persist set is nonempty, then checks `oi:smg:` and refuses malformed guards or any state other than `created` (`src/lib/kv.ts:1576`). Check fences before even a no-op assignment, just as current CAS scripts do. Reuse the literal exported prelude, not a subtly weaker TypeScript pre-read.

**UNVERIFIED — proposed assignment Lua:** keys 1–3 are the existing CAS triplet; additional keys identify membership and destination project. Run the prelude; decode/read the canonical study and verify its identity; validate membership type/value and destination project identity/existence. If target is non-null, require destination to be in `all-projects`. Missing destination → project-not-found; missing study → study-not-found; corruption → unavailable, no write. `SET study-project:<id> <projectId>` or `DEL` for null. Equal current/desired membership succeeds as unchanged. Never `SET study:<id>`, `SREM all-studies`, change links, or touch participant persistence. Use tagged wire arrays so Upstash automatic deserialization cannot erase outcome distinctions.

**UNVERIFIED — proposed create Lua:** preflight types of primary/index/receipt hash and validate all bounded receipts before writes; replay matching unexpired receipt, refuse changed fingerprint, refuse consumed key, check quotas/collision, then write project, add index ID and store receipt in one EVAL. Expired receipt pruning is part of a successful guarded operation. Generate candidate ID/time outside retried transactions. Replay after rename returns original creation receipt, not a second project or the new name; client refresh obtains current state. A network error after a possible commit is ambiguous; retry only on explicit user action with the same key.

**UNVERIFIED — proposed rename Lua:** preflight primary/index and closed project shape; require an existing indexed project; update only name/updatedAt, with server time monotonic via `max(oldUpdatedAt, now)`; unchanged name is a no-op. No membership or study guards are needed for a metadata-only rename.

**UNVERIFIED — proposed project-delete Lua:**

1. Validate project/index/receipt key types, bounded project record and receipts. Absent primary plus absent index is idempotent deleted; mismatched primary/index is corruption, not success.
2. Check `SCARD all-studies <= 1000` before enumeration; validate each study-ID token and membership key's type/value. Collect only IDs currently pointing to this project. Validate their study rows and guard triplets. To reuse the prelude for multiple studies, wrap the exported prelude in a new Lua function with a local `KEYS = {studyKey, persistingKey, guardKey}` and return its refusal tag; this wrapper is new. Any live completion/deletion or malformed guard refuses the entire delete before its first content write.
3. Delete only the collected membership keys, project primary and its index member; mark its receipt(s) consumed and erase name/result payloads, preserving expiry. Never delete a study, interview, link, notebook, aggregate, or participant consent.

No client-supplied member list is trusted for project deletion. Redis serializes the script with assignment: an earlier assignment is included; a later assignment finds the deleted project and refuses. A concurrent study purge either completes first and removes its membership, or its guard causes refusal. Conservatively delay ungrouping a project while any affected study has a completion fence, as requested.

### Study purge integration and failure behavior

Shared `valid_auxiliary_types` and `purge_auxiliary` are at `src/lib/storage/redisStudyPurge.ts:5` and `src/lib/storage/redisStudyPurge.ts:26`. Add string-or-none type validation for `study-project:<id>` and delete it during accepted auxiliary purge. This reaches both `DELETE_EMPTY_STUDY_SCRIPT` (`src/lib/kv.ts:1920`, invocation at `src/lib/kv.ts:2034`) and `DELETE_POPULATED_STUDY_SCRIPT` (`src/lib/storage/redisStudyPurge.ts:99`, invocation at `src/lib/storage/redisStudyPurge.ts:161`). Preserve existing rejected-delete behavior: no membership loss before emptiness/revision/persist checks succeed. A bounded populated purge may remove membership before the final study row, but the deletion guard prevents late assignment throughout.

Redis Lua atomic execution is not rollback-on-error. **UNVERIFIED — implementation requirement:** preflight every command's key type and all untrusted records before the first write; simulate wrong-type late failures and ambiguous/lost replies. Do not claim a TypeScript catch rolls back Lua. Preserve existing no-content logging and ambiguous-vs-unavailable distinction (`src/lib/kv.ts:1634`). A corrupt index causing orphan membership cannot be repaired safely by silently treating the study as ungrouped; inventory must flag it and the affected operation must refuse.

## 4. API contracts, authorization and export

Everything in the following contract table is **UNVERIFIED — proposed**, except the cited existing helpers. All JSON responses use `Cache-Control: no-store`. Params follow the asynchronous Next route style (`src/app/api/studies/[id]/route.ts:117`). Project IDs must be server-minted UUIDs; study IDs use the current accepted study-ID alphabet/length (`cloudflare/workspace/studies.ts:21`). Request objects are closed: unknown fields, arrays, null bodies, invalid IDs/names/types are 400. Neither IDs nor timestamps may be supplied for project creation.

| Endpoint | Request | Success | Endpoint-specific failures |
| --- | --- | --- | --- |
| `GET /api/projects` | No body | 200 `{ projects: Project[], memberships: StudyProjectMembership[], studyIds: string[] }`; last field is the captured bounded roster to detect UI merge races; deterministic newest-created project order, ID tie-break | 413 `PROJECT_COLLECTION_TOO_LARGE`; 503 unavailable/held. Empty workspace is three empty arrays, not an outage fallback. |
| `POST /api/projects` | `{ name: string }`; required `Idempotency-Key` UUID | 200 `{ project: Project, replayed: boolean }`, matching existing study-create success status | 400 invalid/missing key; 409 `IDEMPOTENCY_KEY_REUSE`, `IDEMPOTENCY_KEY_CONSUMED`, `PROJECT_LIMIT_REACHED` or rare `PROJECT_ID_CONFLICT`; 503 `reason: idempotency-quota` or ambiguous/unavailable. |
| `PATCH /api/projects/[id]` | `{ name: string }` | 200 `{ project: Project }` | 404 `PROJECT_NOT_FOUND`; unavailable/ambiguous/held. |
| `DELETE /api/projects/[id]` | Empty body; reject any nonempty body | 200 `{ deleted: true }`, including repeated deletion after confirmed absence | 409 `STUDY_PERSIST_PENDING` when any affected membership is fenced; 413 collection bound; unavailable/ambiguous/held. No delete-study boolean accepted. |
| `PUT /api/studies/[id]/project` | `{ projectId: string \| null }` | 200 `{ studyId: string, projectId: string \| null }` | 404 `STUDY_NOT_FOUND` / `PROJECT_NOT_FOUND`; 409 `STUDY_PERSIST_PENDING`; unavailable/ambiguous/held. |
| `GET /api/projects/[id]/export` | No body; only Markdown in v5.3 | 200 Markdown stream and safe attachment filename | 404 `PROJECT_NOT_FOUND` / `NO_TRANSCRIPTS`; 413 `PROJECT_EXPORT_TOO_LARGE`; 409 `EXPORT_CHANGED` or existing deletion-pending refusal; 503 unavailable/held. After headers, abort without final project sentinel. |

Common failures: 401 for absent/invalid researcher session; 501 `{ error, code: 'PROJECTS_STANDALONE_ONLY', retryable: false }` for an authenticated hosted request; 400 invalid request; 413 exceeded body/collection/export bound; 503 `{ error?, retryable: true, reason: 'unavailable' | 'ambiguous' }` for storage uncertainty. Holds reuse `workspaceHeldResponse` and its existing public reason/retryability rather than inventing a second schema-hold code (`src/lib/canonicalStudy.ts:175`). Unexpected bugs use sanitized logged 500, never a fabricated success. Framework unsupported-method handling remains 405.

Only POST requires a create idempotency key, matching study creation (`src/app/api/studies/route.ts:290`). Rename and assign are absolute-value operations; delete is idempotent absence. **UNVERIFIED — proposed concurrency policy:** last successfully serialized rename/assignment wins. No expected study revision: using that as a membership concurrency token would wrongly conflate organization and collection authority. Do not automatically resend an ambiguous rename/move after another tab could have changed it; refresh and ask the researcher to repeat the desired action.

### Authentication, hosted refusal and body/CSRF parity

Use `deploymentNotReadyResponse` like study POST (`src/app/api/studies/route.ts:175`), then authenticate before reading project existence. On standalone, use `getRequestContext` and `configurationRequiredResponse`; the context selects Node or Durable (`src/lib/researcherContext.ts:132`, `src/lib/researcherContext.ts:152`). Check store readiness, with read/mutation maintenance semantics, before domain operations. Assignment also uses canonical study authority/readiness, but its decisive fence/existence checks remain inside the store transaction.

For hosted, call the identity-only `getHostedResearcherIdentity` as existing study create does (`src/app/api/studies/route.ts:183`), then return 501 before `getRequestContext`/BYOS decryption, account writes or project-key reads. Add adapter defense-in-depth via `standaloneOnly` (`src/lib/storage/redis.ts:170`) on every project method, including reads/export roster lookup. Hosted flat study APIs/sagas are not changed. Demo/unconfigured modes must not be treated as standalone-ready; preserve the deployment/context refusal.

Use `readBoundedJsonObject` (`src/lib/requestBody.ts:49`) for project JSON with the same 128 KiB envelope ceiling as study mutations (`src/lib/studyConfigValidation.ts:14`), then enforce the much smaller closed name/ID shape. This handles actual streamed bytes as well as declared Content-Length. DELETE reads up to 1 KiB with `readBoundedBytes` like study DELETE (`src/app/api/studies/[id]/route.ts:52`), accepts zero bytes including an empty stream, and rejects any nonempty body with 400 (413 if over limit).

Verified security detail: researcher context verifies the session cookie/JWT (`src/lib/researcherContext.ts:466`); researcher cookies are HttpOnly, production Secure, SameSite Strict (`src/lib/auth.ts:199`). The proxy explicitly excludes `/api` (`src/proxy.ts:42`). The inspected study POST/PUT and request-context path do not contain an explicit Origin/Referer/CSRF-token validation helper. **UNVERIFIED — deployment-wide assertion:** an edge rule outside this tree could add origin checks, but none was established here. Match the existing route/cookie policy, introduce no CORS allowlist or cookie relaxation, and do not claim mismatched Origin with a manually supplied valid cookie currently yields 403. An explicit origin rejection rule would be separate shared-route hardening, not a helper to pretend already exists. Browser cross-site-cookie behavior and exact parity need tests; owner gap is recorded in section 8.

### UNVERIFIED — proposed project Markdown composition

The existing export is `GET /api/interviews/export?studyId=...&format=markdown` (`src/app/api/interviews/export/route.ts:338`). Shared builders and the byte-bounded stream are in `src/lib/export/transcriptsMarkdown.ts:162` and `src/lib/export/transcriptsMarkdown.ts:194`. Its exact final marker is `<!-- openinterviewer-export complete: N interview(s) -->`, constructed with singular/plural handling; the checker requires it on the last line (`src/lib/export/transcriptsMarkdown.ts:17`). Node builds a bounded study file and rechecks deletion before returning (`src/app/api/interviews/export/route.ts:350`); Durable starts an export, reads bounded pages and verifies the captured snapshot before its marker (`src/app/api/interviews/export/route.ts:298`). Reuse these paths, not fetches to the public HTTP endpoint and not analysis-summary generation.

1. Authenticate and capture the project name/ID and complete member roster atomically through `projects.read`; order studies by the same newest-created/ID ordering used in listing (`cloudflare/workspace/studies.ts:227`). Validate canonical study reads; unreadable/deleting members are errors, never skipped. Total project export bound is **500 interviews across all members**, not 500 per member, reusing the current interactive ceiling (`src/app/api/interviews/export/route.ts:72`). Preflight count using authoritative store indexes/SQL, not browser counts; enforce the remaining budget again when each source is prepared and while emitting. Later additions can force a stream failure, never truncation presented as success.
2. Emit an escaped project heading, ID, export time and captured study count. For each study in roster order, concatenate its shared Markdown transcript source with a separating rule. Preserve the per-study header/body/footer bytes; no summary, sampling, provider call, or synthesis-only substitution. Study headers may remain H1 within this concatenated document. Empty member studies get a header and an explicit zero-interview section using the same builders; an entirely transcript-free project returns 404 before headers.
3. Prepare/process only one Durable study source at a time, preserving its page/backpressure/final verification. The current snapshot cache is capped at eight (`cloudflare/workspace/exports.ts:54`): preopening all member exports and holding them would evict early snapshots. Propagate cancellation/errors to the active reader. Keep the 256 KiB byte-queue approach (`src/lib/export/transcriptsMarkdown.ts:194`) and cap total Node buffered transcripts at the shared 500 ceiling. Do not buffer a project-sized string in the Worker.
4. After all member streams finish, re-read the project and full roster, require the same ID/name/membership set, and recheck every captured study's deletion/readability. A changed roster/project or deleted member means `EXPORT_CHANGED` before headers, or abort afterwards. Revalidate from canonical storage, not the UI.
5. Only then write a **new** final marker, e.g. `<!-- openinterviewer-project-export complete: S studies; I interviews -->`. New `hasProjectTranscriptsCompleteMarker` accepts only that marker as the final line and validates the declared counts against the generated manifest/header contract. Never use `hasTranscriptsCompleteMarker` on the concatenated file: a cut immediately after the first study's real marker would otherwise pass. The client downloads only after receiving and validating the whole file, following the current checked-download approach (`src/services/storageService.ts:332`). Participant content cannot forge a marker because the shared writer blockquotes every line (`src/lib/export/transcriptsMarkdown.ts:37`); project/study names are inline-escaped (`src/lib/export/transcriptsMarkdown.ts:29`).

**UNVERIFIED — proposed consistency promise:** this is a checked concatenation of per-study snapshots, not a single cross-study point-in-time database snapshot. The roster is captured and checked again, and each study has the current backend's export guarantees; a new interview added after that study's snapshot may be absent. Existing Durable snapshots deliberately tolerate new interviews/analysis changes outside the captured content (`cloudflare/workspace/exports.ts:4`), so a global mutation-sequence comparison must not be presented as its current behavior. An earlier study's snapshot is not retained/reverified after every later study. If the owner requires one instant for all projects/studies, expand the export protocol with a single bounded project snapshot; do not quietly claim that stronger guarantee from this reuse design.

## 5. Tests by layer

All entries here are **UNVERIFIED — proposed tests**, not passing results. New files are explicitly marked. Existing anchors identify suites actually inspected. Use synthetic data, disposable Redis and local workerd only; no production secrets/database/provider calls.

### Node versus Durable parity

Extend `tests/contract/workspaceStoreScenarios.ts:47` with the shared project scenarios. Its existing two runners are `tests/integration/workspaceStore.redis.contract.test.ts:10` and `tests/workers/contract.durable.test.ts:10`; add required project-port fixture wiring there only as needed, without backend-specific behavior in shared assertions. Both must cover:

- Empty list; create/list/read; rename; allowed duplicate names; Unicode; deterministic order and index completeness; size-limit refusal, never a partial list.
- Same key/same intent returns one project; changed intent conflicts; create then rename replay does not revert rename; delete then create replay is consumed; receipts expire and quotas match.
- Assign → move → unassign; no-op commands; missing study/project; destination deleted concurrently; corrupted records fail closed where each backend can inject them.
- Project deletion ungroups multiple empty/populated/locked studies, preserves interviews/analysis/links/consent, preserves other projects, and repeated deletion succeeds.
- Study deletion removes only its membership. Refused empty-only/revision-mismatched study deletion preserves membership. Sample clear removes only deleted fixture memberships and leaves the project.
- Compare study config/revision/timestamps and participant-link bytes before/after all project actions; establish consent and continue/save through the original participant link after moves and project deletion. No new provider calls attributable to grouping.
- Concurrent assignments and delete/assign races linearize: no resurrected project or dangling membership. In Durable, completion serializes normally; Redis's transient persist-guard refusal is tested in the Redis-specific layer rather than requiring a fabricated equivalent Durable window.
- Store project operations on a hosted Redis adapter throw/refuse before any Redis command, including list and read.

### Redis real-wire and fault tests

Extend `tests/integration/redis.researcherControl.test.ts:1` (already in `test:researcher:redis`, `package.json:36`) for assignment/project deletion with active `study-persisting`, in-flight deletion, malformed `oi:smg`, wrong-type membership/index/receipt keys, and both bare/prefixed study JSON. Assert byte-for-byte unchanged study values. Use the existing disposable Redis boundary, not a mocked Lua result.

Extend `tests/integration/redis.crashCuts.test.ts:515` and `tests/helpers/faultManifest.ts:21` for membership cleanup in the existing study purge crash cuts, including the aggregate-removal cut at `tests/integration/redis.crashCuts.test.ts:581`. Include cuts before/after accepted auxiliary purge, retry completion, and a lost project-create reply replayed with the same key. Do not describe fault-injected Redis script errors as transaction rollback. Test guard-first no-op assignment and all-members-preflight project deletion (one guarded member causes zero ungrouping).

Extend `tests/integration/inventoryRedis.test.ts:1`: healthy projects/membership/receipt families; missing primary/index targets; missing study/project membership targets; malformed IDs/encoding/receipts; wrong types; oversize projection marked incomplete; no names/content in the report; database unchanged after inventory. Include the metadata key even when no live project remains.

### Workers / SQLite

Add **new** `tests/workers/projects.test.ts` for actual SQL constraints, transactions, project CRUD/membership, mutation sequence no-op behavior, maintenance/epoch/identity holds, receipt cleanup/alarm durability and delete/complete interleavings. Query all existing study columns to prove no mutation. Failure between project-delete SQL statements must roll back project, memberships and sequence together.

Extend `tests/workers/schema.migrations.test.ts:77`: fresh 0→3; actual 1→2→3 and 2→3 preserving existing study/analysis/notebook data; exact unchanged study column list; interrupted migration 3 leaves neither its first table nor ledger row; rerun succeeds; checksum/gap refusal remains. Use `MIGRATIONS.slice(0, 2)` as a runner-level old-reader test after actual migration 3 and require `newer-incompatible`, not synthetic-only compatibility. Keep the generic additive-N test distinct (`tests/workers/schema.migrations.test.ts:129`). Actual old-binary rehearsal belongs below.

Extend `tests/workers/backup.test.ts:176`: live-schema/backup-column coverage includes both new tables; format-3 round trip, v2/schema2 import leaves both empty, v1/schema1 import leaves notebooks/projects/memberships empty; duplicate membership identity and dangling parent references rejected; rejected import remains held; receipt replay/delete state preserved; watermark changes from project mutations detected. Preserve rotated-epoch, duplicate-chunk and finalization tests (`tests/workers/backup.test.ts:321`, `tests/workers/backup.test.ts:378`).

Extend `tests/workers/studies.test.ts:200` and `tests/workers/exports.test.ts:168` for membership cascade and existing export guarantees; put sample-clear membership assertions in the new projects suite, which calls the actual fixture-clear RPC. Update `tests/workers/jobFixtures.ts:111` reset table list with `study_projects` and `projects` so new persistent rows cannot contaminate subsequent cases. Inspect other local reset lists during implementation instead of assuming this is the only one.

### Unit/component/API tests

| File | Required coverage |
| --- | --- |
| **New** `tests/unit/projects.validation.test.ts` | Closed inputs, Unicode/control/whitespace limits, safe timestamps, forged IDs and malformed wire payloads. |
| **New** `tests/unit/api.projects.test.ts` | Every contract/status above; unauthenticated refusal; authenticated hosted 501 before BYOS or keys; deployment/maintenance/schema holds; bodyless DELETE across null/empty stream; actual streamed oversize body; invalid idempotency key; replay/consumed/ambiguous outcomes. |
| **New** `tests/unit/api.study.project.test.ts` | Store-bound fences cannot be bypassed by a prior read; no calls to study replacement/link mutation; missing/destination/guard/ambiguous mappings. |
| **New** `tests/unit/storage.projects.test.ts` | Redis closed result parsing and Durable RPC payload/status/identity validation, missing/old RPC behavior, uncertain commits, no hosted fallback. |
| `tests/unit/StudyList.register.test.tsx:59` | Keep row navigation and responsive register tests; grouping, empty project/Ungrouped, collapsed focus, menus/rename/delete, move/unassign, failed load not treated as ungrouped, hosted no project calls. |
| **New** `tests/unit/StudySetup.project.test.tsx` | Project target separate from config; two-step create, assignment failure, reload/pending receipt, switching project intent, duplicate/follow-up, no duplicate study after ambiguous assignment. |
| `tests/unit/studyDraftSession.test.ts:22` | Extend intent-key and pending-assignment lifecycle alongside the changed helper. |
| **New** `tests/unit/api.projects.export.test.ts` | Shared source bytes, correct order/headers, empty members, all-empty/oversize refusal, later source failure, roster change/deletion, backpressure/cancellation, total count enforcement. |
| `tests/unit/api.export.markdown.test.ts:192` | Preserve current Node/Durable equal-byte per-study export after extraction, including changed-snapshot refusal. |
| **New** `tests/unit/projectService.test.ts` | Stable create key on explicit retry; 501 not rendered as empty; no download when cut at a legitimate inner study marker; forged marker in participant/name text; only final project sentinel accepted. |
| `tests/unit/backupFormat.test.ts:82` | Format 1/2/3 matrices, old authentic fixtures, exact family sets/order, closed columns, original checksum verification, invalid format/schema pair, unsupported future version, missing/truncated manifest/trailer. Preserve import-free plain-Node loading (`tests/unit/backupFormat.test.ts:250`). |

CSRF parity tests must assert observed policy: cookie attributes and lack of cross-origin browser credentials; do not invent a route-level Origin rejection expectation. If shared explicit Origin enforcement is approved later, test it across old and new mutation routes together.

### Browser E2E on both targets

Add **new** `tests/e2e/projects.spec.ts` and **new** `tests/e2e-cloudflare/projects.spec.ts`, following real-handler workflow patterns at `tests/e2e/research-workflow.spec.ts:42` and `tests/e2e-cloudflare/research-workflow.spec.ts:60`. Use the Node workflow fixture and built Cloudflare artifact respectively, not internal API mocks. The existing Cloudflare study-list regression is at `tests/e2e-cloudflare/study-list.spec.ts:12`.

Both journeys: sign in; create two projects and one ungrouped study; use + Study; reload; rename/collapse/expand; move populated study; delete project and verify study remains; reopen the original participant link and complete an interview; download project Markdown and verify all expected study/interview IDs plus final marker; delete a member study and ensure no dangling UI membership. Cover keyboard-only and 375px viewport. Simulate assignment failure only at the storage/external fixture boundary, verify saved study remains and retry does not POST another study. Count synthetic provider requests so grouping/export creates none. Add a truncated-project-response client test at a stream boundary, specifically cutting immediately after an inner study footer.

Hosted refusal is mandatory API/component coverage; **UNVERIFIED:** a fully authenticated hosted browser harness was not established by this inspection. Do not claim the standalone Node browser lane proves hosted identity isolation. Retain the hosted build and shared-BYOS adversarial lanes.

### Artifact, restart and operator tooling

Extend `tests/cloudflare-artifact/journeys.artifact.test.ts:1` with project CRUD/export/hosted-config refusal at the real artifact boundary. Extend `tests/cloudflare-restart/committed.restart.test.ts:1` with create/assign/ungroup persistence across process kill and restart. Add **new** `tests/cloudflare-restart/projects-schema.restart.test.ts` for a saved 5.2 artifact → 5.3 migration → 5.2 refusal → 5.3 recovery rehearsal using a runner-owned state directory, pending and completed jobs, zero provider dispatch under refusal, and unchanged data afterward. The runner currently fixes one artifact directory (`tests/cloudflare-restart/runner.mjs:55`) and exposes only artifact/txprobe selection (`tests/cloudflare-restart/lane.ts:74`); extend those two files with test-owned explicit artifact selection. **UNVERIFIED prerequisite:** a retained, provenance-checked 5.2 artifact must be supplied to the rehearsal; this task did not build or retrieve one. Record artifact hashes; never use a production namespace. A sliced migration-list unit test alone is not evidence that an old bundled Worker refused.

Extend `tests/setup-cloudflare/operator.test.mjs:1` with CLI format-3 export/validate/import, legacy v2 fixture, no content in diagnostics, and manifest/schema metadata. Adjust fake schema fixtures, not format-2 bytes used as compatibility evidence. Preserve the clean-checkout/build behavior tested at `tests/setup-cloudflare/release-scripts.test.mjs:44` and `tests/setup-cloudflare/release-scripts.test.mjs:106`; no project-specific edit to that suite is planned. No broad snapshot rewrite.

## 6. Backup, restore and inventory changes

### Verified baseline and exact format changes

The format module is deliberately import-free so both Node CLI and Durable can load it (`src/lib/backup/format.ts:17`). Current version is 2 (`src/lib/backup/format.ts:20`); rows have a closed column set (`src/lib/backup/format.ts:198`); manifest types accept 1 or current version (`src/lib/backup/format.ts:221`). Validation currently accepts only 1/current and computes the v1 family count as `BACKUP_FAMILIES.length - 1` (`src/lib/backup/format.ts:425`). That arithmetic must not survive appending two more families.

**UNVERIFIED — proposed exact changes:**

- Set `BACKUP_FORMAT_VERSION = 3`; manifest type explicitly accepts `1 | 2 | 3`.
- Append `projects` keyed by `id`, columns `id:text`, `name:text`, `created_at:integer`, `updated_at:integer`, all non-null; append `study_projects` keyed by `study_id`, columns `study_id:text`, `project_id:text`, non-null. Append after all existing v2 families; project parent precedes membership. Do not reorder or extend any existing row family's columns.
- Add a **new** explicit family-set selector: v1 = the exact released family list without exploration; v2 = the exact released list including exploration; v3 = v2 plus projects and membership. Use it in manifest validation, writer version constraints and reader unsupported-format classification (`src/lib/backup/format.ts:534`). Do not use `length - 1` or treat arbitrary omissions as old format.
- Accept only the known truthful format/schema pairs in this release: (1,1), (2,2), (3,3). A schema-3 manifest labelled format 2 is invalid because it could hide projects. Future formats/schemas are refused rather than coerced. Export writer always emits (3,3) from the upgraded object.
- Preserve canonical JSON/chunk/trailer checksum logic (`src/lib/backup/format.ts:150`, `src/lib/backup/format.ts:168`). Validate old bytes against their original manifest; do not add synthetic empty descriptors before hashing. Missing row families become empty target expectations only after validating the authentic legacy manifest.

### UNVERIFIED — proposed import matrix and domain integrity

| Source | Target running 5.3/schema3 | Treatment |
| --- | --- | --- |
| format1/schema1 | Accept into empty recovery target | Existing v1 families imported; exploration/project/membership families empty. |
| format2/schema2 | Accept into empty recovery target | Existing v2 families unchanged; projects and membership empty. |
| format3/schema3 | Accept into empty recovery target | Import all row families exactly, including projects, memberships and project-create receipts. |
| format2/schema3, format1/schema2/3, unknown future pair | Refuse | Never omit known authoritative row families. |

Change both operator version check and schema compatibility check at `cloudflare/workspace/operator.ts:648` and `cloudflare/workspace/operator.ts:653`; current code has only a special (1,1)→schema2 exception. Target emptiness already loops every backup family (`cloudflare/workspace/operator.ts:539`), so appending families makes preexisting project data block import automatically. Finalization already defaults missing families to zero (`cloudflare/workspace/operator.ts:614`); update its comment and limit this allowance to a validated legacy family set. Reject unexpected chunks for absent legacy families and require actual target counts zero. Do not import or forge a source schema ledger: the target's own migrations have already created schema3.

Extend `rowIdentityValid` (`cloudflare/workspace/operator.ts:566`) for project IDs/name/time semantics and membership IDs. Extend `REFERENCE_CHECKS` (`cloudflare/workspace/operator.ts:599`) with membership → study and membership → project anti-joins. Verify duplicate `study_id` rejection, no membership referring to a fenced/deleted study, and valid `project-create` receipt payloads/dispositions without imposing a live-project requirement on consumed receipts. SQL type checks alone are not domain validation. Keep all imports in recovery, count/checksum/reference finalization, epoch rotation and activation protocol intact (`cloudflare/workspace/operator.ts:639`). A failed import cannot open service or silently prune dangling rows.

The CLI consumes shared family/schema metadata (`scripts/cloudflare/operator.mjs:639`, `scripts/cloudflare/operator.mjs:649`), so no separate handwritten projects exporter is proposed. **UNVERIFIED:** full CLI execution with new families still needs the operator tests; inspect any remaining schema/format literals before concluding zero script edits. Project writes must advance `mutation_seq` so frozen-backup watermarks detect them. Export snapshots remain non-authoritative bookkeeping, not backup row families (`cloudflare/workspace/exports.ts:18`).

### UNVERIFIED — proposed Redis inventory details

Add families to `FAMILIES` (`scripts/cloudflare/inventory-redis.mjs:439`): project primaries/string, `all-projects`/set, membership/string, project-create-receipts/hash. Add corresponding bounded Lua metadata projections near the existing study/index/receipt cases (`scripts/cloudflare/inventory-redis.mjs:210`, `scripts/cloudflare/inventory-redis.mjs:342`, `scripts/cloudflare/inventory-redis.mjs:376`). Report counts, type/encoding/identity faults, project index missing primary, primary not indexed, membership missing study/project, invalid receipt identity/state/expiry and projection-over-bound. Never return project names, transcript/config content, raw idempotency keys or credentials.

Extend record/collection statistics, orphan counters, incomplete reasons and research-data totals (`scripts/cloudflare/inventory-redis.mjs:693`, `scripts/cloudflare/inventory-redis.mjs:1327`, `scripts/cloudflare/inventory-redis.mjs:1360`, `scripts/cloudflare/inventory-redis.mjs:1400`). A workspace holding only projects is not “no research data”; malformed new families make coverage incomplete. Inventory remains read-only and metadata-only. It is not a Redis→Durable migration tool and must not imply a new automatic cross-target restore path. Redis keys are not imported by the SQLite backup format; a future cross-target converter is out of scope.

## 7. Release-check lanes and delivery sequence

Verified commands are in `package.json:18`. The combined matrix is explicit in `scripts/cloudflare/check.mjs:48`; it includes both Node builds/browsers and Cloudflare runtime/artifact/browser/restart lanes. It requires a clean checkout (`scripts/cloudflare/check.mjs:75`) and only a full run yields a passing receipt (`scripts/cloudflare/check.mjs:122`). This design task must not run that mutating/build matrix or commit this file to satisfy its prerequisite.

**UNVERIFIED — proposed implementation/release sequence:**

1. Implement pure domain/port and storage operations; add focused shared-parity, Redis fence and Workers transaction tests. Add migration/backup compatibility fixtures before changing UI.
2. Add hosted refusal and API routes; integrate UI and shared Markdown source/composer; preserve existing study-export tests. Add Node and Cloudflare browser journeys.
3. Run focused tests, then owner-approved full matrix below on a clean implementation commit. This design does not authorize Git writes or deployment.

| Existing lane/command | What it must exercise for projects |
| --- | --- |
| `npm run check` | Lint/typecheck, new API/domain/component/client/backup unit tests, all required store fixtures. |
| `npm run test:contract:redis` | Shared projects scenarios through real Redis and production adapter (`package.json:34`). |
| `npm run test:researcher:redis` | Added completion/deletion fences and purge-membership regressions in existing selected suite (`package.json:36`). |
| `npm run test:redis-crash` | Changed purge crash-cut/replay behavior (`package.json:29`). |
| `npm run test:inventory:redis` | New metadata-only key families/health counters (`package.json:35`). |
| `npm run test:adversarial` | Existing hosted/shared-BYOS regression, alongside new explicit projects refusal unit tests (`package.json:30`). |
| `npm run test:cloudflare` | Shared parity, projects, migration 3, backup v1/v2/v3, alarm and maintenance tests (`package.json:33`). |
| `node scripts/cloudflare/check-import-boundary.mjs` | New Durable/pure-project graph cannot reach Next/Redis/hosted modules (`scripts/cloudflare/check.mjs:57`). |
| `npm run test:setup`, `npm run test:setup:cloudflare` | Setup stays unchanged; operator/format/version/fixture compatibility (`scripts/cloudflare/check.mjs:50`). |
| Node standalone-direct, Node Gateway, Node hosted builds | Existing safe fixture environments (`scripts/cloudflare/check.mjs:24`); projects compile for both standalone modes and stay refused on hosted. |
| `npm run test:e2e` | New Node grouped-project browser journey and existing participant/researcher workflows. |
| `npm run build:cloudflare` then `npm run test:cloudflare:artifact` | Real packaged routes/store/export and automatic schema.current=3 metadata. |
| `npm run test:cloudflare:restart` | New persistent project state and old-artifact refusal rehearsal. Ensure the newly proposed test/harness extension is actually selected by this lane. |
| `npm run test:e2e:cloudflare` | New grouped-project browser journey on the built artifact. |
| `npm run check:cloudflare` | One final full artifact-bound receipt, including audit-production, audit-toolchain and diff-check lanes already required (`scripts/cloudflare/check.mjs:52`). |

CI already selects Redis researcher lifecycle (`.github/workflows/ci.yml:180`), Cloudflare artifact/restart/browser (`.github/workflows/ci.yml:254`) and the full release check before deployment (`.github/workflows/ci.yml:306`). Discovery is explicit: unit glob at `vitest.config.mts:10`, workers at `vitest.workers.config.mts:16`, artifact at `vitest.artifact.config.mts:11`, restart at `vitest.restart.config.mts:12`, and Cloudflare browser directory at `playwright.cloudflare.config.ts:10` cover the proposed names. Node direct discovers the E2E directory (`playwright.config.ts:7`), but Gateway currently selects only research-workflow (`playwright.config.ts:31`): extend that testMatch for projects. Redis scripts use positional suite filters (`package.json:29`); the new Redis assertions are placed in their existing selected files. Verify discovered test lists before the full run; none of the proposed tests exists or has run yet. No paid provider smoke is needed for grouping/export-only changes: no adapter/SDK/provenance contract is changed. All required project verification is credential-free.

Release evidence should include current commit/artifact hashes, schema ledger and min-reader result, backup compatibility fixture outcomes, old-binary refusal/recovery result, focused regressions and the final full-matrix receipt. No production-data screenshots or project names in evidence logs.

## 8. Risks and owner open questions

These are **UNVERIFIED — proposed decisions or evidence gaps**; conservative defaults are already specified so routine implementation does not block on questions.

1. **CSRF/Origin premise differs from inspected code.** Existing study routes establish cookie/session security, not an explicit Origin guard. Default is exact policy parity. If an Origin/Fetch-Metadata defense is required, scope it across study and project mutations and verify reverse-proxy/APP_BASE_URL behavior; do not invent a projects-only helper or silently represent it as existing protection.
2. **Two-step + Study.** Default reuses current study POST then membership PUT, with durable-in-browser pending assignment and honest partial-success UI. This avoids a new cross-operation storage protocol but is not atomic creation-in-project. If the owner requires all-or-nothing, separately extend create inputs/fingerprint/receipt and both stores' create transactions; that is additional work, not covered by falsely reporting the two-step flow as atomic.
3. **Export consistency.** Default is per-study snapshot concatenation, bounded to 500 total interviews, with roster recheck and distinct final marker. It is not a global point-in-time snapshot and does not retain every earlier study's validation token. A stronger guarantee needs new export protocol/snapshot storage and parity design. Empty studies are included, entirely empty projects return 404.
4. **Redis deletion bound.** Without a reverse membership index, bounded `all-studies` enumeration is necessary. Default refuses above 1,000 rather than making an unbounded Lua call; over-limit operators can still unassign individual studies but need an explicit maintenance path to clean a very large workspace. Benchmark the bounded worst case with synthetic data. If real expected scale exceeds this, approve an indexed/resumable deletion protocol and inventory family before coding it.
5. **Corrupt indexes.** Normal writes maintain indices atomically, but old manual edits or rollback can break them. No silent repair or orphan-to-Ungrouped conversion. Inventory must identify coverage gaps; project operations refuse unverifiable state. Administrative repair is not part of researcher CRUD.
6. **Forward-only deployment.** Schema3 refusal is required, not a failure to relax after deploy. Drain/freeze/backup first; old Worker/DO version overlap may briefly hold traffic. Actual old-artifact behavior is UNVERIFIED until the restart rehearsal passes. Node rollback has no retrospective binary guard; document its prohibition separately.
7. **Backup compatibility.** Keep real v1/v2 fixtures unchanged; replacing all version numbers in tests would erase evidence. Format/schema truthfulness and absent-family zero checks are release blockers. Check imported project receipts carefully so deleting a restored project cannot permit a replay to resurrect it.
8. **Concurrent UI edits.** Default last-writer-wins assignment/rename, no study revision CAS. If stale-tab overwrite protection is desired, add a project/membership-specific version token, not a study revision bump. That would change proposed rows/wire contracts and needs its own review before migration 3 is released.
9. **Limits and naming.** Default duplicate names permitted, 200-code-unit normalized display name, 1,000 interactive projects/studies, 100 live create receipts, seven-day horizon. These are proposed product limits requiring validation against owner expectations, not existing guarantees. After the receipt horizon, retrying an old create key can create a new project; UI retires completed intent keys.
10. **Hosted later is not a flag flip.** Future hosted projects need researcher ownership, shared-BYOS namespace isolation, project lifecycle/ownership recovery, cross-database create/delete semantics and quota design. Do not add an unscoped `all-projects` to a hosted client now or infer tenancy from study IDs supplied by the browser.
11. **Test/harness completeness.** Secondary reset/typed mock sites remain to be enumerated by implementation typechecking; multi-artifact restart support is a known required extension, not an existing capability. Resolve those details during implementation and record newly discovered fixture files in the implementation diff. No passing test/build/production claims are made by this document.

