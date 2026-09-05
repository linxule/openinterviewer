# Slice I — One reading, one tab strip, one provider module (Initiative 3, second slice, depends on H)

Ends the three-way fork of the synthesis reading (C1) and lands the two content changes that fork was blocking — honest provenance footers (B1, fixing D1 and D2 and the copy half of D8) and the two aggregate sections the model already produces and nobody has ever seen (B3). Builds the accessible `Tabs` primitive DIRECTION §7 asks for and both tab surfaces adopt it (C2). Extracts the provider-setup module that exists twice and has already drifted (C5), and adopts Slice H's `Notice` and `Icon` in the two files C5 owns. Carries the two renames and the pluralization Slice H deferred to this slice (its Rulings 3 and Open question 3).

Context: `docs/design/initiative-3-brief.md` (defect table D1/D2/D8, Move B, Move C, decisions of record 4 and 5), `docs/design/DIRECTION-final.md` §3 (type scale), §6 (iconography), §7 (Synthesis reading, Provenance footer, one Tabs implementation), §9 (keep list), §11 (self-audit), and `docs/design/slice-F-spec.md` §F3–F6, which specified the reading grammar this slice is now extracting.

**Prerequisites: Slice H, merged.** `Notice`, `Icon`, `shortInterviewId`, the rail's `Interviews` destination, and the breadcrumb change are all assumed present. Slice K branches from H alongside this slice and also touches `Synthesis.tsx` (participant branch); K rebases on I when I lands. Slice L (aggregate citations) and Slice M (StudySetup) both depend on this slice.

**Prime directive: this is an extraction plus four named content changes.** Every handler, effect, fetch, guard, ref, and disabled expression survives byte-for-byte. The rendered appearance of the per-interview reading does not change at all; the rendered class *set* on each element is identical, though `cn` may reorder the class string on the two tab strips. Content changes are exactly four and each is named below: the two provenance footers (I3), the two new aggregate sections (I4), the two renames plus two pluralizations (I10), and the two copy reconciliations in the provider module (I7). If a change is not named here, do not make it.

In `Synthesis.tsx` that means the whole `CompletionAttempt` apparatus — `sameCompletionInputs`, `isCurrentAttempt`, `activeAttempt`, `mounted`, `doSave`, `handleRetrySave`, `handleRetryAnalysis`, the analyze-and-save effect and its full dependency array, `handleBack`, `handleExport` — is untouched, and the participant branch (`:195–267`) is not edited at all. In `InterviewDetail.tsx` that means `loadInterview`, the interview-id reset effect, `handleDownloadJSON`, `handleDownloadTranscript` and every string they emit, `formatDuration`, and `traceToTurn`'s `requestAnimationFrame` focus are untouched. In `StudyDetail.tsx` that means the entire link-management surface, `handleGenerateAggregateSynthesis`, `handleGenerateFollowup`, `handleTbodyKeyDown`, `runReconciliation`, and every `alert()` and `window.confirm` are untouched. In `Settings.tsx` and `Onboarding.tsx` that means `handleSave`, `saveAndComplete`, `clearCredential`, `deleteAccount`, `validateAiKey`, `validateRedis`, `refreshProfile`, `hasChanges`, `availableProviders`, `canProceedFromAiKeys`, and `canProceedFromRedis` are untouched.

## I1. Laws that bind this slice

- **Tokens only.** `bg-paper-*`, `text-ink-*`, `border-ink-*`, `text-action`, `text-success`, `text-error`. `eslint.config.mjs:6–43` enforces this across `src/**`.
- **Wine reaches this slice only through `Citation`.** No file created or edited here may reference `var(--evidence)` or `var(--disclosure)`, and none may use a raw `font-serif` class outside `src/components/ui/`. Serif in the reading comes from `Verbatim`; wine comes from `Citation`. Both already live in `ui/`. This is the constraint that decides I2's file location.
- **No new npm dependency.** `Tabs` and `ExternalLink` are hand-written; `Icon` already ships all six marks.
- **Icons are `aria-hidden`, always.** The accessible name comes from adjacent `sr-only` text or the host control's own label. `Icon` never carries `title`, `role="img"`, or `aria-label` (Slice H, H1).
- **Honesty copy is verbatim (§9).** Not one word changes in: `Preview complete. This interview was not added to the study data.`, `Could not save interview. You can still export locally below.`, `Interview saved successfully. View it in the researcher dashboard.`, `Your responses have been saved. It is now safe to close this tab.`, `Only dates and status are retained here. Link URLs cannot be viewed again after creation.`, `Copy this link now. For security, its URL cannot be recovered from the generated-links list.`, `API keys, Redis credentials, and signing secrets are read from this deployment's environment. They cannot be viewed or changed in the browser.`, `This removes your hosted account, encrypted credentials, and platform routing metadata. It does not delete studies, interviews, or any other data in your external Upstash Redis database. Manage or delete that external data directly in Upstash.`, and the OpenRouter zero-data-retention sentence except for the single reconciled word named in I7.3.
- **Light only.** No `dark:` variant, no `data-theme` read or write.
- **No provenance may be inferred.** The footer prints what the record carries and says so plainly when a field is missing. It never derives a model name from `studyConfig`, never prints a receipt fragment, and never implies a saved aggregate exists.

## I2. `src/components/SynthesisReading.tsx` — the reading, written once (C1)

`Synthesis.tsx:323–454` and `InterviewDetail.tsx:262–400` are byte-identical apart from three things, and `StudyDetail.tsx:485–555` is a third, structurally different reading of a different result shape. A machine diff of the first two (whitespace-normalized) returns exactly: the data expression (`synthesis.*` vs `interview.synthesis.*`), the transcript passed to `resolveThemeEvidence` (`interviewHistory` vs `interview.transcript`), one `Label` string, and the `Read in full transcript` button inside the note.

### I2.1 Where the file goes, and why not `ui/`

**`src/components/SynthesisReading.tsx`, not `src/components/ui/SynthesisReading.tsx`.**

Every file in `src/components/ui/` today imports exactly two things — `react` and `@/lib/cn` — plus, in three cases, a sibling primitive (`Field` and `Notice` import `Label`; `Turn` imports `Coordinate`). None imports `@/types`, `@/lib/`, `@/services/`, or `@/store`. `SynthesisReading` must import `SynthesisResult`, `AggregateSynthesisResult`, and `InterviewMessage` from `@/types` and `resolveThemeEvidence` from `@/lib/evidence`. Putting it in `ui/` inverts that layering and makes the primitive directory depend on the domain.

The decisive reason is the lint boundary. `eslint.config.mjs:26–42` marks `font-serif`, `var(--evidence)`, and `var(--disclosure)` as `primitivesOnly` — `ui/` is not a folder, it is a *licence* to write wine, ochre, and raw serif. This component needs none of that: it reaches serif through `Verbatim` and wine through `Citation`, exactly as the brief requires. Filing a 180-line domain component inside the exemption zone would hand it a standing permission the design law is deliberately withholding, and would make the next person's raw `font-serif` there invisible to review.

`src/components/ui/Tabs.tsx` (I6) and `src/components/ui/ExternalLink.tsx` (I8) *do* go in `ui/`: both are domain-free, both import only `react`, `cn`, and a sibling primitive, and both are new visual vocabulary in the sense the brief's AGENTS.md note means.

### I2.2 What the module exports

Three exports, because the three consumers place them differently and forcing one component over two disjoint documents would be a switch statement wearing a component's clothes:

```tsx
export interface SynthesisReadingProps {
  synthesis: SynthesisResult
  /** The record every citation is checked against. */
  transcript: InterviewMessage[]
  /** Controlled note state, keyed `${themeIndex}:${refIndex}`. A missing key means open. */
  openNotes: Record<string, boolean>
  onNoteOpenChange: (themeIndex: number, refIndex: number, open: boolean) => void
  /**
   * Renders "Read in full transcript" inside each verified note. Omit on a
   * surface with no transcript to jump to — `Synthesis.tsx` has none.
   */
  onTraceToTurn?: (turnIndex: number) => void
}

export interface AggregateReadingProps {
  synthesis: AggregateSynthesisResult
}

export interface ProvenanceFooterProps {
  model?: string
  studyRevision?: number
  /** Preformatted by the consumer, which owns its screen's date format. */
  timestamp: string
  /** How the record came to exist at that time. */
  verb: 'saved' | 'generated'
  /** Trailing honesty clause, e.g. the aggregate's ephemerality warning. */
  note?: string
}
```

All three return a **fragment of sibling `<section>` / `<Rule>` / `<footer>` elements, never a wrapper `<div>`.** Each consumer already wraps them in its own `space-y-6` container and that spacing depends on the sections being direct children. Adding a wrapper would collapse the vertical rhythm on all three screens at once.

