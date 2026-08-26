# Slice F — The evidence surfaces (Initiative 1, depends on Slices A, C, D, E)

Re-registers `src/components/Synthesis.tsx`, `src/components/InterviewDetail.tsx`, `src/components/StudyDetail.tsx`, and `src/components/PreviewBanner.tsx` onto the Verbatim system. Context: `docs/design/DIRECTION-final.md` §7 "Researcher workspace" / "Participant (flagship)", §3 the two laws, amendments A1, A2, A4, A6, A8.

**Prerequisites, strictly ordered.** Slice A primitives exist in `src/components/ui/`. **Slice D must be accepted first** — it builds the reference implementation of the researcher trace grammar in `DemoSimulation`'s insight view (`slice-D-spec.md` §D6) and this slice reuses its idioms rather than inventing new ones. **Slice E must be accepted first** — it establishes the precedent for a component deleting its own page frame now that `ResearcherShell` owns it (`slice-E-spec.md` §E2 final bullet, §E4.1), and both slices edit `eslint.config.mjs`. The ordering is E → F → G and it is not negotiable: concurrent edits to `eslint.config.mjs` in the same working tree are forbidden.

**Prime directive: this is a re-registering of the surface, not a logic rewrite.** Every store read, effect, fetch, handler, ref, error branch, and disabled expression survives byte-for-byte in behavior. In `Synthesis` that means `doSave`, `handleRetrySave`, `handleRetryAnalysis`, `hasAttemptedAnalysis`, `retryTrigger`, `handleBack`, `handleExport`, the `participantState` ladder, and the single `useEffect` with its exact dependency array and its `eslint-disable-next-line react-hooks/exhaustive-deps` comment. In `InterviewDetail` that means `loadInterview`, `handleDownloadJSON`, `handleDownloadTranscript` (including every line of the generated markdown, character for character), `formatDuration`, and the `StudyOperationPendingError` branch. In `StudyDetail` that means `loadParticipantLinks`, `loadStudyData`, `runReconciliation`, `handleToggleLinksEnabled`, `handleGenerateLink`, `handleCopyLink`, `handleRevokeLink`, `handleGenerateAggregateSynthesis`, `handleGenerateFollowup`, `isStudyOperationPending`, `formatDate`, `formatDuration`, every `window.confirm` / `window.alert` call, the `expired` / `replaced` / `status` / `canRevoke` derivations, and both `useEffect`s. In `PreviewBanner` that means the `participantPages` array, the `isOnParticipantPage` gate, and `handleExit`. If a change is not named below, do not make it.

**This slice is the product's thesis made visible: interpretation sitting next to the words it came from.** It is also the slice where the interface must be most careful not to promise what the data cannot yet deliver — see F2, which is the section to read twice.

## F1. Laws that bind all four files

- **Tokens only.** `bg-paper-*`, `text-ink-*`, `border-ink-*`, `text-action`, `text-success`, `text-error`. Every `stone-*`, `amber-*`, `green-*`, `red-*`, `yellow-*`, `blue-*`, and `text-white` / `bg-white` class in these four files dies. No `dark:` variants, no `data-theme` reads or writes, no theme toggle.
- **Light only where the participant can see it (A6).** `Synthesis`'s `viewMode === 'participant'` branch and `PreviewBanner` render on the participant flow. They are light Paper with no toggle and no `prefers-color-scheme` read. The researcher branches are token-only for the same reason Slices C and E were: it keeps the later Night toggle cheap.
- **Apparatus-light for participants (A1).** The participant branch of `Synthesis` carries no turn numbers, no citation marks, no receipt hashes, no model ids. The researcher and preview branches carry all of it.
- **Serif is human speech, consent text, and interpretation prose.** Serif reaches these files exclusively through `Verbatim` and `Turn`. No file may contain a raw `font-serif` class — the ratchet enforces it once these files leave the allowlist. No serif buttons (DIRECTION §11).
- **Wine is evidence-trace, and in this slice nothing is traceable. See F2.** `Citation` is imported by **no file in this slice**, and no file in this slice may contain `var(--evidence`.
- **Ochre is disclosure-only, interruptive, and appears exactly once per screen (A8).** See F7.2 for the one-band rule.
- **No decorative icons (§6).** All four files must end with **no `lucide-react` import at all**. All four must end with **no `framer-motion` import**: every `motion.div` becomes a plain `div` and every `initial` / `animate` / `transition` prop is deleted. No spinners — `Loader2` is replaced by the text the surface already shows, or by a plain sentence. No skeletons (§10: a never-fabricate product does not draw fake content).
- **Radius discipline:** `0` for structure (sheets, sections, notice blocks, tables), `rounded` for controls only. Every `rounded-lg`, `rounded-xl`, `rounded-2xl`, and `rounded-full` in these four files dies, including the participant-access toggle's pill (F6.6) and every status chip.
- **Triage density (A2).** Reading measure applies to prose only — bottom lines, interpretation passages, section descriptions, empty-state copy. It **never** applies to a register table, a link list, a stats row, a form row, or a transcript. Nothing with a `<table>` or an `<input>` in it may carry `max-w-measure` or descend from a node that does.
- **No genre vocabulary in user-facing copy (A2).** No "colophon", "apparatus", "marginalia" — not in headings, labels, `aria-label`s, or comments that could migrate into copy.
- **Rules over boxes.** The `bg-stone-800/50 rounded-xl border border-stone-700 p-6` card is the dominant shape in all three researcher files and it dies everywhere. Sections are separated by `Rule` and identified by `Label` eyebrows or 15px semibold sans headings. Where a genuine sheet is wanted, it is `border border-ink-300 bg-paper-1 p-5 md:p-8`, radius 0, no shadow.

## F2. The wine question, decided: no citations ship in Slice F

This is the section the orchestrator should review the diff against most carefully, because getting it wrong makes the interface lie.

**Law 2 (DIRECTION §3): "Wine = evidence-trace. If wine appears, something is cited."** A citation is a pointer. `Citation` renders a wine numeral that a reader can activate to be shown *where* the words came from — a turn, in an interview, in this app. That contract is what makes the wine mean something.

**Nothing in Slice F can honour that contract, because the schema does not carry a pointer.**

- `SynthesisResult.themes[].evidence` is a bare `string` (`src/types.ts:171`). There is no `turnIndex`, no `interviewId`, no offset.
- `AggregateSynthesisResult.commonThemes[].representativeQuotes` is a bare `string[]` (`src/types.ts:322`). Same absence.
- Worse than absent: **the schema does not even promise these strings are speech.** The synthesis prompt asks the model for `"evidence": "Supporting quote/behavior"` (`src/lib/prompts/synthesis.ts:94`) and for `"representativeQuotes": ["Example evidence from different interviews"]` (`:161`). A given string may be a verbatim fragment or it may be the model's description of a behaviour. The record cannot tell them apart.

Adding the pointer is `EvidenceRef { quote, turnIndex, interviewId }` — DIRECTION §8, **Initiative 2**, together with the prompt change and the normalized-matching validator. **It is out of scope here, categorically.** This slice makes no change to `src/types.ts`, `src/store/**`, `src/services/**`, `src/lib/prompts/**`, or any API route.

Therefore, in Slice F:

1. **`Citation` is imported by no file.** No wine numeral, no wine left-rule, no `.trace-ring`, no `var(--evidence` anywhere in these four files. The ratchet enforces the last of these once they leave the allowlist (F9).
2. **A model-authored supporting string is rendered as the *supporting passage*** — the one idiom defined in F3.3. Serif (it is interpretation prose, which Law 1 puts in serif), indented behind an `ink-300` hairline, **without quotation marks, without wine, and without a coordinate line.**
3. **The quotation marks are omitted deliberately, and this is the part that is easy to get wrong.** Curly quotes assert "these are the participant's words." Slice D's demo can make that assertion because its strings are hand-written scripted speech with a known turn number (`slice-D-spec.md` §D6.6). A live `theme.evidence` string cannot. Dressing an unverified string in quotation marks is the same failure as dressing it in wine, one notch quieter, and DIRECTION §11's "no academic cosplay" guardrail is aimed at exactly this.
4. **Real coordinates do exist in this slice, and they get `Coordinate`, not `Citation`.** A transcript turn's index and timestamp (F5.4), an interview id, a study revision, a model id, a receipt hash (F3.4) are machine-verifiable facts about the record. Mono, tabular numerals, no wine. A coordinate is not a citation; it becomes one when a claim points at it.

When Initiative 2 lands, the supporting passage is the block that becomes a `Citation` note: the quotation marks, the wine hairline, and the `P07 · turn 12 · exploration` coordinate line arrive together, in one diff, because they are one promise. Do not pre-empt any part of it here.

## F3. The synthesis reading grammar (written once; F4 and F5 both consume it)

`Synthesis.tsx` and `InterviewDetail.tsx`'s Analysis tab render the same `SynthesisResult` shape today with near-identical markup and two deliberately different strings. **They must end this slice looking like the same page.** Extracting a shared component is a structural change and is deferred (see Deferred); the contract instead is that both files implement this section literally.

### F3.1 Bottom line

```tsx
<section>
  <Label className="block">Bottom line</Label>
  <Verbatim as="p" className="mt-3 max-w-measure text-[24px] font-normal leading-[36px] text-ink-900 md:text-[28px] md:leading-[40px]">
    {result.bottomLine}
  </Verbatim>
</section>
<Rule className="mt-8" />
```

This is the demo's D6.5 treatment, unchanged. **The eyebrow copy changes from `Key Insight` to `Bottom line`** — a named copy change, made because `BOTTOM LINE` is the label DIRECTION §7 specifies for the signature reading, the demo already ships it, and two names for one thing across two screens is the drift this migration exists to stop. The `rounded-xl bg-stone-700 p-6 text-white` slab and the `Target` icon die. No `uppercase tracking-wider` — `Label` owns the 11px/0.08em treatment.

### F3.2 Stated vs revealed

Two `<dl>`-shaped ruled registers, side by side on `md:` (`md:grid md:grid-cols-2 md:gap-10`), stacked below:

- Heading `Stated vs Revealed` verbatim, `font-sans text-[15px] font-semibold text-ink-900`. `TrendingUp` deleted.
- Sub-labels through `Label`: `What they said` verbatim, and then the file-specific string — **`What their behavior revealed` in `Synthesis.tsx`, `What behavior revealed` in `InterviewDetail.tsx`.** They differ today; keep each verbatim. Do not "harmonize" them; if the owner wants one string, that is a copy decision, not a migration decision.
- Each item becomes a ruled row, not a chip: `<li className="border-t border-ink-300 py-2 font-sans text-[15px] leading-[24px] text-ink-700">`. `bg-stone-800 … rounded-lg` and `bg-stone-700 … rounded-lg` both die. The visual distinction between stated and revealed comes from the two labelled groups, not from two fill colours.

### F3.3 Themes and the supporting passage

Heading `Key Themes` verbatim, `font-sans text-[15px] font-semibold text-ink-900`. `Lightbulb` deleted. The list becomes:

```tsx
<li className="border-t border-ink-300 py-4">
  <p className="font-sans text-[15px] font-medium text-ink-900">{theme.theme}</p>
  <Verbatim as="p" className="mt-2 max-w-measure border-l border-ink-300 pl-4 text-[17px] leading-[28px] text-ink-700">
    {theme.evidence}
  </Verbatim>
</li>
```

**That `Verbatim` block is the supporting passage, and it is the single most reviewable line in this slice.** Serif, one `ink-300` hairline, at measure. No quotation marks. No wine. No `Coordinate`. No `Citation`. See F2 for why. `theme.frequency` stays unrendered, exactly as today.

### F3.4 Contradictions, additional insights, and the provenance footer

- Contradictions block keeps its `synthesis.contradictions.length > 0` gate and its heading `Potential Contradictions` verbatim; `AlertTriangle` deleted; the card becomes `border-t border-ink-300 pt-5` with items as `font-sans text-[15px] leading-[24px] text-ink-700 max-w-measure`.
- `Additional Insights` heading verbatim; the `-` bullet span is deleted and the list becomes ruled rows (`border-t border-ink-300 py-2`), same type as F3.2's rows.
- **Provenance footer (DIRECTION §7).** `_receipt` exists on the record today and is never rendered; this is display of existing data, the same class of change Slice C blessed for `interview.aiModel` (`slice-C-spec.md` §C5). It ships on the two surfaces where all four facts are on the record, and **not** on `Synthesis.tsx` — see F4.4 for why.

```tsx
<footer className="mt-10 border-t border-ink-300 pt-4">
  <Coordinate className="block">
    {`Synthesized by ${model ?? 'unrecorded model'} · study rev ${revision ?? '—'} · ${formatDate(timestamp)} · receipt ${receipt ? receipt.slice(0, 12) : 'unsigned'}`}
  </Coordinate>
</footer>
```

Truncation to 12 characters is display only; nothing downstream reads the rendered string. Do not add a `title` tooltip, a copy button, or an expand affordance — those are features, not a reskin.

## F4. `Synthesis.tsx`

`/synthesis` is **not** inside the `(researcher)` route group, and `Synthesis` is also rendered by `src/app/p/[token]/page.tsx`. **It therefore keeps its own page frame in every branch** — this is the opposite of F5 and F6, and getting it backwards produces an unframed page on the participant flow. `PreviewBanner` renders above it from `src/app/layout.tsx` on `/synthesis`, but not on `/p/[token]`.

### F4.1 No-study branch

```tsx
<div className="flex min-h-dvh items-center justify-center bg-paper-0">
  <p className="font-sans text-[15px] text-ink-500">No study configured.</p>
</div>
```

Copy verbatim. This is the `Consent.tsx` no-study idiom, matched deliberately — the two screens bracket the participant flow.

### F4.2 Participant branch — the completion receipt (A1, A6)

The `participantState` ladder (`'analysis-failed' | 'save-failed' | 'saved' | 'finalizing'`) and every condition feeding it are copied character for character. Frame:

```tsx
<main className="min-h-dvh bg-paper-0 px-4 py-12 sm:px-8 sm:py-20">
  <div className="mx-auto max-w-measure space-y-6">
```

`text-center` dies in all four states — this flow reads left-aligned from consent onward. The `rounded-xl border border-stone-700 bg-stone-800/50 p-6 sm:p-10` card dies; the participant's last screen is a page, not a modal.

Headings are `<Verbatim as="h1" className="text-[28px] font-normal leading-[36px] text-ink-900">`, matching `Consent.tsx`'s study-name `h1` exactly. This is the one place in the researcher-adjacent files where a document heading is serif, and the reason is that it bookends the participant's document, not the researcher's workspace. (Contrast F4.3, which follows Slice D's rule that an `h1` naming a workspace is Public Sans 600.)

Per state, all copy verbatim:

