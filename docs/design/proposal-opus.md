# APPARATUS
### A design direction for OpenInterviewer — *the critical edition of a conversation*

---

## 1. The direction

**Name: Apparatus.**

In textual scholarship, the *apparatus criticus* is the layer of a scholarly edition — set in the margin or at the foot of the page, in smaller type, historically in red ink — that records, for every editorial reading, exactly which manuscript it came from. The source text sits in the middle in the largest, most readable type. The editor's voice sits beside it, visibly subordinate, permanently attributed. It is a **provenance interface invented five hundred years before software**, and it solves precisely the problem this product exists to solve.

**Why it is right for OpenInterviewer specifically.** This product's thesis is a single sentence: *an interpretation must never be more than one glance away from the words that produced it.* The apparatus tradition is the only visual language humans have ever built whose entire purpose is that sentence. It gives us, for free and without invention: a rank order between verbatim speech and interpretation (source text large, editorial small); a mark for "this claim rests on that quote" (the footnote marker — the oldest provenance UI in existence); a convention for disclosing what an artifact is made of (the colophon, which is what `SynthesisResult._receipt` is already secretly storing); and a color that has meant *"this mark is the editor speaking, not the source"* since manuscript rubrication. None of that is decoration. Every piece of it does a job the current UI is failing to do.

And it inverts the one relationship that matters most: **in Apparatus, the participant's own words are the primary text and the AI is the apparatus.** Today the interviewer gets a robot avatar, a labeled bubble, and equal typographic weight with the human it is interviewing. That is a design that quietly says the machine is the author. Apparatus says the participant is the author and the machine is the annotation — which is both the ethically correct claim and, not coincidentally, the product's differentiator.

**The rival direction I rejected: "The Instrument."** A calibrated lab-bench aesthetic — mono-forward, gridded, tick marks, measurement chrome, the oscilloscope/observability-tool language. It flatters the rigor half of the product and the researcher dashboard would look sharp in it. I rejected it because it fails the participant. The one audience that must feel *listened to* would be reading their own testimony on a specimen tray, laid out by an instrument that is measuring them. A direction that serves two of three audiences is not a direction. Apparatus serves all three, because the scholarly-edition tradition already holds the source's own words as the object of highest value in the room — which is exactly the promise a qualitative researcher makes to a participant.

**The single sentence:** *The participant's words are the text. Everything else — the AI's questions, the researcher's reading, the model that produced it — is apparatus, set beside the text, never mistaken for it.*

---

## 2. Visual identity

### 2.1 Polarity: light-first. This is the load-bearing call.

Dark-only is not neutral restraint; **dark-mode-by-default is itself the 2025 AI-product cliché** the brief is complaining about. It is the single strongest signal that this UI came out of the same drawer as every other dev tool from last year.

More importantly it is wrong for the work. This product is long-form reading of human speech: 10–15 minute interviews, multi-thousand-word transcripts, participants on phones in daylight, researchers reading for an hour. Every surface humanity has built for sustained reading — the page, the proof, the manuscript, the e-reader — is dark-on-light. The current design puts the product's most important content on the surface least suited to reading it.

- **Light is the default and the identity.** Warm paper, not white.
- **Dark exists and is complete** — researchers work at night — but it is *the reading lamp*, not the brand.
- **Participants always get light.** No toggle, no theme flash, no decision. They are here once, for fifteen minutes, to be read carefully. The toggle lives in the researcher workspace only.

### 2.2 Palette

Three inks on paper. Nothing else. The warmth of the current `stone` ramp is genuinely right and survives — we keep the warm neutral and flip the polarity.

**Light — "recto" (default)**

