# Research guide

This guide explains how to run a study in OpenInterviewer, from setting up the interviewer to exporting the data. For installation, see the [README](../README.md).

## Try the demo and the sample study

Open `/demo` on a running instance. It needs no login, provider key or database.

The demo:

- lets visitors steer a fictional participant through 3 questions with fixed, branching responses
- ends in an illustrative researcher note with an exact transcript quote, interpretation, nuance and hypothesis to test
- makes no AI-provider or persistence request
- accepts no visitor-written interview content and keeps its selected path in component memory only
- is safe to run while the real provider and storage configuration is absent

The demo is not a disguised live interview. It is deterministic, does not call an AI provider and does not save data. Every response, follow-up and insight is pre-written and visibly labeled as synthetic. Use it to understand the participant-to-researcher workflow, not model quality, latency or provider availability. Real interviews need configured inference access and storage.

The signed-in researcher workspace also offers **Load Sample**. It writes a synthetic study and interviews to the researcher's configured store (a Cloudflare workspace or a Node/Vercel Upstash database), so you can explore the dashboard and aggregate-analysis screens. This is storage-backed sample data and does not power the public `/demo`.

Loading or clearing the sample makes no AI call. Generating new aggregate or follow-up analysis uses the configured provider and may count against its quota. **Clear Sample** removes the designated sample fixture, not arbitrary synthetic studies created through ordinary interview workflows.

## Run a study

1. Create and save a study.
2. Configure questions, profile fields, provider/model, interviewer structure and manner, consent text, and link expiry.
3. Generate an opaque participant link from the saved revision.
4. Share the link and collect interviews.
5. Review individual transcripts and synthesis.
6. Choose a dataset, run aggregate analysis, or ask questions in **Explore**; export the study or workspace.
7. Pause and resume collection without replacing links, or delete a study in Settings when its retention period ends.

## What participants do

1. Open the study link.
2. Review the study information and give consent.
3. Complete the adaptive interview.
4. Choose **Continue to save interview** and wait for **Your responses have been saved. It is now safe to close this tab.** before closing the tab.

Finishing saves the transcript before analysis starts in the background. If the save fails, the participant should keep the tab open and use **Retry save**. Once the save is confirmed, they can close the tab even if analysis is still pending or fails.

Researchers can recover unfinished analysis with **Run analysis** on an interview, or with the pending-analysis batch action on a study. The saved transcript and JSON remain available from the interview detail view. You can also customize the participant thank-you text in study setup.

On Cloudflare, analysis after a participant saves runs as a background job. The researcher sees queued, running, complete, failed or needs-recovery states. "Needs recovery" means a paid provider call may have run but its result could not be confirmed. Running it again may make another paid request.

## Control the interviewer

You control the interviewer in 3 layers:

- **Interview Structure** balances coverage and depth through 3 modes: Structured, Standard and Exploratory.
- **Interviewer Manner** controls phrasing and carriage. Choose a preset (Neutral, Warm, Formal, Plain language or Concrete incidents) or write your own editable instructions. They are injected verbatim into the interview and greeting prompts.
- The prompt itself, in `src/lib/prompts/`, is a further customization layer for self-hosters only.

The default is brief, open, non-leading questions, one at a time, with no praise and no routine paraphrase. A brief check of understanding at a natural transition is allowed. Leading and evaluative turns can shape participants' answers.

Your manner instructions can override the default question craft, including brevity and how many questions to ask per turn. The prompt tells the model not to change the interview phases, ending, profile fields to collect or response format. Manner is the only study field explicitly allowed to override question craft, so read pasted instructions carefully.

Test with **Preview** before sharing a link. Preview runs the saved study, so save first. Editing manner advances the revision and invalidates issued links like any other edit. Tune it before collection or on a scratch study.

The built-in question craft, for reference or a methods appendix:

```
QUESTION CRAFT:
- Ask ONE question per turn. Never stack two questions, and never offer either/or alternatives inside a question. (Exception: a profile field that has preset options may be asked as a closed question listing those options.)
- Keep each turn short: at most one brief sentence before the question, then the question in a single sentence.
- Ask open, non-leading questions. Do not suggest an answer, offer example answers, or embed your own interpretation in the question. Prefer "What was that like?" over "Was that frustrating?"
- Do not evaluate answers. No "great point", "interesting", "that makes sense". A brief acknowledgement ("Thank you.") is enough.
- Do not summarise or paraphrase what the participant said before the next question, except briefly to check your understanding at a natural transition. To anchor a follow-up, quote their own words exactly and briefly.
- Follow the participant's vocabulary. Use their terms for things, not yours.
- Use plain language. No jargon from the research question or topic areas unless the participant used it first.
- If the participant seems distressed or reluctant, say so plainly, remind them they may skip any question, and do not press.
- Do not ask for personal identifying information beyond the profile fields listed.
```

