# Redis → Cloudflare — operational importer design

Baseline: `9d573aa1e61feade20cb20cce38815a40f89a40d`, tag `v5.4.0`, branch `docs/redis-importer-design`, inspected 2026-10-10. This is a build plan, not an implemented importer or compatibility certificate. No source database, credentials, provider, or deployment was accessed. Only this document and `CHANGES-redis-importer.md` were added.

Evidence convention: repository-relative paths and named symbols identify code read at this baseline; historical claims identify tags/commits actually inspected. All importer behavior, new files, flags, policies, estimates and tests below are **PROPOSED / UNVERIFIED**, unless explicitly described as existing. Compatibility requires the release-generated fixtures and staging rehearsal in §8. The structure follows `docs/design/projects-5.3-design.md`, but implementation facts take precedence over that earlier proposal; its owner amendments are in `docs/design/projects-5.3-decisions.md`.

## 1. Scope, binding constraints and implementation shape

### Outcome

Move research data from one fenced **standalone** Node/Vercel Upstash database to an empty Cloudflare installation, without writing to Redis or making a provider request. Produce an ordinary operational backup directory accepted by the **unchanged** `npm run operator:cloudflare -- backup import --in <directory> --origin <destination>` command. Import, activation and opening the destination remain separate operator actions.

This is not hosted/BYOS consolidation, replication, an application upgrade, a transcript reformatter, a source repair tool, or a redirect service. Detect evidence of hosted ownership and refuse this profile; an assertion that a database is standalone cannot override contradictory records. An arbitrary fork is not automatically compatible with its claimed upstream version.

### Existing contract discrepancies to resolve explicitly

1. `docs/operations/cloudflare-migration/TRANSITION.md` §8 says current format v2. Executable truth is **format 3 / schema 3**: `src/lib/backup/format.ts` (`BACKUP_FORMAT_VERSION`, `isValidBackupManifest`), `cloudflare/workspace/schema.ts` migration 3, and `cloudflare/workspace/operator.ts` (`importBackupChunk`). Released pairs 1/1 and 2/2 remain readable; mixed pairs do not. The format file and operator CLI also have stale introductory version comments. This design emits only 3/3.
2. `IMPLEMENTATION.md` §7/F7 calls for generation-0 synthetic terminal **jobs**. `schema.ts` requires `analysis_jobs.generation >= 1`, while `analysis.current_generation >= 0`. Literal F7 jobs cannot import unchanged. Proposed resolution: generation-0 **analysis rows**, no synthetic jobs (§5). This preserves F7's visible state and attempts without inventing paid executions. Obtain the owner's ruling before implementing; do not quietly weaken the schema.
3. Inventory is not a content exporter. `scripts/cloudflare/inventory-redis.mjs` returns metadata-only projections and binds `EVAL_RO` to exactly `PROJECTION_SCRIPT`. Reuse its classification, bounded traversal and command-denial principles, not its projection as a source of transcripts. Its current `FAMILIES` omits `researcher-ai:` even though `src/lib/storage/redis.ts` and `types.ts` write those keys. Account for that discrepancy rather than treating them as fork data.

### Proposed file manifest

| File | Responsibility |
| --- | --- |
| New `scripts/cloudflare/import-redis.mjs` | CLI; stdin credentials; explicit source profile, fence evidence, dry-run, decisions and private output; no destination calls. |
| New `scripts/cloudflare/redis-import/read.mjs` | Read-only executor, complete SCAN passes, expiry capture, byte/member budgets, stable capture and private spool. |
| New `scripts/cloudflare/redis-import/profiles.mjs` | Versioned family/encoding/field registries for the inspected releases; unknown-field accounting before parsing can discard anything. |
| New `src/lib/backup/redisMapping.ts` | Pure decoded-record → rows/dispositions functions, injected snapshot time and deterministic identity; no Next, Redis, Worker or provider imports. |
| New `scripts/cloudflare/redis-import/plan.mjs` | Reference graph, pending-operation resolution, exclusions, decision digest and counts-only report. |
| New `scripts/cloudflare/redis-import/write.mjs` | Canonical ordering/chunking, private atomic publication, `BackupWriter`/`BackupValidator`, directory compatibility. |
| `scripts/cloudflare/inventory-redis.mjs` | Add the missing researcher budget classification; only extract narrowly reusable read transport/traversal if needed. Do not let inventory start returning content. |
| `src/lib/studyConfigValidation.ts` and a small new portable validator module, if needed | Mechanical extraction of pure config validation from its HTTP body-reader import; preserve behavior and test it. Node type stripping cannot resolve the current `@/` runtime imports unaided. Either package the CLI with an explicit build or make its pure import graph Node-loadable; choose and test one, not a new implicit runtime dependency. |
| `package.json` | Add `import:redis` and focused test script(s); lockfile only if a dependency genuinely changes. |
| `TRANSITION.md`, `IMPLEMENTATION.md`, `RUNBOOK.md`, `evidence/DEVIATIONS.md` | Update v3 contract, resolved F7 wording, operation/exclusion policy and tested runbook when implementation exists. |

No new backup family, SQL migration, destination import endpoint, provider adapter, participant path, or UI is required by the preferred design. Existing validators at the backup boundary are necessary but insufficient: they check column shapes and selected identities/references, not every domain invariant (`operator.ts: rowIdentityValid`, `REFERENCE_CHECKS`). The importer must preflight what the application will subsequently read.

The optional pure-function skeleton is deliberately omitted from this delivery: release codecs, unknown-field accounting and the F7 conflict should be settled together; a few happy-path object conversions would not establish compatibility.

## 2. Source releases and actual Redis layouts

### Compatibility policy and history evidence

Proposed initial supported source tags are exactly those below, in standalone mode. “Supported” means a planned tested profile, **not a test result in this document**. Require `--source-release <tag>` plus the deployed commit/fork identity in the private migration plan. There is no inspected database-level release marker that establishes these versions; mixed-age records survive upgrades. Recognize the supported older shapes within each later profile, but refuse unexplained newer families or fields. Before v4.0.0, untagged intermediates, newer releases and forks require a separately reviewed profile.

History inspected: `git log --oneline -- src/lib/storage`; diffs of `src/types.ts`, `kv.ts`, links, consents, and create idempotency across `v4.0.0`, `v4.2.0`, `v5.0.0` and later tags; tag-to-file blob comparisons for the Redis modules. Blob equality establishes source equality only, not behavior of a deployed fork.

