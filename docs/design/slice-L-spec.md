# Slice L — Aggregate citations (Initiative 3, fourth slice, depends on I)

Implements Move **B2** of `docs/design/initiative-3-brief.md`, which is `docs/design/initiative-2-spec.md`'s deferred **I2c**. Context: `DIRECTION-final.md` §3 Law 2 ("wine = evidence-trace"), §7 "Synthesis reading" and its A7 canonical trace primitive, §8 Initiative 2; `initiative-2-spec.md` A5 (the matcher), A5.4 (verdicts are never stored), C1–C3 (the aggregate design as drafted), and Rulings 1–3; `slice-I-spec.md` §I2.4, which built the `AggregateReading` this slice edits and explicitly deferred every line of B2 to here.

**Prime directive.** *The model may point at speech; it may never author speech, and it may never name a record.* Everything below follows from that. The model receives a catalogue of quotes that already exist in owned transcripts and returns positions in that catalogue. The server turns a position into an interview id. The reader checks the quote against the record before any wine appears. Where any link in that chain is missing, the quote renders exactly as `representativeQuotes` render today — serif, ruled, no numeral, no coordinate — and nothing is dropped, repaired, or invented.

**Decision of record 5 binds this slice:** the aggregate is **not persisted**. Everything here lives for one browser session and dies on reload. Do not add a Redis key, do not touch `src/lib/kv.ts`, and do not soften `not saved — regenerate to refresh`.

---

## L1. Laws that bind this slice

1. **Law 2 (DIRECTION §3): wine = evidence-trace.** On the aggregate, "cited" means: a ref whose server-stamped `interviewId` names an interview in this study's loaded collection, **and** whose `quote` is locatable, in order, in a participant turn of that interview's stored transcript. Wine appears for exactly that set. `Citation` is the only path wine reaches the UI (`eslint.config.mjs` bans `var(--evidence)` outside `src/components/ui/**`, and the ratchet is at zero).
2. **"Browser-supplied study configuration, provider/model choice, identity, timestamps, synthesis, and ownership are untrusted"** (AGENTS.md). The model is a browser-adjacent untrusted party for this purpose: it never sees or writes an interview id.
3. **"AI/provider failure is an error. Never substitute a plausible research response"** (AGENTS.md). A quote that will not locate is shown as an unverified passage. It is never repaired, never swapped for nearby text, never silently deleted.
4. **"Evidence citation matching (render-time classification; verdicts never stored)"** (AGENTS.md architecture map). This slice does not change that. See L8.
5. **The aggregate receipt is a fixed point.** `createAggregateSynthesisReceipt` signs `fullResult`; `generate-followup` re-derives `digest(unsignedSynthesis)` over the browser's round-tripped copy (`synthesisReceipt.ts:197,225`). Any field this slice adds must survive `JSON.parse(JSON.stringify(x))` byte-for-byte, or a researcher's "Create Follow-up Study" 403s.
6. **No genre vocabulary** in copy, labels, `aria-label`s, or comments: no "apparatus", "colophon", "marginalia", "concordance".

---

## L2. Repo facts this spec is built on

Verified by reading source at spec time on `initiative-3/slice-i` with H, I and K applied. Re-verify any that look stale.

1. `AggregateTheme.quoteRefs?: EvidenceRef[]` exists (`src/types.ts:351`) and has **zero readers**. `representativeQuotes: string[]` is **required** (`:349`) and has exactly one reader: `SynthesisReading.tsx:240`.
2. **The aggregate model is shown no speech.** `buildAggregateSynthesisPrompt` (`src/lib/prompts/synthesis.ts:130-168`) passes theme *names*, preferences, contradictions, insights and bottom lines. Today's `representativeQuotes` are therefore composed from summaries and have no source in any transcript.
3. **Interviews are already numbered to the model.** The prompt prints `--- Interview ${i + 1} ---` (`synthesis.ts:135`) over the `syntheses` array. The route builds that array and `interviewIds` from **the same** `currentRevisionInterviews` array in the same order (`aggregate/route.ts:88-90,120-124`). So `interviewIndex` *n* already means `interviewIds[n - 1]`, and the mapping is server-held.
4. **`synthesizeAggregate`'s signature does not need to change.** It takes `(studyConfig, syntheses, interviewCount)` and is implemented by five adapters (`claude.ts:196`, `gemini.ts:185`, `openai.ts:189`, `openrouter.ts:205`, `gateway.ts:244`). The catalogue this slice needs is derivable from `syntheses`, which the prompt builder already receives. `initiative-2-spec.md` C2 priced I2c at "five adapter files plus the provider interface"; that price is avoidable and this slice does not pay it. **No adapter file is edited.**
5. **`AggregateSynthesisPayload` is declared once**, at `src/lib/providers/shared.ts:9`, as an `Omit` of `AggregateSynthesisResult`. All five adapters reference the alias by name. `src/lib/ai.ts:44-51` re-declares the same `Omit` inline — the duplicate this slice must keep in step.
6. **`validateAggregateSynthesisPayload` has two callers with two different payload shapes after this slice.** The five adapters call it on raw model output; `generate-followup/route.ts:79` calls it on an object the **browser** posts back, which by then carries server-resolved ids. They cannot share one function once the ref shape differs pre- and post-resolution.
7. **Aggregates are never stored**, but they do round-trip through the browser. `generate-followup` verifies `verifyAggregateSynthesisReceipt` over `rawSynthesis` minus `_receipt` (`route.ts:66-75`) before validating shape (`:79`). The aggregate receipt expires in `1h` (`synthesisReceipt.ts:203`), so a browser tab held open across a deploy is a real, bounded rollout hazard for `generate-followup` — the same hazard `initiative-2-spec.md` A1.2 identified for the save path.
8. **`canonicalize` sorts object keys** (`synthesisReceipt.ts:23-33`), so field *order* cannot break a digest. Field *presence* can: a key present with `undefined` and a key absent both vanish under `JSON.stringify`, but a key present with `[]` does not. Ref objects must be built by explicit field copy, never by spreading input.
9. **The matcher already accepts an aggregate ref unchanged.** `resolveEvidenceRef(ref, transcript)` (`src/lib/evidence.ts:252`) reads only `ref.turnIndex` and `ref.quote`; `interviewId` is ignored. `resolveThemeEvidence` (`:290`) is typed to `SynthesisTheme` and keys off `evidenceRefs`, so the aggregate needs its own resolver, not a widened one.
10. **Interviews load newest-first.** `getInterviewCollectionChecked` sorts `(a, b) => b.createdAt - a.createdAt` (`src/lib/kv.ts:666`), and both the aggregate route and `StudyDetail`'s browser list come through it. `createdAt` is client-supplied (`api/interviews/save/route.ts`), so it orders display but authorizes nothing.
11. **There is no per-turn phase.** `InterviewMessage` is `{ id, role, content, timestamp }` (`types.ts:150-155`). `InterviewPhase` appears only as `AIInterviewResponse.phaseTransition`, which is consumed live and never written to a stored turn; `BehaviorData.messagesPerTopic` is a count map, not a timeline. **The brief's `P02 · turn 12 · exploration` cannot be rendered honestly. The phase is dropped.** See L10.4.
12. **There is no URL affordance for a turn.** `InterviewDetail` holds `tracedTurn` in state and `traceToTurn` is called only from inside the same component (`InterviewDetail.tsx:42-48`). The page reads `searchParams: { studyId?: string }` and nothing else (`src/app/(researcher)/dashboard/interview/[id]/page.tsx:6`).
13. **The telemetry allowlists already carry everything this slice logs.** `REQUEST_LOG_EVENT_ALLOWLIST` contains `'synthesis.evidence'`; `REQUEST_LOG_ALLOWLIST` contains `'refsOffered'` and `'refsLocated'`, both sanitized as finite numbers (`src/lib/requestLog.ts:19-20,28,104-107`). **No allowlist edit is needed, so the AGENTS.md "Structured request logs" row is not tripped.** The two routes are separated in the log by the existing `route` field.
14. **`src/lib/demoData.ts` seeds no aggregate.** Grep for `commonThemes` returns nothing in it. The authenticated sample workspace and the keyless `/demo` are both untouched by this slice.
15. **The e2e transcript is three turns**: AI greeting (1), participant `ANSWER` (2), AI closing (3) — `tests/e2e/workflow-fixture.ts` plus `research-workflow.spec.ts:21-26`. Both synthetic participants produce identical transcripts, so `turnIndex: 2` is a participant turn in either interview regardless of load order.

