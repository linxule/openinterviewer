# Initiative 2 — EvidenceRef: the implementation spec

> **Status (2026-08-27):** I2a shipped (`ad0697d`), I2b shipped (`2b54c3e`), I2d shipped (`dff5312`). I2c (aggregate) deferred by Ruling 3 — specced below, unbuilt. The A9 researcher walkthrough of the trace UI is still owed.

Implements `docs/design/initiative-2-brief.md`. Every "decision of record" in that brief is settled and is treated here as a requirement, not a question. Context: `docs/design/DIRECTION-final.md` §3 (the two laws), §7 (researcher workspace), §8 (Initiative 2), amendments A1, A5, A7; `docs/design/slice-D-spec.md` §D6 (the reference implementation of the trace grammar); `docs/design/slice-F-spec.md` §F2 (why no wine shipped in Slice F, and what has to arrive together with it).

Three slices, strictly ordered: **I2a** (schema, prompt, validation) → **I2b** (trace UI) → **I2c** (aggregate, a candidate later phase). I2b cannot start before I2a is accepted; nothing in I2b is safe against a schema that is still moving.

**Prime directive, inverted from Slice F.** Slice F was a re-registering that changed no logic. This one changes the record. So the directive is: *the stored record and its receipt are the fixed point, and everything else bends around them.* No stored interview is rewritten. No receipt verification path changes behaviour. If a change would make an already-saved interview fail to load, fail to render, or fail to save, it is wrong, however clean it looks.

---

## I2.0 Repo facts this spec is built on

These were verified by reading the source at spec time. Each one constrains a decision below; re-verify any that look stale before implementing.

1. **The synthesis receipt binds a digest of the exact validator output.** `/api/synthesis` signs `digest({transcript, participantProfile, behaviorData, synthesis})` where `synthesis` is `validateSynthesisResult(providerOutput)` (`src/app/api/synthesis/route.ts:156–169`, `src/lib/synthesisReceipt.ts:35–37`). `/api/interviews/save` re-runs `validateSynthesisResult` over the client's payload and re-digests it (`src/lib/interviewSubmission.ts:136`, `src/app/api/interviews/save/route.ts:139–151`). **The two validator invocations must produce byte-identical canonical JSON or every save returns 403.** This is the tightest constraint in the initiative.
2. **The transcript the model saw is provably the transcript that gets stored.** The same digest covers `transcript`. A save whose transcript differs by one character from the one sent to `/api/synthesis` fails. Turn numbering is therefore stable between synthesis time and render time without any extra machinery.
3. **All five provider adapters share one schema and one validator.** `synthesisResponseSchema` (`src/lib/providerSchemas.ts:48`) and `validateSynthesisResult` are used by `claude.ts`, `gemini.ts`, `openai.ts`, `openrouter.ts`, and `gateway.ts` without local variation. The wire-schema change is two files; no adapter file is edited.
4. **The wire schema is strict.** `additionalProperties: false` and every property in `required`. A new property must be added to both `properties` and `required`, or structured output will refuse it.
5. **Stored interviews are not deeply validated on read.** `decodeStoredInterview` (`src/lib/kv.ts:114–128`) checks five scalar fields and casts. Old records flow through untouched; backward compatibility is a TypeScript and rendering concern, not a decode concern.
6. **The interview id does not exist at synthesis time.** `/api/synthesis` never receives one; the id is chosen client-side in `Synthesis.tsx`'s `doSave` and first reaches the server at save. See D3 below.
7. **The client cannot amend a synthesis after it is signed.** Any client-side mutation of the synthesis object changes the digest and the save 403s. Verification verdicts therefore cannot be attached to the record on the client, ever.
8. **Aggregate synthesis is never persisted.** `StudyDetail` holds it in `useState` (`src/components/StudyDetail.tsx:33`), and posts it back verbatim to `/api/studies/[id]/generate-followup`, which verifies `verifyAggregateSynthesisReceipt` over it. There are no old-shape aggregate records to be compatible with — but the object must survive a round trip through the browser unmodified.
9. **The aggregate model is shown no quotes.** `buildAggregateSynthesisPrompt` (`src/lib/prompts/synthesis.ts:117–125`) passes theme *names*, preferences, contradictions, insights, and bottom lines — not `evidence`, not transcripts. Today's `representativeQuotes` are therefore composed from summaries, not selected from speech. This is the reason I2c is a separate slice with a provider-interface change, not a UI slice.
10. **The design-law ratchet is at zero.** `eslint.config.mjs` has no allowlist: `font-serif`, `var(--evidence)`, and `var(--disclosure)` are banned outside `src/components/ui/**` for every file under `src/`. New code must pass `--max-warnings=0` with the config **untouched**. Wine reaches the UI only through `Citation`.
11. **`theme.evidence` has four consumers besides the two synthesis readings**: `src/app/api/interviews/export/route.ts:69`, `src/components/Export.tsx:122`, and twelve fixtures in `src/lib/demoData.ts` (the authenticated sample-workspace seed), plus `tests/unit/providerValidation.test.ts`.

## I2.00 AGENTS.md gates that bind this initiative

`AGENTS.md`'s change map names a focused verification for each area a slice touches. Each gate below is restated as an acceptance criterion of the slice that trips it; a slice is not done until its gates are green.

| Gate (AGENTS.md "Change map and focused gates") | Tripped by | Binding acceptance criterion |
|---|---|---|
| **Providers/provenance** — `providers/`, `prompts/`, interview/synthesis routes → *transport/provider/provenance tests + direct/Gateway build contracts + `npm run check`* | I2a (`src/lib/prompts/synthesis.ts`, `src/lib/providerSchemas.ts`, `src/lib/providerValidation.ts`); I2c (adapter signatures) | `tests/unit/providerValidation.test.ts`, `tests/unit/synthesisReceipt.test.ts`, `tests/unit/api.participant.canonicalContext.test.ts`, `tests/unit/api.save.idempotent.test.ts`, `tests/unit/api.aggregate.revision.test.ts`, `tests/unit/api.followup.provenance.test.ts` all pass; the three CI build contracts pass (standalone+direct, standalone+gateway, hosted+direct, non-secret fixture env from `.github/workflows/ci.yml`); `npm run check` clean. |
| **Researcher UI** — components, services, page entry → *paired component/API tests; inspect 375px when layout changes* | I2b, I2c | The paired suites named in each slice's test section pass; a 375 / 1024 / 1440 pass is recorded in the handback. |
| **Shared domain shapes** (`src/types.ts`, listed under "Sources of truth") | I2a | The type change is additive and documented in-file; no `README.md` / `.env.example` contract changes, so per "Definition of done" those files are **not** touched. |
| **Storage/tenancy** — `kv.ts`, `kvClient.ts`, `platformDb.ts`, reconciler | *Not tripped.* | Explicit non-goal: no slice edits `src/lib/kv.ts`, `src/lib/kvClient.ts`, `src/lib/platformDb*.ts`, or the reconciler. If an implementation finds it needs to, it must stop and hand back rather than proceed. |
| **Structured request logs** — `requestLog.ts`, `providerErrors.ts`, API catch sites | *Not tripped in I2a/I2b.* | `REQUEST_LOG_ALLOWLIST` and `REQUEST_LOG_EVENT_ALLOWLIST` (`src/lib/requestLog.ts:5–25`) are closed lists; adding match-rate telemetry means editing both and running the log gate. Deferred — see Open question 5. |
| **Auth/participant authority**, **Participant/preview headers**, **Mode/setup**, **Public demo** | *Not tripped.* | No slice edits `auth.ts`, `proxy.ts`, `researcherContext.ts`, participant libraries, `participantHeaders.ts`, `interviewApi.ts`, `storageService.ts`, `mode.ts`, `hostedConfig.ts`, `DemoSimulation.tsx`, or `app/demo`. |

