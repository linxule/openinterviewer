# Adversarial challenge verdict (Kimi challenge lane, 2026-08-26)

Run against `synthesis-draft.md` + `brief.md`. Kimi authored one of the three original proposals ("Marginalia") and was instructed to argue against its own prior work where warranted.

**Verdict: PROCEED AMENDED** — "the direction survives the challenge, but only after amendment; the synthesis as drafted would ship the wrong participant experience, an unscoped architecture change, and a validation mechanism that can break the product's core loop."

All key code facts underlying the synthesis were verified against the repo: single-line Enter-submits input at `src/components/InterviewChat.tsx:422-427`; free-text evidence strings at `src/types.ts:171` and `src/lib/prompts/synthesis.ts:94`; flat evidence rendering with no trace at `src/components/Synthesis.tsx:398`; the transcript/analysis tab split at `src/components/InterviewDetail.tsx:32,233-258`; `_receipt` present in the data model but never rendered (`src/types.ts:175,328`); fonts declared in `tailwind.config.ts:11-14` but no `next/font` anywhere in `src/`; no theme system in `src/app/globals.css`.

## Finding 1 — Participant-comfort attack: BENDS

Attack: participants are ordinary people on phones, not readers of critical editions. The register in which people disclose vulnerable things asynchronously is chat (iMessage, WhatsApp, BetterHelp). Kvale & Brinkmann frame the research interview as conversation; rapport literature ties candor to reduced social distance. Transcript grammar — words typeset in documentary serif, turns numbered in a margin, visibly structured as a record — is a demand-characteristic machine: every cue says you are being transcribed, indexed, and cited. Self-editing is the predictable result. "Dignified" and "observed" are the same aesthetic read from different power positions, and the participant is on the wrong side of it. The core inversion (participant words as full-ink primary text) flatters the researcher's gaze; the participant experiences their words as enlarged and made permanent. Kimi: "Marginalia's 'Lamplight' and transcript grammar were designed from the researcher's romance of the archive, not from the participant's nervous system."

Why it doesn't break: (1) the strongest candor lever is the textarea, independent of register — the current input is verified hostile; (2) the apparatus (turn numbers, citation marks) is only needed by the researcher — nothing requires the participant to see it. Bubbles don't create comfort; pace, acknowledgment, and input affordance do. Visible indexing creates surveilled-ness, and that part is a choice.

**Amendment A1 — Two registers over one transcript model.** Participant live view: transcript grammar without visible apparatus (no turn numbers, no citation marks); consent/status in plain warm prose; phase-as-sentence stays. Full apparatus reserved for researcher surfaces and the post-interview receipt. Before phase 3 is done: a moderated 5-participant test, transcript vs chat grammar, probing for self-editing ("did you consider how your answer would look to the researcher?"). If transcript register measurably chills disclosure, participant view falls back to a bubble-adjacent conversational layout. The fallback must be agreed now, in writing, or the test is theater.

## Finding 2 — Audience-mismatch attack: BENDS

Attack: core users live in Dovetail, Condens, Airtable, Notion — dense, utilitarian, keyboard-fast. Colophons, rubrication, lemma marks read to a corporate UX research team as "a humanities seminar performed at me" and "this team spent its budget on typography instead of my workflow." Worst case is not cosplay but slower scanning: editorial layouts privilege reading over triage, and triage is most of a working researcher's dashboard time. The design risks optimizing the researcher's self-image (careful scholar) over the researcher's Tuesday (forty transcripts, stakeholder deck due Friday).

Why it doesn't break: stripped of vocabulary, the researcher-facing mechanics ARE the industry feature set — "every claim traces to a verbatim quote with turn numbers" is Dovetail's core marketed differentiator. The colophon is provenance metadata that already exists in `_receipt`. The register-table dashboard is more Dovetail-like than the current card grid. The risk lives entirely in surface vocabulary and density.

**Amendment A2.** Keep every mechanic; strip genre from user-facing copy (no "colophon/apparatus/rubrication/marginalia" anywhere — the footer reads `Synthesized by <model> · study rev N · date · verified`). Triage density as explicit requirement: scannable rows, keyboard nav, no reading-measure constraint on tables/lists. Researcher walkthrough with 3–5 working UX researchers before phase 4, testing time-to-find-a-quote.

## Finding 3 — Brief-steering attack: FAILS as direction-killer, but voids the unanimity argument

Attack: three-way convergence proves ~nothing. The brief said "research instrument, not AI toy," "provenance is sacred," "soul is reading/listening," and disclosed the demo's trace as the best interaction — a maximally effective prompt for "scholarly apparatus." Three models sampling one input distribution is not three independent discoveries. A warmth-framed brief would have produced three warm-conversational proposals with equal unanimity.

Why it fails to break: steering explains the genre, not the fit. The fit is anchored in artifacts independent of the brief's prose: the invariants in AGENTS.md; the observable gap between the demo's trace and `Synthesis.tsx:398`'s unlinked strings. A differently-framed genre would have no answer for `src/types.ts:171`. The scholarly direction is the one that metabolizes the product's actual hardest problem — a merits argument, not an echo.

**Amendment A3.** Strike "three independent models converged" as evidence in every decision document. The direction stands on repo facts and the usability gates. Every ★ decision carries a single designer's confidence and is re-openable.

## Finding 4 — Maintainability attack: BENDS (the repo is the evidence)