---

## L3. The shapes (`src/types.ts`)

Two ref shapes exist because resolution happens between them. Declaring one and casting is how a fabricated id gets into a signed record.

```ts
/**
 * An aggregate citation as the MODEL returns it. The interview is named by its
 * 1-based position in the prompt's interview list — never by id. The server
 * owns the position→id mapping; see src/app/api/synthesis/aggregate/route.ts.
 */
export interface AggregateQuoteClaim {
  quote: string;
  turnIndex: number;
  interviewIndex: number;
}

/** A common theme as the model returns it, before the server resolves ids. */
export interface AggregateThemeClaim {
  theme: string;
  frequency: number;
  /** Positions in the prompt catalogue. Empty is honest and expected. */
  quoteRefs: AggregateQuoteClaim[];
}

export interface AggregateTheme {
  theme: string;
  frequency: number;
  /**
   * Free-text quotes composed by the model from interview summaries. Written
   * only by aggregates generated before Slice L. Optional since Slice L; the
   * aggregate is never persisted, so this shape survives only in a browser tab
   * held open across a deploy (see generate-followup, L12).
   */
  representativeQuotes?: string[];
  /**
   * Structured citations, each carrying the interviewId the SERVER resolved
   * from the model's catalogue position. A ref is a claim, not a verified
   * fact: src/lib/evidence.ts checks it against the record at render time.
   */
  quoteRefs?: EvidenceRef[];
}

/** What an AIProvider returns for an aggregate: ids are not resolved yet. */
export type AggregateSynthesisProviderPayload = Omit<
  AggregateSynthesisResult,
  | 'studyId' | 'studyRevision' | 'interviewIds' | 'interviewCount'
  | 'aiProvider' | 'aiModel' | 'requestedAiModel' | 'routedProvider'
  | 'generatedAt' | '_receipt' | 'commonThemes'
> & { commonThemes: AggregateThemeClaim[] };
```

**L3.1 `representativeQuotes` becomes optional.** Ruling 1 of `initiative-2-spec.md` kept it required *only* because I2a could not edit `StudyDetail.tsx`; it promised "I2c makes it optional and adds the guard in the same diff". This is that diff. There are no stored aggregates to be compatible with (L2.7), `demoData.ts` seeds none (L2.14), and the only fixtures carrying the shape are in `tests/` and are rewritten here.

**L3.2 `AggregateSynthesisPayload` in `providers/shared.ts:9` becomes `export type AggregateSynthesisPayload = AggregateSynthesisProviderPayload;`**, and `ai.ts:44-51`'s inline `Omit` becomes `Promise<ProviderResult<AggregateSynthesisProviderPayload>>`. The five adapters reference the alias by name and compile unmodified. Do not delete the alias; deleting it is what would force five file edits.

---

## L4. The prompt — the model selects, never composes (`src/lib/prompts/synthesis.ts`)

### L4.1 The catalogue

Today's aggregate prompt shows no speech (L2.2), which is exactly why today's aggregate quotes are unverifiable. `buildAggregateSynthesisPrompt` gains a catalogue built from the `syntheses` array it already receives: every per-interview `evidenceRefs` entry is a quote a previous synthesis already tied to a turn.

```ts
export const MAX_AGGREGATE_QUOTE_REFS = 3;             // == aggregateSynthesisResponseSchema maxItems
const CATALOGUE_PASSES = 3;                            // at most 3 entries per interview
const CATALOGUE_CHAR_BUDGET = 40_000;                  // rendered characters, all interviews
```

Selection is **round-robin over interviews, not a prefix of them**:

1. For each interview *i* (1-based over `syntheses`), collect its refs in theme order, deduplicated by `` `${turnIndex} ${quote}` ``.
2. Run up to `CATALOGUE_PASSES` passes. Pass *k* appends each interview's *k*-th remaining entry, in interview order, stopping the moment the accumulated rendered length would exceed `CATALOGUE_CHAR_BUDGET`.
3. Entries beyond the budget are simply not offered.

A prefix cut would let the newest-first load order (L2.10) silently restrict every aggregate citation to the most recent participants. Round-robin gives every interview its first quote before any interview gets its second, so the residual skew lands only at the cut point inside the final pass. **This is a real limit and must be stated in the handback:** a study large enough to exhaust the budget on pass one can only be cited from the interviews reached before the cut. The unbounded fix is the deferred aggregate-concordance surface, not a bigger prompt.

### L4.2 Rendering the catalogue

Each interview block gains one trailing section. Immediately after `Bottom Line: ...` inside the existing `--- Interview ${i + 1} ---` block:

```
Citable quotes:
[1.4] "I keep a short project note so I remember why I saved the document."
[1.9] "I had forgotten which project it was for"
```