| Token | Hex | Role |
|---|---|---|
| `--paper` | `#FBF9F5` | Page ground. Warm off-white, never `#FFF`. |
| `--paper-raised` | `#FFFFFF` | The rare lifted surface (open apparatus note, active field). |
| `--paper-sunk` | `#F3EFE8` | Wells: transcript ground, input, code. |
| `--rule` | `#E4DDD2` | Hairlines. 1px, the primary structural device. |
| `--rule-strong` | `#C7BCAB` | Section breaks, table heads. |
| `--ink` | `#1C1917` | Primary text. (Deliberately the current `stone-900` — continuity.) |
| `--ink-muted` | `#57534E` | Interviewer questions, secondary UI. 7.4:1 on paper. |
| `--ink-faint` | `#857B71` | Metadata, placeholders. 4.6:1 — never below 13px. |
| `--rubric` | `#A32E17` | **The editorial ink.** ~6.0:1 on paper. |
| `--rubric-wash` | `#F8EBE5` | Rubric ground for filled/alarm states. |
| `--verdigris` | `#2F6B58` | Confirmed-and-recorded only. ~5.3:1. |

**Dark — "verso"**

| Token | Hex | Role |
|---|---|---|
| `--paper` | `#141110` | Warm near-black, deeper and warmer than today's `stone-900`. |
| `--paper-raised` | `#1E1A17` | |
| `--paper-sunk` | `#0F0D0B` | |
| `--rule` | `#332C26` | |
| `--rule-strong` | `#4A4038` | |
| `--ink` | `#EDE7DE` | |
| `--ink-muted` | `#A79D91` | |
| `--ink-faint` | `#7A7168` | |
| `--rubric` | `#EE8B72` | The rubric tints up; it never becomes pink or neon. |
| `--rubric-wash` | `#3A1C14` | |
| `--verdigris` | `#6FBFA3` | |

**On the rubric, and why it is not "error red."** Rubric marks the *editorial voice* — provenance, disclosure, "this is scripted," "this is an interpretation." It appears only as **hairlines, brackets, footnote markers, and 11px labels**. Failure states use the *same ink at a different weight*: a **filled** rubric block, white text on `--rubric` ground, with an icon. Weight separates "note" from "stop," which is how print has always done it, and it means we do not need a fourth color. Hard rule: **no destructive action ever uses the same treatment as a provenance mark.** Provenance is thin and unfilled; destruction is filled.

This preserves what the current design got genuinely right — that **honesty deserves its own dedicated color** — while replacing amber, which cannot hold text contrast on a light ground and therefore cannot survive the polarity flip.

### 2.3 Typography — the identity lives here

Fonts are declared but never loaded today. The whole app is rendering in OS fallback. That means **typography is the single highest-leverage lever available**, and this direction spends nearly all of its identity budget there rather than on color or shape.

Three families, each with one non-negotiable semantic job. A contributor should never have to ask which to use:

**Source Serif 4** (variable, Google Fonts, SIL OFL) — **verbatim human speech, and only that.** Participant answers, evidence quotes, consent text, the bottom line, the landing specimen. Designed by Frank Grießhaber for extended on-screen reading, with real optical sizes and a variable weight axis; it is warm without being literary-precious, and it is a serious open-source reading face rather than a display revival. *Alternate if you dislike it: Literata. Do not substitute Lora, Merriweather, or Playfair.*

**IBM Plex Sans** (SIL OFL) — **all interface chrome.** Buttons, labels, navigation, interviewer questions, forms. Plex was commissioned as the institutional voice of an engineering company: it is neutral enough to disappear but has enough opinion in the details (the `a`, the leg of the `R`) that it does not read as the Inter default that ships with every AI product. It also gives us a matched mono, which is why contributors will get the pairing right without a style guide.

**IBM Plex Mono** (SIL OFL) — **coordinates only.** Turn numbers, timestamps, model IDs, receipt hashes, study revisions, provider strings. Mono means *"this is a machine-verifiable fact you can quote back at us."* Never used for prose, never for emphasis, never for "techy" flavor.

**Loading:** `next/font/google`, latin subset, `display: swap`. Source Serif 4 variable 400–700; Plex Sans 400/500/600; Plex Mono 400/500. Roughly 120 KB of woff2, self-hosted by next/font, zero external requests.

**Scale** (mobile → desktop):

