# Cloudflare analysis: researcher state and recovery slice

Status: implementation specification, 23 September 2026. This slice supports the [Cloudflare migration](../operations/cloudflare-migration/README.md). The [jobs specification](../operations/cloudflare-migration/03-analysis-jobs.md) owns HTTP fields, polling and server state; this file owns the user-visible result. It follows [DIRECTION-final.md](DIRECTION-final.md) and extends the existing save-first analysis workflow without a visual redesign.

## UI-CF-01 — Scope and presentation

Primary surfaces: `src/components/InterviewDetail.tsx`, `src/components/StudyDetail.tsx`, `src/services/analysisApi.ts`, `src/lib/analysisState.ts`, and their paired tests. Participant completion in `Synthesis.tsx` remains a durable-save receipt; it must not wait for researcher analysis or expose researcher polling/controls. The public demo and non-persistent researcher preview keep their existing contracts.

Use current `Notice`, `Button`, typography, status colors and focus behavior. Preserve transcript access, evidence reading, model provenance and export while analysis is pending or unavailable. Do not add infrastructure vocabulary, estimated completion promises, invented analysis, decorative animation or a new dashboard.

## UI-CF-02 — State and copy

| Confirmed server state | Researcher presentation and action |
| --- | --- |
| Legacy generation 0, `phase: 'not-scheduled'` | Existing “Analysis pending” explanation and enabled “Run analysis” action. Do not poll work that has never been scheduled. Imported execution uncertainty must not appear as this state. |
| Queued active generation | “Analysis queued” / “This interview is saved. Its analysis will run in the background.” No new-attempt action while it remains active. |
| Running active generation | “Analysis running” / “This interview is saved. Analysis is in progress.” Poll according to the jobs contract. Browser time alone never enables a Cloudflare retry. |
| Complete with synthesis | Existing reading/evidence/provenance UI. Refresh the record after confirmed completion; show the revision actually used. |
| Durably recorded ordinary failure | Existing safe failure-kind explanation and “Run analysis” action. Do not show SDK messages or raw output. |
| `recoveryRequired: true` | “Analysis needs recovery” / “This interview is saved, but we could not confirm the analysis result. Running it again may make another paid provider request.” An intentional “Run analysis again” action may create the next eligible generation. |
| Status read/request unavailable | Keep the last confirmed transcript and state. Explain that the latest status could not be checked; offer a read-only refresh. Never turn uncertainty into “failed”, “complete” or an empty register. |
| Polling budget ended with work pending | “Analysis is still pending. You can leave this page and check again later.” Read-only refresh remains available; stopping polling never cancels the job. |
| Old client/API contract | Explain that the page needs reloading before starting analysis. No automatic reload while participant answers could be lost; this action is researcher-side. |

Exact spelling can follow existing sentence-case conventions, but keep the information and safe distinctions above. Confirmed queued/running state and a request failure are separate signals; a failed GET does not erase the former. Recovery copy conveys the consequence inline without adding a repeated confirmation dialog.

## UI-CF-03 — Actions and polling

Generate one request key for each intentional action and keep it for retries of that action. Follow the API generation/precondition contract. A double-click or two views must not launch separate attempts. Successful `202` means accepted work, not a completed analysis. A poll or component mount performs only reads; it cannot spend money or create a generation.

Use the jobs specification's bounded polling schedule. Cancel browser timers on unmount/study change, pause when hidden/offline, and refresh when visible again. No stale response may replace the current interview/generation. Researcher navigation away does not cancel server work. The old Node synchronous result remains supported by the same API client.

Cloudflare retry eligibility comes from the confirmed server projection. Select the protocol through the public `analysisExecution` capability; absence means the legacy synchronous path. Preserve the old backend's behavior and do not send new status GETs to an older Node deployment. Do not apply a client-side 180-second lease assumption to the new backend.

## UI-CF-04 — Batch behavior

Keep the existing oldest-first, at-most-25 selection per press. Advance progress only after a confirmed terminal result for the selected interview. Continue after a durably recorded ordinary provider failure; stop on request/storage/auth/rate-limit uncertainty or when the polling budget expires. Work already accepted remains pending and is not resubmitted. Do not call the accepted count “analyzed”.

Unknown provider outcomes require the recovery disclosure before another paid attempt. If such an interview is included in a user-triggered retry batch, make that consequence visible before the batch action. Automatic polling or a batch already in progress must never silently turn a newly observed unknown outcome into a retry. Preserve existing study-operation-pending controls and avoid clearing a loaded table when its refresh fails.

## UI-CF-05 — Acceptance

- Component tests cover every row above, Node synchronous results and Cloudflare pending results, unknown execution, polling exhaustion, stale responses and remount/hidden/offline cleanup.
- Two researcher tabs and detail/batch actions against the real backend resolve to the same active generation; browser tests assert fixture provider counts.
- Closing the participant tab after save still permits server completion; transcript and consent stay immutable.
- Status announcements use a restrained live region; failures requiring attention use the existing alert pattern. Polling does not repeatedly steal focus or announce unchanged state.
- Keyboard controls remain usable, disabled states explain why, and 375px layouts preserve readable copy and existing minimum touch targets. Use reduced-motion behavior already provided by primitives.
- No changes to evidence color/serif semantics, consent copy, public demo network behavior, or participant receipt meaning. Existing design lint and relevant UI/a11y tests pass.
