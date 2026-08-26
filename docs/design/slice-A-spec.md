# Slice A — Foundation (Initiative 1 of the Verbatim redesign)

Implementation spec. Context: `docs/design/DIRECTION-final.md` (the decided direction). This slice builds the token system, fonts, lint guard, and UI primitives. It must be **visually near-zero-change** for existing screens (the one intended visible change: Public Sans starts rendering instead of OS-fallback sans). No existing screen in `src/components/*.tsx` is restyled in this slice — that is Slices B–E.

## A1. Fonts (`src/app/layout.tsx`)

Load via `next/font/google` — **verify the exact Next 16 API in `node_modules/next/dist/docs/` before writing; do not trust training data**:

- `Source_Serif_4` — variable, latin subset, weights 400/600 + italic 400, `display: 'swap'`, CSS variable `--font-serif`
- `Public_Sans` — latin, weights 400/500/600, `display: 'swap'`, variable `--font-sans`
- `IBM_Plex_Mono` — latin, weights 400/500, `display: 'swap'`, variable `--font-mono`

Attach the three variable classNames to `<html>` (or `<body>`, per Next 16 docs). Keep the body's existing `min-h-screen bg-stone-900 font-sans antialiased` for now (screens still own their dark backgrounds until they migrate).

## A2. Tokens (`src/app/globals.css`)

CSS custom properties as **space-separated RGB triples** (for Tailwind `<alpha-value>`), plus one shadow token. `:root` = Paper (light, canonical). `[data-theme="night"]` = Night (researcher-workspace dark; wired later, defined now).

```css
:root {
  --paper-0: 247 243 234;   /* #F7F3EA page ground */
  --paper-1: 251 248 241;   /* #FBF8F1 raised sheet */
  --paper-2: 239 233 218;   /* #EFE9DA recessed well */
  --paper-pop: 255 255 255; /* #FFFFFF rare index-card pop */
  --ink-900: 32 29 23;      /* #201D17 headings/primary */
  --ink-700: 59 54 43;      /* #3B362B body */
  --ink-500: 116 108 88;    /* #746C58 secondary/meta */
  --ink-300: 222 213 190;   /* #DED5BE hairlines */
  --ink-200: 234 227 210;   /* #EAE3D2 faint dividers */
  --action: 30 88 81;       /* #1E5851 teal: links, primary buttons, focus, active nav */
  --success: 63 107 59;     /* #3F6B3B moss */
  --error: 180 67 42;       /* #B4432A terracotta */
  --evidence: 122 53 72;    /* #7A3548 wine — NOT exposed to Tailwind (see A3/A5) */
  --disclosure: 150 99 28;  /* #96631C ochre — NOT exposed to Tailwind */
  --disclosure-ink: 251 248 241;
  --shadow-note: 0 1px 2px rgb(32 29 23 / 0.08);
}
[data-theme="night"] {
  --paper-0: 26 24 21;      /* #1A1815 */
  --paper-1: 34 31 26;      /* #221F1A */
  --paper-2: 20 18 15;      /* #14120F */
  --paper-pop: 34 31 26;
  --ink-900: 236 230 214;   /* #ECE6D6 */
  --ink-700: 207 199 180;   /* #CFC7B4 */
  --ink-500: 167 158 136;   /* #A79E88 */
  --ink-300: 55 51 42;      /* #37332A */
  --ink-200: 45 42 35;      /* #2D2A23 */
  --action: 95 168 158;     /* #5FA89E */
  --success: 140 186 135;   /* #8CBA87 */
  --error: 217 138 117;     /* #D98A75 */
  --evidence: 201 122 139;  /* #C97A8B */
  --disclosure: 217 168 76; /* #D9A84C */
  --disclosure-ink: 26 24 21;
  --shadow-note: 0 1px 2px rgb(0 0 0 / 0.4);
}
```

Also in globals.css:
- **Delete** `input:focus, textarea:focus { outline: none }`. Replace with a token focus ring: `:is(input, textarea, select, button, [role="button"], a):focus-visible { outline: 2px solid rgb(var(--action)); outline-offset: 2px; }` and remove the old hardcoded `button:focus-visible` block.
- Keep the scrollbar and `.preview-banner`/`.prose` blocks untouched this slice (they die with their screens in later slices).