| Role | Face | Size / leading | Notes |
|---|---|---|---|
| Specimen / display | Serif 400 | 40/44 → 56/58 | Tracking −0.01em. **Weight 400, not bold.** |
| Bottom line | Serif 400 | 24/36 → 28/40 | |
| Page title | Plex Sans 600 | 22/30 → 24/32 | |
| Verbatim body | Serif 400 | 18/29 → 19/31 | The measure. |
| Interviewer question | Plex Sans 500 | 16/26 | `--ink-muted`. |
| UI body | Plex Sans 400 | 15/24 | |
| Meta | Plex Sans 400 | 13/20 | |
| Label | Plex Sans 600 | 11/16 | Uppercase, **0.08em** tracking. |
| Coordinate | Plex Mono 400 | 12/16 | `font-variant-numeric: tabular-nums`. |

Note the two corrections to current practice embedded here. First, the heavy bold sans hero is most of why the landing page reads generic — display weight drops to 400 and the size does the work. Second, current eyebrows are tracked at 0.14–0.18em, which is 2019 SaaS; **0.08em at 11px** is a label, not a decoration.

Prefer `font-variant-caps: all-small-caps` for labels where the served build supports it; the 11px uppercase spec above is the tested fallback and should be what ships until someone verifies the `smcp` table in the Google build.

### 2.4 Spatial system — the measure, not the viewport

The organizing unit is **the reading measure**, not the screen.

- **Measure = 34rem** (~62–68 characters at 19px serif). Body text is never wider. Ever.
- **Margin = 18rem.** The apparatus column.
- **Gutter = 3rem.**
- Desktop grid: `grid-template-columns: minmax(0, 34rem) 3rem 18rem`, left-aligned in a `max-w-[64rem]` page — **not centered**, because a centered measure with a margin column produces a page that drifts as content changes. The text column is anchored; the apparatus hangs off it.
- **Below 1024px the margin column does not shrink — it collapses inline**, beneath the passage it annotates, indented with a rubric hairline. That is exactly how a footnote degrades in print, and it is why this layout survives 375px where "sidebar" layouts do not. Mobile is the designed case; the margin is the enhancement.

**Vertical rhythm.** Base unit 4px, but block spacing is expressed in the body leading of **28px**: blocks separate at 0.5 / 1 / 1.5 / 2 / 3 × 28. This keeps the text column looking set rather than assembled, and it is a rule a contributor can follow without reading a doc: *space between things is a multiple of a line.*

### 2.5 Shape and texture

**Kill the rounded card.** The current UI is 16 components' worth of `rounded-2xl` + `1px border` + slightly-lighter-fill boxes. That container is the generic AI-tool tell, it is inconsistently applied (`xl` vs `2xl` vs `lg`), and it wastes ~48px of horizontal space per nesting level on mobile.

Radius scale, complete:

- **0px** — all structure. Sections, passages, the transcript, the apparatus, disclosure bars. Structure is made of **rules and space**, not boxes.
- **2px** — interactive controls: buttons, inputs, selects, choice targets. Just enough to read as pressable.
- **50%** — avatars and status dots only. There are almost none.
- **No `rounded-full` pills. No chat bubbles.** (See §3.3.)

**Texture: none.** No paper grain, no noise overlay, no book-page drop shadow, no faux-deckle edge. Elevation is expressed by ground value and a single hairline, never by shadow — with exactly one exception: an open apparatus note gets `0 1px 2px rgb(0 0 0 / 0.06)` so it reads as lifted off the page. One shadow token in the system.

**The hairline is the primary structural device.** 1px `--rule` for divisions inside a region; 1px `--rule-strong` for divisions between regions; 2px `--rubric` for anything editorial (disclosure bars, evidence brackets, the standing demo masthead).

### 2.6 Motion

**Paper does not bounce.** No spring physics, no scale-in, no stagger cascades. Two motions exist:

1. **Settle** — 180ms, `cubic-bezier(0.2, 0, 0, 1)`, opacity 0→1 with `translateY(4px)`. For content arriving. (This is essentially the current framer-motion fade-up, with the travel cut from 20px to 4px and the easing fixed. The existing restraint is correct; the distance is theatrical.)
2. **Unfold** — 240ms, same easing, `grid-template-rows: 0fr → 1fr` clip reveal. For the apparatus opening. Nothing above the fold point moves.

