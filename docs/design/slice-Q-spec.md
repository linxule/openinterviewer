# Slice Q — The interviewer's manner

Answers a tester's question of 2026-09-09 (a senior analyst whose team is trialling the tool): *"I was wondering whether there could also be some predefined settings for the interviewer itself, such as how it should phrase questions or behave during the interview (even personality). While testing it, I noticed that the AI sometimes asks quite lengthy questions, and occasionally uses leading questions, which could potentially influence the interviewee's responses. I'm curious whether interviewer behavior is already controlled somewhere in the current setup."*

The honest answer today is "partly, and not where you can reach it." This slice makes the answer "yes, here, and you can change it without a redeploy."

Context to read before implementing: `AGENTS.md` in full, especially "Participant and AI flow", the "Providers/provenance" and "Researcher UI" change-map rows, and the invariants on untrusted browser configuration and study revision. `docs/design/DIRECTION-final.md` §3 (typography laws), §4 (rules over boxes), §9 (honesty copy). `docs/design/slice-P-spec.md` P12 for the `thankYouText` pattern this slice copies field-for-field.

---

## Q1. Diagnosis — three gaps behind one message

1. **The one existing control governs the wrong axis.** `StudyConfig.aiBehavior` (`structured | standard | exploratory`) is rendered in setup as *AI Interview Style* (`InterviewStyleSection.tsx`) and injected by `getAIBehaviorInstruction` (`prompts/interview.ts:27-50`). It only decides how many follow-ups to ask and whether to chase tangents — **coverage vs depth**. It says nothing about how a question is phrased.
2. **Question craft is hard-coded and partly self-defeating.** The system prompt's RULES (`prompts/interview.ts:127-133`) say "Keep responses concise (2-3 sentences typical)" and, in the same breath, "Use active listening — reflect back what you hear." The reflection instruction is the proximate cause of both reported symptoms: every turn earns an interpretive preamble (length), and the interviewer's paraphrase becomes the frame the participant answers into (leading). No rule anywhere names leading questions, evaluative affirmations ("that's a great point"), or embedded example answers ("was it cost, or time?") as things to avoid.
3. **The only customization path is a source edit.** `prompts/index.ts` invites users to "modify these files"; nothing in `README.md` says so, and a hosted researcher cannot edit source at all. `README.md:224` lists what study setup configures; interviewer behavior is not on the list.

## Q2. Prime directive

*The researcher decides how their interviewer speaks, sees exactly what it has been told, and can change it by editing the study.* The default, when the researcher says nothing, is the methodologically conservative one: brief, open, non-leading questions, one at a time.

## Q3. Laws that bind this slice

1. **Browser-supplied study configuration is untrusted** (AGENTS.md). The new field is validated by `validateStudyConfig` with an explicit bound and is on the field allowlist; nothing else changes about what the server trusts.
2. **Editing a study advances its revision.** Changing the interviewer's manner is a consequential edit: participants on the old revision are invalidated exactly as for any other config change. No special casing.
3. **AI/provider failure is an error.** No part of this slice adds a fallback, retry, or substitute. A prompt is text; it fails or it doesn't with the request that carries it.
4. **The output contract is not negotiable by prose.** Researcher instructions shape *manner*; they cannot change the JSON response schema, the five interview phases, profile extraction, or `shouldConclude` semantics. The prompt says so in words the model can act on (Q5.3).
5. **Serif = human words** (DIRECTION §3). Researcher instructions are addressed to a machine, not spoken by a person: they render in **Public Sans** in a `paper-2` well, never in `Verbatim`.
6. **No genre vocabulary** in copy or `aria-label`s.

## Q4. Repo facts this spec is built on

Verified on `main` at `fe1cb92`. Re-verify anchors that look stale.

