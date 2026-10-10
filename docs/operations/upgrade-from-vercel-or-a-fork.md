# Upgrade from Vercel or a fork to OpenInterviewer on Cloudflare

This guide moves an older OpenInterviewer deployment on Vercel with Upstash Redis, including a fork with local changes, to the current upstream release on Cloudflare. You or your coding agent can follow it step by step. It routes you to the detailed runbooks rather than repeating them.

The recommended path is a clean start. Researchers export their data from the old deployment, you install upstream on Cloudflare, and studies begin again there. Moving the old records into Cloudflare is not possible yet, because the importer it needs has not been built.

## Who this is for and where you end up

This guide is for you if:

- your deployment runs on Vercel or another Node host and stores research records in one Upstash Redis database
- its `/api/config/mode` endpoint reports `standalone` (for `hosted`, stop: see [TRANSITION.md §1](cloudflare-migration/TRANSITION.md#1-select-the-target))
- it runs an older upstream release, or a fork of one

You end up with the same setup as the project's own instance:

- the latest upstream release (5.4.0 when this guide was written), unmodified
- a staging and a production installation on Cloudflare Workers, each with its own Durable Object workspace and analysis Queue
- both installed and updated only by the checked-in installer, `npm run setup:cloudflare`, from your own computer
- a Durable Object jurisdiction you choose once (`eu` recommended), and optionally your own Cloudflare AI Gateway and a custom domain

### What it takes

You need:

- a Cloudflare account with a Workers Paid subscription (recommended, because the Free plan allows 10 ms of CPU time per request; see [Choose a Workers plan](../self-hosting-cloudflare.md#choose-a-workers-plan) and [Cloudflare's Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/))
- an API key for each AI provider you will use, billed by that provider as before
- for the optional AI Gateway, 2 tokens you create in the Cloudflare dashboard (the gateway does not change provider billing: every request still carries your own key)
- a computer with Node.js 24.19 or newer, npm, git, a local `redis-server` or Docker, and Playwright's Chromium (`npx playwright install chromium`), for the local release check
- a password manager that can pipe secrets to a command, such as 1Password's `op`

Most of the elapsed time is waiting. The old deployment needs at least 4 hours after the last invitation you expect to be used, so that open interviews can finish. The hands-on work is a few hours: the release check, a staging install, the production install and the switch. The acceptance test at the end makes a small number of paid provider calls.

## Rules for the coding agent

These rules apply to every step. They repeat the hard rules in the [Cloudflare agent skill](../../skills/openinterviewer-cloudflare/SKILL.md#hard-rules) and [TRANSITION.md](cloudflare-migration/TRANSITION.md).

Get the operator's explicit authorization before each step that:

- reads production data, including the Redis inventory
- changes production data or settings, including turning participant links off
- creates or changes Cloudflare resources (`apply`, `resume`, `update`)
- resets the Upstash credentials or changes Vercel settings
- switches the address researchers or participants use
- makes a paid provider call, including the acceptance test
- deletes anything

A plan (`setup:cloudflare plan`) is read-only and needs no authorization beyond running it.

Handle credentials this way:

- pass them to commands only on stdin from a password manager, or let the operator type them at a hidden prompt
- never put them in a command-line argument, an environment dump, a file inside the checkout, a log, a commit or the chat
- never read the operator token file the installer writes, and never enumerate a password vault
- fetch a secret only when the operator asks you to

Stop and ask the operator when:

- the installer refuses (exit 2), reports a collision or drift, or `verify` fails
- the checkout is not clean, or a `.env*` file is in the repository root
- the Redis inventory exits 1 or 2, or exits 3 for a reason this guide does not expect
- any check in [TRANSITION.md §6](cloudflare-migration/TRANSITION.md#6-fence-the-old-writers-reset-the-upstash-credentials) fails
- a step would delete data or resources, change DNS, or change the jurisdiction
- anything differs from what this guide or the runbooks describe

Run every tool from a clean upstream checkout. Never run scripts from the old fork against production.

## Decide the data path first

Choose before you install anything. Base the choice on the read-only inventory of the old database ([TRANSITION.md §2](cloudflare-migration/TRANSITION.md#2-inventory-the-old-storage)), run with authorization. Record the decision, who approved it and the inventory it rests on ([TRANSITION.md §3](cloudflare-migration/TRANSITION.md#3-choose-the-data-path)).

### Clean start: supported today

The new workspace starts empty. Before the switch, researchers download what they need from the old deployment. After the switch, they create their studies again on Cloudflare and send new participant links.

The old Upstash database is fenced but not changed or deleted. It stays as your preserved copy until you decide to retire it.

### Preserve data: not available yet

Moving existing studies, interviews and links into Cloudflare needs an Upstash-to-Cloudflare importer. It is specified in [TRANSITION.md §8](cloudflare-migration/TRANSITION.md#8-preserve-data-runbook) but not built. Keeping old participant links working would also need a redirect-only origin backed by the preserved link records, which is not built either.

If you need the old records inside the new instance:

1. Take the clean-start exports anyway, so that nothing depends on the importer.
2. Keep the old Upstash database after the fence. Do not delete it. Keep its new credentials in your password manager.
3. Open an issue upstream (see [Get help](#get-help)) and say what you need preserved.

A fenced database receives no traffic. Upstash may archive a free database after 30 days without traffic ([Upstash FAQ](https://upstash.com/docs/redis/help/faq#what-happens-if-my-database-is-not-used); see also [the project's own note](2026-09-23-upstash-inactivity.md)). Check your plan before relying on it as the preserved copy.

### How a fork's extra data affects either path

A fork can store data that upstream does not know. Upstream handles unknown data in one of 3 ways:

- it ignores an extra field
- it refuses a study whose configuration has an unknown field (fails closed)
- its inventory tool counts keys it does not own as `unrecognized`, and marks invalid records of a family it does own

For any fork, compare the fork's `src/lib/kv.ts` and `src/lib/studyConfigValidation.ts` with upstream's, then read the inventory's `incompleteReasons`, `unrecognizedKeys` and `unrecognizedPrefixes`.

For the [openinterviewerver02](https://github.com/8888oukaouka-spec/openinterviewerver02) fork, we checked its `main` branch (commit `90b8417`, October 2, 2026). It is upstream v2.0.0 plus selected later upstream commits, up to the 4.2.0 provider setting, plus its own features. It has no Cloudflare target. Its only Redis writes outside upstream's layout are in `src/lib/kv.ts`:

| Fork data | What current upstream does with it |
| --- | --- |
| `project:<id>` keys, stored as plain JSON with a `studyCount` field | Upstream uses the same key names with a different format (`oi:project:` prefix and exactly 4 fields). It treats every fork project as unreadable, so the project list fails and the study list shows the flat list with a notice. A fork project cannot be renamed or deleted through upstream. The inventory counts them as invalid projects and exits 3 with `project-records-invalid`. |
| the `all-projects` set | Same name as upstream's index. It holds the fork's project ids, so upstream's list fails while any fork project is in it. |
| `project-studies:<id>` sets | Upstream never reads them. The inventory counts them as unrecognized keys with the label `project-studies:`. |
| `projectId` on a study record | Ignored. Upstream keeps project membership in separate `study-project:<id>` keys. |
| study records rewritten as plain JSON (without the `oi:study:` prefix) | Read normally: upstream accepts unprefixed legacy studies. |
| `aiSynthesisModel` in a study's configuration | Refused. The fork adds it to every Gemini study saved since September 1, 2026. Upstream's configuration allowlist does not include it, so participant access, link creation and analysis retries fail closed, and saving the study fails with "Invalid study configuration fields". |

We confirmed this table against a disposable local Redis seeded with records in the fork's format, on October 10, 2026. It has not been run against a real fork database.

What this means for each path:

- Clean start: none of this data reaches Cloudflare. The only effect is on the inventory in [TRANSITION.md §2 and §6](cloudflare-migration/TRANSITION.md#2-inventory-the-old-storage), which requires a complete report (exit 0). With fork projects present it exits 3. This guide accepts exit 3 only when `incompleteReasons` is exactly `["project-records-invalid"]` and `unrecognizedPrefixes` lists only `project-studies:`. That is a deviation from TRANSITION.md: record it with the operator's approval, and still compare the `families` table as §6 check 5 describes. Any other reason is a stop.
- Preserve data: a future importer would also need a decision for each fork-only item: drop `aiSynthesisModel`, translate fork projects into upstream projects and memberships, and discard the `project-studies:` sets. Say so when you ask upstream.

## Move the code to upstream

Do not merge upstream into your fork. The fork and upstream have diverged, and upstream has since reimplemented most fork features against different storage and consent rules. Start from a fresh clone of upstream at the latest release tag:

```bash
git clone https://github.com/linxule/openinterviewer.git openinterviewer-upstream
cd openinterviewer-upstream
gh release list -R linxule/openinterviewer -L 1   # the latest release tag
git checkout <latest tag, for example v5.4.0>
```

Keep the fork checkout separately, for reference only.

### What happened to the openinterviewerver02 features

[ACKNOWLEDGMENTS.md](../../ACKNOWLEDGMENTS.md) records how each idea reached upstream. None of the fork's code was imported; upstream wrote its own versions.

| Fork feature | Upstream equivalent | Release |
| --- | --- | --- |
| Delete a study and its interviews (`b42f8db`) | Danger Zone in study settings, with 2 confirmations and cleanup of links, aggregate and notebook | [5.0.0](../releases/v5.0.0.md) |
| Aggregate analysis across revisions (`8f3fe57`) | Explicit historical dataset selection | [5.0.0](../releases/v5.0.0.md) |
| Prompt-level language handshake (`44fed5c` and follow-ups) | Interview Languages: participants choose one of 6 languages before consent, and consent is bound to that language | [5.1.0](../releases/v5.1.0.md) |
| Analysis in the researcher's language | Per-installation analysis language (`--analysis-language`) | [5.2.0](../releases/v5.2.0.md) |
| Web Speech microphone with a language picker (`3e3e999`, `9e3de91`, `3e5f1f5`) | Voice Input: browser dictation, or transcription by the installation (Workers AI) | [5.1.0](../releases/v5.1.0.md) |
| Voice that stays on the participant's computer | On-device voice input in desktop Chrome | [5.4.0](../releases/v5.4.0.md) |
| Markdown export of a study's transcripts (`2ce177b`) | **Export transcripts (.md)** | [5.1.0](../releases/v5.1.0.md) |
| Projects with an accordion, **+ Study** and a ··· menu (`dd553c3`, `7ed1eee`, `561f7fd`) | Projects, with project Markdown export | [5.3.0](../releases/v5.3.0.md) |
| Files for further analysis | An `analysis/` folder (JSONL and CSV) in every study ZIP | [5.4.0](../releases/v5.4.0.md) |
| Per-study Gemini synthesis model (`aiSynthesisModel`) | No equivalent. Synthesis always uses the study's own provider and model | Not adopted |

The fork's interviewer manner, analysis writer, self-hosted fonts and provider setting were upstream commits already.

### Keep a local change you still need

Do not carry a local patch on your Cloudflare installation. A modified checkout is a different release from the one upstream checks, and every update would need the patch again.

If you still need a change, such as the fork's interview input layout, propose it upstream. Follow [CONTRIBUTING.md](../../CONTRIBUTING.md): open an issue that describes the need, or a pull request with a regression test, and credit the original commit.

## Skip the in-place Node upgrade

You could first upgrade the existing Vercel deployment to upstream, still on Node and Redis. Do not do this for the openinterviewerver02 fork's data. It gains nothing for a clean start, and with that data it would:

- block every Gemini study the fork saved since September 1, 2026: participants, new links and analysis retries are refused, and the study cannot be saved to fix it (a new study created from its settings works)
- lose the project grouping, and leave fork project records that upstream cannot rename or delete
- be one-way: upstream writes records an older build cannot handle, and rolling a Node deployment back over them is prohibited ([5.0.0](../releases/v5.0.0.md#upgrade-and-rollback), [5.3.0](../releases/v5.3.0.md#back-up-before-upgrading-no-in-place-rollback-to-52))

For an unmodified older upstream release, an in-place Node upgrade follows each release's upgrade notes and [Self-host on Node or Vercel](../self-hosting-node.md). It is still one-way, and you do not need it to move to Cloudflare.

## Install on Cloudflare

These steps follow the [Cloudflare agent skill](../../skills/openinterviewer-cloudflare/SKILL.md) and the [installer guide](cloudflare-migration/INSTALLER.md), which have every option and error. Record your choices outside the repository first, as [TRANSITION.md §1](cloudflare-migration/TRANSITION.md#1-select-the-target) lists.

The AI Gateway changes what the consent notice tells participants. Studies approved by an ethics board may need an amendment ([transport switch and consent](cloudflare-migration/RUNBOOK.md#transport-switch-and-consent-d9)).

1. Choose the installation name, the default provider and which other provider keys to bind, the AI transport (`direct`, or `cloudflare-gateway`) and the analysis language.
2. Choose the jurisdiction (`eu` recommended). It is permanent: changing it later is a migration.
3. Choose the origin: the `workers.dev` address the installer discovers, or a custom domain that you pass to `apply` as `--origin https://…` and attach after the first deploy.
4. In the clean upstream checkout, run `npm ci`, `npm run build:cloudflare` and `npm run check:cloudflare`. The check writes the receipt that deploys require.
5. Sign in to Cloudflare with `node_modules/.bin/wrangler login`. The operator does this, not the agent.
6. Run `npm run setup:cloudflare -- plan --install <name> --env staging …` and show the operator the result.
7. With authorization, run `apply --env staging`, piping the administrator password and provider keys on stdin ([fresh installation](cloudflare-migration/INSTALLER.md#fresh-installation)), then `verify`.
8. On staging, walk through a study with synthetic data only: sign in, create a study, generate a link, consent, interview, save, wait for the analysis, export. This makes paid provider calls, so ask first. [TRANSITION.md §4](cloudflare-migration/TRANSITION.md#4-rehearse-in-staging) lists the full rehearsal, including a practice fence on a throwaway Upstash database.
9. Run `plan`, then `apply --env production`, then `verify`, in the same way.
10. For a custom domain, follow [manual steps outside the installer](cloudflare-migration/INSTALLER.md#manual-steps-outside-the-installer): turn Pseudo IPv4 off, attach the domain to the Worker in the dashboard, then run `resume`. The installer never changes DNS.
11. Hold the production workspace until the switch: `maintenance draining`, then `maintenance frozen`, as in [TRANSITION.md §7 step 1](cloudflare-migration/TRANSITION.md#7-clean-start-runbook).
12. Ask the operator to move the operator token file into their password manager. Maintenance, backup and restore need it.

Later updates use the same commands: `npm run check:cloudflare` on a clean checkout of the new release, then `update` on staging, then on production ([update](cloudflare-migration/INSTALLER.md#update)).

## Switch over and retire the old stack

[TRANSITION.md §5 to §7](cloudflare-migration/TRANSITION.md#5-drain-the-old-deployment) is the procedure. Follow it in this order, with authorization at each step.

1. Announce the window to researchers and stop sending invitations.
2. Researchers export everything they want to keep, before the fence. On the openinterviewerver02 fork, use **Export All** on the dashboard (a ZIP, refused above 500 interviews), **Export Study** for each study's Markdown, and each project's Markdown export.
3. Researchers copy each study's settings (questions, consent text, profile fields), because upstream has no study import.
4. Wait at least 4 hours after the last invitation you expect to be used, then turn participant links off for every active study.
5. Fence the old writers: remove the Upstash variables from every Vercel environment, disable Git deployments, then reset the Upstash database password ([TRANSITION.md §6](cloudflare-migration/TRANSITION.md#6-fence-the-old-writers-reset-the-upstash-credentials)). Store the new credentials only in your password manager.
6. Run every §6 check. On the openinterviewerver02 fork, sign-in reads no storage, so use the study-create probe in check 4. Expect the inventory's exit 3 described in [how a fork's extra data affects either path](#how-a-forks-extra-data-affects-either-path).
7. Reopen the production workspace (`maintenance open`) and run the acceptance test on the production origin. It makes paid provider calls.
8. Give researchers the new address. They sign in again, recreate their studies and send new participant links.

### Old participant links

Old links do not carry over on a clean start. After the fence, an old link fails on the old deployment. Participants need a new link from the new instance.

Decide what the old address shows after the switch. You can leave it failing, or replace it with a redirect-only deployment that has no Upstash credentials and sends visitors to the new instance's home page. The project's own `vercel.app` address redirects this way.

### Retire the old stack later

Keep the old Upstash database and Vercel project until the recovery period is over and the operator accepts the outcome. Then, only with explicit authorization, delete them ([TRANSITION.md §7 step 6](cloudflare-migration/TRANSITION.md#7-clean-start-runbook)). The installer never deletes anything.

Until the new workspace accepts its first write, you can go back by reversing the fence. After that, fix forward.

## Prompt for your coding agent

Give your agent this prompt from inside the clean upstream checkout. Replace the parts in angle brackets.

```text
Read docs/operations/upgrade-from-vercel-or-a-fork.md, skills/openinterviewer-cloudflare/SKILL.md
and docs/operations/cloudflare-migration/TRANSITION.md. Then help me move my OpenInterviewer
deployment to upstream on Cloudflare, following the guide's sections in order.

My old deployment: <Vercel project name and production URL>, <fork URL and commit, or "upstream vX.Y">.
My data path: clean start.
My choices: installation name <name>, default provider <provider>, jurisdiction <eu>,
AI transport <direct or cloudflare-gateway>, origin <workers.dev or https://your.domain>.
My password manager: <for example 1Password, with op inject templates kept outside the checkout>.

Rules:
- Ask me before every step the guide marks as needing authorization, and wait for my yes.
- Never put a credential in an argument, a file in the checkout, a log or this chat. Pipe secrets
  on stdin from my password manager, or let me type them at the hidden prompt.
- Do not run anything from my old fork. Do not delete anything. Do not change DNS.
- Stop and tell me when anything fails, refuses, or differs from the guide.
- Report what you verified and what you could not verify.

Start by checking the prerequisites and running the read-only plan for staging.
```

## Get help

Open an issue at [github.com/linxule/openinterviewer/issues](https://github.com/linxule/openinterviewer/issues).

Include:

- the upstream release or commit you are installing, and your fork's URL and commit if you have one
- which step of this guide you are on
- the command, its exit code and the installer's error line
- from the inventory, only `incompleteReasons`, `warnings` and `unrecognizedPrefixes`

Never include:

- passwords, API keys, tokens, the operator token or the Upstash URL
- participant data, transcripts, study content or participant link codes
- screenshots or logs that show any of these
