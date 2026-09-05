# Slice O — Which model conducted this interview

Answers the owner's question of 2026-09-05: *"On the model selection side, how does it work for the researcher right now? Do they get to track what model was used for which interview? Because they might switch midway and that's fine, it's their choice. Even though we might need to remind them to keep it the same."*

The answer today is **no**. Every saved interview records the provider and model that produced its **synthesis** (`StoredInterview.aiProvider/aiModel/requestedAiModel/routedProvider`, written from the signed receipt at `src/app/api/interviews/save/route.ts:200-203`), and the synthesis model is a fixed per-provider constant the researcher never picks (`SYNTHESIS_MODEL_BY_PROVIDER`, `src/lib/providerRegistry.ts:42-47`). The model the researcher *does* pick — `StudyConfig.aiModel`, edited in `src/components/studySetup/ProviderSection.tsx:228-252` — drives every participant conversation turn and is written nowhere on the interview. The study keeps no history of past configs, so a mid-study model switch leaves no trace in the record.

Context to read before implementing: `AGENTS.md` in full, especially "Participant and AI flow", every "Non-negotiable invariant", and the change map's Researcher UI and Completion-and-export rows; `docs/design/DIRECTION-final.md` §3 (Plex Mono for machine-verifiable facts, model IDs named explicitly), §4 (registers are dense, measure never applies to tables), §7 "Provenance footer"; `docs/design/slice-I-spec.md` §I3.2 for `ProvenanceFooter`'s grammar; `docs/design/slice-N-spec.md` §N8.2 for how the aggregate footer's clauses are assembled.

**Prime directive.** *The record names the model that conducted it, or it says it does not know.* The conducting model is a server-derived snapshot of the canonical study at the revision the participant session was pinned to — never a browser assertion, never inferred at read time from the study's current config, never guessed for a record that predates the field.

---

## O1. Laws that bind this slice

1. **"Browser-supplied study configuration, provider/model choice, identity, timestamps, synthesis, and ownership are untrusted"** (AGENTS.md). The conducting model is written by the save route from `loadCanonicalStudy`, on the same line as `studyRevision` and `consentHash`. `validateInterviewSubmission` (`src/lib/interviewSubmission.ts:139-147`) already returns an explicit field copy, so a body field of this name is dropped before the route sees it; O5.3 pins that with an adversarial regression rather than trusting the whitelist to stay a whitelist.
2. **"Editing a study advances its revision and invalidates older participant authority"** (AGENTS.md). This is the load-bearing invariant of the whole slice. O3 shows it is what makes a save-time snapshot provably equal to what the turns used.
3. **"AI/provider failure is an error. Never substitute a plausible research response"** (AGENTS.md). Its reading here: an interview with no recorded conducting model renders `not recorded`. The current study config is *never* substituted, not on the register, not in the footer, not in the export — even though it is sitting in the same component's props.
4. **"Synthesis provenance must record the provider and model actually used, which may differ from the interview-turn model"** (AGENTS.md). That invariant already anticipated this slice. Nothing here weakens it: the synthesis fields keep their names, their values, and their receipt.
5. **"Completion persistence and study mutation remain atomic and idempotent under retries and concurrency"** (AGENTS.md). Two scalar fields on a value that is written by one `SET` inside an existing script. The only real question is whether they enter the submission fingerprint; O5.2 answers it.
6. **No genre vocabulary** in copy, labels, `aria-label`s, or comments: no "apparatus", "colophon", "marginalia", "provenance" as a user-facing noun.

---

## O2. Repo facts this spec is built on

Verified by reading source at spec time on branch `fix/synthesis-retry-budget` (dirty in `src/app/api/synthesis/route.ts`, `src/components/Synthesis.tsx`, `src/lib/rateLimit.ts`, `src/services/interviewApi.ts` — none of which this slice touches), with Initiative 3 slices H, I, K, L, M and Storage slice N applied. Re-verify any that look stale.