1. `thankYouText` is the template for an optional bounded free-text study field: type (`types.ts:141-149`), allowlist + bound (`studyConfigValidation.ts:44,207-210`), draft state and payload omission when blank (`useStudyDraft.ts:83,193,211,235`), section with a template button (`ThankYouSection.tsx`).
2. Both the system prompt and the greeting prompt receive the whole `StudyConfig` (`prompts/interview.ts:81`, `prompts/greeting.ts:26`); every provider calls them through `src/lib/ai.ts` re-exports (`providers/claude.ts:136,157`, `gemini.ts`, `openai.ts`, `openrouter.ts`, `gateway.ts:189,207`). Adding to the prompt touches no provider.
3. The follow-up generator copies `aiBehavior`, `profileSchema`, `consentText`, `researcherContact`, `aiProvider`, `aiModel` from the parent (`generate-followup/route.ts:157-162`). A child study should inherit the parent's interviewer. (`thankYouText` is not inherited today; manner is the first prompt-shaping text field that is — deliberate, since the child study interviews the same population.)
4. `Export.tsx:37-45` summarises the study config in the research export and includes `aiBehavior`; the export is the researcher's record of how the interview was run.
5. `StudyDetail.tsx:859-866` shows `aiBehavior` under the label `AI Interview Style` in the config register; `slice-F-spec.md:333` fixed that string for slice F, which is not a law for later slices.
6. There is no test of `buildInterviewSystemPrompt` or `buildGreetingPrompt` content today (`tests/unit/prompts.aggregateCatalogue.test.ts` covers only the aggregate catalogue). Q9 adds the first.
7. `/demo` builds no prompt (`DemoSimulation.tsx` is component-memory only). Untouched.

## Q5. Prompt changes (`src/lib/prompts/interview.ts`, `greeting.ts`)

### Q5.1 QUESTION CRAFT — always present

Replace the current RULES block. The new block is the default manner and the floor beneath any preset. Length rules are in sentences, not words, because the interview may run in any language (Q13.6):

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

Removed from the prompt: "Use active listening - reflect back what you hear" and "Keep responses concise (2-3 sentences typical)". The three output-contract lines ("When a core question is substantially addressed, note its index", "Extract profile data from user responses when mentioned", "Signal shouldConclude=true only after feedback phase is complete") move into a block headed `OUTPUT CONTRACT:` placed after QUESTION CRAFT.

