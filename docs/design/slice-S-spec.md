# Slice S — Study lifecycle controls

## Prime directive

Pause, edit, export and permanent deletion do exactly what their names promise,
on every supported backend and under concurrency, failure and replay.

## Binding contracts

- Access toggles retain collection revision; config edits advance it, normalized
  no-ops do not. Apply the returned canonical study to UI after mutation.
- `deleteStudy` retains empty-only behavior unless `deleteInterviews: true` is
  explicitly confirmed by the researcher. Optional `expectedRevision` detects
  changed confirmation context. Populated deletion is a port operation, not a
  direct Redis route. Hosted deletion keeps its durable saga and repair path.
- A refused operation writes no blocking guard. Successful deletion removes
  records, indices, links, consents, aggregates, exploration artifacts and
  content-bearing pending jobs. Completion and late writes cannot resurrect it.
- Unbounded Redis loops are prohibited: bound atomic work or use a tombstoned,
  resumable purge. Pending work is reported truthfully and replay is safe.
- Study Settings offers Edit, Export this study and a Danger Zone with a second
  explicit permanent-delete confirmation. Offer export, do not require it.
- `/api/interviews/export?studyId=<id>` exports only the authorized study with
  the existing complete-archive checks and immutable snapshot guarantees.
  Optional `studyId` propagates through durable export operations/pages.
- Deletion affects the application's live store; external downloads, backups
  and already-started provider requests are not promised recalled.

## Gates

Real Redis/workerd completion-vs-delete and late-result regressions; hosted
reconciliation and owner isolation; scoped export completeness; full check and
both browser targets. Preserve unrelated studies and replay receipts/fences.