1. **The participant token pins a study revision.** `ParticipantTokenPayload.studyRevision` is baked at link exchange (`src/lib/auth.ts:59,75,285,300`) and is not re-derived per request.
2. **Every participant request is refused when the stored revision has moved past the pinned one.** `resolveParticipantOrPreviewContext` returns `409 'This study link was replaced after the study changed.'` in standalone (`src/lib/researcherContext.ts:649-650`) and hosted (`:747-748`). The check sits *after* the link and links-enabled checks and *before* any context is returned, so it gates greeting, interview turns, synthesis and save alike. It is not skipped on the `persist-repair` path.
3. **Any config edit advances the revision.** `REPLACE_STUDY_CONFIG_SCRIPT` writes `nextRev = revision + 1` in the same patch as the new config (`src/lib/kv.ts:1252-1268`); `SET_STUDY_LINKS_SCRIPT` does the same for a link toggle (`:1216-1228`). There is no path that changes `aiModel` without bumping the revision.
4. **Facts 1–3 together mean the conducting model cannot change inside one interview.** A researcher who switches the model mid-interview does not switch the model mid-interview: they end it. The in-flight participant's next request 409s, and no record is ever saved for that session under a second model. This is the fact the design turns on, and it is currently pinned by **no test** — O13 adds one.
5. **The canonical study read at save is at the pinned revision.** `save/route.ts:104-110` calls `loadCanonicalStudy` after `resolveParticipantOrPreviewContext` has already enforced fact 2, and `persistCompletedInterview` is then given `expectedStudyRevision: canonical.study.revision ?? 1` (`:259`). So `canonical.study.config.aiModel` at save is the same string the turn route passed to `getInterviewProvider` (`src/app/api/interview/route.ts:156`, via `src/lib/providers/index.ts:56-61`).
6. **A canonical study always has a valid provider and model.** `loadCanonicalStudy` runs `validateStudyConfig` and fails closed with 503 otherwise (`src/lib/canonicalStudy.ts:42-58`); `validateModel` rejects `undefined` and anything `isKnownProviderModel` refuses (`src/lib/studyConfigValidation.ts:122-135`, called unconditionally at `:176`). So the two new fields are always present on a record written after this slice — never optional in practice, only in the type, and only for records written before it.
7. **Model ids are bounded.** `MAX_MODEL_LENGTH = 200` (`studyConfigValidation.ts:26`); non-OpenRouter models are a closed enum, and an OpenRouter slug is ≤200 chars matching `OPENROUTER_MODEL_ID` (`src/lib/providerRegistry.ts:49-56`). Two extra fields add at most ~230 bytes to a value already bounded by the 512 000-byte submission cap (`save/route.ts:45`).
8. **Interview turns carry no execution provenance at all.** `AIProvider.generateInterviewResponse` returns `AIInterviewResponse`, not `ProviderResult` (`src/lib/ai.ts:28-36`); only the three synthesis-family methods return `ProviderResult`. The Gateway adapter computes `responseModel` and `gatewayModel` for a turn and discards both (`src/lib/providers/gateway.ts:179-203`); Gemini does the same (`src/lib/providers/gemini.ts:155-176`). **There is therefore no provider-reported model for a turn anywhere in the system**, and this slice does not create one — see O3.3.
9. **A researcher preview never persists.** `save/route.ts:155-162` returns `{ preview: true }` before any storage call, so no preview writes a conducting model.
10. **`StoredInterview` is stored as one JSON value with no field allowlist on read.** `encodeInterviewValue` is `oi:interview:` + `JSON.stringify` (`src/lib/kv.ts:133-135`); `decodeStoredInterview` (`:117-131`) checks `id`, `studyId`, `status`, `createdAt`, `completedAt` and casts. New fields round-trip with no kv edit. There is no per-interview byte ceiling analogous to `MAX_STORED_AGGREGATE_BYTES`.
11. **The read routes are pass-throughs.** `GET /api/interviews`, `GET /api/interviews/[id]` and `GET /api/interviews/export` all serialize the decoded record (`export/route.ts:120`, `interviews/[id]/route.ts:61,78`, `interviews/route.ts:47,87,107`). New fields reach `Dashboard`, `StudyDetail`, `InterviewDetail` and both JSON downloads with no plumbing.
12. **`ProvenanceFooter` has exactly two consumers.** `InterviewDetail.tsx:275-280` (per-interview, `verb="saved"`) and `StudyDetail.tsx:523-533` (aggregate, `verb="generated"|"saved"` plus `note`). `Synthesis.tsx` renders the reading but no footer, and `tests/unit/Synthesis.register.test.tsx:131` asserts the participant never sees one. The aggregate has no single conducting model and must keep its footer byte-identical — `tests/unit/StudyDetail.aggregate.test.tsx:166,191` pin it with anchored regexes.
13. **The Dashboard already has a Model column** at `lg:table-cell`, header `Model` (`src/components/Dashboard.tsx:313`), cell `interview.aiModel ?? '—'` (`:365`). **No test pins that header or that value** — `tests/unit/Dashboard.register.test.tsx:85-88` checks only ID, Study, Started, Status. `StudyDetail`'s interview register has no model column at all (`StudyDetail.tsx:559-585`).
14. **`StudyDetail` already holds every interview of the study.** `getStudyInterviews(studyId)` at `:100`, kept in `interviews` state, already reduced client-side for `eligibleInterviewCount` (`:63-66`) and `interviewIndex` (`:59`). A per-model histogram is one more `useMemo` over data that is already there, with no new request.
15. **`StudySetup` does not know how many interviews a study has.** Edit mode is entered from `StudyList.tsx:407-408`, which puts only `study.config` into `sessionStorage`; `StudySetup.tsx:189-222` reads that and nothing else. The component never calls `getStudy` or `getStudyInterviews`. This is the entire cost of the ProviderSection note — see O10.
16. **`summary.csv`'s last column index is asserted.** `tests/unit/api.export.csvFormulas.test.ts:106` reads `cells[6]` for the Key Insight cell. Appending columns after it is free; inserting before it is not.
17. **`makeStoredInterview` sets no model fields** (`tests/fixtures/models.ts:45-59`), and `makeStudyConfig` sets `gemini` / `gemini-2.5-flash` (`:23-24`). Every existing fixture interview is therefore a "not recorded" case for this slice by default, which is the right default.
18. **`src/lib/demoData.ts` seeds interviews with no model fields at all.** `SARAH_INTERVIEW`, `MARCUS_INTERVIEW`, `PRIYA_INTERVIEW` (`:182,284,387`) carry `studyRevision` and nothing else from the provenance family, even though the demo study config names `gemini` (`:50-51`). The sample workspace already renders `—` in the Model column, and that precedent is followed here.
19. **The e2e suite records the model of every provider call.** `workflow.calls` entries are `{ transport, operation, model }` (`tests/e2e/workflow-fixture.ts:28,118-119`), and the study it creates selects OpenAI with the default model (`research-workflow.spec.ts:15`). So the browser suite can assert the stored conducting model against the model the interview-operation calls actually used — the only place in the repo where that comparison is possible.

---

## O3. The decision: what is recorded, and when

### O3.1 At save, from the canonical study, and that is not a compromise