| state | heading | body | roles kept | controls |
|---|---|---|---|---|
| `finalizing` | `Finalizing your interview` | `We are preparing and saving your responses. Keep this tab open until you see confirmation that it is safe to close.` | `role="status" aria-live="polite"` on the body | none |
| `saved` | `Interview submitted` | `Your responses have been saved. It is now safe to close this tab.` | `role="status" aria-live="polite"` on the body | none |
| `save-failed` | `We couldn&apos;t save your interview` | `Your responses are still in this tab. Keep it open and retry the save before closing.` | `role="alert"` on the body | `Back to interview`, `Retry save` |
| `analysis-failed` | `We couldn&apos;t finalize your interview` | `Your responses are still in this tab, but they have not been saved. Keep this tab open and try again.` | `role="alert"` on the body | `Back to interview`, `Retry finalization` |

Bodies are `font-sans text-[15px] leading-[24px] text-ink-700`. The two failure states get a `border-l-2 border-error bg-paper-2 px-4 py-3` ruled block around the body, per the Slice C/E notice idiom; the two success/pending states get no block.

Controls: `Back to interview` is `<Button variant="quiet">` with `onClick={handleBack}`; `Retry save` is `<Button variant="primary" disabled={isSaving}>` with `onClick={handleRetrySave}`; `Retry finalization` is `<Button variant="primary">` with `onClick={handleRetryAnalysis}`. All three labels verbatim. `RefreshCw`, `Loader2`, `CheckCircle`, `XCircle`, `AlertTriangle` and their coloured circles are deleted. The spinner in the `isSaving` state of `Retry save` is deleted; `Button`'s `disabled:opacity-50` carries it.

**Three hard constraints on this branch, each pinned by a test (see F10):** `A bottom line` must not appear; **no button whose accessible name matches `/export/i` may exist**; and the string `safe to close` must appear in the `saved` state and nowhere else.

### F4.3 Researcher and preview branch — the analysis reading

Frame: `<main className="min-h-dvh bg-paper-0">` wrapping `<Page className="py-10 md:py-14">`. `max-w-4xl mx-auto` and `p-4 sm:p-8` die (`Page` owns the frame).

Header:
- `<Label>Interview analysis</Label>` — new eyebrow copy, additive.
- `<h1 className="font-sans text-[24px] font-semibold leading-[32px] text-ink-900">{viewMode === 'preview' ? 'Researcher preview analysis' : 'Interview Analysis'}</h1>` — the expression is copied character for character; `Synthesis.completion.test.tsx:92` matches `Researcher preview analysis` as an exact heading name. Public Sans 600, per Slice D's decided rule for `h1`s that name a workspace document (`slice-D-spec.md` §D5.1).
- Subtitle `Patterns and insights from the conversation` verbatim, `font-sans text-[15px] leading-[24px] text-ink-700`. `ml-13` (a nonexistent Tailwind class) and the `BarChart3` tile die.
- Then `<Rule className="my-8" />`.

Analyzing state: no spinner, no card. `<p role="status" aria-live="polite" className="font-sans text-[15px] text-ink-500">` — but note the existing markup has **no live region here**; do not add one. Render `<h2 className="font-sans text-[18px] font-semibold text-ink-900">Analyzing Interview...</h2>` and `<p className="mt-2 font-sans text-[15px] text-ink-700">Looking for patterns, themes, and insights</p>`, both verbatim, both inside a plain `div`. The composing-bar idiom from Slice B is **not** reused here; this wait has no next question to set.

Save-status notices, all ruled blocks (`border-l-2 px-4 py-3 bg-paper-2`, `Label` eyebrow, 13px `text-ink-700` body), all conditions and copy verbatim:

| condition | border | eyebrow | body |
|---|---|---|---|
| `saveStatus === 'saved'` | `border-success` | `Saved` | `Interview saved successfully. View it in the researcher dashboard.` |
| `saveStatus === 'preview'` | `border-ink-500` | `Preview` | `Preview complete. This interview was not added to the study data.` |
| `saveStatus === 'failed'` | `border-error` | `Not saved` | `Could not save interview. You can still export locally below.` + the `Retry Save` control |
| `saveStatus === 'pending' && isSaving` | `border-ink-500` | `Saving` | `Saving interview...` |

**The `preview` row is `border-ink-500`, not ochre, and that is deliberate — see F7.2.** `Retry Save` (capital S, verbatim) becomes `<Button variant="quiet" disabled={isSaving} className="mt-2">`; icons deleted.

Body: F3.1 → F3.2 → F3.3 → F3.4's contradictions and insights, in that order, separated by `Rule`. No provenance footer (F4.4).

Action row, `flex flex-col gap-3 sm:flex-row`, both expressions copied character for character:
- `<Button variant="quiet" onClick={handleBack}>{viewMode === 'preview' ? 'Continue preview' : 'Continue Interview'}</Button>`
- `<Button variant="primary" onClick={handleExport}>{viewMode === 'preview' ? 'Export preview data' : 'Export Data'}</Button>` — `Synthesis.completion.test.tsx:95` matches `/export preview data/i` as a button name.

`ArrowLeft` and `ArrowRight` deleted; the words carry the affordance (`slice-D-spec.md` §D2.6).

Analysis-failed and no-data branches: no cards, no icon circles. `Analysis Failed`, `There was an error analyzing the interview. Please try again.`, `Back to Interview`, `Retry Analysis`, `No interview data to analyze yet.`, `Go to Interview` — all verbatim; headings `font-sans text-[18px] font-semibold text-ink-900`; controls `Button variant="quiet"` and `Button variant="primary"` respectively.

### F4.4 Why `Synthesis.tsx` gets no provenance footer

At this moment the interview record does not exist yet — `doSave` may still be in flight, may have failed, or may have been a preview that is never written. `SynthesisResult` carries only `_receipt` (`src/types.ts:175`); the model id and study revision live on `StoredInterview` (`:229`, `:233`), which is what `InterviewDetail` reads. Rendering `studyConfig.aiModel` here would be an inference about which model actually ran, not a fact from the record, and a provenance line that infers is worse than no provenance line. The footer therefore ships on `InterviewDetail` (F5.5) and `StudyDetail` (F6.5) only.

## F5. `InterviewDetail.tsx`

### F5.1 The shell owns the frame

`/dashboard/interview/[id]` is inside the `(researcher)` group and is wrapped by `ResearcherShell`, which already provides `min-h-dvh bg-paper-0`, a `<Page>` container, and the breadcrumb (`src/components/shell/ResearcherShell.tsx:112–116`). Delete:

- `min-h-screen bg-stone-900 p-8` and the `max-w-4xl mx-auto` inner div, in the main branch **and** in both early-return branches;
- the header's `Back to Dashboard` button and its `ArrowLeft` — the rail and the breadcrumb are the nav now (`slice-C-spec.md` §C4, `slice-E-spec.md` §E4.1).

**The not-found branch keeps its `Back to Dashboard` control.** The rule this slice applies, consistently, is: *page navigation chrome dies; error-recovery actions survive.* A researcher who has landed on a deleted interview id needs a way out that is about this failure, not a rail destination. It becomes `<Button variant="quiet" onClick={() => router.push('/dashboard')}>Back to Dashboard</Button>`, copy verbatim. The same rule keeps `StudyDetail`'s `Back to Studies` and `Reconcile` in F6.2.