Instructions steer a model; they do not bind it. Code enforces the response format, but not the phases or the ending. Model and provider choice matter, so review early transcripts.

Two worked examples to paste into Interviewer Manner:

- register in a language: "Use polite (desu/masu) register." The language itself is a study setting ([interview languages](#interview-languages)); manner adjusts how the interviewer speaks in it.
- a short screening study: "Ask two short, open questions per turn. Do not suggest answers or evaluate responses." This overrides the default one-question rule; save and Preview to check the result.

Instructions ride every turn, so a long manner costs tokens under hosted quotas. Each interview record snapshots the instructions in force when it was saved, so later study edits do not rewrite its record.

## Choose what participants are told about the AI provider

Analysis uses the study's current configured provider and model, including when the study was edited after collection. The result records the study revision used. Each interview separately records the provider and model configured when it was saved.

Each study sets what participants are told about the AI provider, in **AI Provider → What participants are told**:

- **Only this provider and model** (the default for new studies). The consent notice names the provider and the model, and says the study does not switch them. An interview saved under this setting can be re-analyzed only with that provider and model. After you switch the study to another one, re-analyzing an earlier interview is refused (`PROVIDER_NOT_DISCLOSED`) until you set the study back.
- **The provider or model may change.** The consent notice names the provider and says you may later analyze responses with a different provider or model. Re-analysis uses whatever the study is set to.

Studies saved before this setting existed keep their old notice, and their interviews are not checked, until the study is saved again.

Aggregate analysis defaults to the current revision, but an explicit dataset may include earlier revisions. Aggregate analysis, exploration and follow-up generation check each selected interview's provider commitment and transport disclosure before sending content. Follow-up generation preserves the stored aggregate's source scope. Researcher previews do not store research records. If preview analysis fails, **Export transcript** still opens the transcript download.

## Interview languages

**Interview Languages** lists the languages participants may choose: English, Simplified Chinese, French, Japanese, Korean and Spanish. With more than one, the consent page opens with a language choice. It is preselected from the participant's browser, or else the study's default language. The consent page, data notice, interview screens and thank-you screen then use that language. The interviewer conducts the whole interview in it, asking questions written in another language in the participant's language.

- Consent text is written for each language in its section. A blank one is generated from the research question in that language when you save. The participant's consent is recorded against the text they read, and every later request names the same language: a client that switches language is refused.
- Analysis is written in the installation's analysis language, English unless set otherwise, with quotations kept verbatim in the participant's language. Set `ANALYSIS_LANGUAGE` to `zh`, `fr`, `ja`, `ko` or `es` (Node: an environment variable; Cloudflare: `npm run setup:cloudflare -- update --analysis-language <code>`). It applies to every study and to analyses written after the change; earlier analyses keep their language until they are run again. Rolling back to 5.1 returns analysis to English (5.1 ignores the setting; the receipt keeps it for the next upgrade). The study setup's Interview Languages section shows the current setting. Each saved interview records the language it was conducted in.
- Translations of the fixed participant screens and the data notice were drafted with AI assistance and reviewed by 3 other AI models. They are not certified translations (see `docs/translations/`). Your consent text in each language is your own: have it checked as your ethics process requires.
- A study saved with only English keeps working exactly as before. Releases before 5.1 refuse a study with a language setting (fail-closed), so do not roll back past 5.1 while one is collecting.

## Voice input

**Voice Input** lets participants speak an answer instead of typing it. The text appears in their answer box to check and edit. Nothing is sent until they press Send. The consent notice states who turns speech into text. There are 4 modes.

**Transcribed by this installation.** The browser records up to one minute, converts it to 16 kHz WAV and sends it to `/api/transcribe`. That route passes it to Cloudflare Workers AI (`@cf/openai/whisper-large-v3-turbo`) once.

- OpenInterviewer does not store or log the recording or its text. Cloudflare's Workers AI terms say customer content is not used to train models. They do not state a retention period, so the consent line promises only that the study does not keep the recording.
- It works in current Chrome, Edge, Firefox and Safari, on phones and computers.
- On Cloudflare the installation's `AI` binding is used directly, never through AI Gateway. On Node, set `CLOUDFLARE_WORKERS_AI_ACCOUNT_ID` and `CLOUDFLARE_WORKERS_AI_TOKEN` (an API token with Workers AI permissions).
- Cloudflare charges about $0.0005 per audio minute after its free daily allowance of 10,000 Neurons (roughly 200 audio minutes).
- Each request is admitted like an interview turn: 40 clips per session per hour and 1,500 per study per day.
- The model's voice-activity filter drops silence and steady noise. Like any speech model, it can occasionally turn a non-speech sound into a stock phrase (in staging tests, once, the Japanese for “thanks for watching”). The participant's check before sending is the safeguard, so the text is never sent on its own.

**The browser's own dictation.** It needs no setup. Chrome sends the audio to Google and Safari to Apple, under their terms. Firefox does not support it. Use it only where your ethics approval allows these processors.

**On the participant’s computer (desktop Chrome only)** (`device`). The browser turns speech into text locally with `processLocally = true`. It never falls back to a speech service or to installation transcription.

- It is available in desktop Chrome 139+ where the selected language pack is supported. Phones, Safari, Firefox and unsupported devices show no microphone, and participants type instead.
- The browser may first download a speech pack (about 60 MB). Participants can keep typing and sending during preparation, then press the mic again when ready.
- Locality is the browser’s local-processing promise, not something the page can independently verify.
- No server credentials, bindings or readiness capability are needed.

**Off.** This is the default.

The hosted service does not offer transcription by the installation and refuses to save it. Browser dictation and device voice work there. The 6 speech tags are centralized in `SPEECH_TAGS` in `src/lib/voice/useVoiceInput.ts`. Desktop Chrome 155 accepts all 6 (including `zh-CN`) for local processing. The voice strings' translations were reviewed like the others (`docs/translations/REVIEW-2026-10.md`). See the [v5.4.0 release notes](releases/v5.4.0.md).

### Rolling back a device-mode study to 5.3

A 5.3 build rejects saved `voiceInput: device` configurations rather than silently changing modes. Participant access and link creation are refused (409), and canonical-study validation also fails closed (503). Unchanged saves return 400 `Invalid voice input setting`.

Before rollback, stop collection and explicitly change affected studies to **Off** on 5.4. This advances their revision, so distribute new links before resuming. Saved interviews keep their original device-mode collection configuration, which 5.3 does not fully understand. Prefer rolling forward if those records need processing or export.

## Study revisions and lifecycle

Changing study configuration advances its revision and invalidates links and participant sessions issued for the previous revision. Generate and distribute a new link after a consequential edit. Pausing/resuming collection and unchanged saves do not advance the revision.

**New study**, **Edit study** and **Duplicate for testing** have separate draft identities. Reloading an edit loads the matching saved study. A restored stale draft requires review before saving. Duplicate copies configuration only, not interviews, links or analysis. Preview still runs the saved revision.

Pausing blocks participant entry, calls and completion, but preserves the revision and active links. Resuming restores those links; revoked or expired links remain unusable. Saving unchanged configuration does not advance the revision. A real settings change still advances it and invalidates old participant authority.

Settings includes a **Danger Zone**. Deleting a populated study requires 2 confirmations tied to its identifier and reviewed revision. It removes the live study, interviews, links, aggregate and exploration notebook.

- Large Redis deletions are resumable. A pending operation is not reported as complete.
- Late analysis writes cannot recreate the study.
- Downloads, external backups and provider requests already started are outside this live-store deletion.
- Legacy unindexed consent records contain identifiers and a hash, not transcripts, and expire after 4 hours. New consent records are indexed for cleanup.

## Explore a study

**Explore** answers questions against saved transcripts in one study, including interviews whose individual analysis is pending or failed. First select revisions, particular interviews or recorded profile fields.

Unknown, refused, vague and ambiguous profile values remain unknown. A numeric range accepts only a recorded scalar number, not an inferred age. Original field definitions are preserved for newly saved interviews. Older records without those definitions are visibly unknown, not relabeled with today's schema.

Ask for provisional archetypes, concerns, unexpected themes, or evidence supporting and challenging a hypothesis. Answers save with the question, exact source manifest, scope counts, timestamps, and requested and served model provenance. Findings separate supporting, challenging and uncertain quotations. A quotation matched to a participant's transcript is a located quotation. It is not proof that the interpretation is correct or that a theme is prevalent.

One request includes the full selected corpus, within these limits:

- at most 100 interviews and 256 KiB of exact provider-facing interview records
- a separate 320 KiB bound on the complete prompt, including question, study context, continuity and system instructions
- dataset inspection bounded at 1,000 saved interviews

Byte limits can refuse fewer than 100 interviews and do not guarantee a custom model's context capacity. Larger selections are refused before a provider request: narrow the dataset or export it. Nothing is silently sampled. There is no cross-study chat, vector index or web search.

Every admitted question is durable and idempotent. Checking the same attempt does not call the provider again. A timeout or uncertain interruption becomes **Needs recovery**. Starting another attempt is an explicit action and may incur another provider charge. A generated answer that could not be saved remains downloadable. You can save it with its signed, save-only receipt for 24 hours, without another model call. Each study retains at most 500 attempts.

## Export study data

**Export this study** downloads a ZIP of raw records, transcripts, the aggregate and the notebook, plus an `analysis/` folder for coding tools and spreadsheets. Workspace ZIP exports include the same analysis files.

The ZIP keeps the per-interview `NNN_*.json` and `.md`, `summary.csv`, `aggregates/` and `explorations/`. It adds:

- `analysis/README.md`: field definitions, historical-label rules and the consent/provider sharing warning
- `analysis/interviews.jsonl`: one interview per line, with collection context, recorded consent and analysis provenance, profile values and verbatim turns
- `analysis/interviews.csv`: interview-level data and one column per observed profile field ID, labeled from the newest interview
- `analysis/turns/NNN.csv`: one turn table per interview to bound export memory; indices match analysis citations, including gaps for omitted system messages
- `analysis/profile_fields.csv`: profile values in long form with their labels at collection

CSVs use UTF-8 with BOM and CRLF. Formula-like text is protected with an added apostrophe, so use JSONL for verbatim quotes. Unknown historical fields are not filled from today’s study configuration. ZIP Markdown dates are ISO UTC.

**Export transcripts (.md)** downloads one Markdown file with every saved transcript of the study, for reading or for another analysis tool. Transcript text is quoted exactly as saved, and each interview lists what its participant was told about the AI. If a participant was promised that the study uses only one provider and model, sending the file to a different AI service may break that promise. A download that did not finish is refused rather than saved.

## Group studies into projects

Projects are available on standalone Node/Redis and Cloudflare installations only. There, **My Studies** groups studies into named, collapsible projects and an explicit **Ungrouped** section. Hosted researcher accounts keep the flat study list.

- Use **New project**, then **+ Study** to create a study in it. Study actions offer **Move to project…** and **Ungroup**. Empty projects remain visible.
- Grouping is organization, not study configuration. It does not change a study's revision, questions, consent, participant links, transcripts or provider choices.
- A project's **···** actions rename it, export its transcripts, or delete the project. Deleting a project moves its studies to Ungrouped; it deletes no study or interview.
- Creating a study and assigning it are 2 separate saves. If assignment fails, the study still opens with a notice. Move it from the study list; do not create it again. Uncertain project changes are refreshed, not automatically retried.
- **Export transcripts** downloads one Markdown file containing each study's saved transcripts, including an empty-study header where appropriate. It makes no AI calls and keeps each interview's recorded provider/transport disclosure. The limit is 500 interviews in total; export larger collections study by study. The client refuses an incomplete download, including a file cut after a valid inner study footer. A transcript-free project has nothing to download.

Project exports are checked concatenations of per-study snapshots, not one cross-study point-in-time snapshot. The project name and membership roster are checked again at completion. The workspace supports at most 1,000 projects and 1,000 studies in its project listing. Oversize collections are refused rather than truncated. A failed grouping read shows a notice and the flat list, not a guessed Ungrouped view.

### Upgrading to 5.3

Back up before upgrading to 5.3. Cloudflare schema 3 is forward-only: a 5.2 build refuses the upgraded workspace. Do not roll Node back to 5.2 against the upgraded Redis database either: it would ignore memberships and omit project cleanup. See the [5.3 forward-only upgrade note in the runbook](operations/cloudflare-migration/RUNBOOK.md#projects-53-forward-only-upgrade).

## Researcher AI request limits

On a standalone installation (Node or Cloudflare), every AI call the researcher starts is counted before the provider is called. This covers preview greetings, preview turns and preview analysis, aggregate analysis, study exploration, follow-up study generation and **Run analysis**.

Each operation has a limit per signed-in session and a limit for the whole workspace, so signing in again does not reset the workspace limit. At a limit, the request is refused with HTTP 429, a `Retry-After` header and "Too many AI requests from this workspace. Please wait before trying again." Nothing is sent to the provider, and the provider charges nothing. Participant interviews have their own limits and never count here.

| Operation | Per session | Per workspace |
| --- | --- | --- |
| Preview greeting | 10 per 10 minutes | 200 per day |
| Preview turn | 60 per hour | 1,000 per day |
| Preview analysis | 10 per hour | 100 per day |
| Aggregate analysis | 20 per hour | 100 per day |
| Study exploration | 20 per hour | 100 per day |
| Follow-up study | 20 per hour | 100 per day |
| Run analysis | 100 per hour | 500 per day |

A window opens at the first counted request and does not slide. On Cloudflare, **Run analysis** is counted only when it starts new work: repeating a request that was already accepted, or asking again while an analysis is still running, is free. On Node, every **Run analysis** request is counted. The limits are set in `STANDALONE_RESEARCHER_AI_POLICY` (`src/lib/researcherAiBudget.ts`). Hosted accounts use the hosted platform limits instead.

Exploration reserves a notebook attempt before checking the budget. If the budget refuses it, the notebook records a failed, budget-limited attempt and no model request is made. The response keeps that attempt rather than losing its identity behind a standalone error. Replaying or saving an existing attempt does not consume more AI budget.
