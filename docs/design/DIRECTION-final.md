# Verbatim — the OpenInterviewer design direction (v1.0, decided 2026-08-26)

**One sentence:** The participant's exact words are the primary text; everything the system or the researcher says about them is a visibly subordinate, traceable annotation — and the interface is the warm, light, typeset document that makes that hierarchy legible at a glance.

**Provenance of this document:** synthesized from three independent proposals — "Marginalia" (Kimi), "Apparatus" (Opus), "Facing Pages" (grok-build) — then amended by an adversarial challenge (Kimi challenge lane, verdict: proceed amended, 9 amendments, all adopted). Decision points resolved by the project owner. Per amendment A3, three-model convergence is NOT cited as evidence anywhere; the direction stands on repo facts and the gates below.

---

## 1. Decisions of record

| Decision | Resolution | Decided by |
|---|---|---|
| Scope | Full experience: identity + UX flows, all journeys | Owner |
| Genre | Annotated-document / citation apparatus (not chat, not dashboard-SaaS) | Synthesis + challenge survival |
| Participant interview theme | **Light only.** One warm-paper palette. No toggle, no `prefers-color-scheme` auto-switch. Dark exists solely as a researcher-workspace toggle. (A6) | Owner |
| Typefaces | **Source Serif 4** (verbatim human speech + interpretation prose) · **Public Sans** (all UI chrome) · **IBM Plex Mono** (machine-verifiable facts). Three families, no display face — display is SS4 at weight 400, size does the work. Loaded via `next/font/google`, latin subset, swap. | Owner |
| Accents | **Kimi's three-hue architecture**: wine `#7A3548` = evidence-trace only · ochre `#96631C` = disclosure/synthetic/preview only · teal `#1E5851` = links, primary buttons, focus rings, active nav. Status: moss `#3F6B3B` success, terracotta `#B4432A` error (hue-distinct from wine so "cited" and "failed" never confuse). | Owner (overriding synthesis ★ of ink-buttons) |
| Amendments A1–A9 | Adopted as a package | Owner |

## 2. Palette (tokens)

Light — "Paper" (the identity; the only participant palette):

| token | hex | role |
|---|---|---|
| `--paper-0` | `#F7F3EA` | page ground |
| `--paper-1` | `#FBF8F1` | raised sheet |
| `--paper-2` | `#EFE9DA` | recessed well (quote blocks, transcript pane, input, code) |
| `--ink-900` | `#201D17` | headings / primary |
| `--ink-700` | `#3B362B` | body |
| `--ink-500` | `#746C58` | secondary / meta |
| `--ink-300` | `#DED5BE` | hairlines |
| `--evidence` | `#7A3548` | wine — citation numerals, trace rings, quote left-rules, turn tags |
| `--disclosure` | `#96631C` | ochre — synthetic/preview/consent honesty chrome, NOTHING else |
| `--action` | `#1E5851` | teal — links, primary buttons, focus, active nav |
| `--success` / `--error` | `#3F6B3B` / `#B4432A` | status only |

Dark — "Night" (researcher workspace toggle only): warm near-black family (`#1A1815` ground, `#ECE6D6` ink, accents tinted up: wine `#C97A8B`, ochre `#D9A84C`, teal `#5FA89E`). Never the participant flow, never the demo.