`SynthesisReading` derives `isNoteOpen(i, j) => openNotes[`${i}:${j}`] ?? true` internally. Both consumers already store the same shape (`Synthesis.tsx:72–75`, `InterviewDetail.tsx:25–31`); they keep their `useState` and pass it down. The state stays in the consumer because `InterviewDetail.tsx:68–71` must clear it when `interviewId` changes, and that effect is about the route, not the reading.

### I2.3 The per-interview reading, section by section

Copied character for character from `Synthesis.tsx:324–454`, with `synthesis` and `transcript` coming from props:

1. **Bottom line** — `<section>` with `<Label className="block">Bottom line</Label>` and `<Verbatim as="p" className="mt-3 max-w-measure text-[24px] font-normal leading-[36px] text-ink-900 md:text-[28px] md:leading-[40px]">`, then `<Rule className="mt-8" />`.
2. **Stated vs Revealed** — `<h3 className="font-sans text-[15px] font-semibold text-ink-900">Stated vs Revealed</h3>`, the `mt-4 md:grid md:grid-cols-2 md:gap-10` pair, `Label` sub-heads, rows as `border-t border-ink-300 py-2 font-sans text-[15px] leading-[24px] text-ink-700`. Then `<Rule className="mt-8" />`.
3. **Key Themes** — `<h3>` verbatim, `<ul className="mt-4">`, each `<li className="border-t border-ink-300 py-4">` with the theme name paragraph, the `resolveThemeEvidence` branch, the `Citation` for verified refs and the serif `Verbatim` passage for legacy text and unverified refs. Every class string is copied.
4. **Contradictions** — the `synthesis.contradictions.length > 0` gate and `border-t border-ink-300 pt-5` section, verbatim.
5. **Additional Insights** — `<h3>` verbatim, ruled rows, verbatim.

**The `Label` string is harmonized to `What their behavior revealed`.** `InterviewDetail` says `What behavior revealed` today. `slice-F-spec.md:71` kept both deliberately and named the merge "a copy decision, not a migration decision"; C1 forces that decision now, because the alternative is a prop whose only job is to keep two names for one thing alive inside the component built to stop exactly that. No test pins either string (`grep -rn "behavior revealed" tests/` returns nothing). The surviving string is the one that parallels its sibling `What they said` and names whose behaviour it was. See Rulings 1; reverting is a one-word edit in one file.

**The trace affordance is one optional prop.** Inside the verified-ref `Citation`, after the `Coordinate`:

```tsx
{onTraceToTurn ? (
  <button
    type="button"
    onClick={() => onTraceToTurn(entry.ref.turnIndex)}
    className="mt-2 block font-sans text-[13px] text-action underline underline-offset-2"
  >
    Read in full transcript
  </button>
) : null}
```

Copy, classes, and placement verbatim from `InterviewDetail.tsx:334–340`. `Synthesis.tsx` omits the prop, so the button does not render — which is what `Synthesis.trace.test.tsx:133` already asserts, and asserting it structurally is stronger than asserting it by prop.

### I2.4 The aggregate reading

From `StudyDetail.tsx:486–531`, plus I4's two new sections. Headings are `<h4 className="font-sans text-[15px] font-semibold text-ink-900">`, not `<h3>` — the aggregate reading is nested under the `Aggregate Analysis` `<h3>` at `StudyDetail.tsx:469` and the existing markup already uses `h4`. Order:

1. **Bottom line** — same `Label` + `Verbatim` treatment as I2.3, then `<Rule className="mt-8" />`.
2. **Key Findings** — `<ul className="mt-3">`, rows `max-w-measure border-t border-ink-300 py-2 font-sans text-[15px] leading-[24px] text-ink-700`. Verbatim.
3. **Common Themes** — gated on `commonThemes.length > 0`; each `<li className="border-t border-ink-300 py-4">` with the theme name and its `representativeQuotes` as serif supporting passages (`mt-2 max-w-measure border-l border-ink-300 pl-4 text-[17px] leading-[28px] text-ink-700`). Verbatim. **`quoteRefs` stays unread — that is Slice L (B2/I2c).**
4. **Divergent Views** — new, I4.
5. **Research Implications** — new, I4.

The `Create Follow-up Study` block (`StudyDetail.tsx:533–544`) and the footer are **not** part of `AggregateReading`; `StudyDetail` renders them as siblings after it, in the order they appear today.

## I3. B1 — provenance footers that tell the truth (fixes D1, D2, the copy half of D8)

`ProvenanceFooter` owns the grammar:

```tsx
export function ProvenanceFooter({ model, studyRevision, timestamp, verb, note }: ProvenanceFooterProps) {
  const line = [
    `Synthesized by ${model || 'unrecorded model'}`,
    `study rev ${studyRevision ?? '—'}`,
    `${verb} ${timestamp}`,
    ...(note ? [note] : []),
  ].join(' · ')
  return (
    <footer className="mt-10 border-t border-ink-300 pt-4">
      <Coordinate className="block">{line}</Coordinate>
    </footer>
  )
}
```

`model || 'unrecorded model'` rather than `??`: an empty string is not a model name, and `aiModel` reaches `StudyDetail` through a `data.synthesis as AggregateSynthesisResult` assertion (`StudyDetail.tsx:248–252`), not through validation.

**There is no receipt clause anywhere in the UI after this slice.** The confirming reads: `src/app/api/interviews/save/route.ts:138` destructures `const { _receipt, ...verifiedSynthesis }` and `:188` stores `verifiedSynthesis`, so a stored interview's `synthesis._receipt` is structurally always `undefined` and `InterviewDetail.tsx:411–413` can only ever print `receipt unsigned`. `src/lib/synthesisReceipt.ts:40–76` shows why that is correct rather than a bug: the receipt is a 1-hour HS256 token whose entire job is discharged at `verifySynthesisReceipt` (`:78`), and the facts it carried — `aiModel`, `studyRevision`, `aiProvider`, `requestedAiModel`, `routedProvider` — are copied onto the stored record at `save/route.ts:197–204`. The footer's remaining three facts are the verified ones. On the aggregate, `StudyDetail.tsx:551` prints `_receipt.slice(0, 12)`, which is the base64 of a JWS header and therefore the same twelve characters for every receipt this deployment has ever issued.

### I3.1 InterviewDetail

```
Synthesized by <aiModel> · study rev <studyRevision> · saved <completedAt>
```

`InterviewDetail` computes the timestamp with the same options its own header already uses (`:168–172`), so one screen prints one date format:

```tsx
const savedAt = Number.isFinite(interview.completedAt)
  ? new Date(interview.completedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  : 'time unrecorded';
```

Then `<ProvenanceFooter model={interview.aiModel} studyRevision={interview.studyRevision} timestamp={savedAt} verb="saved" />`. `aiModel` and `studyRevision` are optional on `StoredInterview` (`src/types.ts:257,261`) and take the `unrecorded model` / `—` fallbacks; `completedAt` is required (`:255`) and server-generated (`save/route.ts:195`), so the guard is belt-and-braces against a hand-edited record, not an expected path.

### I3.2 StudyDetail aggregate

```
Synthesized by <aiModel> · study rev <studyRevision> · generated <generatedAt> · not saved — regenerate to refresh
```

```tsx
const generatedAt = Number.isFinite(aggregateSynthesis.generatedAt)
  ? formatDate(aggregateSynthesis.generatedAt)
  : 'time unrecorded';
```

`formatDate` is `StudyDetail`'s existing local formatter (`:307–315`, month/day/year plus 2-digit hour and minute) — keep it, because every other timestamp on that screen uses it and the aggregate is a thing that happened minutes ago, where the clock time is the useful part.

Then `<ProvenanceFooter model={aggregateSynthesis.aiModel} studyRevision={aggregateSynthesis.studyRevision} timestamp={generatedAt} verb="generated" note="not saved — regenerate to refresh" />`.

**The clause is unconditional.** `aggregateSynthesis` lives in `useState` (`StudyDetail.tsx:33`) and `POST /api/synthesis/aggregate` writes nothing — `route.ts:121–136` builds `fullResult`, mints a receipt, and returns it. There is no read path and no persistence, so there is no state in which the aggregate *is* saved and no condition to gate the clause on. Decision of record 5 makes persistence the next Storage train's first item; when it ships, this is the one prop that changes.

All three provenance fields are non-optional on `AggregateSynthesisResult` (`src/types.ts:356,360,368`) and all three are set unconditionally by the route (`:124,129,131`), so the fallbacks are unreachable on any response this deployment produces. They are still specified, because the value arrives through a type assertion rather than a validator.

### I3.3 Synthesis.tsx renders no footer

Unchanged from `slice-F-spec.md` §F4.4, and now enforced structurally: `Synthesis.tsx` does not import `ProvenanceFooter`. At that moment the interview record does not exist — `doSave` may be in flight, may have failed, or may be a preview that is never written — and the only provenance the browser holds is `studyConfig`'s *requested* provider, which AGENTS.md's last invariant says may differ from the model that actually ran. `Synthesis.register.test.tsx:122` and `Synthesis.trace.test.tsx:132` pin the absence.