**The thinking indicator is not three bouncing dots.** In the participant interview, while the interviewer composes, a **2px rubric rule draws itself left-to-right across the measure** over ~1.4s and holds at full width, in the slot where the next question will set. It reads as *a line being written*, which is what is actually happening. Beneath it, `Composing a follow-up` in 13px `--ink-faint`.

`prefers-reduced-motion: reduce` disables both settle and unfold (content appears at final state; the apparatus opens instantly) and replaces the drawing rule with a static rule plus the same text label. This must be real, not aspirational — the current `globals.css` shimmer animation on the preview banner honors nothing and should be deleted outright.

### 2.7 Iconography

**Near-total rejection.** lucide-react stays as the dependency; its usage collapses to **functional actions only**: send, back, close, external link, copy, download, check, chevron. Nominal stroke 1.5, size 16 or 18, never larger than 20 except the single participant-receipt confirmation mark.

**Delete every decorative section icon.** `Target` before "Bottom line," `Lightbulb` before "Key themes," `Search` before "Evidence trail," `BarChart3` before the page title, `TrendingUp` before "Stated vs revealed" — these are pure 2020s-dashboard tic. A section is identified by its **rubric label**, which is more legible, more accessible, translatable, and does not require anyone to decode why insight is a lightbulb.

**Delete the `Bot` icon.** An interviewer is not a robot, and putting a robot face on it is a claim about the relationship that the product does not want to make. The interviewer is identified typographically (see §3.3) and, where a word is needed, by the word `Interviewer`.

**Replace the `Quote` icon with actual quotation marks.** We are loading a typeface with excellent ones.

---

## 3. Experience architecture

### 3.1 Landing — lead with a specimen, not a description

The current hero *describes* the product in a heavy bold sans. Every AI product does. Replace it with **the product's smallest complete unit, rendered for real**:

```
                                          ┌─ margin ─────────────┐
 “I had dozens of saved pieces, and       │ TURN 4 · PARTICIPANT │
  nothing told me why this one had        │                      │
  mattered.”                              │ Saved curiosity      │
     ← serif, 28/40, --ink                │ becomes undifferen-  │
                                          │ tiated backlog.      │
                                          │   ← sans 15/24,      │
                                          │     --ink-muted      │
                                          └──────────────────────┘
 ─────────────────────────────────────────────────────────────────  ← 1px rubric

 Follow the answer, not just the script.     ← Plex Sans 600, 20px
 Turn a research guide into an adaptive interview…   ← sans 15/24
 [ Try the scripted demo · 2 min ]  [ Self-host your own ]
```

A visitor understands the entire thesis — verbatim on the left, interpretation in the margin, coordinate attached — in under three seconds, before reading a word of marketing copy. The tagline stays but becomes the caption to the demonstration rather than the headline.

**Structural changes:** the three-card "research loop" row becomes **three passages in one continuous column** with rubric numerals hanging in the margin — because they are a sequence, and three separated boxes actively hide that. The "Safe to try immediately" amber box becomes a rubric-ruled note attached to the demo CTA, not a floating card competing with the hero.

**Keep:** the copy. It is well-written, specific, and non-hypey. The "Fictional participant, fixed branches, no account, API key, live AI, interview API call, or saved data" line is the most trustworthy sentence on the page.

### 3.2 Demo — keep the structure, change the honesty from banner to fabric

`DemoSimulation.tsx` is the best-designed screen in the repo and its architecture (intro → interview → insight, with focus management on every transition) survives intact. Three changes:

1. **The fat amber aside becomes a standing rubric masthead.** A permanent 3px rubric rule across the top of the viewport that *never scrolls away*, with the disclosure text set once beneath it in 13px. Permanent and thin beats large and dismissible-feeling.
2. **Fictionality becomes typographic, not just declared.** Every fictional participant passage carries a rubric bracket in its margin reading `SCRIPTED` in 11px. The honesty is then present at every glance, at every scroll position, in every screenshot anyone takes of this page — instead of living in one banner at the top that a reader stops seeing after ten seconds. This is what the brief means by *make the honesty chrome beautiful rather than bury it*: it stops being a nag and becomes the page's texture.
3. **"Trace this insight" becomes the unfold-in-margin gesture** (§4), with the existing jump-to-turn behavior demoted to a "Read in full transcript" link inside the note. The current amber `ring-2 ring-offset-4` on the traced turn becomes a rubric bracket in the transcript's margin — a mark, not a glow.

