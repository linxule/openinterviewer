# OpenInterviewer — Design Direction

## 1. Named direction: Facing Pages

Qualitative research is not a chat. It is a relationship between two texts that must never be allowed to drift apart: the **witness** (what was said) and the **note** (what we claim it means). The interface is a book opened flat. Left page: the transcript, turn-numbered in the margin. Right page: the claim, with every sentence hanging off a lemma in that transcript. You cannot read an interpretation without seeing the page it came from.

This is right for OpenInterviewer specifically because the product’s thesis is already hiding in the demo — “Trace this insight in the transcript” — and then vanishing from `Synthesis.tsx` / `InterviewDetail.tsx`, which render the same ideas as disconnected stone cards. Facing Pages is that demo interaction promoted from easter egg to native structure. It also solves the typographic vacuum: a product whose soul is reading, listening, and interpreting human speech should look like a critical edition, not like a 2025 LLM console that happens to store quotes.

**Rival I considered and rejected: Warm Editorial Instrument.** Cream paper, Source Serif 4, amber honesty kept as a “tasteful” accent, chat bubbles restyled, light for participants / dark for researchers. That is where a competent consensus will land. It flatters the product’s self-image (thoughtful, academic, humane) without changing the metaphor. If you keep iMessage, you are still an AI chat app with nicer type. Provenance is a relationship between two texts; bubbles cannot express a relationship between two texts. I also rejected Oral History Archive (waveforms, portraits, Smithsonian blue) because this product has no audio and must not costume itself as if it did.

---

## 2. Visual identity

### Palette (actual hex)

Light is the default. This is a reading instrument. Dark-as-default is how the current UI became generic.

**Light (canonical)**

| Token | Hex | Role |
|---|---|---|
| `--desk` | `#E4E6E0` | Viewport, the surface the page sits on |
| `--paper` | `#F4F5F0` | The page |
| `--ink` | `#1E231F` | All primary type |
| `--ink-dim` | `#5C635C` | Meta, phase, captions |
| `--rule` | `#C5C9C0` | Hairlines, table rules, turn gutter |
| `--lemma` | `#B54A2C` | Iron oxide. Provenance only: lemma wash, honesty colophon, traced turns, “this is sourced” |
| `--lemma-wash` | `#EED5C8` | Background of a cited span. Ink stays ink on top of it |
| `--fail-ground` | `#F3E4E1` | Error field |
| `--fail-ink` | `#8C1D18` | Error type. Typeset, not glowing |

**Dark (opt-in, researcher night reading — never the participant default)**

| Token | Hex |
|---|---|
| `--desk` | `#121412` |
| `--paper` | `#161815` |
| `--ink` | `#E8EBE3` |
| `--ink-dim` | `#9AA198` |
| `--rule` | `#3A3F38` |
| `--lemma` | `#D47254` |
| `--lemma-wash` | `#3A241C` |
| `--fail-ground` | `#2A1614` |
| `--fail-ink` | `#F0B4AE` |

`--lemma` is **not a brand accent and not a button color.** 2025 products collapse brand, CTA, and “trust” onto one gold/violet/teal. Split them. Primary actions are ink filled, paper type. Secondary actions are a hairline rule and ink type. Oxide appears only when something is being *sourced, disclosed, or traced*. Honesty and evidence share a color on purpose: both are about not lying.

No stone scale. No amber-700. No white pills. The two accident colors in Settings/Load Sample (purple, blue) are deleted.

### Light/dark strategy

- Participants and the demo: light only. A wary person on a phone at a bus stop should not be dropped into charcoal.
- Researcher workspace: light default, a single “Night” toggle in the running head, persisted. Dark is a **microfilm field** — one continuous dark ground, luminous type, hairline rules. Not nested `stone-800` cards on `stone-900`. Inverted cards are how the current UI got its genre.
- Theme via CSS custom properties on `:root` / `[data-theme="night"]`. Tailwind v3.4 `extend.colors` maps to those variables. About **eight tokens**, not a 47-color system. Contributors can hold it in their head.

### Typography

Declared Inter and JetBrains Mono are never loaded; the app is OS-fallback sans. Treat that as permission to start from zero. Do not “finally load Inter.”

