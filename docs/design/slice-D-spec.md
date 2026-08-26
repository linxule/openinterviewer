# Slice D — Demo reskin + Landing (Initiative 1, depends on Slice A)

Re-registers `src/components/DemoSimulation.tsx` and `src/components/Landing.tsx` onto the Verbatim system. Context: `docs/design/DIRECTION-final.md` §7 "Demo" / "Landing", §5 Motion, amendments A1, A2, A6, A7, A8. Prerequisite: Slice A primitives exist in `src/components/ui/` (including `Verbatim`, added in the Slice B fix round). Slice B (participant flagship) and Slice C (researcher shell + register tables) must be accepted before this slice starts — all three edit `eslint.config.mjs`.

**Prime directive: this is a re-registering of the surface, not a logic rewrite.** The demo's state machine, scripted content, focus management, and accessibility architecture survive byte-for-byte in behavior. `DemoPath` / `DemoView` / `DemoBranch` / `TranscriptMessage`, `FIRST_CHOICES`, `BRANCHES`, `buildTranscript`, `STUDY_NAME`, `RESEARCH_QUESTION`, `OPENING_QUESTION`, `CLOSING_MESSAGE`, every `useState`, the single `useEffect` focus router and its dependency array, `resetTo`, `handleChoice`, `showInsight`, `traceEvidence`, `choiceGroupRef`, `completionButtonRef`, `insightHeadingRef`, `evidenceRef`, and every `data-testid` are moved and restyled, never rewritten. Landing has no logic: it is markup and copy only. If a change is not named below, do not make it.

**The demo's skin is the reference implementation of the researcher-facing trace grammar.** Everything later slices build for `Synthesis` and `InterviewDetail` should be recognisable as the same page as this one: manuscript turns through `Turn`, the wine numeral through `Citation`, machine facts through `Coordinate`, honesty through `Disclosure`. Per A7 the `Citation` primitive is reused here, never forked. If it genuinely cannot express something, style around it in the component and record why in the handback; do not edit the primitive.

## D1. Laws that bind both files

