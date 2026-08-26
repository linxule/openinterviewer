# Kimi's proposal: "Marginalia" (2026-08-26, via kimi-ask, grounded in repo)

Files read: DemoSimulation.tsx, InterviewChat.tsx, Synthesis.tsx, Landing.tsx, Consent.tsx, Dashboard.tsx, InterviewDetail.tsx, globals.css, tailwind.config.ts, plus the brief.

## 1. Named direction: Marginalia

Every screen is an annotated document, not a chat app: human words sit in a reading column set in a real text face; every claim carries a citation mark that pulls the exact cited turn into view beside it, like a note in the margin of a manuscript. One structural device — reading column + citation rail — exists in embryo in the demo's "Evidence trail" and is missing everywhere it matters (`Synthesis.tsx`, `InterviewDetail.tsx`).

Why right for THIS product: the ethical claims ("every interpretation linked back to transcript evidence," "researcher owns everything," "fail closed") are claims about citation discipline. A design language borrowed from scholarly apparatus isn't decoration on the claim; it IS the claim, made visible on every screen. It also differentiates hard from the dark-charcoal AI genre, which has no citation vocabulary at all.

Rival rejected: **"The Deposition"** — court-reporter register (mono-forward, exhibit stamps, stenographer line numbers, redaction bars). Even more literally about evidence, but its emotional register is adversarial and clinical; depositions exist inside conflict. The participant journey needs respectful/trustworthy/humane. Marginalia keeps the deposition's citation rigor housed in a reader's register, not a litigator's.

## 2. Visual identity

### Palette — Paper (light, default for landing/demo/researcher)
`--paper-0 #F7F3EA` page · `--paper-1 #FBF8F1` raised · `--paper-1-pop #FFFFFF` rare index-card pop · `--paper-2 #EFE9DA` recessed well · `--ink-900 #201D17` headings · `--ink-700 #3B362B` body · `--ink-500 #746C58` secondary · `--ink-300 #DED5BE` hairlines · `--ink-200 #EAE3D2` faint dividers

### Lamplight (dark — proposed default for participant interview only; RETRACTED under challenge, A6)
`--lamp-0 #1A1815` · `--lamp-1 #221F1A` · `--lamp-2 #14120F` · `--lamp-ink-900 #ECE6D6` · `--lamp-ink-500 #A79E88` · `--lamp-border #37332A`
Original argument: participant is alone, at night, on a phone, saying something honest — a quiet low-stimulation surface is kinder; "a reading lamp, not a dev tool at night"; same warm ink family as Paper — one brand at two times of day.

### Accents (three hues total, one job each)
- `--evidence` wine `#7A3548` (dark: `#C97A8B`) — quote left-rules, citation numerals, trace ring/underline, turn tags
- `--disclosure` ochre `#96631C` (dark: `#D9A84C`) — synthetic/preview/consent honesty chrome, nothing else
- `--action` ledger-teal `#1E5851` (dark: `#5FA89E`) — links, primary buttons, focus rings, active nav
- Status: `--success` moss `#3F6B3B`, `--error` terracotta `#B4432A` — deliberately hue-distinct from wine so "cited" and "failed" never confuse.

### Typography (four families, two registers)
- Display: **Fraunces** (variable, optical axis), 500–600, italic pull-quotes — literary, university-press-book-jacket, not SaaS.
- Reading: **Source Serif 4** 400/600 for HUMAN words — transcript turns, markdown, consent text, synthesis prose. The single highest-leverage typographic decision: today every word renders in OS-fallback sans in a bubble; text-weight serif at 16–18px/1.6 signals "this is being read carefully," which is the product's value proposition.
- UI: **Public Sans** — deliberate rejection of Inter; a face designed for U.S. government digital services carries a public-record register fitting "consent is a server-side record," open-source, researcher-owns-everything.
- Data: **IBM Plex Mono** — turn numbers, timestamps, phase counters, JSON, citation tags.
Editorial register (Fraunces + SS4) = anything a human said or interpretation of it; institutional register (Public Sans + Plex Mono) = anything the system is telling you. A reader can tell which is which by typeface alone.

### Spatial / shape / texture
Base 4px; density over padding (`px-3 py-2` chrome); generous leading only for reading prose. Radius 2–4px = cut paper edge; pill reserved for status chips only (each shape gets exactly one meaning, fixing the current radius drift). Rules over boxes: 1px hairlines and occasional 2px ledger rules instead of nested bordered cards. The recurring grid: ~66ch reading column + sticky right citation rail (240–280px desktop); on mobile the rail collapses to inline footnote-numeral disclosures — never a second scrolling region.
No gradients (kill the preview shimmer — a shimmering marquee is the wrong register for sober disclosure); no glow; blur only functional; tabular numerals for counts ("counted and citable," not gamified).