| Role | Face | Why this face |
|---|---|---|
| Speech and interpretation | **Gentium Plus** (SIL, Google Fonts, via `next/font`) | Designed for the diversity of human language, not for SaaS headings. Slightly dark, slightly irregular, excellent italics. The words people said, and the words we write about them, share one face. That is an ethical choice. |
| UI chrome, forms, nav | **Atkinson Hyperlegible** (Braille Institute, Google Fonts) | Distinctive without being fashionable. Awkward in a useful way (l/I/1, rn/m). Aligns with a product that has a11y tests and mobile participants. Not Inter, not Geist, not Plex Sans. |
| Apparatus | **Azeret Mono** | Turn numbers, model names, key fingerprints, timestamps, `SYNTHETIC`, phase sigla, token counts. JetBrains Mono is the 2025 AI-dev cliché; do not load it. Azeret is slightly wide, industrial, not a coding-app default. |

Scale (1.25 modular, from 16):

- Apparatus / turn numbers: 12/16 Azeret, tabular lining
- UI / body chrome: 14/20 and 16/24 Atkinson
- Transcript body: 18/30 Gentium Plus (`line-height: 1.67`). This is the product. Size it like a book, not like Slack.
- Claim / bottom line: 22/34 Gentium Plus italic, or 28/40 for the one-sentence finding
- Page titles: 40/48 Gentium Plus, tracking −0.01em. Not 700-weight geometric sans
- Running heads: 11/16 Azeret, letterspacing 0.04em, **sentence case**. Kill the 0.18em all-caps eyebrows.

Small caps, when needed, are Gentium’s real small caps (or `font-variant-caps: small-caps` with the Plus cut), never CSS-tracked Atkinson.

### Spatial system

- Base 8. Felt unit is the **line**, not the card.
- **Margin column: 3.25rem** on desktop, 2.25rem on mobile. Turn numbers live here. They are always visible. They are the product’s unit of evidence.
- Measure for speech: **36–40rem**. Do not let transcript lines run to `max-w-5xl`.
- Facing spread: max 88rem, two pages with a 1px `--rule` between them, not a gap of cards.
- Padding of a page: 2rem 3rem desktop, 1.25rem 1.25rem mobile (plus gutter).
- Radius: **0** for pages, tables, rules, transcripts. **2px** for inputs and buttons (ink trap, not a pill). No `rounded-xl`, no `rounded-2xl`, no `rounded-full` avatars.
- Elevation: none. No shadow, no blur, no gradient. Separation is rule + whitespace. The one existing `backdrop-blur` and the one gradient (preview shimmer) are deleted.

### Texture / shape language

Uncoated paper, not linen. No paper-fiber PNG, no deckled edge, no simulated spine, no page-curl skeuomorph. The “book” is a **layout system** (two columns, margin, lemma) not a costume. Hairline rules (1px `--rule`). Block quotes are a 2px `--lemma` bar in the gutter, not a card. Tables are ruled like a register. Buttons are rectangles. The shape of a turn is a **block of type with a numeral**, not a bubble with a tail (`rounded-br-md` in `InterviewChat.tsx` and `DemoSimulation.tsx` is the iMessage tell — kill it in both).

### Motion principles

Current motion is one pattern: fade-up. That is how every 2025 marketing page says “alive.” A record does not fade in; it is entered.

1. **No entrance fades** on transcripts, claims, or lists. They are there.
2. The only signature motion: **lemma travel**. Click a claim → the witness page scrolls so the cited span sits in the upper third → the span takes `--lemma-wash` in 160ms → the margin numeral switches from `--ink-dim` to `--lemma`. If `prefers-reduced-motion`, snap-scroll and wash with no duration.
3. View change (interview → insight, participant → researcher): 120ms dim of the whole page, replace, 120ms restore. Not a slide. Not a modal.
4. The interviewer composing: a blinking 1px rule at the next turn’s top, plus the typeset status `Interviewer is composing…` in the margin. No `Loader2` spinner inside a bubble labeled “Thinking…” — that is chatbot grammar and it implies a mind.
5. Fail closed: if the request dies, the rule stops blinking and a `--fail-ground` block appears with the existing honest copy (“This is not an AI reply”). Nothing that could be mistaken for a model utterance.

### Iconography stance

Lucide stays because it is already in the stack, but it is **workspace plumbing only**: settings, download, copy, chevrons, 16px, 1.75 stroke, `--ink-dim`.

Banned in interview, demo, synthesis, landing:

- `Bot` — the product must stop performing AI-ness
- `User` as a bubble avatar
- `ShieldCheck` as a trust totem (honesty is typeset, not badged)
- `Lightbulb`, `Target`, `Search` as section labels (the heading is the label)
- Progress dots