## A3. Tailwind config (`tailwind.config.ts`)

Extend (keep existing `stone.850` for legacy screens):

- `fontFamily`: `sans: ['var(--font-sans)', 'system-ui', 'sans-serif']`, `serif: ['var(--font-serif)', 'Georgia', 'serif']`, `mono: ['var(--font-mono)', 'ui-monospace', 'monospace']`
- `colors` (RGB-triple pattern `'rgb(var(--x) / <alpha-value>)'`): `paper.{0,1,2,pop}`, `ink.{900,700,500,300,200}`, `action`, `success`, `error`.
- **Deliberately absent**: `evidence` and `disclosure` are NOT in the Tailwind scale (amendment A4 — they are reachable only inside `src/components/ui/` primitives via `var(--evidence)` / `var(--disclosure)` arbitrary values or scoped CSS).
- `maxWidth: { measure: '34rem' }`
- `boxShadow: { note: 'var(--shadow-note)' }`

## A4. `cn()` helper (`src/lib/cn.ts`)

`npm install clsx tailwind-merge` (lockfile updated; use npm, never bun/yarn — `package-lock.json` is authoritative). `export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)) }`.

## A5. ESLint ratchet (`eslint.config.mjs`)

Add a flat-config entry enforcing the design law in **new/migrated code only**, via a legacy allowlist that later slices shrink:

- `files: ['src/**/*.{ts,tsx}']`
- `ignores`: the 16 existing screen components (`src/components/Landing.tsx`, `DemoSimulation.tsx`, `InterviewChat.tsx`, `Synthesis.tsx`, `Consent.tsx`, `Dashboard.tsx`, `InterviewDetail.tsx`, `StudyList.tsx`, `StudyDetail.tsx`, `StudySetup.tsx`, `Settings.tsx`, `Onboarding.tsx`, `Export.tsx`, `Login.tsx`, `OAuthLogin.tsx`, `PreviewBanner.tsx`), `src/app/layout.tsx`, and `src/app/self-host/page.tsx`. Add a comment: “Verbatim migration ratchet — remove each file from this list as its slice migrates it.”
- Rule: `no-restricted-syntax` matching string literals/template chunks containing `stone-` (Tailwind stone classes), `font-serif` (raw serif utility — serif is only reachable through primitives), or `var(--evidence` / `var(--disclosure` — each with a message pointing at `docs/design/DIRECTION-final.md`.
- A **second** entry for `files: ['src/components/ui/**']` that re-allows `var(--evidence` / `var(--disclosure` and `font-serif` (the primitives are exactly where those live) but still bans `stone-`.
- `npm run lint` must pass with zero warnings after this (the gate is `--max-warnings=0`).

## A6. Primitives (`src/components/ui/`)

All typed, all accept `className` merged via `cn()`, all forwardRef where the element is interactive. No framer-motion in primitives. These APIs are the contract — keep names and props exactly:

1. **`Button.tsx`** — `variant: 'primary' | 'quiet' | 'destructive'` (default `quiet`), extends `ButtonHTMLAttributes`. primary: `bg-action text-paper-1 hover:opacity` (subtle); quiet: `border border-ink-300 text-ink-900 bg-transparent hover:bg-paper-2`; destructive: `bg-error text-paper-1`. Radius `rounded` (2–4px — set Tailwind default radius usage `rounded-sm`/`rounded`, never `rounded-xl+`). Padding `px-4 py-2`, text 15px/`font-medium`, `font-sans`.
2. **`Label.tsx`** — `<span>` (or `as`-less, just span): 11px, `font-semibold`, `uppercase`, `tracking-[0.08em]`, `text-ink-500`. Prop `tone?: 'default' | 'evidence' | 'disclosure'` switching color to the scoped vars (evidence/disclosure tones use inline `style={{ color: 'rgb(var(--evidence))' }}` style — allowed here only).
3. **`Rule.tsx`** — `<hr>`: `border-0 border-t border-ink-300`, prop `strong?: boolean` → `border-ink-500/40`… no: strong uses `--ink-500` at full: `border-t border-[rgb(var(--ink-500))]`? Keep simple: `strong` → `border-ink-500`.
4. **`Coordinate.tsx`** — `<span>` mono 12px `text-ink-500` `[font-variant-numeric:tabular-nums]`. For machine-verifiable facts (turn numbers, timestamps, model ids).
5. **`Disclosure.tsx`** — the filled ochre band (amendment A8: interruptive, never a hairline): `role="note"`, background `rgb(var(--disclosure))`, text `rgb(var(--disclosure-ink))`, `px-4 py-3`, 14px `font-medium`, optional `title` (bold lead-in) + children. No dismiss affordance.
6. **`Turn.tsx`** — one transcript turn. Props: `speaker: 'interviewer' | 'participant'`, `turnIndex?: number`, `showCoordinate?: boolean` (default false — participant live view never shows it, per A1), `children`. interviewer: `font-sans text-[16px] leading-[26px] text-ink-500`; participant: `font-serif text-[19px] leading-[31px] text-ink-900 pl-8` (indent). When `showCoordinate` and `turnIndex` present, render `<Coordinate>` `t. {turnIndex}` in a margin slot (grid col on `md+`, above the text on mobile).
7. **`Citation.tsx`** — the canonical trace primitive shell (amendment A7). Props: `label` (e.g. `t.4`), `children` (the note content: quote + coordinate), controlled or uncontrolled `open`. Renders a `<button>` superscript: mono 11px, wine border/text via scoped var, `rounded-[2px]`, `aria-expanded`, `aria-controls`; the note region `role="region"` with the quote in `font-serif`, left border 2px wine, `shadow-note`, unfold animation 240ms `cubic-bezier(0.2,0,0,1)` translateY(4px)+fade, `@media (prefers-reduced-motion: reduce)` → no animation. Keyboard: Enter/Space toggles (native button), Escape closes when open and focus is within.
8. **`Field.tsx`** — labeled form control wrapper: renders `<label>` (Label styles) + slot for `input`/`textarea`/`select` children styled `bg-paper-2 border border-ink-300 rounded px-3 py-2 text-ink-900 font-sans`; focus ring comes from globals. Include `hint?` (13px `text-ink-500`) and `error?` (13px, `text-[rgb(var(--error))]`… use `text-error`) lines.
9. **`Page.tsx`** — layout: `<div>` with `max-w-[66rem] mx-auto px-5 md:px-12`; and export **`Measure`** (`max-w-measure`) and **`WithMargin`** (grid `md:grid-cols-[minmax(0,34rem)_3rem_18rem]`, children slots `main` + `margin`; below `md` the margin content renders inline after main, indented with a `--ink-300` left border).
10. **`index.ts`** — barrel export.

## A7. Tests (`tests/unit/`)

jsdom vitest, following existing test conventions in `tests/unit/`. Smallest realistic regressions:
- `ui.button.test.tsx` — three variants render distinct classes; native button semantics; className merge works (cn dedupe).
- `ui.disclosure.test.tsx` — `role="note"`, title + children text visible.
- `ui.turn.test.tsx` — participant vs interviewer typography classes; coordinate hidden by default, shown only with `showCoordinate` + `turnIndex`.
- `ui.citation.test.tsx` — button has `aria-expanded=false`, click → `true` + region visible, Escape closes, `aria-controls` id wiring.

## A8. Verification (must all pass, in order)

```bash
npm run lint          # zero warnings, ratchet rule active
npm run typecheck
npm run test          # includes new ui tests
DEPLOYMENT_MODE=standalone npm run build
npm run test:e2e      # demo untouched — must still pass
```

## Hard constraints

- Do NOT modify any file in `src/components/*.tsx` (the 16 screens) or any `src/app/**/page.tsx`. Only: `layout.tsx` (fonts), `globals.css`, `tailwind.config.ts`, `eslint.config.mjs`, `package.json`+lock, new files under `src/components/ui/` and `src/lib/cn.ts`, new tests.
- Do not commit; leave the working tree for review. Preserve unrelated dirty files (`docs/` is untracked — leave it).
- Preserve the Next-managed block in `CLAUDE.md`; never touch `.claude/` or `.env*`.
- npm only (`package-lock.json` authoritative). Node ≥ 24.19.