The brief asked whether to record at the first turn, at save, or both, and how to represent a config that changed in between. **Record at save from the canonical study config. There is no "in between" to represent.**

Facts O2.1–O2.5 compose into a proof: the participant session is pinned to a revision; a model change bumps the revision; a bumped revision 409s every subsequent participant request including the save. So for any interview that reaches storage, the config at save time *is* the config every turn ran under. A first-turn snapshot would record the same string, at the cost of a new server-side per-session record (the browser cannot be asked to carry it — Law 1), a TTL, a fault cut, and a reconciliation story. A "record at save and flag a divergence" design would ship a flag that can never be set.

The corollary is worth stating in the handback, because it is the thing the owner actually asked about: **a researcher cannot switch models mid-interview.** They can switch mid-*study*, freely, and that is what this slice makes visible. An in-flight participant at the moment of the switch loses their session with `This study link was replaced after the study changed.` — existing behaviour, out of scope here, and worth its own look if it turns out to bite in the field.

### O3.2 Two fields, not four

Recorded: the provider and the model, both copied verbatim from `canonical.study.config`. **Not** recorded: a requested/resolved pair, and not a routed provider.

The synthesis family has four fields because a synthesis call returns a provider-reported response model and, under the Gateway, a mapped model id and a pinned creator route (`shared.ts:18-30`, `gateway.ts:235-241`). A turn returns none of that (O2.8). Deriving a routed provider or a gateway model id at save time would mean recomputing transport from an environment that may have been redeployed since the turns ran — precisely what `tests/unit/api.save.idempotent.test.ts:187-220` ("stores signed generation-time provenance when provider resolution changes before save") exists to forbid. Two fields, both provably pinned by the revision, and nothing else.

### O3.3 The honest limit, and why it goes in the label

What is recorded is the model the study **asked for**, not a model any provider **reported**. Under `AI_TRANSPORT=gateway` the wire actually carried `toGatewayModelId(provider, model)` and the response carried a `modelId` that was thrown away. So:

- The UI label is **"Conducted by"**, never "executed by", "ran on", or "responded as".
- The two model strings in a footer are **not** parallel evidence: `Synthesized by` is provider-reported, `Conducted by` is study-configured. The footer prints both without claiming they were measured the same way, and the spec does not try to close the gap with an asterisk.
- Making them parallel is a real, separable slice: change `generateInterviewResponse` and `getInterviewGreeting` to return `ProviderResult`, thread execution through five adapters, and accumulate per-session on the server. It is listed in "Deferred" and is not attempted here.

### O3.4 Naming

**`conductedByProvider: AIProviderType` and `conductedByModel: string`.**

- The brief's `interviewAiProvider`/`interviewAiModel` is rejected: the record is already called an interview, so `interview.interviewAiModel` and `interview.aiModel` are indistinguishable at a glance in review — which is the exact ambiguity this slice exists to remove.
- Renaming the existing `aiProvider`/`aiModel` to `synthesisAiModel` is rejected as out of scope: they are signed into receipt v3 (`src/lib/synthesisReceipt.ts:53-56`), reused verbatim on `AggregateSynthesisResult` (`types.ts:391-394`), and live on immutable stored records. They keep their names and gain a doc comment saying what they mean.
- `conductedByModel` is the UI label spelled as a field name, which is how `savedAt` and `consentAcceptedAt` already read. It sorts next to `consentHash`/`participantLinkId` as another fact about how the record came to exist.

---

## O4. The shapes (`src/types.ts`)

```ts
export interface StoredInterview {
  // ... unchanged through consentAcceptedAt ...

  /**
   * The provider and model that produced this interview's SYNTHESIS, taken
   * from the signed receipt at save time. The synthesis model is a fixed
   * per-provider constant (providerRegistry.ts SYNTHESIS_MODEL_BY_PROVIDER),
   * not a researcher choice. `aiModel` is provider-reported; under the Gateway
   * `requestedAiModel` is the mapped model id and `routedProvider` the pinned
   * creator route.
   */
  aiProvider?: AIProviderType;
  aiModel?: string;
  requestedAiModel?: string;
  routedProvider?: string;

  /**
   * The provider and model that conducted the CONVERSATION — the researcher's
   * own choice, snapshotted server-side from the canonical study config at
   * save time. Safe to treat as the model every turn used: the participant
   * session is pinned to a study revision (auth.ts), a config edit advances
   * that revision (kv.ts REPLACE_STUDY_CONFIG_SCRIPT), and a moved revision
   * refuses every participant request (researcherContext.ts) — so the config
   * cannot change inside one interview.
   *
   * This is the model that was ASKED FOR, not one a provider reported: an
   * interview turn returns no execution provenance (ai.ts AIProvider). Absent
   * on every interview saved before Slice O; render those as "not recorded"
   * and never fill them in from the study's current config.
   */
  conductedByProvider?: AIProviderType;
  conductedByModel?: string;

  participantLinkId?: string;
}
```

No other type changes. `StudyConfig`, `AggregateSynthesisResult`, `SynthesisProvenance` and every `EvidenceRef` shape are untouched.

---

## O5. The write path (`src/app/api/interviews/save/route.ts`)

### O5.1 The diff

Two fields on the `interview` object literal (`:182-205`), between the synthesis provenance block and `participantLinkId`:

```ts
      aiProvider: synthesisProvenance.aiProvider,
      aiModel: synthesisProvenance.aiModel,
      requestedAiModel: synthesisProvenance.requestedAiModel,
      routedProvider: synthesisProvenance.routedProvider,
      // The researcher's own choice, at the revision this session is pinned to.
      // Never from the body: see interviewSubmission.ts's explicit field copy.
      conductedByProvider: canonical.study.config.aiProvider,
      conductedByModel: canonical.study.config.aiModel,
      participantLinkId: linkId,
```