and when an interview contributes nothing (a legacy synthesis with `evidence` strings, or one whose refs did not survive L7.1's verification filter):

```
Citable quotes: none available for this interview.
```

The tag is `[interviewIndex.turnIndex]`. The quote is printed inside straight double quotes; the model is told the marks are the delimiter, not part of the quote.

### L4.3 The instruction

Appended after the existing `Look for:` list:

```
CITING EVIDENCE:
Every quote you attach to a common theme must be one of the CITABLE QUOTES
listed above. For each common theme, provide 0-3 citations in "quoteRefs".
Each citation has:
- "interviewIndex": the first number in the [i.t] tag of the entry you chose.
- "turnIndex": the second number in that tag.
- "quote": the text of that entry, copied character-for-character, without the
  surrounding quotation marks.
Do not write a quote of your own. Do not merge two entries into one. Do not
adjust wording, spelling, punctuation, or capitalization. If no listed quote
supports a theme, return an empty "quoteRefs" array — that is honest; an
invented quote is not.
```

### L4.4 The echoed output description

`aggregateSynthesisOutputDescription` (`synthesis.ts:170-192`) is updated in the same diff so the two descriptions of the schema cannot drift (the same reason `initiative-2-spec.md` A4.3 gave):

```
  "commonThemes": [
    {
      "theme": "Theme name",
      "frequency": 3,
      "quoteRefs": [
        { "interviewIndex": 1, "turnIndex": 7, "quote": "Exact text of a citable quote" }
      ]
    }
  ],
```

`buildSynthesisPrompt`, `synthesisOutputDescription`, `greeting.ts`, `interview.ts` and `followup.ts` are untouched.

---

## L5. The wire schema (`src/lib/providerSchemas.ts`)

`aggregateSynthesisResponseSchema.properties.commonThemes.items` becomes:

```ts
{
  type: 'object',
  additionalProperties: false,
  properties: {
    theme: { type: 'string' },
    frequency: { type: 'number', minimum: 0 },
    quoteRefs: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          interviewIndex: { type: 'integer', minimum: 1 },
          turnIndex: { type: 'integer', minimum: 1 },
          quote: { type: 'string', maxLength: 2000 },
        },
        required: ['interviewIndex', 'turnIndex', 'quote'],
      },
    },
  },
  required: ['theme', 'frequency', 'quoteRefs'],
}
```

Load-bearing:

1. **`representativeQuotes` leaves the wire schema entirely**, exactly as `evidence` did in I2a (A2.1). The model is never again asked to compose a quote for an aggregate.
2. **`interviewId` is not in the wire schema and never will be.** The model cannot be given the opportunity to invent one.
3. **`maxItems: 3` must equal `MAX_AGGREGATE_QUOTE_REFS`.** A mismatch between the schema and the validator is a silent rejection generator; a test asserts them equal by reading both (L15).
4. The schema stays strict (`additionalProperties: false`, everything in `required`), so `quoteRefs` is always present and an empty array is the honest zero.
5. `tests/e2e/workflow-fixture.ts:110` detects the aggregate operation with `'commonThemes' in properties`. That property survives, so the fixture's operation dispatch is unaffected.

---

## L6. Validation — two shapes, two validators (`src/lib/providerValidation.ts`)

Factor the existing body of `validateAggregateSynthesisPayload` into an internal `validateAggregateCore(input, mode)` and export two thin wrappers. `divergentViews`, `keyFindings`, `researchImplications`, `bottomLine` and every cap are shared and unchanged.

### L6.1 `validateAggregateSynthesisPayload(input): AggregateSynthesisProviderPayload`

Called by the five adapters. Keeps its name so no adapter import changes.

Per theme: `theme` a non-empty string, `frequency` a finite non-negative number (both unchanged), then

- `quoteRefs` must be present and an array of at most `MAX_AGGREGATE_QUOTE_REFS` items.
- **`representativeQuotes` present is a failure.** The wire schema forbids it, and a model that returns it is returning composed speech.
- Per claim: `quote` a string with `1 <= length <= MAX_EVIDENCE_QUOTE` (2 000, the existing constant — a whitespace-only quote passes here and is classified `empty-quote` by the matcher, per A3.2's reasoning); `turnIndex` a positive integer; `interviewIndex` a positive integer `<= MAX_AGGREGATE_INTERVIEW_INDEX` (`1_000`, matching the route's own collection ceiling at `aggregate/route.ts:76`); no unknown keys.
- The returned claim is built by explicit field copy — `{ quote, turnIndex, interviewIndex }` — never by spreading the input (L2.8).

`interviewIndex` is bounded here but **not** checked against the actual interview count: this function has no count. The route owns that check (L7.2).

### L6.2 `validateResolvedAggregateSynthesis(input)`

Called only by `generate-followup`. Accepts the **post-resolution** shape and the legacy shape, exactly-one-of per theme, mirroring `validateSynthesisResult`'s theme rule:

- Exactly one of `representativeQuotes` (array of strings, legacy) or `quoteRefs` (array of ≤ 3 `EvidenceRef`) per theme; neither or both fails the whole payload.
- Per ref: `quote` and `turnIndex` as above; **`interviewId` is required and must match `/^[A-Za-z0-9_-]{1,120}$/`** — the existing `INTERVIEW_ID` regex. A resolved ref without an id is not resolved. `interviewIndex` present is a failure: it means the browser is replaying an unresolved payload.
- Explicit field copy, `{ quote, turnIndex, interviewId }`.

**The legacy branch is permanent, not transitional.** It is the L2.7 rollout window: a researcher whose tab was open across a deploy still has a valid 1-hour receipt over a `representativeQuotes` aggregate, and rejecting it turns "Create Follow-up Study" into a 400 for no gain. The same reasoning as `initiative-2-spec.md` A1.2, one surface over.

---

## L7. The aggregate route (`src/app/api/synthesis/aggregate/route.ts`)

### L7.1 Before the call: a record-backed catalogue

The route holds the transcripts; the prompt builder does not. So the route hands the provider a synthesis array whose refs have already been checked against the records they name:

```ts
const syntheses = currentRevisionInterviews.map(interview =>
  withRecordBackedEvidence(interview.synthesis!, interview.transcript)
);
```

`withRecordBackedEvidence` (L9.1) drops every ref that does not verify and rewrites each surviving ref's `quote` to the **record's own characters** (`quotedFromRecord`). Two consequences worth stating plainly: the catalogue can only offer quotes that provably exist, and a model that copies faithfully produces a ref that verifies on the first try, because it is copying the record rather than an earlier model's copy of it.

A legacy theme (`evidence` present) is returned **unchanged, by identity** — no `evidenceRefs: []` is added. This is what keeps `tests/unit/api.aggregate.revision.test.ts:114`'s `toHaveBeenCalledWith(study.config, [synthesis, synthesis], 2)` passing unmodified, because its fixture synthesis is legacy-shaped.

`interviewCount` and the ordering are untouched. **Hard invariant: nothing may reorder, filter, or re-sort between `currentRevisionInterviews`, `syntheses`, and `interviewIds`.** Those three arrays are index-aligned and that alignment *is* the position→id mapping. A test pins it (L15).

### L7.2 After the call: resolution, before signing

```ts
const interviewIds = currentRevisionInterviews.map(interview => interview.id);
const commonThemes: AggregateTheme[] = aggregateResult.value.commonThemes.map(theme => ({
  theme: theme.theme,
  frequency: theme.frequency,
  quoteRefs: theme.quoteRefs.flatMap(claim => {
    const interviewId = interviewIds[claim.interviewIndex - 1];
    return interviewId === undefined
      ? []
      : [{ quote: claim.quote, turnIndex: claim.turnIndex, interviewId }];
  }),
}));
```

Then `fullResult` is built as today with `commonThemes` replacing the spread's version, and `createAggregateSynthesisReceipt(fullResult)` signs the **resolved** object. Resolution before signing is what makes `generate-followup`'s digest check work (L2.7) and is the one place a fabricated id could otherwise enter a signed record.

**L7.2.1 An out-of-range `interviewIndex` is dropped, and counted.** It names no record at all: there is no coordinate to print and no transcript to be unverified against, so there is nothing honest to render. Keeping it would put a quote with no provenance whatsoever into the reading — precisely today's failure mode that this slice exists to end. It is not silent: `refsOffered` counts it and `refsLocated` does not, so the gap is visible to the operator (L13). This is the one narrow exception to L1.3, and it is narrow because the claim's *subject* is invalid, not its text.

`representativeQuotes` is **not** written onto a new theme — not as `[]`, not as `undefined` (L2.8). New aggregates carry `quoteRefs` only.

### L7.3 What the route does not do

- **It computes no verdict into the payload.** `quoteRefs` reaching the browser is the model's claim plus a server-resolved id. Nothing marks a ref verified.
- **It does not filter refs on match failure.** A ref that names a real interview but whose quote drifted is passed through and renders unverified.
- It does not change authorization, revision gating, the two-interview minimum, rate limiting, provider resolution, `providerErrorResponse`, or the 500 catch site.

---

## L8. Where matching happens, and why it stays render-time

**Decision: matching stays in the reader, at render time, in the browser.** `initiative-2-spec.md` C1 step 4 proposed server-side re-verification before signing; that is rejected here.

The argument for it was that the route has every transcript in hand. The argument against is A5.4's, unchanged by moving up a level: a verdict computed at synthesis time and folded into the signed payload is a judgement no later reader can re-derive, sitting inside a digest, on an object that is re-validated by a second route. It would also have to be *stored* in the ref to be useful, and "verdicts never stored" is an architecture-map guarantee (AGENTS.md), not a per-slice convention.

The team-lead's invariant — *the browser never asserts a verdict the server didn't compute from records it owns* — is satisfied without server verification, because the dangerous half of an aggregate citation is **identity**, not matching:

- **Identity is server-authored.** The model returns a position; the server converts it to an id drawn from `interviewIds`, which it built from records it loaded under `getAuthorizedResearcherStudyContext`, and then signs it. The browser cannot introduce, edit, or redirect a ref's `interviewId` without breaking the receipt.
- **Matching is a pure function of two things the browser legitimately holds.** `StudyDetail` already loads the full `StoredInterview` records, transcripts included, through the same authorized collection loader the route uses (`loadStudyData` → `getStudyInterviews`). Running `resolveEvidenceRef` over them is the same computation `InterviewDetail` already performs on the same class of data, one record wider.
- **A tampering browser gains nothing.** It could render wine over a quote the record does not contain — but it could equally render arbitrary HTML. The guarantee that matters is that a *correct* client shows wine only for located quotes, and that the coordinate a researcher copies into a report points at a real turn in a real owned interview.

The server still computes matches — for telemetry only, counts only, never into the payload (L13). That is where the operator's signal belongs and where A5.4 said it belongs.

**Bounding the work.** `commonThemes` ≤ 100 (`MAX_PROVIDER_LIST_ITEMS`) × `quoteRefs` ≤ 3 = **≤ 300 resolutions per render**, each `O(len(turn))` over one turn of one transcript. The interview lookup is a `Map` built once per aggregate in `StudyDetail` with `useMemo` keyed on the interviews array (L10.1) — `O(N log N)` for the sort, once, not per ref. Per-ref resolution is left uncached, matching `SynthesisReading`'s existing behaviour; 300 substring scans is not a frame budget problem and caching it would add a second source of truth for a verdict.

---

## L9. `src/lib/evidence.ts` — the aggregate resolver and P-numbers

Additions only. The file's contract is preserved: pure, no I/O, no logging, no throwing on bad data, no import beyond `@/types`.

### L9.1 The catalogue helper

```ts
/**
 * Returns a copy of `synthesis` in which every evidenceRef that does not
 * locate in `transcript` is dropped, and every surviving ref's `quote` is
 * replaced by the record's own characters. Legacy themes (those carrying
 * `evidence`) are returned unchanged, by identity.
 */
export function withRecordBackedEvidence(
  synthesis: SynthesisResult,
  transcript: InterviewMessage[],
): SynthesisResult;
```

### L9.2 The interview index and the P-number

```ts
export interface AggregateInterviewEntry {
  participantNumber: number;
  transcript: InterviewMessage[];
}
export type AggregateInterviewIndex = ReadonlyMap<string, AggregateInterviewEntry>;

/** Stable 1-based participant numbering: ascending createdAt, ties broken by id. */
export function buildAggregateInterviewIndex(
  interviews: readonly { id: string; createdAt: number; transcript: InterviewMessage[] }[],
): AggregateInterviewIndex;

/** `P01`, `P02`, … `P100`. Two-digit minimum, never truncated. */
export function participantLabel(participantNumber: number): string;
```

**L9.2.1 Ordering: ascending `createdAt`, ties broken by `id` lexicographically.** Not the newest-first order the collection arrives in (L2.10). A coordinate must be stable: under newest-first, today's `P02` becomes `P03` the moment a third participant finishes, so a number a researcher copied into a report would silently change meaning. Ascending order is stable under append and is the ordinary research convention (`P01` is the first participant). `createdAt` is client-supplied, which is fine here — it orders a display label and authorizes nothing — and the `id` tiebreak makes the result deterministic when two records share a timestamp.

**L9.2.2 This disagrees with the register's row numbering.** `StudyDetail.tsx:560,566` labels rows `Interview ${index + 1}` over the newest-first array, so `P02` and "Interview 2" are generally different records. This slice does not touch the register: renaming a column that three tests and one e2e assertion pin (`research-workflow.spec.ts:86-88`) is a separate change with its own review. See Open question 2.

### L9.3 The resolver

```ts
export type AggregateEvidenceEntry = {
  ref: EvidenceRef;
  match: EvidenceMatch;
  quotedFromRecord: string | null;
  /** null when the ref's interviewId is not in the index. */
  participantNumber: number | null;
};

export type AggregateThemeEvidenceView =
  | { kind: 'legacy'; quotes: string[] }
  | { kind: 'refs'; entries: AggregateEvidenceEntry[] }
  | { kind: 'none' };

export function resolveAggregateThemeEvidence(
  theme: AggregateTheme,
  index: AggregateInterviewIndex,
): AggregateThemeEvidenceView;
```

Rules, in order:

1. `theme.representativeQuotes !== undefined` → `{ kind: 'legacy', quotes }`. (The exactly-one-of rule means a theme never carries both; if a malformed object somehow does, legacy wins and no wine is possible — fail closed toward "no citation".)
2. `quoteRefs` absent or empty → `{ kind: 'none' }`.
3. Otherwise, per ref: look up `ref.interviewId` in the index. **Not found → `{ ref, match: { status: 'unverified', reason: 'no-record' }, quotedFromRecord: null, participantNumber: null }`.** Found → `resolveEvidenceRef(ref, entry.transcript)`, with `quotedFromRecord` built from the spans exactly as `resolveThemeEvidence` builds it (`evidence.ts:303-308`), and `participantNumber` set.

`UnverifiedReason` gains one member, `'no-record'`, for the case where the id names no loaded interview — a browser that has not finished loading, or an interview deleted between the aggregate call and the render. It is a classification, not an error; nothing throws.

---

## L10. `AggregateReading` — the trace on the aggregate (`src/components/SynthesisReading.tsx`)

Only the Common Themes section of `AggregateReading` (`:233-254`) changes. Bottom line, Key Findings, Divergent Views, Research Implications, and `ProvenanceFooter` are untouched, character for character.

### L10.1 The props

```ts
export interface AggregateReadingProps {
  synthesis: AggregateSynthesisResult
  /** The records every citation is checked against. Built by the consumer. */
  interviewIndex: AggregateInterviewIndex
  /** Controlled note state, keyed `${themeIndex}:${refIndex}`. Missing means open. */
  openNotes: Record<string, boolean>
  onNoteOpenChange: (themeIndex: number, refIndex: number, open: boolean) => void
}
```

`AggregateReading` stays hook-free, mirroring `SynthesisReading`: the consumer builds the index (`useMemo` in `StudyDetail`) and owns the note state, exactly as `InterviewDetail` does for the per-interview reading. Passing an already-built index rather than an interview array also keeps the sort out of the render path.

The cross-record link needs no callback: `synthesis.studyId` is on the object, so the component builds the href itself.

### L10.2 The themes list

```tsx
{synthesis.commonThemes.map((theme, i) => {
  const view = resolveAggregateThemeEvidence(theme, interviewIndex);
  return (
    <li key={i} className="border-t border-ink-300 py-4">
      <p className="font-sans text-[15px] font-medium text-ink-900">
        {theme.theme}
        {view.kind === 'refs'
          ? view.entries.map((entry, j) =>
              entry.match.status === 'verified' && entry.participantNumber !== null ? (
                <Citation
                  key={j}
                  label={`t.${entry.ref.turnIndex}`}
                  open={openNotes[`${i}:${j}`] ?? true}
                  onOpenChange={(next) => onNoteOpenChange(i, j, next)}
                  className="ml-1"
                >
                  <span className="block text-[19px] leading-[31px] text-ink-900">
                    {`“${entry.quotedFromRecord}”`}
                  </span>
                  <Coordinate className="mt-2 block">
                    {`${participantLabel(entry.participantNumber)} · turn ${entry.ref.turnIndex}`}
                  </Coordinate>
                  <Link
                    href={`/dashboard/interview/${encodeURIComponent(entry.ref.interviewId!)}`
                      + `?studyId=${encodeURIComponent(synthesis.studyId)}&turn=${entry.ref.turnIndex}`}
                    className="mt-2 block font-sans text-[13px] text-action underline underline-offset-2"
                  >
                    {`Read in ${participantLabel(entry.participantNumber)}'s transcript`}
                  </Link>
                </Citation>
              ) : null
            )
          : null}
      </p>
      {view.kind === 'legacy'
        ? view.quotes.map((quote, j) => (
            <Verbatim key={j} as="p" className={/* the Slice I class string, inlined verbatim */}>
              {quote}
            </Verbatim>
          ))
        : null}
      {view.kind === 'refs'
        ? view.entries
            .filter((entry) => entry.match.status !== 'verified' || entry.participantNumber === null)
            .map((entry, j) => (
              <Verbatim key={j} as="p" className={/* same class string */}>
                {entry.ref.quote}
              </Verbatim>
            ))
        : null}
    </li>
  );
})}
```

The class string is the one already at `SynthesisReading.tsx:243`, inlined at both sites verbatim and not extracted to a constant (the Slice F/I rule):

```
mt-2 max-w-measure border-l border-ink-300 pl-4 text-[17px] leading-[28px] text-ink-700
```

### L10.3 Rules

1. **The wine numeral's label is `t.N`**, identical to the per-interview reading. The participant is named in the note's coordinate, not on the numeral — the numeral has to stay legible inline at 375px, and `P02·t.12` is a second coordinate system in a place designed for one.
2. **The quoted characters come from the record, not the model.** `entry.quotedFromRecord`, never `entry.ref.quote`. The quotation marks assert "these are the participant's words"; the characters between them must be the participant's characters. This is the single most reviewable line in the slice and it has a direct test.
3. **An unverified ref renders `entry.ref.quote`** — the model's string, unquoted, in serif, with a hairline rule. Byte-identical to how `representativeQuotes` render today. Not dropped, not coloured, not annotated with a reason. The absence of the numeral is the signal, and it is the same absence a pre-Slice-L aggregate shows.
4. **Notes are open on first paint and toggleable**, in controlled mode, with `?? true`, exactly as `SynthesisReading` does it (`:47`). Closed-by-default would make the aggregate strictly less informative than the reading it replaces.
5. **`frequency` stays unrendered**, as today.
6. No raw `font-serif` and no `var(--evidence)` may appear in this file. Serif arrives through `Verbatim` and `Citation`; wine arrives through `Citation` alone.

### L10.4 The coordinate reads `P02 · turn 12`, not `P02 · turn 12 · exploration`

The phase is dropped. There is no phase on a stored turn and no phase timeline on a stored interview (L2.11); reconstructing one from `behaviorData.messagesPerTopic`, which is a count map, would be inventing a fact and printing it in the mono face reserved for machine-verifiable facts (DIRECTION §3). The brief's string was written against the sketch in DIRECTION §7, not against the record. If a per-turn phase is ever stored, adding the third segment is one template literal.

### L10.5 The link is an anchor, not a button

The in-record control stays a `<button>` because it switches a tab. This one navigates to a different page, so it is a `next/link` `<Link>`: middle-click, open-in-new-tab, and a visible target in the status bar all matter for a control whose whole promise is "go look at the record yourself". Styling is identical to the button's (`font-sans text-[13px] text-action underline underline-offset-2`). No arrow glyph — `slice-D-spec.md` §D2.6 ("the words carry the affordance") and the shipped `Read in full transcript` control both omit it, and the brief's `→` would be the only one in the system.

---

## L11. `InterviewDetail` — landing on a turn

The link must arrive at the cited turn, not at the top of a transcript.

**`src/app/(researcher)/dashboard/interview/[id]/page.tsx`**: `searchParams` gains `turn?: string`, passed through as a prop. This is the smallest honest mechanism: the state already exists in the component (L2.12), only the entry point is missing, and a URL is what a link can carry.

**`src/components/InterviewDetail.tsx`**: gains an optional `turn?: string` prop and one effect, declared **after** the existing `[interviewId]` reset effect (`:70-74`) so that on the commit where a record first arrives the reset runs first and the focus runs second:

```tsx
useEffect(() => {
  if (!interview) return;
  const requested = Number(turn);
  if (!Number.isInteger(requested) || requested < 1 || requested > interview.transcript.length) return;
  setActiveTab('transcript');
  setTracedTurn(requested);
  const frame = requestAnimationFrame(() => {
    document.getElementById(`turn-${requested}`)?.focus();
  });
  return () => cancelAnimationFrame(frame);
}, [interview, turn]);
```

`'transcript'` is already the default tab, so this sets the ring and the focus and nothing else. An absent, non-numeric, or out-of-range `turn` is ignored silently — a stale link should land on the transcript, not on an error. `switchTab` still clears `tracedTurn`, so the ring disappears the moment the researcher navigates away from it, unchanged.

Nothing else in the file changes: `loadInterview`, both downloads and every character they emit, `formatDuration`, the `StudyOperationPendingError` branch, the `Tabs` wiring, `SynthesisReading`'s props, and `ProvenanceFooter` all survive.

---

## L12. `generate-followup`

One line: `validateAggregateSynthesisPayload` becomes `validateResolvedAggregateSynthesis` at `src/app/api/studies/[id]/generate-followup/route.ts:79` (and its import at `:17`). Everything else in that route — receipt verification, the provenance comparison at `:81-93`, the eligible-id check at `:105-110`, the `topicAreas` derivation at `:163-164` — is untouched.

The ordering already in the file matters and must be preserved: the receipt is verified over the raw object **before** shape validation. That is what makes L6.2's legacy branch safe — a stale-shaped payload is only accepted if it is also correctly signed.

---

## L13. Telemetry

`/api/synthesis/aggregate` emits **one** `synthesis.evidence` event on the success path, after `createAggregateSynthesisReceipt` and before the response, in the same shape and with the same wrapper `/api/synthesis` uses (`route.ts:170-183`):

```ts
try {
  const claims = aggregateResult.value.commonThemes.flatMap(theme => theme.quoteRefs);
  logRequestEvent({
    event: 'synthesis.evidence',
    requestId: createRequestId(request.headers.get('x-request-id')),
    route: '/api/synthesis/aggregate',
    refsOffered: claims.length,
    refsLocated: claims.filter(claim => {
      const interview = currentRevisionInterviews[claim.interviewIndex - 1];
      return interview !== undefined
        && resolveEvidenceRef(
             { quote: claim.quote, turnIndex: claim.turnIndex },
             interview.transcript,
           ).status === 'verified';
    }).length,
  });
} catch {
  // Swallowed by design: a telemetry failure must never cost a paid aggregate.
}
```

- **Counts only, ever.** No quote text, no turn text, no interview id, nothing derived from participant speech reaches a log line (ADR-003).
- `refsOffered` counts every claim the model returned, **including** those L7.2.1 drops for an out-of-range index. `refsLocated` counts only verified ones. The gap is the operator's signal that the catalogue instruction is not landing.
- **No `src/lib/requestLog.ts` edit** (L2.13). The event name and both fields are already allowlisted and already sanitized as finite numbers. The two routes are separated by the existing `route` field, which is why a second event name is unnecessary and would only cost an allowlist edit.
- The telemetry block is the *only* place the server runs the matcher on aggregate refs, and its result never touches `fullResult`.

---

## L14. Fixtures and sample data

- **`src/lib/demoData.ts` is not edited.** It seeds no aggregate (L2.14). The trace is already showcased per-interview by Sarah's record (I2e). Seeding an aggregate would mean seeding an unsigned, unpersisted object into a workspace that has nowhere to put it.
- **`src/components/DemoSimulation.tsx` and `src/app/demo` are not edited.** The keyless demo has its own hand-built trace and makes no API request.
- **`tests/e2e/workflow-fixture.ts`** — the `aggregate` constant loses `representativeQuotes` and gains two refs, one verifiable and one not:

```ts
const UNSAID = 'I never write anything down about a document.';
const aggregate = {
  commonThemes: [{
    theme: 'Remembering context', frequency: 2,
    quoteRefs: [
      { interviewIndex: 1, turnIndex: 2, quote: ANSWER },
      { interviewIndex: 2, turnIndex: 2, quote: UNSAID },
    ],
  }],
  divergentViews: [], keyFindings: ['Both participants keep contextual notes.'],
  researchImplications: ['Investigate when notes are written.'],
  bottomLine: 'Context notes help both participants resume work.',
};
```

  `ANSWER` is the participant's turn 2 in both synthetic interviews (L2.15), so ref 1 verifies whichever way the collection loads and ref 2 never does. That pair is what proves the whole chain — prompt → schema → validator → server resolution → signature → browser matching → wine — end to end against real handlers and disposable Redis, which no unit test can do.

- **Fixture rule (AGENTS.md "Start here" §5).** Every quote in every fixture in this slice is invented, in the register of the existing synthetic content. No real participant text, no production credentials, no writable production database.

---

## L15. Tests

### Must keep passing, unchanged

- **`tests/unit/evidence.test.ts`** in full. This slice adds to `src/lib/evidence.ts` and changes nothing in `normalizeForMatch`, `locateQuote`, `resolveEvidenceRef`, or `resolveThemeEvidence`. If one of these fails, the matcher was edited and it should not have been.
- **`tests/unit/api.aggregate.revision.test.ts`** in full — most importantly **`:114`** `expect(synthesizeAggregate).toHaveBeenCalledWith(study.config, [synthesis, synthesis], 2)`, whose fixture synthesis at `:47` is legacy-shaped (`themes: [{ theme, evidence, frequency }]`). It passes only if L7.1's helper returns legacy themes unchanged, which is precisely the property worth pinning. Also `:104` the four-interview eligibility filter, `:118-131` the `interviewIds` / provenance block, `:132-134` the receipt call, `:146-170` the OpenRouter provenance case, `:172-190` the revision-mixing refusal, and the provider-configuration and rate-limit cases below it.
- **`tests/unit/synthesisReceipt.test.ts`** in full, including `:205`'s empty `commonThemes` aggregate. Receipt creation and verification are untouched by this slice and any movement here means the digest changed.
- **`tests/unit/api.followup.provenance.test.ts`** — `:122-148` current-revision provenance, `:149-164` signed-provenance preservation, `:165-174` stale/invented ids, **`:175-185` browser-tampered content rejected before any provider call**, `:186-200` and `:201-` the provider-error branches. The fixture at `:51` is legacy-shaped and must keep passing untouched: it *is* the L6.2 rollout-window regression.
- **`tests/unit/requestLog.test.ts`** in full, `:92-125` in particular (the `synthesis.evidence` field pass-through and the counts-only rejection). No allowlist changes, so nothing here may move.
- **`tests/unit/api.synthesis.telemetry.test.ts`** in full. `/api/synthesis` is not edited.
- **`tests/unit/InterviewDetail.trace.test.tsx`** and **`tests/unit/InterviewDetail.reading.test.tsx`** in full. `turn` is a new optional prop; every existing render omits it and must behave identically, including the tab-switch/focus/ring sequence.
- **`tests/unit/SynthesisReading.test.tsx`**, **`tests/unit/Synthesis.trace.test.tsx`**, **`tests/unit/Synthesis.register.test.tsx`**, **`tests/unit/Synthesis.completion.test.tsx`** in full. `SynthesisReading` and `ProvenanceFooter` are not edited; only `AggregateReading` is.
- **`tests/unit/ui.citation.test.tsx`**, **`tests/unit/ui.tabs.test.tsx`**, **`tests/unit/StudyDetail.register.test.tsx`**, **`tests/unit/StudyDetail.participantLinks.test.tsx`**, **`tests/unit/Export.register.test.tsx`**, **`tests/unit/demoData.evidence.test.ts`**, **`tests/unit/api.demo.seed.test.ts`**, **`tests/unit/DemoSimulation.accessibility.test.tsx`**, **`tests/unit/DemoSimulation.trace.test.tsx`**, **`tests/e2e/demo-no-provider.spec.ts`** in full.
- **`tests/unit/gatewaySynthesis.workflow.test.ts`** — its `aggregateOutput` at `:69-75` has `commonThemes: []`, so it is shape-agnostic and must pass untouched. It is the Gateway half of the Providers/provenance gate.
- **`tests/e2e/research-workflow.spec.ts`** everything except the additions listed below: `:78` `2 interviews`, `:83-88` the Interviews tab and row buttons, `:89-101` the downloads and provenance fields, `:103` the `Analyze All Interviews` click, `:104-107` the bottom line / research implication / absent Divergent Views assertions, `:108` `not saved — regenerate to refresh`, `:109` the no-receipt body check, `:110-113` the whole call ledger.

### Rewritten by this slice, and why

1. **`tests/unit/providerValidation.test.ts:38-46`** (`validAggregatePayload`) — `representativeQuotes: ['"Speed matters"']` becomes `quoteRefs: [{ interviewIndex: 1, turnIndex: 3, quote: 'Speed matters' }]`. The wire schema no longer permits `representativeQuotes` on the provider path (L5.1), so the "valid payload" fixture must be the shape the provider now returns.
2. **`tests/unit/providerValidation.test.ts:306-319`** (`rejects malformed commonThemes including nested representativeQuotes`) — becomes `rejects malformed commonThemes including nested quoteRefs`. Keep the `frequency: '4'` case and the `commonThemes = 'none'` case verbatim; replace the two `representativeQuotes` cases with: `quoteRefs` missing → throws `/quoteRefs/`; `quoteRefs: [{ interviewIndex: 1, turnIndex: 3 }]` (no quote) → throws; `quoteRefs: [{ interviewIndex: 0, turnIndex: 3, quote: 'x' }]` → throws; four refs → throws; `representativeQuotes` present alongside `quoteRefs` → throws.
3. **`tests/unit/providerValidation.test.ts:344-352`** (`rejects oversized aggregate collections`) — the 101-theme array at `:346-348` uses `representativeQuotes: []`; change to `quoteRefs: []`. The `/commonThemes/` assertion is unchanged.
4. **`tests/unit/api.followup.provenance.test.ts`** — no rewrite; **add** a new case: the same aggregate with `commonThemes: [{ theme, frequency, quoteRefs: [{ quote, turnIndex, interviewId: 'interview-a' }] }]` and a valid receipt reaches the provider, and one with `interviewIndex` instead of `interviewId` is rejected 400 before any provider call.
5. **`tests/unit/StudyDetail.aggregate.test.tsx`** — the fixture at `:41` and the assertion at `:100-110`. `representativeQuotes: ['A representative quote.']` becomes two refs, one against a real seeded interview transcript and one against a quote that transcript does not contain. `:100-110` keeps its `viewA`/`viewB` non-serif assertions verbatim and swaps the `A representative quote.` serif assertion for the unverified ref's quote. `:86-98` (heading order) and `:112-119` (the footer regex) pass unchanged and must not be touched — they are Slice I's contract and the direct guard that this slice did not disturb the rest of the reading. The `beforeEach` at `:57-60` must give its two `makeStoredInterview` records real transcripts and distinct `createdAt` values so the P-numbering is exercised rather than accidental.
6. **`tests/e2e/workflow-fixture.ts:16`** — as written in L14.

### New, smallest realistic regressions

- **Extend `tests/unit/evidence.test.ts`** (or a new `tests/unit/evidence.aggregate.test.ts` if the file is already long): `buildAggregateInterviewIndex` numbers ascending by `createdAt` regardless of input order, breaks a `createdAt` tie by id, and is unaffected by a later append (an interview added with a newer `createdAt` does not renumber the existing ones); `participantLabel` renders `P01`, `P09`, `P10`, `P100`; `resolveAggregateThemeEvidence` returns `legacy` for a `representativeQuotes` theme, `none` for an empty/absent `quoteRefs`, `verified` with the record's own characters in `quotedFromRecord` and the right `participantNumber` for a locatable ref, `no-record` for an id not in the index, `wrong-speaker` for a ref citing an interviewer turn that contains the quote, `no-turn` for `turnIndex: 99`, and `not-found` for a quote present in a *different* interview than the one cited (the cross-record wrong-record case, which the per-interview matcher could not have); it never throws for a `null`/`undefined`/fractional/`NaN` turn index or an empty index. Plus `withRecordBackedEvidence`: a legacy theme comes back deep-equal to its input with no `evidenceRefs` key added; an unlocatable ref is dropped; a locatable ref's `quote` is rewritten to the record's characters and is a literal substring of the turn.
- **New `tests/unit/api.aggregate.citations.test.ts`** (node environment, mocking the same modules `api.aggregate.revision.test.ts` does): with two current-revision interviews whose syntheses carry `evidenceRefs` and a stubbed `synthesizeAggregate` returning `quoteRefs` claims — the signed `fullResult`'s `commonThemes[0].quoteRefs` carry `interviewId` and **no** `interviewIndex`; the ids match `interviewIds` at the claimed positions; an `interviewIndex` of `0`, `3` (one past the count), and `1_000` is dropped from the payload; no theme carries `representativeQuotes`; `createAggregateSynthesisReceipt` is called with the **resolved** object (assert `quoteRefs[0].interviewId` inside `expect.objectContaining`); the provider was called with syntheses whose refs were filtered and record-backed; and — the ordering invariant — with four interviews of which two are eligible, `interviewIndex: 2` resolves to the **second eligible** id, not the second loaded id. Then telemetry: spying `console.error`, exactly one `synthesis.evidence` line is emitted with `route: '/api/synthesis/aggregate'`, `refsOffered` counting the dropped claim and `refsLocated` counting only the verified one, and the whole set of logged lines contains no substring of any fixture quote.
- **New `tests/unit/AggregateReading.citations.test.tsx`** (or extend `StudyDetail.aggregate.test.tsx` if it stays readable): a verified ref renders a `Citation` trigger whose accessible name is `t.2`, `aria-expanded="true"` on first paint, a note containing the **record's** characters in curly quotes (assert the rendered text is a literal substring of the fixture transcript's turn content, and that it differs from the model's `quote` string in case or punctuation), a coordinate reading `P01 · turn 2`, and a link named `Read in P01's transcript` whose `href` is `/dashboard/interview/<id>?studyId=<id>&turn=2`; clicking the trigger collapses the note and clicking again restores it; an unverified ref renders inside an element whose `className` matches `/font-serif/`, whose text contains no `"`, `“` or `”`, with no `[aria-expanded]` descendant; a ref whose `interviewId` is absent from the index renders the same way; a theme with `quoteRefs: []` renders its name and no passage; a legacy `representativeQuotes` theme renders exactly as before with no wine; `container.querySelectorAll('svg')` is length `0`; and the rendered HTML contains no `--evidence` outside a `Citation`.
- **Extend `tests/unit/InterviewDetail.trace.test.tsx`** — rendering with `turn="2"` puts the Transcript tab in view, focuses `#turn-2` (`document.activeElement`), and leaves that `<li>` carrying `ring-2`; rendering with `turn="99"`, `turn="abc"`, and `turn={undefined}` focuses nothing, sets no ring, and leaves the default tab intact.
- **New `tests/unit/aggregateSchema.roundTrip.test.ts`** — `MAX_AGGREGATE_QUOTE_REFS` equals `aggregateSynthesisResponseSchema.properties.commonThemes.items.properties.quoteRefs.maxItems`, read from the schema (the L5.3 mismatch, pinned the way `synthesisSchema.roundTrip.test.ts` pins its counterpart); and the digest-equality property that makes `generate-followup` work: for a resolved aggregate `A`, `digest(A) === digest(JSON.parse(JSON.stringify(A)))` and `validateResolvedAggregateSynthesis` accepts both, with `quoteRefs` field order in the input not affecting the digest and an unknown key on a ref rejected.
- **New `tests/unit/prompts.aggregateCatalogue.test.ts`** — `buildAggregateSynthesisPrompt` prints a `[1.4]`-style tag for each catalogue entry with the interview index matching the `--- Interview N ---` block it sits in; an interview whose synthesis is legacy-shaped prints `Citable quotes: none available for this interview.`; the catalogue takes at most three entries per interview; with more interviews than the character budget allows, **every** interview that appears contributes before any interview contributes a second entry (the round-robin guarantee, asserted by counting entries per index); and the instruction block contains the verbatim sentence `an invented quote is not.`
- **Extend `tests/e2e/research-workflow.spec.ts`** after `:107` — assert a `t.2` citation trigger is visible; assert the note shows `ANSWER` and a coordinate matching `/^P0\d · turn 2$/`; assert a link matching `/^Read in P0\d's transcript$/` whose `href` contains `turn=2`; assert `UNSAID` is visible **and** carries no citation trigger (the unverified half); then follow the link and assert the transcript turn containing `ANSWER` has focus and carries the trace ring. The aggregate call ledger at `:110-113` must still read exactly one aggregate call.