**Keep, without negotiation:** the `role="log"` / `aria-live` wiring, the four-branch focus-management effect, the `data-testid` hooks, `min-h-11` targets, and every word of the disclosure copy. That a11y discipline is the best engineering in the UI layer and a reskin is the classic way to lose it.

### 3.3 Participant interview — the flagship

**Consent** stops being a card and becomes a **document**. The study's consent text is a document; setting it at reading measure in serif is the design telling the truth about what it is. The "Interview Structure" foreshadow moves to the margin as a numbered list. The provider disclosure — currently buried in a gray box — becomes a rubric-ruled editorial note with the provider and model as a mono coordinate: `openai/gpt-…  ·  via Vercel AI Gateway`. The button reads `I consent — begin the interview`. On success, the server-issued `acceptedAt` is shown as a mono timestamp: consent is a record, and the participant should see their copy of it.

**The interview itself. Kill the chat bubbles.** An interview transcript is not a text-message thread. Two speakers, **one column**, differentiated by typography and indentation — the way printed oral-history transcripts, plays, and depositions have always been set:

```
 PART TWO OF FOUR · exploring what you said        ← margin, 11px label

 What made you save it?                            ← Plex Sans 500, 16/26,
                                                     --ink-muted, flush left,
                                                     no container

     The headline made me curious, but I           ← Source Serif 4, 19/31,
     was not ready to give it twenty minutes.        --ink, indented 2rem
                                              ┌──────────────┐
                                              │ TURN 3       │  ← mono, margin
                                              └──────────────┘

 Curiosity was enough to save it, but not
 enough to read it. What happened when you
 saw it again?
```

The participant's words are set as the primary text: larger, serif, full-strength ink. The interviewer's questions are smaller, sans, muted, unindented — apparatus. **The whole product thesis, rendered as type, on the screen where it matters most.** And it makes the transcript already *look like the source it will be quoted from*, so §4's trace gesture needs no special "evidence mode" — the document was always a document.

Three further changes on this screen, in order of how much they matter:

1. **The input becomes a textarea.** This is the highest-leverage single change in the product. Today it is `<input type="text">` with `onKeyDown={e => e.key === 'Enter' && handleSend()}` — a control that physically cannot show a paragraph and that *submits the moment someone tries to write one*. It actively punishes the exact behavior qualitative research exists to collect. Replace with an auto-growing textarea, 3 lines minimum → ~12 maximum, **set in the same serif at the same size the answer will appear in**, so the participant composes in the form they will be read in. **Enter inserts a newline; Cmd/Ctrl+Enter or the explicit Send button sends.** Placeholder: `Take as much space as you need.` No character counter — counters shorten answers.
2. **The phase machine becomes a sentence.** Five phases currently surface as a small header label plus anonymous dots. A participant who has agreed to 10–15 minutes deserves to know where they are: one line in the margin, `PART TWO OF FOUR · exploring what you said`, updating on transition. Dots communicate progress-bar anxiety; a sentence communicates respect.
3. **Sent answers set into the column** rather than flying into a bubble, with the turn number appearing in the margin as they land. The participant watches their own transcript being composed. It is a small thing and it is the entire emotional difference between "chatting with a bot" and "giving testimony."

**The receipt.** Today the participant ends at a spinner and the words "Interview submitted." Propose a real **participant receipt**: turns contributed, elapsed time, the server-issued consent timestamp in mono, the researcher's contact line, and — the humane move — **`Download your transcript`**. They just gave a stranger forty minutes of honest experience; they should be able to leave with a copy of what they said. The transcript is already in the client store, so this is a client-side blob download and a few lines of code. It costs nearly nothing and it is the clearest possible statement of what this product believes about who the words belong to.

**Failure states, per the fail-closed principle:** filled rubric block, white text, and the existing excellent copy — `The interviewer could not reply. This is not an AI reply.` Never a skeleton, never a shimmer, never a plausible-looking placeholder.

### 3.4 Researcher workspace