`canonical.study.config` has already passed `validateStudyConfig`, so both values are a known provider and a model `isKnownProviderModel` accepts (O2.6). The route adds no validation of its own; a second check here would be a second source of truth for a rule `canonicalStudy.ts` already fails closed on.

### O5.2 They enter the submission fingerprint

`submissionFingerprint` (`:207-221`) gains the same two keys, in the same order as the object:

```ts
      conductedByProvider: canonical.study.config.aiProvider,
      conductedByModel: canonical.study.config.aiModel,
```

**Why include them.** The fingerprint's job is to let a `persist-repair` retry recognize its own earlier attempt (`:223-252`). It should cover every server-derived field of the stored record, or a repair could confirm a guard written for a materially different record. Divergence across attempts is impossible for the same reason the whole slice works: the revision is pinned, so both attempts read the same config, and if it moved the second attempt 409s in `resolveParticipantOrPreviewContext` long before a fingerprint is computed.

**What it costs.** One hand-computed fingerprint in `tests/unit/api.save.idempotent.test.ts:404-416` must gain the two keys, and the canonical-study mock at `:92-98` must gain `aiProvider`/`aiModel` on its config so the values are not `undefined`. That is the whole cost, and O13 names it.

### O5.3 The client cannot assert it

`validateInterviewSubmission` returns an explicit seven-field copy (`interviewSubmission.ts:139-147`), so `conductedByModel` in a request body is already unreachable. The adversarial regression in O13 posts one anyway and asserts the persisted record carries the canonical study's value — because the guarantee is "the route writes the server's value", not "the validator happens to be a whitelist today".

### O5.4 Not touched

`src/lib/kv.ts` (O2.10), `src/lib/synthesisReceipt.ts` (the conducting model is not signed — it is not a claim the browser carries), `src/app/api/interview/route.ts`, `src/app/api/greeting/route.ts`, `src/app/api/synthesis/route.ts`, every file under `src/lib/providers/`, `src/lib/prompts/`, `src/lib/aiTransport.ts`, `src/lib/providerSchemas.ts`, `src/lib/providerValidation.ts`, `src/lib/requestLog.ts`.

---

## O6. `ProvenanceFooter` (`src/components/SynthesisReading.tsx`)

One optional prop, one leading clause:

```ts
export interface ProvenanceFooterProps {
  /** The model that produced the reading above. Provider-reported. */
  model?: string
  /**
   * The model that conducted the conversation, when the record names one.
   * Per-interview only — an aggregate spans interviews and has no single
   * conducting model, so StudyDetail does not pass it and its footer is
   * unchanged. Omitted (not `undefined`-defaulted) means "no such fact for
   * this reading"; `'not recorded'` is rendered by the consumer, not here.
   */
  conductedBy?: string
  studyRevision?: number
  timestamp: string
  verb: 'saved' | 'generated'
  note?: string
}
```

```tsx
  const line = [
    ...(conductedBy ? [`Conducted by ${conductedBy}`] : []),
    `Synthesized by ${model || 'unrecorded model'}`,
    `study rev ${studyRevision ?? '—'}`,
    `${verb} ${timestamp}`,
    ...(note ? [note] : []),
  ].join(' · ');
```

`InterviewDetail.tsx:275-280` passes `conductedBy={interview.conductedByModel ?? 'not recorded'}` — always present on a per-interview footer, so a legacy interview reads `Conducted by not recorded · Synthesized by gemini-2.5-flash · study rev 3 · saved Jan 1, 2026`. Two different honesty strings sit in one line (`not recorded` and the existing `unrecorded model`); keep both rather than unifying, because they answer different questions and the existing one is pinned at `tests/unit/SynthesisReading.test.tsx:128`.

`StudyDetail.tsx:523-533` passes nothing new. Its footer must stay byte-identical; `StudyDetail.aggregate.test.tsx:166,191` is the guard.

The provider name is not printed. A model id already names its provider unambiguously (`gemini-3.7-flash`, `claude-opus-5`, `openai/gpt-5.6-terra`), and DIRECTION §3 wants the machine-verifiable fact, not a gloss. `conductedByProvider` exists on the record for the export and for grouping, not for this line.

---

## O7. The registers

### O7.1 Dashboard (`src/components/Dashboard.tsx`)

The existing `Model` column is renamed and joined by a sibling, both at the existing `lg:table-cell` breakpoint:

| header | cell |
|---|---|
| `Conducted` | `<Coordinate>{interview.conductedByModel ?? 'not recorded'}</Coordinate>` |
| `Analyzed` | `<Coordinate>{interview.aiModel ?? 'not recorded'}</Coordinate>` |

Order: … Turns · **Conducted** · **Analyzed** · Status. The existing `—` at `:365` becomes `not recorded` in both cells so the register and the footer say the same word for the same absence.

**Two columns, not one with a disclosure.** DIRECTION §4 makes dashboards dense scannable ruled registers with keyboard nav; two mono columns of short ids are exactly that. A single cell with two unlabelled stacked ids is not scannable — nothing in the cell says which is which — and a disclosure hides the one fact a researcher opens this screen to scan. Both columns stay hidden below 1024px, where the register already sheds Started, Duration and Turns.

### O7.2 StudyDetail's interview register (`src/components/StudyDetail.tsx:559-585`)