| Tags / release commits | Redis record and behavior boundary |
| --- | --- |
| `v4.0.0` `c82d588`; `v4.1.0` `a355005`; `v4.1.1` `e0eafc5` | Same inspected `kv.ts`, `participantLinks.ts`, `participantConsent.ts`, `createIdempotency.ts`, `storage/redis.ts`, and `types.ts` blobs. Studies, immutable saved interview content plus inline analysis, stored aggregates, revision-bound opaque links, consent, completion fingerprints/guards, study-operation receipts/guards, create receipts and admission keys already exist. No exploration/project modules. |
| `v4.2.0` `c297750` | Same core `kv.ts`/link/consent/create-record blobs as v4.0. `7078df8` adds `StudyConfig.aiProviderCommitment` and `StoredInterview.providerCommitment`; absence remains meaningful. `d8e9e79` adds `researcher-ai:` budgets; `0b1f148` adds Node sign-in counters under `rate-limit:login:*`. No notebook/projects. |
| `v5.0.0` `fde1bba`; `v5.0.1` `fc0ef67` | `9ed5864` introduces `redisExploration.ts`, `redisStudyPurge.ts`, the four notebook families, study-scoped link/consent cleanup indexes, `StoredInterview.collectionConfig`, and aggregate `scope`. Populated deletion can be partially purged under a guard; guard adds optional `deleteInterviews: true`/`expectedRevision`. Deleted create receipts now permit `study: null`; older deleted receipts can retain their original study. Pause no longer increments revision, and no-op config saves do not increment it. Do not recompute historical revisions. Both tags have identical inspected core storage/type blobs. |
| `v5.1.0` `e4063d7`; `v5.2.0` `1ee54c5`; `v5.2.1` `42dfb28` | Same inspected research-record storage blobs as v5.0. `b2f6374` adds `interviewLanguages`, consent/thank-you translations and saved `interviewLanguage`; `647d38f` adds `voiceInput` (`off`, `installation`, `browser`). The `src/types.ts` blob is identical across these three tags. No new research key family for language or voice; do not invent audio records. |
| `v5.3.0` `f3eb006` | `34ad68e` adds `project:<id>`, `all-projects`, `study-project:<studyId>` and backup/schema 3; purge removes memberships. `d2f1642` tightens project-name handling (controls and lone surrogates). No project-create receipt family: see the actual `redisProjects.ts`, `projects/types.ts` and owner decision 1, not the earlier projects proposal. |
| `v5.4.0` `9d573aa` | Same inspected Redis storage blobs as v5.3. `749bd52` extends `voiceInput` with `device`; no Redis family change. |

### Closed family/encoding registry

These names are grounded in `kv.ts`, `participantLinks.ts`, `participantConsent.ts`, `createIdempotency.ts`, `storage/redisExploration.ts`, `storage/redisProjects.ts`, `storage/redisLoginBudget.ts`, and inventory's `FAMILIES`. Suffixes below are placeholders, never values to print.

| Family | Redis type and payload | First profile / disposition |
| --- | --- | --- |
| `study:<id>` | STRING; raw JSON `StoredStudy` or `oi:study:` + JSON. `saveStudy` uses bare JSON; atomic create uses prefix. | All; `studies`. |
| `interview:<id>` | STRING; bare JSON from `saveInterview`, or `oi:interview:` + JSON from completion. | All; `interviews` plus analysis. |
| `study-aggregate:<studyId>` | STRING, `oi:aggregate:` + `StoredAggregateSynthesis`. | All; `aggregates`; a bare aggregate is not assumed supported. |
| `participant-link:<digest>` | STRING; bare version-1 JSON for standalone creation; parser also accepts `oi:link:` JSON. | All; `participant_links`. Non-null `researcherId` contradicts standalone. |
| `participant-consent:<sessionDigest>` | STRING, bare version-1 JSON. | All; `consents`. |
| `interview-fingerprint:<id>` | STRING, `oi:fp:` + hex digest. | All; interview fingerprint. A bare digest is a compatibility anomaly, not silently accepted. |
| `interview-persisting:<id>` | STRING, `oi:pguard:` + version-2 guard. | All; resolve P1/Finish, never copy a job. |
| `study-operation-result:<markerId>` | STRING, `oi:receipt:` + version-2 operation receipt. | All; resolve creation/deletion. |
| `study-mutation-guard:<studyId>` | STRING, `oi:smg:` + version-2 guard. | All; resolve lifecycle before accepting children. |
| `all-studies`, `all-interviews`, `study-interviews:<studyId>`, `study-persisting:<studyId>` | SETs of IDs. | All; reconcile against complete primary-key scan, not authoritative enumeration alone. |
| `participant-link-index:none` | SET of link IDs; inventory also recognizes the `participant-link-index:` and `participant-links:` prefix families. | All; standalone index is `:none` (`researcherLinkIndexKey`). Do not label arbitrary other suffixes as standalone without review. |
| `create-idemp:<digest>`, `create-idemp-index:standalone` | STRING `oi:idemp:` version-2 record; ZSET index. | All; translate resolved replay authority (§6). |
| `rate-limit:*`, `interview-rate:*` | STRING counters; ZSET save-admission membership respectively. | All; operational exclusions, counted/acknowledged. Login subtype is present from v4.2. |
| `researcher-ai:<operation>:session:<windowSeconds>:<subject>` and `researcher-ai:<operation>:researcher:<windowSeconds>:workspace` | STRING counters; see `researcherAiBudget.ts` and `redis.ts: admitResearcherAiRequest`. | v4.2+; same operational-exclusion policy, add inventory coverage. |
| `study-link-index:<studyId>`, `study-consent-index:<studyId>` | SET of link IDs; SET of full consent keys respectively. | v5.0+; cleanup/reference indexes, not new research rows. |
| `study-exploration:<studyId>:<answerId>` | STRING `oi:exploration:` + `ExplorationAnswer`. | v5.0+; `exploration_answers`. |
| `study-exploration-index:<studyId>`, `study-exploration-order:<studyId>` | SET answer IDs; ZSET IDs scored by creation time. | v5.0+; verify and replace with destination SQL indexing. |
| `study-exploration-keys:<studyId>` | HASH, field = request key digest; value = `oi:exploration-key:` JSON `{id, fingerprint}`. | v5.0+; **translate to receipts**, not discard. |
| `project:<id>`, `all-projects`, `study-project:<studyId>` | STRING `oi:project:` JSON `{id,name,createdAt,updatedAt}`; SET project IDs; STRING raw project UUID. | v5.3+; `projects` / `study_projects`, reconcile index. |

Raw REST bytes must be decoded explicitly: do not rely on Upstash SDK auto-deserialization, coerce stringified numbers, recursively parse arbitrary strings, or use application list/get functions that hide corrupt/unindexed records. Treat each envelope and nested object as untrusted input. Inspect unknown members before calling parsers that select fields. Versioned allowed-field tables include optional legacy absences, not arbitrary extensions.

## 3. Read-only capture, fencing and determinism

### Required operator evidence

Require a migration plan containing source storage digest, profile/deployed commit, fixed `snapshotAt` (integer epoch ms chosen for the capture), importer version, fence evidence references and disposition decisions. Credentials arrive separately by no-echo prompt or stdin JSON with the inventory's `KV_REST_API_URL` and `KV_REST_API_READ_ONLY_TOKEN` names. Never put them in arguments, output or the plan. Reuse inventory's URL checks and bounded request/error handling. The production CLI accepts only the Read Only token field; no Standard-token fallback, even if inventory permits one.

