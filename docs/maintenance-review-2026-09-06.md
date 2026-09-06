# Maintenance review — 2026-09-06

Four parallel reviews covered the recent save-first work, analysis storage,
researcher recovery, and provider adapters. The starting revision was `bdd87e7`.
The clean baseline passed lint, typecheck, and 1,511 unit tests. This review used
source code and synthetic local fixtures; it did not inspect a live deployment
or call a paid provider.

## Assessment of the recent Claude changes

The core solutions are sound within the reviewed source and test boundaries:

- `7438d08` saves the transcript before scheduling analysis, retains participant
  authority and researcher ownership checks, and uses an atomic claim to prevent
  stale writers. Its `after()` usage matches the installed Next.js documentation.
  The specification explicitly permits a researcher to analyze an older interview
  with the current study configuration.
- `6610af3` applies the study-selected model to interview synthesis, aggregate
  synthesis, and follow-up generation across all five adapters.
- `d73bde7` and `62ef595` limit schema sanitization to the direct Gemini adapter;
  the removed schema bounds remain enforced by runtime validation.

The save-first review found recovery and concurrency edge cases despite the
passing baseline. The parser and missing-model issues below predate those changes.

## Changes

| Change | Reason and verification boundary |
| --- | --- |
| Count attempts in the atomic Redis script | A delayed contender could read an old count and later overwrite newer attempt history. A deterministic real-Redis interleaving now covers this race, lease takeover, and stale writes. Completion and failure preserve the attempt-start timestamp. |
| Remove redundant transcript reads | Claim, completion, and failure each use one Redis command instead of a GET followed by EVAL. A normal analysis pipeline uses three storage commands instead of five, excluding route authorization and study loading. This is a command-count reduction, not a measured production latency claim. |
| Preserve storage uncertainty | Redis outages return retryable HTTP 503. A provider failure is reported as recorded only after its conditional write succeeds. Lost write responses respect an already-completed record instead of reporting a false failure. |
| Share a typed analysis client | Both researcher screens handle HTTP, network, and malformed-response failures consistently. A batch stops on a request failure and retains its loaded register; a recorded per-interview provider failure still allows the remaining batch to proceed. |
| Recover from standalone detail URLs | The analysis request uses the fetched interview's study id, including when the original detail URL has no study query. |
| Preserve JSON string content | The shared parser tracks quoting and escapes, so braces and embedded Markdown fences inside valid provider output remain intact. Malformed output still fails validation. |
| Require actual served-model metadata | Direct adapters reject missing or blank response models instead of substituting the requested alias. Regression cases cover all four direct adapters and preserve dated model snapshots. |
| Name provenance by its current responsibility | `synthesisReceipt.ts` becomes `synthesisProvenance.ts`; the remaining validator no longer suggests that signed browser receipts are part of completion. README and contributor/agent guidance now describe save-first behavior. |

## Dependency and architecture decisions

Dependencies remain unchanged. Registry checks found newer releases, while both
the production and complete npm audits reported no vulnerabilities. None of the
selected fixes needs a package upgrade. The existing Tailwind 3 compatibility
choice and the previous review's migration boundaries remain in place.

The shared client and provenance module address current responsibilities without
splitting the larger components or storage module solely by line count. Wider
modularization and package migrations remain separate work requiring a concrete
behavioral or compatibility benefit.

## Verification

Completed with Node 24.19.0, a fresh `npm ci`, no inherited application
credentials, CI fixture configuration, and runner-owned disposable Redis:

- `npm run check`: lint, typecheck, and 172 unit files / 1,565 tests passed.
- `npm run test:setup`: 17 tests passed; demo, standalone direct, Gateway, and
  hosted setup contracts passed.
- Full and production npm audits: zero vulnerabilities.
- Standalone direct, standalone Gateway, and hosted production builds passed.
  The direct build was the browser launcher's production-build prerequisite.
- `npm run test:e2e`: all five Chromium scenarios passed on the final run.
  The real application routes cover save-first completion, deferred failure,
  researcher recovery without a study query, storage refusals in single and
  batch analysis, export, and aggregate synthesis. Both researcher error
  surfaces were visually inspected at 375px and passed overflow checks.
- `npm run test:redis-crash`: 30 tests passed; `npm run test:adversarial`:
  24 tests passed.
- Independent reviews of the final storage, API, and UI changes found no
  unresolved actionable issues. `git diff --check` passed.

The first expanded browser run exposed an assertion that also matched Next's
page-announcement alert. Scoping it to the analysis panel fixed the test; the
application had already completed recovery successfully.

## Operational scope

There is no storage migration or participant workflow change. Existing counters
that were previously undercounted cannot be reconstructed; future attempts
increment the stored count atomically. Missing served-model metadata now causes
an analysis failure, retaining the transcript for researcher recovery.

The work is isolated on `codex/maintenance-review-20260906` at
`/Users/xulelin/.codex/worktrees/openinterviewer-review-20260906`. The original
checkout's untracked duplicate files and user-owned `.claude/` directory were
preserved. No credentials, external data, push, merge, or deployment were involved.
