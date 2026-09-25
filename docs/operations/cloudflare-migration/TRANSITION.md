# Production transition runbook (OPS-04)

This runbook moves a standalone Node/Vercel deployment, whose research records live in one Upstash Redis database, to a Cloudflare standalone installation. It implements `OPS-04` and the old-writer part of `OPS-01` in [04 — verification and cutover](04-verification-and-cutover.md). The package [README](README.md) asks for both a clean-start and a preserve-data runbook; both are here. The Cloudflare side uses [INSTALLER.md](INSTALLER.md) and [RUNBOOK.md](RUNBOOK.md).

Status: prepared, not executed.

- Every step that reads or changes production data or resources needs explicit authorization for that step. This covers the inventory, the drain, the credential reset, the installation and the switch.
- The clean-start path can run on the code in this branch.
- The preserve-data path needs an Upstash importer that has not been built.
- The inventory tool is tested only against a local disposable `redis-server`, not against Upstash.

Out of scope: a hosted-mode deployment, meaning the platform Redis plus researcher-owned (BYOS) databases. The Cloudflare target has no hosted mode, and the inventory tool recognizes only the standalone key layout.

## 1. Select the target

Record the following outside the repository, before any other step:

- **Cloudflare account.** The account id, the plan (Workers Paid recommended) and the usage headroom for Workers, Durable Objects and Queues.
- **Names.** The installation name and the names `setup:cloudflare plan` derives from it, plus the staging installation.
- **Origin.** A stable origin: `workers.dev` or a custom domain. On a custom-domain zone, turn Pseudo IPv4 off.
- **Jurisdiction.** The Durable Object jurisdiction (`eu` recommended). It is fixed at installation.
- **Backups.** The protected destination and retention for operational backups (OPS-02).
- **Deployment owner.** The installer, for the project's maintained instance too ([INSTALLER.md](INSTALLER.md#maintained-instance)); the CI promotion job only for an installation that chooses it ([INSTALLER.md](INSTALLER.md#optional-ci-owned-deployment)).
- **Acceptance smoke.** The provider, model and number of calls for the end-to-end acceptance. It is a paid call.
- **Old links and hostname.**
  - Whether old entry links must keep working. They cannot move to a Cloudflare-owned domain; only a redirect-only origin backed by preserved link records could keep them, which requires the preserve-data path.
  - What the old hostname shows after the switch.
- **The old deployment.**
  - Its mode, as its public `/api/config/mode` reports it. This runbook covers `standalone`. If the mode is `hosted`, stop: the research records live in researcher-owned databases, and that transition needs its own decision.
  - The Vercel project or projects.
  - Every production, preview and deployment URL and alias that can reach the database. Vercel keeps older deployments reachable.
  - The Upstash database: its id and region.
  - Where its credentials are held, by name only: Vercel environments, local env files, CI secrets.

## 2. Inventory the old storage

`npm run inventory:redis` (`scripts/cloudflare/inventory-redis.mjs`) prints a metadata-only report of the Upstash database:

- **Read commands only.** It sends only `PING`, `DBSIZE`, `SCAN`, `TYPE`, `PTTL`, `STRLEN`, `SCARD`, `ZCARD`, `HLEN`, `LLEN`, `MEMORY USAGE`, and `EVAL_RO` of one fixed projection script. It refuses anything else before any network request.
- **Bodies stay on the server.** Record bodies are read only there, by that script, which returns booleans, counts, enumerated states and timestamps.
- **No identifying output.** The report holds no key names, identifiers, transcripts, link codes or credentials.

Run it only with authorization. Use an interactive terminal (hidden prompts), or pipe the credentials from a secret manager so that they never reach a file, an argument or the shell history:

