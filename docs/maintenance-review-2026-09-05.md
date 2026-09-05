# Maintenance review — 2026-09-05

Three independent audits covered backend structure and collection loading, frontend rendering and state, and dependency compatibility. The selected changes reduce demonstrated work or remove unused code. This is a source and local-test review, not a production performance measurement.

## Implemented

| Change | Evidence and benefit | Verification boundary |
| --- | --- | --- |
| Memoize saved interview turns | Four composer edits previously reparsed two existing Markdown turns eight times. Primitive role/content props now avoid those parses while still updating changed messages. | Real Markdown rendering during typing, sending, receiving, and history replacement; existing greeting, keyboard, completion, and session tests. |
| Apply one hosted interview budget across all studies | The 1,000-interview list limit and 500-interview export limit previously reset for each study. Later studies now receive the remaining budget, and oversized results return the existing 413 outcome. | Actual collection loader with synthetic Redis responses; exact limits, empty trailing studies, authority before BYOS, and refusal before overflow payload reads. |
| Remove dormant v1 platform operations | Repository-wide reference checks found no application or script callers of the old operation and ownership API. Removed 500 implementation lines plus obsolete tests/mocks; current V2 Lua and account/credential flows are unchanged. | Existing V2 operation, authority, credential, account-deletion, crash-cut, and adversarial tests. |
| Patch Next.js and its lint config | Both move from 16.3.1 to 16.3.4, including the matching SWC/env/plugin packages and sharp patch. | Standalone direct, standalone Gateway, and hosted builds; full unit and browser gates. |
| Remove unused lucide-react | No imports remain. Removes 3,509 package files / approximately 27.14 MiB unpacked; this is an installation saving, not a measured browser-bundle saving. | Clean npm install, typecheck, lint, builds. |
| Match the class merger to Tailwind 3 | tailwind-merge 3 targets Tailwind 4. Version 2.6.1 correctly resolves `focus:outline-none focus:outline` to the caller's `focus:outline`. | Focus-outline override regression, existing UI primitive tests and browser suite. |
| Patch build-tool transitive dependencies | Targeted Browserslist and postcss-selector-parser updates clear the high/low advisories reported by the full npm audit. Their normal dependency ranges are retained; no overrides were added. | Fresh lockfile install, audit, lint, and builds. |

