# Cloudflare operator runbook

Operational procedures for an OpenInterviewer standalone installation on Cloudflare. It implements the contracts in [04 — verification and cutover](04-verification-and-cutover.md) (`OPS-01`..`OPS-04`) and [03 — analysis jobs](03-analysis-jobs.md) (`JOB-10`). Installation and updates are covered by [INSTALLER.md](INSTALLER.md); the routes behind these commands are specified in [IMPLEMENTATION.md §6](IMPLEMENTATION.md#6-operator-surface-ops). The move of an existing Vercel/Upstash deployment to Cloudflare is in [TRANSITION.md](TRANSITION.md).

Status: none of these procedures has run against a real Cloudflare account. The maintenance, backup, import and activation procedures have been exercised locally against synthetic data. Three have been exercised only in part:

- **Point-in-time restore.** The restore command's refusals, its route and the object restart are tested locally. The restore itself is not, because local workerd does not implement point-in-time recovery.
- **CI promotion.** The workflow has been checked only statically. No GitHub Actions run or dispatch has taken place.
- **Production transition.** This needs production authorization.

Each section lists the remote rehearsal that must pass before the procedure is relied on in production.

## Operator CLI

```bash
npm run operator:cloudflare -- status --origin https://<installation>
npm run operator:cloudflare -- maintenance <open|draining|frozen|recovery> --expected-state <state> --expected-version <n> [--classify-in-flight] --origin …
npm run operator:cloudflare -- backup export --out <dir> --origin …
npm run operator:cloudflare -- backup import --in <dir> --origin …
npm run operator:cloudflare -- recovery restore --expected-state <frozen|recovery> --expected-version <n> (--at <ISO 8601 time with zone> | --bookmark <bookmark>) --origin …
npm run operator:cloudflare -- recovery activate --expected-epoch <ep_…> --origin …
```

- `--origin` is the scheme and host only: HTTPS, or HTTP for a loopback host in a local rehearsal.
- Credentials: the administrator password and the installation's `OPERATOR_TOKEN`, as stdin JSON (`{"ADMIN_PASSWORD": "…", "OPERATOR_TOKEN": "…"}`, for example from `op inject`) or no-echo prompts in a terminal. Never pass them as arguments or environment variables.
- The CLI signs in through `POST /api/auth` and sends the token as `Authorization: Bearer`. The Worker accepts an operator request only when the token matches in constant time **and** the researcher session was issued within the last 15 minutes. The CLI signs in again after 12 minutes, and once more if the Worker answers `SIGN_IN_REQUIRED` or `RECENT_SIGN_IN_REQUIRED`, so long exports and imports keep their authority.
- Output: one JSON result on stdout; progress and errors on stderr. It shows only states, versions, counts, identifiers and error classes, never credentials, cookies or record contents. Every accepted or refused action is logged by the Worker without content, and the object keeps an audit row for each transition, import and activation. A scheduled restore writes no audit row, because the restore would rewind it; it is logged as an `operator.action` event (`restore.schedule`) instead.

| Exit | Meaning |
| --- | --- |
| `0` | Done. |
| `1` | Failed, or the outcome is unknown: a network error, a sign-in lockout (429), a refused backup page or import chunk, or a transition, activation or restore that may have committed. When the Worker answers with 5xx or `OUTCOME_UNKNOWN`, the report includes the current `status`. When no reply arrives at all (a reset connection, or no answer within 120 s), the CLI reports `request failed (<code>)` with `detail.network` and does not read `status`; run `status` yourself. |
| `2` | Refused before anything changed: invalid arguments (including an `--at` time that is not a real calendar time, is in the future or is more than 30 days back), an incomplete or corrupt backup directory, an `ADMIN_PASSWORD` whose sign-in body is over 1 KiB, a password or token that was not accepted, an origin without the operator API or without a bound `OPERATOR_TOKEN`, the wrong maintenance state for a backup, a record-family mismatch, or a definite refusal of a transition, activation or restore (409, 422 `BOOKMARK_REFUSED`, or 503 `DEPLOYMENT_NOT_READY`, `WORKSPACE_HELD`, `WORKSPACE_NOT_CONFIGURED`). |
| `130` | A credential prompt was cancelled. |

A lost response is resolved by reading `status`, never by repeating a transition blindly.

### Sign-in lockout

Sign-in is limited on Cloudflare: 10 failed attempts per client per 15 minutes, and 200 across all clients per hour. Each client is its full normalized address. Each window opens with its first counted attempt and is never extended. Over a limit, `/api/auth` answers 429 with `Retry-After`, and the CLI exits 1 with "retry after N seconds". A client-level lockout clears within 15 minutes. A global lockout means many failures from many clients; it blocks every sign-in, including the correct password, for up to one hour. Sign-in works in every maintenance state and under epoch, identity and bootstrap holds. Only an unsupported schema or unavailable workspace storage refuses it (503).

## Maintenance states (OPS-01)

| State | Participants | Researchers | Analysis |
| --- | --- | --- | --- |
| `open` | normal | normal | normal |
| `draining` | new link exchanges refused; existing sessions may consent, talk and save | mutations, aggregate synthesis and analysis retries refused; reads, exports, preview and follow-up generation allowed | existing and newly saved jobs settle |
| `frozen` | all writes refused | reads and exports allowed; preview and follow-up refused | no dispatch, claims, starts, result writes or cleanup |
| `recovery` | as `frozen` | as `frozen` | as `frozen`; import and epoch activation allowed |

Allowed transitions: `open` → `draining`; `draining` → `open` or `frozen`; `frozen` → `open` or `draining`; `recovery` → `frozen` or `open`; any state → `recovery`. Each is a compare-and-set on `(state, version)`: pass the state and version `status` last reported. A conflict reports the current state and version.

- Entering `frozen` while analysis attempts are claimed or started is refused (exit 2, `ANALYSIS_IN_FLIGHT`) unless you pass `--classify-in-flight`. It returns unstarted claims to `pending` and marks started attempts recovery-required: a paid call may have run, and the researcher sees the retry-cost disclosure.
- Leaving `recovery` is refused while an import is in progress.
- While the activated recovery epoch differs from the deployment's (after an epoch change, before activation), only a transition to `recovery` is accepted.
- Transitions that resume work (to `open`, or `frozen` → `draining`) are refused with `DEPLOYMENT_NOT_READY` on a not-ready deployment. Transitions that tighten the hold, `status`, backup, import and activation work on a not-ready deployment.
- Returning to `open` or `draining` from `frozen` or `recovery` re-arms the scheduler in the same transaction; its first pass dispatches due work.

```bash
npm run operator:cloudflare -- status --origin …
npm run operator:cloudflare -- maintenance draining --expected-state open --expected-version <v> --origin …
npm run operator:cloudflare -- maintenance frozen --expected-state draining --expected-version <v> --origin …
npm run operator:cloudflare -- maintenance open --expected-state frozen --expected-version <v> --origin …
```

## Operational backup (OPS-02)

Researcher ZIP exports are a product feature, not a backup. The operational backup covers every authoritative table (studies, immutable interviews and fingerprints, analysis and jobs, aggregates, participant link digests, consents, unexpired receipts and budgets, deletion fences, workspace metadata). It contains no secrets, since none are stored in the workspace. The sign-in budget and the operator audit log are per-installation state and are not backed up.

1. `draining`, wait until `status` shows no claimed or started jobs, then `frozen` (or classify in-flight attempts).
2. `npm run operator:cloudflare -- backup export --out <dir> --origin …`
3. Return to `open` only when the export reports `complete: true` and the directory is stored.

The workspace must be `frozen` or `recovery`. `--out` must be a new or empty directory outside the repository; the CLI checks this before asking for credentials. It then does the following:

- Reads the first page and compares the record families the Worker backs up with the families its own checkout knows. On any difference it refuses (exit 2) before writing anything: run the CLI from the release deployed there.
- Only then creates the directory (mode 0700).
- Checks every later page against the watermark `(maintenance version, mutation sequence)` of the first page, and confirms it once more after the last page.
- Re-validates what it wrote before writing the manifest and, last, the trailer.

```
<dir>/                            0700
  chunks/                         0700
    <NN>-<family>-<index>.json    0600; one chunk record: rows and SHA-256
  manifest.json                   0600; format and schema versions, source workspace, watermark, per-family counts, per-chunk checksums
  trailer.json                    0600; completion trailer, written last
```

`NN` is the family's two-digit position in the format's family order and `index` is six digits. Files are created exclusively and synced. A directory without `trailer.json` is incomplete. It must not be used, and import refuses it. After an interruption, the workspace stays held; return it to service explicitly.

The checksum detects corruption; it does not encrypt or authorize. Store the directory with protections suitable for participant data.

Remote rehearsal pending: export from a staging installation with synthetic data.

## Import into a fresh workspace (OPS-02)

Import runs only into an empty workspace in `recovery`: install a new installation with `setup:cloudflare apply --import-target` ([INSTALLER.md](INSTALLER.md)).

```bash
npm run operator:cloudflare -- backup import --in <backup directory> --origin https://<fresh installation>
npm run operator:cloudflare -- status --origin …
npm run operator:cloudflare -- recovery activate --expected-epoch <activated epoch reported by status> --origin …
```

Before asking for credentials, the CLI validates the whole directory:

- `trailer.json` and `manifest.json` are present and valid;
- there are no chunk files the manifest does not describe;
- every described chunk is present and matches its checksum.

An import request carries one chunk and the manifest and is limited to 24 MiB, like the route. Chunks are bound to their manifest descriptors and cannot be split, so a chunk too large for that limit is refused locally. Pages written by this exporter hold at most 500 rows and 8 MiB of column data.

The Worker accepts chunks idempotently by `(family, index)` under one manifest digest. A chunk that gets a 503 marked retryable, or a network error, is sent up to three times in all. Any other refusal stops with exit 1 and keeps the accepted chunks: re-run the same command to resume, and chunks already accepted come back as duplicates. Finalize validates counts, references, identities, sizes and counters. Expiry timestamps are preserved, never renewed. Imported unfinished analysis stays held until activation reconciles it to recovery-required. Reports contain counts and error classes only.

After activation, verify with `status`, then `maintenance open --expected-state recovery --expected-version <v>`.

Remote rehearsal pending: import into a fresh staging workspace and compare counts and checksums.


## Point-in-time restore (OPS-03)

Durable Object point-in-time recovery returns the workspace object's SQLite storage to a point within the last 30 days. It runs only inside the object. `recovery restore` asks the object to:

1. resolve a time to a bookmark (`getBookmarkForTime`);
2. schedule the restore for its next session (`onNextSessionRestoreBookmark`);
3. reply, then restart.

Cloudflare documents point-in-time recovery only as these [storage methods](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), not as a wrangler command. A restore rewinds every table in the object, including sign-in attempts and the operator audit log. It does not rewind Queue deliveries, provider calls or the Worker's secrets.

| Part | Evidence |
| --- | --- |
| Refusals before any point-in-time call; reply before restart | Local: `tests/workers/operator.test.ts` › `point-in-time restore entry point (OPS-03)`, with the two storage methods stubbed |
| Route authority and outcomes | Local: `tests/unit/api.operator.routes.test.ts` › `OPS-03 POST /api/operator/recovery/restore` |
| CLI parsing, request bodies and exit codes | Local: `tests/setup-cloudflare/operator.test.mjs` › `OPS-03 recovery restore …` |
| Epoch-mismatch hold, activation and reconciliation | Local: `tests/workers/operator.test.ts` › `recovery-epoch activation (JOB-10, OPS-03)` |
| The platform resolving a time, restoring storage and reopening the object on it; undo | **Remote only.** Local workerd refuses both calls: it does not implement point-in-time recovery |
| `wrangler secret put` and `wrangler rollback` around the epoch secret | **Remote only.** Read from the wrangler 4.136.3 source and the Cloudflare documentation, not run |

### Procedure

1. **Fence writers.** Move to `draining`, wait until `status` shows no claimed or started jobs, then move to `frozen`, or classify in-flight attempts with `--classify-in-flight`. Confirm that no deploy can start: no CI promotion running or queued ([below](#maintained-instance-ci-promotion)) and no `setup:cloudflare update`.
2. **Record** the following with the installation receipt, outside the repository:
   - the `status` output: maintenance state and version, activated epoch, counts and jobs;
   - the receipt's `epochFingerprint`;
   - the target time or bookmark;
   - the Worker's current deployment (`node_modules/.bin/wrangler deployments list --name <worker>`).
3. **Rotate the epoch before touching storage.** Generate a new value (`ep_` followed by 32 lowercase hex characters), record it, then bind it:

   ```bash
   node -e "console.log('ep_' + require('node:crypto').randomBytes(16).toString('hex'))"
   node_modules/.bin/wrangler secret put ANALYSIS_RECOVERY_EPOCH --name <worker>   # paste the value at the hidden prompt
   ```

   The value is not sensitive. [`wrangler secret put` creates a new Worker version and deploys it immediately](https://developers.cloudflare.com/workers/configuration/secrets/). Then `status` must report `epoch.configuredMatches: false`. From this point every write, alarm and consumer callback against the database is held (`recovery-epoch-mismatch`). The installer's `epochFingerprint` no longer describes the bound value, because the installer never changes the epoch.

   **From this step until activation (step 7), never roll the Worker back.** Do not run `wrangler rollback`, do not `wrangler versions deploy` an earlier version, and do not roll back in the dashboard. Every version uploaded before this step binds the old epoch, and the restored database carries that same epoch. Its restored state, alarms and jobs would then resume without the activation reconciliation.

   The epoch is a secret binding, so `wrangler rollback` lists the changed secret and asks for confirmation (API code 10220). That prompt is a warning, not a guard:
   - its default answer is yes;
   - without a TTY, or in CI, wrangler answers it yes by itself (wrangler 4.136.3: `confirm2` in `wrangler-dist/cli.js` returns its fallback value, yes).
4. **Schedule the restore.**

   ```bash
   npm run operator:cloudflare -- recovery restore --expected-state frozen --expected-version <v> --at 2026-09-21T14:30:00Z --origin …
   # or --bookmark <bookmark> instead of --at
   ```

   Nothing is scheduled, and the CLI exits 2, when:
   - the workspace is not `frozen` or `recovery` at exactly the version you pass (409 `MAINTENANCE_CONFLICT`, with the current state and version, or 409 `NOT_HELD`);
   - the bound epoch is invalid, equals the activated one, or was activated here before (409 `EPOCH_NOT_ROTATED`). Go back to step 3;
   - the platform refuses the time or bookmark (422 `BOOKMARK_REFUSED`).

   The CLI also refuses, before sending anything, a time that has no zone, is not a real calendar time, is in the future or is more than 30 days back.

   On success the CLI prints `bookmark` and `undoBookmark`. Record both. The object restarts on the restored storage after it replies.

   If the reply is lost, the CLI exits 1. When the Worker answered with 5xx or `OUTCOME_UNKNOWN` (`restore outcome unknown (…); current status is reported below`), the report already includes `status`. When no reply arrived at all (`request failed (<code>)`, with `detail.network`), the CLI has not read `status`: run `npm run operator:cloudflare -- status --origin …` yourself before anything else. Then:
   - A state or version different from the one you passed means the restore ran.
   - If both are unchanged and the counts match step 2, repeat the same command. The repeat's `undoBookmark` leads back to the state just before the repeat, which is the original state only if the first attempt did not run. Remote rehearsal item: that a repeated `--at` resolves to the same bookmark.
5. **Check the epoch again, before anything else.** `status` must now report the restored maintenance state and version with `epoch.configuredMatches: false`. If it reports `true`, the Worker binds the epoch the restored database carries, which means a rollback or deploy reinstated it. In that case:
   1. Run nothing else.
   2. Bind the step 3 value again with `wrangler secret put ANALYSIS_RECOVERY_EPOCH --name <worker>`.
   3. Repeat this check.

   Anything the restored state did while the epochs matched, such as dispatches or attached results, is not undone. Activation still reconciles whatever is unfinished.
6. `maintenance recovery --expected-state <restored state> --expected-version <restored version>`. Under the epoch mismatch only `recovery` is accepted, from any state.
7. `recovery activate --expected-epoch <activated epoch reported by status>`. Activation first reconciles every restored unfinished generation to recovery-required, because external calls and Queue deliveries were not rewound. It then activates the deployment's epoch. Old messages and late results are rejected.
8. Verify with `status` (`configuredMatches: true`), then `maintenance open --expected-state recovery --expected-version <v>`.

Participant consequences: consents, links and receipts created after the bookmark are gone. Affected participants must re-consent (428) or receive a new link (403 on the old one). Researchers may need to re-run analyses marked recovery-required, with the paid-request disclosure.

**Undo.** A restore can be reversed before activation, while the bound epoch has still never been activated:

1. If the workspace is not `frozen` or `recovery`, move it to `recovery` (step 6).
2. Run `recovery restore --expected-state <state> --expected-version <v> --bookmark <undoBookmark>`.
3. Continue from step 5.

After activation, an undo first needs another epoch rotation (step 3), because the object refuses a restore while the bound epoch is the activated one. If `undoBookmark` was lost, the pre-restore state can be reached only with `--at`. Remote rehearsal item: that a time before a restore resolves to the pre-restore state.

**Back out when the restore cannot proceed after step 3.** This applies when no usable bookmark exists or the platform keeps answering `BOOKMARK_REFUSED`. Do not roll the epoch back. Activate the new epoch on the current database instead:

1. `maintenance recovery --expected-state frozen --expected-version <v>`
2. `recovery activate --expected-epoch <activated epoch from status>`
3. Verify with `status`.
4. `maintenance open --expected-state recovery --expected-version <v>`

The cost is that every pending, claimed or started analysis becomes recovery-required, and researchers see the retry-cost disclosure before running one again. This is the code path that `tests/workers/operator.test.ts` › `JOB-10/OPS-03: activation reconciles every nonterminal generation to recovery-required, …` exercises locally.

**An older epoch after activation.** A rollback or deploy that later binds an older epoch fails closed. The object holds every write and job (`recovery-epoch-mismatch`) and refuses to activate an epoch it has superseded. To recover, bind the activated epoch again with `wrangler secret put ANALYSIS_RECOVERY_EPOCH`, or rotate to a new epoch and run steps 6–8.

## Release classification and application rollback (OPS-03)

Classify each release against the deployed commit before deploying it:

| Class | How to recognize it | Rollback procedure |
| --- | --- | --- |
| Code-only | No new migration in `cloudflare/workspace/schema.ts`. No change to the Queue message, job states or RPC shapes the other version reads. No change to `durable_objects`, `migrations` or bindings in `wrangler.jsonc` | Compatible redeploy. The maintained instance reverts on `main` and dispatches the CI promotion again ([below](#maintained-instance-ci-promotion)). An installer-owned installation checks out the previous commit, runs `build:cloudflare` and `check:cloudflare` there, then `setup:cloudflare -- update`. Either way, current secrets, epoch and configuration are kept. |
| Compatible schema or job-protocol change | A new migration that declares `minReaderVersion` equal to the previous release's `schema.current` (from its artifact manifest). `minReaderVersion` is the optional field of `Migration` in `cloudflare/workspace/schema.ts`; it is not part of the migration checksum. Declare it only for changes the previous release can ignore (nullable or defaulted columns, tables it never reads), and only if the previous release still serves the new release's pending jobs. Or a job-protocol change the previous release still reads | Compatible redeploy, as above. Before release, rehearse N−1 → N → N−1 → N with pending and completed jobs, as `tests/workers/schema.migrations.test.ts` does with a synthetic migration. A migration that keeps the default `min_reader_version` makes the previous release refuse the database (`schema-unsupported`: not ready, reads and writes refused), so that release is forward-fix only. |
| Durable Object resource lifecycle change | A change to `durable_objects` or `migrations` in `wrangler.jsonc` (class added, renamed or deleted), or a removed binding | Native rollback may be unavailable ([Worker rollback restrictions](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/#bindings)). Keep required resources through the rollback window and plan a forward fix. |

The artifact manifest's `schema.minReadable` is the oldest stored schema a build reads. It says nothing about whether an older build can read a newer database: only the `min_reader_version` of each newer migration decides that.

Record before each deploy (with the installation receipt, outside the repository):

- the release class and the rollback procedure that was tested: native rollback, compatible redeploy or forward-fix;
- the previous and new commit, `artifact.workerSha256` and `schema.current`, from each artifact manifest (`dist/cloudflare/artifact/manifest.json`);
- the `min_reader_version` each new migration declares;
- `status`: maintenance state and version, activated epoch and whether it matches, and claimed/started job counts;
- the receipt's `epochFingerprint`, which must not change: a rollback keeps the current epoch, secrets and operational controls.

Roll back with a compatible redeploy, not `wrangler rollback`. Neither the installer nor CI sees a native rollback: the receipt's recorded version is then wrong, and `verify` cannot detect it. If a native rollback is unavoidable, for example because the deploy path itself is broken:

- run it in an interactive terminal only, never from CI, a script or an agent session, where wrangler confirms every prompt by itself;
- answer no if the prompt lists `ANALYSIS_RECOVERY_EPOCH`;
- never roll back across an epoch rotation (point-in-time restore, step 3).

Never run mixed application versions against incompatible state, never use percentage deployments for this Worker, and remember that neither a code rollback nor a DNS change restores data. During any deploy the Worker and the Durable Object can briefly run different versions; the RPC surface is additive between adjacent versions. To avoid analyses ending recovery-required during a deploy, drain analysis first (`draining`, wait for zero claimed/started) or accept that cost. `update` exits 3 when it deployed but the workspace is held; reopen it, then run `verify`.

## Maintained instance: CI promotion

The project's own production installation is deployed by the `promote-cloudflare` job in `.github/workflows/ci.yml` (`SETUP-05`), not from a workstation. Its one-time setup (the `cloudflare-production` environment, the installation-config variable and the API token) is in [INSTALLER.md](INSTALLER.md#maintained-instance-ci-promotion). This section covers deploying and rolling back through it. The one routine workstation deploy is a provider change: `update --change-provider` runs from the workstation that holds the receipt, after which the variable is regenerated (step 3 below).

Before a dispatch:

1. Classify the release and record the items above.
2. Drain analysis if you want to avoid recovery-required analyses (`draining`, then wait for zero claimed or started jobs).
3. Confirm that `CLOUDFLARE_INSTALL_CONFIG` still describes the installation. After `update --change-provider`, or for any release that changes `wrangler.jsonc` outside the installation-owned fields (`name`, var values, `routes`, `workers_dev`, `account_id`, queue names), for example the compatibility date or flags, Durable Object migrations or bindings, var names or queue settings, regenerate it without deploying and store the new file in the variable:

   ```bash
   npm run setup:cloudflare -- config --install <install> --env production   # prints the file's path
   ```

   `config` reads only the receipt and `wrangler.jsonc` and makes no remote call ([INSTALLER.md](INSTALLER.md#config-only-config)).

Dispatch the `CI` workflow on `main` with `promote_cloudflare` set, from the Actions tab or with:

```bash
gh workflow run ci.yml --ref main -f promote_cloudflare=true
```

Every required lane runs again for that commit. A required reviewer then approves the `cloudflare-production` environment before the job starts.

Concurrency:

- A push or pull request never cancels a dispatch run, and a dispatch never cancels a run in progress.
- A second dispatch waits for the first.
- GitHub still cancels a waiting run when a newer run joins the same group, so a third dispatch replaces a waiting second one.
- The promotion job also holds the `cloudflare-production` group and never cancels it.

| Outcome | What it means | Next |
| --- | --- | --- |
| Job succeeds | Deployed, and `verify --config` found `APP_BASE_URL` ready | Record the deployed commit. |
| Succeeds with the warning "held in a maintenance state" (verify exit 3) | Deployed; the workspace is held, for example because you drained it | Reopen it (`maintenance open …`), then `npm run setup:cloudflare -- verify --config <file with the variable's JSON> --wait-seconds 180`. |
| Fails in the config check or the release check | Nothing was uploaded | Fix the cause and dispatch again. |
| The deploy step fails, the run is cancelled or times out, or the verify step fails | The live version is unknown | See below. |

After a cancelled or ambiguous deploy:

1. See which version serves: `node_modules/.bin/wrangler deployments list --name <worker>` (needs Cloudflare credentials on the workstation). A deploy by `deploy.mjs` carries the message `openinterviewer <first 12 characters of the commit>`.
2. Check readiness, which needs no credentials: `npm run setup:cloudflare -- verify --config <file with the variable's JSON> --wait-seconds 180`. Exit 0 means ready, 1 not ready or a config problem, 2 refused, 3 held.
3. Act on the result:
   - New version live and ready: done.
   - Previous version live: fix the cause and dispatch again.
   - Not ready: roll back by reverting on `main` and dispatching again. Never run `wrangler rollback` from CI or a script.

Rollback is a revert on `main` followed by a new dispatch, because the job runs only from `refs/heads/main`. `setup:cloudflare update` from a workstation is only an emergency fallback for when CI cannot run, and needs the operator's explicit decision. It is recorded in that workstation's receipt, which CI never reads.

CI does not:

- update the installer receipt: the receipt's `deployments` and the `Version` that `setup:cloudflare verify --install` reports stay at the last installer deploy;
- compare queue ids, bound secret names or the installation identity with the receipt, as `update` does;
- prove that `APP_BASE_URL` is served by this Worker;
- drain the workspace.

## Production transition (OPS-04)

The move of an existing Vercel/Upstash standalone deployment to Cloudflare is in [TRANSITION.md](TRANSITION.md). It covers:

- the target record;
- the metadata-only inventory (`npm run inventory:redis`);
- the old-writer barrier, an Upstash credential reset verified by a deliberately late write;
- the clean-start and preserve-data runbooks.

Nothing in it runs without production authorization. Old `vercel.app` links cannot move to a Cloudflare-owned domain; plan re-entry.