Prefer typographic marks: turn numerals, quotation dashes, `§` for phase, `¶` optional, a Gentium italic “l.” for lemma references (`l. 14` or `t. 14`). Section labels are words.

---

## 3. Experience architecture per journey

### Landing (curious visitors)

Do not open on a SaaS hero with two pills and three numbered cards. That screenshot is competent and forgettable. Open on a **working spread**.

- Full-viewport facing pages. Left: eight turns of the Maya study, already typeset, turn 4 lemma-washed. Right: the bottom line plus one interpretation sentence, with `t. 4` as a live lemma link. Running colophon at the top, full width, oxide on paper:

  `Scripted demonstration · Maya is fictional · no model · nothing is saved`

- Title sits above the spread in Gentium: “Follow the answer, not just the script.” Subtitle is one sentence, not a feature paragraph.
- Primary action is under the claim, ink rectangle: `Walk the path — 2 minutes`. Secondary is a text link: `Self-host the instrument`.
- Below the fold, a **table of contents**, not feature cards: Frame the study / Follow the thread / Trace the insight, as a numbered list with one sentence each. Then a ruled register of two rows: Configured workspace · Self-host. The current “Safe to try immediately” amber card is absorbed into the colophon. Do not make visitors read a disclaimer in a sidebar card *and* a banner later. Say it once, in the voice of a title-page printer’s note, then get out of the way.

Mobile: stack as page-then-page. Witness first (three turns, not eight), claim second, CTA after the claim. Do not hide the lemma wash; it is the argument.

### Demo (`/demo`)

Keep the three-act structure (intro → interview → insight). It is the best-designed flow in the repo. Change the *grammar*.

**Intro.** Drop the three how-it-works cards and the “synthetic study” rounded panel. One title page: study name in Gentium, research question in italic, a short protocol paragraph, the colophon, `Begin the scripted interview`.

**Interview.** Kill left/right bubbles. Single column, margin numerals, interviewer in Gentium roman, Maya in Gentium roman indented one em with `Maya` in Azeret 12 in the margin (not “Maya · fictional participant” inside the bubble — the colophon already said she is fictional; repeating it on every turn is anxious). Choices are not bordered mini-cards; they are a numbered list of possible next turns, each a full-width row with a hairline, hover = `--desk` wash. The progress bar (“Question 3 of 3” + “Scripted branch”) becomes a running head: `§ 3 of 3 · Fading curiosity`.

**Insight.** This is the first facing-page moment the visitor meets. Do not stack Bottom Line card / Evidence trail card / Hypothesis card / Nuance card. Right page is the note, in this order, as a *single typeset argument*:

1. Bottom line (Gentium 28 italic)
2. Theme (one line)
3. Lemma block: quoted span + `Maya · t. 4` as a button
4. Interpretation
5. Nuance (still on the same page — nuance is not a sidebar leftover)
6. Hypothesis to test, ruled off, labeled in Azeret `HYPOTHESIS` — it is a different speech act and should look like one

Left page is the transcript, dimmer (`--ink-dim`) except the lemma. “Trace this insight in the transcript” is redundant if the lemma is already live; make the quote itself the control. Keep “Replay another path” and “Set up your own instance” as a colophon of actions under the note.

The demo is loudly fictional. Keep every sentence of that copy. Retire the amber banner-as-genre. The colophon is always on, oxide rule, paper ground, Azeret 12.

### Participant interview (flagship)

`InterviewChat.tsx` is currently a dark iMessage clone: 80% bubbles, `Bot`/`User` labels, a single-line `<input type="text">`, “Thinking…”, progress dots, `rounded-br-md`. That is the wrong genre for someone giving a researcher their honest experience.

**Consent is a title page**, not a checkbox vibe and not a dark card. Study name, who is asking, what will happen, what is stored, that they can finish early, a signature-sized ink button: `I agree to be interviewed`. The server-side record stays; the design should feel like signing a protocol, not dismissing a cookie banner.

**The interview is a document being written.**