Gains one `Conducted` column at `md:table-cell` (matching Duration and Turns), same cell content. Not an `Analyzed` column: within one study the synthesis model is a per-provider constant and cannot vary unless the provider changed, so a column of identical strings would be noise. The per-interview analysis model stays one click away in the footer.

---

## O8. The reminder (`src/components/StudyDetail.tsx`)

### O8.1 The histogram

One `useMemo` beside `eligibleInterviewCount` (`:63-66`):

```ts
// Counts by (provider, model) pair — two providers could in principle expose
// the same model id, and the pair is what the record actually stores.
const conductingModels = useMemo(() => {
  const counts = new Map<string, { provider?: string; model?: string; count: number }>();
  for (const interview of interviews) {
    const key = interview.conductedByModel
      ? `${interview.conductedByProvider ?? ''} ${interview.conductedByModel}`
      : ' ';
    const entry = counts.get(key)
      ?? { provider: interview.conductedByProvider, model: interview.conductedByModel, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count
    || (a.model ?? '').localeCompare(b.model ?? ''));
}, [interviews]);

const recordedModelCount = conductingModels.filter(entry => entry.model).length;
```

Sorted by count descending, model id ascending on a tie — stable under a page reload, which the newest-first load order (`kv.ts:666`) is not.

### O8.2 When it fires, and what it says

**Fires when `recordedModelCount >= 2`.** Legacy interviews alone never trigger it: a study of seven pre-Slice-O interviews is not evidence of a switch, and firing on it would make the reminder mean "this deployment is old", which is not the owner's question. When it does fire and unrecorded interviews exist, they are listed as a trailing term.

A `Notice tone="neutral"` above the register on the Interviews tab:

> **Eyebrow:** `Conducted with 2 models`
> **Body:** `gemini-3.7-flash ×4 · gemini-3.8-flash ×3 · not recorded ×1`
> `Switching models is recorded on each interview, not blocked. Keeping one model across a study makes interviews easier to compare.`

The counts line is a `Coordinate` (Plex Mono, tabular numerals — DIRECTION §3). The eyebrow counts **recorded** models only, so it never says "2 models" when one of the two is an absence. The second sentence is the reminder the owner asked for and the whole of it: no warning tone, no error colour, no blocking, no "are you sure". `tone="neutral"` is a deliberate choice against `tone="error"` — a switch is a legitimate research decision, and terracotta is reserved for failure (DIRECTION §2).

Not shown when the study spans one model: a register that reads `gemini-3.7-flash` on every row already says so, and a banner restating it is the earth-tone-SaaS drift DIRECTION §11 warns about.

---

## O9. Export (`src/app/api/interviews/export/route.ts`)

- **Per-interview JSON is already done.** `zip.file(..., JSON.stringify(interview, null, 2))` at `:120`, and `InterviewDetail`'s Download JSON at `:97`, both serialize the whole record. Two new fields appear in both with no edit.
- **`summary.csv` gains two columns, appended after Key Insight** so `cells[6]` stays put (O2.16):

  ```ts
  'Interview ID,Study,Date,Duration (min),Messages,Themes,Key Insight,Conducted Model,Analysis Model',
  ```

  and, in the row builder (`:135-137`), `,${csvCell(interview.conductedByModel ?? '')},${csvCell(interview.aiModel ?? '')}`. Empty, not `not recorded`: a spreadsheet's blank cell is the honest form of "no value", and a filter for "which model" should not have to exclude a sentence. Both go through `csvCell` for uniformity even though no valid model id can begin with a formula character.
- **Neither markdown generator is edited.** `generateTranscript` (`export/route.ts:24-84`) and `InterviewDetail.handleDownloadTranscript` (`:107-152`) are near-duplicates already; adding a header line to one and not the other is how they drift further apart, and adding it to both duplicates the change. The transcript is the participant's words; the model that produced them is a fact about the record, and the record ships as JSON alongside it. If the owner wants it in the markdown, it is a `SynthesisReading`-style extraction of one shared generator, in its own slice.
- **The aggregate export is untouched.** `aggregates/<studyId>.json` (`:124-126`) carries `AggregateSynthesisResult`, which has no conducting model (O6).

---

## O10. `StudySetup` / `ProviderSection`

**Not in this slice, and here is the price of putting it in.** `StudySetup` in edit mode receives `study.config` through `sessionStorage` and nothing else (O2.15). To say *"7 interviews were conducted with gemini-3.7-flash; new interviews will use gemini-3.8-flash"* it needs a per-model histogram over the study's interviews, and every way to give it one is disproportionate to a one-line note:

- **Compute it in the browser** — `getStudyInterviews(studyId)` pulls every transcript of the study into a form page to render one sentence.
- **Compute it server-side on `GET /api/studies/[id]`** — doubles the interview-collection read on the StudyDetail page, which already fetches both.
- **Maintain a histogram on `StoredStudy`** — the structurally clean answer, and the most expensive: a new field inside the persist script's Lua, a new fault cut, `tests/helpers/faultManifest.ts`, and the atomicity suite. That is a Storage-train slice, not a note.
- **Pass it through `sessionStorage` from `StudyList`** — `StudyList` does not have it either, and browser-carried claims about the record are what Law 1 exists to refuse.

What ships instead: **the reminder lives at O8, on the surface that already holds the data**, and the ProviderSection read block (`ProviderSection.tsx:182-192`) gains one sentence that is true without any new data. `StudySetup` calls `getStudy(studyId)` once in edit mode — a single cheap read of the study record it is already editing, no interviews — and passes `interviewCount` down:

> `7 interviews have already been collected. Each interview records the model that conducted it; changing the model here affects only new interviews.`