**Give it a shell.** There is currently none: `layout.tsx` renders a banner and children, and every page invents its own nav from `router.push()` buttons. Add a persistent rail — left at ≥1024px, top bar below — carrying exactly three fixed destinations (Studies, Settings, account) plus the current study's breadcrumb. One tab implementation; delete the second. Researchers should never again have to guess where "back" goes.

**`StudySetup.tsx` (1599 lines) becomes a document, not a form.** A study *is* a document that gets revised — research question, topic guide, profile schema, provider, consent text. Set it as a readable page at measure, with each section carrying an inline `Edit` that turns *that section* into fields while the rest stays readable. This kills the endless-scroll mega-form, matches how researchers actually think about a protocol, and makes the study revision system (already in the data model as `studyRevision`) legible: the document has versions, and you can see them.

**`Synthesis.tsx` and `InterviewDetail.tsx` get the Apparatus treatment** (§4) — which requires a data-model change, below.

### 3.5 The change that is not a design change (and is the most important item here)

The brief identifies the real gap correctly: the trace affordance exists in the demo and not in the product. **The reason is not the CSS. It is the schema.**

```ts
// today — src/types.ts
themes: { theme: string; evidence: string; frequency: number }[]
representativeQuotes: string[]   // AggregateSynthesisResult
```

`evidence` is a free-text paraphrase. There is no quote, no turn index, no interview id. **The provenance thesis is not in the data model**, so no amount of design can put it in the UI — the demo can only do it because its evidence is hardcoded to `answers[1]` at "turn 4."

Required:

```ts
export interface EvidenceRef {
  quote: string;        // verbatim, exact substring of the turn
  turnIndex: number;    // index into StoredInterview.transcript
  interviewId: string;  // required for aggregate; redundant per-interview
}

themes: { theme: string; evidence: EvidenceRef[]; frequency: number }[]
commonThemes: { theme: string; frequency: number; evidence: EvidenceRef[] }[]
divergentViews: { topic: string; viewA: EvidenceRef; viewB: EvidenceRef }[]
```

…plus the synthesis prompt returning it, plus **server-side validation that every `quote` is an exact substring of `transcript[turnIndex].content`, rejecting the synthesis if not.** That last clause is where "fail closed, never fabricate" stops being a slogan: a model that invents a quote produces an error, not a card.

This is a schema + prompt + validation change, not a styling change, and **it is the highest-value item in this entire proposal.** Everything in §4 is undesignable without it, and with it, §4 is a week of work.

---

## 4. The signature moment

**The quote comes to the claim.**

The study synthesis page. Desktop: measure column, 3rem gutter, 18rem margin column, left-anchored.

**Top of page.** No card, no icon, no container. An 11px rubric label — `BOTTOM LINE` — and then one sentence in Source Serif 4 at 28/40, full ink, at measure. A hairline rule beneath. That is the entire header. Compare to today: a `rounded-xl` gray box with a `Target` icon and an "KEY INSIGHT" eyebrow. The sentence is the insight; the box was never adding anything.

**The body.** Each theme is a passage — title in Plex Sans 600 at 17px, interpretation in serif at 19/31, at measure. And **every clause that rests on evidence carries a rubric superscript numeral**, inline in the running text, exactly as a footnote marker does. Not a chip. Not a badge. Not an underline with a tooltip. A footnote marker — implemented as a `<button>` so it is focusable, `aria-expanded`, and in the tab order.

**The gesture.** Click or press Enter on the marker and the quote **unfolds in the margin**, baseline-aligned to the line containing the marker:

```
 …the participant does not need more resurfacing;   ┌──────────────────────────┐
 they need the original spark restored, or         ─┤ “I had dozens of saved   │
 permission for the item to disappear.²             │  pieces, and nothing     │
                                                    │  told me why this one    │
                                                    │  had mattered.”          │
                                                    │                          │
                                                    │ TURN 4 · PARTICIPANT     │
                                                    │ Read in full transcript →│
                                                    └──────────────────────────┘
```

The verbatim in serif with real typographic quotes. Beneath it a mono coordinate line. A rubric bracket in the gutter connects the marker's line to the note. The marker fills from outline to solid. **Nothing above the fold point moves; the reading position never jumps.**

