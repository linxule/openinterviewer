# OpenInterviewer redesign — Synthesis draft (v1, pre-challenge)

Three independent proposals: **Marginalia** (Kimi), **Apparatus** (Opus), **Facing Pages** (grok-build). All three converged, blind, on the same genre: the scholarly citation apparatus — the interface as an annotated document where human speech is the primary text and every interpretation is a traceable note on it. My own pre-panel priors (recorded separately) also pointed here. Caveat honestly held: the brief's framing ("research instrument, not AI toy") tilted the field; an adversarial pass must attack the genre itself before we commit.

## The unanimous core (adopt unless the challenge breaks it)

1. **Thesis made visible**: participant's words are the primary text (serif, full ink, reading measure); the AI interviewer and all interpretation are typographically subordinate annotation. Inverts the current hierarchy where the bot gets an avatar and equal weight.
2. **Kill chat-bubble grammar everywhere**: one column, two speakers differentiated by type and indentation, turn numbers in a margin/gutter — printed-oral-history grammar, not iMessage.
3. **Light, warm paper as identity** (exact defaults contested below); dark exists but is not the brand. "Dark-by-default is itself the 2025 cliché."
4. **Serif for verbatim human speech only; sans for chrome; mono for machine-verifiable facts** (turn numbers, timestamps, model IDs, receipt hashes). Register split = content hierarchy readable by typeface alone.
5. **A dedicated provenance/disclosure ink** — rubrication. Never on buttons, never brand decoration. When it appears, something is being sourced or disclosed.
6. **Rules and whitespace over boxes**: hairlines, radius ~0–4px, no nested gray cards, no shadows (or one token), no gradients, no glassmorphism.
7. **Kill list (unanimous)**: Bot/User avatars, decorative section icons (Target/Lightbulb/Search), progress dots, 0.14–0.18em all-caps eyebrows, white pill CTA, "Thinking…" spinner-in-bubble, shimmer preview banner, fade-up-20px entrances, confetti anywhere.
8. **Textarea for answers** — auto-growing, set in the same serif the answer will be read in, min 3–4 rows. The current single-line `<input>` that submits on Enter "actively punishes the exact behavior qualitative research exists to collect" (unanimous, near-verbatim across all three).
9. **Phase machine as humane sentence** ("Part two of four · exploring what you said"), not dots.
10. **Consent as a signed document**, typeset at reading measure, provider disclosure as mono coordinate, server timestamp shown back to the participant.
11. **App shell for researchers** — persistent nav, one tabs implementation, breadcrumb; end per-page router.push clusters.
12. **Schema before styling — THE prerequisite**: `EvidenceRef { quote, turnIndex, interviewId }` replacing free-text `evidence` strings, synthesis prompt updated, and (Opus) **server-side validation that every quote is an exact substring of the referenced turn — fabricated quote ⇒ synthesis rejected**. Extends "fail closed, never fabricate" to interpretation itself. Kimi independently confirmed the same gap in code.
13. **Signature moment: the trace** — click a claim's citation mark; the exact quoted turn appears/illuminates with its coordinate. Ships in the real product (Synthesis, InterviewDetail, aggregate), demo becomes the faithful miniature. Motion: the one "special" animation in the system; everything else stays quiet so it reads as meaningful.
14. **Colophon on every synthesis**: `synthesized by <model> · study revision N · timestamp · receipt hash` — data already exists in `_receipt`, currently never shown.
15. **Keep, verbatim**: all honesty copy; fail-closed error behavior; demo a11y engineering (focus management, role=log, aria-live, min-h-11) as a review gate on the redesign PR; the existing restraint.
16. No shadcn/Radix import. Tokens (~10 CSS custom properties), 3 font loads via next/font, `cn()` (clsx+tailwind-merge) and ~10–12 primitives (Page, Margin/Rail, Rule, Label, Coordinate, Turn, Apparatus/Citation, Colophon, Button ×3 variants, Field, Disclosure). Grep for `stone-` as the migration completeness check.

## Genuine decision points (user decides; my recommendation marked ★)

### D1 — Participant interview theme
- grok + Opus: participants ALWAYS light ("a wary person at a bus stop should not be dropped into charcoal"; "no toggle, no decision").
- Kimi: participant interview defaults DARK — "Lamplight," warm near-black: alone, at night, on a phone, saying something honest; low-stimulation is kinder. Same warm ink family, "a reading lamp, not a dev tool at night."
- ★ My synthesis: **follow the participant's own `prefers-color-scheme`** — light paper by day-preference, Lamplight warm dark by dark-preference. No toggle UI. Least presumptuous: the participant's device already knows their context. Both palettes warm, same family. (Researcher workspace: light default + persisted Night toggle — unanimous anyway.)