Proposed CLI examples (not commands available in this release): `npm run import:redis -- --source-release v4.2.0 --plan <private-plan.json> --dry-run`, then `npm run import:redis -- --source-release v4.2.0 --plan <approved-private-plan.json> --out <new-private-backup-directory>`. A separate `--from-capture <private-capture>` mode performs deterministic offline conversion and needs no Redis credential. `--dry-run` and `--out` are mutually exclusive; a report is always counts-only. Require explicit confirmation of the observed capture/decision digest before publishing output if a new capture differs from the approved dry-run. No unattended approval by elapsed time.

Before capture, the operator completes `TRANSITION.md` §§5–6: drain, disable old credential distribution, reset Upstash credentials, show both old tokens refused, verify every old deployment/late-write barrier and compare complete post-fence inventories. The importer performs **no** reset or write probe. Evidence is a prerequisite, not something the importer can independently prove from reads. Old browsers, deferred work and previews must all be fenced. Do not create a maintenance marker in Redis.

### Command contract

Reuse the inventory base allowlist: `PING`, `DBSIZE`, bounded `SCAN`, `TYPE`, `PTTL`, `STRLEN`, `SCARD`, `ZCARD`, `HLEN`, `LLEN`, exact `MEMORY USAGE`, and only its exact metadata `EVAL_RO` projection. A separate importer executor adds only:

| New read | Need / bound |
| --- | --- |
| `GET` | Full known STRING records, fingerprints and counters. Preflight STRLEN and cap reply bytes; no content in exceptions. |
| `SSCAN`, `HSCAN`, `ZSCAN` | Complete bounded collection traversal including notebook receipt values and ZSET scores; de-duplicate members. No `SMEMBERS`/`HGETALL` on unbounded collections. |
| `PEXPIRETIME` | Exact absolute Redis expiry, including consent and receipts that store no expiry field. `PTTL + client clock` is not an exact, reproducible substitute. Persistent/missing sentinels are distinguished. |

These operations read values/metadata only. Prefer individual/pipelined reads plus the repeated-pass checks below; no arbitrary Lua, no EVAL, MULTI, WATCH, SET, DEL, EXPIRE, RESTORE, KEYS, or application repair script. Inventory's fixed `EVAL_RO` is optional for comparison, not necessary for content capture. The policy rejects unknown command names/argument shapes **before transport**. Test the read-only ACL independently from this client-side policy. Availability of `PEXPIRETIME` with an Upstash Read Only token is **unverified** here and a staging release gate: if refused, stop with a capability error, never broaden credentials or approximate expiry silently.

Unknown namespaces receive TYPE/size/TTL/count metadata only by default. Reading an unknown family's content requires an explicit adapter allowlist; an exclusion can be acknowledged without fetching its content. Unknown key names and hash fields are themselves potentially sensitive.

### Capture algorithm

1. Complete SCAN (`MATCH *`, bounded COUNT, cursor to zero), de-duplicating keys as inventory does. Retain global key/time/member/byte limits; overflow is incomplete, not success with truncation. Preflight sizes before values. Spill to a private, bounded work directory only in real capture mode; dry-run uses bounded memory and fails rather than spooling content.
2. For each supported key, read TYPE and absolute expiry around its value/collection traversal. Hash raw STRING bytes; canonicalize SET members, HASH field/value pairs and ZSET member/score pairs in bytewise order for comparison. Include type and absolute expiry in its digest. Record presence separately. TTLs are not hashed as decreasing relative durations. Large unknown collections whose equality cannot be established require a bounded adapter or block complete capture; count equality alone does not certify them.
3. Repeat a complete pass and compare the full key sets and digests, **including indexes and resolved/excluded known operational records**. Detect additions, type changes, same-size rewrites, TTL extensions, member/value/score changes and unexplained deletions. Stop on any mutation; do not chase a live database until it happens to look quiet.
4. The only automatic disappearance allowance is a key whose previously measured absolute expiry has elapsed. Report it as `expired-during-capture`; never synthesize its former value from an index. An expiring container that disappears mid-read is counted similarly, not read as an empty persistent container. Survivors must have identical values and absolute expiries. Stale index members caused by those expiries are accounted separately. Take an end-of-capture server-time observation if needed for the expiry proof; adding `TIME` would be another explicitly tested read-only capability, not an assumption about client clock skew.
5. Store a private accepted capture with fixed metadata/digest; mapping is offline from that capture. Detect graph errors, apply only snapshot-bound explicit dispositions, validate every output row and cross-reference, then write the backup. Dry-run executes the same parsing/mapping decisions but produces only the counts report; it does not create a capture, chunks, manifest, trailer or quarantine file.

**Limit:** repeated scans detect observed changes but cannot prove that a value was changed and restored between reads, or recover keys expired before the first scan. There is no source-wide mutation sequence in the inspected standalone layout. The external credential fence is the consistency guarantee; digests improve detection beyond inventory's counts but do not replace it. Expose `consistency: externally-fenced-two-pass-verified`, never `atomic-snapshot`. Unknown data may also expire unseen; do not claim historical completeness.

Determinism means **same accepted capture + importer/profile version + fixed snapshot metadata + decisions → byte-identical backup**. SCAN order, locale, wall clock, random UUIDs and current provider defaults must not affect it. Repeating a live scan after expiry is a different capture. Retaining the private capture enables exact re-runs; a dry-run report alone cannot recreate expired content. Exclusion acknowledgements bind to a plan digest including source/capture/profile/decision identities and counts. Re-read live data means fresh validation, not reuse of a stale acknowledgement.

## 4. Backup directory and record mapping

### Container, limits and workspace identity

Use `BackupWriter`, `canonicalJson`, checksums and `BackupValidator` from `src/lib/backup/format.ts`. Order families exactly as `BACKUP_FAMILIES`, rows by each family's key tuple using deterministic ordinal comparison, chunks by consecutive zero-based index. Emit at most 500 rows/chunk and a fixed conservative byte cap (proposed 4 MiB), then verify **each encoded chunk + complete import manifest + 1,024 bytes ≤ 24 MiB**, matching `scripts/cloudflare/operator.mjs: loadBackupDirectory`. Reject oversize rows rather than splitting their JSON content. Enforce destination `MAX_ROW_BYTES = 1,900,000`, synthesis/aggregate 256,000-byte ceilings (`studies.ts`, `operator.ts: rowWithinLimits`); also enforce notebook validators' own tighter bounds.

Directory layout matches `operator.mjs: chunkFileName`, with each file a single JSON record plus newline:

```text
chunks/00-workspace_meta-000000.json
chunks/01-studies-000000.json
...                       # only nonempty chunks, actual BACKUP_FAMILIES ordinal
manifest.json             # {kind: "manifest", manifest: ...}
trailer.json              # {kind: "trailer", complete: true, manifestSha256: ...}
```

The manifest includes all 15 families, including zero counts/empty chunk descriptors. `formatVersion = schemaVersion = 3`; `exportedAt = snapshotAt`; no custom fields inside the closed manifest. Keep report, decisions and capture in a private sibling work directory, not `chunks/`. Validate the entire directory offline before publishing its trailer. Use a new/empty outside-repository directory, 0700 directories, exclusive 0600 files, fsync and final atomic publication; reject symlink/path escape and never overwrite an existing backup. An interrupted run has no complete trailer. Matching existing output may be verified as a no-op, not partially rewritten.