```bash
# The template holds op:// references only and lives outside the checkout, like the report:
#   ~/secure/inventory.tpl.json: {"KV_REST_API_URL": "{{ op://<vault>/<item>/url }}", "KV_REST_API_READ_ONLY_TOKEN": "{{ op://<vault>/<item>/read-only token }}"}
op inject -i ~/secure/inventory.tpl.json | npm run --silent inventory:redis > <directory outside the repository>/inventory-<date>.json
```

- Prefer the database's Read Only token.
- `--max-keys` and `--max-seconds` (defaults 50,000 keys and 300 s) bound the scan.
- Exit codes:
  - `0`: a complete report.
  - `3`: an incomplete report, with the reasons in `incompleteReasons`: `key-budget`, `time-budget`, `scan-interrupted`, `field-projection-unavailable`, `records-not-projected`, `collections-over-member-bound` or `command-errors`.
  - `2`: refused, for example `Upstash refused the token`.
  - `1`: failed.
- If Upstash refuses `EVAL_RO` with the Read Only token, the report falls back to counts and sizes and is marked `field-projection-unavailable`. A rerun with the Standard token still sends read commands only. Unverified: whether Upstash accepts `EVAL_RO` and `MEMORY USAGE` with a Read Only token.
- The scan is not a snapshot. `scan.dbsizeBefore`/`dbsizeAfter` and the warnings `key-count-changed-during-scan` and `keys-changed-during-scan` show that writes were happening. Final numbers come from a run after the fence (§6).

Record these fields as the input to §3:

- `summary`: `totalKeys`, `researchRecords` (studies, interviews, participant links, aggregates, consents), `hasResearchData`, `pendingOperations`, `interviewsAwaitingFirstAnalysis`, `orphanedReferences`, `unrecognizedKeys`;
- the `pendingOperations`, `orphans` and `expiredReferences` breakdowns. Their counters overlap, and the two summary totals count each item once. An unfinished save appears both as `interviewPersistsUnfinished` and as `studyPersistingMembers`, and counts once in `summary.pendingOperations`. `summary.orphanedReferences` counts a study's interview index whose study is missing through its entries, not also as `studyInterviewIndexesWithoutStudy`; an entry that names a live interview belonging to another, existing study (a misfiled entry) is not counted in the summary at all, so always record `orphans.studyInterviewIndexesWithoutStudy` as well. A missing interview listed both in `all-interviews` and in its study's index counts once in `summary.orphanedReferences` when `all-interviews` was checked member by member; `collections.studyInterviewIndexes.missingTargetsAlsoInAllInterviews` says how many there were;
- the `families` table: `count`, `ttl` (`persistent`, `expiring`), `bytes` and `members` for each key family. §6 compares it;
- `records.interviews.analysis.importMapping`: how the importer would map each interview's analysis state (IMPLEMENTATION.md §7, F7);
- `target.storageId`: a digest of the database origin, used to confirm that later runs read the same database.

Keys the application does not own are counted as `unrecognized`, with a lowercase namespace label only. The test is `tests/integration/inventoryRedis.test.ts`: `npm run test:inventory:redis`, also the `redis-inventory` lane of `npm run check:cloudflare`. Like the other Redis lanes, it needs a local `redis-server` or Docker.

## 3. Choose the data path

Record an explicit decision, who approved it, and the inventory file it rests on. Do not assume that low use means an empty database.

- **Clean start** (§7). The new workspace starts empty. The old database stays untouched, and later unreadable to the old application, until it is retired. Researchers keep what they need as ZIP exports taken from the old deployment during the drain.
- **Preserve data** (§8). Chosen records move into the new workspace through an operational import. This needs the Upstash importer, which is not built.

## 4. Rehearse in staging

Rehearse with the same code and configuration shape, on a staging installation (`--env staging`) and synthetic data, and record the results as the `VERIFY-04` staging report:

- **Install and update.** A clean install under custom names. Repeated `apply` and `update` without duplicate resources or rotated secrets. An interrupted setup and its `resume`. A deliberately failing release check that leaves staging unchanged.
- **Backup and restore.** An operational export and an import into an `--import-target` installation (RUNBOOK OPS-02). A point-in-time restore, its undo and its back-out (RUNBOOK OPS-03).
- **The old-writer barrier.** The procedure in §6, run on an old-stack staging deployment: a Vercel preview with its own throwaway Upstash database. It must include the participant late write described there.
- **Rollback.** N−1 → N → N−1 for the release class (RUNBOOK OPS-03).
- **Preserve data only.** The importer on a synthetic Upstash dataset that covers every family the inventory reports.

## 5. Drain the old deployment

The old Node deployment has no maintenance modes. Turning a study's participant links off (`linksEnabled: false`) refuses new link exchanges. It also refuses the sessions already open and their saves, so drain before you turn links off:

1. Announce the window to researchers. Stop sending new invitations.
2. For a clean start, researchers export (ZIP) every study they want to keep. Exports read the old database, so they must finish before the fence.
3. Wait at least the 4-hour participant session lifetime after the last invitation you expect to be used.
4. Turn participant links off for every active study.

A participant still mid-interview at that point loses the answers that exist only in their browser. Record how many such sessions were known.

## 6. Fence the old writers: reset the Upstash credentials

