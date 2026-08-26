# Slice B — Participant flagship (Initiative 1, depends on Slice A)

Rebuilds `src/components/InterviewChat.tsx` and `src/components/Consent.tsx` onto the Verbatim system. Context: `docs/design/DIRECTION-final.md`. Prerequisite: Slice A primitives exist in `src/components/ui/`.

**Prime directive: this is a re-registering of the surface, not a logic rewrite.** Every store call, effect, handler, error path, preview-mode branch, header-building call, and disabled-state in both components must survive byte-for-byte in behavior. The greeting-effect ref discipline (`greetingStartedRef`, `mountedRef`), the retry flow, profile updates, phase transitions, `completeInterview`, the server-issued consent timestamp handling — all unchanged. If a change is not named below, do not make it.

## B1. Amendment A1 governs everything here

The participant live view carries **no visible apparatus**: no turn numbers, no citation marks, no mono coordinates in the transcript. Speaker identity is conveyed typographically (plus `sr-only` labels for screen readers). The scholarly register is researcher-side only.

## B2. `Consent.tsx` — from card to signed document

Layout: `min-h-dvh bg-paper-0`, single column at `max-w-measure` centered, generous vertical padding. No card container, no `bg-stone-700` header band, no Shield icon, no framer-motion entrance (remove `motion.div` entirely).

Top to bottom:
1. `Label` eyebrow: `Research consent` · study name as title — `font-serif` 28/36 `text-ink-900` weight 400.
2. Consent text: `font-serif` 17/28 `text-ink-700`, `whitespace-pre-wrap` kept.
3. Interview structure (all existing dynamic content kept — core-question count, follow-up note, feedback step, "Estimated time: 10-15 minutes"): a plain numbered list, `font-sans` 15/24; primary line `text-ink-900`, secondary 13px `text-ink-500`. No circle badges, no icons (remove MessageSquare, Clock, HelpCircle).
4. Data notice: the full existing copy verbatim, set as a fact block — `bg-paper-2` well, 13px, the provider-disclosure sentence in `font-mono`, the plain-English remainder in `font-sans` `text-ink-700`. Keep the `<strong>Data notice:</strong>` lead.
5. Provider-not-configured state: use the Slice A `Disclosure` primitive (filled ochre band) with the existing copy; keep `role="alert"`.
6. Consent error: keep `role="alert"`, restyle as filled error block — `bg-error text-paper-1 px-4 py-3 rounded text-sm`.
7. Actions: Back (preview mode only) = `Button variant="quiet"` (no ArrowLeft icon, word `Back`); consent = `Button variant="primary"` full-width, copy exactly `I consent — begin the interview` (em dash), submitting state shows the text `Recording consent…` (no Loader2 spinner — remove the import), keep `disabled` and `aria-busy` logic exactly.

## B3. `InterviewChat.tsx` — from chat app to interview transcript

Shell: `min-h-dvh` (replace `h-screen`) flex column, `bg-paper-0` throughout. Delete: all framer-motion (`motion`, `AnimatePresence`), all icons (Bot, User, MessageSquare, CheckCircle, Send, Loader2, ArrowRight), the backdrop-blur header, the bubbles, the progress dots.

### Running head
Sticky top, `bg-paper-0`, bottom hairline `border-ink-300` (no blur, no icon circle). Left: study name (`font-sans` 15 `font-semibold text-ink-900`, truncate) and beneath it the phase sentence 13px `text-ink-500` — keep `getProgressDisplay()` and the `phaseLabels` copy exactly (they are on the keep list). Right: `Finish early` as a quiet text button (13px `text-ink-500 hover:text-ink-700 underline-offset-2`), same visibility logic (`showFinishOption && !isComplete`). Progress dots: deleted, nothing replaces them (the sentence is the progress).