Attack: the codebase cannot hold simpler rules today (radius drift, two tab implementations, stray colors, declared-never-loaded fonts, two dialects) — under the easiest possible law ("use stone and amber"). A semantic law (serif ONLY speech, wine ONLY evidence…) enforced by convention across drive-by OSS contributions rots by default: month 3 someone puts `font-serif` on a heading; month 4 wine becomes a destructive button; month 9 the system is inconsistent AND pretentious — the serif no longer reliably means speech, so the claimed soul (hierarchy readable by typeface alone) is noise. A dull one-family system is hard to get wrong.

Why it bends: a semantic law enforced by COMPONENTS rots an order of magnitude slower than one enforced by convention — the contributor's path of least resistance (drop in a primitive) is also the correct path.

**Amendment A4.** (a) Register semantics live inside primitives only: no `font-serif` utility, no wine/ochre in the general color scale — scoped to primitives via CSS custom properties. (b) ESLint rule banning raw `font-serif`, rubrication custom properties, direct hex outside `src/components/ui/`; runs in CI. (c) Cut the law to two rules (serif = verbatim speech, wine = evidence-trace); the rest is convention. (d) Permanent CI grep for the old palette. Fallback to one-family only if enforcement proves infeasible.

## Finding 5 — Scope attack: BENDS (the synthesis half-confesses)

Attack: the "design revamp" smuggles in (1) a data-schema migration touching prompt, validation, stored-record compat, aggregate path; (2) a new server-side rejection path in the fail-closed pipeline; (3) IA surgery (tab merge); (4) a participant-facing data feature (transcript download) interacting with consent/privacy boundaries; (5) a rendering pipeline (typeset export). Three initiatives wearing a design coat; the visual revamp risks being held hostage to schema-migration edge cases.

The substring validation is the most dangerous single line in the synthesis: LLM output paraphrases, elides ("…"), normalizes quotes/whitespace; exact substring matching rejects FAITHFUL syntheses at a non-trivial rate in a product with no fallback allowed. "Never fabricate" becomes "frequently fail."

Why it bends: the flagship (trace) is genuinely impossible without the schema work — you cannot build a citation interaction on an unlinked string. Cutting it makes the revamp toothless, not honest. The move is partition, not amputation.

**Amendment A5.** Three initiatives, separate PR trains and gates. Initiative 1 (design revamp) shippable alone with evidence still unlinked. Initiative 2 (EvidenceRef + prompt + validation + trace) as fast-follow, with NORMALIZED matching (Unicode quote/dash canonicalization, whitespace collapse, ellipsis-aware containment), a measured false-rejection budget, researcher-visible retry/repair, rejection-rate telemetry from day one. Initiative 3 (transcript download → privacy/consent review; typeset export later).

## Finding 6 — The D1 compromise nobody argued for: BENDS

Auto-`prefers-color-scheme` for participants is worse than both parents: it does not honor the trust argument (wary people at bus stops run dark mode; they get charcoal), outsources a trust-relevant decision to an OS setting correlating with nothing, and doubles the test matrix on the most trust-critical screen for a one-shot audience. Lamplight's defense ("alone at night, saying something honest") is romance — an imagined participant mood over a designed, consistent, tested trust register.

**Amendment A6.** Participant flow is light paper, one palette, no auto-scheme, no toggle. Dark lives in the researcher workspace. If post-launch evidence shows participants bouncing on light, earn dark as a deliberate second register — not a silent OS lottery.

## Finding 7 — "One citation vocabulary across three surfaces" is asserted, not designed: BENDS

Three evidence grammars (margin-unfold, sticky rail, concordance) = three implementations of the hardest interaction in the system, each with its own mobile degradation and a11y surface, in a codebase that maintains two tab implementations badly.

**Amendment A7.** Opus's margin-unfold is THE canonical trace, built once as a primitive, gated on the demo a11y suite + 375px review. Rail and concordance are deferred follow-ups that MUST reuse the primitive; if either can't, the vocabulary claim was false and the surfaces get rethought, not forked.

## Finding 8 — Beautiful disclosure is buried disclosure: BENDS

The current amber banners are LOUD (shimmer band you cannot miss). A disclosure that harmonizes with the page reads as decoration; the system optimizes away the interruption that makes "THIS IS SYNTHETIC" land. Beauty and salience compete; the synthesis optimized only one side.

**Amendment A8.** Disclosure/synthetic/preview surfaces keep interruptive weight — filled band, not hairline; ochre the hue but never at apparatus subtlety. Add an explicit prominence check: the synthetic label perceivable at arm's length on a phone (the actual threat model for a demo mistaken for real AI).

## Finding 9 — Zero humans were consulted: BENDS

The strongest form of Findings 1–2 is empirical, and three language models reading a brief written by no user cannot answer it. The participant-register and audience questions are testable, and the sequencing spends real money before either is tested.

**Amendment A9.** Validation gate after phase 2: 5-participant moderated test of the interview prototype (per A1's protocol) + 3–5 researcher walkthrough (per A2's), before phase 3 completes and any phase 4+ work. One week of testing against a multi-phase redesign.

## What the challenge could NOT kill

The textarea over the single-line input (verified hostile); the trace as signature moment (the product's thesis, currently demo-only); the colophon facts (data exists, never shown); serif-for-speech as hierarchy — provided A4's enforcement exists; the kill list of 2025 clichés.

## Amendments collected

A1 two registers / A2 mechanics-not-vocabulary + triage density / A3 void unanimity / A4 lint-enforced two-law system / A5 three-initiative partition + normalized validation / A6 participant light-only / A7 one canonical trace / A8 loud disclosure / A9 human validation gates.

**All nine adopted by the project owner, 2026-08-26.**