Redis has no WorkspaceStore identity. Derive synthetic `sourceWorkspaceId = ws_ + first32(sha256(domain + sourceStorageId))`; derive `activated_epoch = ep_ + first32(sha256(otherDomain + captureDigest))`. Domains are fixed/versioned constants; these are migration identities, **not credentials or a claim of a former Durable Object**. Detect digest/ID collisions. Bind manifest and metadata to that source ID. Receive the destination's configured epoch as non-secret plan metadata and fail on equality, rather than regenerate randomly. The destination CLI still checks equality authoritatively.

`workspace_meta`: `singleton=1`, `workspace_id=sourceWorkspaceId`, `activated_epoch=syntheticSourceEpoch`, `maintenance_state='recovery'`, `maintenance_version=0`, `mutation_seq=0`, `created_at=updated_at=snapshotAt`. Manifest/chunk watermark is `{maintenanceVersion:0, mutationSeq:0}`. These are explicitly synthetic values, not Redis history. `operator.ts: importBackupChunk` retains the destination's own identity/held state, adopts the source epoch, and advances its mutation sequence. Do not copy credentials, session secrets, rate-limit salts or cookies. Activation uses the imported epoch as expected value and the deployment's distinct epoch as new value.

### Studies and canonical configuration

| Destination column | Source / rule |
| --- | --- |
| `id` | `StoredStudy.id`, exactly equal to key suffix and `config.id`. |
| `config_json` | Canonical JSON of the retained `config` object, no defaults or content edits. |
| `revision` | Exact `revision`, valid current integer range; do not derive from timestamps, links or counts. Missing/invalid revision blocks, despite older Lua paths using `or 1`. |
| `created_at`, `updated_at` | Exact `createdAt`, `updatedAt`; safe nonnegative integer ms. Config's own `createdAt` is preserved independently. |
| `interview_count` | Number of retained primary interviews after graph/operation resolution; compare source `interviewCount`, report corrections. Do not count stale index entries. A correction requires a named disposition when not explained by a verified unfinished completion. |
| `is_locked` | Preserve true; otherwise true if retained interviews exist, false only when source false and none exist. Record any correction. Never unlock a historically locked study because selected records were excluded. |
| `sample_fixture` | 0. Redis `StoredStudy` has no such field; never infer destructive sample-clear authority from an ID/name. Report synthetic/sample-looking records without setting this bit. |

Validate config using current `validateStudyConfig` (`src/lib/studyConfigValidation.ts`), not the create validator that replaces identity or adds save-only placeholder checks. Its allowed fields are `id`, `name`, `description`, `researchQuestion`, `coreQuestions`, `topicAreas`, `profileSchema`, `aiBehavior`, `aiProvider`, `aiModel`, `aiProviderCommitment`, `consentText`, `researcherContact`, `thankYouText`, `interviewerInstructions`, `interviewLanguages`, `consentTextTranslations`, `thankYouTextTranslations`, `voiceInput`, `createdAt`, `parentStudyId`, `parentStudyName`, `generatedFrom`, `linksEnabled`, `linkExpiration`, `enableReasoning`. Preserve all, including absent optionals and order of questions/languages; validate nested profile fields too.

**Rejected current config:** default is a blocked backup, with counts by safe validation code. Do not choose a replacement model, fill missing consent, strip fields, truncate questions or change revision. The existing backup importer only checks config identity, but `canonicalStudy.ts: loadCanonicalStudy` rejects invalid configuration on participant use; exploiting that weaker import check is not success. The operator may explicitly exclude the study and its dependency closure, or commission a separately reviewed transformation profile. A transformation of actual interview protocol requires a new revision and explicit old-authority disposition, not an in-place same-revision repair; that is outside the first importer. Record whether the owner instead wants an archive-only invalid-config mode (§10). Historical `collectionConfig` is research evidence, not today's active config: preserve supported historical shapes without replacing old models with current defaults.

### Links and consent