Also binding from `AGENTS.md` outside the change map:

- **"Never use production credentials, real participant content, or a writable production database for tests"** (Start here §5). Every fixture in this initiative is invented text. Restated per slice.
- **"AI/provider failure is an error. Never substitute a plausible research response"** (Non-negotiable invariants). A quote that cannot be located is reported as unverified. It is never repaired, never replaced with nearby text, never dropped.
- **"Completion persistence and study mutation remain atomic and idempotent under retries and concurrency."** The digest-equality requirement in I2.0 fact 1 is how this initiative honours it.
- **"Synthesis provenance must record the provider and model actually used."** Untouched; the provenance footer keeps rendering from `_receipt` / `StoredInterview` exactly as Slice F left it.
- **Definition of done**: preserve unrelated dirty files, add the smallest realistic regression, run focused verification then the proportional full gate, report migration caveats explicitly, do not commit.

---

# Slice I2a — schema, prompt, and the matcher

Files that may change: `src/types.ts`, `src/lib/providerSchemas.ts`, `src/lib/providerValidation.ts`, `src/lib/prompts/synthesis.ts`, a new `src/lib/evidence.ts`, `src/app/api/interviews/export/route.ts` and `src/components/Export.tsx` (the one branch in A6), `src/components/Synthesis.tsx` and `src/components/InterviewDetail.tsx` (the optional-field guard in A7 and nothing else), and the tests named in A9. **Nothing else.** No other component, no other route, no service, no store, no CSS, no `eslint.config.mjs`.

This slice ships **no visible change**. A record synthesized after it carries citations that nothing yet renders; the two synthesis readings continue to render exactly as Slice F left them, because a new-shape theme has no `evidence` string and Slice F's block is guarded (A8.3). That is deliberate: the schema must be settled and provably round-tripping before any surface promises a trace.

## A1. The type change

In `src/types.ts`, replacing the inline theme shape at `:171`:

```ts
/**
 * A citation: the model's excerpt plus the coordinate it claims the excerpt
 * came from. `turnIndex` is 1-based over the interview's `transcript` array —
 * the same number the researcher sees as `t. N` on the turn. `interviewId` is
 * omitted for citations inside a single interview's synthesis (the containing
 * record is the interview) and is set only on aggregate citations, where the
 * server resolves it. A ref is a claim, not a verified fact: see
 * src/lib/evidence.ts for how a claim is checked against the record.
 */
export interface EvidenceRef {
  quote: string;
  turnIndex: number;
  interviewId?: string;
}

export interface SynthesisTheme {
  theme: string;
  frequency: number;
  /**
   * Free-text supporting passage. Written only by syntheses produced before
   * Initiative 2. Never written by new syntheses; never rewritten on old
   * records, which are receipt-signed and immutable.
   */
  evidence?: string;
  /** Structured citations. Written by every synthesis produced after Initiative 2. */
  evidenceRefs?: EvidenceRef[];
}

export interface SynthesisResult {
  statedPreferences: string[];
  revealedPreferences: string[];
  themes: SynthesisTheme[];
  contradictions: string[];
  keyInsights: string[];
  bottomLine: string;
  _receipt?: string;
}
```

And for the aggregate at `:322`:

```ts
export interface AggregateTheme {
  theme: string;
  frequency: number;
  /**
   * Free-text quotes. REQUIRED until I2c ships: `StudyDetail.tsx:518` maps this
   * field unguarded, and I2a may not edit that file. I2c makes it optional and
   * adds the guard in the same diff.
   */
  representativeQuotes: string[];
  /** Structured citations, each carrying the interviewId the quote came from. Never populated before I2c. */
  quoteRefs?: EvidenceRef[];
}
```

`AggregateSynthesisResult.commonThemes` becomes `AggregateTheme[]`. **The aggregate type lands in I2a; the aggregate prompt, schema, and UI do not** — see I2c. Until I2c ships, `quoteRefs` is never populated and `representativeQuotes` stays required-in-practice. Declaring the type now costs nothing and keeps the two shapes described in one place.

### A1.1 Why two optional fields, and not a union or a migration-on-read

The brief settles that `evidence` is *replaced* by structured references. It also settles that old records must render exactly as Slice F renders them, and that stored records are never rewritten. Those two facts together mean the type must be able to describe both shapes; the only open question is how.

- **A discriminated union on `evidence` (`string | EvidenceRef[]`) is rejected.** It changes the type of an existing field, which breaks `export/route.ts:69`, `Export.tsx:122`, and twelve `demoData.ts` fixtures at compile time, and forces every consumer — including the markdown export, which is honesty-adjacent output — to branch on record age. Worse, it puts a type-level branch inside `validateSynthesisResult`, the one function that must produce identical output on two independent code paths (I2.0 fact 1). Every branch there is a way for the synthesis path and the save path to disagree, and disagreement is a 403 on a real participant's completed interview.
- **Migration-on-read is rejected.** A view that presents an old record as a new-shape object produces bytes that differ from what is stored. Anything that re-digests — the save path, and `generate-followup` for aggregates — would then need to know which shape to digest, and the receipt would be verifying a shape the reader never sees. Receipts sign the original payload; the reader must read the original payload.
- **Two optional fields, with a runtime rule that exactly one is present per theme, is adopted.** Old record: `evidence` present, `evidenceRefs` absent. New record: the reverse. The validator passes through whichever it finds, unchanged and in the same shape it received, which is the simplest possible round trip. No existing consumer breaks at compile time; `export/route.ts` and `Export.tsx` gain one small branch each (A6).

### A1.2 The rollout window is a data-loss hazard, and it decides the validator's tolerance

`validateSynthesisResult` runs on the save path over a payload the client received up to an hour earlier (receipts expire at `1h`, `synthesisReceipt.ts:73`). A participant who synthesizes minutes before a deploy and saves minutes after it will present a **legacy-shaped** synthesis with a **valid** receipt. If the post-deploy validator rejects legacy themes, that interview is destroyed at the moment of submission, with a 400, after the participant has answered every question.

Therefore: **`validateSynthesisResult` must accept the legacy shape permanently.** It is not a transitional kindness; it is the reason the save path does not lose interviews across a deploy boundary. The same holds in reverse for a rollback.

## A2. The wire schema (`src/lib/providerSchemas.ts`)

`synthesisResponseSchema.properties.themes.items` becomes:

```ts
{
  type: 'object',
  additionalProperties: false,
  properties: {
    theme: { type: 'string' },
    frequency: { type: 'number', minimum: 0 },
    evidenceRefs: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          quote: { type: 'string', maxLength: 2000 },
          turnIndex: { type: 'integer', minimum: 1 },
        },
        required: ['quote', 'turnIndex'],
      },
    },
  },
  required: ['theme', 'frequency', 'evidenceRefs'],
}
```

Three things are load-bearing:

1. **`evidence` is removed from the wire schema entirely.** The model is never again asked for a free-text supporting string. `evidence` survives only as a shape the validator can still *read* off an old payload.
2. **`interviewId` is not in the wire schema.** The model cannot know the interview id (I2.0 fact 6) and must never be given the opportunity to invent one. See D3.
3. **`maxItems: 3`.** A cap that is small enough that three open citation notes under one theme is the worst case the visual pass has to survive (see B6), and large enough for a theme that genuinely rests on more than one turn.

`aggregateSynthesisResponseSchema` is **unchanged in I2a**.

## A3. The validator (`src/lib/providerValidation.ts`)

Replace the theme mapper inside `validateSynthesisResult` (`:149–167`) with, in effect:

```ts
const themes = input.themes.map((theme, i) => {
  if (!isRecord(theme)) fail('synthesis', `themes[${i}]`, 'must be an object');
  if (!isNonEmptyString(theme.theme)) fail('synthesis', `themes[${i}].theme`, 'must be a non-empty string');
  if (!isFiniteNonNegativeNumber(theme.frequency)) fail('synthesis', `themes[${i}].frequency`, 'must be a finite non-negative number');

  const hasLegacy = theme.evidence !== undefined;
  const hasRefs = theme.evidenceRefs !== undefined;
  if (hasLegacy === hasRefs) {
    fail('synthesis', `themes[${i}]`, 'must carry exactly one of evidence or evidenceRefs');
  }

  if (hasLegacy) {
    if (!isNonEmptyString(theme.evidence)) fail('synthesis', `themes[${i}].evidence`, 'must be a non-empty string');
    return { theme: theme.theme, evidence: theme.evidence, frequency: theme.frequency };
  }

  if (!Array.isArray(theme.evidenceRefs) || theme.evidenceRefs.length > MAX_EVIDENCE_REFS) {
    fail('synthesis', `themes[${i}].evidenceRefs`, `must be an array of at most ${MAX_EVIDENCE_REFS} items`);
  }
  const evidenceRefs = theme.evidenceRefs.map((ref, j) => { /* per-ref checks, below */ });
  return { theme: theme.theme, frequency: theme.frequency, evidenceRefs };
});
```

Requirements:

- **A3.1** `MAX_EVIDENCE_REFS = 3`, matching the wire schema exactly. A mismatch between the two numbers is a silent 403 generator.
- **A3.2** Per ref: `quote` must be a string with `1 <= length <= MAX_EVIDENCE_QUOTE` (`2_000`, matching the wire schema) — note it is **not** required to be non-empty after trimming, because a whitespace-only quote is a shape the validator should pass through and the *matcher* should classify as unverified. Rejecting it here would turn a bad citation into a failed save. `turnIndex` must satisfy `Number.isInteger(turnIndex) && turnIndex >= 1`. `interviewId`, if present, must match `/^[A-Za-z0-9_-]{1,120}$/` (the repo's `ID` shape, `interviewSubmission.ts:10`). Anything else fails the whole synthesis, exactly as a malformed `bottomLine` does today.
- **A3.3 The returned ref object is built by explicit field copy with conditional spread**, `{ quote, turnIndex, ...(interviewId !== undefined ? { interviewId } : {}) }`, never by spreading the input. An input-spread would carry unknown keys into the digest on one path and not the other.
- **A3.4 Round-trip exactness is the acceptance criterion, not an implementation note.** For any payload `P` that the validator accepts, `digest(validate(P)) === digest(validate(JSON.parse(JSON.stringify(validate(P)))))`. This is what makes the save path work, and it gets its own test (A9.1).
- **A3.5** `themes` is still capped at `MAX_PROVIDER_LIST_ITEMS`; nothing else in the function changes. `validateAggregateSynthesisPayload` is untouched in I2a.

## A4. The prompt (`src/lib/prompts/synthesis.ts`)

### A4.1 Numbered turns

`buildSynthesisPrompt`'s transcript formatting (`:39–41`) becomes:

```ts
const interviewText = history
  .map((m, i) => `TURN ${i + 1} · ${m.role === 'user' ? 'PARTICIPANT' : 'INTERVIEWER'}: ${m.content}`)
  .join('\n\n');
```

The role mapping is copied character for character from today's line — `user` is `PARTICIPANT`, everything else (including `system`) is `INTERVIEWER`. The only change is the prefix. **Numbering runs over every element of `history`, 1-based, regardless of role**, because that is the array the researcher's `t. N` coordinate counts (`slice-F-spec.md` §F5.4 renders `turnIndex={i + 1}`), and because the receipt binds that array (I2.0 fact 2).

### A4.2 The instruction

`Analyze for:` item 3 becomes:

```
3. Key themes, each supported by direct citations from the transcript
```

and a new block is appended after the numbered list:

```
CITING EVIDENCE:
For each theme, provide 1-3 citations in "evidenceRefs". Each citation has:
- "quote": an excerpt copied character-for-character from a single PARTICIPANT
  turn. Do not paraphrase, correct, translate, or tidy it. Do not join text
  from two turns into one quote. If you shorten the middle of a passage, mark
  the omission with an ellipsis (...); do not silently splice.
- "turnIndex": the number printed as TURN N beside that participant turn.
Quote only PARTICIPANT turns. If no single participant turn supports a theme,
prefer leaving that theme out to citing a turn that does not say it. An empty
"evidenceRefs" array is honest and acceptable; an inaccurate quote is not.
```

### A4.3 The echoed output description

`synthesisOutputDescription` (`:88–100`) is updated so the two descriptions of the schema cannot drift:

```
  "themes": [
    {
      "theme": "Theme name",
      "frequency": 3,
      "evidenceRefs": [
        { "quote": "Exact words from one participant turn", "turnIndex": 7 }
      ]
    }
  ],
```

It has no runtime consumer today (`prompts/index.ts` re-exports it; no adapter uses it), which is precisely why it drifts if left alone.

### A4.4 Not changed

`buildAggregateSynthesisPrompt` and `aggregateSynthesisOutputDescription` are untouched in I2a. `greeting.ts` and `interview.ts` are untouched.

## A5. The matcher — `src/lib/evidence.ts` (new)

Pure and dependency-free, in the register of `providerValidation.ts`: no imports beyond `@/types`, no I/O, no logging, no throwing on bad data (it *classifies* bad data — a thrown error here would become a render crash on a real record).

### A5.1 Normalization, in exactly this order

`normalizeForMatch(text: string): { normalized: string; sourceIndex: number[] }` builds a normalized string alongside a parallel array mapping each normalized character back to its index in the original. The map is what makes it possible to display the *record's* characters rather than the model's copy of them (B4.3).

1. **NFKC, applied per grapheme cluster, not per code unit.** Segment the source into grapheme clusters (`Intl.Segmenter` with granularity `'grapheme'`, or an equivalent code-point walk that attaches combining marks to their base), then `cluster.normalize('NFKC')` each cluster. Per-*character* NFKC is wrong here: a combining accent normalized in isolation cannot compose with its base, so a decomposed `e` + U+0301 in the record would never match a precomposed `é` in the quote — failing this spec's own NFKC test case. Each normalized output character maps back to its source cluster's `{start, end}` range; a span's original coordinates are `start = map[normStart].start`, `end = map[normEnd - 1].end`. A cluster that normalizes to the empty string contributes nothing.
2. **Quotation marks fold to ASCII.** `'` ← `U+2018 U+2019 U+201A U+201B U+2032 U+2035`; `"` ← `U+201C U+201D U+201E U+201F U+2033 U+2036 U+00AB U+00BB`.
3. **Dashes fold to ASCII hyphen.** `-` ← `U+2010`–`U+2015`, `U+2212`.
4. **Ellipsis expands.** `U+2026` → `...`.
5. **Zero-width characters are dropped.** `U+200B U+200C U+200D U+FEFF`.
6. **All whitespace collapses.** Every Unicode whitespace character (`\s` plus `U+00A0`) becomes a single space, and runs collapse to one space. Leading and trailing spaces are trimmed.
7. **Case folds.** `toLowerCase()`.

Both sides of a comparison go through the identical function. There is no "normalize the quote a bit more" branch; asymmetric normalization is how a matcher starts blessing things the record does not say.

Additionally, the **quote only** is pre-trimmed before normalization by stripping a single balanced pair of wrapping quotation marks (ASCII or curly, straight-double, single, or guillemet) and any leading or trailing ellipsis. Models routinely hand back `"…felt like work."`, and the wrapping marks are the model's punctuation, not the participant's.

### A5.2 Match semantics: ordered, ellipsis-aware, normalized containment

```ts
export type EvidenceMatch =
  | { status: 'verified'; turnIndex: number; spans: { start: number; end: number }[]; occurrences: number }
  | { status: 'unverified'; reason: UnverifiedReason };

export type UnverifiedReason =
  | 'empty-quote'      // nothing left after normalization
  | 'too-short'        // fewer than MIN_QUOTE_CHARS normalized characters
  | 'no-turn'          // turnIndex out of range for this transcript
  | 'wrong-speaker'    // the cited turn is not a participant turn
  | 'not-found';       // the quote is not in the cited turn
```

`locateQuote(quote: string, turnContent: string): EvidenceMatch['spans'] | null`:

1. Normalize both sides.
2. If the normalized quote is empty → `empty-quote`. If it is shorter than `MIN_QUOTE_CHARS = 4` → `too-short`. (A one- or two-character "quote" would match nearly any turn; a citation that cannot fail is not a citation.)
3. Split the normalized quote on runs of `...` into **segments**; trim each; drop empties. Cap at `MAX_QUOTE_SEGMENTS = 6`; more than that is not a quotation, it is a collage.
4. Scan the segments **in order with a moving cursor**: `idx = haystack.indexOf(segment, cursor)`; if `idx === -1`, the match fails; otherwise record the span and set `cursor = idx + segment.length`. Out-of-order segments therefore fail, which is correct — a citation asserts an order.
5. Map each normalized span back through the cluster map to original coordinates: `start = map[normStart].start`, `end = map[normEnd - 1].end` (see A5.1 step 1).
6. `occurrences` counts how many times the **first** segment appears in the haystack, for the benefit of a future highlight; it does not affect the verdict.

The single-segment case — the overwhelming majority — degenerates to `haystack.includes(needle)`, which is the "normalized substring" semantics the brief asks for.

**Repeated phrases verify.** If a quote occurs at several positions in the cited turn, the citation is still true: the participant said those words in that turn. The first occurrence supplies the span. Failing an honest citation because the participant repeated themselves would be exactly the naive-substring failure mode the challenge rejected, one level up. (See Open question 4.)

### A5.3 Resolving a ref against a record

```ts
export function resolveEvidenceRef(ref: EvidenceRef, transcript: InterviewMessage[]): EvidenceMatch;
```

1. `turnIndex` must be an integer with `1 <= turnIndex <= transcript.length`, else `no-turn`. (`transcript[turnIndex - 1]` is the cited turn; the `- 1` lives here and nowhere else in the codebase.)
2. The cited turn's `role` must be `'user'`, else `wrong-speaker`. A quote located in an interviewer or system turn is *not* the participant's words, and rendering it in quotation marks behind a wine numeral would assert exactly what `slice-F-spec.md` §F2.3 forbids asserting. The prompt asks for participant turns (A4.2); this is the guard that makes the interface honest when the model ignores it.
3. Otherwise `locateQuote` decides.

```ts
export type ThemeEvidenceView =
  | { kind: 'legacy'; text: string }
  | { kind: 'refs'; entries: { ref: EvidenceRef; match: EvidenceMatch; quotedFromRecord: string | null }[] }
  | { kind: 'none' };

export function resolveThemeEvidence(theme: SynthesisTheme, transcript: InterviewMessage[]): ThemeEvidenceView;
```

`quotedFromRecord` is populated only for a verified match: the original-coordinate substrings of the cited turn, one per span, joined by `' … '` (U+2026 with hair spacing as written). It is `null` for every unverified entry. **This is the string the UI puts inside quotation marks** (B4.3). `kind: 'none'` covers a new-shape theme whose `evidenceRefs` array is empty — an honest outcome the prompt explicitly permits.

### A5.4 Where validation runs: at render, from the record

Verification is a pure function of `(ref, transcript)`, and both live inside the same record. It therefore runs **at render time, in the reader, every time**, and its verdict is **never stored**.

- Storing a verdict would create a second source of truth that no later reader can re-check, on a record that is immutable and receipt-signed.
- Computing a verdict at synthesis time and folding it into the signed payload would put a server-computed judgement inside the digest that the save path must reproduce from a client payload it cannot re-derive it from.
- **Synthesis is never rejected or repaired on the strength of a failed match.** An unlocatable quote is displayed as an unverified passage. Discarding the theme, or substituting nearby text, would be the "never substitute a plausible research response" invariant broken in the quietest possible way.

The cost is that a false rejection is invisible to the operator until a researcher notices. That is what Open question 5 is about.

## A6. The two markdown exports

`src/app/api/interviews/export/route.ts:69` and `src/components/Export.tsx:122` both render `- ${t.theme}: ${t.evidence}`. Each gains the minimum branch:

```ts
const support = t.evidence ?? (t.evidenceRefs ?? []).map(r => `"${r.quote}" (turn ${r.turnIndex})`).join('; ');
lines.push(support ? `- ${t.theme}: ${support}` : `- ${t.theme}`);
```

Two constraints. **The export prints the model's `quote` string, not a verified span**, because the export is a dump of the record and the record is what it says it is; and it prints the coordinate so a reader can check it. **The export does not label anything "verified"** — the markdown carries no verification because a text file cannot re-derive one.

This is the one place in I2a where output visibly changes, and only for records synthesized after the slice. `Export.tsx` is a component: this edit trips the **Researcher UI** gate for I2a, and `tests/unit/Export.register.test.tsx` must keep passing.

## A7. What I2a explicitly does not do

- No component renders `evidenceRefs`. `StudyDetail.tsx` is untouched entirely. `Synthesis.tsx` and `InterviewDetail.tsx` receive exactly one edit each: because `evidence` is now optional, the two call sites (`Synthesis.tsx:337`, `InterviewDetail.tsx:283`) must be made type-safe. **That guard is the only edit permitted to those two files in I2a** — wrap the existing `Verbatim` block in `{theme.evidence ? (…) : null}`, changing not one class and not one other character. A new-shape theme then renders its name and no supporting passage. No `Citation`, no wine, no coordinate. That is I2b.
- No aggregate prompt, schema, or UI change.
- No telemetry, no repair path, no retry UI.
- No `eslint.config.mjs` edit; the ratchet is already at zero and this slice adds no design-law surface.

## A8. Acceptance criteria (I2a)

1. `npm run lint` passes with `--max-warnings=0` and `eslint.config.mjs` unmodified.
2. `npm run typecheck` passes; `demoData.ts`'s twelve legacy fixtures compile unchanged.
3. Digest equality: a synthesis produced by the new schema and round-tripped through `JSON.parse(JSON.stringify(...))` and `validateSynthesisResult` twice produces the same `digest`, and a save of it verifies (A9.1, A9.5).
4. A **legacy-shaped** synthesis with a valid receipt still saves (A9.5). This is the rollout-window criterion from A1.2.
5. A theme carrying both `evidence` and `evidenceRefs`, or neither, is rejected by the validator.
6. `resolveEvidenceRef` never throws for any input, including a negative, fractional, `NaN`, or out-of-range `turnIndex`, an empty transcript, and a 2000-character quote.
7. Every AGENTS.md **Providers/provenance** gate item in I2.00 is green.
8. No file outside the list at the head of this slice is modified.

## A9. Tests (I2a)

**New — `tests/unit/evidence.test.ts`** (the matcher's edge cases; the brief names most of these):

- curly single and double quotes on either side of the comparison, in both directions;
- the model wraps its quote in quotation marks the turn does not contain;
- NBSP, tab, and newline runs inside the turn collapse to single spaces and still match;
- case differs;
- en dash in the turn, hyphen in the quote;
- combining-accent vs precomposed form of the same word (NFKC);
- internal ellipsis, both `…` and `...`, with segments present **in order** → verified; the same segments **out of order** → `not-found`;
- leading and trailing ellipsis on the quote are stripped, not treated as segments;
- quote genuinely not present in the turn → `not-found`;
- quote present in a **different** turn than the one cited → `not-found` (the wrong-turn case: matching is scoped to the cited turn only, never to the whole transcript);
- `turnIndex` of `0`, `-1`, `1.5`, `NaN`, and `transcript.length + 1` → `no-turn`; `transcript.length` → resolves to the last turn;
- cited turn has `role: 'ai'` or `role: 'system'` → `wrong-speaker`, even when the quote is present in it;
- whitespace-only quote → `empty-quote`; three-character quote → `too-short`;
- a phrase repeated twice in one turn → `verified`, `occurrences === 2`, and the span is the **first** occurrence;
- **span fidelity**: for a verified match where the model's quote used straight quotes and lowercase and the turn used curly quotes and a capital, `quotedFromRecord` equals the turn's own substring — capital, curly marks and all — and is a literal substring of `turn.content`;
- multi-segment `quotedFromRecord` joins the segments with `' … '` and each joined piece is a substring of `turn.content`.

**New — `tests/unit/synthesisSchema.roundTrip.test.ts`**:

- A9.1 the digest-equality property in A8.3, asserted against `validateSynthesisResult` and a local copy of `synthesisReceipt.ts`'s canonicalize/digest (or by importing them, if exported — do not export new internals just for a test if a local copy is honest about what it duplicates).
- `evidenceRefs` field order in the input does not change the digest; an unknown key on a ref is rejected.
- `MAX_EVIDENCE_REFS` and the wire schema's `maxItems` are asserted equal, by reading `synthesisResponseSchema` (this is the mismatch in A3.1, pinned).

**Extended — `tests/unit/providerValidation.test.ts`**: its fixture at `:22` gains a new-shape theme; the existing legacy-shape assertions **stay and must keep passing** (they are now the backward-compatibility test). New cases: both fields present → throws; neither → throws; `turnIndex: 0` → throws; `turnIndex: '3'` → throws; four refs → throws; `interviewId` with a slash in it → throws.

**Must keep passing untouched**: `tests/unit/synthesisReceipt.test.ts`, `tests/unit/api.save.idempotent.test.ts`, `tests/unit/api.participant.canonicalContext.test.ts`, `tests/unit/api.aggregate.revision.test.ts`, `tests/unit/api.followup.provenance.test.ts`, `tests/unit/Export.register.test.tsx`, `tests/unit/Synthesis.register.test.tsx`, `tests/unit/Synthesis.completion.test.tsx`, `tests/unit/InterviewDetail.reading.test.tsx`, `tests/unit/StudyDetail.register.test.tsx`. The last four hold legacy-shape fixtures and their continuing to pass **is** the proof that old records still render as Slice F.

- A9.5 a **save-path** test — extend `tests/unit/api.save.idempotent.test.ts` or add `tests/unit/api.save.evidenceRefs.test.ts` — proving both shapes save: sign a receipt over a new-shape synthesis, save it, expect success; sign one over a legacy-shaped synthesis, save it, expect success. This is the single most valuable test in the slice.

**Fixture rule (AGENTS.md Start here §5).** Every quote in every fixture is invented. Use obviously-synthetic content in the register of `DemoSimulation`'s Maya (`"I had forgotten which project it was for"`), never text copied from a real interview, a real study, or a screenshot.

## A10. Verification ladder (I2a)

```bash
npm run lint            # --max-warnings=0
npm run typecheck
npm run test
DEPLOYMENT_MODE=standalone npm run build
npm run test:e2e
```

Then, because the **Providers/provenance** gate is tripped, the two remaining build contracts with the non-secret fixture env from `.github/workflows/ci.yml`:

```bash
DEPLOYMENT_MODE=standalone AI_TRANSPORT=gateway npm run build
DEPLOYMENT_MODE=hosted   AI_TRANSPORT=direct  npm run build
```

And report in the handback: the digest-equality result, the list of files changed, and confirmation that `eslint.config.mjs` is untouched.

---

# Slice I2b — the trace surfaces

Depends on I2a being accepted. Files that may change: `src/components/InterviewDetail.tsx`, `src/components/Synthesis.tsx`, and the tests in B9. **Nothing else** — no primitive (A7: `Citation`, `Coordinate`, `Turn`, `Verbatim` are a frozen contract, reused and never forked), no `globals.css`, no `eslint.config.mjs`, no type, no prompt, no route.

This is the slice `slice-F-spec.md` §F2 was written to make possible: "When Initiative 2 lands, the supporting passage is the block that becomes a `Citation` note: the quotation marks, the wine hairline, and the coordinate line arrive together, in one diff, because they are one promise."

## B1. The law this slice is judged against

**Law 2 (DIRECTION §3): wine = evidence-trace. If wine appears, something is cited.** Under I2a's matcher, "cited" now has an operational definition: a ref whose quote is locatable, in order, in the participant turn it names, inside this record. Wine appears for exactly that set and for nothing else.

Every other case renders as Slice F's supporting passage — serif, one `ink-300` hairline, at measure, **no quotation marks, no wine, no coordinate** — because every other case is a string whose relationship to the participant's speech the record cannot confirm. That includes an old record's `evidence`, an unlocatable quote, a quote in the wrong turn, and a quote in an interviewer turn.

## B2. The shared grammar (written once; B3 and B4 both consume it)

Slice F §F3 established that `Synthesis.tsx` and `InterviewDetail.tsx`'s Analysis tab implement the same markup literally rather than sharing a component. That holds here: both files implement this section, character for character, with only the differences B3 and B4 name. Hoisting it into a shared component remains deferred (`slice-F-spec.md` Deferred).

### B2.1 The themes list

Replacing the `theme.evidence` block at `Synthesis.tsx:330–340` and `InterviewDetail.tsx:276–286`:

```tsx
{themes.map((theme, i) => {
  const view = resolveThemeEvidence(theme, transcript);
  return (
    <li key={i} className="border-t border-ink-300 py-4">
      <p className="font-sans text-[15px] font-medium text-ink-900">
        {theme.theme}
        {view.kind === 'refs'
          ? view.entries.map((entry, j) =>
              entry.match.status === 'verified' ? (
                <Citation
                  key={j}
                  label={`t.${entry.ref.turnIndex}`}
                  open={isOpen(i, j)}
                  onOpenChange={(next) => setOpen(i, j, next)}
                  className="ml-1"
                >
                  <span className="block text-[19px] leading-[31px] text-ink-900">
                    {`“${entry.quotedFromRecord}”`}
                  </span>
                  <Coordinate className="mt-2 block">
                    {`Participant · turn ${entry.ref.turnIndex}`}
                  </Coordinate>
                  {/* InterviewDetail only — see B4.4 */}
                </Citation>
              ) : null
            )
          : null}
      </p>
      {view.kind === 'legacy' ? (
        <Verbatim as="p" className={SUPPORTING_PASSAGE}>{view.text}</Verbatim>
      ) : null}
      {view.kind === 'refs'
        ? view.entries
            .filter((entry) => entry.match.status !== 'verified')
            .map((entry, j) => (
              <Verbatim key={j} as="p" className={SUPPORTING_PASSAGE}>{entry.ref.quote}</Verbatim>
            ))
        : null}
    </li>
  );
})}
```

where `SUPPORTING_PASSAGE` is Slice F's class string, inlined at both sites verbatim and not extracted to a constant:

```
mt-2 max-w-measure border-l border-ink-300 pl-4 text-[17px] leading-[28px] text-ink-700
```

**B2.2** The wine numerals sit inline after the theme name, in ref order. The theme name is the claim; the numeral is the pointer; the note carries the words. That is the `slice-D-spec.md` §D6.6 grammar with the interpretation sentence replaced by the theme name — the same page, as A7 requires.

**B2.3** `Citation`'s note is already `font-serif` (`Citation.tsx:62`); the quote span adds size and colour only. **No file in this slice may contain a raw `font-serif` class or the string `var(--evidence)`** — the ratchet is at zero and will fail the build otherwise. Serif reaches these files through `Verbatim`, `Turn`, and `Citation`, and wine reaches them through `Citation` alone.

**B2.4** The curly quotation marks are written as escapes (`“` / `”`) inside a template literal, matching how the demo's note is built, and they appear **only** inside a `Citation` note. A `Verbatim` supporting passage never gains them (F2.3).

**B2.5** An unverified entry renders `entry.ref.quote` — the model's string, unquoted. It is not silently dropped (the brief forbids that), not marked with an error colour (terracotta is failure status, and a drifted quote is not a system failure), and not annotated with its reason. The absence of the numeral **is** the signal, and it is the same absence a Slice F record shows.

**B2.6** `frequency` stays unrendered, as today.

### B2.7 Open on first paint

Notes are **open on first paint and toggleable**, in controlled mode, exactly as `slice-D-spec.md` §D2.1 and §D6.6 do it. Rationale: closed-by-default would make the Analysis tab strictly less informative than Slice F — a list of bare theme names — and DIRECTION §7 asks that checking provenance cost a glance, not a click. The unfold gesture then serves as collapse.

State shape: one `useState<Record<string, boolean>>` per component keyed by `` `${themeIndex}:${refIndex}` ``, read with a `?? true` default so no initialisation pass over the themes is needed and a re-render with different data cannot desynchronise. This is the only new state either component gains.

## B3. `Synthesis.tsx` — researcher and preview branch only

- **B3.1** The transcript is `interviewHistory` from the store (`Synthesis.tsx:15`) — the same array that was sent to `/api/synthesis`, and therefore the array the turn numbers count (I2.0 fact 2). Pass it to `resolveThemeEvidence`.
- **B3.2 The participant branch gains nothing. This is an acceptance criterion with a test (B9.2).** A1: no citations, no wine, no turn numbers, no coordinates, ever, on any surface a participant can see. The `participantState` ladder and its four states are unchanged, byte for byte, and the themes list does not render in that branch at all.
- **B3.3** Everything else in the file survives as Slice F left it: `doSave`, `handleRetrySave`, `handleRetryAnalysis`, `hasAttemptedAnalysis`, `retryTrigger`, `handleBack`, `handleExport`, the single `useEffect` with its exact dependency array and its `eslint-disable-next-line react-hooks/exhaustive-deps` comment, every save-status notice, and the action row. If a change is not named in this slice, do not make it.
- **B3.4** No provenance footer appears here, still, for the reason in `slice-F-spec.md` §F4.4.
- **B3.5** There is no transcript view on `/synthesis`, so the note carries quote + coordinate and no trace control (B4.4 is `InterviewDetail`-only).

## B4. `InterviewDetail.tsx` — the Analysis tab and the trace

- **B4.1** The transcript is `interview.transcript`, in the same record. `resolveThemeEvidence(theme, interview.transcript)`.
- **B4.2** The tab pair stays (the merged single-surface reading is still deferred, `slice-F-spec.md` Deferred). The transcript panel keeps Slice F's markup exactly, with the two additions in B4.4.
- **B4.3 The words inside the quotation marks come from the record, not from the model.** The note renders `entry.quotedFromRecord` — the substring of `interview.transcript[turnIndex - 1].content` that the matcher located — never `entry.ref.quote`. The marks assert "these are the participant's words"; the characters between them must therefore be the participant's characters, with the record's own capitalisation, punctuation, and curly quotes. This is the single most reviewable line in the slice, and it has a direct test (B9.1).
- **B4.4 The trace gesture** (DIRECTION §5's one special animation, on real data; the demo's `traceEvidence` idiom, reused rather than reinvented):
  - Each transcript `<li>` gains `id={\`turn-${i + 1}\`}` and `tabIndex={-1}`, plus `className={cn('focus:outline-none', tracedTurn === i + 1 && 'ring-2 trace-ring ring-offset-4 ring-offset-paper-0')}`. `.trace-ring` is the class `slice-D-spec.md` §D6.1 added to `globals.css`; the literal `ring-2` is what carries the ring, and the wine lives in the stylesheet, not in this file. **`globals.css` is not edited by this slice** — the class already exists.
  - Each citation note gains, after the `Coordinate` line, a plain control: `<button type="button" className="mt-2 block font-sans text-[13px] text-action underline underline-offset-2">Read in full transcript</button>`, which sets `activeTab` to `'transcript'`, sets `tracedTurn`, and focuses `#turn-N` in a `requestAnimationFrame` after the panel mounts. Copy verbatim, no arrow glyph (`slice-D-spec.md` §D2.6: the words carry the affordance).
  - `tracedTurn` clears on the next tab change. Under `prefers-reduced-motion` the ring is static — that behaviour already lives in `globals.css` and is not re-implemented here.
- **B4.5** The provenance footer (`slice-F-spec.md` §F5.5) is unchanged and stays at the foot of the Analysis panel.
- **B4.6** `loadInterview`, `handleDownloadJSON`, `handleDownloadTranscript` (including every character of the generated markdown), `formatDuration`, the `StudyOperationPendingError` branch, the breadcrumb call, and the download controls all survive unchanged.

## B5. What I2b does not do

- `StudyDetail.tsx` is untouched. Its common-themes block keeps rendering `representativeQuotes` as Slice F's supporting passages, with no wine. That is I2c.
- No merged transcript-and-analysis surface; no `Tabs` primitive; no aggregate concordance; no `divergentViews` / `researchImplications` rendering. All still deferred.
- No primitive is edited. If `Citation` genuinely cannot express something, style around it in the component and record why in the handback (A7).
- No new dependency, no `lucide-react`, no `framer-motion`.

## B6. The visual risk this slice must check by eye

Three verified refs on each of five themes is fifteen open citation notes — and the open note is the one shadow token in the whole system (DIRECTION §4). A themes list that reads as a stack of shadowed cards is the "nested gray cards" failure the redesign exists to correct, arriving by a different door.

The 375 / 1024 / 1440 pass therefore includes a named check: **load a synthesis with at least three themes carrying two or more verified refs each, and confirm the Analysis tab still reads as a ruled document.** If it reads as cards, the fallback is decided in advance and is a one-line change: flip B2.7's default to closed (`?? false`) and update the two `aria-expanded` assertions in B9. Do not solve it by editing `Citation`.

## B7. Acceptance criteria (I2b)

1. A record with a verified ref renders a `Citation` trigger whose accessible name is `t.N`, whose note contains the record's own substring in curly quotes, and whose coordinate reads `Participant · turn N`.
2. A record with an unverified ref renders a serif supporting passage carrying no `"`, no `“`, no `”`, no `aria-expanded` descendant, and no wine.
3. **An old-shape record renders byte-identically to Slice F.** `tests/unit/InterviewDetail.reading.test.tsx` and `tests/unit/Synthesis.register.test.tsx`, whose fixtures are legacy-shaped, pass **untouched**.
4. **The participant branch of `Synthesis` contains no element with `aria-expanded`, no `role="region"`, no text matching `/\bt\.\d/`, and no `Coordinate` output** (A1).
5. `npm run lint --max-warnings=0` passes with `eslint.config.mjs` unmodified; neither file contains `font-serif` or `var(--evidence)`.
6. `container.querySelectorAll('svg')` is still length `0` on every branch of both components (the Slice F icon ratchet).
7. No ancestor of the transcript list carries `max-w-measure` (the Slice F triage-density guard, still true).
8. The AGENTS.md **Researcher UI** gate is green: the paired component suites pass and a 375 / 1024 / 1440 pass including B6 is recorded.

## B8. The wine audit (run before handing back)

```bash
grep -rn "var(--evidence)\|font-serif" src/components/Synthesis.tsx src/components/InterviewDetail.tsx   # must return nothing
grep -rn "Citation" src/components/StudyDetail.tsx                                                        # must return nothing
```

Then, by eye, on `/dashboard/interview/<id>` with a post-I2a interview: confirm that every wine numeral on screen opens onto a quote that is visibly present in the Transcript tab at the turn the coordinate names, and that every serif passage without a numeral carries no quotation marks.

## B9. Tests (I2b)

**New — `tests/unit/InterviewDetail.trace.test.tsx`** (mock `@/services/storageService`'s `getInterview`; the fixture carries a four-message transcript and a synthesis with three themes: one verified ref, one unlocatable ref, one empty `evidenceRefs` array):

- B9.1 **span fidelity**: the fixture's participant turn contains `“work”` with curly quotes and a capital; the model's ref quotes it straight and lowercase; the rendered note's text contains the turn's exact characters, and that text is a literal substring of the fixture's turn content;
- the trigger's accessible name is `t.2`, `aria-expanded` is `"true"` on first paint, clicking it removes the quote and flips to `"false"`, clicking again restores it;
- the coordinate `Participant · turn 2` is present;
- the unlocatable ref renders inside an element carrying `font-serif` and its text contains no `"`, `“`, or `”`;
- the empty-refs theme renders its name and no supporting passage;
- a ref citing an **interviewer** turn whose text contains the quote renders unverified — no trigger — proving the `wrong-speaker` rule reaches the UI;
- a ref with `turnIndex: 99` renders unverified;
- clicking `Read in full transcript` switches to the Transcript tab, focuses `#turn-2` (`document.activeElement`), and that `<li>` carries `ring-2`;
- `container.querySelectorAll('svg')` has length `0` on both tabs.

**New — `tests/unit/Synthesis.trace.test.tsx`**:

- B9.2 in `viewMode === 'participant'`, across all four `participantState` values, `container.querySelector('[aria-expanded]')` is `null`, `queryByRole('region')` is `null`, and the rendered HTML matches neither `/\bt\.\d/` nor `--evidence`;
- in `viewMode === 'preview'` with a verified ref in the store's `interviewHistory`, the trigger renders and the note carries quote + coordinate;
- in `viewMode === 'preview'` there is still no provenance footer (`/^Synthesized by/` absent) and no `Read in full transcript` control.

**Must keep passing untouched**: `tests/unit/Synthesis.register.test.tsx` (its `queryByText`/`font-serif`/no-`--evidence` assertions are the old-shape guard and must not be relaxed), `tests/unit/Synthesis.completion.test.tsx`, `tests/unit/Synthesis.sessionHeaders.test.tsx`, `tests/unit/InterviewDetail.reading.test.tsx`, `tests/unit/StudyDetail.register.test.tsx`, `tests/unit/PreviewBanner.test.tsx`, `tests/unit/DemoSimulation.accessibility.test.tsx`, `tests/e2e/demo-no-provider.spec.ts`.

If an existing `getByText` becomes ambiguous because a string now appears twice, fix the duplication in the component, not the query, and note it in the handback (the Slice D/F rule).

**Fixture rule**: invented content only, per A9's fixture rule and AGENTS.md Start here §5.

## B10. Verification ladder (I2b)

```bash
npm run lint && npm run typecheck && npm run test
DEPLOYMENT_MODE=standalone npm run build
npm run test:e2e
```

Then B8's wine audit, B6's density check, and a 375 / 1024 / 1440 pass on `/dashboard/interview/<id>` (both tabs) and `/synthesis` (participant, preview, and researcher branches). Leave the dev server runnable for the orchestrator's screenshots.

---

# Slice I2c — the aggregate (candidate later phase)

**Recommendation: do not ship I2c with I2a/I2b.** It is specified here so the decision is informed, not so it is scheduled. See Open question 3.

## C1. Why the aggregate is a different problem

`buildAggregateSynthesisPrompt` shows the model theme names, preferences, contradictions, insights, and bottom lines — and no speech at all (I2.0 fact 9). It then asks for `representativeQuotes`. Whatever the model returns is composed from summaries, which means today's aggregate quotes have **no source in any transcript** and cannot be made verifiable by anything I2b does. Rendering them with wine would be Law 2 broken on the surface where a researcher is most likely to quote a participant in a report.

Making them real requires the model to *select* from citations that already exist rather than compose new ones:

1. `/api/synthesis/aggregate` already loads the full `StoredInterview` records (`route.ts:62–88`), so it can build a per-interview catalogue of that interview's verified `evidenceRefs` — quote text, turn number, and an **interview index** local to this request.
2. `buildAggregateSynthesisPrompt` gains that catalogue and instructs the model to reference a citation by `interviewIndex` + `turnIndex`, never to write a quote of its own.
3. The wire schema's `commonThemes[].quoteRefs` carries `{ interviewIndex, turnIndex, quote }`. **The model never writes an interview id.** The route maps `interviewIndex` → the real `interviewIds[n]` after validation and before signing, which is exactly where a fabricated id would otherwise enter the record.
4. Each resulting ref is re-verified server-side against that interview's transcript before it is written into `fullResult`, because the route has all the transcripts in hand — this is the one place where synthesis-time verification is both possible and free.
5. `createAggregateSynthesisReceipt` then signs the resolved object, and `generate-followup`'s `verifyAggregateSynthesisReceipt` keeps working because the resolution happens before signing (I2.0 fact 8).

## C2. The cost

`synthesizeAggregate(studyConfig, syntheses, interviewCount)` is implemented by five adapters. Adding the catalogue changes that signature in `claude.ts`, `gemini.ts`, `openai.ts`, `openrouter.ts`, `gateway.ts`, and the provider interface — the **Providers/provenance** gate in full, on five files, plus `aggregateSynthesisResponseSchema`, `validateAggregateSynthesisPayload`, the aggregate route, and `StudyDetail.tsx`. It is a larger diff than I2a and I2b combined.

## C3. The UI, when it comes

`StudyDetail`'s common-themes block gets B2's grammar with two differences: the coordinate line reads `` `Interview ${id.slice(0, 8)} · turn ${turnIndex}` `` (mono, matching the register table's ID column), and `Read in full transcript` becomes a `router.push` to `/dashboard/interview/${interviewId}?studyId=…` — cross-record navigation, not a tab switch. A pre-I2c aggregate (`representativeQuotes`, no `quoteRefs`) renders as Slice F does today. Since aggregates are never persisted (I2.0 fact 8), that legacy path only exists for a browser tab held open across a deploy, which is a reason to keep it and not a reason to build around it.

---

# Cross-slice constraints

- **npm only** (`package-lock.json` authoritative), Node ≥ 24.19. No new dependency in any slice.
- **Do not commit.** Leave the working tree for review. `docs/` is untracked; leave it.
- **Preserve unrelated dirty files** and review only the scoped diff (AGENTS.md "Definition of done").
- **`eslint.config.mjs` is not edited by any slice.** The ratchet is at zero; new code passes it untouched or it is wrong.
- **`src/components/ui/**` is a frozen contract in every slice.**
- **No `data-theme` wiring, no theme toggle, light Paper only** (A6).
- **No genre vocabulary** in user-facing copy, labels, `aria-label`s, or comments that could migrate into copy: no "apparatus", "colophon", "marginalia" (A2).
- **No real participant content, no production credentials, no writable production database in any test** (AGENTS.md Start here §5).
- **Human validation (A9) is owed.** The trace UI is not "done" until the 3–5 researcher walkthrough scored on time-to-find-a-quote has run against I2b on real data. That is the owner's gate, not the implementer's, but the handback must state that it is outstanding.

---

# Open questions for Fable

1. **Does the aggregate type land in I2a?** A1 declares `AggregateTheme` with `quoteRefs` in I2a while leaving the aggregate prompt, schema, and UI to I2c. The alternative is to declare nothing until I2c and keep `commonThemes` inline. *Recommendation: declare it in I2a.* It is free, it documents both shapes in one place, and `AggregateSynthesisResult` is read by `generate-followup` where a surprise about shape is expensive. If you would rather I2a's diff touch nothing the slice does not exercise, delete the `AggregateTheme` block; nothing else in I2a depends on it.

2. **Should a per-interview `EvidenceRef` carry an `interviewId`?** The brief's shape includes it; A1 makes it optional and omits it for per-interview synthesis, because the id does not exist at synthesis time (I2.0 fact 6) and a client cannot add one afterwards without breaking the receipt (fact 7). The alternative is to have the client send its intended interview id in the `/api/synthesis` body so the server can stamp it into every ref before signing. *Recommendation: omit it.* Stamping adds an untrusted body field, a validation branch, and a genuinely awkward case — a ref whose `interviewId` disagrees with the record it is stored in — in exchange for a redundancy the reader never uses. If you want the shape honoured literally, say so and it becomes one field on the request body plus one `ID`-regex check.

3. **Does I2c ship now?** *Recommendation: no.* Its diff is larger than I2a and I2b together, it changes a five-adapter provider interface, and it lands on the surface where a wrong call is most damaging (a researcher quoting an aggregate in a report). I2a plus I2b make the trace real where the data can support it today. If the owner wants aggregate traceability in this train, C1's design is the one to build — the model selecting from a catalogue, never composing — and the sequencing question becomes whether it precedes or follows the A9 walkthrough.

4. **A quote that matches at several positions in the cited turn.** A5.2 verifies it and uses the first occurrence. The alternative is to treat ambiguity as `not-found`. *Recommendation: verify.* The citation's claim is "the participant said this in turn N", and repetition does not make that false; refusing it would reintroduce the exact-matching brittleness the challenge rejected, one level up. Position only starts to matter if a later slice highlights the span inside the turn, and `occurrences` is carried so that slice can decide then.

5. **Rejection-rate telemetry, which DIRECTION §8 asks for "from day one".** A5.4 runs verification at render time only, so nothing server-side counts how often quotes fail to locate, and A1.2's rollout hazard means the operator has no signal if the matcher is too strict. Recording it means editing `REQUEST_LOG_ALLOWLIST` and `REQUEST_LOG_EVENT_ALLOWLIST` (both closed lists) and tripping the **Structured request logs** gate, and it must be counts-only — a log line must never carry quote text, turn text, or anything derived from participant speech. *Recommendation: a fourth, small slice after I2b*, adding one event (`synthesis.evidence`) and two numeric fields (refs offered, refs located) computed in `/api/synthesis` where the transcript is already in hand. Cheaper than folding it into I2a, and it can be measured against real records rather than fixtures. If you would rather have the signal on day one, it belongs in I2a and the log gate joins I2a's gate list.

---

# Slice I2d — match-rate telemetry (added per Ruling 5)

Files that may change: `src/lib/requestLog.ts`, `src/app/api/synthesis/route.ts`, `tests/unit/requestLog.test.ts`, and a synthesis-route test. Nothing else.

- **D1** `REQUEST_LOG_EVENT_ALLOWLIST` gains `'synthesis.evidence'`; `REQUEST_LOG_ALLOWLIST` gains `'refsOffered'` and `'refsLocated'` (numeric counts). No other allowlist change; `REQUEST_LOG_REASON_ALLOWLIST` untouched.
- **D2** `/api/synthesis`, on the success path only (after `createSynthesisReceipt`, before the response), computes over `result.value.themes`: `refsOffered` = total `evidenceRefs` entries across themes (0 for a legacy-shaped or ref-free synthesis), `refsLocated` = those whose `resolveEvidenceRef(ref, history)` returns `verified`. Logs one `logRequestEvent({ event: 'synthesis.evidence', requestId, route: '/api/synthesis', refsOffered, refsLocated })`. **Counts only — no quote text, no turn text, nothing derived from participant speech reaches a log line** (ADR-003). A telemetry failure must never fail the synthesis response: computation and log are wrapped so any throw is swallowed (the matcher never throws by contract, but the wrapper is cheap honesty).
- **D3** The aggregate route is untouched (no refs exist there until I2c). The save path is untouched (it would double-count what synthesis already measured).
- **D4** Tests: `requestLog.test.ts` gains cases pinning the new event and both fields pass sanitization and that a non-allowlisted field alongside them is dropped; a synthesis-route test asserts the emitted event carries the right counts for a mixed verified/unverified synthesis and that nothing resembling quote text appears in the logged line. Existing log-gate suites (`requestLog.test.ts`, `providerErrors.test.ts`, health/config contract tests) must keep passing — this is the AGENTS.md Structured-request-logs gate.

---

# Slice I2e — sample-workspace showcase (added post-release, owner-approved)

The authenticated sample workspace (`src/lib/demoData.ts`) seeds only legacy-shape syntheses, so a researcher exploring it never meets the trace UI. Files that may change: `src/lib/demoData.ts`, plus a new test. Nothing else — no component, no route logic, no public demo (`DemoSimulation.tsx` / `app/demo` are untouched; they are a different surface with their own hand-built trace).

- **E1** Exactly ONE sample interview — Sarah's — converts its four themes to `evidenceRefs` (1–2 refs per theme, ≤3). Each `quote` must be a genuine substring-after-normalization of the cited turn in `SARAH_TRANSCRIPT`, and each cited turn must be a participant turn. Quotes are chosen from the transcript's existing text; the transcript itself is not edited. The legacy `evidence` strings for Sarah are deleted (exactly-one-of rule). Commentary that the old evidence strings carried (e.g. "- AI enables more strategic focus") is NOT smuggled into quotes; if it is worth keeping it is already expressed by the theme name.
- **E2** Marcus and Priya stay legacy-shape deliberately: the sample workspace then shows both eras side by side, which is the truthful picture of a live deployment.
- **E3** A new test (`tests/unit/demoData.evidence.test.ts`) resolves every ref in every seeded synthesis with `resolveEvidenceRef` against its own transcript and asserts status `verified` — so a future edit to the transcript or the refs cannot silently break the showcase. It also asserts Marcus/Priya remain legacy-shaped (the coexistence is intentional and pinned).
- **E4** If the seeded records carry `_receipt` values, they are display fixtures, not signed receipts — leave whatever convention exists untouched.
- **E5** Gates: `tests/unit/api.demo.seed.test.ts` and every existing demoData consumer test must keep passing; full ladder.

# Rulings (Fable, 2026-08-27 — posted to owner for veto)

1. **Q1 — adopted, with one correction.** `AggregateTheme` lands in I2a, but `representativeQuotes` stays **required** in the type until I2c: `StudyDetail.tsx:518` maps it unguarded, and optionality would force an edit to a file I2a declares untouched. `quoteRefs?` is the only optional field. (A1 amended accordingly.)
2. **Q2 — adopted.** Per-interview refs omit `interviewId`. The brief's shape included it, but the id's nonexistence at synthesis time (I2.0 fact 6) is new information, not a re-litigated judgement; the brief's intent — traceability — is fully delivered by `turnIndex` within the containing record. `interviewId` is reserved for aggregate refs, where the server resolves it.
3. **Q3 — adopted.** I2c does not ship in this train. I2a + I2b now; I2c is a separate decision after the A9 researcher walkthrough. The brief itself anticipated this ("may be a later phase").
4. **Q4 — adopted.** A repeated phrase verifies; first occurrence supplies the span; `occurrences` is carried for a future highlight slice.
5. **Q5 — adopted.** Telemetry ships as a small **I2d** slice after I2b: one `synthesis.evidence` event, counts only (refs offered / refs located), computed in `/api/synthesis`. DIRECTION §8's "day one" is read as "within this initiative"; folding the log gate into I2a would add risk to the initiative's most delicate slice.
6. **Spec amendment (matcher correctness).** A5.1 step 1 normalization is per **grapheme cluster**, not per character — per-character NFKC cannot compose a decomposed base + combining mark and would fail the spec's own NFKC test case. A5.2 step 5 span mapping updated to the cluster map.