Next's [August security release](https://nextjs.org/blog/august-2026-security-release) and [16.3.4 release notes](https://github.com/vercel/next.js/releases/tag/v16.3.4) justify the framework patch. Source inspection found no `next/image` imports or Pages Router; this review does not establish an exploitable deployed application path. The class merger's [compatibility guidance](https://github.com/dcastil/tailwind-merge/tree/v3.6.0#readme) recommends the 2.6 line for Tailwind 3. The transitive updates address the [Browserslist advisory](https://github.com/advisories/GHSA-c83g-rgw3-j3cx) and [selector-parser advisory](https://github.com/advisories/GHSA-w9m9-85wc-3x92).

The hosted cap is an intentional behavior correction: a workspace whose combined result exceeds the limit now fails as a whole instead of materializing every individually small study. Researchers can use a study filter. The export service's preexisting silent-null handling of a 413 remains a separate UI follow-up. Removing v1 code requires no migration: the existing README already requires a clean V2 namespace and forbids using pre-v2 code against V2 research data.

## Next candidates

| Priority | Candidate | Required evidence before shipping |
| --- | --- | --- |
| Next | Ignore superseded Dashboard requests | Deferred A/B responses must leave B's rows, warnings, and loading state visible after selecting A then B. Guard every state write, including error/finally paths. |
| Next | Narrow root PreviewBanner and chat store subscriptions | Use stable selectors or Zustand's shallow helper. Keep preview exit, participant isolation, and persisted workflow behavior unchanged; demonstrate fewer unrelated renders. |
| Later | Batch independent owned-study authority and record reads | Measure a fixed concurrency limit (for example, 8); finish all authority checks before any BYOS read, preserve deterministic errors, and prove zero BYOS access when any authority is blocked. Do not parallelize interview loads across the shared budget. |
| Later | Move the preview banner into participant layouts | Compare actual public route chunks first. Route-group changes need direct-entry, phase-navigation, preview-exit, and no-persistence demo tests because mounting boundaries change. |
| Later | Reuse evidence normalization within one citation resolution | `locateQuote` and `countOccurrences` currently normalize the same turn and quote twice. Benchmark a synthetic long transcript; retain original-record span fidelity, Unicode behavior, and render-time-only verdicts without caching participant content globally. |

Broad Tailwind, TypeScript, ESLint, test-runner, provider SDK, and authentication major upgrades are deferred. Each needs a specific compatibility benefit and its own migration checks. Review compatible package families together, retain the authoritative npm lockfile, and consult official security releases alongside npm audit: the audit database did not flag the older Next patch during this review.

## Validation

Completed using Node 24.19.0, an environment without inherited credentials, the safe CI fixtures for deployment contracts, and runner-owned disposable Redis instances. No production data or deployment was involved.

- `npm ci`: fresh install succeeded; full dependency audit reported zero vulnerabilities. The production-only audit also passed.
- `npm run check`: lint and typecheck passed; 130 unit files / 1,154 tests passed, including the added class-override, rendering, aggregate-cap, and index-growth regressions.
- `npm run test:setup`: 17 passed; demo and all three production configuration contracts passed.
- Gateway and hosted production builds passed on Next.js 16.3.4. The standalone direct production build passed as Playwright's web-server prerequisite.
- `npm run test:e2e`: the repository's one Chromium test passed, covering the keyless demo's research loop and lack of API/external requests. Participant and researcher behavior in this change is covered by unit tests, not a live-provider browser run.
- `npm run test:redis-crash`: 14 passed. `npm run test:adversarial`: 23 passed across the in-memory and real-Redis suites.
- Independent frontend and backend diff reviews found no actionable issues; `git diff --check` passed.

## Follow-up: completion and researcher workflows

A report from someone running a local deployment prompted a separate completion audit. Their version, transport, and error output were unavailable, so these findings do not establish which defect they encountered. The earlier maintenance changes above did not address completion.

Three defects were reproduced and fixed:

- Gateway synthesis produced mapped model IDs and creator-route provenance that receipt validation rejected. Participant saves then failed after successful synthesis, and aggregate receipt creation also failed. A shared provenance validator now accepts the known Gateway mappings with the exact creator route, independently of the current deployment transport. Native, OpenRouter, and legacy receipt checks remain intact.
- Completion replaced a null participant profile after synthesis had signed it, regenerated fallback submission identity/time on retries, and allowed late analysis responses to affect a superseding session. The component now saves its captured analysis inputs, retains stable fallback identity/time, and ignores superseded responses. Preview users can export their transcript when analysis fails.
- The first real-storage browser run exposed Redis Lua re-encoding valid empty arrays as objects while updating the study's interview count. The initial save succeeded, but canonical study validation failed on refresh and for the next participant. Completion, link toggles, and config replacement now patch selected JSON fields without re-encoding untouched values. The shared helper uses portable Redis Lua; atomic guards and recovery cuts remain unchanged.

The browser suite now connects real application routes, signed receipts, and runner-owned Redis. Both standalone direct and Gateway journeys create a study, use separate participant sessions, recover from synthesis and storage failures, refresh saved submissions, verify exactly two interviews, download transcript and JSON, and run aggregate synthesis. Preview recovery is checked at 375px, including transcript export and zero saved research records. External provider HTTP responses are synthetic; deployed application configuration never enables the test proxy.

The storage fix prevents new corruption. It does not repair study records already damaged by older versions; those need inspection and recovery from known-good configuration. No external deployment or stored research data was inspected or changed. Live provider availability, model quality, hosted OAuth onboarding, and actual deployed configuration remain outside this browser coverage.

Follow-up verification passed with Node 24.19.0 and synthetic fixtures:

- `npm run check`: lint, typecheck, and 132 unit files / 1,190 tests.
- `npm run test:setup`: 17 tests; demo, direct, Gateway, and hosted setup contracts.
- Standalone direct, standalone Gateway, and hosted production builds.
- `npm run test:e2e`: five Chromium scenarios. The subsequent launcher readiness change also passed a focused startup/shutdown check for both transport servers; the 375px preview recovery screen was visually inspected.
- `npm run test:redis-crash`: 19 tests; `npm run test:adversarial`: 23 tests.
- Independent completion, receipt, and Redis diff reviews found no actionable issues; `git diff --check` passed.
