# Slice R — Correct intent and safe researcher experimentation

## Prime directive

The UI acts on the study the researcher selected, preserves their unfinished
work and previews only an explicitly saved version.

## Scope

- `/setup` means new, regardless of the previous persisted study configuration.
- `/setup?prefill=edit&studyId=...` loads that canonical study; consumed session
  prefill cannot make reload fail or substitute another study's fields.
- `/setup?prefill=duplicate&studyId=...` copies configuration into a new intent,
  with no source id, interviews, links, consent, results or authority.
- New/edit/duplicate drafts are isolated by intent and source identity. Restore
  and discard are explicit and visible. Do not autosave live collection settings.
- Existing dirty/unsaved preview refusal stays intact. Draft loss on navigation
  is guarded; safe local restoration may use tolerant session storage.
- Dashboard requests are keyed to selection; only the newest request commits
  rows or failure state. A successful empty read is not an outage.
- Populated StudyList deletion navigates to the selected study's Settings at
  `/studies/<id>?tab=settings#danger-zone`; no direct force-delete call.

## Regressions

Save/preview A then create B; stored A then edit B with empty fields; reload edit
B after prefill consumption; duplicate A without mutating A; independent draft
restoration/discard; deferred A read after B; failure then confirmed empty read.

## Gates

Paired component/idempotency tests, lint/typecheck, researcher browser workflow,
desktop and 375px inspection. Preserve participant workflow and create receipts.