Do not snapshot any component in this slice.

---

## L16. Verification

The AGENTS.md change map's **Providers/provenance** row is tripped (`prompts/`, synthesis route, provider validation, and the provider payload type). The **Researcher UI** row is tripped (`SynthesisReading`, `StudyDetail`, `InterviewDetail`). **Storage/tenancy is not tripped** — no slice file touches `kv.ts`, `kvClient.ts`, `platformDb*.ts`, or the reconciler; if an implementation finds it needs to, stop and hand back. **Structured request logs is not tripped** (L2.13, L13), but its suites are run anyway because a new call site was added.

```bash
# Providers / provenance
npx vitest run tests/unit/providerValidation.test.ts tests/unit/aggregateSchema.roundTrip.test.ts \
  tests/unit/prompts.aggregateCatalogue.test.ts tests/unit/api.aggregate.revision.test.ts \
  tests/unit/api.aggregate.citations.test.ts tests/unit/api.followup.provenance.test.ts \
  tests/unit/synthesisReceipt.test.ts tests/unit/gatewaySynthesis.workflow.test.ts \
  tests/unit/aiTransport.test.ts tests/unit/api.synthesis.telemetry.test.ts

# Structured request logs (not tripped, but a new call site exists)
npx vitest run tests/unit/requestLog.test.ts tests/unit/providerErrors.test.ts \
  tests/unit/api.health.ready.test.ts tests/unit/api.config.readiness.test.ts

# Researcher UI + the matcher
npx vitest run tests/unit/evidence.test.ts tests/unit/evidence.aggregate.test.ts \
  tests/unit/StudyDetail.aggregate.test.tsx tests/unit/AggregateReading.citations.test.tsx \
  tests/unit/StudyDetail.register.test.tsx tests/unit/StudyDetail.participantLinks.test.tsx \
  tests/unit/InterviewDetail.trace.test.tsx tests/unit/InterviewDetail.reading.test.tsx \
  tests/unit/SynthesisReading.test.tsx tests/unit/demoData.evidence.test.ts
```