Rendered as a `Notice tone="neutral"` inside `statusBlocks` when `interviewCount > 0`, so it appears in both read and edit mode like the other four status blocks (`ProviderSection.tsx:142-168`). It deliberately does **not** name the earlier model, because the component cannot know whether the current config is what those seven ran under — that is exactly the inference Law 3 forbids. The researcher who wants the breakdown is one link away.

**Open question 2** asks whether the owner wants the named-model version enough to buy one of the four options above.

---

## O11. Legacy records and the demo

- A record without `conductedByModel` renders `not recorded` in the register (O7), `Conducted by not recorded` in the footer (O6), and an empty CSV cell (O9). It is **never** filled in from `study.config.aiModel`, even where the study is right there in the same component's state (`StudyDetail`) — that inference is the one thing this slice must not do, and O13 tests it explicitly.
- `src/lib/demoData.ts` is **not** backfilled. Its three seeded interviews already carry no `aiModel` (O2.18) and already render `—` today; they were conducted by no model at all, and stamping one on them would be the same fabrication in the sample workspace. They will read `not recorded`.
- The keyless `/demo` (`DemoSimulation.tsx`) is untouched: it renders no register and no footer.

---

## O12. Telemetry, storage and transport

Nothing. No new `requestLog` event or field, so the "Structured request logs" change-map row is not tripped. No kv function, key, prefix, script, arity or fault cut, so "Storage/tenancy" is not tripped. No prompt, adapter, schema, transport or provider-validation file, so "Providers/provenance" is not tripped. **If an implementation finds it needs one of those, stop and hand back** — it has left the slice.

---

## O13. Tests

### Must keep passing, unchanged

- **`tests/unit/StudyDetail.aggregate.test.tsx`** in full, especially the anchored footer regexes at `:166` and `:191`. The aggregate footer does not gain a clause; if this file moves, `conductedBy` leaked into `StudyDetail`.
- **`tests/unit/SynthesisReading.test.tsx`** in full, including `:123` (`'Synthesized by m · study rev 3 · saved Jan 1, 2026'`), `:128` and `:147`. The new prop is optional and every existing case omits it.
- **`tests/unit/Synthesis.register.test.tsx:131`** — the participant still sees no footer.
- **`tests/unit/Dashboard.register.test.tsx`, `Dashboard.idColumn.test.tsx`, `StudyDetail.register.test.tsx`, `StudyDetail.participantLinks.test.tsx`, `InterviewDetail.trace.test.tsx`, `Export.register.test.tsx`, `Export.mode.test.tsx`** in full. None asserts a model column or count.
- **`tests/unit/api.save.evidenceRefs.test.ts`** in full — it asserts the synthesis provenance fields reach `persistCompletedInterview` and must keep doing so with the new fields alongside.
- **`tests/unit/synthesisReceipt.test.ts`, `api.followup.provenance.test.ts`, `api.aggregate.revision.test.ts`, `api.aggregate.citations.test.ts`, `kv.atomicPersistence.test.ts`, `kv.aggregatePersistence.test.ts`, `requestLog.test.ts`, `api.synthesis.telemetry.test.ts`, `studyConfigValidation.test.ts`** in full.
- **`tests/e2e/demo-no-provider.spec.ts`** in full.

### Rewritten by this slice, and why

1. **`tests/unit/api.save.idempotent.test.ts`** — the canonical-study mock at `:92-98` gains `aiProvider: 'gemini', aiModel: DEFAULT_GEMINI_MODEL` on its config, and the hand-computed fingerprint at `:404-416` gains `conductedByProvider` and `conductedByModel` with the same values. Every existing assertion then passes: `:168-185`'s `objectContaining` is unaffected by added keys, and `:187-220`'s "provider resolution changes before save" case still proves the *synthesis* fields come from the receipt and not from the environment. Add the two cases in the next section to this file.
2. **`tests/unit/InterviewDetail.reading.test.tsx`** — the fixture at `:46` keeps `aiModel: 'gemini-2.5-flash'`; `:91`'s `startsWith('Synthesized by …')` becomes `startsWith('Conducted by not recorded · Synthesized by gemini-2.5-flash · study rev 3 · saved ')`, and a second case gives the fixture `conductedByModel: 'gemini-3.7-flash'` and asserts the `Conducted by gemini-3.7-flash · Synthesized by gemini-2.5-flash` prefix. That pair is the honest-labelling contract in one file.
3. **`tests/unit/api.export.csvFormulas.test.ts`** — the header row assertion (if the file grows one) and the two new trailing cells; every `cells[n]` index at `:88,:99,:106` is unchanged by construction, and if one moves the columns were inserted rather than appended.

### New, smallest realistic regressions

- **Extend `tests/unit/researcherContext.revokedLink.test.ts`** with the fact the whole slice rests on and nothing currently pins (O2.4): a token with `studyRevision: 1` against `makeStoredStudy({ id: 'study-open', revision: 2 })` returns `{ valid: false, statusCode: 409 }` with an error containing `replaced`, and no context. Placed beside the existing legacy-study 409 at `:101-121`. **This is the load-bearing test of the design decision**, not a nicety: if it ever goes red, a save-time snapshot stops being provably the turn-time model and O3.1 must be rewritten.
- **Extend `tests/unit/api.save.idempotent.test.ts`** with two cases:
  - *the record names the canonical study's model* — the canonical mock's config carries `aiProvider: 'claude', aiModel: DEFAULT_CLAUDE_MODEL` while the receipt mock returns `aiProvider: 'claude', aiModel: CLAUDE_SYNTHESIS_MODEL`; assert `persistCompletedInterview` is called with an object matching **both** `{ aiModel: CLAUDE_SYNTHESIS_MODEL, conductedByModel: DEFAULT_CLAUDE_MODEL }`. One assertion, both fields, and it fails if either is copied from the other.
  - *the adversarial case* — the same request body additionally carries `conductedByProvider: 'openai'`, `conductedByModel: 'attacker/model'` and a `studyConfig: { aiModel: 'attacker/model' }`; assert the persisted object still carries the canonical study's provider and model, and that neither attacker string appears anywhere in `JSON.stringify` of the persisted record.