That last sentence is the whole point. *Checking provenance costs the reader nothing.* In the current product, verifying a claim means leaving the interpretation, finding the transcript, and losing your place — so nobody does it, and the product's central promise quietly goes unexercised. Here it costs a glance to the right. **A promise that is cheap to check is a promise people actually check**, and that is the difference between a research instrument and a product that says the word "provenance" on its landing page.

**Mobile:** identical markup, one grid change. The note unfolds inline directly beneath the paragraph, indented, rubric hairline on the left, same coordinate line. A footnote, degrading exactly as footnotes degrade.

**Keyboard and AT:** markers in tab order; Enter/Space toggles; Escape closes; the note is an `aria-details` region whose accessible name is the quote plus its turn coordinate, so a screen-reader user gets the verbatim *and* the provenance in one announcement — which is arguably a better experience than the sighted one.

**And the colophon.** At the foot of every synthesis page: a hairline rule, then 12px Plex Mono in `--ink-faint`:

```
Synthesized by anthropic/claude-… · study revision 12 · 2026-08-26 14:02 UTC · receipt a91f3c…
```

`SynthesisResult._receipt` already carries this and the UI currently shows none of it. Every printed scholarly edition ends with a statement of who made this object and how; every synthesis in this product should end the same way. It is the cheapest honesty feature available — the data exists — and it is the thing a peer reviewer will ask for.

---

## 5. What to keep

1. **The warm neutral ground.** The `stone` instinct is correct; warmth is what keeps a light theme from reading as a Google Doc. `--ink` is literally `stone-900`.
2. **A dedicated color for honesty.** Rare and correct. Amber → rubric, only because amber cannot hold text contrast on light and therefore cannot survive the polarity flip.
3. **The demo's accessibility engineering** — focus management across all four transitions, `role="log"`, `aria-live`, `data-testid` hooks, `min-h-11` targets, real focus-visible rings. This is the best code in the UI layer and it is exactly what reskins destroy. It must be a review gate on the redesign PR, not a hope.
4. **The disclosure copy, verbatim.** "Maya is fictional. Every response, follow-up, and insight is pre-written. No demo response leaves this page or survives a refresh." Do not touch it.
5. **The restraint.** One gradient, one blur, no sparkles, no purple, no emoji. Hold the line — and then go further: delete the one gradient (the shimmering preview banner, which also ignores `prefers-reduced-motion`) and the one `backdrop-blur`.
6. **Letterspaced labels as a device** — right in kind, wrong in dose. Keep the idea; take tracking from 0.16–0.18em down to 0.08em and size to 11px.
7. **`max-w-5xl` page width and the newer marketing dialect generally.** The brief is right that `Landing`/`Demo`/`self-host` are the better half of the codebase; Apparatus is a continuation of that half's discipline, not a repudiation of it.

---

## 6. Cliché audit

### Rejected outright

- **Dark-mode-only near-black + 1px-border card grid.** The house style of every 2025 dev tool.
- **Chat bubbles for anything that is not a text message.** The interview is a transcript.
- **A robot icon for the interviewer.** It makes a claim about the relationship that this product should not make.
- **An icon in front of every section heading.** Target, Lightbulb, TrendingUp, BarChart3 — dashboard tic, zero information.
- **Wide-tracked ALL-CAPS eyebrows above every block.**
- **The white pill CTA.** The "Vercel button."
- **Bouncing-dot "Thinking…", shimmer skeletons, and typewriter reveals.** Skeletons are especially wrong here: a product whose principle is *never fabricate a plausible substitute* should not draw fake content while waiting.
- **Gradient text, glow, glassmorphism, `backdrop-blur` chrome, sparkle-emoji-for-AI, purple-to-blue anything.**
- **Inter as the default identity.** It is the correct choice when you have decided not to have an opinion.

### New clichés my own direction risks importing — and the guardrails

