# Fable's independent priors (written BEFORE reading panel proposals)

Recorded so synthesis can distinguish "the panel changed my mind with evidence" from "the panel wrote confidently."

## My read of the essence

The product's soul is **listening carefully and showing your work**. Three verbs: listen (interview), trace (evidence provenance), respect (consent, honesty chrome). It is a research *instrument* — the design should feel like a beautifully made tool for serious people, with warmth, because its raw material is human speech.

## Hypothesis: the strongest direction is editorial/archival, not dev-tool

- Nearest kin: field notes, oral-history archives, annotated transcripts, literary journals — not terminals.
- Type is the identity: a serious serif for reading surfaces (transcripts, quotes, synthesis) paired with a quiet sans for UI chrome; mono reserved for provenance metadata (turn numbers, model IDs, hashes). A quote set in real quotation typography is the product's "logo."
- Light mode should probably become primary (researchers read; paper is light), with dark as a supported theme. Participants on phones at night may prefer dark — theme system, not single-theme.
- Amber survives as the honesty/disclosure color — it's already the most distinctive element. Possibly promoted to a fuller role: the color of *provenance* (evidence rings, synthetic labels, preview banners — everything that says "here is the truth status of what you're reading").
- The signature moment should be the **evidence trace**: click an interpretation, see the exact quoted turn illuminate. This must ship in the real product, not just the demo.

## Risks with my own hypothesis (things the panel might rightly attack)

- "Editorial serif" is itself becoming a cliché (2024-26 wave: serif headers on every startup landing). The direction must be specific enough to escape the genre.
- Academic sobriety can tip into dull/dated; participants (not researchers) need warmth and ease, and might be better served by something softer than an archive.
- Two audiences may genuinely need two registers: instrument (researcher) vs conversation (participant). One identity, two voices — how?

## UX structural convictions (independent of visual direction)

1. Real app shell for researchers: persistent nav, orientation, no more per-page router.push clusters.
2. Interview input becomes a textarea with room to breathe; the interview screen should feel like being listened to, not like chatting with a bot (maybe de-bubble it).
3. Evidence-trace interaction in real Synthesis/InterviewDetail — the product must deliver the demo's promise.
4. Design tokens + small primitives layer (Button, Card, Tabs, Field) — Tailwind v3 tokens, maybe upgrade to v4 later; no heavyweight component library.
5. StudySetup mega-form needs progressive structure (sections/steps), not 1599 lines of scroll.
6. Load the damn fonts.

## Open questions for synthesis

- One theme or two (light+dark)? Who gets which default?
- How far to unify participant vs researcher registers?
- Is a rename/wordmark in scope? ("OpenInterviewer" is descriptive but flavorless — likely out of scope unless user wants it.)