- **Extend `tests/unit/Dashboard.register.test.tsx`** — with two interviews, one carrying `conductedByModel: 'gemini-3.7-flash'` and one carrying none, assert `columnheader` `Conducted` and `Analyzed` both exist, that `gemini-3.7-flash` renders, and that `not recorded` renders exactly once per absent field. Assert no cell renders `—`.
- **New `tests/unit/StudyDetail.conductingModels.test.tsx`** — the reminder's whole contract, driven through the rendered Interviews tab:
  - four interviews on `gemini-3.7-flash` and three on `gemini-3.8-flash` render the eyebrow `Conducted with 2 models` and the counts `gemini-3.7-flash ×4 · gemini-3.8-flash ×3`, in that order (count descending);
  - seven interviews on one model render **no** notice;
  - seven interviews with no `conductedByModel` render **no** notice, and — the inference test — the study's own `config.aiModel` appears nowhere in the rendered register or notice region even though `study.config` is loaded;
  - a mixed study of two recorded models plus one legacy interview fires, and the counts line ends `· not recorded ×1`;
  - the notice's tone is neutral: assert it does not carry the error border class, so a later refactor cannot quietly turn a reminder into a warning.
- **Extend `tests/e2e/research-workflow.spec.ts`** at the interview-JSON block (`:91-98`), where the study is OpenAI at the default model and `workflow.calls` records every call's model (O2.19):

  ```ts
  expect(interview.conductedByProvider).toBe('openai');
  expect(interview.conductedByModel).toBe(DEFAULT_OPENAI_MODEL);
  const interviewCall = workflow.calls.find(call => call.operation === 'interview')!;
  expect(interviewCall.model).toBe(
    transport === 'gateway' ? `openai/${DEFAULT_OPENAI_MODEL}` : DEFAULT_OPENAI_MODEL,
  );
  expect(interview.conductedByModel).not.toBe(interview.aiModel);
  ```

  The third assertion is O3.3 made executable: under the Gateway the recorded string and the wire string differ by the transport mapping, and the test says so rather than papering over it. The fourth pins that the conducting and analysis models are genuinely two different facts in a real run. Then, on the interview detail page, `await expect(page.getByText(/^Conducted by .+ · Synthesized by /)).toBeVisible()`.

Do not snapshot any component in this slice.

---

## O14. Verification

Two change-map rows are tripped: **Researcher UI** (`Dashboard.tsx`, `StudyDetail.tsx`, `InterviewDetail.tsx`, `SynthesisReading.tsx`, `ProviderSection.tsx`, `StudySetup.tsx`) and **Completion and export** (`save/route.ts`, `export/route.ts`).

```bash
# Completion and export
npx vitest run tests/unit/api.save.idempotent.test.ts tests/unit/api.save.evidenceRefs.test.ts \
  tests/unit/api.export.csvFormulas.test.ts tests/unit/Export.mode.test.tsx \
  tests/unit/Export.register.test.tsx tests/unit/synthesisReceipt.test.ts \
  tests/unit/Synthesis.completion.test.tsx tests/unit/Synthesis.lifecycle.test.tsx

# Participant authority — the fact the design rests on
npx vitest run tests/unit/researcherContext.revokedLink.test.ts \
  tests/unit/researcherContext.authority.test.ts tests/unit/api.participant.canonicalContext.test.ts \
  tests/unit/canonicalStudy.validation.test.ts

# Researcher UI
npx vitest run tests/unit/Dashboard.register.test.tsx tests/unit/Dashboard.idColumn.test.tsx \
  tests/unit/StudyDetail.conductingModels.test.tsx tests/unit/StudyDetail.register.test.tsx \
  tests/unit/StudyDetail.aggregate.test.tsx tests/unit/InterviewDetail.reading.test.tsx \
  tests/unit/SynthesisReading.test.tsx tests/unit/Synthesis.register.test.tsx \
  tests/unit/StudySetup.document.test.tsx tests/unit/StudySetup.notices.test.tsx
```

Then the proportional gate:

```bash
npm run check
DEPLOYMENT_MODE=standalone npm run build
DEPLOYMENT_MODE=hosted AI_TRANSPORT=direct npm run build
npm run test:e2e
git diff --check
```

`npm run test:redis-crash` and `npm run test:adversarial` are not required by the change map for this slice — no storage script, no tenancy path, no wire family changes. Run them anyway before the handback; they are cheap and they are the only real-wire evidence that a record with two new fields round-trips.

Then the greps, each of which must return no output:

```bash
git diff --stat src/lib/kv.ts src/lib/wire/ src/lib/redisPort.ts src/lib/kvClient.ts
git diff --stat src/lib/providers/ src/lib/prompts/ src/lib/ai.ts src/lib/aiTransport.ts
git diff --stat src/lib/providerSchemas.ts src/lib/providerValidation.ts src/lib/synthesisReceipt.ts
git diff --stat src/lib/requestLog.ts src/lib/demoData.ts src/components/DemoSimulation.tsx
grep -rn "conductedBy" src/app/api/interview/ src/app/api/greeting/ src/app/api/synthesis/
grep -rn "config.aiModel" src/components/Dashboard.tsx src/components/InterviewDetail.tsx
```