**Barrier.** Reset the password of the Upstash database. This revokes both its Standard and its Read Only REST tokens ([Upstash REST API](https://upstash.com/docs/redis/features/restapi)). Every old writer uses the old credentials, so all of them lose read and write access at once:

- the production deployment;
- every older and preview deployment and alias;
- deferred analyses already running;
- any local or CI copy of the credentials.

A code flag, a redeploy, an alias change or a DNS change cannot do this. Vercel deployments are immutable and keep the environment they were built with, and DNS is not a barrier (OPS-01).

The new credentials never go back into Vercel. The operator keeps them in the password manager as the authorized read path, for the final inventory and, when preserving data, the importer.

**Before the reset:**

1. **Make sure no new deployment can obtain the new credentials.** Disable Git deployments for the old Vercel project or projects. Remove the Upstash variables (`KV_REST_API_URL`, `KV_REST_API_TOKEN`, `KV_REST_API_READ_ONLY_TOKEN`, and any other Upstash URL the integration added) from every environment of every Vercel project linked to the database.
   - Whether the Vercel integration copies reset credentials into a project by itself is not established, so assume it may.
   - Do not delete the database or uninstall the integration. Confirm in the staging rehearsal that the removal method you chose leaves the database in place.
2. For the staging rehearsal: open a participant session on a synthetic study and leave it unsaved.

**Reset.** Reset the database credentials in the Upstash console, or with the Upstash developer API (`POST /v2/redis/reset-password/{id}`). Record the time, and store the new tokens only in the password manager.

**Verify.** Every check must pass before §7 or §8 continues:

1. **The old tokens are refused.** Run `npm run --silent inventory:redis` once with the old Standard token and once with the old Read Only token. Both must exit 2 with `errorClass: "unauthorized"`. The tool sends no write, so this proves revocation without touching data.
2. **Take the reference inventory** with the new Read Only token. It must be complete (exit 0), and its `target.storageId` must equal the one in §2.
3. **Every old deployment is cut off.** For every URL and alias recorded in §1, send `GET /api/health/ready` and act on the answer:
   - **503 with `checks.configuration: true` and `checks.platformDatabase: false`.** The storage ping failed: cut off.
   - **200 (`ready: true`).** The deployment still reaches the database: the barrier has failed (below).
   - **404.** The deployment predates the readiness route, which was added on 14 August 2026. A read cannot prove the cut there: those releases answer an unreachable database on the study list with 200 and an empty list. Use the write probe of check 4 on that URL instead, signing in with the password that deployment was built with. The create must fail with 503 or 500, never 2xx: every release since the studies API (7 December 2025) refuses a create that way when storage is unreachable. Sign-in in those releases reads no storage, so a failed sign-in (wrong password, or deployment protection) leaves the URL unchecked.
   - **503 with `checks.configuration: false`.** The storage check did not run. Use the write probe, as for a 404.
   - **Anything else,** such as Vercel's deployment protection answering instead of the application, or a timeout. The URL is not checked yet; get past the protection or resolve the failure, then repeat.

   If the study create answers 404 as well, the deployment predates the studies API. Record its creation time from Vercel: if it was created before the reset, it can hold only the old credentials, which check 1 showed are refused. Otherwise treat it as a failed barrier.
4. **A deliberately late write is refused.**
   - On the old production URL, sign in as the researcher. Up to v4.1.1, Node sign-in reads no storage. Then create a study named `fence probe <date>`. The request must fail: on the current release it answers 503 (storage unavailable), not 2xx.
   - Releases after v4.1.1 count Node sign-in attempts in the database before comparing the password. On them, sign-in itself is the late write: with the correct password it must answer 503 "Sign-in is temporarily unavailable". A 200 or 429 means the deployment still reached the database: the barrier has failed. The study create then cannot be attempted and is not needed.
   - In the staging rehearsal, also submit the participant save left open before the reset. It must be refused.
5. **Nothing was written.** Run the inventory again with the new Read Only token. It must be complete (exit 0), with the same `target.storageId`. Compare it with the reference inventory from check 2.

   Equality is too strict, because keys with an expiry disappear between the two runs without any write: consents after 4 hours, participant links created with an expiry (`expiresAt`), rate-limit windows, and the 7-day study-operation receipts and create-idempotency records. Require instead that nothing grew, and that every decrease is explained by expiry:
   - `summary.totalKeys` and `scan.dbsizeAfter` are not greater than in the reference.
   - For every entry of `families`, `count` and `ttl.expiring` are not greater, and `ttl.persistent` is equal. A key without an expiry cannot appear or disappear without a write, so any decrease comes from keys that had an expiry.
   - Every family with no expiring keys in the reference (`ttl.expiring` 0) is unchanged: `count`, `bytes.total` and `members.total` are all equal. In the standalone layout these include `studies`, `interviews`, `aggregates`, `allStudiesIndex`, `allInterviewsIndex` and `studyInterviewIndexes`, so a late study create or interview save shows here, and so does an edit that changes an existing record's size. An edit that keeps the size is invisible to the inventory; checks 3 and 4 cover the write path itself.
   - `summary.researchRecords` follows from the above: `studies`, `interviews` and `aggregates` are equal, while `participantLinks` and `consents` may only have fallen.

   Any other difference is a write after the reset: treat it as a failed barrier. The converse does not hold: in a family with expiring keys, a late create offset by an expiry in the same family, or a rewrite of an expiring key, leaves every count unchanged, and a same-size edit is invisible everywhere. This check only catches writes the counts can show; checks 3 and 4 are the barrier's real proof.

If an old URL is still ready, a late write succeeds, or the inventory shows a write, the barrier has failed:

1. Stop, and do not switch.
2. Find the writer: a deployment, project, script or copy holding credentials you did not reset.
3. Record any probe study that was created, for removal.

## 7. Clean-start runbook

Preconditions:

- §1–§4 are recorded, with the decision "clean start".
- Authorization for the production installation, the drain, the reset, the switch and the acceptance smoke.

1. **Install the destination, and hold it.**
   1. From a clean checkout of the release commit, run `npm run build:cloudflare` and `npm run check:cloudflare`.
   2. Run `setup:cloudflare plan`, then `apply --env production` ([INSTALLER.md](INSTALLER.md#fresh-installation)), then `verify`.
   3. Hold the workspace: `maintenance draining --expected-state open --expected-version <v>`, then `maintenance frozen --expected-state draining --expected-version <v>`.
   4. `status` must show zero studies and interviews.

   Installing before the fence is safe, because the workspace is held and nothing directs participants to it. Later deploys use `setup:cloudflare update` from the workstation that holds the receipt. An installation that chooses the optional CI deployment sets it up now; later deploys then go through it.
2. **Drain the old deployment** (§5).
3. **Fence it** (§6), with every verification passing. Keep the reference inventory with the decision record. The old database is not modified or deleted.
4. **Switch.**
   1. Reopen the destination only now: `maintenance open --expected-state frozen --expected-version <v>`.
   2. Run the controlled end-to-end acceptance on the production origin: sign in, create a clearly named acceptance study, generate a link, consent, interview and save, wait for the background analysis to complete, then export. This makes the paid calls named in §1. A study that holds interviews cannot be deleted, so keep the acceptance study clearly labelled.
   3. Give researchers the new origin. Sessions do not migrate: researchers sign in again and create new studies and links.
5. **Observe.**
   - Readiness: `setup:cloudflare verify`, or `verify --config` for a CI-owned installation.
   - `status`: job counts and the oldest active age.
   - Failure classes in the Worker's structured logs.
   - No Upstash traffic after the reset other than the operator's inventory runs.
   - No duplicate paid attempts.
6. **Retire later.** Only after the recovery period and an accepted disposition, and only with explicit authorization, delete the Upstash database and the old Vercel resources. The installer never deletes anything.

**Fallback.** Until step 4.1 (the first Cloudflare write), the old deployment remains a fallback. Reverse the fence by resetting the credentials again, configuring the old project with them and redeploying. After Cloudflare has accepted writes, pointing back to Upstash would hide those writes: fix forward.

## 8. Preserve-data runbook

Not executable yet: it requires an Upstash-to-Cloudflare importer, which is not built. The package README asks for one only if the authorized inventory finds data to retain. The importer's contract:

- **Input.** The fenced Upstash database, through the new Read Only token, with read commands only.
- **Output.** An operational backup directory in format v1 (`src/lib/backup/format.ts`) that `npm run operator:cloudflare -- backup import` validates and imports unchanged.
  - The manifest and its `workspace_meta` row carry a source workspace id (`ws_` followed by 32 hex characters).
  - The row carries a valid activated epoch that differs from the destination's; the import refuses otherwise.
  - The destination keeps its own identity.
- **Mapping.**
  - Analysis states map as IMPLEMENTATION.md §7 (F7) specifies.
  - Redis-specific guards, indexes and unfinished operations (the inventory's `pendingOperations`) are resolved, not copied as jobs.
  - Expiry times are preserved, never renewed.
  - Link and consent records stay bound to their study revision.
  - Every exclusion is counted in the importer's report.
- **Tests.** Synthetic Upstash data covering every family the inventory reports, and the staging rehearsal (§4).

Old entry links can survive only through a redirect-only origin backed by preserved link records (04 §OPS-04). That is not built either.

Once the importer exists:

1. Install the destination as an import target: `setup:cloudflare apply … --import-target`. The workspace starts empty, in `recovery`.
2. Drain the old deployment (§5), then fence it (§6), with every verification passing.
3. Run the final inventory with the new Read Only token. It must be complete (exit 0). Record `pendingOperations` and `importMapping`.
4. Run the importer into a new directory outside the repository. Store it like participant data.
5. Import it: `npm run operator:cloudflare -- backup import --in <dir> --origin …` (RUNBOOK OPS-02).
6. Compare `status` counts with the inventory, allowing for the importer's reported exclusions.
7. `recovery activate --expected-epoch <activated epoch from status>`. Imported unfinished analyses become recovery-required.
8. Switch: `maintenance open --expected-state recovery --expected-version <v>`, then the acceptance run from §7 step 4, including an imported study and interview.
9. Observe, and retire later, as in §7.

The fallback rule is the same as in §7: the old deployment is a fallback only until the first Cloudflare write.