Loading branch: `<p className="py-16 font-sans text-[15px] text-ink-500">Loading…</p>` — no spinner, no `min-h-*` (the shell already fills the viewport; adding one produces a second full-height column inside the shell's).

Not-found branch: `max-w-measure` block, `<h1 className="font-sans text-[24px] font-semibold leading-[32px] text-ink-900">` carrying the existing conditional expression (`Study change pending` / `Interview Not Found`) verbatim, body (`A study operation is already in progress.` / `This interview may have been deleted.`) verbatim at 15px `text-ink-700`.

### F5.2 Breadcrumb

Call `useSetTrailingCrumb(interview?.studyName ?? null)` at the top level of the component, importing from `@/components/shell/breadcrumb`. The `slice-C-spec.md` §C3 table expects `/dashboard/interview/<id>` to render `Studies / Interviews / <trailing ?? id.slice(0,8)>`; without this the crumb falls back to a mono id fragment. The hook must be called unconditionally (it is a hook), so pass `null` while loading — `useSetTrailingCrumb` already clears on unmount and on label change (`breadcrumb.tsx:29–37`).

### F5.3 Header and downloads

`<h1 className="font-sans text-[24px] font-semibold leading-[32px] text-ink-900">{interview.studyName}</h1>`. Meta line beneath, `flex flex-wrap items-center gap-x-4 gap-y-1`:

- `<Coordinate>{formatDuration(interview.createdAt, interview.completedAt)}</Coordinate>` — `formatDuration` unchanged, `Clock` deleted;
- `<span className="font-sans text-[13px] text-ink-500">{interview.transcript.length} messages</span>` — copy verbatim, `MessageSquare` deleted;
- `<Coordinate>` wrapping the existing `toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })` expression, copied character for character.

Download controls become `<Button variant="quiet" className="text-[13px]">`. **Named copy change:** the labels become `Download transcript` and `Download JSON` (from `Transcript` and `JSON`). Deleting the `Download` icon would otherwise leave a button whose entire accessible name is `Transcript`, sitting one block above a tab whose accessible name is also `Transcript` — an ambiguity the icon was hiding. Both handlers, both generated filenames, and every line of `handleDownloadTranscript`'s markdown output are unchanged.

### F5.4 Tabs and the transcript

The tab pair stays this slice — **the merged single-surface reading (transcript and analysis on one page, claims adjacent to turns) is Initiative 2 work** and is listed under Deferred. Restyle in place:

```tsx
<div className="mb-8 grid grid-cols-2 border-b border-ink-300">
  {/* per tab: min-h-11 border-b-2 px-2 py-3 text-center font-sans text-[15px] font-medium
      active:   border-action text-action
      inactive: border-transparent text-ink-500 hover:text-ink-900 */}
</div>
```

`Transcript` and `Analysis` verbatim; both remain plain `<button>`s with `setActiveTab` handlers. **Do not add `role="tablist"` / `role="tab"` here.** `StudyDetail` has those roles because two assertions pin them (F6.1); adding a partial ARIA tab pattern — roles without `aria-controls`, `tabpanel`, or arrow-key navigation — is worse for a screen-reader user than two plain buttons. Unifying both files behind one accessible `Tabs` primitive with roving tabindex is the deferred item that satisfies DIRECTION §7's "one Tabs implementation"; it is not this slice's work.

The transcript panel loses its card entirely (`bg-stone-800/50 rounded-xl border border-stone-700 p-6` dies) and becomes `<ol className="space-y-8">` — the transcript is the page, not a box inside it. Bubble geometry (`flex justify-end/justify-start`, `max-w-[80%]`, `rounded-2xl`, `rounded-br-md`, `rounded-bl-md`, `bg-stone-700`, `bg-stone-800`) is deleted outright, along with the `Bot` and `User` avatars. Each `<li key={i}>`:

```tsx
<li key={i}>
  <div className="flex items-baseline justify-between gap-3">
    <Label>{msg.role === 'ai' ? 'Interviewer' : 'Participant'}</Label>
    <Coordinate>{new Date(msg.timestamp).toLocaleTimeString()}</Coordinate>
  </div>
  <Turn
    speaker={msg.role === 'ai' ? 'interviewer' : 'participant'}
    turnIndex={i + 1}
    showCoordinate
    className="mt-1"
  >
    <div className="prose-verbatim">
      <ReactMarkdown>{msg.content}</ReactMarkdown>
    </div>
  </Turn>
</li>
```

Notes that are load-bearing:

- `msg.role` here is `'user' | 'ai'` (`src/types.ts`, `InterviewMessage`), **not** `'participant' | 'interviewer'`. The mapping above is required; `TurnProps['speaker']` will not accept the raw value and TypeScript will say so.
- `Interviewer` and `Participant` are the existing strings, kept verbatim.
- **`showCoordinate` is on, deliberately.** A1 forbids visible apparatus in the *live participant interview* (`InterviewChat`, Slice B). This is the researcher reading a completed record; the turn number is the thing Initiative 2's citations will point at, and Slice D made the same call for the demo's researcher-facing transcript (`slice-D-spec.md` §D5.3).
- `prose prose-sm max-w-none prose-invert` becomes `prose-verbatim`, the token-based block Slice B added to `globals.css` (`:150–168`) and which `InterviewChat.tsx:323` already uses. This is the last reference to the legacy `.prose` block, which dies in F8.

Analysis panel: F3.1 → F3.2 → F3.3 → F3.4 in order, reading from `interview.synthesis`, with the same `interview.synthesis ? … : …` gate and the empty message `No analysis available for this interview.` verbatim at 15px `text-ink-500`, no card.

### F5.5 Provenance footer

At the foot of the Analysis panel, when `interview.synthesis` exists, render F3.4's footer with `model = interview.aiModel`, `revision = interview.studyRevision`, `timestamp = interview.completedAt`, `receipt = interview.synthesis._receipt`. All four are already on `StoredInterview` (`src/types.ts:218–239`); three are optional and take the fallbacks named in F3.4. Format the timestamp with the same `toLocaleDateString('en-US', …)` options the header uses, so one screen does not print two date formats.

## F6. `StudyDetail.tsx`

### F6.1 The shell owns the frame, and one existing assertion must move

Delete `min-h-screen bg-stone-900 p-4 sm:p-8`, `max-w-5xl mx-auto`, the header's `Back to Studies` button and its `ArrowLeft`, and the `w-12 h-12 rounded-xl bg-stone-700` `BookOpen` tile — in the main branch and in the not-found branch's frame.

**`tests/unit/StudyDetail.participantLinks.test.tsx:90` asserts `heading.closest('.min-h-screen')).toHaveClass('p-4', 'sm:p-8')`.** That is a direct assertion on the page frame this slice is required to delete, and it is the one existing assertion in Slice F that must change. Replace it with the inverse guard, which is the thing actually worth protecting now:

```ts
expect(heading.closest('.min-h-screen')).toBeNull();
expect(heading.closest('.min-h-dvh')).toBeNull();
```

Change nothing else in that test file except as F10 specifies. Two assertions in the same test are **kept and must keep passing untouched**: `:91` requires the tablist to carry `grid-cols-3`, and `:92` requires the `Study summary` group to carry `grid-cols-1` and `sm:grid-cols-3`. Both class strings survive the reskin verbatim.

Call `useSetTrailingCrumb(study?.config.name ?? null)` (C3's `/studies/<id>` row).

### F6.2 Loading, not-found, and the pending notice

- Loading: `<p className="py-16 font-sans text-[15px] text-ink-500">Loading…</p>`, no spinner, no `min-h-*`.
- Not-found: `max-w-measure` block, no `AlertCircle`, no centring. All three heading strings verbatim (`Study change pending`, `Workspace unavailable`, `Study Not Found`) at `font-sans text-[18px] font-semibold text-ink-900`; all three bodies verbatim at 15px `text-ink-700` (including `The study you&apos;re looking for doesn&apos;t exist.` with its entities). `Reconcile` / `Reconciling…` keeps its `disabled={isReconciling}` and its handler as `Button variant="quiet"`; `Back to Studies` survives as `Button variant="quiet"` under F5.1's error-recovery rule.
- `operationPending` notice: the Slice C notice idiom — `border-l-2 border-error bg-paper-2 px-4 py-3`, `role="status"`, `Label` eyebrow `Pending reconciliation`, body `A study operation is already in progress.` verbatim, and the `Reconcile` `Button variant="quiet"` with `disabled={isReconciling}`. `AlertCircle` and `RefreshCw` deleted; the amber dies.

### F6.3 Header and tabs

`<h1 className="break-words font-sans text-[24px] font-semibold leading-[32px] text-ink-900">{study.config.name}</h1>` — `StudyDetail.participantLinks.test.tsx:89` matches it by name. Meta line, `flex flex-wrap items-center gap-x-4 gap-y-1`:

- `{study.interviewCount} interviews` verbatim, 13px `text-ink-500`; `Users` deleted.
- `Created {formatDate(study.createdAt)}` verbatim, wrapped in `Coordinate`; `Calendar` deleted.
- `Locked` / `Editable` verbatim as plain text — `text-ink-500` when locked, `text-success` when editable. `Lock`, `Unlock`, the `rounded-full` pill, and `bg-green-900/50` all die (`slice-C-spec.md` §C4's status rule).

Tabs: the `tabs` array survives with its `icon` key **deleted**; `BarChart3`, `Users`, and `Settings` go with it. Labels `Overview`, `Interviews`, `Study settings` verbatim. Keep `role="tablist"`, `aria-label="Study sections"`, `role="tab"`, and `aria-selected` exactly — `:91` and `:94` depend on them, and `:57–58` finds `Study settings` by text and clicks its closest `button`, so the label must remain a direct text child of the tab button. Styling matches F5.4's tab strip, with `grid grid-cols-3` (required by `:91`) instead of `grid-cols-2`.

### F6.4 Overview tab

- **Research question.** `Label` eyebrow `Research Question` verbatim (the `<h3>` becomes the eyebrow; `Sparkles` deleted), then `<p className="mt-2 max-w-measure font-sans text-[17px] leading-[28px] text-ink-900">{study.config.researchQuestion}</p>`. **Sans, not serif** — Law 1 puts speech, consent text, and interpretation prose in serif; a research question is the study's specification, and rendering it in the same face as the participant's words would blur exactly the distinction this design exists to draw. Then `<Rule className="my-8" />`.
- **Stats summary.** Keep `role="group" aria-label="Study summary"` and the classes `grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4` verbatim (`:92`). Each cell loses its card and becomes `border-t border-ink-300 py-4`, left-aligned: `<Coordinate className="block text-[28px] leading-[36px] text-ink-900">{n}</Coordinate>` (twMerge resolves `Coordinate`'s 12px/`ink-500` defaults in favour of the overrides) above `<Label className="mt-1 block">`. The three labels `Interviews`, `Core Questions`, `Topic Areas` are verbatim.

### F6.5 Aggregate analysis

Section heading `Aggregate Analysis` verbatim, `font-sans text-[15px] font-semibold text-ink-900`; `BarChart3` deleted. `Analyze All Interviews` / `Analyzing...` becomes `Button variant="primary"` with its `disabled={operationPending || isGeneratingAggregate || interviews.length < 2}` expression and both labels verbatim; `Sparkles` and `Loader2` deleted. The two guard sentences (`Need at least 2 interviews to generate aggregate analysis.` and `Click &quot;Analyze All Interviews&quot; to generate cross-interview insights.`) are verbatim at 13px `text-ink-500`.

When `aggregateSynthesis` exists:

1. **Bottom Line first, not second.** F3.1's treatment, reading `aggregateSynthesis.bottomLine`, with the eyebrow `Bottom line`. It currently sits below Key Findings in a `bg-stone-800 rounded-lg p-3` box; the box dies and the order flips, because DIRECTION §7 makes the bottom line the signature reading and burying it under a bullet list is what the redesign is correcting. Copy unchanged.
2. `Key Findings` heading verbatim; the `•` span dies; items become ruled rows (`border-t border-ink-300 py-2`, 15px `text-ink-700`, `max-w-measure`).
3. **Common themes — the one additive change in Slice F.** `AggregateSynthesisResult.commonThemes` (`src/types.ts:322`) is populated today and has never been rendered. Render it with F3.3's grammar: theme name in 15px medium `ink-900`, then each string in `representativeQuotes` as a **supporting passage** — serif, `ink-300` hairline, no quotation marks, no wine, no coordinate. Read F2 before writing this block; it is the exact place the temptation to reach for `Citation` is strongest and the exact place the data cannot support it. `divergentViews` and `researchImplications` stay unrendered, as today.
4. `Create Follow-up Study` / `Generating...` becomes `Button variant="quiet"` with its `disabled` expression and handler verbatim; `GitBranch` and `Loader2` deleted. Its explanation sentence verbatim at 13px `text-ink-500`.
5. F3.4's provenance footer, with `model = aggregateSynthesis.aiModel`, `revision = aggregateSynthesis.studyRevision`, `timestamp = aggregateSynthesis.generatedAt`, `receipt = aggregateSynthesis._receipt` — all four on the type (`src/types.ts:313–328`), three of them non-optional.

### F6.6 Interviews tab — a register table

Same wrapper, markup, header styling, row styling, and `data-row-primary` keyboard contract as `slice-C-spec.md` §C4/§C5. Wrapper `<div className="overflow-x-auto">`, **never** `max-w-measure` and never a measure-bearing ancestor. `<table className="w-full border-collapse text-left">`; `<thead>` row `border-b border-ink-300`; each `<th scope="col" className="px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500">`; `<tbody>` rows `border-b border-ink-200 hover:bg-paper-1`, cells `px-3 py-3 align-top text-[13px] text-ink-700`.

| # | header | cell content | responsive |
|---|---|---|---|
| 1 | `ID` | `Coordinate`, `interview.id.slice(0, 8)` | always |
| 2 | `Participant` | row primary button + insight second line | always |
| 3 | `Started` | `Coordinate`, `formatDate(interview.createdAt)` | `hidden sm:table-cell` |
| 4 | `Duration` | `Coordinate`, `formatDuration(interview.createdAt, interview.completedAt)` | `hidden md:table-cell` |
| 5 | `Turns` | `Coordinate`, `interview.transcript.length` | `hidden md:table-cell` |

- **Row primary control:** `<button type="button" data-row-primary aria-label={\`View interview ${index + 1}\`}>`, styled `font-sans text-[14px] font-medium text-ink-900 text-left hover:text-action hover:underline underline-offset-2`, with the existing push verbatim: ``router.push(`/dashboard/interview/${interview.id}?studyId=${encodeURIComponent(studyId)}`)``. Its visible text is the existing extracted-fields join — `fields.filter(f => f.status === 'extracted' && f.value).slice(0, 3).map(f => f.value).join(' • ')`, pipeline copied verbatim — falling back to `Interview {index + 1}` when the join is empty, so the control is never a blank target for pointer users.
  **The `aria-label` string is exact and load-bearing:** `StudyDetail.participantLinks.test.tsx:95` does `getByRole('button', { name: 'View interview 1' })` with an exact match. The separate `Eye` button that carries that label today is deleted and its label moves here — the row is the target now (`slice-C-spec.md` §C5 deleted the equivalent per-row `Eye`).
- Second line in cell 2: `interview.synthesis?.bottomLine` when present, `line-clamp-1 text-[13px] text-ink-500`. The boxed `Lightbulb` callout dies; the insight stays visible.
- `<tr>` keeps an `onClick` with the same push for pointer convenience; no `role`, no `tabIndex` — the button is the accessible target.
- Keyboard navigation: `<tbody onKeyDown>` collecting `[data-row-primary]` buttons and moving focus one step on `ArrowDown` / `ArrowUp`, clamped, `preventDefault()`. Identical to C4; no roving tabindex, no `role="grid"`, no Home/End.
- Empty state: no icon circle, no card, `max-w-measure`. `No Interviews Yet` at `font-sans text-[18px] font-semibold text-ink-900` and `Share the participant link to start collecting interviews.` at 15px `text-ink-700`, both verbatim. `Users` deleted.

### F6.7 Study settings tab

- **`study.interviewCount > 0` notice** — a neutral caution, so `border-l-2 border-ink-500 bg-paper-2 px-4 py-3`. Eyebrow keeps the existing expression `{study.interviewCount} interview{study.interviewCount > 1 ? 's' : ''} collected` verbatim; body `This study has collected data. Editing is allowed but may affect consistency with existing responses.` verbatim. `AlertCircle` deleted; the amber dies.
- **Study config display** — the card becomes a ruled definition register: `<dl className="divide-y divide-ink-300 border-t border-ink-300">` with each row `grid grid-cols-1 gap-1 py-4 md:grid-cols-[12rem_1fr] md:gap-6`. The six `<label>` elements become `<dt>` with `Label` typography — they label nothing focusable and a bare `<label>` with no control is invalid; the six strings (`Study Name`, `Description`, `Research Question`, `Core Questions ({n})`, `Topic Areas ({n})`, `AI Interview Style`) are verbatim, count expressions included. Values are `<dd className="font-sans text-[15px] leading-[24px] text-ink-900">`; `No description` and the `capitalize` class on `aiBehavior` survive verbatim. Core questions keep their `pl-4 border-l-2` indent with `border-ink-300`. Topic areas lose `rounded-full bg-stone-700` and become a comma-free ruled inline list: `<li className="border-t border-ink-300 py-1.5 text-[15px] text-ink-700">` per topic.
- **Link management.** Heading `Link Management` verbatim (`LinkIcon` deleted). The participant-access row becomes `border-y border-ink-300 py-4 flex … justify-between`; `Participant Access` and both branches of the status sentence are verbatim, and `id="participant-access-status"` stays on the sentence.
  The toggle **keeps `type="button"`, `role="switch"`, `aria-label="Participant access"`, `aria-checked`, `aria-describedby="participant-access-status"`, its handler, and its `disabled` expression byte-for-byte** (`:61` asserts the role, the name, and `aria-checked="true"`). Only the visual changes: the `w-14 h-7 rounded-full` track, the `bg-white` knob, and `bg-green-600` all die, replaced by the Slice E toggle idiom (`slice-E-spec.md` §E3.5) — a bordered mono word, `<Coordinate className="rounded border px-2 py-1">` reading `ENABLED` when on (`border-ink-500 text-ink-900`) and `DISABLED` when off (`border-ink-300 text-ink-500`), with `min-h-11` on the button.
  The `linkExpiration` sentence is verbatim (`Clock` deleted), 13px `text-ink-500`. The `!linksEnabled` warning becomes a ruled block with `border-error` — it is a hard warning, not a preview or consent disclosure, so it is **not** ochre (F7.2); copy verbatim.
- **Generated links.** `Generated links` and `Only dates and status are retained here. Link URLs cannot be viewed again after creation.` verbatim (`:62` matches the second). The refresh control keeps `aria-label="Refresh participant links"` and `disabled={linksLoading}` verbatim, drops `RefreshCw`, and becomes a text button reading `Refresh` (`font-sans text-[13px] text-ink-500 hover:text-ink-900`, `min-h-11`) — the accessible name stays the `aria-label`.
  The three states keep their conditions and copy: `linksError` → ruled block `border-error` with the message and a `Retry` text button (handler verbatim); `linksLoading` → `Loading generated links…` verbatim at 13px `text-ink-500`, `Loader2` deleted; empty → `No generated links for this study yet.` verbatim.
  Each link row becomes a ruled register row (`border-t border-ink-300 py-3`), not a card. `Created {formatDate(link.createdAt)}` verbatim; the `status` derivation and all five status strings (`Revoked`, `Expired`, `Replaced by study edit`, `Active`, `Globally disabled`) verbatim — `:60` and `:67` match `Active` and `Revoked` as exact text, so each must be its own text node. Status renders as plain text: `text-success` for `Active`, `text-ink-500` otherwise; the `rounded-full` chip dies. The expiry/revision line stays verbatim inside `Coordinate`. `Revoke` keeps its `aria-label={\`Revoke participant link created ${formatDate(link.createdAt)}\`}` verbatim (`:65` matches `/revoke participant link created/i`), its `disabled` expression verbatim, and becomes a text button `font-sans text-[13px] text-error hover:text-ink-900 disabled:opacity-40`, `min-h-11`; `Trash2` and `Loader2` deleted.
- **Participant link generator.** Heading `Participant Link` verbatim. `Generate New Link` becomes `Button variant="primary"` with its `disabled` expression verbatim; icons deleted. The generated-link row keeps its `readOnly` input (restyled with `Field`'s control classes plus `font-mono text-[13px] flex-1 min-w-0` — **do not route it through `Field`**, `:63` asserts `queryByDisplayValue(/\/p\//)` is absent before generation and the row's shape is a copy pair, not a labelled field) and its `Copy` / `Copied!` button as `Button variant="quiet"`, both labels verbatim, `Copy` and `Check` deleted. The `Copy this link now. For security, its URL cannot be recovered from the generated-links list.` sentence is a hard warning: ruled block, `border-error`, copy verbatim; the amber dies. The trailing explanation sentence and its conditional tail are verbatim at 13px `text-ink-500`.

## F7. `PreviewBanner.tsx`

### F7.1 The band

`PreviewBanner` belongs to this slice rather than to G because it is the honesty chrome for exactly the flow `Synthesis`'s preview branch lives in, and its A8 weight has to be judged against that branch, not in isolation. It is rendered globally from `src/app/layout.tsx:44`; **do not move it, and do not touch `layout.tsx` — that is Slice G's file.**

The `participantPages` array, `isOnParticipantPage`, the `viewMode !== 'preview' || !isOnParticipantPage` early return, and `handleExit` are unchanged. The render becomes:

```tsx
<Disclosure title="Preview Mode - Participant View" className="sticky top-0 z-50 flex items-center justify-between gap-3">
  <button
    type="button"
    onClick={handleExit}
    className="min-h-11 shrink-0 font-sans text-[13px] font-medium underline underline-offset-4"
  >
    Exit Preview
  </button>
</Disclosure>
```

Both strings verbatim — `PreviewBanner.test.tsx:37` matches `Preview Mode - Participant View` as exact text (the hyphen is a plain ASCII hyphen surrounded by spaces; do not "fix" it to an en dash) and `:51` matches `Exit Preview` as an exact button name. `Eye` and `ArrowLeft` are deleted. The exit button carries **no colour class**, so it inherits `--disclosure-ink` from the primitive (`slice-D-spec.md` §D3.3 set this precedent). `.preview-banner`, `.preview-banner-pulse`, and every `stone-*` class in the file die; the shimmer gradient and the pulse are on DIRECTION §10's kill list by name.

`Disclosure` passes `title` through a leading `<strong>` and spreads unknown props onto its root, so `className` merges via `cn` and the sticky positioning lands correctly. `title` here carries the whole message and `children` carries only the control; that is legal and keeps `getByText` unambiguous, because `getNodeText` reads only direct text-node children.

### F7.2 The one-band rule (A8), stated once for F and G

**On any single screen, ochre appears once.** `PreviewBanner` renders on `/consent`, `/interview`, `/synthesis`, and `/export` whenever `viewMode === 'preview'` — which means it is already on screen, at the top, filled, when `Synthesis`'s preview save-status notice renders (F4.3) and when `Export`'s preview subtitle renders (Slice G). A second filled ochre band beneath the first does not double the interruption; it trains the eye to skip both, which is the A8 failure mode inverted.

So: **the page-level `PreviewBanner` owns the ochre for the entire preview flow, and per-screen preview notices are neutral ruled blocks** (`border-l-2 border-ink-500 bg-paper-2`). This is why F4.3's `saveStatus === 'preview'` row is `border-ink-500`, and Slice G applies the same rule to `Export`. Ochre still appears at full interruptive weight where nothing else carries it: the demo's page band and insight disclosure (Slice D), and the consent provider-unavailability notice (Slice B).

Ochre appears in Slice F **exactly once**: `PreviewBanner`. No other file in this slice may import `Disclosure`.

## F8. `globals.css` — two grep-gated deletions and one stale comment

Re-run these greps before editing and report the results in the handback. If either returns a hit outside the file this slice migrates, **do not delete that block** and say so.

```bash
grep -rn "\bprose\b" src/ --include='*.tsx' --include='*.ts' | grep -v prose-verbatim
grep -rn "preview-banner" src/
```

At spec time the only hits are `src/components/InterviewDetail.tsx:293` (`prose prose-sm max-w-none prose-invert`) and `src/components/PreviewBanner.tsx:28` and `:30` — all three inside files this slice rewrites. Slice D was explicitly forbidden from deleting these for exactly this reason (`slice-D-spec.md` §D6.1); F is the slice that inherits them.

**Delete:**

- the `/* Prose styling for markdown */` block and all five `.prose` rules (`globals.css:83–104`). Its colours are `#e7e5e4` and `#fafaf9` — dark-palette hexes that would render near-white text on paper. `.prose-verbatim` (`:150–168`) is its token-based replacement and already exists.
- the `/* Preview mode banner */` block: `.preview-banner`, `.preview-banner-pulse`, `@keyframes shimmer`, and `@keyframes pulse` (`globals.css:62–81`). Verify `pulse` and `shimmer` have no other consumer before deleting the keyframes (`grep -rn "animate-\[\?pulse\|shimmer" src/`); Tailwind's own `animate-pulse` uses its own keyframe name and is unaffected, but check rather than assume.

**Edit:** the `.prose-verbatim` comment at `:150–151` currently reads "token-based sibling of the legacy `.prose` block above (kept as-is for the demo until Slice D)". Both halves are now false. Replace with:

```css
  /* Transcript markdown — src/components/InterviewChat.tsx, src/components/InterviewDetail.tsx */
```

Anything else in `globals.css` is out of scope for Slice F. In particular **do not touch the `::-webkit-scrollbar` block** — it belongs to Slice G, which is where the last dark surface disappears.

## F9. Ratchet (`eslint.config.mjs`)

- Remove `'src/components/Synthesis.tsx'`, `'src/components/InterviewDetail.tsx'`, `'src/components/StudyDetail.tsx'`, and `'src/components/PreviewBanner.tsx'` from `legacyDesignAllowlist`. All four must then pass clean under `--max-warnings=0`.
- Make no other allowlist edits and no rule edits. Four lines, so the diff is trivially reviewable.
- Assuming Slices C, D, and E have landed, the allowlist after this slice holds **seven** entries and no more: `src/components/Export.tsx`, `src/components/Login.tsx`, `src/components/OAuthLogin.tsx`, `src/app/layout.tsx`, `src/app/self-host/page.tsx`, `src/app/**/setup/page.tsx`, and `src/app/p/\\[token\\]/page.tsx`. Report the actual post-slice list in the handback; do not "tidy" it. Slice G empties it.

## F10. Tests

### Must keep passing, ideally untouched

- **`tests/unit/Synthesis.completion.test.tsx`** — load-bearing, in the order it uses them: `getByText('Finalizing your interview')` present on first paint; `findByText('Interview submitted')`; `getByText(/it is now safe to close this tab/i)`; `queryByText('A bottom line')` **absent** in participant mode; `queryByRole('button', { name: /export/i })` **absent** in participant mode; `findByText("We couldn't save your interview")` (the source writes `&apos;`, which renders as U+0027 — keep the entity, do not substitute a typographic apostrophe); `getByText(/keep it open and retry/i)`; `queryByText(/safe to close/i)` absent in the failure state; `getByRole('button', { name: /retry save/i })`; `getByRole('heading', { name: 'Researcher preview analysis' })` as an **exact, level-agnostic** name; `findByText(/was not added to the study data/i)`; `getByText('A bottom line')` as an exact text node; `getByRole('button', { name: /export preview data/i })`. Every `saveCompletedInterview` call-count assertion must pass unchanged — if one moves, the reskin touched logic and the fix is to revert that, not to edit the test.
- **`tests/unit/Synthesis.sessionHeaders.test.tsx`** — asserts the exact argument tuples passed to `synthesizeInterview` and `saveCompletedInterview`, including the `participantSessionHandle`. It does not read markup at all; if it breaks, the effect or `doSave` was edited.
- **`tests/unit/PreviewBanner.test.tsx`** — load-bearing: `queryByText(/Preview Mode/i)` absent when `viewMode === 'participant'` and when `pathname === '/setup'`; `getByText('Preview Mode - Participant View')` as **exact** text; `getByRole('button', { name: 'Exit Preview' })` as an **exact** name; and the three store assertions after the click (`viewMode === 'researcher'`, `participantSessionHandle === null`, `router.push('/setup')`).

### Must keep passing, with exactly one assertion changed

- **`tests/unit/StudyDetail.participantLinks.test.tsx`** — change only `:90`, per F6.1. Everything else is load-bearing and stays: `:57–58` `findByText('Study settings')` then `.closest('button')`; `:60` `findByText('Active')`; `:61` `getByRole('switch', { name: 'Participant access' })` with `aria-checked="true"`; `:62` `getByText(/link urls cannot be viewed again/i)`; `:63` `queryByDisplayValue(/\/p\//)` absent; `:65` `getByRole('button', { name: /revoke participant link created/i })`; `:67` `getByText('Revoked')`; `:69–70` the DELETE body being exactly `JSON.stringify({ linkId })`; `:89` `findByRole('heading', { name: 'Managed Links Study' })`; `:91` the tablist carrying `grid-cols-3`; `:92` the `Study summary` group carrying `grid-cols-1` and `sm:grid-cols-3`; `:94` `getByRole('tab', { name: 'Interviews' })`; `:95` `findByRole('button', { name: 'View interview 1' })` as an **exact** name.

Where an existing test must change, change only the structural query and preserve every behavioural assertion. If `getByText` becomes ambiguous because a string now appears twice, fix it by removing the duplication in the component, not by loosening the query, and note it in the handback.

### New, smallest realistic regressions

- **`tests/unit/Synthesis.register.test.tsx`**
  - in participant mode, `container.querySelectorAll('svg')` has length `0` in all four states, and no element carries a class matching `/stone-/`;
  - in participant mode the completion heading is a level-1 heading and there is **no** element with `role="note"` (the participant's last screen carries no ochre);
  - in preview mode the theme's supporting passage renders `Some evidence` (the fixture string) inside an element carrying `font-serif`, and that element's text content contains **no `"` or `“` character** — the direct guard on F2;
  - in preview mode `container.querySelector('[aria-expanded]')` is `null` (no `Citation` shipped) and the rendered HTML contains no occurrence of `--evidence`;
  - in preview mode there is no provenance footer: no text matching `/^Synthesized by/`.
- **`tests/unit/InterviewDetail.reading.test.tsx`** (mock `@/services/storageService`'s `getInterview` with a fixture carrying two transcript messages, `aiModel`, `studyRevision`, and a synthesis with `_receipt`)
  - the transcript renders both turns with visible mono coordinates `t. 1` and `t. 2`, and the participant turn's text sits inside an element carrying `font-serif` while the interviewer turn's does not;
  - switching to the Analysis tab renders the bottom line inside a `font-serif` element and renders a provenance line matching `/^Synthesized by .+ · study rev .+ · .+ · receipt /`;
  - `container.querySelectorAll('svg')` has length `0` on both tabs;
  - no ancestor of the transcript list carries `max-w-measure` (walk `parentElement` to `document.body` and assert the class is absent on every node);
  - the component renders no element with `min-h-screen` or `min-h-dvh` (the shell owns the frame).
- **`tests/unit/StudyDetail.register.test.tsx`**
  - with two interviews on the Interviews tab: `getByRole('table')` exists; column headers `ID`, `Participant`, `Started` are present; `ArrowDown` on a focused row button moves focus to the next row's button and `ArrowUp` moves back, without wrapping past the ends; the row button's click calls `router.push` with the interview path **including the encoded `studyId`**; no ancestor of the table carries `max-w-measure`;
  - `container.querySelectorAll('svg')` has length `0` on all three tabs;
  - the participant-access control still resolves as `getByRole('switch', { name: 'Participant access' })` and its visible text reads `ENABLED` when `linksEnabled` is true.

Do not snapshot any of the four components.

## F11. Verification

```bash
npm run lint && npm run typecheck && npm run test
DEPLOYMENT_MODE=standalone npm run build
npm run test:e2e
```

Then, before handing back:

- **The wine audit (F2).** `grep -rn "Citation\|--evidence\|trace-ring" src/components/Synthesis.tsx src/components/InterviewDetail.tsx src/components/StudyDetail.tsx src/components/PreviewBanner.tsx` must return nothing. Then load `/dashboard/interview/<id>` with a synthesised interview and confirm by eye that no wine is on screen and that every serif passage that is *not* a transcript turn carries no quotation marks.
- **The one-band audit (F7.2).** Enter preview from `/setup`, walk to `/synthesis`, and confirm exactly one filled ochre band is visible, at the top, and that the preview save-status notice below it is a neutral ruled block.
- **Frame audit.** Load `/studies/<id>` and `/dashboard/interview/<id>` behind the shell and confirm neither draws a second page frame, a second back-nav, or a doubled horizontal inset; confirm the breadcrumb's trailing crumb reads the study name on both, not a mono id fragment.
- **Participant audit.** Load `/synthesis` with `viewMode === 'participant'` and confirm warm paper, no rail, no turn numbers, no receipt hash, no model id, and no ochre.
- 375 / 1024 / 1440 visual pass on `/synthesis`, `/studies/<id>` (all three tabs), and `/dashboard/interview/<id>` (both tabs). At 375 confirm the two register tables scroll inside their own `overflow-x-auto` container and the page body does not scroll horizontally.

Leave the dev server runnable for the orchestrator's screenshots.

## Hard constraints

- Files that may change: `src/components/Synthesis.tsx`, `src/components/InterviewDetail.tsx`, `src/components/StudyDetail.tsx`, `src/components/PreviewBanner.tsx`, `src/app/globals.css` (only the deletions and the one comment in F8), `eslint.config.mjs` (four lines, per F9), and the tests in F10. Nothing else.
- **No type, store, service, prompt, or API change.** `src/types.ts`, `src/store/**`, `src/services/**`, `src/lib/prompts/**`, `src/lib/participantLinks.ts`, `src/proxy.ts`, and `src/lib/researcherAccess.ts` are untouched. `EvidenceRef` is Initiative 2 and does not begin here.
- Do not touch `src/app/layout.tsx`, any `page.tsx`, `src/components/shell/**`, or anything under `src/components/ui/` (frozen contracts). If a primitive genuinely cannot express something here, style around it in the component and record why in the handback; do not edit the primitive.
- No new dependencies. No `framer-motion` and no `lucide-react` in any file this slice writes. `react-markdown` stays (it is already a dependency and `InterviewDetail` keeps using it).
- No `data-theme` wiring and no theme toggle; light Paper only, tokens only (A6).
- Do not commit; leave the working tree for review. `docs/` is untracked — leave it. npm only (`package-lock.json` authoritative), Node ≥ 24.19.

## Deferred, do not attempt

- **Initiative 2 in all its parts**: `EvidenceRef { quote, turnIndex, interviewId }` replacing free-text `evidence` (`src/types.ts:171`), the synthesis prompt change, normalized-match validation, and the trace UI on real data. F2 is the whole reason this slice ships no citations.
- **The merged `InterviewDetail` reading** — transcript and analysis on one surface, with claims adjacent to the turns they cite, reusing the canonical trace primitive (DIRECTION §7 A7, Initiative 3). The transcript/analysis tab pair stays this slice.
- **One accessible `Tabs` primitive** with `aria-controls`, `role="tabpanel"`, and roving tabindex, replacing both `StudyDetail`'s partial ARIA tabs and `InterviewDetail`'s plain buttons (DIRECTION §7's "one Tabs implementation"). F5.4 explains why a partial fix is worse than none.
- **Extracting the shared synthesis reading** from `Synthesis.tsx` and `InterviewDetail.tsx`. F3 is written once so both files converge on the same markup, but hoisting it into a component is a structural change and belongs in its own PR with its own review — the same call Slice E made for the duplicated `AI_PROVIDER_SETUP` tables.
- **Rendering `divergentViews` and `researchImplications`** on `StudyDetail`'s aggregate analysis. Both are populated and unrendered; adding them is a content decision, not a migration.
- **The aggregate concordance** (DIRECTION §7 A7, Initiative 3).
- `src/app/layout.tsx`'s `bg-stone-900` body and the `::-webkit-scrollbar` block — both are Slice G.

## Open questions for the orchestrator

1. **Should the supporting passage carry quotation marks?** This spec says no (F2.3): `theme.evidence` and `representativeQuotes` are documented in the prompt as "quote/behavior" and "example evidence", so the schema cannot distinguish a verbatim fragment from the model's paraphrase, and quotation marks would assert what the record does not know. The brief this slice was written from anticipated "a quoted serif block without wine", which is one notch more generous. If the owner prefers the quoted reading, the change is two characters per site in F3.3 and F6.5 and one assertion in `Synthesis.register.test.tsx`; nothing else moves. It is worth deciding deliberately rather than by default, because the marks are the part a reader will read as a promise.

2. **`Key Insight` → `Bottom line`.** F3.1 renames the eyebrow on `Synthesis` and `InterviewDetail` so all four synthesis surfaces (these two, the demo, and `StudyDetail`'s aggregate) use the label DIRECTION §7 specifies. It is not honesty copy, so §9's keep list does not bind it, but it is a user-visible string change in a slice that otherwise changes none. Confirm, or say the word `Key Insight` stays and the demo diverges.

3. **`StudyDetail`'s common themes.** F6.5 renders `commonThemes` / `representativeQuotes`, which exist on the type and have never been displayed. It is the one place this slice adds visible content rather than re-registering it, and it is also the clearest demonstration of the product's thesis on real data. If the orchestrator wants Slice F to be a pure reskin with a zero-content diff, delete F6.5 item 3 and add it to Deferred; nothing else in the slice depends on it.

4. **The provenance footer's receipt.** F3.4 prints the first 12 characters of `_receipt`. That is enough for a researcher to match a reading against a stored record and short enough not to dominate the line, but the truncation length is arbitrary and the string is otherwise meaningless to a human. If the owner would rather print `receipt on file` / `unsigned` and keep the hash out of the UI entirely, that is a one-expression change in F3.4.
