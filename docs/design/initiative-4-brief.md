# Initiative 4 — Researcher control and evidence exploration

Status: implementation authorized by Xule, 2026-09-29. Release candidate: 5.0.0.

## Prime directive

The researcher controls collection, retained data and analytical questions as
distinct operations. Participant words remain the primary record. Generated
interpretation is inspectable, source-bound, durable and never consent authority.

User feedback: interviewer manner works well; populated-study deletion is
missing; researchers need archetypes, recorded-profile segments, hypothesis
evidence and unexpected themes from the same interviews. Contributor reference:
https://github.com/8888oukaouka-spec/openinterviewerver02 . Adapt the interaction,
not the fork's non-atomic Redis force-delete or unconditional revision-filter removal.

## Slices

- R: explicit study intent, draft safety and truthful asynchronous selection.
- S: reversible access pause, no-op saves, study-local editing/export/deletion.
- T: explicit compatible datasets and durable transcript-backed exploration.

## Binding decisions

1. A real collection-configuration edit still advances revision and invalidates
   older participant authority. Pause/resume changes access, not the protocol
   revision. Paused entry, provider use and completion remain refused. Revoked
   or expired links and mismatched consent never revive on resume.
2. Normalized no-op configuration saves do not advance revision. Existing name
   and description are not assumed researcher-only metadata.
3. New/edit/duplicate intent is explicit. A session's previous study cannot
   determine the target of a new or different edit. Canonical edit loading is
   authoritative; draft restoration is keyed to that exact intent.
4. Existing overview remains available. Dataset scope is explicit: revisions,
   selected interviews and recorded-profile predicates. Missing/vague/refused
   fields remain unknown. No inferred age/gender and no retroactive historical
   schema reconstruction. New records snapshot their collection configuration.
5. All selected saved transcripts can be explored, including pending/failed
   individual analysis. Exploration reads original transcripts, not only prior
   summaries. Prior answers are not interview evidence.
6. Every selected source passes ownership, provider-commitment and transport
   disclosure checks before provider use. Unsupported selections are refused;
   no silent exclusions, truncation, fallback provider or hidden sampling.
7. One explicit question starts at most one provider attempt. Idempotent request
   replay does not call again. Uncertain execution requires a deliberate new
   attempt. Charge the researcher budget before execution and record actual
   provider/model/transport. Bound corpus and result sizes before admission.
8. Exploration answers are study-owned saved artifacts with exact source scope,
   question, structured interpretation/citations and provenance. Quotes resolve
   against selected participant turns; quotation location is not claim validity.
   Historical scope remains visible after later collection/configuration edits.
9. Populated deletion explicitly confirms the study and all live research data.
   Deletion fences completion/late analysis and removes notebook artifacts.
   Refusal has no side effects. Preserve hosted operation/reconciliation authority.
   Bounded purge may report pending; never claim permanent completion early.
10. Study export is available without exporting unrelated studies. Archive and
    operational backup/import contracts include new artifacts. Schema migration
    must refuse unsafe older readers that omit new data from deletion/backup.

## Product boundaries

No voice, autonomous tools, cross-study knowledge base, embeddings service,
demographic inference, mandatory demographic collection, automatic retention,
trash/undo, fixed methodological mode menu, or separate analysis-model override.
Question-driven interaction uses the existing document/citation vocabulary.

## Verification and delivery

Focused realistic regressions precede full repository/Redis/workerd/browser
gates. UI is inspected at desktop and 375px. Release candidate is committed and
the full clean-commit Cloudflare release matrix produces the deployment receipt.
No production data, credentials or external writes are used for fixture tests.
Paid live smoke requires explicit provider-scoped authorization. Commit authority
is granted; publication/production deployment is a distinct final action.