Then the proportional full gate, including both build contracts the Providers/provenance row requires, with the non-secret fixture environment from `.github/workflows/ci.yml`:

```bash
npm run check
DEPLOYMENT_MODE=standalone npm run build
DEPLOYMENT_MODE=standalone AI_TRANSPORT=gateway npm run build
DEPLOYMENT_MODE=hosted     AI_TRANSPORT=direct  npm run build
npm run test:e2e
git diff --check
```

Then the greps, each of which must return no output except where noted:

```bash
grep -rn "representativeQuotes" src/                     # only the optional field + the legacy render branch
grep -rn "\.interviewIndex" src/components/              # nothing: no component reads a catalogue position (the `interviewIndex` PROP is the id→participant map, L10.1)
grep -rn "font-serif\|var(--evidence)" src/components/SynthesisReading.tsx
grep -rn "Citation" src/components/ --include=*.tsx      # SynthesisReading.tsx, ui/, and the pre-existing Landing.tsx / DemoSimulation.tsx specimens — the latter two must show an empty git diff
grep -rn "synthesizeAggregate" src/lib/providers/        # five adapters, all unmodified
git diff --stat src/lib/providers/                       # only shared.ts, and only the alias line
git diff --stat src/lib/requestLog.ts                    # empty
git diff --stat src/lib/demoData.ts src/components/DemoSimulation.tsx   # empty
```

