# Cloudflare operator runbook

Operational procedures for an OpenInterviewer standalone installation on Cloudflare. It implements the contracts in [04 — verification and cutover](04-verification-and-cutover.md) (`OPS-01`..`OPS-04`) and [03 — analysis jobs](03-analysis-jobs.md) (`JOB-10`). Installation and updates are covered by [INSTALLER.md](INSTALLER.md); the routes behind these commands are specified in [IMPLEMENTATION.md §6](IMPLEMENTATION.md#6-operator-surface-ops).

Status: every procedure below has been exercised locally against synthetic data only. None has run against a real Cloudflare account. Each section lists the remote rehearsal that must pass before the procedure is relied on in production.

## Operator CLI

```bash
npm run operator:cloudflare -- status --origin https://<installation>
npm run operator:cloudflare -- maintenance <open|draining|frozen|recovery> --expected-state <state> --expected-version <n> [--classify-in-flight] --origin …
npm run operator:cloudflare -- backup export --out <dir> --origin …
npm run operator:cloudflare -- backup import --in <dir> --origin …
npm run operator:cloudflare -- recovery activate --expected-epoch <ep_…> --origin …
```

- `--origin` is the scheme and host only: HTTPS, or HTTP for a loopback host in a local rehearsal.
- Credentials: the administrator password and the installation's `OPERATOR_TOKEN`, as stdin JSON (`{"ADMIN_PASSWORD": "…", "OPERATOR_TOKEN": "…"}`, for example from `op inject`) or no-echo prompts in a terminal. Never pass them as arguments or environment variables.
- The CLI signs in through `POST /api/auth` and sends the token as `Authorization: Bearer`. The Worker accepts an operator request only when the token matches in constant time **and** the researcher session was issued within the last 15 minutes. The CLI signs in again after 12 minutes, and once more if the Worker answers `SIGN_IN_REQUIRED` or `RECENT_SIGN_IN_REQUIRED`, so long exports and imports keep their authority.
- Output: one JSON result on stdout; progress and errors on stderr. It shows only states, versions, counts, identifiers and error classes, never credentials, cookies or record contents. Every accepted or refused action is logged by the Worker without content, and the object keeps an audit row for each transition, import and activation.

| Exit | Meaning |
| --- | --- |
| `0` | Done. |
| `1` | Failed, or the outcome is unknown: a network error, a sign-in lockout (429), a refused backup page or import chunk, or a transition or activation that may have committed. An unknown outcome includes the current `status` in its report. |
| `2` | Refused before anything changed: invalid arguments, an incomplete or corrupt backup directory, a password or token that was not accepted, an origin without the operator API or without a bound `OPERATOR_TOKEN`, the wrong maintenance state for a backup, a record-family mismatch, or a definite refusal of a transition or activation (409, or 503 `DEPLOYMENT_NOT_READY`, `WORKSPACE_HELD`, `WORKSPACE_NOT_CONFIGURED`). |
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

Durable Object point-in-time recovery is not available locally; this procedure is a remote rehearsal gate.

1. Fence writers: `draining`, settle, then `frozen` (classify in-flight attempts). Confirm no other deployment can write.
2. Record the receipt's `epochFingerprint`, the activated epoch from `status`, the target bookmark or time and the rollback target.
3. **Before restoring storage**, set a new `ANALYSIS_RECOVERY_EPOCH` secret (`ep_` + 32 lowercase hex), for example with `node_modules/.bin/wrangler secret put ANALYSIS_RECOVERY_EPOCH --name <worker>`, and confirm that `status` reports `epoch.configuredMatches: false`. The restored database carries the old activated epoch, so every write, alarm and consumer callback from the restored state is inert. The installer never changes the epoch, so its `epochFingerprint` no longer describes the bound value.
4. Restore the Durable Object to the bookmark (Cloudflare PITR API inside the object; requires the restore tooling being rehearsed in staging).
5. `maintenance recovery --expected-state <state> --expected-version <v>` with the values `status` now reports. The restored state may be anything, and only `recovery` is accepted under the epoch mismatch.
6. `recovery activate --expected-epoch <activated epoch reported by status>`. Activation reconciles every restored unfinished generation to recovery-required (external calls and Queue deliveries were not rewound) and then activates the deployment's epoch. Old messages and late results are rejected.
7. Verify with `status`, then return to `open`.

Participant consequences: consents, links and receipts created after the bookmark are gone. Affected participants must re-consent (428) or receive a new link (403 on the old one). Researchers may need to re-run analyses marked recovery-required, with the paid-request disclosure.

Never roll the epoch back to an older value. It is a secret binding so that `wrangler rollback` refuses to reinstate it silently.

## Release classification and application rollback (OPS-03)

Classify each release against the deployed commit before deploying it:

| Class | How to recognize it | Rollback procedure |
| --- | --- | --- |
| Code-only | No new migration in `cloudflare/workspace/schema.ts`. No change to the Queue message, job states or RPC shapes the other version reads. No change to `durable_objects`, `migrations` or bindings in `wrangler.jsonc` | Compatible redeploy: check out the previous commit, run `build:cloudflare` and `check:cloudflare` there, then `setup:cloudflare -- update`. Current secrets, epoch and configuration are kept. |
| Compatible schema or job-protocol change | A new migration that declares `minReaderVersion` equal to the previous release's `schema.current` (from its artifact manifest). Declare it only for changes the previous release can ignore (nullable or defaulted columns, tables it never reads) and only if the previous release still serves the new release's pending jobs. Or a job-protocol change the previous release still reads | Compatible redeploy, as above. Before release, rehearse N−1 → N → N−1 → N with pending and completed jobs, as `tests/workers/schema.migrations.test.ts` does with a synthetic migration. A migration that keeps the default `min_reader_version` makes the previous release refuse the database (`schema-unsupported`: not ready, reads and writes refused), so that release is forward-fix only. |
| Durable Object resource lifecycle change | A change to `durable_objects` or `migrations` in `wrangler.jsonc` (class added, renamed or deleted), or a removed binding | Native rollback may be unavailable ([Worker rollback restrictions](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/#bindings)). Keep required resources through the rollback window and plan a forward fix. |

The artifact manifest's `schema.minReadable` is the oldest stored schema a build reads. It says nothing about whether an older build can read a newer database: only the `min_reader_version` of each newer migration decides that.

Record before each deploy (with the installation receipt, outside the repository):

- the release class and the rollback procedure that was tested: native rollback, compatible redeploy or forward-fix;
- the previous and new commit, `artifact.workerSha256` and `schema.current`, from each artifact manifest (`dist/cloudflare/artifact/manifest.json`);
- the `min_reader_version` each new migration declares;
- `status`: maintenance state and version, activated epoch and whether it matches, and claimed/started job counts;
- the receipt's `epochFingerprint`, which must not change: a rollback keeps the current epoch, secrets and operational controls.

Prefer `update` from the older commit to `wrangler rollback`. The installer does not see a native rollback, so its recorded version would be wrong, and `verify` cannot detect it.

Never run mixed application versions against incompatible state, never use percentage deployments for this Worker, and remember that neither a code rollback nor a DNS change restores data. During any deploy the Worker and the Durable Object can briefly run different versions; the RPC surface is additive between adjacent versions. To avoid analyses ending recovery-required during a deploy, drain analysis first (`draining`, wait for zero claimed/started) or accept that cost. `update` exits 3 when it deployed but the workspace is held; reopen it, then run `verify`.

## Production transition (OPS-04)

Follow the table in `04-verification-and-cutover.md` §OPS-04 in order:

1. Select the target and record the decisions.
2. Inventory the old storage (metadata only).
3. Choose a clean start or preservation. An Upstash importer is built only if preservation is chosen.
4. Rehearse in staging.
5. Drain the old Vercel/Upstash writers and fence them: all URLs and callbacks, verified with a deliberately late write.
6. Prepare the destination.
7. Switch.
8. Observe.
9. Retire the old resources only after the recovery period.

Old `vercel.app` links cannot move to a Cloudflare-owned domain; plan re-entry.