## I4. B3 — `divergentViews` and `researchImplications` on the aggregate reading

Both are populated, schema-validated (`src/lib/providerValidation.ts:283–304` and `:308–318`), prompted for (`src/lib/prompts/synthesis.ts:183–191`), and referenced in zero `.tsx` files. The researcher has already paid for them.

**Divergent Views**, after Common Themes:

```tsx
{synthesis.divergentViews.length > 0 && (
  <section>
    <h4 className="font-sans text-[15px] font-semibold text-ink-900">Divergent Views</h4>
    <ul className="mt-3">
      {synthesis.divergentViews.map((view, i) => (
        <li key={i} className="border-t border-ink-300 py-4">
          <p className="font-sans text-[15px] font-medium text-ink-900">{view.topic}</p>
          <ul className="mt-2">
            <li className="max-w-measure border-l border-ink-300 pl-4 font-sans text-[15px] leading-[24px] text-ink-700">
              {view.viewA}
            </li>
            <li className="mt-2 max-w-measure border-l border-ink-300 pl-4 font-sans text-[15px] leading-[24px] text-ink-700">
              {view.viewB}
            </li>
          </ul>
        </li>
      ))}
    </ul>
  </section>
)}
```

**These two rows are sans, not serif, and that is the load-bearing decision in this section.** Law 1 puts verbatim human speech, consent text, and interpretation prose in Source Serif 4. `representativeQuotes` are the participant's words and are serif (I2.4 step 3). `viewA` and `viewB` are the model's *summaries of a disagreement* — the same register as `keyFindings` and `keyInsights`, both of which are sans today. Rendering a paraphrase in the face reserved for speech is precisely the confusion DIRECTION §11 calls "serif is load-bearing, never decorative". 
The `border-l border-ink-300 pl-4` indent is the existing supporting-passage geometry — `StudyDetail.tsx:522` and `InterviewDetail.tsx:349` both use exactly those three classes — reused here without the serif and without the 17/28 size.

No sub-labels for the two views: the type gives them none (`src/types.ts:364` is `{ topic, viewA, viewB }`), and inventing `One view` / `Another view` would be UI copy asserting a structure the data does not carry.

**Research Implications**, last, in exactly the Key Findings grammar:

```tsx
{synthesis.researchImplications.length > 0 && (
  <section>
    <h4 className="font-sans text-[15px] font-semibold text-ink-900">Research Implications</h4>
    <ul className="mt-3">
      {synthesis.researchImplications.map((implication, i) => (
        <li key={i} className="max-w-measure border-t border-ink-300 py-2 font-sans text-[15px] leading-[24px] text-ink-700">
          {implication}
        </li>
      ))}
    </ul>
  </section>
)}
```

Both use the bare `.length > 0` gate, matching the `commonThemes` sibling at `StudyDetail.tsx:511`. `Array.isArray` guards are not added: both fields are required on the type, `validateAggregateSynthesis` rejects a response missing either, and the value is never read back from storage because there is no storage.

Placing Research Implications last is deliberate — it is the forward-looking section and it sits directly above `Create Follow-up Study`, which is the action it argues for.

**What the fixtures give you.** `tests/e2e/workflow-fixture.ts:17–18` returns `divergentViews: []` and `researchImplications: ['Investigate when notes are written.']`, so the e2e run exercises the empty gate on one section and the render on the other. `src/lib/demoData.ts` seeds no aggregate synthesis at all, so the sample workspace shows this section only after a real `Analyze All Interviews` call.

## I5. The three consumers

### I5.1 `src/components/Synthesis.tsx`

Only the researcher/preview branch changes. `:323–454` is replaced by one element inside the existing `<div className="space-y-6">`:

```tsx
<SynthesisReading
  synthesis={synthesis}
  transcript={interviewHistory}
  openNotes={openNotes}
  onNoteOpenChange={setNoteOpen}
/>
```