`participant_links`: `id ← link.id` (key's SHA-256 digest, not the unavailable original code); `study_id ← studyId`; `study_revision ← studyRevision`; `created_at ← createdAt`; `expires_at ← expiresAt`; `revoked_at ← revokedAt`. Require `version=1`, `researcherId=null`; these two source members are validated/consumed, not SQL columns. Preserve older revision bindings even if already stale; reject a future revision relative to the parent. Never rebind to the latest revision or set `linksEnabled=true`.

Check finite link `expiresAt` against captured Redis absolute expiry. A shorter TTL is an anomaly requiring explicit selection of the earlier effective expiry; a later/no TTL does not justify extending `expiresAt`. A persistent record with null expiry stays null. Already-expired but still readable records may be retained with the past timestamp; keys gone during capture are counted as expired exclusions. Never renew duration from capture/import time. `participantLinks.ts: hashParticipantLinkCode` hashes codes; preserving digest IDs lets existing codes resolve at the new origin, but does not recover codes or redirect old URLs. The redirect-only origin described in `TRANSITION.md` §8 remains a separate unbuilt task.

`consents`: `session_digest ← key suffix`, verified against SHA-256(`participantSessionId`); `study_id ← studyId`; `record_json ←` canonical whole supported version-1 record; `expires_at ←` captured absolute Redis expiry. Preserve `version`, `participantSessionId`, `studyId`, `studyRevision`, `consentHash`, `acceptedAt`, and optional `disclosedTransport`. Do not rehash consent text against today's config, translate it or upgrade direct disclosure to gateway. Old-revision consent remains old. Persistent/missing expiry on a live consent blocks rather than using `snapshotAt + 4h`: source TTL is four hours but `acceptedAt + 4h` is not necessarily the exact server expiry (`participantConsent.ts: RECORD_CONSENT_SCRIPT`). Source/record identity and parent checks are stricter than the destination's current reference list. Cookies/sessions do not migrate; preserved consent is evidence, not permission to accept an old session at the new installation.

### Interviews, aggregates and projects

`interviews` columns:

- `id`, `study_id`, `created_at`, `completed_at`, `study_revision` come from `id`, `studyId`, `createdAt`, `completedAt`, `studyRevision ?? null`. Check key identity, parent, types and revision bounds; never backfill a missing historical revision.
- `record_json` preserves the complete supported `StoredInterview`: `id`, `studyId`, `studyName`, `participantProfile`, `transcript`, `synthesis`, `behaviorData`, `createdAt`, `completedAt`, `status`, optional `studyRevision`, `collectionConfig`, `consentHash`, `consentAcceptedAt`, `aiProvider`, `aiModel`, `requestedAiModel`, `routedProvider`, `aiTransport`, `consentTransport`, `conductedByProvider`, `conductedByModel`, `providerCommitment`, `conductedWithInstructions`, `interviewLanguage`, `analysis`, `participantLinkId` (`src/types.ts`). Preserve nested transcript IDs/roles/text/times/order, profile evidence and behavior data exactly in value; canonical serialization may change whitespace/key order, never content or array order. Analysis projection is handled in §5. Preserve original inline analysis/claim metadata as historical record content, never executable authority.
- `fingerprint` copies validated `interview-fingerprint:<id>` after removing `oi:fp:`. Guard and fingerprint must agree. For legacy saves legitimately lacking it, use a documented migration-domain SHA-256 over immutable source content and source identity, count `synthetic-fingerprint`; it is **not** the old submission fingerprint. The save route hashes client submission fields before server normalization (`src/app/api/interviews/save/route.ts`), so reconstructing the original from stored data is not guaranteed. No old participant session replay is promised.
- `participant_session_id` is null except where a validated matching persist guard explicitly retains `identity.participantSessionId`; do not guess from consent or interview ID. `link_id` copies `participantLinkId`, or a matching guard's `identity.linkId` if available; conflicts block. Historical interview link evidence may outlive the live link record, so do not require an unexpired link to retain an interview.
- `sample_fixture=0` for the same reason as studies. Saved `status='in_progress'` is accepted by `projection.ts: parseRecord` but not a proven completed submission: default block with a separate disposition, never relabel it completed or schedule analysis.

`aggregates`: `study_id ← studyId`; `aggregate_json ←` complete supported aggregate JSON; `saved_at ← savedAt`. Preserve `studyRevision`, `interviewIds`, `interviewCount`, optional `scope`, all provider/execution members, `commonThemes` (including supported legacy quotes and structured `quoteRefs`), `divergentViews`, `keyFindings`, `researchImplications`, `bottomLine`, `generatedAt`, `savedAt` (`src/types.ts`, `kv.ts: decodeStoredAggregate`). Validate parent and cited source closure. Stale revisions are historical results, not an invitation to regenerate them. If excluded/missing interviews break scope, block or explicitly exclude the aggregate; never shrink its corpus and pretend the synthesis still describes it.

`projects`: `id ← id`, `name ← name`, `created_at ← createdAt`, `updated_at ← updatedAt`. Use `projects/validation.ts: isProject`: lowercase v4 UUID, already-trimmed 1–200 UTF-16-unit name, no controls/lone surrogates, safe times with updated ≥ created. Do not silently trim/rename. `study_projects`: `study_id ← study-project key suffix`, `project_id ← raw value`. Check both parents and one membership/study. Preserve duplicate project names and empty projects. Reconcile `all-projects` but do not discard an unindexed valid primary unnoticed. Profiles before 5.3 emit empty project families unless an explicit fork adapter supplies them. Grouping does not change study config, revision, timestamps or participant authority.

## 5. Analysis mapping: F7 without impossible jobs

Evidence: `IMPLEMENTATION.md` §7/F7; `src/lib/analysisState.ts`; `cloudflare/workspace/{schema,projection,analysis,completion}.ts`; `tests/workers/analysis.test.ts` generation-0 scenarios. `projection.ts` overlays an analysis row and removes inline mutable members; a missing analysis row is explicitly supported for legacy records.

Proposed normal mapping, with `current_generation=0` in every row:

| Valid source state | `analysis.status` | `recovery_required` / `failure_kind` | Work scheduled |
| --- | --- | --- | --- |
| No analysis, no synthesis; or pending with attempts 0 | `pending` | 0 / null | None; API phase `not-scheduled`. |
| Valid synthesis and absent analysis or consistent `complete` | `complete` | 0 / null | None. |
| `failed` | `failed` | 0 / exact supported source failure kind | None. Preserve an already recorded uncertainty flag if a reviewed profile supports it. |
| `running`, including 0 attempts; or pending with attempts > 0 | `failed` | 1 / `timeout` | None; researcher recovery is required. |

Other columns: `interview_id ← record.id`; `attempts ← analysis.attempts` verbatim (0 only when analysis absent); `last_attempt_at ← analysis.lastAttemptAt` (0 sentinel only when absent); `study_revision ← analysis.studyRevision ?? null`, **not** collection/current revision; `synthesis_json ←` exact-value canonical source synthesis only for complete; `provenance_json ←` recorded `aiProvider`, `aiModel`, `requestedAiModel`, optional `routedProvider`/`aiTransport` only for complete; null otherwise. `updated_at = max(completedAt, lastAttemptAt)` is a documented synthetic projection timestamp, not an invented observed completion time. Safe nonnegative integers required; never reset nonzero attempts. Count synthetic metadata separately.

Refuse contradictory state (complete without synthesis, noncomplete with a synthesis, malformed attempts/failure fields) rather than choose an interpretation that could trigger another paid call. Historical models may no longer be in the current request catalogue; preserve recorded result provenance and validate its historical profile, not current model availability. Never fabricate execution provenance from the current study, nor reinterpret Vercel routing as Cloudflare Gateway.

**Legacy synthesis with incomplete provenance:** `projectInterview` requires non-null synthesis/provenance JSON when an analysis row says complete. Preferred exception: retain the supported legacy interview unchanged and emit **no analysis row**, reporting `legacy-complete-without-analysis-row`. `analysis.ts: statusBody` reports generation-0 complete from its synthesis; the original missing fields stay missing. Test UI/export/retry behavior rather than writing `{}` to satisfy a structural check. Owner should approve this explicit F7 exception.

`analysis_jobs` has **zero rows** in the proposed importer. Thus none of its columns (`job_id`, `interview_id`, `generation`, `recovery_epoch`, `state`, `input_json`, `requested_provider`, `requested_model`, `allocated_at`, `updated_at`, `dispatch_state`, `dispatch_attempts`, `next_due_at`, `claim_nonce`, `claimed_at`, `claim_expires_at`, `started_at`, `terminal_at`, `failure_kind`, `terminal_receipt_json`) is synthesized. No frozen provider input or history is invented. This avoids both the generation-0 SQL violation and accidental dispatch. Recovery activation cannot substitute for this mapping: `operator.ts: activateRecoveryEpoch` settles nonterminal **jobs**, not a jobless Node `running` record. Map uncertainty before writing the backup. A later explicit retry with expected generation 0 allocates the destination's first real generation; verify it performs no call until researcher action.

## 6. Notebook, replay authority and unfinished operations

### Exploration notebook

`exploration_answers`: `id ← answer.id`, `study_id ← studyId`, `record_json ←` supported complete `ExplorationAnswer`, `request_fingerprint ← requestFingerprint`, `created_at ← createdAt`, `updated_at ← updatedAt`, `status ← status`. Validate with `exploration/validation.ts` and the identity consistency of `cloudflare/workspace/exploration.ts: decodeAnswerRow`.

Preserve `question`, optional `parentAnswerId`, `scope`, `result`, `execution`, `failureKind`, `promptVersion=1` and all identity/timestamp/state fields. Scope includes `studyId`, `selection` (IDs/revisions/profile filters), `sources` (`interviewId`, nullable `studyRevision`, `contentHash`), `totalSaved`, `selectedCount`, `excludedCount`, `unknownProfileCount`, `pendingAnalysisCount`, `sourceFingerprint`. Result retains answer, findings with supporting/challenging/uncertain evidence references, and limitations. Preserve quote text and 1-based stored-transcript indices; do not renumber around system turns, rejudge entailment or rewrite source hashes.

Check every source against the retained interview and `immutableSourceContentHash` (`exploration/dataset.ts`: transcript/profile/collectionConfig/revision/identity, not synthesis). Validate parent existence in the same study, reject cycles/identity collisions and missing sources. The source key is study-scoped but the destination primary key is global answer ID: collisions block, never auto-rename IDs embedded in evidence/replay authority. Never replace missing protocol snapshots with today's config because that changes immutable source hashes.

For `running`, map to `recovery-required`, `failureKind='request-interrupted'`, and `updatedAt=max(source.updatedAt,snapshotAt)`; retain the old timestamp/state in the private disposition ledger and count the transform. The failure class is already used by `exploration/server.ts: recoverInterruptedAnswer`. Preserve complete/failed/recovery-required states otherwise. No answer, attempt or provider retry is generated. Activation's existing `classifyExplorations` also handles running rows, but preclassification makes the backup itself inert and deterministic.

Translate every valid HASH entry in `study-exploration-keys:<studyId>` to `idempotency_receipts`:

| Column | Value |
| --- | --- |
| `operation_family` | `exploration` |
| `key_digest` | Original hash field; verify hex64. |
| `fingerprint` | Entry `fingerprint`, exactly matching answer `requestFingerprint`. |
| `target_id` | Parent study ID (not answer ID). |
| `disposition` | `reserved`, even if answer is complete. |
| `result_json` | Raw answer ID string, **not JSON-quoted**. |
| `created_at` | Answer `createdAt`. |
| `expires_at` | `Number.MAX_SAFE_INTEGER` for the supported persistent notebook mapping. |

This is the destination's actual lifetime/replay contract (`cloudflare/workspace/exploration.ts: reserve/lookup`). The route hashes `{studyId, researcherId, key}` on both targets (`src/app/api/studies/[id]/exploration/route.ts`); standalone null researcher identity means the original digest is reusable without the raw key. A fork's expiring receipt container needs explicit policy, not automatic immortality. Duplicate digest with different answers across studies blocks. Missing receipts cannot be reconstructed without the raw key: retain the answer only with an explicit `missing-replay-authority` acknowledgement, and do not claim replay parity. Orphan receipts, set/order disagreements and missing parent/source answers require explicit exclusion/repair disposition. SQL indexes replace verified Redis ordering/index entries; no silent omission of their evidence of missing records.

### Study create receipts

For a resolved `create-idemp:<digest>` (`createIdempotency.ts`), write `operation_family='study-create'`, `key_digest=suffix`, `fingerprint=source.fingerprint`, `target_id=studyId`, `created_at=createdAt`, `expires_at=captured absolute expiry`. `disposition='created'` and `result_json=canonical original source receipt.study` only if the live study and operation resolution establish creation; retain the original candidate snapshot, not today's edited study. `disposition='deleted'` and `result_json=null` for deleted/explicitly consumed keys. The field `researcherId` must be `standalone`; `version`, `state`, `updatedAt` and `operationId` are validated/resolution inputs, not copied columns. Hash scope is the same standalone hash (`hashCreateIdempotencyKey`; `storage/redis.ts`); test actual replay through the destination.

Do not recreate a deleted study from a receipt containing its old config (4.x legacy). A pending mapping with a proven committed matching create resolves created; pending with no authoritative study does **not** create one. Block until an explicit consumed-key or exclusion decision. Persistent live receipts are anomalous; do not invent a fresh seven-day lifetime. An expiring source receipt that vanishes during capture is counted. No project-create or Node analysis-retry receipt is invented.

### Resolver decision table

Resolution is a pure graph operation on the capture; it **never executes** Redis's Lua repair/deletion scripts. Evidence: `kv.ts` P1/Finish, `StandaloneOperationReceipt`, `StudyMutationGuard`; `storage/redisStudyPurge.ts`.

| Source condition | Proposed outcome |
| --- | --- |
| Valid primary record, consistent parents and terminal created guard/receipt | Retain once. Translate replay authority as above; consume guard as resolved metadata. |
| Valid completed interview + matching fingerprint/P1 guard, Finish not reflected in indexes/count | Retain transcript once, derive count/lock from retained primaries, record `finish-resolved-offline`; do not charge old rate plan or start analysis. Validate guard's version, IDs, fingerprint, expectedRevision, standalone mode, identity, ratePlan and frozenUpdatedAt. A guard revision older than current is evidence to review, not permission to replace historical revision. |
| Guard/fingerprint but no interview, or guard/record mismatch | Block pending explicit abandonment/exclusion; a guard has no substitute transcript. Count affected operations without double-counting its study-persisting member. |
| Terminal deleted receipt/guard or in-flight populated-delete guard | Never resurrect remaining children. Compute the whole study/child/notebook/membership closure; require explicit acknowledgement to exclude the partially deleted closure. In-flight delete is not proof that its remaining research data has already been removed. |
| In-flight/cancelled create, conflicting guards/receipts, invalid shape, hosted mode | Block; no chronology guess based only on timestamps. Hosted needs a different importer, not an exclusion switch hiding ownership. |
| Missing/misfiled/stale index entry but valid primary | Report discrepancy; rebuild destination indexing from primaries only under an explicit repair disposition. A record's appearance in an index never overrides its own study ID. |
| Index/receipt names a missing primary | Report orphan and require disposition unless disappearance is proven expiry. Never recreate content from a cached index/receipt. |

No Redis indexes/guards/pending operations become Cloudflare jobs. `budget_windows` and `budget_members` are empty: old rate/login/researcher/save counters and memberships are explicitly counted as operational-state exclusions, acknowledged in the migration plan; new installation sessions/salts are separate. `deletion_fences` is empty in the initial profile: enforce all source tombstones in the retained-record graph and exclude their data rather than invent deletion times/horizons. Count terminal deletion metadata as resolved/excluded; maintain consumed create receipts where available. This policy depends on new destination identity/epoch, no imported jobs and no old sessions—verify these invariants. Destination `schema_migrations`, `operator_audit`, `login_attempts` and internal KV export/scheduler state are not backup families (`schema.ts`, `IMPLEMENTATION.md` §4); do not add them.

## 7. Unknown data and reviewable reports

Default: **no complete backup while any key family, record member, encoding, lifecycle conflict or reference has no disposition**. Count unknown keys, unknown field occurrences, and distinct affected records separately. Enumerate unknown nested fields as well as top-level fields; dynamic legitimate maps (translations/profile data) must use their domain schema, not treat user-defined keys as extension names. Do not trust a familiar `study:` prefix to imply its entire JSON is supported.

Allowed decisions are versioned mapping adapter, explicit exclusion of selected record/field/closure, or stop. Exclusion acknowledgement includes exact capture/plan digest, rule ID, affected-count expectation, operator/approval reference and dependent consequences. No blanket `--ignore-unknown`, wildcard future acknowledgement or successful run with only a warning. Dropping an unknown field from an immutable dataset source can invalidate notebook hashes: block or explicitly exclude affected derived artifacts; do not rewrite their hashes to disguise the loss. Save retained original content only in the private capture, not a pretend extra backup family.

### Example fork projects (illustrative, not observed upstream)

A fork might put `projectId` inside study/config JSON and keep its own project namespace. The actual namespace, shape, membership cardinality, timestamps and semantics are **unknown until its code/sample schema is supplied**. Do not assume the fork keys are the native 5.3 `project:` family.

An explicit proposed `--fork-project-adapter <reviewed-profile>` plus snapshot-bound plan may extract that organization field and produce native `projects`/`study_projects`. The adapter must state field paths, key matching, missing-parent policy, ID mapping and collision handling. Reuse valid native UUIDs; otherwise use a fixed source-bound map to UUID-shaped IDs accepted by `isProjectId`, with collision detection (do not call the result a randomly generated UUID). Missing project times/names block until the operator approves an explicit synthetic value or exclusion; never derive them from the first study without saying so. Conflicts with native membership or multiple projects per study block. Only a demonstrated organization-only field may be moved without revising the study protocol. If the fork used it in prompts or consent, this is a protocol migration requiring a different plan. Unknown extensions on the projects themselves also need disposition.

### Counts report (proposed format; synthetic example)

```json
{
  "reportVersion": 1,
  "mode": "dry-run",
  "status": "blocked",
  "source": {"profile": "v5.3.0", "storageId": "<digest>", "commitVerified": false},
  "snapshot": {"digest": "<digest>", "consistency": "externally-fenced-two-pass-verified"},
  "counts": {
    "sourceKeys": 42,
    "records": {"studies": 2, "interviews": 3, "explorationAnswers": 1, "projects": 1},
    "plannedRows": {"studies": 2, "interviews": 3, "analysis": 3, "analysis_jobs": 0},
    "unknownKeys": 2,
    "unknownFieldOccurrences": 2,
    "recordsWithUnknownFields": 2,
    "unresolvedOperations": 0
  },
  "analysisMapping": {"notScheduled": 1, "complete": 1, "failed": 0, "recoveryRequired": 1, "legacyWithoutRow": 0},
  "issues": [
    {"rule": "unknown-family", "selector": "<opaque-selector>", "keys": 2, "decision": "required"},
    {"rule": "unknown-study-member", "selector": "<opaque-selector>", "records": 2, "occurrences": 2, "decision": "required"}
  ],
  "dispositions": {"mapped": 0, "resolved": 0, "excluded": 0, "expiredDuringCapture": 0},
  "planDigest": "<digest>",
  "backupPublished": false
}
```

The real report enumerates **every** source family and all 15 destination families, with scanned/decoded/mapped/resolved/excluded/expired/blocked counts, bytes and reconciled deltas; the compact example omits zero families for readability only. Distinguish key counts from logical operations and row counts; one interview creates two rows, one pending completion appears in several keys, and exclusions cascade. Provide equations/checks: each observed key has one terminal disposition; each primary record is retained or explicitly excluded; projected row counts match the manifest. Unknown-field totals may overlap affected-record totals and are labelled as such.

Never output study/project names, IDs, raw keys, field names from arbitrary forks, questions, transcript text, profiles, quotes, source hashes, raw parser errors, URLs or credentials. Use importer-owned rule names and opaque plan selectors; private capture/adapter configuration provides local resolution. Even namespace labels can contain sensitive free text: stricter redaction than inventory's optional lowercase namespace label is appropriate here. Treat report/digests as restricted operational metadata, not public telemetry. An operator reviewing content does so through explicitly chosen local secure tooling, never a `--verbose` console dump.

Proposed exits: 0 complete dry-run or published backup (distinguished by `mode`); 2 input/capability/authorization refused; 3 incomplete/changed/blocked/unacknowledged; 1 internal/I/O failure. Error paths emit safe classes/counts only. Do not print participant data even when JSON parsing fails.

## 8. Verification and staging gates

### Release-generated synthetic fixtures, not today's hand-built approximations

Implement a fixture producer in CI/a developer environment that can open ports. This session cannot, and did not run these lanes. For **each exact supported tag in §2**, a future runner creates a detached `git worktree` of that tag, records its resolved SHA, installs **that tag's** lockfile/toolchain, and imports **that tag's** storage implementation. This is a proposed future test setup, not permission to mutate Git in this docs-only task.

Start a runner-owned disposable local `redis-server` (or the existing test harness's owned container), blank credential environment and unique ownership attestation; never accept an inherited Redis URL or flush an arbitrary server. Use the tag's `src/lib/redisNodeAdapter.ts` / `RedisPort` with its own `createRedisWorkspaceStore`, `kv.ts`, link/consent writers and, where present, notebook/project stores. `tests/helpers/disposableRedis.ts` supplies the current ownership pattern. The fixture driver lives outside or as test-only overlay in the detached checkout; do not modify production source to make an old shape look current.

Seed valid synthetic configs accepted at that release, using its own study creation, link, consent, P1/Finish, analysis attach/fail and aggregate/notebook/project writes. Use literal synthetic transcripts with distinctive leak-test markers; never call a provider. Controlled clocks/IDs make captures repeatable. Exercise real API serialization through a test driver where the stored fields are assembled in a route rather than the store (e.g. `collectionConfig`, commitment/language). Generate legacy bare/prefixed paths with `saveStudy`/`saveInterview` and atomic methods respectively. For unsupported states such as corruption/extra fork fields, first generate valid data, then mutate only the disposable fixture and label it **fault injection**, not historical producer output.

Keep fixture provenance: tag/SHA, lockfile digest, producer version, called entry points, Redis version, record-family counts and capture digest. Do not copy expected fixtures between tags merely because storage blobs match. Confirm v4.x notebook/projects absent, v4.2 budget additions, v5.0 scope/receipts/delete cuts, v5.1 languages/voice, v5.3 projects, and v5.4 device mode. Also test mixed-age records produced by sequential old/new writers before fencing the fixture.

### Test manifest and pass criteria

| Proposed test files / lane | Required evidence |
| --- | --- |
| `tests/unit/redisImportMapping.test.ts`, `redisImportPlan.test.ts` | Every destination column and optional historical absence; no guessing provider/revision; complete/failed/running/pending-attempts F7 matrix; missing provenance; native/fork membership; unknown nested fields; dependent exclusions; deterministic permutations; no input-object mutation. |
| `tests/setup-cloudflare/redis-import.test.mjs` | Fake REST executor: exact read allowlist, denied writes/Lua, auth/capability errors, malformed/paged/duplicate SCAN, byte bounds, clock/expiry semantics, same-size value and equal-cardinality index changes, no Standard fallback. Secret/content markers absent from stdout/stderr and failure reports. Dry-run creates no content artifacts. |
| `tests/integration/redisImport.test.ts` + `tests/helpers/redisImportReleaseFixtures.mjs` | Real owned Redis, each old tag writing its own records; read-only ACL for capture; crash cuts for P1/Finish/create/delete; unexplained write detection and expiry-only disappearance. Compare pre/post logical state to prove importer sends no mutation. |
| New `tests/workers/redisImport.test.ts`; existing `tests/workers/backup.test.ts` | Import the mapper's actual 3/3 chunks through `WorkspaceStore.importBackupChunk`, duplicate chunk/finalize replay, interruption/resume, real reference validation, wrong epoch, identity retention, incompatible pairs, bounds, unknown columns. Never insert destination rows directly as the proof of importer correctness. |
| Worker round-trip/assertions | Read studies/interviews/analysis/notebook/projects through production store methods, export a destination backup, compare research values/absolute expiries and documented transforms (not workspace metadata bytes, which legitimately change). Verify generation-0 state, exact attempts, incomplete-provenance legacy reads, old-revision link refusal, project membership without study mutation, create/notebook replay without execution, deletion closure, exports/citations. Activate/open, advance alarms and assert **zero queue/provider attempts**; only explicit researcher retry creates generation 1. |
| Operator directory tests | Feed generated directory to the current operator loader with a fake destination; prove filenames, manifest, trailer and body sizes work unchanged. Missing trailer, extra chunk, corrupted checksum, changing decisions and existing-directory overwrite all refuse. |
| Full gates on an unrestricted test runner | Focused unit/CLI/Redis/Worker tests, `npm run lint`, `npm run typecheck`, `npm run check`, `npm run test:cloudflare`, `npm run test:contract:redis`, `npm run test:inventory:redis`, import-boundary check; final supported Cloudflare matrix via `npm run check:cloudflare` on an authorized clean implementation commit. Artifact/E2E/setup/restart coverage should follow that runner, not duplicate guessed commands. |

Current supporting tests inspected include `tests/workers/backup.test.ts` (round-trip machinery) and `tests/workers/analysis.test.ts` (jobless generation-0 behavior). Existing backup fixtures do not establish full current-config validation or historical producer compatibility; do not reuse their deliberately minimal records as the only importer fixtures.

### TRANSITION §4 rehearsal

Record a synthetic `VERIFY-04` preservation rehearsal on an old-stack Vercel staging deployment with its own throwaway Upstash database, plus a staging Cloudflare `--import-target` installation (`--env staging`). Include the section's install/update/resume/failing-release checks, operational export/import, point-in-time restore/undo/back-out, and release-class rollback, as well as:

1. All supported families and every analysis state, notebook replay key and project membership; expired/revoked/stale-revision authority and one deliberately unfinished completion/deletion.
2. A participant session opened before the fence. Reset credentials and verify old Standard/Read Only refusal, all old deployment barriers and its deliberately late save failure as §6 specifies. Do not substitute two equal inventories for this test.
3. Capability probe using only the new Read Only token; complete inventory, dry-run report, explicit exclusion plan, capture, stable repeat conversion and import through the unchanged operator command.
4. Destination status/read/export comparisons against report counts, valid source/destination epoch separation, activation, and no automatic provider execution. Exercise lookup/replay before separately authorized synthetic-provider retry/acceptance.
5. Resume an interrupted import of the same directory, reject a changed manifest, prove expiry was not renewed, and document old-link behavior/new origin (redirect implementation is not implied).

No real participant data or live paid provider is needed for automated lanes. Any actual staging provider acceptance remains separately scoped as in TRANSITION. Do not infer production readiness from local fixture success. Before opening the destination, the old stack is still the operational fallback; once Cloudflare accepts new research writes, redirecting back would hide them—follow TRANSITION's fix-forward rule.

## 9. Phased delivery and effort

Estimate, not a commitment: **12–18 engineering days plus owner review and staging access**, for upstream profiles; a fork adapter adds approximately 2–5 days per documented layout. Main cost is historical fixtures and resolving ambiguities, not copying JSON. Expect roughly 7–9 new production/helper files, 3–5 touched code/config files, 6–8 test/fixture files, and four operations documents updated; an extraction/build choice can change that count.

1. **Contract/fixtures (2–3 days):** owner answers §10; pin the supported SHAs; produce fixtures for all 11 tags; validate Read Only capability and identify anomalous historical records. Gate: evidence-backed codec profiles, no advertised support from tag names alone.
2. **Read/capture/report (3–4 days):** reuse inventory traversal policy, missing budget family, strict new reads, expiry/digest checks, resource bounds, private capture and counts-only dry-run. Gate: no-write and no-leak tests, explicit unresolved findings.
3. **Mapping/plans/output (3–5 days):** all 15 family dispositions, graph resolution, unknown-field/exclusion accounting, determinism and unchanged operator directory. Gate: complete unit/CLI cases; every observed key/field accounted; no trailer on failure.
4. **Round-trip and release gates (2–3 days):** real historical Redis → backup → Worker import/read/export/replay; full proportional verification and documentation updates. Gate: import/activation creates no paid work.
5. **Staging rehearsal (2–3 days):** TRANSITION §4/§6 and preserve-data acceptance, owner sign-off on recorded caveats; only then describe §8 as executable. Production migration remains a separately authorized operation.

## 10. Open questions for the owner

1. **F7 ruling:** approve generation-0 analysis rows with zero synthetic jobs (and legacy complete/no-analysis-row when provenance is missing), or commission a destination protocol/schema change first? The latter breaks this task's unchanged-importer constraint and enlarges scope.
2. **Old invalid configs:** accept strict blocking/dependency-closure exclusion, or require an archive-only preservation mode for configs today's validator rejects? That mode needs demonstrated non-executability and usable researcher exports; the current weak backup identity check alone is not sufficient evidence. No silent model/consent rewrite is proposed.
3. **Source scope:** certify all 11 listed tags initially, or prioritize v4.2.0 and v5.4.0 while marking others not yet certified? What exact deployed commit and fork source/schema are available? An upstream tag cannot identify fork project semantics.
4. **Loss/repair authority:** approve derived count/index repair, source-tombstone closure exclusions, synthetic legacy fingerprints/sample flags and operational-counter exclusion policies? Who signs the digest-bound disposition plan and keeps the secure capture? Missing notebooks/replay receipts and partial deletions must not be decided by the importer silently.
5. **Read capability:** does the authorized Upstash staging Read Only token permit exact absolute-expiry reads (and server-time observation if needed)? If not, stop and revisit capture strategy; no Standard-token fallback is authorized by this design.
6. **Migration operations:** intended data volume/downtime, capture retention/deletion period, need to preserve old invitation URLs through a separately built redirect origin, and staging owner/access window? These are not established by repository inspection.

## 11. Verification of this design-only delivery

Only the two requested Markdown files were added. No skeleton, dependencies, application code or tests were added; therefore npm install/typecheck/lint/unit execution was not needed or claimed. No ports were opened. Git remained read-only. `CHANGES-redis-importer.md` records the exact final documentation checks and exit codes, the planned logical commit, and the implementation verification still to do. All runtime/import compatibility claims above remain proposed until §8 passes.