### D2 — Spatial grammar for evidence
- grok: full facing spread (transcript page | note page).
- Opus: single anchored measure + margin apparatus; footnote marker unfolds the quote INTO the margin, baseline-aligned — "the quote comes to the claim; reading position never jumps." Best mobile degradation (footnote collapse).
- Kimi: reading column + sticky live transcript rail; click scrolls & rings the turn; explicitly merges InterviewDetail's transcript/analysis tabs.
- ★ These compose by surface rather than compete: **per-interview synthesis reading → Opus's margin-unfold** (quote comes to you); **InterviewDetail → Kimi's merged column + live transcript rail** (you're navigating the whole document); **aggregate analysis → grok's concordance** (cited turns from many interviews stacked as the left page). One citation-mark vocabulary across all three.

### D3 — Typefaces
- Speech serif: Source Serif 4 (Opus + Kimi) vs Gentium Plus (grok). ★ Source Serif 4 — two votes, purpose-built for extended screen reading; Gentium's charm is real but its argument is more ideological than functional.
- UI sans: Plex Sans (Opus) vs Public Sans (Kimi) vs Atkinson Hyperlegible (grok); all three reject Inter. ★ Public Sans — Kimi's register argument is the best fit: a face literally designed for public digital services suits a product whose ethic is records, consent, and public ownership; also dodges grok's "Plex = serious-infra cliché" flag.
- Mono: Plex Mono (Opus + Kimi) vs Azeret (grok). ★ Plex Mono.
- Display: Kimi adds Fraunces as a 4th family. ★ Reject — Fraunces is the loudest indie-SaaS trend signal in any proposal; Opus's move (serif at weight 400, size does the work) is quieter and stronger. Three families, not four.

### D4 — Accent architecture
- grok: ONE accent (iron oxide) = provenance AND disclosure ("both are about not lying"); buttons are ink.
- Opus: rubric (~same hue) for editorial voice; failure = same ink, filled weight; verdigris for confirmed-recorded.
- Kimi: THREE hues — wine (evidence), ochre (disclosure), teal (actions); terracotta error kept hue-distinct from wine.
- ★ My synthesis: **ink buttons (grok/Opus — most distinctive, most disciplined); wine for evidence-trace; ochre for disclosure/synthetic/preview (direct heir of the current amber — continuity of meaning); moss success + terracotta error as status-only**. Splitting evidence from disclosure is right: "this is cited" and "this is synthetic" are different truth-statuses, and conflating them overloads one mark. Drop teal: with ink buttons there is no action hue to need.

### D5 — Unique ideas to adopt regardless of the above
- **Participant receipt + "Download your transcript"** (Opus) — the words belong to the speaker; client-side blob, ~free. ★ Adopt.
- **"Your keys · your database" ambient footer** in researcher shell (Kimi). ★ Adopt.
- **StudySetup as revisable document** with per-section inline edit (Opus), sectioned sheets (Kimi) — same instinct. ★ Adopt Opus's form (makes `studyRevision` legible).
- **Dashboard as ruled register table**, not card grid (grok). ★ Adopt.
- **Export emits a typeset edition** (HTML/PDF with gutters + citation marks), not only CSV (grok). ★ Adopt as later phase.
- **Composing indicator**: Opus's self-drawing 2px rubric rule + "Composing a follow-up" vs grok's blinking rule. ★ Opus's.
- Mobile send: explicit Send button sends; Enter = newline on mobile (Kimi); Cmd/Ctrl+Enter on desktop (Opus). ★ Combine.

## The unrepresented case (for the adversarial pass)
No proposal argued: (a) participants may be SERVED by familiar chat idiom — comfort of the known register vs the dignity of the transcript register; (b) industry UX researchers (not academics) may read scholarly apparatus as pretentious cosplay; (c) three-typeface editorial systems are harder for OSS contributors to keep coherent than one sans; (d) the entire panel may have been steered by the brief's own framing. The challenge round must make the strongest version of these.

## Sequencing (Opus's, amended)
1. EvidenceRef schema + substring validation (unblocks everything; not design work)
2. Fonts, tokens, cn(), primitives
3. Participant interview (typography, textarea, receipt) — flagship
4. Synthesis trace + colophon (per-interview), InterviewDetail merge
5. Demo reskin on shared primitives (a11y suite as gate)
6. App shell + nav; Dashboard register
7. StudySetup as document; aggregate concordance; typeset export
Landing anytime — good first PR.