`openNotes`, `isNoteOpen`, and `setNoteOpen` (`:72–75`): `openNotes` and `setNoteOpen` are passed down; **`isNoteOpen` is deleted** because it moves into the component and would otherwise be an unused local that lint flags. The four save-status `Notice` blocks (`:293–321`) stay above it and the action row (`:457–464`) stays below it, both unchanged. `Citation`, `Coordinate`, and `resolveThemeEvidence` drop out of the import list; `Verbatim` stays (the participant branch's `h1`s use it), as do `Button`, `Label`, `Notice`, `Page`, and `Rule`.

The participant branch, the no-study branch, the analyzing branch, the analysis-failed branch, and the no-data branch are not edited.

### I5.2 `src/components/InterviewDetail.tsx`

- `:152–154` — `Back to Dashboard` becomes `Back to Interviews` (I10).
- `:166` — `{interview.transcript.length} messages` becomes `{interview.transcript.length} message{interview.transcript.length !== 1 ? 's' : ''}` (I10).
- `:203–226` — the two plain buttons become `Tabs` (I6.2).
- `:262–400` — replaced by:

```tsx
<SynthesisReading
  synthesis={interview.synthesis}
  transcript={interview.transcript}
  openNotes={openNotes}
  onNoteOpenChange={setNoteOpen}
  onTraceToTurn={traceToTurn}
/>
```

- `:402–415` — replaced by the `ProvenanceFooter` of I3.1.

`isNoteOpen` (`:29`) is deleted for the same reason as above. `Citation`, `Coordinate`, `Rule`, `Verbatim`, and `resolveThemeEvidence` leave the import list; `Coordinate` **stays**, because the header at `:165–173` still uses it. `Label` and `Turn` stay for the transcript panel. The `interview.synthesis ? … : …` gate and its `No analysis available for this interview.` fallback are unchanged.

### I5.3 `src/components/StudyDetail.tsx`

- `:388` — `{study.interviewCount} interviews` becomes `{study.interviewCount} interview{study.interviewCount !== 1 ? 's' : ''}` (I10).
- `:412–429` — the partial-ARIA tablist becomes `Tabs` (I6.2).
- `:486–531` — replaced by `<AggregateReading synthesis={aggregateSynthesis} />`, still inside `<div className="mt-6 space-y-6">` at `:485`.
- `:533–544` — the `Create Follow-up Study` block stays exactly where it is, unchanged.
- `:546–554` — replaced by the `ProvenanceFooter` of I3.2.

`Verbatim` leaves the import list (`AggregateReading` owns the only serif on this screen); `Coordinate`, `Button`, `Icon`, `Label`, `Notice`, and `Rule` all stay. `:658`'s eyebrow keeps its `> 1` form: it renders only under `study.interviewCount > 0`, so it is already correct, and rewriting it changes no output.

## I6. `src/components/ui/Tabs.tsx` — one accessible tab strip (C2)

Today `StudyDetail.tsx:412–429` has `role="tablist"`, `role="tab"`, and `aria-selected` but no `aria-controls`, no `tabpanel`, and no roving tabindex; `InterviewDetail.tsx:203–226` is two plain buttons with none of it. A screen-reader user on the first is told they are in a tab list and then given no panel relationship and no arrow keys; that is worse than the second.

### I6.1 The primitive

```tsx
export interface TabItem<T extends string> { id: T; label: string }

export interface TabsProps<T extends string> {
  items: TabItem<T>[]
  value: T
  onValueChange: (id: T) => void
  /** Accessible name for the tablist. */
  label: string
  /** Classes for the tablist element; the grid column count lives here. */
  className?: string
  /** Classes for the tabpanel element. */
  panelClassName?: string
  /** The active panel's content. Only the active panel is rendered. */
  children: ReactNode
}
```

Renders a **fragment**, never a wrapper element:

```
<div role="tablist" aria-label={label} className={cn('grid border-b border-ink-300', className)} onKeyDown={…}>
  <button
    type="button"
    role="tab"
    id={`${baseId}-tab-${item.id}`}
    aria-selected={item.id === value}
    aria-controls={`${baseId}-panel`}
    tabIndex={item.id === value ? 0 : -1}
    ref={…}
    onClick={() => onValueChange(item.id)}
    className="min-h-11 border-b-2 px-2 py-3 text-center font-sans text-[15px] font-medium …"
  >{item.label}</button>
  …
</div>
<div role="tabpanel" id={`${baseId}-panel`} aria-labelledby={`${baseId}-tab-${value}`} tabIndex={0} className={panelClassName}>
  {children}
</div>
```

`baseId` from `useId()`. Active tab classes `border-action text-action`; inactive `border-transparent text-ink-500 hover:text-ink-900`. Both strings are copied from the two call sites, which already agree character for character.

**Manual activation, not automatic.** Arrow keys move focus only; `Enter`, `Space`, and click activate. Three reasons, in order of weight:

1. Activation here has a side effect. `InterviewDetail.tsx:33–36`'s `switchTab` clears `tracedTurn`, so under automatic activation a researcher arrowing past `Transcript` on the way back to `Analysis` would silently discard the turn they had just traced to.
2. `StudyDetail`'s `Study settings` panel is a long surface with link management, a `role="switch"`, and a generated-links register. Auto-mounting and announcing it while a user arrows through the strip is a large involuntary context change.
3. The APG reserves automatic activation for panels whose display is free of cost and consequence, and manual activation is behaviourally identical under pointer input — which is what every existing assertion and the e2e spec use.

**Keys**, on the tablist: `ArrowRight` / `ArrowLeft` move focus one tab and **wrap**; `Home` / `End` move to first / last; each calls `preventDefault()`. `ArrowUp` / `ArrowDown` are not bound — this is a horizontal tablist, and `StudyDetail` already binds those on its interview `<tbody>` (`:322–333`). Wrapping diverges from the register tables, which clamp (`StudyList.register.test.tsx:87–97` pins the clamp); the divergence is deliberate, because a tablist is a closed ring of two or three items where wrapping is the convention, while an unbounded table row list is one where wrapping would teleport a researcher from the last interview to the first.

**One panel element, shared.** Every tab's `aria-controls` points at the single `${baseId}-panel`, whose `aria-labelledby` names the currently selected tab. The alternative — a per-tab panel id — leaves inactive tabs pointing at ids that do not exist, which axe's `aria-valid-attr-value` flags and which no assistive technology can follow. The other alternative — mounting every panel and hiding the inactive ones — changes behaviour: it would mount `InterviewDetail`'s whole transcript while the researcher is reading the analysis, and it would make `screen.getByText` in six existing tests resolve against content the user cannot see. **Only the active panel is rendered**, exactly as today.

`tabIndex={0}` on the panel: `StudyDetail`'s Overview panel contains long non-focusable prose, and a keyboard user must be able to reach and scroll it. It does not disturb `InterviewDetail`'s programmatic `document.getElementById('turn-N').focus()` (`:41–43`), which runs inside `requestAnimationFrame` after the panel has mounted.

Export from `src/components/ui/index.ts`: `export { Tabs, type TabItem, type TabsProps } from './Tabs'`.

### I6.2 The two adoptions

**`StudyDetail.tsx`.** The `tabs` array at `:374–378` is unchanged and satisfies `TabItem<TabType>[]`. `:412–429` and the three `{activeTab === '…' && (…)}` blocks at `:432`, `:565`, and `:655` become:

```tsx
<Tabs items={tabs} value={activeTab} onValueChange={setActiveTab} label="Study sections" className="mb-8 grid-cols-3">
  {activeTab === 'overview' && (…)}
  {activeTab === 'interviews' && (…)}
  {activeTab === 'settings' && (…)}
</Tabs>
```

The three conditional bodies are moved without one character changing. `StudyDetail.participantLinks.test.tsx:102` asserts the tablist carries `grid-cols-3`, which `className` supplies; `toHaveClass` is order-insensitive, so `cn`'s reordering of the class string is invisible to it.

**`InterviewDetail.tsx`.** A module-level array beside the component:

```tsx
const INTERVIEW_TABS = [
  { id: 'transcript', label: 'Transcript' },
  { id: 'analysis', label: 'Analysis' },
] as const satisfies readonly TabItem<'transcript' | 'analysis'>[];
```

`:203–226` and the `{activeTab === 'transcript' ? … : …}` ternary at `:229–423` become `<Tabs items={INTERVIEW_TABS} value={activeTab} onValueChange={switchTab} label="Interview sections" className="mb-8 grid-cols-2">` wrapping the same ternary. `switchTab` keeps clearing `tracedTurn`; `traceToTurn` keeps calling `setActiveTab('transcript')` directly, so a trace does **not** clear the turn it just set. That asymmetry is existing behaviour and `InterviewDetail.trace.test.tsx:179–191` depends on it.

`aria-label="Interview sections"` is new copy, and it is the only new user-facing string in C2. It names what the strip switches between, parallel to `Study sections`.

**Both tab strips move from `button` role to `tab` role**, which is the point of the primitive and which breaks four assertions — see I11.

## I7. `src/components/providerSetup.tsx` — the module that exists twice (C5)

`Settings.tsx:10–154` and `Onboarding.tsx:18–157` declare the same `ValidationState`, the same `CredentialField` and `ProviderProfileField` unions, the same four-entry `AI_PROVIDER_SETUP`, the same `emptyValidationState`, the same `initialProviderRecord`, and a character-identical `ValidationBadge`. Two of the four provider entries have already drifted.

Location: `src/components/providerSetup.tsx`, lowercase, following `src/components/shell/breadcrumb.tsx`'s precedent for a module that exports both data and a component. It carries JSX (the `guidance` nodes) so it cannot live in `src/lib/`, and it imports `@/types` and `@/lib/providerRegistry` so it must not live in `src/components/ui/` (I2.1).

### I7.1 What it exports

```tsx
export interface ValidationState { loading: boolean; valid: boolean | null; error: string | null }
export type ProviderProfileField = 'hasGeminiKey' | 'hasAnthropicKey' | 'hasOpenAiKey' | 'hasOpenRouterKey'
export type CredentialField = 'geminiApiKey' | 'anthropicApiKey' | 'openAiApiKey' | 'openRouterApiKey'
export type CredentialTarget = 'gemini' | 'anthropic' | 'openai' | 'openrouter'

export interface ProviderSetup {
  id: AIProviderType
  /** Full product name, from PROVIDER_OPTIONS. */
  label: string
  /** Short name for status rows and guide triggers: Gemini · Claude · OpenAI · OpenRouter. */
  shortLabel: string
  article: 'a' | 'an'
  placeholder: string
  profileField: ProviderProfileField
  credentialField: CredentialField
  clearTarget: CredentialTarget
  keyUrl: string
  keyUrlLabel: string
  steps: string[]
  guidance: ReactNode
}

export const AI_PROVIDER_SETUP: ProviderSetup[]
export function providerInputId(surface: 'settings' | 'onboarding', provider: ProviderSetup): string
export function emptyValidationState(): ValidationState
export function initialProviderRecord<T>(create: () => T): Record<AIProviderType, T>
export function ValidationBadge(props: { state: ValidationState; label: string }): ReactNode
```

Two fields present today are **derived instead of stored**, and both derivations reproduce every current value exactly:

- `Settings`'s `statusLabel` (`Gemini Key`, `Claude Key`, `OpenAI Key`, `OpenRouter Key`) is `` `${provider.shortLabel} Key` ``, rendered inline at `Settings.tsx:410`.
- Both files' `inputId` is `` `${surface}-${provider.id}-key` ``. Check it against all eight: `settings-gemini-key`, `settings-claude-key`, `settings-openai-key`, `settings-openrouter-key`, `onboarding-gemini-key`, `onboarding-claude-key`, `onboarding-openai-key`, `onboarding-openrouter-key`. All eight match the literals in the source today, so no `htmlFor`/`id` pairing and no `${inputId}-error` id changes.

`Settings`'s `StatusIcon` (`:130–137`) stays in `Settings.tsx` — one consumer, and it is a status presentation, not provider setup.

`ValidationBadge` moves verbatim: the three branches, the two `role="status" aria-live="polite"` wrappers, the `aria-hidden` visible words, the `sr-only` `Testing {label} key` and `{label} key validated`, and the unwrapped `Invalid` span. `Settings.tokens.test.tsx:57–68` and `providerSetupCopy.test.tsx:122,189` all depend on this shape.

### I7.2 The gemini `steps` drift

`Settings.tsx:50` has `['Sign in and create an API key', 'Copy the new key']`; `Onboarding.tsx:62` has `['Sign in with a Google account', 'Create an API key', 'Copy the new key']`. The other three providers agree. **Keep Onboarding's three-step version.** It names the account type a first-time researcher needs, it separates signing in from minting a key the way the other three entries do, and no assertion reads the list on either surface. Settings gains one step.

### I7.3 The OpenRouter zero-data-retention drift

`Settings.tsx:112–114`: "…denies provider data collection; **requests fail** if those restrictions cannot be met."
`Onboarding.tsx:124–126`: "…denies provider data collection; **a request fails** if those restrictions cannot be met."

**Keep the Settings wording, `requests fail if those restrictions cannot be met`.** The sentence states a standing policy, and AGENTS.md's invariant is categorical — "AI/provider failure is an error. Never substitute a plausible research response." The plural reads as the rule; the singular reads as an incident that might happen once. Onboarding's sentence changes by two words. This is the one honesty-copy edit in the slice and it is deliberate; `providerSetupCopy.test.tsx:115` matches only the leading clause and passes either way.

### I7.4 The two adoptions

Both files delete their local declarations and import from the module. Neither file's logic moves:

- `Settings.tsx` — delete `:10–18` (types), `:20–33` (`ProviderSetup`), `:35–36` (`providerLabel`), `:38–119` (`AI_PROVIDER_SETUP`), `:121` (`emptyValidationState`), `:123–128` (`initialProviderRecord`), `:139–154` (`ValidationBadge`). Keep `StatusIcon` (`:130–137`). Render `` {`${provider.shortLabel} Key`} `` at `:410` and `providerInputId('settings', provider)` at `:474`, `:479`, and `:500`. `:256` (`for (const provider of AI_PROVIDER_SETUP)`), `:313` (`.find(o => o.clearTarget === target)`), `:406`, `:470`, `:489`, `:546–550`, and `:616` are otherwise unchanged.
- `Onboarding.tsx` — delete `:18–25`, `:32–45`, `:47–48`, `:50–131`, `:133`, `:135–140`, `:142–157`. Render `providerInputId('onboarding', provider)` at `:350`, `:355`, and `:369`. `:249–252`, `:282–284`, `:346`, `:364`, `:407` (`How to get {provider.article} {provider.shortLabel} API key`), `:415–419`, and `:535` (`availableProviders.map(p => p.shortLabel).join(' + ')`) are otherwise unchanged. `summaryLabel` is renamed to `shortLabel` at both use sites and nowhere else.

`providerSetupCopy.test.tsx:92–95` pins the four Onboarding trigger names (`/how to get a gemini api key/i`, `/a claude/`, `/an openai/`, `/an openrouter/`) and `:143–146` pins the four Settings ones (`Google Gemini setup guide` and siblings). Both are reproduced exactly by `shortLabel` + `article` and by `label`.

## I8. `src/components/ui/ExternalLink.tsx` — the external mark, once (C4/D6)

`grep -rn 'target="_blank"' src/` returns 17 hits: 9 in `Settings.tsx`, 8 in `Onboarding.tsx`. None carries an external mark and none announces the new tab. Sixteen use `rel="noopener noreferrer"`; `Settings.tsx:383` uses `rel="noreferrer"` alone.

Seventeen call sites means seventeen chances to drift on the mark, the `rel` pair, and the screen-reader string. One primitive:

```tsx
export interface ExternalLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'target' | 'rel'> {
  href: string
  children: ReactNode
}

export function ExternalLink({ href, children, className, ...props }: ExternalLinkProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn('inline-flex items-baseline gap-1', className)}
      {...props}
    >
      {children}
      <Icon name="external" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}
```

- `target` and `rel` are omitted from the prop type so no call site can weaken them; `Settings.tsx:383`'s lone `rel="noreferrer"` is unified upward to `noopener noreferrer`.
- The mark is `Icon name="external"` at the default 16px, `aria-hidden` and `currentColor` (Slice H, H3), so it takes the teal of the link it sits in.
- `inline-flex items-baseline gap-1` keeps the mark on the text baseline inside a running sentence, which is where fourteen of the seventeen links live.
- **The accessible name gains ` (opens in a new tab)`.** That is the point of the sr-only span and it is what breaks ten existing assertions — see I11. `Settings.tsx:380–387`'s `View readiness status` is an in-app URL, and it gets the mark too: the mark means "this opens a new tab", not "this leaves the site".

Export from `src/components/ui/index.ts`: `export { ExternalLink, type ExternalLinkProps } from './ExternalLink'`.

**All seventeen sites convert**, keeping their `className` and link text verbatim. Five are inside `AI_PROVIDER_SETUP`'s `guidance` nodes and so move into `providerSetup.tsx` (`Settings.tsx:54,56,75,94,115`, identical to `Onboarding.tsx:66,68,87,106,127`); one is the shared `keyUrl` link (`Settings.tsx:546–548`, `Onboarding.tsx:415–417`); the rest are the two Upstash console links (`Settings.tsx:646`, `Onboarding.tsx:503`), the two Upstash pricing links (`Settings.tsx:657`, `Onboarding.tsx:516`), and the readiness link (`Settings.tsx:380–387`).

**Nothing outside `Settings.tsx`, `Onboarding.tsx`, and `providerSetup.tsx` converts.** `Landing.tsx` and `self-host` links are same-tab and are not this slice's files.

## I9. Notice adoption in Settings and Onboarding

Slice H created `Notice` and deliberately left these four sites to whichever slice owns the file (H9, H's Deferred). Every conversion is mechanical and must render an identical class set:

| file:line | tone | eyebrow | other props |
|---|---|---|---|
| `Settings.tsx:431` | `neutral` | `Setup incomplete` | `className="mb-6"` |
| `Settings.tsx:667` | `error` | — | `className="mb-6"` |
| `Settings.tsx:695` | `error` | — | `id="account"`, `className="mt-8 py-4"` |
| `Onboarding.tsx:543` | `error` | — | `role="alert"`, `className="mb-4"` |

Notes:

- `Settings.tsx:695` is `px-4 py-4` today, one step taller than `Notice`'s `px-4 py-3`. `cn` is `twMerge(clsx(...))`, so a caller `py-4` wins cleanly; do not change the primitive. `id="account"` reaches the root `<div>` through `...props` — it is a fragment target and must survive.
- `Settings.tsx:431`'s eyebrow is already a bare `<Label>Setup incomplete</Label>`, which is exactly what `Notice` renders for a string eyebrow.
- `Onboarding.tsx:543`'s `role="alert"` sits on the wrapper today and passes through `...props`. Do not move it onto the inner `<p>`.
- The bodies keep their existing elements and classes; `Notice` injects no wrapper (Slice H, H2 contract 2). `Settings.tsx:431`'s `Finish setup` button moves inside the `Notice` unchanged, keeping its `mt-2`.
- **`Onboarding.tsx:293`'s `border border-ink-300 bg-paper-1 p-5 md:p-8` card is not this slice's business.** It is the same D7 pattern Slice H killed in `Login.tsx`, but the brief does not name it and no slice owns Onboarding's layout. Open question 3.

## I10. Rulings carried from Slice H

Slice H's Ruling 3 assigned both renames to this slice, "in the same diff as C1". Its Ruling on D9 put `/dashboard` in the rail as **Interviews**, which is what makes the two old strings wrong.

- **`Dashboard.tsx:177`** — `<h1>Interview Dashboard</h1>` becomes `<h1>Interviews</h1>`. Classes, the `{n} interview{s} collected` line beneath it, and the `Export All` control are untouched. `grep -rn "Interview Dashboard" tests/` returns nothing; `Dashboard.register.test.tsx` resolves nothing by that name. This is the only edit to `Dashboard.tsx` in this slice.
- **`InterviewDetail.tsx:153`** — `Back to Dashboard` becomes `Back to Interviews`. It sits in the not-found branch, which `slice-F-spec.md:193` kept under the rule "page navigation chrome dies; error-recovery actions survive". `grep -rn "Back to Dashboard" tests/` returns nothing.

Pluralization, in the files this slice owns:

- **`StudyDetail.tsx:388`** — `{study.interviewCount} interviews` becomes `{study.interviewCount} interview{study.interviewCount !== 1 ? 's' : ''}`, matching the `!== 1` precedent at `Dashboard.tsx:179` and `StudyList.tsx:186`. The surrounding text stays in one `<span>` with no extra element, so the node's `textContent` is still `2 interviews` and `research-workflow.spec.ts:78` and `:121` (`getByText('2 interviews'/'0 interviews', { exact: true })`) both hold.
- **`InterviewDetail.tsx:166`** — `{interview.transcript.length} messages` becomes `{interview.transcript.length} message{interview.transcript.length !== 1 ? 's' : ''}`. A one-turn record is reachable: a participant who answers the greeting and finishes early saves a two-message transcript, and the preview path can save one.
- **`StudyDetail.tsx:658`** keeps its `> 1` form. It renders only inside `study.interviewCount > 0`, so it is already correct, and editing it changes no rendered output.

`grep -rn '} interviews\|} messages\|} questions' src/components/` must return nothing after this slice.

## I11. Tests

### Must keep passing, unchanged

- **`tests/unit/Synthesis.register.test.tsx`** — the whole file. `:50` (`svg` count 0 across all four participant states) is why nothing in `SynthesisReading` may render an icon; `:68`, `:79`, `:90`, `:101` the four `level: 1` participant headings; `:114` `/was not added to the study data/i`; `:116–118` the legacy passage serif and unquoted; `:120` no `[aria-expanded]`; `:121` no `--evidence` in `innerHTML`; **`:122` `queryByText(/^Synthesized by/)` absent in preview mode** — the direct guard on I3.3.
- **`tests/unit/Synthesis.trace.test.tsx`** — the whole file. `:69–73`'s `assertNoTrace` across the four participant states; `:126–127` the `t.1` trigger and its `aria-expanded="true"` default; `:129` the quote; `:130` `Participant · turn 1`; **`:132` no footer and `:133` no `/read in full transcript/i` button** — the two direct guards on I2.3's optional prop and I3.3.
- **`tests/unit/Synthesis.completion.test.tsx`** — `:60–65` the participant success ladder including `queryByText('A bottom line')` absent and no `/export/i` button; `:76–83` the save-failure ladder and the second `saveCompletedInterview` call; `:92` `getByRole('heading', { name: 'Researcher preview analysis' })`; `:93–96` the preview reading, `A bottom line` as an exact text node, and `/export preview data/i`. Every call-count assertion in this file must pass untouched; if one moves, the extraction touched logic.
- **`tests/unit/Synthesis.lifecycle.test.tsx`** and **`tests/unit/Synthesis.sessionHeaders.test.tsx`** in full. Neither reads the reading, and both are on the Completion row of the AGENTS.md change map.
- **`tests/unit/StudyDetail.register.test.tsx`** — `:66`, `:107`, `:111`, `:142`, `:161` the five `getByRole('tab', …)` resolutions (already role-correct; `Tabs` must keep them unique and clickable); `:69–71` the three column headers; `:72` no measure-bearing ancestor on the table; `:74–93` the row buttons and the `ArrowDown`/`ArrowUp` clamp; `:105`, `:109`, `:113` `svg` count 0 on all three tabs; `:116–152` the Copy control and its single `aria-hidden` icon; `:163–165` the `role="switch"` reading `ENABLED`.
- **`tests/unit/StudyDetail.participantLinks.test.tsx`** — `:100–101` no page frame; **`:102` `getByRole('tablist', { name: 'Study sections' })` carries `grid-cols-3`**, the direct guard that `Tabs` forwards `className` and `label`; `:103` the summary group; `:105–106` the tab click reaching the interview row. Also `:60`, `:62`, `:65`, `:67`, `:75–80` on the link register, none of which this slice touches.
- **`tests/unit/InterviewDetail.trace.test.tsx`** — everything except the three tab clicks in I11's rewrite list. Specifically `:100–109` span fidelity, `:112–126` the toggle, `:128–137` the unlocatable passage, `:139–151` the legacy passage with no wine and no `t.N`, `:153–160` the empty-refs theme, `:162–169` the wrong-speaker ref, `:171–177` the out-of-range ref, and **`:179–191`** — `Read in full transcript` switches tabs, focuses `turn-2`, and leaves it ringed. That last one is the direct guard that `onTraceToTurn` and `Tabs` compose correctly.
- **`tests/unit/Dashboard.register.test.tsx`** and **`tests/unit/Dashboard.idColumn.test.tsx`** in full — the `h1` rename touches no assertion in either.
- **`tests/unit/ResearcherShell.test.tsx`** in full — Slice H already rewrote it for the rail, and this slice does not touch the shell.
- **`tests/unit/providerSetupCopy.test.tsx`** — `:91–96` the five Onboarding guide-trigger names; `:97`, `:102`, `:115` the guidance body strings; `:116` and `:136` and `:169` the no-embedded-prices guards; `:118–128` the validate-key request body and the enabled `Next`; `:131` the Upstash guidance sentence; `:142–147` the five Settings guide-trigger names; `:172–213` the full credential rotate-and-clear flow, including `:198–203`'s exact `save-credentials` body and `:212`'s `{ target: 'openrouter' }`. Everything except the ten link-name assertions listed below.
- **`tests/unit/Settings.tokens.test.tsx`** — `:47–55` each key input a direct sibling of its `Test` button (`providerInputId` must not change the DOM shape); `:57–68` the `Configured` / `: configured` announcement pair; `:70–76` the BYOS block carrying no `role="note"`.
- **`tests/unit/Onboarding.steps.test.tsx`** — `:36–42` and `:44–52` the silent progress line on both steps.
- **`tests/unit/ui.notice.test.tsx`**, **`tests/unit/ui.icon.test.tsx`**, **`tests/unit/ui.citation.test.tsx`**, **`tests/unit/evidence.test.ts`** in full. `SynthesisReading` consumes `Citation` and `resolveThemeEvidence` unchanged.
- **`tests/e2e/research-workflow.spec.ts`** — `:6–19` study creation; `:21–27` the conversation; `:38–45` link generation via `getByRole('tab', { name: 'Study settings' })`; `:47–75` both participant recovery paths; **`:78` `getByText('2 interviews', { exact: true })`** (the direct guard on I10's pluralization); `:79–81` the `Interviews` tab and the row buttons; `:83–93` both downloads and the provenance fields on the JSON; `:97–104` the aggregate run and the call-count ledger; `:113–119` the 375px preview-recovery path; **`:121` `getByText('0 interviews', { exact: true })`**.

### Rewritten by this slice, and why

1. **`tests/unit/InterviewDetail.reading.test.tsx:86`**, **`tests/unit/InterviewDetail.trace.test.tsx:92`** and **`:198`** — `getByRole('button', { name: 'Analysis' })` becomes `getByRole('tab', { name: 'Analysis' })`. An element with an explicit `role="tab"` no longer matches the `button` role, so C2 breaks these three by construction. Nothing else in either call changes.
2. **`tests/unit/InterviewDetail.reading.test.tsx:91–92`** — the footer assertion. `:92` currently requires `/^Synthesized by .+ · study rev .+ · .+ · receipt /`, which is exactly the clause D1 removes. Rewrite to assert the footer text starts `Synthesized by gemini-2.5-flash · study rev 3 · saved ` and that `footer.textContent` matches neither `/receipt/i` nor `/unsigned/i`. **Also drop `_receipt: 'a'.repeat(24)` from the fixture at `:56`** — `save/route.ts:138` makes a stored interview with a receipt unrepresentable, and a fixture that models an impossible record is how D1 survived review for a train. `:88–89` (the serif bottom line) and `:94` (`svg` count 0) stay.
3. **`tests/e2e/research-workflow.spec.ts:94`** — `getByRole('button', { name: 'Analysis', exact: true })` becomes `getByRole('tab', { name: 'Analysis', exact: true })`. Same cause as 1. `:95`'s `INSIGHT` assertion is unchanged.
4. **`tests/unit/providerSetupCopy.test.tsx:98, 103, 107, 111, 132, 149, 153, 157, 161, 165`** — ten `getByRole('link', { name: '…' })` calls whose `name` is a bare string, which Testing Library matches exactly. `ExternalLink` appends ` (opens in a new tab)` to every accessible name, so each becomes an anchored regex: `/^rate-limit documentation/`, `/^current pricing documentation/`, `/^API pricing/`, `/^privacy and ZDR documentation/`, `/^Redis pricing/`. The `toHaveAttribute('href', …)` half of every assertion is unchanged. **Add one assertion** to each of the two tests: the same link also matches `/opens in a new tab/`, so the sr-only string is pinned somewhere rather than merely tolerated.
5. **`tests/unit/Settings.tokens.test.tsx:78–82`** — `carries no decorative icons`, `svg` count 0. It passes unchanged today only because every provider guide is collapsed on first paint, so its guarantee is accidental. Rewrite as `marks external links and carries no other icons`: open one provider guide with `fireEvent.click(screen.getByRole('button', { name: 'OpenRouter setup guide' }))`, then assert every `svg` in the container has `aria-hidden="true"` and an ancestor matching `a, button`, and that the `svg` count equals the number of `a[target="_blank"]` in the container. Keep the legacy-class spirit by also asserting no `className` matches `/stone-|rounded-xl|rounded-full/`.
6. **`tests/unit/Onboarding.steps.test.tsx:54–81`** — `carries no decorative icons on the welcome, ai-keys, and done steps`. Same cause, same rewrite: keep the welcome-step and done-step `svg` count at 0 (neither renders a link), and on the ai-keys step open one guide and apply the aria-hidden-with-link-ancestor assertion. The whole navigation sequence at `:61–79` stays exactly as written — it is the only place the four-step flow is driven end to end.

### New, smallest realistic regressions

- **`tests/unit/ui.tabs.test.tsx`** — the tablist carries `role="tablist"` and the given `aria-label`; each tab carries `role="tab"`, `aria-selected`, an `aria-controls` that resolves to the rendered `tabpanel`, and `tabIndex` 0 on the selected tab and −1 on the rest; the panel carries `role="tabpanel"`, `tabIndex={0}`, and an `aria-labelledby` naming the selected tab; **`ArrowRight` moves focus without calling `onValueChange`** and `Enter` on the focused tab then calls it once with that id (manual activation); `ArrowRight` from the last tab wraps to the first and `ArrowLeft` from the first wraps to the last; `Home` and `End` reach the ends; a click calls `onValueChange` once; only the active panel's children are in the document; every tab carries `min-h-11`.
- **`tests/unit/SynthesisReading.test.tsx`** — with a two-theme synthesis: the five sections render in order with their headings verbatim and the sub-label reads `What their behavior revealed`; a verified ref renders a `Citation` trigger, and with `onTraceToTurn` supplied the note contains a `Read in full transcript` button that calls it with the ref's `turnIndex`, while without the prop no such button exists anywhere; a legacy `evidence` theme renders a serif unquoted passage with no trigger; `openNotes` with an explicit `false` collapses that one note and leaves its sibling open. Then `ProvenanceFooter` directly: `verb="saved"` with a full record produces `Synthesized by m · study rev 3 · saved Jan 1, 2026`; a missing `model` yields `unrecorded model`; a missing `studyRevision` yields `—`; `verb="generated"` with a `note` appends ` · ` and the note; no output ever matches `/receipt/i`.
- **`tests/unit/StudyDetail.aggregate.test.tsx`** — stub `POST /api/synthesis/aggregate` to return a fixture with two `commonThemes`, one `divergentViews` entry, and two `researchImplications`; click `Analyze All Interviews`; assert the five headings appear in document order (`Bottom line`, `Key Findings`, `Common Themes`, `Divergent Views`, `Research Implications`); assert `viewA` and `viewB` both render and neither element's `className` matches `/font-serif/`, while a `representativeQuotes` string's does; assert the footer reads `/^Synthesized by .+ · study rev 4 · generated .+ · not saved — regenerate to refresh$/` and matches neither `/receipt/i` nor `/unsigned/i`; assert that with `divergentViews: []` the `Divergent Views` heading is absent while `Research Implications` still renders. This is the only unit coverage B3 gets — `demoData.ts` seeds no aggregate.
- **`tests/unit/providerSetup.test.tsx`** — `AI_PROVIDER_SETUP` has the four ids in registry order; `providerInputId` produces all eight literal ids the two surfaces used before this slice (assert them as string literals, not as a template); the OpenRouter `guidance` renders `requests fail if those restrictions cannot be met` and no variant of it renders `a request fails`; the gemini `steps` are the three-step list; `initialProviderRecord` returns four independent values; `emptyValidationState` is `{ loading: false, valid: null, error: null }`; `ValidationBadge` renders the loading, valid, and invalid branches with the `sr-only` strings intact and renders nothing when `valid` is null.
- **`tests/unit/ui.externalLink.test.tsx`** — renders `target="_blank"` and `rel="noopener noreferrer"`; contains exactly one `svg` with `aria-hidden="true"`; the accessible name is the child text followed by ` (opens in a new tab)`; a caller `className` merges rather than replacing the layout classes; no `rel` or `target` prop from a caller can reach the element (a type-level guarantee, asserted by rendering with a spread and checking the attributes).
- **Extend `tests/unit/InterviewDetail.reading.test.tsx`** — a one-message interview renders `1 message` and the document contains no `1 messages`; the not-found branch (stub `getInterview` to resolve `null`) renders a control named `Back to Interviews` and none named `Back to Dashboard`.
- **Extend `tests/unit/StudyDetail.register.test.tsx`** — a study with `interviewCount: 1` renders `1 interview` in the header and the document contains no `1 interviews`.
- **Extend `tests/unit/Dashboard.register.test.tsx`** — `getByRole('heading', { level: 1, name: 'Interviews' })` resolves and the document contains no `Interview Dashboard`.
- **Extend `tests/e2e/research-workflow.spec.ts`** after `:99` — assert `Investigate when notes are written.` is visible (the fixture's single `researchImplications` entry, which is B3's only end-to-end proof) and that a `Divergent Views` heading is absent (the fixture's `divergentViews` is `[]`); assert the aggregate footer matches `/not saved — regenerate to refresh/` and that the page body contains no text matching `/receipt (eyJ|unsigned)/`.

Do not snapshot any component in this slice.

## I12. Verification

Focused gates first. `Synthesis.tsx` is on the Completion row of the AGENTS.md change map, and `InterviewDetail`, `StudyDetail`, `Dashboard`, `Settings`, and `Onboarding` are all on the Researcher UI row, so both rows run:

```bash
# Completion row — receipt, lifecycle, and save
npx vitest run tests/unit/Synthesis.completion.test.tsx tests/unit/Synthesis.lifecycle.test.tsx \
  tests/unit/Synthesis.register.test.tsx tests/unit/Synthesis.trace.test.tsx \
  tests/unit/Synthesis.sessionHeaders.test.tsx tests/unit/synthesisReceipt.test.ts \
  tests/unit/api.save.idempotent.test.ts tests/unit/api.save.evidenceRefs.test.ts

# Researcher UI row — the readings, the tabs, the provider module
npx vitest run tests/unit/InterviewDetail.reading.test.tsx tests/unit/InterviewDetail.trace.test.tsx \
  tests/unit/StudyDetail.register.test.tsx tests/unit/StudyDetail.participantLinks.test.tsx \
  tests/unit/StudyDetail.aggregate.test.tsx tests/unit/Dashboard.register.test.tsx \
  tests/unit/Dashboard.idColumn.test.tsx tests/unit/ResearcherShell.test.tsx \
  tests/unit/SynthesisReading.test.tsx tests/unit/ui.tabs.test.tsx tests/unit/ui.externalLink.test.tsx

# Provider surfaces
npx vitest run tests/unit/providerSetup.test.tsx tests/unit/providerSetupCopy.test.tsx \
  tests/unit/Settings.tokens.test.tsx tests/unit/Onboarding.steps.test.tsx \
  tests/unit/api.onboarding.lifecycle.test.ts tests/unit/api.account.delete.test.ts \
  tests/unit/credentialValidation.test.ts tests/unit/providerAvailability.test.ts

# Aggregate route and validation, since B3 renders two fields it produces
npx vitest run tests/unit/api.aggregate.revision.test.ts tests/unit/providerValidation.test.ts \
  tests/unit/api.followup.provenance.test.ts tests/unit/api.synthesis.telemetry.test.ts
```

Then the proportional full gate. The Completion row requires the browser journeys, and C2 changes tab semantics on two researcher routes:

```bash
npm run check
npm run test:e2e
```

Then the greps, each of which must return no output except where noted:

```bash
grep -rn "receipt\|unsigned" src/components/                  # no UI prints a receipt
grep -rn 'role="tab' src/components/ --include=*.tsx          # only src/components/ui/Tabs.tsx
grep -rn 'target="_blank"' src/                               # only src/components/ui/ExternalLink.tsx
grep -rn "Interview Dashboard\|Back to Dashboard" src/        # both renamed
grep -rn "} interviews\|} messages" src/components/           # pluralization fixed
grep -rn "a request fails" src/                               # one OpenRouter wording
grep -rn "AI_PROVIDER_SETUP\|emptyValidationState\|initialProviderRecord\|ValidationBadge" \
  src/components/Settings.tsx src/components/Onboarding.tsx   # imports only, no local declaration
grep -rn "font-serif\|var(--evidence)\|var(--disclosure)" src/components/SynthesisReading.tsx
grep -rn "resolveThemeEvidence\|@/types" src/components/ui/   # ui/ stays domain-free
```

Then by hand, at **375px** and 1280px:

- **`/synthesis` in preview** — the reading is pixel-for-pixel what it was before the extraction. Compare against a screenshot taken on `main`. No footer anywhere on the page. The citation note still opens on first paint and still has no `Read in full transcript` control.
- **`/dashboard/interview/<id>` → Analysis** — the footer reads `Synthesized by <model> · study rev N · saved <date>` with no receipt clause. Force the fallbacks by loading an interview record whose `aiModel` and `studyRevision` are absent and confirm `unrecorded model` and `—`. Open a citation, click `Read in full transcript`, and confirm the tab switches, the turn takes focus, and the wine ring draws.
- **The tab strips on both screens** — click each tab; then focus a tab and walk the strip with `ArrowLeft`/`ArrowRight`/`Home`/`End` and confirm the panel does **not** change until `Enter` or `Space`; confirm the ring wraps at both ends; confirm `Tab` from outside lands on the selected tab, not the first; confirm the panel itself is reachable with `Tab`. Check the same with VoiceOver rotor: the panel must be announced as belonging to the selected tab.
- **`/studies/<id>` → Overview → Analyze All Interviews** — the two new sections render below Common Themes in the specified order; the divergent views read in Public Sans and the representative quotes in Source Serif 4, and the difference is legible at 375px; the footer's `not saved — regenerate to refresh` is present. Reload the page and confirm the whole aggregate is gone, which is what the clause is warning about.
- **`/studies/<id>` header** — a one-interview study reads `1 interview`.
- **`/dashboard`** — the `h1` reads `Interviews` and matches the rail entry marked `aria-current`.
- **`/settings`** (hosted) — open each of the five setup guides and confirm every external link carries the mark inline on the baseline and is announced with `(opens in a new tab)`; the three notices are square ruled blocks; the delete-account block keeps its taller padding and is still reachable at `#account`. Then load the standalone branch and confirm `View readiness status` carries the mark.
- **`/onboarding`** — walk all four steps; the provider guide trigger still reads `How to get an OpenRouter API key`; the OpenRouter guidance now reads `requests fail`; the done-step error block is a ruled `Notice`.

Leave the dev server runnable for the orchestrator's screenshot pass.

## Hard constraints

- Files that may change: `src/components/SynthesisReading.tsx` (new), `src/components/providerSetup.tsx` (new), `src/components/ui/Tabs.tsx` (new), `src/components/ui/ExternalLink.tsx` (new), `src/components/ui/index.ts` (two exports), `src/components/Synthesis.tsx`, `src/components/InterviewDetail.tsx`, `src/components/StudyDetail.tsx`, `src/components/Dashboard.tsx` (the `h1` only), `src/components/Settings.tsx`, `src/components/Onboarding.tsx`, and the tests in I11. Nothing else.
- **No API route, `src/lib/`, `src/services/`, `src/store.ts`, `src/types.ts`, `proxy.ts`, or `auth.ts` change.** B1 is copy inside a footer component; B3 reads two fields that already exist, are already validated, and are already returned. If any change here seems to need a route edit, it is out of scope and belongs to Slice L or the Storage train.
- **`src/lib/prompts/synthesis.ts` and `src/lib/providerValidation.ts` are not edited.** The model already produces `divergentViews` and `researchImplications` and the validator already accepts them.
- **Do not read `quoteRefs`.** `AggregateTheme.quoteRefs` (`src/types.ts:351`) stays unread and `representativeQuotes` stays the only source for the aggregate's quotes. Aggregate citations are Slice L, and reaching for `Citation` here would ship a wine numeral over an unverified string.
- **Do not edit any existing primitive in `src/components/ui/`.** `Button`, `Label`, `Rule`, `Field`, `Coordinate`, `Verbatim`, `Turn`, `Citation`, `Disclosure`, `Page`, `Notice`, and `Icon` are frozen contracts. `Tabs` and `ExternalLink` are additions, not edits. If a call site cannot express something through them, style around it in the consumer and say so in the handback.
- **`Notice` renders no icon** (Slice H, H2 contract 1). `Settings.tokens.test.tsx` and `Onboarding.steps.test.tsx` both count `svg`s, and the only `svg`s either file may gain are `ExternalLink`'s marks inside links.
- Do not edit `eslint.config.mjs`, `tailwind.config.ts`, `src/app/globals.css`, or `src/app/layout.tsx`. This slice needs no new token, no keyframe, and no config change; if lint blocks a class, the class is wrong.
- Do not edit `src/components/InterviewChat.tsx`, `src/components/Consent.tsx`, `src/components/StudySetup.tsx`, `src/components/Export.tsx`, `src/components/StudyList.tsx`, `src/components/Login.tsx`, `src/components/DemoSimulation.tsx`, `src/components/Landing.tsx`, `src/components/PreviewBanner.tsx`, or anything in `src/components/shell/`.
- **The participant branch of `Synthesis.tsx` (`:195–267`) and its no-study branch (`:187–193`) are not touched.** Slice K rewrites it and rebases on this slice; a change here would collide.
- `generateJSON`, `generateTranscript`, `handleDownloadJSON`, and `handleDownloadTranscript` and every string they emit do not change by one character. They are file formats a researcher's tooling may already parse.
- No new dependency and no dependency removal. No `data-theme` wiring, no theme toggle.
- Do not commit; leave the working tree for review. npm only (`package-lock.json` authoritative), Node ≥ 24.19.

## Deferred, do not attempt

- **B2 aggregate citations (I2c) — Slice L.** The prompt change, the server-side resolution of `{ quote, interviewId, turnIndex }` against owned interview records, the wine numeral on `quoteRefs`, the `P02 · turn 12 · exploration` note, `Read in P02's transcript →`, and the aggregate telemetry counts. This slice builds the reading Slice L will edit; it must not pre-empt any of it.
- **Persisting aggregate synthesis (D8's real fix)** — the next Storage train, with its own spec and the Storage gates (decision of record 5). The footer clause this slice ships is the honest interim, not a placeholder to be softened.
- **A1, A2, A3 — Slice K.** The composer as the last block in document flow, the `viewport` meta decision, the receipt fact block, the consent `acceptedAt` echo, and killing the centered completion panel. Nothing here may pre-empt K's layout decisions.
- **C6 / F1 StudySetup decomposition, and D6/D7's StudySetup sites — Slice M**, which also adopts `Notice` in `StudySetup.tsx`'s six sites.
- **The `WithMargin` unfold (B4)** — struck by decision of record 4. `ui/Page.tsx:22–31` stays exported and unused.
- **The merged InterviewDetail single-surface reading** — Initiative 3's "not in this train" list. `Tabs` is what makes the two-panel shape honest until then; it is not a step toward keeping it.
- **Onboarding's bordered card (`Onboarding.tsx:293`)** — the same D7 pattern Slice H killed in `Login.tsx`, in a file this slice edits but whose layout no slice owns. Open question 3.
- **Night theme, participant transcript download, typeset export.**

## Rulings (Fable, 2026-09-05) — settled; the text above stands except where a ruling amends it

1. **Q1 — `What their behavior revealed`** on both surfaces, as specced.
2. **Q2 — manual activation**, as specced. The `tracedTurn` side effect decides it; revisit only on observed confusion.
3. **Q3 — delete the Onboarding card.** Amendment to I9 and the Hard constraints: `Onboarding.tsx:293`'s `border border-ink-300 bg-paper-1 p-5 md:p-8` wrapper is removed, mirroring Slice H's H6 treatment of `Login.tsx` — delete the wrapper, keep its children and their spacing, and structure with the existing `Rule` where the card edge did visual work (the spec author checks the step header/footer and inserts at most one `Rule`). `Onboarding.steps.test.tsx` walks by role and text and is unaffected; add one assertion to it that no element in the flow carries `bg-paper-1` with a `border` class (the "rules over boxes" guard).
4. **Q4 — as specced**, anchored regexes plus the two `/opens in a new tab/` pins.
5. **Q5 — mark it, do not retarget.**

## Open questions as originally drafted (for the record)

1. **The harmonized `Label` string.** `slice-F-spec.md:71` kept `What their behavior revealed` and `What behavior revealed` deliberately and called the merge "a copy decision, not a migration decision" for the owner. C1 makes deferring it impossible: the alternative to picking one is a `revealedLabel` prop whose only purpose is to keep the drift alive inside the component built to end it. This spec ships `What their behavior revealed` on both surfaces, for the parallel with `What they said` and because it names whose behaviour it was. No test pins either string. **Recommendation: as specced**; reverting is one word in one file, and the orchestrator's call is cheap either way.
2. **Manual versus automatic tab activation.** I6.1 argues manual on the strength of `switchTab`'s `tracedTurn` side effect and the size of the Study settings panel. The counter-argument is real: automatic activation is what most researchers will have met elsewhere, and a keyboard user who arrows to `Analysis` and does not press `Enter` sees nothing happen. If the orchestrator prefers automatic, the change is to call `onValueChange` from the arrow handler and to make `traceToTurn` re-set `tracedTurn` after the switch, which is one extra line. **Recommendation: ship manual**, and revisit if the researcher walkthrough surfaces confusion.
3. **`Onboarding.tsx:293`'s bordered card.** `<div className="border border-ink-300 bg-paper-1 p-5 md:p-8">` wraps every onboarding step and is the same "rules over boxes" violation (D7) that Slice H deleted from `Login.tsx` with a `Rule` in its place. The brief's D7 row names `InterviewChat`, `Consent`, `StudySetup:926`, and `Login`, not Onboarding, and no later slice owns this file — so left alone it becomes the last bordered card in the researcher workspace, in a file this slice is already opening. Deleting it is a four-line diff with no test exposure (`Onboarding.steps.test.tsx` walks the flow by role and text, never through the card). **Recommendation: delete it here**, mirroring H6, and ship as specced (card intact) unless the orchestrator says otherwise.
4. **The ten rewritten link-name assertions.** `ExternalLink` extends every external link's accessible name with ` (opens in a new tab)`, which is the correct behaviour and which breaks ten exact-string `getByRole('link', { name })` calls in `providerSetupCopy.test.tsx`. The rewrite to anchored regexes is mechanical, but it does weaken ten assertions from exact to prefix matching. The alternative — putting the hint in a `title` attribute instead of `sr-only` text — keeps the names exact and is what most sites do, and is also worse: `title` is unreliable on touch, inconsistently announced, and invisible to keyboard users. **Recommendation: as specced**, with the added `/opens in a new tab/` assertion on two of the ten so the string itself is still pinned.
5. **`Settings.tsx:380–387`'s readiness link.** It is `target="_blank"` to an in-app JSON endpoint, and I8 gives it the external mark like the other sixteen. An argument exists that the mark should mean "leaves this application" and that an in-app endpoint should therefore open in the same tab instead. Changing the target is a behaviour change on a fail-closed operator surface and is out of scope. **Recommendation: mark it, do not retarget it**; if the mark reads wrong there, the fix belongs with whoever revisits the standalone settings branch.