The last two are the inference guard: the conducting model is written in exactly one route and read from the record in exactly the read surfaces, never reconstructed from a study config at render time.

Then by hand, at **375px** and 1280px:

- `/dashboard` with at least one legacy and one post-slice interview — both new columns hidden below 1024px, `not recorded` legible, no horizontal body scroll at 375px.
- `/studies/<id>` → Interviews, on a study spanning two models — the notice above the register, the counts line in mono, the register's Conducted column present at ≥768px.
- `/dashboard/interview/<id>` → Analysis — the two-model footer line wraps rather than overflowing at 375px.
- `/setup?prefill=edit&studyId=<id>` on a study with interviews — the AI Provider section's count sentence in both read and edit mode.

---

## Hard constraints

- Two fields, written in one place: `save/route.ts`. Anything else writing `conductedByModel` is a bug.
- The conducting model is never derived at read time from a study config. Not in a component, not in a route, not in a test fixture helper.
- The aggregate footer, the participant flow, the keyless demo and the sample-workspace seed produce byte-identical output to before this slice.
- No new API route, no new Redis key, no new log field, no new dependency.
- Wine and ochre appear nowhere in this slice: it introduces no evidence and no disclosure. The notice is `tone="neutral"`.

## Deferred, do not attempt

- **Real turn-time execution provenance.** Changing `generateInterviewResponse`/`getInterviewGreeting` to return `ProviderResult`, threading it through five adapters, and accumulating a provider-reported model per participant session on the server. It is the only way to make `Conducted by` as measured as `Synthesized by`, and it is a Providers/provenance + Storage slice of its own.
- **A dynamic model list from each provider's `models` endpoint** (owner keynote) — explicitly a separate slice; `PROVIDER_MODELS` stays a static registry here.
- **Choosing the synthesis model.** `resolveSynthesisModel` stays a fixed per-provider constant; this slice only labels it honestly.
- **A per-study config history.** The snapshot on each interview is the record; a versioned config log is a Storage feature with its own retention and tenancy questions.
- **Backfilling legacy interviews or `demoData.ts`.**
- **Blocking, warning-toning, or confirming a mid-study model change.** The owner ruled it the researcher's choice.
- **Model ids in the markdown transcripts** until the two generators are one (O9).

---

## Open questions for the owner

1. **Does the reminder belong on the Overview tab as well as Interviews?** As specced it sits above the interview register, where the evidence is. A researcher who only ever opens Overview to run the aggregate analysis will not see it — and an aggregate over interviews conducted by two different models is arguably the moment it matters most. Making it a second consumer is trivial; the question is whether a study-level fact should interrupt the analysis reading.
2. **Is the named-model note in ProviderSection worth a new read?** O10 ships an unnamed version (`7 interviews have already been collected…`) for the cost of one existing endpoint call. Naming the earlier models (`7 interviews were conducted with gemini-3.7-flash`) costs either a full interview-collection load inside a form page, or a server-computed histogram on `GET /api/studies/[id]`, or a counter maintained in the persist script's Lua. If the answer is yes, which price.
3. **Should a mid-interview model change end the participant's session as silently as it does today?** O3.1 discovered that it already does: the in-flight participant gets `This study link was replaced after the study changed.` and their transcript is lost. That is correct fail-closed behaviour and out of this slice's scope, but the owner may want the researcher warned before saving an edit to a study with a live participant session — a different feature, on a different surface.
4. **`Conducted` / `Analyzed` as the two register headers?** They are short, parallel, and match the footer's `Conducted by` / `Synthesized by`. The mismatch between the column word (`Analyzed`) and the footer word (`Synthesized`) is deliberate — the column has ~9 characters of room — but it is a vocabulary split, and DIRECTION §11 is strict about one word per job.

---

## Rulings (owner-delegated, 2026-09-05)

Anchors O2.1–O2.3 re-verified against `main` at `ea186d4` (auth.ts:59,75; kv.ts REPLACE_STUDY_CONFIG_SCRIPT; researcherContext.ts:649-650, 747-748). The design decision in O3.1 stands.

1. **Overview tab — yes.** The same reminder renders on Overview, directly above the aggregate analysis action, under the same `recordedModelCount >= 2` condition and with identical copy. Extract the notice into one small component (`ConductingModelsNotice`, local to `StudyDetail.tsx` or `src/components/studyDetail/` if that directory exists) so both tabs are one consumer. Add an Overview case to `StudyDetail.conductingModels.test.tsx`; the aggregate footer regexes in `StudyDetail.aggregate.test.tsx` must still pass untouched.
2. **ProviderSection named-model note — no.** Ship O10 as written (unnamed sentence, one `getStudy` read, `interviewCount > 0`). If `getStudy` does not return an interview count, use whatever count the study record already exposes; if none exists, drop the sentence entirely rather than adding a read of the interview collection. Flag which branch was taken in the handback.
3. **Mid-interview edit ending a live session — out of scope.** Recorded as a follow-up in the brief's decision log. No warning UI in this slice.
4. **Headers: `Conducted` / `Synthesized`.** One word per job wins over the shorter `Analyzed`; the footer already says "Synthesized by", and the column has room at `lg:`.

Additional rulings:
- Branch: `feat/slice-o-conducting-model` from `main`. Do not commit.
- Copy is final as written in O8.2 and O10, with header change per ruling 4.
- Under `tone="neutral"`: verify `Notice` actually exposes that tone; if its tones are named differently, use the non-error/non-disclosure one and report the name.