Then by hand, at **375px** and 1280px, on `/studies/<id>` → Overview → **Analyze All Interviews**, against a study with at least three interviews synthesized after I2a:

- Every wine numeral opens onto a quote that is visibly present in the named participant's transcript at the named turn. Follow at least two links and confirm the turn takes focus and the ring draws.
- Every serif passage without a numeral carries no quotation marks and no coordinate.
- **The density check** (`initiative-2-spec.md` B6, one surface over): three themes each carrying two or three verified refs is up to nine open notes, each with the system's one shadow token. Confirm the section still reads as a ruled document and not as a stack of cards. If it reads as cards, the fallback is decided in advance and is one character — flip L10.3.4's default to `?? false` and update the `aria-expanded` assertions. **Do not solve it by editing `Citation`.**
- At 375px, confirm the coordinate line and the link do not wrap into an unreadable stack inside the note, and that the page body does not scroll horizontally.
- Reload the page and confirm the entire aggregate is gone. That is what `not saved — regenerate to refresh` is warning about, and it is still true.
- Generate an aggregate over a study whose interviews are all pre-I2a (legacy `evidence`): confirm the catalogue is empty, the model returns empty `quoteRefs`, and Common Themes renders theme names with no passages and no wine. This is the honest zero and it must not look broken.