### Motion
Keep the restraint; turns fade+rise 6–8px/~170ms, no bounce ("casual companion app" is the wrong weight for testimony being recorded). THE one special animation: the citation trace — smooth scroll + a wine border that draws itself on over ~400ms (stroke-dashoffset), a pen underlining a passage, not a flash-highlight. Full reduced-motion fallback. No confetti/celebration anywhere — this content is often emotionally loaded; celebratory motion would feel performative.

### Iconography
Keep lucide, use less: strip decorative header icons; reserve for interactive affordances and true status.

## 3. Experience architecture

**Landing:** Paper, Fraunces serif H1; disclosure as solid ochre-tint printed label. Structural: reproduce the quote → citation → interpretation pattern statically above the fold (today the landing only describes the trace in prose). Extract a shared AppShell top nav.

**Demo:** keep state machine + a11y wholesale; rebuild skin as the reference implementation of the citation rail. Bubbles → manuscript turns (no tails; left speaker rule — teal interviewer, gray participant, wine reserved for evidence; sans speaker label over serif body). Insight view = literal column + rail; mobile collapses inline.

**Researcher workspace:**
1. Build the missing AppShell (persistent left rail; active state = thin left border, not filled pill).
2. **Merge InterviewDetail's transcript/analysis tabs into one screen** — highest-priority structural change: the tab split forces choosing between the claim and the words that support it, exactly the adjacency the thesis depends on. Requires theme/claim data to carry a turn index — the single most valuable schema change; `theme.evidence` is currently a flat string with no pointer into the transcript.
3. Aggregate synthesis: same treatment + per-theme "sources" strip (mono interview chips) so aggregate claims trace to which participants.
4. StudySetup: break the 1599-line mega-form into left-nav'd paper sheets (Basics · Research question & topic guide · Profile schema · AI provider · Consent text).
5. Onboarding as "provisioning your own instrument": numbered mono steps, paper sheets.
6. Persistent quiet footer: "Your keys · your database" in mono — ownership ethics as ambient always-visible status, not Settings copy. (Flagged as a gap in the brief.)

**Participant interview:**
1. Replace the single-line input with an auto-growing textarea — min 3 lines, ~40vh cap, SS4 17px/1.6. Desktop Enter sends; mobile requires the explicit Send button (return = newline).
2. No character counter (performance anxiety).
3. Phase surfaced honestly: mono micro-label "2 / 5 · core questions," no animated fill-bar.
4. Manuscript turns, same grammar as demo — from "texting a chatbot" to "being interviewed and recorded thoughtfully."
5. Lamplight dark by default (later retracted, A6).
6. Consent rebuilt as a document: SS4 at reading size; provider disclosure in mono to distinguish fact from plain-English consent; solid teal consent button, sharp corners (currently visually equal to every secondary button).
7. Receipt minimal; no confetti.

## 4. Signature moment
Reading a synthesis, every claim has a citable footnote that pulls the exact quoted moment into view beside it, live. Click the wine superscript numeral → the sticky rail smooth-scrolls to the cited turn; the turn's border draws on in wine ink; a mono meta-line resolves: "Priya · participant · turn 12 · exploration phase." Keep reading the interpretation while the rail re-centers — a finger in two pages of a book at once. No competitor ships persistent structural click-to-source citation as the default way of reading a synthesis; it exists only in this product's own scripted demo.

## 5. What to keep
Demo interaction architecture + a11y wholesale · honesty-chrome content and voice exactly (typeset better: mono for facts, serif for plain English, ochre instead of translucent amber) · fail-closed error handling verbatim · the instinct behind the restraint · the tagline. Pushback on the brief: DemoSimulation is the best-ENGINEERED screen, not best-designed — its architecture is the template; its skin is not worth preserving as reference.

## 6. Cliché audit
Rejected: charcoal-by-default; rounded-2xl bubble-soft cards; chat bubbles with tails; Inter/generic grotesk; purple gradients/sparkles; icon-plus-microcopy on every header; confetti; gamified progress bars; decorative glass.
Self-audit: Fraunces-on-cream is an indie-SaaS signal (mitigation: identity carried by the citation-rail IA, not the typeface); footnote aesthetic risks twee Tufte-blog (mitigation: no vintage texture, no drop caps, strictly functional); muted three-hue palette risks Notion-earth-tone (mitigation: each hue has one non-negotiable semantic job with a specific referent — sealing-wax wine, caution-label ochre, ledger-book teal).

---
Note: in the subsequent adversarial challenge, Kimi retracted Lamplight ("designed from the researcher's romance of the archive, not from the participant's nervous system") — participant flow is light-only per amendment A6. Fraunces was dropped in synthesis (three families, not four). The teal action hue was adopted by owner decision.