- Running head: study name · `§ Getting to know you` (use the existing phase copy; it is good) · `Finish early` as a quiet text action once past background
- Column of turns, numerals in the gutter, no bubbles, no avatars, no “Interviewer” robot. Interviewer unlabeled (or `Int.` in the gutter). Participant `You.`
- Input is a **textarea**, min 4 rows, looking like the next blank turn — a rule, a gutter numeral in `--rule` color, a caret. Placeholder: `Your turn`. Enter sends, Shift+Enter newline. This is non-negotiable for qualitative speech; the current single-line input is a structural insult to the answers the product exists to collect.
- Send control is the word `Send` in Atkinson, not a `Send` icon in a stone pill.
- Phase machine: **section titles**, not dots. Dots are survey UX and they imply a fixed script — the opposite of the tagline. When phase changes, a centered `§ Exploring further` rule appears in the transcript, like a chapter break, then the next interviewer turn.
- Completion is a closing colophon, not a success-circle: “Your responses have not been saved yet…” (keep that copy; it is ethically precise) and `Continue to save interview` as the ink button.

Mobile: this *is* the product for participants. Gutter shrinks but remains. Textarea gets the bottom of the viewport, large tap target, 16px+ to avoid iOS zoom. No sticky dark header with a blur.

Preview mode: the shimmer banner in `globals.css` is a cliché and it animates a lie-adjacent mood. Replace with a static colophon: `Preview · this conversation will not be stored`.

### Researcher workspace (the return surface)

There is no app shell. Every page builds its own `router.push` nav. Researchers have no orientation. Add one.

**Running head (persistent):** `OpenInterviewer` · current study title · `Night`.  
**Table of contents (left, 16rem, or a top register on mobile):** Protocol · Interviews · Analysis · Export · Settings. Not icons. Words. The current study is the object; the app is not a pile of tools.

**Dashboard** is a **register**, not a card grid. One ruled table: interview id, started, duration, phase/complete, synthesis yes/no, model used. A register says “these are records.” Cards say “these are tiles in a SaaS.”

**Study setup** (`StudySetup.tsx`, 1599 lines) should stop being a mega-form that feels like an admin panel. Treat it as **typesetting a protocol**:

- Left (or above, on mobile): live preview of the title page the participant will sign, and the opening turn.
- Right: the protocol in sections (`§ Research question`, `§ Topic guide`, `§ Consent language`, `§ Background fields`, `§ Model`). Not a 4-step onboarding wizard. Wizards are for products that think researchers are new users of software. They are not. They are writing an instrument.
- Onboarding (BYO key, BYO Upstash) is a **specification sheet**: three fields, what each is for, a fail-closed test (`Key refused · nothing was sent to a model`). No friendly illustrations. This is the one place the industrial tone should be blunt — it is how the product keeps its promise that the researcher owns everything.

**Analysis / synthesis (flagship, currently the gap that matters most).**

Do not reskin `Synthesis.tsx`’s flat cards. Rebuild it as Facing Pages, and **ship the demo’s trace into the real product**. That is the highest-leverage UX change in this entire revamp.

Desktop:

- Left page: full transcript, turn numbers, search that filters turns (not a floating command palette).
- Right page: the synthesis as a typeset note. Every claim that cites evidence is a lemma link (`t. 12–13`). Model name and time sit in Azeret under the title: `synthesized by claude-… · 2026-03-14` — provenance of the *interpretation*, which the product already records and currently under-shows.
- Aggregate analysis: still facing pages, but the left page becomes a **concordance** — the cited turns from many interviews, stacked, each labeled `P07 · t. 14`. The right page is the cross-interview claim. Never a claim without a way to open its witnesses.

Mobile (375px is in the review): pages stack; the note is first (researchers come for the claim); every lemma is a control that **replaces** the note with the transcript scrolled to the turn, with a `Back to note` running action. Not a modal sheet. A page.

Export should emit something that looks like this edition (HTML/PDF with gutter numbers and lemma markers), not only a CSV of fields. The design system is the research object.

---

## 4. Signature moment

**Click a sentence of interpretation, and the witness turns to the exact words.**

Concretely: in the researcher note, the line “Reconstructing purpose becomes part of the cost of reading” carries a gutter mark `t. 4`. Activate it. The left page scrolls. Turn 4’s numeral goes oxide. The quoted span takes `--lemma-wash`. The rest of the transcript stays readable, only dimmed. No ring around a bubble. No amber glow. No “jump to quote” toast. The book just… shows you the place.

Do this first in the real `Synthesis` / interview detail, then make the demo a faithful miniature of it (today the demo is the only place it exists). If we get only one thing right, this is the thing. It is the tagline made spatial: follow the answer, not just the script — and then follow the claim, not just the summary.