Untouched prompt text that contradicts the new block is corrected in the same change (Q13.3): BACKGROUND PHASE loses "Bundle related questions." and reads "Gather profile fields naturally, one question at a time."; the structured-mode redirect line becomes `- Redirect tangents briefly: "Let's come back to..."`; the exploration and feedback phase questions keep their text (the feedback question's "or" joins two nouns, not two alternative answers).

### Q5.2 INTERVIEWER MANNER — present when the researcher wrote one

Placed immediately **after** QUESTION CRAFT and before OUTPUT CONTRACT:

```
INTERVIEWER MANNER (written by the researcher for this study):
<studyConfig.interviewerInstructions, verbatim>

Where INTERVIEWER MANNER conflicts with QUESTION CRAFT, follow INTERVIEWER MANNER. It does not change the INTERVIEW FLOW phases, when the interview concludes (shouldConclude), the profile fields to collect, or the response format.
```

Absent entirely (no header, no "none", and QUESTION CRAFT's header does not mention it) when the field is undefined — a model told "no manner was set" behaves differently from one told nothing.

### Q5.3 What the precedence sentence does and does not enforce

Only the response schema is code-enforced (provider structured output plus `validateInterviewResponse`). The phase machine and `shouldConclude` are prompt-enforced: an instruction such as "wrap up as soon as you have enough" can shorten interviews, and the server will not stop it. The precedence sentence therefore names those items explicitly so the model has a rule to follow, and README (Q10.1 item 5) says in plain words that instructions steer a model and do not bind it. Q3.4 is a statement about the prompt, not a security property.

### Q5.4 Greeting

`buildGreetingPrompt` gains the INTERVIEWER MANNER block (when present) after the study lines, with its own precedence sentence: `Where INTERVIEWER MANNER conflicts with the instructions above, follow INTERVIEWER MANNER, but still thank them and ask one opening question.` The closing instruction changes from "Keep it conversational and inviting" to "Keep it brief and plain. Do not praise or evaluate. Ask one open question." The line "Start gathering their profile naturally - don't make it feel like a form." is kept. "Write a warm, brief opening (2-3 sentences)" becomes "Write a brief opening of one or two sentences", and WRAP-UP PHASE in the system prompt changes "Thank them warmly" to "Thank them" — a Formal or Neutral manner must not fight a baked-in "warm".

### Q5.5 What the preset text may and may not do

Preset text is ordinary researcher instructions; it goes through the same field and the same block. It has no privileged channel over other instruction text. Note, though, that this field is more privileged than the rest of the study config: it is the only field whose contents are instructions with stated override power over the built-in rules. The realistic hazard is not a hostile researcher but a pasted, unread "persona" from elsewhere; Preview (Q8.4) is the mitigation, and the read sheet always shows the full text.

## Q6. Presets (`src/lib/interviewerManner.ts`, new)

Five exported constants, each a complete instruction paragraph the researcher can read as prose and edit in place. Names are the labels the UI shows.

- **`INTERVIEWER_MANNER_NEUTRAL`** — "Neutral": *Keep a strictly neutral, non-directive stance. Do not acknowledge, praise, or comment on answers; move straight to the next question. Never summarise what the participant said. Never suggest possible answers. If the participant asks what you think, say that your role is only to listen and ask.*
- **`INTERVIEWER_MANNER_WARM`** — "Warm": *Be warm and conversational, like an attentive colleague. A brief acknowledgement is fine ("Thank you.", "I see."), but do not praise or evaluate answers. Keep questions short and open. If the participant hesitates, reassure them that there are no right answers and give them time.*
- **`INTERVIEWER_MANNER_FORMAL`** — "Formal": *Use a professional, courteous register with no small talk. Address the participant respectfully and keep each turn to a single, clearly worded question. Avoid colloquialisms and casual phrasing. Do not comment on answers.*
- **`INTERVIEWER_MANNER_PLAIN`** — "Plain language": *Use simple, everyday words and short sentences, as for a reader whose first language may not be the interview's. One idea per sentence. Avoid idioms, abbreviations, and technical terms. If a term from the study is unavoidable, say what you mean by it in the same sentence. Keep the participant's own words for anything they have named.*

- **`INTERVIEWER_MANNER_INCIDENTS`** — "Concrete incidents": *Ask about specific, recent occasions rather than general opinions. When the participant generalises ("usually", "people tend to"), ask for the last time it actually happened and walk through it in order: what led up to it, what they did, what happened next. Prefer "Tell me about the last time…" over "How do you usually…".*

Four of these are register; the fifth is method. Also exported: `INTERVIEWER_MANNER_PRESETS: { id, label, text }[]` in that order, and `MAX_INTERVIEWER_INSTRUCTIONS_LENGTH = 4000` (the validation bound; shared so the UI hint and the server agree).

Every preset must itself satisfy QUESTION CRAFT's non-leading rules — a preset that reintroduces leading questions is a bug. Q9 tests that each preset is under the bound and contains no bracketed placeholder.

## Q7. Type, validation, lineage, export

1. `types.ts` — add to `StudyConfig`, after `thankYouText`:
   ```ts
   /**
    * Optional. Researcher-authored instructions that shape how the interviewer
    * phrases questions and carries itself; injected verbatim into the interview
    * and greeting prompts. Absent means the QUESTION CRAFT defaults alone.
    */
   interviewerInstructions?: string;
   ```
2. `studyConfigValidation.ts` — add `'interviewerInstructions'` to `STUDY_CONFIG_FIELDS`; after the `thankYouText` check:
   ```ts
   if (value.interviewerInstructions !== undefined
     && !isBoundedString(value.interviewerInstructions, MAX_INTERVIEWER_INSTRUCTIONS_LENGTH, true)) {
     return { ok: false, error: 'Interviewer instructions must be 4000 characters or fewer' };
   }
   ```
   No placeholder check: the text is read by the model, not a participant, and brackets are legitimate there.
   **Clearing.** `validateStudyConfigUpdate` treats an empty string (`''`) for `interviewerInstructions` — and, fixing the same latent defect, for `thankYouText` — as "remove the field": the key is deleted from the merged object before `validateStudyConfig` runs. Without this a saved value can never be cleared (an omitted key preserves the current value; JSON cannot carry `undefined`).
3. `generate-followup/route.ts` — copy `interviewerInstructions: parentStudy.config.interviewerInstructions` alongside `aiBehavior`.
4. **Snapshot at save; export from the record.** `StoredInterview` gains `conductedWithInstructions?: string`, written by `save/route.ts` from `canonical.study.config.interviewerInstructions` beside `conductedByProvider`/`conductedByModel` — on the persisted record (`:207`) **and** in the submission fingerprint (`:227`), exactly as `conductedBy*` already is: the fingerprint is submission identity, the session is pinned to one study revision, so the value cannot differ between a save and its retry, and a study without instructions keeps its pre-slice fingerprint byte for byte (regression in `api.save.idempotent.test.ts`) — for the same reason those exist: an interview may be exported after the study was edited. Absent on older records and when the study had no instructions; never back-filled from the current config. `Export.tsx` adds `interviewerInstructions: studyConfig?.interviewerInstructions` to the study summary **and** each interview carries its own `conductedWithInstructions`; the interview detail's provenance block shows it beside the conducting model (or "not recorded" for older records, matching `conductedBy*`).
5. `useStudyDraft.ts` — `interviewerInstructions: string` state (`''` when absent), `setInterviewerInstructions`, load/reset paths mirroring `thankYouText`, and payload `interviewerInstructions: interviewerInstructions.trim()` — always sent, so a blank textarea clears a saved value on update `buildConfig` takes a `mode: 'create' | 'update'` argument: on `create` blank optional text fields (`interviewerInstructions`, `thankYouText`, `researcherContact`) are omitted, on `update` `interviewerInstructions` and `thankYouText` are sent as `''` so the server clears them. `StudySetup.tsx:522` passes the mode it already knows from `draft.savedStudyId`.

## Q8. Researcher UI

### Q8.1 Rename the structure control

`InterviewStyleSection.tsx`: `label="Interview Structure"`, `id="interview-structure"`; `StudySetup.tsx` section id references follow. Option labels become:

- `Cover every question (Structured)` — *Minimal follow-ups; tangents are redirected.*
- `Balance coverage and depth (Standard)` — *Default. One or two follow-ups on key insights, then move on.*
- `Go deep (Exploratory)` — *Follows threads and probes motivations; the script is a guide.*

`StudyDetail.tsx:861` label becomes `Interview Structure`. The `capitalize` value display is kept.

### Q8.2 New section — Interviewer Manner (`InterviewerMannerSection.tsx`, new)

Placed directly after Interview Structure, before Link Settings. `id="interviewer-manner"`, `label="Interviewer Manner"`, description: *How the interviewer phrases questions and carries itself. By default it asks brief, open, non-leading questions, one at a time. Start from a preset or write your own.*

Edit mode, top to bottom:

1. A wrapped row (`flex flex-wrap gap-x-4 gap-y-1`) of five link-styled text buttons — `text-action underline underline-offset-2 text-[13px] min-h-11`, the same treatment as the Section "Edit" control, not bordered boxes — labelled `Neutral`, `Warm`, `Formal`, `Plain language`, `Concrete incidents`, introduced by a `Label` reading *Start from a preset*. Pressing one **replaces** the textarea contents with that preset's text. If the field held text that was non-empty and not equal to any preset, an `Undo` text button appears beside the row and restores it; it disappears after use or on the next keystroke. `aria-label="Use the {label} preset"`.
2. `Field label="Instructions to the interviewer" htmlFor="study-interviewer-instructions" hint="Read by the AI, not by participants. Leave blank for the default manner. {n} of 4000 characters."` wrapping a `textarea rows={6}` at `text-[13px]`, `maxLength={MAX_INTERVIEWER_INSTRUCTIONS_LENGTH}`.
3. No duplicate read sheet in edit mode: the textarea is the text. Below it, the reminder *Preview runs the saved study — save first, and tune manner before links go out or on a scratch study.*

Read mode (`read=`): a `bg-paper-2 p-4` well with `Label`: *Your instructions to the interviewer* (the built-in QUESTION CRAFT rules are not shown here; README prints them verbatim). Body is `font-sans text-[15px] leading-[24px] text-ink-700 whitespace-pre-wrap max-w-measure` showing the instructions, or, when blank, the sentence *Default manner: brief, open, non-leading questions, one at a time.* in `text-ink-500`. Never `Verbatim` (Q3.5).

### Q8.3 Study detail register

Add a row after Interview Structure: `<dt><Label>Interviewer Manner</Label></dt>` with `<dd>` in `font-sans text-[15px] leading-[24px] text-ink-700 whitespace-pre-wrap` showing the instructions, or *Default* in `text-ink-500` when absent.

### Q8.4 Preview is the test bench — after saving

Preview runs the real provider without persisting, but only on the saved study: it is disabled while the draft is dirty or unsaved (`StudySetup.tsx:662,884`). Every manner iteration is therefore a save, which advances the revision and invalidates in-flight participant links (Q3.2). The section copy (Q8.2 item 3) and README (Q10.1 item 4) say so plainly: tune manner before links go out, or on a scratch study. No new preview mechanism in this slice.

### Q8.5 Mobile

The preset row wraps (`flex flex-wrap gap-x-4 gap-y-1`, per Q8.2). Inspect at 375px.

## Q9. Tests (unit tier, `tests/unit/`)

1. `studyConfigValidation.test.ts` — accepts a bounded `interviewerInstructions`; rejects 4001 chars, empty/whitespace string, non-string; the omitted field validates; update-merge preserves a current value when the patch omits the key and **clears it when the patch sends `''`** (same assertion added for `thankYouText`); create rejects `''`.
2. `prompts.interview.test.ts` (new) — with no instructions: the system prompt contains `QUESTION CRAFT:`, does not contain the header `INTERVIEWER MANNER (written by the researcher`, does not contain `reflect back` or `Bundle related`; with instructions: contains the verbatim text under that header, contains the precedence sentence, and the manner block appears **after** `QUESTION CRAFT:` and **before** `OUTPUT CONTRACT:`. Greeting prompt: contains the block and its own precedence sentence iff instructions present, and always keeps the profile line.
3. `interviewerManner.test.ts` (new) — every preset is non-empty, ≤ `MAX_INTERVIEWER_INSTRUCTIONS_LENGTH`, contains no `BRACKETED_PLACEHOLDER`, and no preset contains the words "great", "interesting", or "for example".
4. `Export.register.test.tsx` — export carries the study's `interviewerInstructions` and each interview's `conductedWithInstructions`. `canonicalStudy.validation.test.ts` — a stored record with `interviewerInstructions: ''` cannot exist after Q7.2, but a stored `undefined` serves participants; assert the served path. `api.followup.provenance.test.ts` — child inherits `interviewerInstructions`. Save-route test — `conductedWithInstructions` is written from the canonical config and absent when the study has none. Greeting test — no `conversational and inviting`; synthesis prompt tests — `INTERVIEWER MANNER` never appears (Q11).
4b. `StudySetup.document.test.tsx` — the index lists `Interview Structure` and `Interviewer Manner`; pressing `Neutral` fills the textarea with `INTERVIEWER_MANNER_NEUTRAL`; pressing `Warm` afterwards replaces it; the read sheet shows the default sentence when blank. Existing assertions on the old `AI Interview Style` string are updated, not deleted.
5. `StudyDetail` test (extend the nearest existing one) — the register shows the instructions when set and `Default` when not.
6. (folded into 4.)

E2E: `npm run test:e2e` must still pass; no new browser journey is required because the field rides the existing create/edit/save path.

## Q10. Documentation

### Q10.1 `README.md` — new subsection under "Research workflow"

`### How the interviewer is controlled`, after the participant steps and before "Analysis uses the study's…". Content, in this order:

1. The three layers, one sentence each: **Interview Structure** (coverage vs depth — three modes), **Interviewer Manner** (phrasing and carriage — presets or your own instructions, injected verbatim into the prompt), **the prompt itself** (`src/lib/prompts/`, self-hosters only).
2. The default: brief, open, non-leading questions, one at a time; no praise, no paraphrase. Why: leading and evaluative turns shape answers.
3. What instructions can and cannot change (Q5.3, in plain words).
4. Test it with **Preview** — which runs the saved study, so save first — before sharing a link; editing manner advances the revision and invalidates issued links like any other edit, so tune it before collection or on a scratch study.
4a. The built-in QUESTION CRAFT block, printed verbatim in a code fence, so a methods appendix can quote what every interviewer was told.
5. The honest limit: instructions steer a model, they do not bind it — the response format is enforced by code, the phases and ending are not. Model and provider choice matter; review early transcripts.
6. Two worked examples of instructions, the first being language: *"Conduct the entire interview in Japanese, using polite (desu/masu) register."* and one manner tweak (e.g. two questions per turn for a short screening study). Language is not a separate setting; it is an instruction — and it reaches the interviewer's questions and greeting only: consent text is the researcher's own, and the app's fixed participant chrome (phase sentences, buttons, receipt) and the analysis prompts stay in English.
7. Operational caveats: instructions ride every turn (a long manner costs tokens under hosted quotas), and each interview record snapshots the instructions in force when it was saved.

Update the line at `README.md:224` to include "interviewer structure and manner".

### Q10.2 `AGENTS.md`

"Providers and prompts" line gains `src/lib/interviewerManner.ts`. Nothing else: no invariant changed.

### Q10.3 In-file guides

`prompts/index.ts` and `prompts/interview.ts` header comments: point researchers to Interviewer Manner in setup first, and to editing the file second.

## Q11. Non-goals

- No stored enum for presets. A preset is text the researcher can read; the stored record is the text, so the record is always the truth about what the model was told.
- No per-turn length enforcement in code. A model that ignores "60 words" is a model problem the researcher can see in Preview and in transcripts; truncating its output would fabricate a shorter question.
- No interviewer *name* or avatar. DIRECTION §6 deleted the Bot avatar; a persona is a manner, not a character.
- No change to synthesis prompts. Manner is about the interview, not the analysis.

## Q12. Verification

Focused: `npx vitest run tests/unit/studyConfigValidation.test.ts tests/unit/prompts.interview.test.ts tests/unit/interviewerManner.test.ts tests/unit/StudySetup.document.test.tsx` plus the StudyDetail and follow-up tests touched. Then `npm run check`, `DEPLOYMENT_MODE=standalone npm run build`, `npm run test:e2e`, `git diff --check`. Inspect setup and study detail at 375px.

## Q13. Amendments after adversarial challenge (2026-09-10)

Kimi challenge, verdict "concern"; the owner's three decisions were out of scope and none of the findings argued against them. Adopted:

1. **Clearing bug** (Q7.2, Q7.5, Q9.1): `''` on update deletes the field; draft always sends the field. Applied to `thankYouText` too.
2. **Test contradiction** (Q9.2): assert absence of the full manner header, not the phrase.
3. **Prompt contradictions** (Q5.1): "Bundle related questions" and "That's interesting, but…" corrected; "below" pointer removed by moving MANNER after CRAFT.
4. **Precedence honesty** (Q5.2, Q5.3, README item 5): sentence names `shouldConclude`; spec states what code enforces and what only the prompt does.
5. **Greeting** (Q5.4): own precedence sentence; profile line kept.
6. **Language** (Q5.1, Q6, Q10.1 item 6): sentence-based length rules; English-register phrasing removed from Formal; language is set by instruction and is the README's first example.
7. **Method** (Q5.1): paraphrase carve-out for checking understanding; acknowledgement not suppressed to zero; distress/reluctance line in the floor.
8. **Plain preset** (Q6): keeps the participant's own terms, resolving the conflict with "follow the participant's vocabulary".
9. **Trust framing** (Q5.5): the field is described as more privileged than other config; Preview and the always-visible read sheet are the mitigation.

Not adopted: a stronger Neutral/default separation (Neutral is the strict end by design); code enforcement of phase transitions (out of scope — would be its own slice).

## Q14. Amendments after design reviews, round one (2026-09-10, Codex + Opus)

Codex: design holds; its findings were conformance gaps between the in-flight implementation and Q13, relayed to the implementer. Opus surfaced new facts. Adopted:

1. **Preview needs a save** (Q8.4, Q8.2, README 4): the "test bench" is honest about the revision cost.
2. **Snapshot instructions on the interview record** (Q7.4): `conductedWithInstructions`, same rationale and lifecycle as `conductedBy*`. Export and interview detail read the record, not the current config.
3. **Read sheet relabelled** (Q8.2) and **QUESTION CRAFT printed verbatim in README** (Q10.1 4a) so the researcher can cite what the interviewer was told.
4. **Greeting/wrap-up "warm"** removed (Q5.4) so Formal/Neutral do not fight a baked-in register.
5. **Preset press is undoable** (Q8.2); presets are link-styled, not boxes; no duplicate sheet in edit mode.
6. **`buildConfig` create/update fork** (Q7.5).
7. **Profile-option carve-out and no-PII line** in QUESTION CRAFT (Q5.1).
8. **Fifth preset, "Concrete incidents"** (Q6): one method preset among four registers.
9. **Language reach and cost caveats** in README (Q10.1 6–7).
10. **Test holes** (Q9.4): export, canonical study, follow-up, save-route snapshot, greeting, synthesis non-goal.

Not adopted: participant-facing disclosure of the manner (consent text is researcher-authored and already the place for it; a generic "the interviewer follows instructions" line would say nothing), and a code-enforced phase machine (own slice).