Implementation: CSS custom properties on `:root` / `[data-theme=night]`, surfaced through Tailwind v3 `extend.colors` with `<alpha-value>`. **Per A4: wine and ochre are NOT in the general Tailwind scale** — they live inside the Quote/Citation/Disclosure primitives via scoped custom properties. Teal is general (it's the conventional action hue and safe to expose). ESLint rule (CI) bans raw `font-serif`, raw evidence/disclosure hex, and any `stone-*` class outside `src/components/ui/`. Permanent CI grep for the old palette.

## 3. Typography rules (the two laws + conventions)

**Laws (lint-enforced via primitives):**
1. Serif (Source Serif 4) = verbatim human speech, consent text, and interpretation prose. If a serif appears anywhere that is not someone's words or a reading document, it is a bug.
2. Wine = evidence-trace. If wine appears, something is cited.

**Conventions (reviewed, not lint-enforced):** Plex Mono for machine-verifiable facts (turn numbers, timestamps, model IDs, receipt hashes, phase counters) with tabular numerals; ochre only for disclosure; labels 11px/0.08em tracking (never 0.14–0.18em); display = SS4 weight 400.

Scale (mobile → desktop): display 40/44→56/58 SS4 400 · bottom line 24/36→28/40 SS4 · page title 22/30→24/32 Public Sans 600 · verbatim body 18/29→19/31 SS4 · interviewer question 16/26 Public Sans 500 `--ink-500` · UI body 15/24 · meta 13/20 · coordinate 12/16 Plex Mono.

## 4. Spatial + shape

- Reading measure 34rem (~66ch) for documents; **measure never applies to tables/lists** (A2 triage density: dashboards are scannable ruled registers with keyboard nav, not reading columns).
- Margin/apparatus column 18rem on desktop; collapses inline (footnote-style, indented, wine hairline) below 1024px. Mobile is the designed case.
- Rules over boxes: 1px `--ink-300` hairlines structure the page; no nested gray cards. Radius: 0 structure · 2–4px controls · pill = status chip only. One shadow token (open citation note).
- Vertical rhythm: block spacing in multiples of the 28px body leading.

## 5. Motion

Quiet everywhere so one gesture reads as meaningful:
- Settle: 180ms, 4px rise, ease-out. No springs, no stagger, no 20px travel.
- **The trace** (the one special animation): wine border draws itself on (~400ms) around the cited turn / the citation note unfolds in the margin. Reduced-motion: instant, static.
- Composing indicator: a 2px rule draws left-to-right where the next question will set + "Composing a follow-up" in meta type. No spinner-in-bubble, no bouncing dots, no skeletons (a never-fabricate product does not draw fake content).
- Delete: the shimmer preview banner, the lone gradient, the lone backdrop-blur.

## 6. Iconography

Lucide, functional actions only (send/copy/download/close/chevron/external/check/alert), 16–18px. Delete all decorative section icons (Target/Lightbulb/Search/BarChart3/TrendingUp), the Bot and User avatars, progress dots. Sections are identified by typographic labels.

## 7. Experience architecture

### Participant (flagship) — with A1: two registers, one transcript model
- **Live interview view carries NO visible apparatus**: no turn numbers, no citation marks. One column, transcript grammar (no bubbles, no tails): interviewer questions in Public Sans 500 `--ink-500` flush left; participant answers in SS4 19/31 full ink, indented. Warm paper. Phase as humane sentence ("Part two of four · exploring what you said"), not dots.
- **Input: auto-growing textarea**, min 3 lines → ~40vh cap, set in the same serif the answer is read in. Desktop: Enter=newline, Cmd/Ctrl+Enter or Send button sends. Mobile: only the Send button sends. Placeholder "Take as much space as you need." No character counter.
- **Consent as a signed document**: SS4 at reading measure; provider disclosure as Plex Mono fact block; teal consent button; server `acceptedAt` timestamp shown back in mono.
- **Receipt**: turns contributed, elapsed time, consent timestamp, researcher contact, **Download your transcript** (Initiative 3 — ships only after the privacy/consent review; the words belong to the speaker).
- Failure: filled terracotta block, existing fail-closed copy verbatim ("This is not an AI reply"). Never a plausible placeholder.

### Researcher workspace
- **App shell**: persistent rail ≥1024px / top bar below — Studies · Settings · account + current-study breadcrumb; one Tabs implementation (delete the second); quiet footer line "Your keys · your database" in mono.
- **Dashboard/lists: ruled register tables** — id, started, duration, phase, synthesis?, model — scannable, keyboard-navigable, dense (A2).
- **Synthesis reading (the signature)**: `BOTTOM LINE` label + one SS4 28/40 sentence, hairline, then themed passages at measure. Every evidenced clause carries a wine superscript numeral (a real `<button>`, aria-expanded). Activate → **the quote unfolds in the margin**, baseline-aligned: verbatim in serif, mono coordinate line (`P07 · turn 12 · exploration`), "Read in full transcript →". Reading position never jumps; checking provenance costs a glance. Mobile: unfolds inline beneath the paragraph, footnote-style.
- **A7: this margin-unfold is THE canonical trace primitive, built once**, gated on the demo's a11y suite + 375px review. The InterviewDetail merged transcript-rail and the aggregate concordance are deferred follow-ups that MUST reuse the primitive; if they can't, the surfaces get rethought, not forked.
- **Provenance footer** (A2 vocabulary: plain facts, no "colophon" label in UI): `Synthesized by <model> · study rev N · <timestamp> · receipt <hash>` — from `_receipt`, which exists today and is never rendered.
- **StudySetup becomes a revisable document**: sections readable at measure, per-section inline Edit, making `studyRevision` legible. Onboarding as a blunt specification sheet ("Key refused · nothing was sent to a model").

### Demo
- Keep the state machine, focus management, `role=log`/`aria-live`, testids, min-h-11 — the a11y suite is a **review gate** on the redesign PR.
- Reskin onto the shared primitives; the insight view becomes the faithful miniature of the real trace.
- **A8: disclosure keeps interruptive weight** — the synthetic/preview banner is a FILLED ochre band, not a tasteful hairline; explicit check that "scripted demo" is perceivable at arm's length on a phone. Beautiful ≠ buried.

### Landing
Lead with a specimen, not a description: a real quote in SS4 28/40 with its margin interpretation and mono coordinate, above the fold, before any copy. Tagline becomes the caption to the demonstration. Three-step loop as one ruled column, not three cards. All copy kept verbatim.

## 8. The three initiatives (A5 partition — separate PR trains, separate gates)

**Initiative 1 — Design revamp (shippable alone, evidence still unlinked):**
tokens + fonts (`next/font` — none exists today) + `cn()` (clsx+tailwind-merge, the one dependency addition) + ~10 primitives (Page, Margin, Rule, Label, Coordinate, Turn, Citation, Disclosure, Button ×3, Field) → participant interview typography + textarea → app shell + register dashboard → demo reskin (a11y gate) → StudySetup document → landing.
**Gate (A9): after tokens/primitives, before the participant flagship completes** — 5-participant moderated test of the interview prototype (probe for self-editing: "did you consider how your answer would look to the researcher?"), with the pre-agreed fallback IN WRITING: if transcript register measurably chills disclosure, the participant view falls back to a bubble-adjacent conversational layout and the document register stays researcher-side. Plus a 3–5 researcher walkthrough scored on time-to-find-a-quote.

**Initiative 2 — Evidence traceability (fast-follow):**
`EvidenceRef { quote, turnIndex, interviewId }` replacing free-text `evidence` (`src/types.ts:171`) · synthesis prompt update (`src/lib/prompts/synthesis.ts`) · **normalized-matching validation** (Unicode quote/dash canonicalization, whitespace collapse, ellipsis-aware containment — NOT naive substring), with a measured false-rejection budget, a researcher-visible retry/repair path, and rejection-rate telemetry from day one · the trace UI on real data.

> **Status (2026-08-27):** Initiative 1 shipped (PR #9, slices A–G). Initiative 2 shipped in the same PR as slices I2a (schema/prompt/matcher), I2b (trace UI), and I2d (rejection-rate telemetry, counts only) — see `docs/design/initiative-2-spec.md` and its rulings. Two deliberate divergences from the sketch above: per-interview refs omit `interviewId` (the id does not exist at synthesis time; it stays reserved for aggregate refs), and there is **no repair path** — an unlocatable quote renders as an honest unverified passage, because repairing or substituting citation text would break the "never substitute a plausible research response" invariant. Aggregate citations (I2c) are specced but deferred; the A9 human-validation gates remain owed for both initiatives.

**Initiative 3 — Features (own reviews):**
participant transcript download (privacy/consent review against README boundaries) · InterviewDetail transcript-rail + aggregate concordance (reusing the trace primitive) · typeset HTML/PDF export.

## 9. Keep list (unconditional)
Every word of the honesty copy · fail-closed behavior · demo a11y engineering · phase names ("Getting to know you"…) · the tagline · the restraint (and go further: delete the last gradient and blur) · MIT/self-host/BYOK bluntness.

## 10. Kill list (unconditional)
Chat bubbles + tails · Bot/User avatars · "Thinking…" spinner · progress dots · decorative section icons · 0.14–0.18em ALL-CAPS eyebrows · white pill CTA · dark-by-default · nested gray cards · stray purple/blue · shimmer banner · fade-up-20px · confetti/celebration anywhere · Inter-as-identity · skeletons · genre vocabulary in user-facing copy ("colophon", "apparatus", "marginalia").

## 11. Self-audit (standing guardrails)
- Serif is load-bearing, never decorative — no drop caps, no serif buttons, no oversized tracked serif hero.
- No academic cosplay: no paper texture, no faux page numbers, no LaTeX mimicry. Texture budget zero; one shadow token.
- No twee Tufte-blog register: apparatus is functional or absent.
- Earth-tone-SaaS drift check: each hue has exactly one semantic job; if wine or ochre appears outside its primitive, CI fails.
- Marginalia layouts must be designed mobile-first; the margin is the enhancement.