### Transcript
Scrolling region, `role="log"` + `aria-live="polite"` (mirroring the demo's discipline). Inside: one column `max-w-measure mx-auto`, turns separated by `space-y-8` (a multiple of the line), `px-4 py-8`.

Each message renders through the Slice A `Turn` primitive (`showCoordinate` NEVER set here):
- `msg.role === 'ai'` → `speaker="interviewer"`: `font-sans` 16/26 `text-ink-500`, flush left, `sr-only` prefix `Interviewer:`.
- `msg.role === 'user'` → `speaker="participant"`: `font-serif` 19/31 `text-ink-900`, indented (`pl-8`), `sr-only` prefix `You:`.

Markdown bodies: keep `ReactMarkdown`. Replace `prose prose-sm prose-invert` with a light class `prose-verbatim` added to `globals.css` under `@layer components`, styled with tokens (`color: rgb(var(--ink-900))` inherits from Turn; style `strong`, lists, `p` margins similar to the existing `.prose` block but token-based). Do not modify the old `.prose` block (demo still uses it until Slice D).

Keep the auto-scroll effect (`messagesEndRef`) exactly.

### Composing indicator (replaces "Thinking…")
When `isAiThinking`: at the transcript bottom, a container with `role="status"`: a 2px bar in `rgb(var(--ink-300))` that animates `width: 0 → 100%` over 1.4s ease-out and holds (CSS keyframe in globals under `@layer components`; `@media (prefers-reduced-motion: reduce)` → static full-width bar, no animation), and beneath it `Composing a follow-up…` 13px `text-ink-500`. No spinner, no bubble.

### Errors
Keep both error states, copy, `role="alert"`, and the retry wiring exactly. Restyle: filled error block `bg-error text-paper-1 rounded px-4 py-3 text-sm`; the `Try again` button inside as underlined `text-paper-1` (keep `disabled` logic).

### Input area
Bottom section, `bg-paper-0`, top hairline, `max-w-measure mx-auto` (not `max-w-3xl`):
- Replace `<input type="text">` with an **auto-growing `<textarea>`**: min height 3 rows (~76px), grows with content to a max of `40vh` then scrolls internally (implement autogrow via the `field-sizing: content` CSS property if supported, with a JS scrollHeight fallback — Codex judges the cleanest reliable approach; no new dependency).
- Typography: `font-serif` 17px/1.6 `text-ink-900`, `bg-paper-2 border border-ink-300 rounded px-4 py-3`, placeholder `Take as much space as you need.` in `placeholder:text-ink-500`. ≥16px font (prevents iOS zoom). Keep `id="interview-response"` + the `sr-only` label, keep `disabled={isAiThinking}`.
- **Key behavior: Enter inserts a newline. It never sends.** Cmd/Ctrl+Enter sends (guard `!isAiThinking && input.trim()`). The Send button always sends. Remove the old `onKeyDown` Enter-sends handler.
- Send control: `Button variant="primary"` with the word `Send` (no icon), keep `aria-label="Send response"` is no longer needed since the button has text — use the visible text; keep `disabled={!input.trim() || isAiThinking}`.
- Beneath the row, a 12px `text-ink-500` hint: `⌘/Ctrl + Enter to send` (hidden on coarse pointers via `[@media(pointer:coarse)]:hidden` or equivalent — touch users have the button).
- No character counter. Do not add one.

### Completion state
Replace the card + CheckCircle with a closing block at `max-w-measure mx-auto text-center`: heading `font-sans font-semibold text-ink-900` and the existing copy for both `viewMode` variants **verbatim**, then `Button variant="primary"` with the existing label logic (`Continue preview` / `Continue to save interview`), no arrow icon, keep `handleViewAnalysis`.

### The no-study fallback
`min-h-dvh bg-paper-0` + `text-ink-500` message, copy unchanged.

## B4. Ratchet

Remove `src/components/InterviewChat.tsx` and `src/components/Consent.tsx` from the ESLint legacy allowlist in `eslint.config.mjs`. Both files must then pass the ratchet (no `stone-`, no raw `font-serif` outside primitives — note: `font-serif` via the `Turn` primitive and the textarea class is the one place raw `font-serif` is needed in InterviewChat's textarea; if the ratchet blocks it, give the textarea its serif via a `.input-verbatim` class in `@layer components` or extend the ui-scope allowance — Codex picks the cleaner path and documents it).

## B5. Tests

- Update any existing unit tests that assert on the old structure (bubbles, input element, button labels, icons) while **preserving every behavioral assertion** (error copy, retry, consent recording, disabled states, aria attributes).
- New regressions in `tests/unit/`:
  - Enter in the textarea does NOT call send (message count unchanged); Cmd/Ctrl+Enter DOES send; Send button sends.
  - Textarea is disabled while thinking; send disabled on empty input.
  - Transcript container has `role="log"` and `aria-live="polite"`; turns carry sr-only speaker prefixes.
  - Consent: primary button disabled until provider configuration ready (behavior exists — keep/port the assertion); consent error renders with `role="alert"`.

## B6. Verification

```bash
npm run lint && npm run typecheck && npm run test
DEPLOYMENT_MODE=standalone npm run build
npm run test:e2e
```

Then a 375px visual inspection happens post-slice (orchestrator does this with Playwright screenshots — leave the dev server runnable).

## Hard constraints

Only `InterviewChat.tsx`, `Consent.tsx`, `globals.css` (additive: `prose-verbatim`, composing keyframe, optional input class), `eslint.config.mjs` (allowlist shrink), and tests may change. No store, service, type, or API changes. No other component. Do not commit. npm only.
