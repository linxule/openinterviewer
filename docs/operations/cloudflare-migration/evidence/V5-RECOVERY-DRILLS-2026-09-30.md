# Version 5 remote recovery drills

Observed on 30 September 2026 (Europe/Paris; UTC timestamps span 29–30 September). This follows the [v5 rollout](V5-ROLLOUT-2026-09-30.md) and records installation-specific evidence, not certification of every recovery scenario.

## Scope and spending guard

Only the previously provisioned, isolated synthetic restore installation was changed. It served the checked `fde1bbaef1f73b1e3e8409e59e78967b7373238f` v5.0.0 artifact, schema 2, with a separate Worker, Durable Object and analysis Queue. Its initial corpus contained 18 synthetic studies and 15 synthetic interviews, with no active jobs. Production and maintained staging were not mutated.

Delivery on **that installation's analysis Queue only** was paused and the pause read back before saving one small synthetic participant transcript through the real link exchange, consent and save handlers. Greeting, interview-turn, preview, synthesis, exploration and retry endpoints were not called. A large transcript is not a spending guard: queued execution passes it to the provider. Paused delivery was the guard until verified recovery reconciliation made the job non-executable.

Credentials stayed in process memory and request headers; neither credentials nor raw tail output were persisted. Protected operational backups contain only this synthetic installation's data and remain outside Git. The tail receipt retains event types, timestamps, outcomes and allowlisted content-free application events.

## Unattended alarm

| Observation | UTC |
| --- | --- |
| Initial send acknowledgment, derived from the five-minute watchdog deadline | 29 September 23:48:50.967 |
| Early housekeeping alarm | 29 September 23:48:55.444 |
| Final write-free operator-status baseline | 29 September 23:49:04.894 |
| Watchdog alarm's platform `scheduledTime` | 29 September 23:53:50.967 |
| Tail observed successful watchdog alarm | 29 September 23:53:51.340 |

No object-directed request, browser polling, sign-in or analysis-status repair was made during the **286-second** baseline-to-alarm interval. Queue delivery stayed paused. The next operator read showed a pending job, zero claimed/started jobs and an advanced watchdog deadline. A subsequent frozen operational export confirmed the drill job was pending/sent, `dispatch_attempts: 2`, with `started_at: null`.

This proves alarm-driven redispatch after observed inactivity. It does **not** directly prove isolate eviction: the deployed object exposes no incarnation identifier, and a tail subscription is not an eviction instrument.

## PITR, undo and epoch fencing

The pre-restore workspace was frozen at maintenance version 3 with 20 studies, 16 interviews and one pending job: the extra studies were the transcript study and a later marker study. A complete nine-chunk backup and deployment metadata were recorded privately. The installation's external `ANALYSIS_RECOVERY_EPOCH` was rotated once using the runbook procedure, and `configuredMatches: false` was confirmed **before** any restore. The initial read during deployment propagation still matched; a later read established the hold. No old application version or epoch was reinstated.

Five bounded restore requests exercised two timestamp targets, repeat resolution and two undos:

- `--at 2026-09-29T23:49:04.894Z` returned both bookmarks, restarted the object and removed the later marker. It resolved to an earlier snapshot than the baseline: the transcript study existed, but its interview had not yet been saved. A valid study-create probe returned 503 under the epoch mismatch despite the restored maintenance state being `open`.
- Undo by the returned bookmark restored the frozen pre-restore state. All **nine chunk checksums**, including workspace metadata, matched the pre-restore export exactly.
- `--at 2026-09-29T23:53:52.000Z` restored the pending interview/job but not the later marker. The restored job retained its first-send deadline and one dispatch, illustrating that a timestamp is approximate rather than an exact transaction checkpoint. The overdue restored alarm was refused with `analysis.job` / `alarm` / `epoch-mismatch`.
- Repeating that same timestamp resolved to the **same bookmark**. Undo using the original pending-target restore's undo bookmark again restored all nine pre-restore chunk checksums exactly.
- While still held, recovery activation reported `activated`, reconciled exactly **one** unfinished job, and made the bound epoch match. The frozen export confirmed `state: recovery-required`, `next_due_at: null`, `started_at: null`, and no active jobs. Queue delivery was not resumed before these checks.

Cloudflare documents [time-to-bookmark resolution as approximate, and undo bookmarks as exact recovery targets](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api). Verify restored records against the intended recovery point; do not infer them from the timestamp supplied. Record the returned bookmarks before activation, when undo is still possible without another epoch rotation.

## Completion and limits

After delivery resumed, both retained old-epoch messages produced successful Queue invocations with `analysis.job` / `consume` / `epoch-mismatch`. Neither reached provider start or execution. The two drill studies were deleted through the confirmed-deletion API and then returned 404. Final exports matched the original studies, interviews, analysis, analysis-job and participant-link rows exactly: 18 studies, 15 interviews and 19 links. Identifier-only deletion fences and create receipts remain intentionally.

The checked installer redeployed the original v5 artifact after activation, preserving the new epoch. Cloudflare version `c9e5ed6e-5703-4c65-b4d2-667cb3def458` serves at 100%; the installer returned exit 3 for the intended maintenance hold, not a failed deploy. Final operator status reports `recovery`, maintenance version 8, matching epoch and zero pending/claimed/started/recovery-required jobs. Queue delivery is resumed. A retained alarm timestamp is not authority to run work while held. These are operational follow-ups, not a new application release or a rewrite of the v5.0.0 tag.

**No provider call was made.** The save was protected by confirmed Queue pause, activation terminalized the only new pending job before delivery resumed, stale envelopes were rejected before provider loading, and the drill job's start marker remained null. Tail evidence is corroborating telemetry, not the sole spending proof.

Read-only readiness checks of the maintained production and staging origins returned HTTP 200 with `ready: true` after the drill. Neither installation was written, restored, redeployed or rotated for this exercise.

The remote exercise does not cover a claimed/started paid attempt, late provider-result attachment, lost restore replies, rollback to an older epoch or an after-activation undo. Those fault boundaries remain locally tested; remote replay of late results would need its own bounded procedure. Optional CI-owned deployment remains unconfigured for the maintained installation, which is installer-owned. The isolated infrastructure is retained rather than deleted.