- **Light only (A6).** `bg-paper-0` ground, ink text, no `dark:` variants, no `data-theme` reads or writes. Both surfaces are public and participant-adjacent.
- **Wine is evidence-only.** Wine reaches these files exclusively through `Citation` (the numeral, the note's left rule) and through the `.trace-ring` class defined in D6. Neither file may contain `var(--evidence` — the ESLint ratchet enforces this once they leave the allowlist.
- **Ochre is disclosure-only, and interruptive (A8).** The synthetic/preview honesty chrome is the filled `Disclosure` band, never a tasteful hairline. The demo's page-level band must be perceivable at arm's length on a 375px phone; that is a named review check in D8.
- **Serif is human speech, consent text, and interpretation prose.** Serif reaches these files exclusively through `Verbatim` and through `Citation`'s note (which is already `font-serif`). Neither file may contain a raw `font-serif` class. No serif buttons (DIRECTION §11).
- **No genre vocabulary in user-facing copy (A2).** No "colophon", "apparatus", "marginalia" — not in headings, labels, `aria-label`s, or comments that could migrate into copy.
- **No decorative icons (§6).** Both files must end with **no `lucide-react` import at all**. No `framer-motion` (neither file imports it today; do not add it). No gradients, no `backdrop-blur`, no shimmer, no progress dots, no avatars, no skeletons.
- **Radius discipline:** `0` for structure (sheets, sections, notice blocks), `rounded`/`rounded-sm` for controls only. Every `rounded-xl` and `rounded-2xl` in both files dies.
- **Measure discipline (A2):** reading measure (`Measure` / `max-w-measure`) applies to prose only. Nothing in this slice is tabular, so the rule bites in one place: the demo's choice list and its three-step index are not prose columns and take their width from the page, not from `Measure`.

## D2. `Landing.tsx` — the specimen leads

Shell: `<main className="min-h-dvh bg-paper-0">` wrapping `<Page className="py-12 md:py-20">`. Delete the `bg-stone-900 px-4 py-10 text-stone-100 sm:px-8 sm:py-16` frame and the `max-w-5xl space-y-14` inner div (`Page` owns the frame). Vertical rhythm between sections: `space-y-14` becomes `space-y-16` (multiples of the 28px body leading, per §4).

### D2.1 The specimen (new; must precede `<h1>` in DOM order)

DIRECTION §7 Landing: *lead with a specimen, not a description; the tagline becomes the caption to the demonstration.* The landing therefore opens with the quote → citation → interpretation pattern rendered in its resting, **unfolded** state, before any marketing copy.

Module-level constant in `Landing.tsx`:

```ts
// Excerpt from the scripted demo's "project" branch (see DemoSimulation.tsx).
// Kept in sync by hand; see the deferred item in D9.
const SPECIMEN = {
  quote:
    'I had forgotten which project it was for, so opening it felt like work before the reading even started.',
  coordinate: 'Scripted demo · Maya · turn 4',
  interpretation:
    'Reconstructing purpose becomes part of the cost of reading, so the saved item feels like unfinished administrative work.',
} as const;
```

Both strings are copied character-for-character from `DemoSimulation.tsx` (`BRANCHES.project.secondChoices[0].text` and `BRANCHES.project.interpretation`). Do not paraphrase, re-punctuate, or straighten the apostrophes.

Markup, in this order:

1. `Label` eyebrow: `From the scripted demo`. (New copy. It is additive honesty chrome, not a rewrite of kept copy — the specimen is synthetic and must say so above the fold.)
2. The interpretation sentence: `<Verbatim as="p" className="max-w-measure text-[19px] leading-[31px] text-ink-900">`, ending with the citation trigger inline after the final period:
   `<Citation label="t.4" open={specimenOpen} onOpenChange={setSpecimenOpen}>` …note… `</Citation>`
3. The citation note (`children` of `Citation`) contains, in order:
   - the quote, wrapped in curly double quotes exactly as the demo renders them (`“…”`), in `<span className="block text-[24px] leading-[36px] text-ink-900 md:text-[28px] md:leading-[40px]">` — the note is already `font-serif`, so no serif class is added here;
   - `<Coordinate className="mt-3 block">{SPECIMEN.coordinate}</Coordinate>`.
4. State: `const [specimenOpen, setSpecimenOpen] = useState(true)`. Open on first paint (so the quote is server-rendered and visible with no interaction), and still toggleable — the landing's one gesture is the product's one gesture.

`Landing` keeps `'use client'` (it already has it) and gains this single `useState`. This is the only state in the file.

### D2.2 Tagline block (all copy verbatim)

Immediately after the specimen:

- `<Verbatim as="h1" id="landing-heading" className="max-w-[24ch] text-[40px] font-normal leading-[44px] text-ink-900 md:text-[56px] md:leading-[58px]">Follow the answer, not just the script.</Verbatim>` — SS4 at weight 400; **no tracking utility** (`tracking-tight` dies; §11 bans the oversized tracked serif hero).
- Lede paragraph, copy verbatim: `font-sans text-[17px] leading-[28px] text-ink-700 max-w-measure`.
- The eyebrow `OpenInterviewer · Open source` moves **above the specimen** as the page's first line, rendered through `Label`. Copy verbatim.
- The `<section aria-labelledby="landing-heading">` wrapper survives; drop its `grid items-end gap-8 lg:grid-cols-[1.2fr_0.8fr]` — this is one column now.

### D2.3 Calls to action

Two `next/link` anchors in a `flex flex-col gap-3 sm:flex-row sm:flex-wrap` row, both `min-h-11 inline-flex items-center justify-center`, no icons:

- `/demo` — primary: `rounded bg-action px-4 py-2 font-sans text-[15px] font-medium text-paper-1 hover:bg-action/90`. Copy verbatim: `Try the scripted demo · 2 min`.
- `/self-host` — quiet: `rounded border border-ink-300 bg-transparent px-4 py-2 font-sans text-[15px] font-medium text-ink-900 hover:bg-paper-2`. Copy verbatim: `Self-host your own`.

These duplicate `Button`'s variant class strings because `Button` renders a `<button>` and these are navigations. Do **not** nest a `Button` inside a `Link` (invalid HTML) and do **not** add an `as`/`asChild` prop to `Button` in this slice — the primitives are a frozen contract here. Record it as the deferred item in D9.

### D2.4 Honesty chrome

The "Safe to try immediately" box becomes the `Disclosure` primitive:

```tsx
<Disclosure title="Safe to try immediately">
  Fictional participant, fixed branches, no account, API key, live AI, interview API call, or saved data.
</Disclosure>
```

Copy verbatim. Named consequence: the current `<h2 className="font-semibold text-amber-100">` becomes `Disclosure`'s `<strong>` lead-in, so the landing's heading outline loses one `h2`. That is accepted — the band is a note, not a section. `Beaker` icon deleted.

### D2.5 The research loop — one ruled column, not three cards

`<section aria-labelledby="workflow-heading">` survives. `Label` eyebrow `The research loop` verbatim. `<h2 id="workflow-heading" className="font-sans text-[24px] font-semibold leading-[32px] text-ink-900">From a question to evidence you can inspect.</h2>` verbatim.

The `<ol>` loses `grid gap-4 md:grid-cols-3` and becomes a single ruled register. Each `<li>`: `grid grid-cols-[3rem_1fr] gap-4 border-t border-ink-300 py-5` (first item keeps the top rule; no rule after the last). Left cell: `<Coordinate>{step}</Coordinate>` (`01`/`02`/`03`, verbatim). Right cell: `<h3 className="font-sans text-[15px] font-semibold text-ink-900">{title}</h3>` and `<p className="mt-1 font-sans text-[15px] leading-[24px] text-ink-700 max-w-measure">{description}</p>`. All nine strings verbatim. The `icon:` key is deleted from the data array along with the `BookOpen` / `GitBranch` / `Quote` imports.

### D2.6 Ways to run OpenInterviewer

`<section aria-label="Ways to run OpenInterviewer">` survives with its `aria-label` verbatim. Drop `grid gap-4 … sm:grid-cols-2` in favour of a two-row ruled list (`divide-y divide-ink-300 border-t border-ink-300`); on `md:` it may become `md:grid md:grid-cols-2 md:gap-10 md:divide-y-0` — the rows are short, both readings are legal, pick one and keep it consistent between the two entries.

Each entry is a `next/link` with `className="group block py-6"`, containing:
- `<h2 className="font-sans text-[15px] font-semibold text-ink-900 group-hover:text-action">` — copy verbatim (`Configured researcher workspace`, `Self-host`).
- body paragraph, copy verbatim including the `&apos;` entity, `font-sans text-[15px] leading-[24px] text-ink-700 max-w-measure`.
- the trailing action line, copy verbatim (`Researcher sign in`, `View deployment guide`), `mt-3 inline-block font-sans text-[13px] font-medium text-action`. The `ArrowRight` icons and the `LogIn` / `Server` icons are deleted; the words carry the affordance.

### D2.7 Deletions checklist for `Landing.tsx`

`lucide-react` import (whole line) · every `stone-*`, `amber-*`, `text-white` class · every `rounded-xl` / `rounded-2xl` · `tracking-[0.18em]` and `tracking-[0.16em]` (labels come from `Label` at `0.08em`) · `focus-visible:ring-*` and `focus-visible:outline-none` on the CTAs (the token focus ring in `globals.css` already covers `a`) · the `min-h-12` on the CTAs (replaced by `min-h-11`, matching the demo's touch-target discipline).

`src/app/page.tsx` is a bare wrapper (`import Landing; return <Landing />`). **It does not change.**

## D3. `DemoSimulation.tsx` — shell, disclosure band, and the keep-list

### D3.1 Keep-list (a review gate, not a suggestion)

The demo's accessibility engineering is on DIRECTION's unconditional keep list (§9) and is a **review gate on this slice**. The following survive exactly:

| Kept | Where |
|---|---|
| `<aside aria-label="Demo disclosure">` landmark | page-level band |
| `role="log" aria-live="polite" aria-relevant="additions"` on the transcript container | interview view |
| exactly one `role="status"` in the interview view, on `data-testid="demo-progress"` | interview view |
| `<fieldset ref={choiceGroupRef} tabIndex={-1}>` + `<legend>Choose Maya’s response</legend>` (curly apostrophe) | interview view |
| `<section aria-labelledby="transcript-heading">` + the `sr-only` `<h2 id="transcript-heading">` | interview view |
| `aria-labelledby` on the `bottom-line`, `evidence`, `hypothesis`, `nuance`, `real-product`, and `demo-study` sections, and every `id` they point at | intro + insight |
| `<h1 ref={insightHeadingRef} tabIndex={-1}>` with `outline-none` | insight view |
| the evidence `<li ref={evidenceRef} tabIndex={-1}>` | interview view |
| `min-h-11` on every interactive control | everywhere |
| `data-testid`: `demo-start`, `demo-progress`, `demo-message-ai`, `demo-evidence-turn`, `demo-choice-${id}`, `demo-view-insight`, `demo-insight`, `demo-insight-disclosure` | everywhere |
| `aria-hidden="true"` discipline on anything decorative that remains | everywhere |

**Carryover from the Slice B review — nested live regions.** The interview view has exactly two announcement paths: the transcript's `role="log"` and the progress line's `role="status"`. They are **siblings and must stay siblings**; do not move the status line inside the log region, do not add a second `role="status"` (or `aria-live`) anywhere in the interview view, and do not wrap either in a further live region. `tests/unit/DemoSimulation.accessibility.test.tsx` calls `screen.getByRole('status')` in the singular four times; a second status node fails the suite, and a nested one double-announces to a screen reader even when the test passes.

### D3.2 Shell

`<div className="min-h-dvh bg-paper-0 text-ink-700">` replaces `min-h-dvh bg-stone-900 text-stone-100`. `<main>` survives; its `mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-12` is replaced by `<Page className="py-10 md:py-14">` nested inside `<main>`.

Known transitional state, do not fix: `src/app/layout.tsx` still sets `bg-stone-900` on `<body>` and is on the ESLint allowlist. The only visible consequence on `/demo` and `/` is dark overscroll bounce on iOS. Do not touch `layout.tsx`.

### D3.3 The page-level disclosure band (A8)

The `<aside aria-label="Demo disclosure">` landmark survives as the wrapper. Inside it, the visible band becomes the `Disclosure` primitive — filled ochre, full-bleed, interruptive:

```tsx
<aside aria-label="Demo disclosure">
  <Disclosure title="Scripted demo">
    <span className="block">
      Maya is fictional. Every response, follow-up, and insight is pre-written. No demo response leaves this page or survives a refresh.
    </span>
    <nav aria-label="Demo links" className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
      <Link href="/login" className="underline underline-offset-4">Configured workspace</Link>
      <Link href="/self-host" className="underline underline-offset-4">Self-host setup</Link>
    </nav>
  </Disclosure>
</aside>
```

All four strings verbatim. The links carry **no colour class** so they inherit `--disclosure-ink` from the primitive; do not give them `text-*` utilities. `ShieldCheck` deleted. `border-b border-amber-700/40 bg-amber-950/40` deleted — the primitive owns the fill.

`tests/unit/DemoSimulation.accessibility.test.tsx:20` asserts `getByRole('complementary', { name: /demo disclosure/i })` has text content matching `/maya is fictional/i`, so the `aside` must remain the landmark and the copy must remain inside it.

## D4. Demo — intro view

1. `Label` eyebrow, copy verbatim: `Participant view → researcher view`. (`text-sm font-semibold uppercase tracking-[0.18em] text-stone-400` dies; `Label` is 11px at `0.08em`.)
2. `<Verbatim as="h1" className="text-[32px] font-normal leading-[38px] text-ink-900 md:text-[40px] md:leading-[44px]">See an interview become an insight.</Verbatim>` — copy verbatim; the unit test matches this as a level-1 heading.
3. Lede paragraph, copy verbatim, `font-sans text-[17px] leading-[28px] text-ink-700 max-w-measure`.
4. `demo-start`: `<Button variant="primary" data-testid="demo-start" className="min-h-11" onClick={() => setView('interview')}>Begin scripted interview</Button>`. `ArrowRight` and the whole hand-rolled `focus-visible:ring-*` cluster are deleted (the token focus ring covers it).
5. Synthetic-study sheet: `<section aria-labelledby="demo-study-heading" className="border border-ink-300 bg-paper-1 p-5 md:p-6">` — radius 0, one hairline, no shadow. `BookOpen` and the `tracking-[0.16em]` eyebrow are replaced by `<Label>Synthetic study</Label>`. `<h2 id="demo-study-heading" className="mt-2 font-sans text-[18px] font-semibold text-ink-900">{STUDY_NAME}</h2>`. Then `<Label className="mt-5 block">Research question</Label>` and `<p className="mt-2 font-sans text-[15px] leading-[24px] text-ink-700">{RESEARCH_QUESTION}</p>`.
   The `lg:grid-cols-[1.15fr_0.85fr]` two-column intro may stay (`md:grid md:grid-cols-[1.15fr_0.85fr] md:items-start md:gap-10`) — the sheet is an aside to the cover, and this is the one place a second column earns itself.
6. `<ol aria-label="Demo workflow">`: same treatment as Landing D2.5 — one ruled column, `Coordinate` numerals (`1`/`2`/`3`, verbatim), `border-t border-ink-300 py-5`, `h3` sans 15 semibold, description sans 15/24 `text-ink-700`. All nine strings verbatim. `rounded-2xl border border-stone-800 bg-stone-850 p-5` and the `text-amber-200` numerals die.

## D5. Demo — interview view

### D5.1 Header

- `Label`: `Synthetic study` (verbatim).
- `Back to overview`: a bare text button, `font-sans text-[13px] text-ink-500 underline underline-offset-2 hover:text-ink-900`, `min-h-11`, same `onClick={() => resetTo('intro')}`. Copy verbatim.
- `<h1 className="font-sans text-[24px] font-semibold leading-[32px] text-ink-900">{STUDY_NAME}</h1>`.

  **Typographic rule for the demo's three `h1`s, decided:** the intro's cover heading is the one SS4 400 display (D4.2); the interview and insight `h1`s name documents and are Public Sans 600 page titles at 24/32 (DIRECTION §3 scale). Do not make the study name serif.
- Research-question line: `<p className="font-sans text-[15px] leading-[24px] text-ink-700"><span className="font-medium text-ink-900">Research question:</span> {RESEARCH_QUESTION}</p>` — copy verbatim including the colon.

### D5.2 Progress line — the single `role="status"`

Not a card. A ruled register line:

```tsx
<div
  role="status"
  data-testid="demo-progress"
  className="flex flex-wrap items-center justify-between gap-3 border-y border-ink-300 py-2"
>
  <span className="font-sans text-[13px] font-medium text-ink-900">
    {interviewComplete ? 'Interview complete' : `Question ${answers.length + 1} of 3`}
  </span>
  <Coordinate>{branch ? `Scripted branch: ${branch.label}` : 'Choose the opening path'}</Coordinate>
</div>
```

All four strings verbatim — the e2e asserts `Question 1 of 3` and `Interview complete`, and the unit suite asserts `Scripted branch: Fading curiosity` and `Question 1 of 3`.

### D5.3 Transcript

`<section aria-labelledby="transcript-heading">` keeps its `aria-labelledby` and `sr-only` `h2`; its `rounded-2xl border border-stone-700 bg-stone-850 p-4 sm:p-6` becomes `mt-8` with no box at all — the transcript is the page, not a card. The `role="log"` div is unchanged. `<ol className="space-y-8">` (a multiple of the 28px line).

Each `<li>` keeps its `key`, `ref` (evidence turn only), `tabIndex` (evidence turn only), and `data-testid` logic **exactly as written today**, and gains:

```tsx
className={cn(
  'focus:outline-none',
  message.evidence && highlightEvidence && 'ring-2 trace-ring ring-offset-4 ring-offset-paper-0'
)}
```

The literal class `ring-2` is load-bearing twice: `tests/unit/DemoSimulation.accessibility.test.tsx:86` asserts `toHaveClass('ring-2')` and `tests/e2e/demo-no-provider.spec.ts:40` asserts `toHaveClass(/ring-2/)`. Keep the token `ring-2` in the class string verbatim; the wine comes from `.trace-ring` (D6), never from a `ring-[…]` arbitrary value (which the ratchet would reject).

Inside each `<li>`, in order:

1. Speaker attribution — honesty copy, kept visible:
   `<Label className="block">{message.role === 'interviewer' ? 'Scripted interviewer' : 'Maya · fictional participant'}</Label>`, with `md:pl-[3.75rem]` on the participant side so it sits over the indented text. Both strings verbatim. `Bot` and `User` icons deleted, along with the `justify-end` alignment for participant turns.
2. The turn itself:
   `<Turn speaker={message.role} turnIndex={index + 1} showCoordinate className="mt-1">{message.content}</Turn>`
   — `message.role` is already `'interviewer' | 'participant'`, matching `TurnProps['speaker']` with no mapping. `buildTranscript` yields the evidence turn at array index 3, so `turnIndex` 4, which is exactly what the existing coordinate copy (`… turn 4`) claims.

**`showCoordinate` is set here, deliberately.** A1 forbids visible apparatus in the *live participant interview* (`InterviewChat`, delivered in Slice B). `/demo` is a researcher-facing artefact that demonstrates both registers and whose whole point is that an insight can be traced to a numbered turn; the trace has to have a visible target. If the orchestrator would rather the demo transcript mirror the participant's apparatus-free view exactly, that is a real alternative — see the open question in D9.

Bubble geometry (`flex justify-end/justify-start`, `max-w-[92%] sm:max-w-[78%]`, `rounded-2xl`, `rounded-br-md`, `rounded-bl-md`, `bg-stone-700`, `bg-stone-800`) is deleted outright. Transcript grammar, not chat grammar.

### D5.4 Choice fieldset

`<fieldset ref={choiceGroupRef} tabIndex={-1} className="mt-8 border-0 border-t border-ink-300 pt-6 focus:outline-none">`. `<legend className="px-1 font-sans text-[15px] font-semibold text-ink-900">Choose Maya’s response</legend>` — curly apostrophe verbatim; the unit test matches this as the group's accessible name. `<p className="mb-4 mt-1 font-sans text-[13px] text-ink-500">Every option is fictional and pre-written.</p>` verbatim.

Each choice: `<Button variant="quiet" key={choice.id} data-testid={\`demo-choice-${choice.id}\`} onClick={() => handleChoice(choice)} className="min-h-11 w-full text-left leading-[24px]">{choice.text}</Button>`. The `grid gap-3` wrapper survives.

The choice labels stay **sans** even though they are the words Maya is about to say: DIRECTION §11 bans serif buttons, and a control label is chrome. The words become serif the instant they are spoken, one line below, in the transcript — which is the lesson the demo is teaching.

### D5.5 Completion control

`<div className="mt-8 border-t border-ink-300 pt-6">` wrapping
`<Button ref={completionButtonRef} variant="primary" data-testid="demo-view-insight" onClick={showInsight} className="min-h-11 w-full sm:w-auto">{hasSeenInsight ? 'Return to researcher note' : 'See researcher view'}</Button>`.
Both labels verbatim (the unit suite matches both, and asserts the button holds focus on completion — `Button` forwards its ref, so `completionButtonRef` keeps working unchanged). `ArrowRight` deleted.

## D6. Demo — insight view (the reference implementation)

Wrapper keeps `data-testid="demo-insight"`.

1. `Label`: `Researcher view` (verbatim).
2. `<h1 ref={insightHeadingRef} tabIndex={-1} className="font-sans text-[24px] font-semibold leading-[32px] text-ink-900 outline-none">Illustrative synthesis</h1>` — copy, ref, `tabIndex`, and `outline-none` all verbatim.
3. Subtitle, copy verbatim: `Based on one fictional interview. This is an interpretation, not a research finding.` — `font-sans text-[15px] leading-[24px] text-ink-700`.
4. Insight disclosure — the `Disclosure` primitive, testid preserved, sentence verbatim with its inline `<strong>`:

```tsx
<Disclosure data-testid="demo-insight-disclosure">
  This note was authored in advance for the <strong>{branch.label}</strong> path. No model analyzed Maya or generated these claims.
</Disclosure>
```

   Pass no `title` here — the `<strong>` sits mid-sentence, and `Disclosure`'s `title` renders a leading `<strong>`. `Disclosure` spreads unknown props onto its root, so `data-testid` lands correctly.

5. **Bottom line.** `<section aria-labelledby="bottom-line-heading">` survives. Keep the `<h2 id="bottom-line-heading">Bottom line</h2>` element (the section's accessible name depends on it) and restyle it with `Label`'s typography: `font-sans text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500`. Then:
   `<Verbatim as="p" className="mt-3 max-w-measure text-[24px] font-normal leading-[36px] text-ink-900 md:text-[28px] md:leading-[40px]">{branch.bottomLine}</Verbatim>`
   Then `<Rule className="mt-8" />`. The `rounded-2xl bg-stone-700 p-5 text-white` slab and the `Target` icon die.

6. **Evidence trail — the canonical trace.** `<section aria-labelledby="evidence-heading">` survives. `<h2 id="evidence-heading" className="font-sans text-[15px] font-semibold text-ink-900">Evidence trail</h2>` (copy verbatim; `Search` icon deleted). The `<dl>` survives with **two** pairs, not three:

   - `<dt>` `Emerging theme` (Label typography) / `<dd className="mt-2 font-sans text-[15px] font-medium text-ink-900">{branch.theme}</dd>`.
   - `<dt>` `Interpretation` (Label typography) / `<dd className="mt-2">` containing:

```tsx
<Verbatim as="p" className="max-w-measure text-[17px] leading-[28px] text-ink-700">
  {branch.interpretation}{' '}
  <Citation label="t.4" open={traceOpen} onOpenChange={setTraceOpen}>
    <span className="block text-[19px] leading-[31px] text-ink-900">“{answers[1]}”</span>
    <Coordinate className="mt-2 block">Maya · participant response · turn 4</Coordinate>
  </Citation>
</Verbatim>
```

   with `const [traceOpen, setTraceOpen] = useState(true)` added to the component's state (the second and last new state in this slice). Open on first paint, still toggleable.

   - **Named deletion:** the third `<dt>`/`<dd>` pair (`Evidence quote`, its `Quote` icon, its `border-l-2 border-amber-300 pl-4` block, and its separate coordinate `<dd>`) is removed — the quote and its coordinate now live inside the citation note, which is where the trace grammar puts them. The coordinate string `Maya · participant response · turn 4` and the curly quotes around `answers[1]` survive verbatim.
   - **Why the note opens by default:** the quote must be present in the DOM without interaction. `tests/unit/DemoSimulation.accessibility.test.tsx` asserts `getByText(/forgotten which project it was for/i)` and `getByText(/could not remember why i had saved it/i)` on the insight view, and `tests/e2e/demo-no-provider.spec.ts:37` asserts the same. `Citation` renders nothing when closed.

7. **Hypothesis / Nuance.** Both `<section aria-labelledby>` wrappers and both `<h2>` strings (`Hypothesis to test`, `Nuance worth preserving`) survive verbatim; the `Lightbulb` icon and both `rounded-2xl … bg-stone-800/70` / `bg-stone-850` cards die. Each becomes `border-t border-ink-300 pt-5` with the `h2` at `font-sans text-[15px] font-semibold text-ink-900` and the body at `font-sans text-[15px] leading-[24px] text-ink-700 max-w-measure`. The two-column `lg:grid-cols-[1.25fr_0.75fr]` split may survive as `lg:grid lg:grid-cols-[1.25fr_0.75fr] lg:gap-10`, or collapse to one column — pick one; the mobile case is the designed case.

8. **What changes in a real study?** `<section aria-labelledby="real-product-heading">` and its `h2` + paragraph survive verbatim, same ruled treatment.

9. **Action row.** `flex flex-col gap-3 sm:flex-row sm:flex-wrap`:
   - `<Button variant="quiet" onClick={traceEvidence} className="min-h-11">Trace this insight in the transcript</Button>` — copy verbatim; both the e2e and the unit suite click it by accessible name, and neither opens a citation first, so this control must be reachable at the top level of the insight view regardless of `traceOpen`.
   - `<Button variant="quiet" onClick={() => resetTo('interview')} className="min-h-11">Replay another path</Button>` — copy verbatim.
   - `Set up your own instance` — a `next/link` to `/self-host` with the primary anchor classes from D2.3, `min-h-11`.
   `Quote`, `RotateCcw`, and `ArrowRight` deleted.

### D6.1 `globals.css` — one addition, and two things that must NOT be deleted

**Add** (under `@layer components`, beside the existing `.citation-note` block):

```css
/* Evidence trace ring — src/components/DemoSimulation.tsx */
.trace-ring {
  --tw-ring-color: rgb(var(--evidence));
  --tw-ring-offset-color: rgb(var(--paper-0));
}
```

DIRECTION §5 asks for the trace to draw itself on over ~400ms, instant under reduced motion. Tailwind's `ring-*` colour lives in a custom property, which does not interpolate without registration, so the settle gesture is a bounded implementation choice: Codex picks either an `@property`-registered alpha or a short keyframe on an inset overlay, subject to this contract — the literal class `ring-2` stays in the component; the wine comes only from `--evidence` inside `globals.css`; the animation lasts ~400ms with `cubic-bezier(0.2, 0, 0, 1)`; `@media (prefers-reduced-motion: reduce)` disables it entirely and leaves a static wine ring; no new dependency; the chosen approach is documented in the handback. If neither approach is clean, ship `.trace-ring` as written above with no animation and say so — a static wine ring is correct and the motion is the smaller half of the promise.

**Do not delete `.prose` or `.preview-banner`.** The Slice D brief anticipated both dying here "if nothing else references them". They are both still referenced — verified by grep at spec time:

- `.prose` / `.prose strong` / `.prose ul` / `.prose ol` / `.prose p` → used by `src/components/InterviewDetail.tsx:293` (`prose prose-sm max-w-none prose-invert`). `DemoSimulation.tsx` never referenced `.prose` at all; the brief's premise was mistaken.
- `.preview-banner`, `.preview-banner-pulse`, `@keyframes shimmer`, `@keyframes pulse` → used by `src/components/PreviewBanner.tsx:28` and `:30`.

Both blocks die with the slice that migrates `InterviewDetail.tsx` and `PreviewBanner.tsx`, not this one. Re-run the grep before touching `globals.css` and report the result in the handback; if it comes back clean because those files moved in the meantime, deleting them is in scope, but do not delete on the strength of this spec alone.

Anything else in `globals.css` is out of scope for Slice D.

## D7. Ratchet (`eslint.config.mjs`)

- Remove `'src/components/Landing.tsx'` and `'src/components/DemoSimulation.tsx'` from `legacyDesignAllowlist`. Both files must then pass clean under `--max-warnings=0`.
- Make no other allowlist edits and no rule edits. Two lines, so the diff is trivially reviewable.
- After this slice the allowlist should hold: `Synthesis.tsx`, `InterviewDetail.tsx`, `StudyDetail.tsx`, `StudySetup.tsx`, `Settings.tsx`, `Onboarding.tsx`, `Export.tsx`, `Login.tsx`, `OAuthLogin.tsx`, `PreviewBanner.tsx`, `src/app/layout.tsx`, `src/app/self-host/page.tsx`, the setup `page.tsx` entry (path rewritten by Slice C), and `src/app/p/\[token\]/page.tsx`. Report the actual post-slice list in the handback; do not "tidy" it.

## D8. Tests

**Must keep passing untouched:**

- `tests/e2e/demo-no-provider.spec.ts`. Its dependencies, in the order it uses them: the text `scripted demo` (case-insensitive, `.first()`) and `Maya is fictional` visible on load; `demo-start`; `demo-progress` containing `Question 1 of 3`; `demo-choice-project`; the text `saved it for a specific future use`; `demo-choice-project-context-lost`; the text `reason for saving had faded`; `demo-choice-project-own-note`; **exactly four** elements with `data-testid="demo-message-ai"`; `demo-progress` containing `Interview complete`; `demo-view-insight`; a **level-agnostic heading** named `Illustrative synthesis`; `demo-insight-disclosure` containing `No model analyzed Maya`; the texts `Lost context creates re-entry work` and `forgotten which project it was for`; a button named `Trace this insight in the transcript`; `demo-evidence-turn` carrying a class matching `/ring-2/`; and, after reload, `demo-start` visible again. It also asserts **zero** same-origin `/api/` requests and **zero** cross-origin requests — so introduce no `fetch`, no `<img src>` to another host, and no external stylesheet or font link. `next/font` self-hosts at build time and is already proven safe by the current suite.
- `tests/unit/DemoSimulation.accessibility.test.tsx`. Additional dependencies beyond the e2e's: `getByRole('complementary', { name: /demo disclosure/i })`; `getByRole('heading', { level: 1, … })` for both `See an interview become an insight` and the study name — **both must remain `h1`**; `getByRole('group', { name: /choose maya’s response/i })`; `getByRole('status')` in the **singular** (D3.1); focus landing on `See researcher view` at completion; the texts `interpretation, not a research finding`, `reconstructing purpose becomes part of the cost`, `original spark restored or permission for the item to disappear`, `saved curiosity becomes undifferentiated backlog`; and `queryByText(/scripted branch: project context/i)` being absent after a replay.

If either suite breaks, the fix is in the component, not the test. The one exception, requiring an explicit note in the handback: if `getByText` becomes ambiguous because a string now appears twice (for example a branch label rendered in both the progress line and the insight disclosure), fix it by removing the duplication in the component, not by loosening the query.

**New, smallest realistic regressions:**

- `tests/unit/Landing.specimen.test.tsx`
  - the specimen quote text is in the document on first render, and its node **precedes** the `h1` in document order (`compareDocumentPosition(...) & Node.DOCUMENT_POSITION_FOLLOWING`);
  - the citation trigger is a `button` with `aria-expanded="true"` on first paint; clicking it removes the quote from the document and flips `aria-expanded` to `"false"`;
  - the mono coordinate line `Scripted demo · Maya · turn 4` is present;
  - the honesty band renders with `role="note"` and contains `Fictional participant, fixed branches` and `Safe to try immediately`;
  - the four links resolve to `/demo`, `/self-host` (twice), and `/login`;
  - `container.querySelectorAll('svg')` has length `0` (the icon ratchet).
- `tests/unit/DemoSimulation.trace.test.tsx`
  - on the insight view, the evidence quote is visible without interaction and the citation trigger reports `aria-expanded="true"`;
  - clicking the trigger hides the quote, and clicking again restores it;
  - the coordinate `Maya · participant response · turn 4` is present;
  - the interview view contains exactly one node with `role="status"` and exactly one with `role="log"`, and the status node is **not** a descendant of the log node (`expect(log.contains(status)).toBe(false)`);
  - `container.querySelectorAll('svg')` has length `0` on all three views.

Do not snapshot either component.

## D9. Verification

```bash
npm run lint && npm run typecheck && npm run test
DEPLOYMENT_MODE=standalone npm run build
npm run test:e2e
```

Then, before handing back:

- **A8 arm's-length check.** Load `/demo` at 375px width and confirm the filled ochre band reads as an interruption — that "Scripted demo" is legible at arm's length and is not mistaken for page chrome. This is the amendment's own acceptance test, and "beautiful but buried" fails it.
- 375 / 1024 / 1440 visual pass on `/` and `/demo`. Leave the dev server runnable for the orchestrator's screenshots.
- Confirm `/` and `/demo` show no researcher rail (Slice C's route group must not have swallowed them).

## Hard constraints

- Files that may change: `src/components/DemoSimulation.tsx`, `src/components/Landing.tsx`, `src/app/globals.css` (the single additive `.trace-ring` block in D6.1 — nothing deleted), `eslint.config.mjs` (two lines, per D7), and the tests in D8. Nothing else.
- Do not touch `src/app/page.tsx`, `src/app/demo/page.tsx`, `src/app/layout.tsx`, anything under `src/components/ui/` (frozen contracts), or any other component. No store, service, type, API route, `proxy.ts`, or `researcherAccess.ts` changes.
- No new dependencies. No `framer-motion`, no `lucide-react`, in any file this slice writes.
- No `data-theme` wiring and no theme toggle. Light Paper only; both surfaces are public (A6).
- Do not commit; leave the working tree for review. `docs/` is untracked — leave it. npm only (`package-lock.json` authoritative), Node ≥ 24.19.

## Deferred, do not attempt

- A `Button` `as`/`asChild` escape hatch so `next/link` CTAs stop duplicating variant class strings (D2.3, D6.9).
- Hoisting the demo's scripted content into a shared module so `Landing`'s `SPECIMEN` cannot drift from `BRANCHES.project` (D2.1). Today the two are kept in sync by hand and by the D8 assertion on the quote string.
- Deleting `.prose` and `.preview-banner` from `globals.css` — they belong to the `InterviewDetail` and `PreviewBanner` slices (D6.1).
- `src/app/layout.tsx`'s `bg-stone-900` body.

## Open question for the orchestrator

**Does the demo's transcript show turn coordinates?** This spec says yes (D5.3): the demo is a researcher-facing artefact, and the trace needs a visible target for `t.4` to point at. The alternative reading of A1 is that the demo's interview view should be a faithful mirror of the participant's apparatus-free transcript, with coordinates appearing only in the insight view — which would make the trace-back land on a turn with no visible number, and would make the demo teach a slightly different lesson. If the orchestrator prefers the mirror reading, the change is one prop (`showCoordinate` off in D5.3) and no test moves.
