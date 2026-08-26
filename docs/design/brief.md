# OpenInterviewer — Design Direction Brief

You are one of several independent designers asked for a **complete experience direction** for OpenInterviewer. Other designers are working in parallel; you will not see their work. Do not hedge toward a safe consensus — give us the direction *you* believe in, argued from the product's nature.

## What the product is

OpenInterviewer is an open-source platform for **adaptive, AI-assisted qualitative research interviews**. A researcher configures a study (research question, topic guide), shares an opaque link; participants are interviewed by an AI that follows their thread instead of marching through a script; the researcher reviews transcripts and a synthesis in a dashboard — every interpretation linked back to transcript evidence.

Tagline currently: "Follow the answer, not just the script."

## The three audiences / journeys

1. **Researchers** (academics, UX researchers, qualitative social scientists): login → onboarding (BYO AI key + BYO Upstash storage) → study setup → dashboard → transcripts, per-interview synthesis, aggregate analysis, export. This is a workspace they return to.
2. **Participants**: click an opaque link → consent screen → conversational interview → synthesis receipt → done. One-shot, often on mobile, possibly wary. The experience must feel respectful, trustworthy, humane — they are giving a researcher their honest experience.
3. **Curious visitors**: landing page → a keyless scripted demo (`/demo`) where they steer a fictional participant "Maya" through 3 branching questions and then see the researcher's evidence trail (bottom line → theme → verbatim quote → interpretation → nuance → hypothesis to test). The demo is loudly, honestly labeled synthetic — no AI calls, nothing saved.

## The product's ethical/intellectual character (design should embody this)

- **Evidence provenance is sacred**: every claim traces to a verbatim quote, with turn numbers. Synthesis records which model actually produced it.
- **Honesty chrome everywhere**: the demo repeatedly declares its own fictionality; preview mode never persists; consent is a server-side record, not a checkbox vibe.
- **Researcher owns everything**: their keys, their database, their data. Open source, MIT, self-hostable.
- **Fail closed, never fabricate**: an AI failure is an error, never a plausible substitute response.

This is a *research instrument*, built by people who care about rigor and consent. It is not an "AI magic" product.

## Current state (the problem)

The current UI is the 2025 "dark LLM product" genre: near-black charcoal background, dark-gray cards with 1px borders and ~12px radius, rounded chat bubbles, letterspaced all-caps micro-labels, a single amber/gold accent used for the "synthetic demo" trust banners, white pill CTA buttons, default-looking heavy sans headings. Dark-only. Competent and restrained — no purple gradients or sparkle emoji — but utterly generic: it could be any AI dev tool from 2025. Zero typographic identity for a product whose soul is *reading, listening, and interpreting human speech*.

## The ask

Propose a full experience direction. We want:

1. **A named design direction** — a concept with a point of view, and 2–3 sentences of why it is *right for this product specifically* (not just fashionable). Feel free to also name the strongest rival direction you considered and why you rejected it.
2. **Visual identity**: palette (actual hex values, light/dark strategy), typography (specific typefaces — Google Fonts or system stacks are what's practically available), spatial system, texture/shape language, motion principles, iconography stance.
3. **Experience architecture per journey**: how landing, demo, researcher workspace, and participant interview should each *feel* and *flow* — including any structural UX changes you'd argue for (not just reskinning). The participant interview and the evidence-trail/synthesis views are the flagship moments; be most specific there.
4. **The signature moment**: the one screen or interaction that, done right, makes someone say "oh, this is different." Describe it concretely.
5. **What to keep**: anything in the current design that is actually correct and should survive.
6. **Cliché audit**: name the 2025-AI-product clichés your direction is specifically rejecting, and check your own proposal for new clichés it might be importing.

## Code facts (from a full repo audit — trust these)

- Tailwind CSS **v3.4** (classic config), no component library, no Radix/shadcn, no `cn()`/cva. Every button/card/tab is hand-rolled inline Tailwind, duplicated across 16 flat components. Two tab implementations, drifting button variants, `rounded-xl` vs `rounded-2xl` vs `rounded-lg` inconsistency.
- **Fonts are declared (Inter, JetBrains Mono) but never actually loaded** — the whole app renders in OS-fallback sans today. Typography is a blank canvas.
- **No theme system at all**: dark is hardcoded (`bg-stone-900` on body and re-declared per screen), zero `dark:` variants, zero CSS custom properties, one custom token in the entire config (`stone-850`). Whatever token architecture you propose is greenfield.
- **No shared app shell**: `layout.tsx` renders only a preview banner + children. Every page builds its own ad-hoc nav from `router.push()` buttons with inconsistent membership. Researchers have no persistent orientation.
- Palette today is ~90% Tailwind `stone` (warm gray), amber as the honesty/disclosure accent, light-on-dark white CTA pills, two stray accident colors (purple on "Load Sample", blue in Settings).
- framer-motion used for exactly one pattern (fade-up entrance); one gradient and one backdrop-blur exist in the whole codebase. The restraint is real.
- Two visual dialects coexist: newer marketing/demo surfaces (`Landing`, `DemoSimulation`, `/self-host` — rounded-2xl, letterspaced eyebrows, amber, proper focus rings) vs older app surfaces (`Dashboard`, `StudySetup`, `Synthesis`, `Export` — rounded-xl, no focus rings). The newer dialect is the better one.
- Key screens by weight: `StudySetup.tsx` (1599-line mega-form), `StudyDetail.tsx` (934, tabs), `Settings.tsx` (772), `Onboarding.tsx` (616, 4-step wizard), `DemoSimulation.tsx` (583, best-designed screen), `InterviewChat.tsx` (450, the heart), `Synthesis.tsx` (505), `Dashboard.tsx` (427).
- **The gap that matters most**: the demo has a "Trace this insight in the transcript" interaction — click, jump to the exact quoted turn, ring it in amber, with turn-number provenance. The real researcher `Synthesis.tsx` / `InterviewDetail.tsx` have NO trace affordance — flat cards. The product's thesis exists in the demo but not in the product.
- The participant interview input is a single-line `<input type="text">` — no room to breathe for qualitative answers.
- The AI interview runs a phase machine: background → core-questions → exploration → feedback → wrap-up, currently surfaced as a small header label + progress dots.
- Repo (read anything you need): `/Users/xulelin/Documents/Apps/openinterviewer` — components in `src/components/`, config in `tailwind.config.ts`, `src/app/globals.css`, `src/app/layout.tsx`.
- Screenshots of the current UI (PNG, view them if you can): `/tmp/oi-shots/` — `landing-desktop.png`, `demo-desktop.png`, `demo-walk2.png` (mid-interview), `demo-walk4.png` (researcher evidence view), `login-desktop.png`, `landing-mobile.png`, `demo-mobile.png`.

## Constraints

- Stack: Next.js 16 (App Router), React 19, Tailwind CSS, framer-motion, lucide-react icons, react-markdown. Fonts realistically via next/font (Google Fonts or local files). No heavy new UI dependency without strong justification.
- Accessibility matters (there are a11y tests on the demo). Contrast, keyboard, reduced motion.
- Mobile: participants often arrive on phones; researcher UI is inspected at 375px in review.
- The honesty chrome (synthetic labels, consent clarity, provenance) is a non-negotiable *content* requirement — your design should make it beautiful, not bury it.
- This is open-source; the design system should be maintainable by contributors, not a bespoke art project.

## Output format

Write a structured proposal (markdown). Be concrete and opinionated. Actual hex values, actual font names, actual described layouts. Where you propose UX restructuring, say what moves and why. Length: whatever the direction needs — density over padding.
