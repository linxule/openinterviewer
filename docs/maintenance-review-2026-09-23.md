# Dependency investigation — 2026-09-23

## Current disposition — completed, 23 September 12:15 CEST

Xule subsequently authorized the recommendations with “ok! go with your recs.” This later authorization covers the narrow Tailwind hold and PR closure; it does not reopen the earlier multi-repository sweep.

- [PR #45](https://github.com/linxule/openinterviewer/pull/45) was closed, unmerged, at 10:09:57 UTC with the migration reason documented.
- [PR #48](https://github.com/linxule/openinterviewer/pull/48) merged at 10:13:31 UTC as `dc5c54207f5f8cfb7bbdc44e541fce6efb72af21`. Its only change is four lines in `.github/dependabot.yml`: an ignore rule for `tailwindcss` and `version-update:semver-major`. Minor/patch updates and security updates remain eligible. Dependabot's `IgnoreCondition#ignored_versions` bypasses update-type filters for security jobs; no explicit version exclusion was added.
- YAML parsing, duplicate-key checks, semantic comparison against the original config, and whitespace checks passed. [PR CI](https://github.com/linxule/openinterviewer/actions/runs/35847178278) and [final main CI](https://github.com/linxule/openinterviewer/actions/runs/35847553530) passed quality, browser, Redis crash-cut and adversarial checks. The Vercel preview also passed.
- [Native npm updater run 35847557502](https://github.com/linxule/openinterviewer/actions/runs/35847557502) succeeded against final main and its job definition includes the new Tailwind rule. Automatic security fixes were verified enabled and unpaused.
- The existing Git integration automatically deployed final main: [production `dpl_CTuatjJt3EYGVK8DrHyNxmu4uKuw`](https://vercel.com/linxules-projects/openinterviewer/CTuatjJt3EYGVK8DrHyNxmu4uKuw) is READY, with `openinterviewer.vercel.app` among its aliases. No manual deployment was submitted.

No application source, package versions, lockfile, credentials, account settings or other PRs were changed. Implementation used `/Users/xulelin/.codex/worktrees/openinterviewer-tailwind-hold-20260923`; the original checkout's tracked files and others' untracked favicon/operations work were preserved. Only this local report and the receipt were updated there; neither was included in the public PR.

Next trigger: an intentionally approved Tailwind migration or a relevant security advisory. No further action is required for this specific failed-preview notification. Daily Desk owns reconciliation of the completion receipt. Database inactivity and retention remain outside this task.

## Historical investigation — 23 September 12:02 CEST

The following records the earlier investigation and its then-current authority; the completed disposition above supersedes its request for authorization.

As of 23 September 2026, 12:02 CEST (10:02 UTC). Investigation only, scoped to the OpenInterviewer Tailwind Dependabot preview failure reported by Gmail Mail515156, received 18 September at 08:30:40 CEST. The mail details were supplied by Daily Desk; the mailbox was not reopened.

## Disposition

**Needs action: PR #45 remains open and broken.** The later suppression of Dependabot previews is already handled, but it does not fix or close this dependency PR. This is a preview/PR failure; current production is a separate READY deployment using Tailwind 3.4.18. The 14 September all-clear predates this new PR and does not cover it.

## Current evidence

- [PR #45](https://github.com/linxule/openinterviewer/pull/45), `dependabot/npm_and_yarn/tailwindcss-4.3.3`, was created 18 September at 06:26:01 UTC. It remains OPEN, unmerged and unclosed, at `e14d33459ea9d842eb2164026f061fed53b40842`; last update is 18 September 06:27:38 UTC. A paginated all-state PR listing found no other Tailwind-titled replacement. Current main still locks Tailwind 3.4.18.
- The PR changes only `package.json` and `package-lock.json`, moving Tailwind 3.4.18 to 4.3.3. Its unchanged `postcss.config.js` registers `tailwindcss` directly, and `src/app/globals.css` retains the Tailwind 3 directives. No migration accompanies the version bump.
- [GitHub CI run 35314858157](https://github.com/linxule/openinterviewer/actions/runs/35314858157) failed `browser` and `quality`; `redis-crash` and `adversarial` passed. The browser build failed at 06:27:04 UTC in `src/app/globals.css`: Tailwind reports that its PostCSS plugin moved to `@tailwindcss/postcss`, so the direct `tailwindcss` plugin registration is invalid. Quality fails with the same CSS error in `providerSetupCopy.test.tsx` and three `layout.viewport.test.ts` tests (173 test files passed, two failed; 1,619 tests passed, three failed).
- The [Vercel PR status/comment](https://github.com/linxule/openinterviewer/pull/45#issuecomment-5726087244) records the [failed preview](https://vercel.com/linxules-projects/openinterviewer/GyvDbQV1Ry81qwQzFkJtZt1oBtX9) at 18 September 06:27:38 UTC (08:27:38 CEST), matching the alert's branch and commit.

**Failure-evidence limit:** Vercel's deployment lookup now returns 404, and the authenticated CLI cannot find that deployment. The connector's build-log operation was also unavailable. The original Vercel build log therefore could not be recovered. The PostCSS incompatibility is directly confirmed by both CI jobs on the same PR; attributing the Vercel failure to that same build blocker is a strong inference, not a recovered Vercel-log observation. This pass did not determine why the deployment is no longer retrievable or investigate retention.

## Production and changes already made

[Current production](https://vercel.com/linxules-projects/openinterviewer/Cz5TCcn9kbNJRiSRfndYvxiLTQ2V) is `dpl_Cz5TCcn9kbNJRiSRfndYvxiLTQ2V`, target `production`, state READY, source `main` at `4d3076528681862cda21d0b2c80d1ae2ce9faeda`. Vercel reports alias `openinterviewer.vercel.app`, no alias error, and READY since 18 September 23:51:57 CEST. This is deployment-state evidence, not a test of the database, provider availability, or participant workflows.

[Commit ca8257c](https://github.com/linxule/openinterviewer/commit/ca8257c05dd556fd3127272ba79b7ca00a0e0fd8), made 18 September at 23:21:10 CEST, added `vercel.json` with `git.deploymentEnabled["dependabot/**"]: false`. Main's README documents this policy. It postdates the failed preview by about 15 hours. It addresses future preview creation, not the Tailwind migration or GitHub CI. No new push was made to test suppression in this investigation.

## Existing major-version policy

[The 5 September maintenance review](maintenance-review-2026-09-05.md) explicitly defers broad Tailwind major upgrades until there is a concrete compatibility benefit and dedicated migration checks. It also records why `tailwind-merge` stays on 2.6 for Tailwind 3. The policy therefore covers this upgrade substantively.

Current main's `.github/dependabot.yml`, verified against GitHub, has minor/patch groups but no major-version `ignore` rule. Group membership does not disable unmatched upgrades; GitHub documents that unmatched updates get individual PRs. See the [Dependabot options reference](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#groups). Thus the policy is not enforced as an automated major-update exclusion.

## Recommended next step and owner

OpenInterviewer maintainer/Xule: authorize closing #45 as a deferred incompatible major and, if recurring major PR noise should be prevented, a narrow `tailwindcss` / `version-update:semver-major` version-update hold. Keep security maintenance active; do not apply a blanket dependency exclusion. This recommendation was not executed.

Revisit when a Tailwind 4 migration is deliberately approved or a relevant security advisory changes the priority. A real migration needs the PostCSS package/configuration, CSS entry and configuration compatibility, class-merger compatibility, and focused visual/browser checks, followed by the repository's build/test gates. Installing the new plugin alone does not establish a complete migration; see the [official Tailwind upgrade guide](https://tailwindcss.com/docs/upgrade-guide).

## Scope and filing

Only this report and the Daily Desk receipt were written. No app/config edits, install, build, test rerun, PR mutation, commit, push, deployment, deletion, account change, credential fetch, external message, or paid provider call was performed. Existing untracked `docs/design/favicon-follow-up-2026-09-07.md` was preserved. Other repositories, other dependency PRs, Upstash inactivity, and Vercel retention were not investigated.

Receipt: `/Users/xulelin/Documents/Apps/daily-desk/desk/receipts/2026-09-23-openinterviewer-dependabot.md`. Daily Desk owns reconciliation into its current view; this report does not edit that shared note.
