# Upstash inactivity warning — 23 September 2026

Disposition: **needs Xule's availability/retention decision**. Investigation complete within the authorized metadata-only scope. `openinterviewer-redis-v2` is the currently configured **production standalone research database**, not a demonstrated retired instance. Keep the current configuration intact; do not dismiss the warning as harmless cleanup.

## Evidence and current dependency

Source warning: Gmail local Mail515868, subject “Reminder: Upstash Redis Database Inactivity First Notice”, received 21 September 2026 at 02:05:17 Europe/Paris. Full message read. It names `openinterviewer-redis-v2`, describes weeks without traffic, says archival backs up data and removes the instance, and promises one more notice. It supplies no exact archival date.

Read-only Vercel CLI checks on 23 September, approximately 12:02–12:06 CEST:

| Check | Observed metadata |
| --- | --- |
| Integration resource | `openinterviewer-redis-v2`, `store_AefOFHEtqOncLdF4`, Upstash for Redis, status `available` |
| Fresh provider resource inspection | Same resource, status `available`, billing plan ID `free`, name `Free` |
| Connection | Project `openinterviewer` (`prj_zYguawEdtUNC3V3yVy6mHA1OtSWJ`), **production**, provider-managed credentials, no custom prefix |
| Injected variable names only | `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `KV_REST_API_READ_ONLY_TOKEN`, `REDIS_URL`, `KV_URL`; no values fetched or printed |
| Older resource | `openinterviewer`, `store_thwL1vXUJ6BLPMNV`, status `uninstalled`; distinct from the warned v2 resource |
| Canonical production alias | `openinterviewer.vercel.app` resolves in Vercel inspection to READY production `dpl_Cz5TCcn9kbNJRiSRfndYvxiLTQ2V`, URL `openinterviewer-kbwgdubgt-linxules-projects.vercel.app`, created 18 September at 23:46:04 CEST |
| Public config-only endpoint | [GET /api/config/mode](https://openinterviewer.vercel.app/api/config/mode): HTTP 200, `mode: standalone`, `aiTransport: direct`, `ready: true`, `errors: []` |

The config endpoint's `ready` means configuration shape is valid, not that Redis was contacted or its contents/health verified. Resource status is control-plane metadata, not a database health test.

Current source reviewed at `4d3076528681862cda21d0b2c80d1ae2ce9faeda`:

- [Standalone client](/Users/xulelin/Documents/Apps/openinterviewer/src/lib/kvClient.ts:251) consumes exactly `KV_REST_API_URL` and `KV_REST_API_TOKEN`; [mode selection](/Users/xulelin/Documents/Apps/openinterviewer/src/lib/kvClient.ts:334) chooses it for standalone requests. The runtime mode plus the production resource connection establishes the configured dependency without decrypting/comparing credentials or sending a Redis command.
- Hosted platform storage is separate, using `PLATFORM_KV_REST_API_*` at [kvClient.ts:265](/Users/xulelin/Documents/Apps/openinterviewer/src/lib/kvClient.ts:265). Hosted researcher BYOS is resolved per researcher at [researcherContext.ts:60](/Users/xulelin/Documents/Apps/openinterviewer/src/lib/researcherContext.ts:60). Neither is the observed canonical deployment's current mode. This pass did not enumerate other self-hosted installations or inspect hosted account records.

Reproducible metadata checks used: `vercel integration list openinterviewer --format=json --scope linxules-projects`; `vercel storage status store_AefOFHEtqOncLdF4 --project openinterviewer --json --scope linxules-projects`; `vercel integration-resource inspect openinterviewer-redis-v2 --json --scope linxules-projects`; and `vercel inspect https://openinterviewer.vercel.app --json --scope linxules-projects`. Provider inspection accepts the resource name; an initial store-ID lookup did not resolve. Only safe metadata fields were retained.

## What archival would affect

Removing this instance would make persistent researcher and participant workflows unavailable until restoration/reconnection: study loading/editing, participant link resolution and consent, transcript saves, deferred analysis, and stored-result review/export. [Participant links](/Users/xulelin/Documents/Apps/openinterviewer/src/lib/participantLinks.ts:340) also use the standalone store.

The public landing and [keyless demo contract](/Users/xulelin/Documents/Apps/openinterviewer/README.md:30) do not depend on this database. A functioning demo or READY deployment is therefore compatible with broken persistent workflows.