Leave the dev server runnable for the orchestrator's screenshot pass.

---

## Hard constraints

- **Files that may change:** `src/types.ts`, `src/lib/providerSchemas.ts`, `src/lib/providerValidation.ts`, `src/lib/prompts/synthesis.ts`, `src/lib/evidence.ts`, `src/lib/providers/shared.ts` (the alias line only), `src/lib/ai.ts` (the `synthesizeAggregate` return type only), `src/app/api/synthesis/aggregate/route.ts`, `src/app/api/studies/[id]/generate-followup/route.ts` (the validator import and call only), `src/components/SynthesisReading.tsx` (`AggregateReading` only), `src/components/StudyDetail.tsx`, `src/components/InterviewDetail.tsx`, `src/app/(researcher)/dashboard/interview/[id]/page.tsx`, and the tests and fixtures in L15. **Nothing else.**
- **No provider adapter is edited.** `claude.ts`, `gemini.ts`, `openai.ts`, `openrouter.ts`, `gateway.ts` compile unchanged because `AggregateSynthesisPayload` keeps its name and `validateAggregateSynthesisPayload` keeps its name. If a change here seems to need an adapter edit, the alias was deleted instead of re-pointed.
- **No `src/lib/requestLog.ts` edit.** The allowlists already carry the event and both fields. Adding a new event name would trip a gate this slice does not need to trip.
- **No storage.** No Redis key, no `kv.ts`, no `studyJsonLua.ts`, no persistence of the aggregate or of any verdict. Decision of record 5 puts that in the next Storage train.
- **No verdict in the payload.** `fullResult` carries claims plus server-resolved ids and nothing else. Nothing marks a ref verified, anywhere, ever.
- **The model never receives and never returns an interview id.** `interviewId` is absent from `aggregateSynthesisResponseSchema`, from the prompt, and from `validateAggregateSynthesisPayload`'s accepted keys.
- **`src/components/ui/` is a frozen contract.** `Citation`, `Coordinate`, `Verbatim`, `Label`, `Rule`, `Notice`, `Icon`, `Tabs`, `ExternalLink`, `Button`, `Page` are not edited. If a call site cannot express something through them, style around it in the consumer and say so in the handback.
- **Do not edit `eslint.config.mjs`, `tailwind.config.ts`, `src/app/globals.css`, or `src/app/layout.tsx`.** The design-law ratchet is at zero and this slice adds no token, no keyframe, and no class the primitives do not already own. `.trace-ring` already exists.
- **Do not edit `src/components/Synthesis.tsx`, `src/components/Export.tsx`, `src/components/Dashboard.tsx`, `src/components/DemoSimulation.tsx`, `src/lib/demoData.ts`, `src/app/api/synthesis/route.ts`, or `src/app/api/interviews/export/route.ts`.** The per-interview trace, both markdown exports, the register, the sample workspace and the keyless demo are all out of scope.
- **`SynthesisReading` and `ProvenanceFooter` do not change by one character.** Only `AggregateReading` and the module's type exports move.
- No new dependency and no dependency removal. npm only (`package-lock.json` authoritative), Node ≥ 24.19. No `data-theme` wiring, no theme toggle, light Paper only.
- **Do not commit.** Leave the working tree for review, preserve unrelated dirty files, and review only the scoped diff.