- **"Editorial serif" is itself a 2023–25 trend** (the Substack/serif-revival look). Guardrail: **the serif is load-bearing, never decorative.** It marks verbatim source text and nothing else. No drop caps, no serif-italic pull quotes, no oversized tightly-tracked serif hero. If a serif appears anywhere that is not someone's actual words, it is a bug. This one rule is what separates Apparatus from a newsletter template.
- **Academic cosplay.** LaTeX mimicry, Computer Modern, faux page numbers, `op. cit.`, parchment textures, book-page drop shadows. All explicitly banned. We are borrowing the apparatus because it is *functional information design*, not because old books look smart. Texture budget is zero; there is exactly one shadow token in the system.
- **Marginalia layouts that shatter on phones.** The real failure mode of this direction. Guardrail: mobile is the designed case, the margin is the enhancement, and the collapse rule (§2.4) is specified before the desktop layout — not retrofitted after.
- **Rubric red misread as "error."** Guardrail: weight, not hue, carries severity. Provenance marks are thin and unfilled; failures are filled blocks with an icon; no destructive action ever wears a provenance treatment.
- **Hairlines-and-small-caps drifting into "law firm website."** Guardrail: the sans/mono chrome stays contemporary and tight, and it does all the interface work. The serif never touches a button.
- **Colophons and footnote markers becoming ornament.** Guardrail: if a marker does not resolve to a validated verbatim quote, it does not render. Provenance chrome that is sometimes decorative is worse than none, because it teaches people not to trust the marks.

---

## 7. Implementation notes for a contributor codebase

**Tokens.** CSS custom properties on `:root` and `[data-theme="dark"]`, surfaced to Tailwind v3 via `<alpha-value>`:

```ts
// tailwind.config.ts
darkMode: ['class', '[data-theme="dark"]'],
theme: { extend: {
  colors: {
    paper:  { DEFAULT: 'rgb(var(--paper) / <alpha-value>)',
              raised:  'rgb(var(--paper-raised) / <alpha-value>)',
              sunk:    'rgb(var(--paper-sunk) / <alpha-value>)' },
    ink:    { DEFAULT: 'rgb(var(--ink) / <alpha-value>)',
              muted:   'rgb(var(--ink-muted) / <alpha-value>)',
              faint:   'rgb(var(--ink-faint) / <alpha-value>)' },
    rule:   { DEFAULT: 'rgb(var(--rule) / <alpha-value>)',
              strong:  'rgb(var(--rule-strong) / <alpha-value>)' },
    rubric: { DEFAULT: 'rgb(var(--rubric) / <alpha-value>)',
              wash:    'rgb(var(--rubric-wash) / <alpha-value>)' },
    verdigris: 'rgb(var(--verdigris) / <alpha-value>)',
  },
  fontFamily: { sans: ['var(--font-plex-sans)', ...], serif: [...], mono: [...] },
  maxWidth:   { measure: '34rem' },
  borderRadius: { DEFAULT: '2px' },
}}
```

Store values as space-separated RGB triples so alpha works. No `stone-*` classes survive the migration; a grep for `stone-` is the completeness check.

**Primitives to build** — small, obvious, contributor-legible, ~10 files:

`Page` (measure + margin grid) · `Margin` (apparatus slot, collapses on mobile) · `Rule` · `Label` · `Coordinate` (mono, tabular) · `Passage` · `Turn` (one transcript turn, speaker-aware) · `Apparatus` (the marker + unfoldable note) · `Colophon` · `Button` (exactly three variants: primary / quiet / destructive) · `Field` · `Disclosure`.

**One dependency addition, justified:** `clsx` + `tailwind-merge` (~2 KB gzipped) for a `cn()` helper. Not cva, not shadcn, not Radix. Sixteen components currently hand-roll and drift every variant they have; a `cn()` and a dozen primitives is the smallest thing that stops the drift, and it is the version a first-time contributor can read in ten minutes.

**Sequence.** (1) Schema + validation from §3.5 — it unblocks everything and is not design work. (2) Fonts, tokens, `cn()`, primitives. (3) Participant interview: transcript typography + textarea + receipt — the flagship, and the change with the largest effect on real research data quality. (4) Synthesis Apparatus + colophon. (5) Demo reskin onto the shared primitives, with the a11y suite as the gate. (6) App shell + nav. (7) StudySetup as document. Landing can happen any time and is a good first PR for someone new.