The current [Upstash inactivity FAQ](https://upstash.com/docs/redis/help/faq#what-happens-if-my-database-is-not-used) says free databases may be archived after at least 30 days of inactivity, with warnings beforehand. It describes restoration into a new database from the retained backup. This supports recoverability, not uninterrupted endpoint availability, and does not mean 30 days remain after this email. The exact archival date, backup-retention duration and this database's last-traffic timestamp were not established.

## What must be preserved

These are schema-based requirements; no participant record, key inventory, record count or data export was accessed.

- Complete study configuration/revisions and associated collection indexes.
- Interviews: transcripts, participant profiles/behavior, saved consent evidence, synthesis and deferred-analysis state, and conducting/requested/served model provenance. [Stored types](/Users/xulelin/Documents/Apps/openinterviewer/src/types.ts:290).
- Aggregate synthesis, participant links, indexes and relevant idempotency/operation records needed to restore application consistency. [Aggregate persistence](/Users/xulelin/Documents/Apps/openinterviewer/src/lib/kv.ts:1653).
- Retain existing secure application configuration and authorized account access for recovery. Do not copy tokens/signing keys into this report. If restoration creates a new endpoint, its connection configuration and the deployment will need an explicitly authorized update.

A full restorable database backup is broader than a transcript/CSV export. Existing backup presence, timestamp, size, coverage and retention remain unverified. Upstash's promise to back up on archival is not evidence of an independently verified backup for this instance. No assertion is made that the database is empty or contains real participants.

For any future hosted deployment, preservation would additionally include platform accounts, encrypted BYOS envelopes, ownership and operation journals plus the corresponding encryption keyring in its existing secure location; that is an architecture caveat, not a finding that this database currently holds hosted data.

## Recommendation and next trigger

1. **Now:** preserve the connection and data; no automatic upgrade, deletion, migration or keepalive. Treat the warning as a real production-dependency risk, not a Vercel deployment-retention issue.
2. **If persistent research must remain available while idle:** Xule should authorize a plan that retains the endpoint during inactivity, after confirming the actual Marketplace terms/cost and backup status. A paid retention decision is separate from this investigation. Do not substitute synthetic traffic for it.
3. **If the deployment is intentionally demo-only/dormant:** allowing provider archival can be reasonable only after Xule accepts persistent-workflow downtime and the account-specific backup/recovery requirements are established. Do not mark archival safe solely because a restore is advertised. The [backup/restore guide](https://upstash.com/docs/redis/features/backup) also says restore deletes existing data in its target, so any later restoration needs its own scoped plan/authorization.

Next owner: Xule for the availability choice; this project for any subsequently authorized backup/configuration work. Next trigger: that choice, a second/final Upstash notice, or before the next real interview/research session—whichever comes first. No invented deadline or automatic monitor.

## Access, coverage and preservation

No login gap blocked the dependency determination: the existing Vercel CLI session worked. The Vercel connector returned `INVALID_ARGUMENT`, so CLI metadata was used. Backup inventory and account-specific archival timing are evidence gaps, not a demonstrated login failure; no additional login, SSO, credential access or account setting change was attempted.

A targeted indexed Gmail search for “Upstash Inactivity” since 20 September returned only the first notice. Mail index observed at 12:05 CEST, last local reconciliation 12:00:41, no failed jobs/caps; one Outbox file was unindexed. Gmail provider synchronization is unknown, so absence of a second notice is bounded local evidence.

Only `/api/config/mode` was requested from the application after confirming its environment-only implementation at [route.ts:9](/Users/xulelin/Documents/Apps/openinterviewer/src/app/api/config/mode/route.ts:9). `/api/health/ready` was avoided because it PINGs Redis; `/api/config/readiness` was avoided because hosted lineage checking can read/write Redis. No Redis commands, synthetic keepalive, participant content/export, provider calls, application edits, account changes, deletion, commit/push/deploy, PR actions, external messages or job restarts occurred.

Written files: this report and the requested Daily Desk receipt. Existing favicon note and concurrent dependency-owner report were preserved. The dated desk note, Dependabot work and separate Vercel retention investigation remain with their owners. No test suite was run for this documentation-only investigation.

Recorded: 2026-09-23T12:07:57+02:00