---

## Deferred, do not attempt

- **Persisting the aggregate** (D8's real fix) — the next Storage train, its own spec, the Storage gates. The `not saved — regenerate to refresh` clause Slice I shipped is the honest interim and is not softened here.
- **The aggregate concordance** — a surface listing every citation across a study, and the answer to L4.1's catalogue budget on large studies. Initiative 3's "not in this train" list.
- **Renaming the register's `Interview N` to `P0N`** — Open question 2. It touches `StudyDetail.tsx`, `Dashboard.tsx`, three unit suites and one e2e assertion, and it is a vocabulary decision, not a citation one.
- **Highlighting the located span inside the transcript turn.** `EvidenceMatch.spans` and `occurrences` are carried for it (`initiative-2-spec.md` Ruling 4) and this slice still does not use them; the ring on the turn is the trace.
- **The `WithMargin` unfold (B4)** — struck by decision of record 4. `ui/Page.tsx` stays exported and unused.
- **A repair or retry path for a drifted quote.** An unlocatable quote renders unverified, permanently. Repairing it would break "never substitute a plausible research response" in the quietest possible way.
- **C6 / F1 StudySetup decomposition — Slice M.** Night theme, participant transcript download, typeset HTML/PDF export.
- **The A9 researcher walkthrough** scored on time-to-find-a-quote is still owed for the trace UI, now on two surfaces. It is the owner's gate, not the implementer's, and the handback must state that it is outstanding.

---

## Rulings (Fable, 2026-09-05) — settled; the text above stands except where a ruling amends it

1. **Q1 — drop and count**, as specced.
2. **Q2 — reconcile the register's numbering here, without renaming.** The disagreement must not ship. Amendment to L9.2.2 and the Hard constraints: `StudyDetail`'s interview rows keep their newest-first order and their `Interview N` / `View interview N` vocabulary, but **N becomes the participant number from `buildAggregateInterviewIndex`** (ascending `createdAt`, id tiebreak) instead of `index + 1`. So `Interview 2` on the register and `P02` in a citation name the same record, and the row label is stable under append. `Dashboard.tsx` is not touched (it has no row number). Tests: `StudyDetail.register.test.tsx:74-75`, `StudyDetail.participantLinks.test.tsx:106`, and `research-workflow.spec.ts:86` resolve `View interview 1` / `View interview 2` by name and keep passing provided the fixtures' `createdAt` values order the same way their positions did — verify each fixture and, where a fixture's newest-first position disagrees with its chronological number, rewrite that assertion and say so. Add one assertion to `StudyDetail.register.test.tsx`: with two interviews whose `createdAt` order is the reverse of their array order, the first rendered row is `Interview 2`.
3. **Q3 — ship the budget silently**, as specced; record the limit in the handback.
4. **Q4 — as specced.**
5. **Q5 — as specced.** Render-time matching in the browser; identity server-stamped and signed.
6. **Phase dropped from the coordinate** (L10.4) — confirmed. `P02 · turn 12` is what the record supports.

## Open questions as originally drafted (for the record)

1. **Should an out-of-range `interviewIndex` fail the whole aggregate instead of being dropped?** L7.2.1 drops it and counts it. The stricter alternative is to give `validateAggregateSynthesisPayload` the real interview count and reject the payload outright, treating a hallucinated position exactly like a malformed `turnIndex`. That is more consistent with how every other provider-shape violation is handled, and it would surface a systematically confused model loudly instead of quietly. The cost is that one bad index throws away a paid aggregate call over an entire study, and the researcher's only recourse is to press the button again and hope. **Recommendation: drop and count, as specced.** The telemetry gap is the loud signal, and it is loud in the place that can act on it.

2. **`P02` and the register's `Interview 2` are different records.** L9.2.1 numbers participants ascending by `createdAt` so a coordinate is stable under append; `StudyDetail.tsx:560,566` numbers rows by position in the newest-first list, so its numbers shift whenever an interview arrives. Both are defensible alone and they disagree on the same screen. Unifying them means the register adopts the P-number, which touches `StudyDetail`, `Dashboard`, `Dashboard.idColumn.test.tsx`, `StudyDetail.register.test.tsx` and `research-workflow.spec.ts:86-88`. **Recommendation: unify in a follow-up, not here** — the register's numbering is the one that is wrong (it is not stable), and fixing it inside a citation slice would put a vocabulary change under a provenance gate. If the orchestrator would rather not ship the disagreement at all, the smaller move is to drop the row number entirely and let the ID column identify the row, which is a two-line diff in `StudyDetail`.

3. **The catalogue budget silently limits which interviews can be cited on a large study.** L4.1's round-robin keeps the bias off the interview list's head, but a study past the character budget still has interviews that contribute no citable quote, and the interface says nothing about it. The honest alternatives are a visible note on the aggregate ("citations drawn from N of M interviews"), which adds copy to a surface the brief wanted left alone, or raising the budget, which raises cost and latency on exactly the studies that are already expensive. **Recommendation: ship the budget silently and record the limit in the handback and in `AGENTS.md`'s follow-up list.** The number of studies that hit 40 000 characters of catalogue is small, and the right fix is the deferred concordance surface, not a disclosure about a prompt.

4. **`withRecordBackedEvidence` rewrites the catalogue quote to the record's characters.** That is what makes a faithful copy verify on the first try, and it means the model never sees an earlier model's paraphrase. The counter-argument is that it makes the prompt input differ from the stored record's `evidenceRefs[].quote`, so a debugging researcher comparing the two will find them different for the same citation. **Recommendation: as specced.** The difference is always in the honest direction — toward the record — and the alternative is offering the model text that we have already established the record does not contain.

5. **Aggregate matching runs in the browser (L8).** The chain is safe because identity is server-stamped and signed, and the browser only recomputes a pure function over records it already holds. But it does mean the *server* never blocks a drifted quote from reaching a reader, and a future non-browser consumer of the aggregate (an export, a report generator) would have to re-implement the matcher or ship unverified text. **Recommendation: as specced**, and note in the handback that if aggregate persistence ships in the next Storage train, "where does an export get its verdicts" is the first question that train has to answer.