A visitor should be able to do this in the first 90 seconds of `/demo` without being taught. A researcher should do it a hundred times a week without noticing the UI, only the words.

---

## 5. What to keep

- **The honesty sentences.** “Maya is fictional.” “This is an interpretation, not a research finding.” “This is not an AI reply.” “Preview responses will not be added to study data.” “Your responses have not been saved yet.” These are the product’s moral spine. Make them typographic, do not rewrite them into brand voice, do not bury them.
- **Fail closed.** Errors as errors. Keep the retry pattern; restyle the container, not the policy.
- **Demo information architecture.** Intro → three scripted turns → researcher note → trace. Best screen in the repo (`DemoSimulation.tsx`). Steal its content hierarchy for the real synthesis.
- **Phase names.** “Getting to know you” / “Exploring further” / “Wrapping up” are humane and accurate. Keep the copy; lose the dots.
- **The restraint.** Almost no gradient, almost no blur, no sparkle, no purple. The newer marketing dialect’s *discipline* is correct; its *genre* (dark stone, rounded-2xl, letterspaced eyebrows, white pills, amber banners) is not.
- **Focus rings and demo a11y.** Focus management in the demo (choice fieldset, completion button, insight heading, evidence turn) is real craft. Extend that to the app. Recolor the ring to `--ink` (or `--lemma` when the focus *is* a lemma). Never `outline: none` on inputs (`globals.css` currently does this).
- **Open-source bluntness.** MIT, self-host, BYO key. Keep saying it. The landing’s “nothing is called, nothing is saved” is a competitive advantage; it should be a colophon, not a warning chip.
- **Lucide as a limited set, Tailwind without a component library.** Do not import Radix/shadcn to “professionalize” this. A contributor-maintained system of eight tokens, three typefaces, and a page layout will outlive a kit.

---

## 6. Cliché audit

**Rejected from the current UI and from 2025-AI genre**

- Near-black charcoal + stone cards + 1px border + 12–16px radius
- Letterspaced all-caps micro-labels (`RESEARCHER VIEW`, `BOTTOM LINE`)
- Amber/gold “trust” banners and amber focus rings
- White pill CTAs on dark
- Heavy geometric sans headings (and the Inter that was declared and never loved)
- JetBrains Mono as “we are builders”
- Chat bubbles with `rounded-br-md` tails
- `Bot` and `User` avatars
- `Thinking…` spinner
- Progress dots
- Fade-up entrance
- Shimmer/pulse preview banner
- Three feature cards with 01 / 02 / 03
- Dashboard as a grid of rounded tiles
- Dark-only as a personality

**Clichés this direction could import, and how it refuses them**

| Risk | Refusal |
|---|---|
| iA Writer / Medium / Ulysses “warm writing app” | Cool north-light paper (`#F4F5F0`), not cream. No fiber texture. No editor chrome. Atkinson, not a tasteful neo-grotesk. |
| Oxford University Press cosplay | No Loeb cloth colors, no university crest, no Baskerville-on-cream. Gentium is a field linguist’s face, not a prestige face. |
| Legal deposition / FOIA redaction | No Bates-stamp theatre, no black redaction bars. Oxide is a pencil, not a prosecutor. |
| Skeuomorphic book | No spine, no curl, no leather. Facing pages is a grid. |
| “Serious infra” Plex/IBM | Plex family not used. Azeret Mono only in the gutter. |
| Academic journal skin (Source Serif + navy + terracotta) | No navy. Oxide is reserved for provenance, not for headers. No two-column “article” of abstract/keywords. |
| Analog nostalgia (typewriter, tape, legal pad) | No Courier body, no yellow pad, no scan lines. The record is contemporary and sharp. |
| Gov-tech USWDS | Public Sans not used. We are not a portal. |
| Replacing one accent with another and calling it identity | Buttons are ink. Oxide does not appear on CTAs, links-in-nav, or “brand moments.” If oxide shows up, something is being sourced or disclosed. |

---

The test: a screenshot of the participant interview should be mistakable for a **critical edition of a conversation**. A screenshot of analysis should be mistakable for **a note written in the margin of that edition**. Neither should be mistakable for ChatGPT, for Notion, or for a qualitative-research SaaS circa 2025. If a contributor can implement it with eight CSS variables, three `next/font` loads, and a two-column grid, it is maintainable. If they cannot, we have made an art project and failed the brief.