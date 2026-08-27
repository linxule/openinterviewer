# Initiative 2 — EvidenceRef: making the trace real

Status: KICKOFF APPROVED by owner (2026-08-27), work begins after the Initiative 1 PR.
Orchestrator: Fable (Claude Code session). Pipeline: spec → Codex build → Fable + Kimi double review → visual pass → accept → commit, same as Initiative 1.

## Decisions of record (from DIRECTION-final.md and the challenge verdict — settled, do not re-litigate)

- **The schema change** (amendment A5, initiative 2): `theme.evidence` at `src/types.ts:171` (flat free-text string) is replaced by structured evidence references:
  `EvidenceRef { quote: string; turnIndex: number; interviewId: string }` (array per theme). Aggregate `representativeQuotes` gets the same treatment.
- **Validation is NORMALIZED matching, not naive substring** (the challenge's finding against exact-substring checks: faithful LLM paraphrases and whitespace/punctuation/curly-quote drift must not fail honest citations). Normalize both sides (case, whitespace, quote marks, ellipses) before matching the quote against the cited turn's content; a quote that cannot be located in its cited turn is rendered as an *unverified* passage (no wine), never silently dropped and never displayed as a trace.
- **Wine only when something is actually cited** (Law 2, slice-F-spec §F2): once an EvidenceRef verifiably points at a turn, the supporting passage graduates from the plain serif hairline block to the `Citation` primitive (wine numeral `t.N`, unfold note with quote + `Coordinate`). The Slice D demo insight view is the reference implementation of this grammar (A7: reuse `Citation`, never fork).
- **Where the trace UI lands first**: `InterviewDetail`'s Analysis tab (claims cite turns in the same record — `turnIndex` resolves against `interview.transcript`). `Synthesis`'s researcher/preview branch same grammar. StudyDetail aggregate needs `interviewId` resolution across records (trace opens the cited interview's turn — may be a later phase).
- **Participant branch stays apparatus-free** (A1) — no citations, no wine, ever.
- **Prompt change**: the synthesis prompts must ask the model for quote + turn index per theme. Prompt files under `src/lib/prompts/` (check AGENTS.md change-map gates — prompt changes likely have their own review requirements).
- **Backward compatibility**: stored interviews carry old-shape synthesis (flat `evidence` strings, `_receipt`-signed). The reader must render old records exactly as Slice F does today (serif passage, no wine). Do NOT rewrite stored records; do not break `_receipt` verification. A type-level union or a migration-on-read view — decide in the spec, and mind that receipts sign the original payload.
- **Deferred alongside** (owner may pull in): merged InterviewDetail single-surface reading (claims adjacent to turns); aggregate concordance; `divergentViews`/`researchImplications` rendering.

## Constraints

- This initiative touches types, prompts, services, and possibly API/storage — the AGENTS.md change-map gates apply in full (unlike Initiative 1's UI-only slices). Read AGENTS.md before speccing; every gate it names for `src/types.ts` / prompts / services must be honored.
- Never use production credentials or real participant content in tests (repo rule).
- The Initiative 1 ESLint design law is in force repo-wide: wine reaches UI only through `Citation`.
- Human validation (A9) is still owed on Initiative 1 and applies doubly here: the trace UI needs the researcher walkthrough before it is called done.

## First step (next session)

Draft `docs/design/initiative-2-spec.md` (likely 2–3 slices: I2a schema+prompt+validation with old-record compatibility; I2b InterviewDetail + Synthesis trace UI; I2c StudyDetail aggregate). Opus drafts against this brief + AGENTS.md; Fable reviews; the usual pipeline runs.
