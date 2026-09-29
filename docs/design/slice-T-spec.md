# Slice T — Explicit datasets and durable exploration

## Prime directive

Ask a new question of retained interview evidence, see exactly which records
answered it, and keep the result without rewriting the participant's record.

## Product/API contracts

- Study dataset selection names revisions, optional interview IDs and recorded
  profile predicates. Counts distinguish retained, selected, excluded and unknown.
- `GET/POST /api/studies/<id>/dataset` reads/preflights selection. Response includes
  the source manifest, available revisions/profile definitions and eligibility.
- `/api/studies/<id>/exploration` GET lists saved answer artifacts; POST accepts
  bounded question/scope and an Idempotency-Key. A replay returns the original
  answer/attempt, never another paid execution. Optional parentAnswerId supplies
  conversational continuity, but generated answers are not evidence.
- Question and corpus bounds refuse oversize inputs before execution. The first
  implementation uses full selected transcripts, not retrieval or hidden sampling.
- Provider payload is flexible answer text plus findings with supporting,
  challenging and uncertain quote claims, limitations, and no invented prevalence.
  Server resolves model-local interview positions to selected IDs and checks refs.
- New StoredInterview.collectionConfig is a server-owned original configuration
  snapshot. Legacy missing historical metadata stays unknown, never backfilled.
- Persist immutable answer scope and result/provenance. Refresh reads saved work.
  A signed server-issued save receipt permits save-only recovery after a confirmed
  generated answer could not be stored; it cannot authorize another provider call.
- Dataset changes label historical scope. Deleted/missing sources never produce
  verified citations; study deletion removes artifacts and fences late completion.
- Backups, imports, sample clearing and exports include notebook artifacts. SQLite
  adds a new migration with a reader floor that refuses unsafe older builds.

## Acceptance corpus

Pending/failed individual analysis with an overlooked theme; known/missing/vague/
refused profiles; numeric range ambiguity; supporting/challenging/ambiguous cases;
fewer defensible archetypes than requested; wrong-speaker/record/fabricated refs;
transcript instructions treated as data; oversize preflight zero calls; idempotent
replay zero extra calls; refresh retention; save-only retry; deletion during call.

## Gates

Pure dataset/evidence tests; API ownership/consent/budget/replay tests; provider
adapters; Redis/workerd persistence and migrations/backup; Node and built Worker
browser journeys; full clean-commit release matrix and scoped live smoke.
