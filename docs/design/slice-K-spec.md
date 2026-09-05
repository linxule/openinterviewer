# Slice K — The participant page is a page (Initiative 3, Move A; depends on Slice H)

Turns the flagship participant surface from a chat app into a document. The composer stops being a viewport-pinned pane and becomes the last block of the transcript, indented and set in the serif it will be read in. The `h-dvh` pane split dies and the page itself scrolls. The centered "conversation complete" panel becomes a left-aligned closing block at measure. The "Interview submitted" screen becomes a receipt with a mono fact block. Context: `docs/design/initiative-3-brief.md` (Move A: A1, A2, A3; decisions of record 3) and `docs/design/DIRECTION-final.md` §3 (type scale), §4 (spatial, radius, rhythm), §5 (motion), §7 "Participant (flagship)", §9 (keep list), §10 (kill list).

**Prerequisites: Slice H (`5cf7a71`, merged `840de8a`).** H already applied D3 (consent pluralization) and D7's three class strings in `InterviewChat.tsx` and two in `Consent.tsx`. This slice reads those files as they now stand, not as `slice-B-spec.md` left them.

**Rebase order with Slice I.** Both slices edit `src/components/Synthesis.tsx`. Slice I owns the researcher/preview branch (`Synthesis.tsx:269–498`, from which C1 extracts `SynthesisReading`) and the `Synthesis.tsx:8` import line. **Slice K touches `Synthesis.tsx:195–267` and nothing else in that file, and adds its one new import as a separate statement after line 10 rather than editing line 8.** With that discipline the two diffs are disjoint by line and the rebase is mechanical. K rebases onto I when I lands; they are not merged the same day without a joint visual pass (brief, "Proposed slices and order").

**Prime directive: this is a layout and register change, not a logic rewrite.** Every store call, effect, handler, ref, guard, error path, preview branch, and disabled expression survives byte-for-byte in behaviour. In `InterviewChat` that means `mountedRef`, `greetingStartedRef`, the greeting effect and its dependency array, the autogrow fallback effect, `handleSend`, `handleTextareaKeyDown`, `handleRetryGreeting`, `handleFinishEarly`, `handleViewAnalysis`, `getProgressDisplay`, `phaseLabels`, the memoized `InterviewTurn`, and the no-study fallback. In `Synthesis` that means the whole completion apparatus above line 195 — `sameCompletionInputs`, `isCurrentAttempt`, `activeAttempt`, `doSave`, `handleRetrySave`, `handleRetryAnalysis`, the analyze-and-save effect, and the four-state `participantState` ladder. In `Consent` that means `handleConsent`, `handleBack`, the `providerDisclosure` chain, and `providerConfigurationReady`. The two auto-scroll effects in K1.6 are the **only** new behaviour in the slice, and they are specified line by line. If a change is not named below, do not make it.

## K0. Laws that bind this slice

- **Tokens only.** `bg-paper-*`, `text-ink-*`, `border-ink-*`, `text-action`, `text-success`, `text-error`. `eslint.config.mjs:6–43` enforces this across all of `src/**` with no allowlist. Raw `font-serif` outside `src/components/ui/**` is a lint error — the composer gets its serif from `.input-verbatim` in `globals.css`, exactly as it does today.
- **Light only.** No `dark:` variant, no `data-theme` read or write, no `prefers-color-scheme` branch. Every file in this slice is participant-facing (DIRECTION §1, A6).
- **No apparatus in the live view (A1).** No turn numbers, no citation marks, no mono coordinates anywhere in `InterviewChat`. `Turn` is rendered without `showCoordinate`, as today. Mono appears in this slice at exactly one place: the A2 receipt, which is not the live view.
- **Radius: 0 for structure, `rounded` for controls.** The textarea keeps its `rounded` (it is a control). Nothing else in these files gains one.
- **Honesty copy is verbatim (§9).** Not one word changes in: `This is not an AI reply — please try again.` (via `The interviewer could not start. This is not an AI reply — please try again.`), `The interviewer could not reply. Please try sending again.`, `Your responses have not been saved yet. Continue to finalize and save your interview. Keep this tab open until you see confirmation that it is safe to close.`, `Continue to generate the preview analysis. Preview responses will not be added to study data.`, `Take as much space as you need.`, `Composing a follow-up…`, `Finish early`, `Your responses have been saved. It is now safe to close this tab.`, `We are preparing and saving your responses. Keep this tab open until you see confirmation that it is safe to close.`, `Your responses are still in this tab, but they have not been saved. Keep this tab open and try again.`, `Your responses are still in this tab. Keep it open and retry the save before closing.`, `No study configured.` Layout, type sizes and leading change; strings do not.
- **No new dependency.** No scroll library, no `react-intersection-observer`, no virtualization. The auto-scroll discipline in K1.6 is one `scroll` listener and one ref.
- **Behaviour byte-identical except where named.** No `role` is removed, no accessible name changes, no heading level changes. Two roles are added on purpose: the `<main>` landmark in K1.1, and nothing else.

---

## K1. A1 — the composer becomes the last block in the document flow

`src/components/InterviewChat.tsx`, plus one line of `src/app/globals.css` and one export in `src/app/layout.tsx`.

### K1.1 The shell: kill the pane split

`:308` `<div className="flex h-dvh flex-col bg-paper-0">` → `<div className="min-h-dvh bg-paper-0">`.

This is the whole of the kill. `InterviewChat.tsx:308` is the only `h-dvh` left in `src/` — every other full-height surface in the repo is already `min-h-dvh` (`Consent.tsx:84`, `Synthesis.tsx:205`, `Export.tsx:202`, `Landing.tsx:21`, `Login.tsx:110`). The flagship was the outlier.

Then wrap the transcript and the composer in a `<main>`:

```tsx
<div className="min-h-dvh bg-paper-0">
  <header className="sticky top-0 z-20 …">…</header>
  <main>
    <div role="log" aria-live="polite" className="relative">…</div>
    {isComplete ? <closing block/> : <composer/>}
    <div ref={messagesEndRef} />
  </main>
</div>
```

**Why a `<main>` is added and why it is the only new landmark.** The two participant pages either side of this one already have one (`Consent.tsx:84`, `Synthesis.tsx:205`); the interview page has none, so a screen-reader user has no landmark to jump to and no skip target. The existing `<header>` is unchanged and continues to expose `banner` — it is not nested inside the new `<main>`, and moving it inside would silently demote it. Exactly one `main` element exists on the page; `PreviewBanner` renders `role="note"` (`ui/Disclosure.tsx:13`) and is not a landmark competitor.

**Sticky depends on there being no `overflow` ancestor.** `position: sticky` is inert if any ancestor between the sticky box and the scrollport has an `overflow` other than `visible`. After this change the chain is `html` → `body` (`layout.tsx:43`, `min-h-dvh bg-paper-0 font-sans text-ink-700 antialiased`, no overflow) → the root `div` → `<main>` → the composer. **Do not add `overflow-hidden`, `overflow-y-auto`, or `overflow-clip` to any of them**, and do not reintroduce one on the log. K5 pins this with a test rather than a comment, because the failure mode is silent.

### K1.2 The running head — unchanged except its stacking order

`:310` keeps every class and both children. Change `z-10` → `z-20`.

The head and the composer are now both sticky against the same scrollport. They only meet when the composer grows toward its 40vh cap on a short viewport; when they do, the head must win, because the phase sentence is the participant's only orientation. `Finish early` keeps `showFinishOption && !isComplete` and its classes verbatim.

**Known preview-only artifact, do not fix here.** `PreviewBanner` is `sticky top-0 z-50` (`PreviewBanner.tsx:30`) and renders above `{children}` in `layout.tsx:44`. In researcher preview both it and the running head pin at `top: 0`, and the ochre band covers the head. This is pre-existing — today's document is already `banner height + 100dvh` tall, so ~48px of scroll produces the same collision — but A1 makes the document long, so it is now visible for the whole interview. Fixing it means giving `PreviewBanner` a measured height as a custom property that the head can offset against, which is a shell change in a file no Initiative 3 slice owns. Name it in the handback; see Open question 1.

### K1.3 The transcript — a region, not a scrollport

`:331` `<div role="log" aria-live="polite" className="relative min-h-0 flex-1 overflow-y-auto bg-paper-0">` → `<div role="log" aria-live="polite" className="relative">`.

`role="log"` and `aria-live="polite"` stay on this element — they are pinned by `InterviewChat.greeting.test.tsx:387–388`. `relative` stays, and so does its comment (reworded: the element is no longer a scroll container, but Tailwind's `.sr-only` is `position: absolute`, and without a positioned ancestor those speaker prefixes resolve against the initial containing block and can inflate the document's scroll height — which now *is* the page's scroll height, so the hazard is larger, not smaller). `bg-paper-0` is dropped: the root div paints the ground.

`:332` the inner column keeps `mx-auto max-w-measure space-y-8 px-4 py-8` exactly. `space-y-8` (32px) is the shipped rhythm between turns and becomes the gap between the last turn and the composer; do not retune it.

`:337–344` the composing indicator stays inside the log, unchanged, including its `role="status"` and the `.composing-bar` keyframe. `:342`'s `Composing a follow-up…` is on the keep list.

`:346` the `messagesEndRef` div **moves out of the log and becomes the last child of `<main>`, after the composer**. See K1.6.

### K1.4 The composer sits outside the log region — and why

The composer block is a **sibling of the log, inside `<main>`, after it**. It is not inside `role="log"`.

Three reasons, in the order that decides it:

1. `aria-live="polite"` announces every mutation inside its region. The composer contains a `<textarea>` whose value changes on every keystroke, an error block that appears and disappears, and a hint line. Screen readers already echo typed characters from the control itself; a live region wrapping that control makes them announce the participant's own words back a second time.
2. The error block carries `role="alert"` (`:372`), an assertive live region. Nesting an assertive region inside a polite one is a documented double-announcement hazard, and the string it announces (`This is not an AI reply — please try again.`) is the one string in this component that must be heard exactly once and immediately.
3. The ARIA `log` role describes a sequence of entries added over time. A form control is not an entry. The transcript is the log; the composer is how the participant adds to it.

Nothing is lost by the separation: the composer is in DOM and tab order immediately after the transcript (`Finish early` → textarea → `Send`), its label is `Your response` (`:390–392`), and it is reachable without the live region.

**The constraint this must not break:** `InterviewChat.greeting.test.tsx:394` reads `log.querySelectorAll('.sr-only')` and requires `You:` and `Interviewer:` to resolve *inside* the log element. The turns stay inside. Only the composer moves out.

### K1.5 The composer block itself

`:368` `<div className="border-t border-ink-300 bg-paper-0 px-4 py-4 sm:px-6">` becomes:

```tsx
<div className="sticky bottom-0 z-10 border-t border-ink-300 bg-paper-0 px-4 py-4 sm:px-6">
```

`sticky bottom-0` is the whole mechanic. When the transcript is shorter than the viewport the block sits at its natural position, directly under the most recent interviewer turn, and nothing moves. When the transcript is longer, the block pins to the bottom of the viewport and the transcript scrolls beneath it. `bg-paper-0` and the top hairline are already there and are what make the pinned state opaque; do not make them translucent and do not add a blur (§10).

**No bottom spacer is needed under the transcript.** Because the composer is the last block rather than a fixed overlay, at maximum scroll it releases to its natural position and the final turn is fully above it. This is the property that a `position: fixed` composer does not have, and it is why A1 specifies in-flow-plus-sticky rather than fixed.

**No safe-area padding.** `env(safe-area-inset-bottom)` resolves to `0` unless `viewport-fit=cover` is set, and K1.8 deliberately does not set it. Do not add `pb-[env(safe-area-inset-bottom)]` or equivalent.

`:369` the inner column `<div className="mx-auto max-w-measure space-y-2">` gains the participant indent:

```tsx
<div className="mx-auto max-w-measure space-y-2 pl-8">
```

`pl-8` is `Turn`'s participant indent (`ui/Turn.tsx:31`), so the composer's left edge lands on the same axis as the participant's own answers in the transcript above it. Sitting the field where the answer will appear is the whole argument of A1; a flush-left field would read as chrome again.

**Type: the field is set in the register the answer is read in.** `:402` `text-[17px] leading-[1.6]` → `text-[19px] leading-[31px]`. 19/31 is `Turn`'s participant register (`ui/Turn.tsx:31`) and DIRECTION §3's "verbatim body 18/29→19/31 SS4". The shipped 17/1.6 means the participant's words visibly resize and reflow the instant they send, which is exactly the seam A1 exists to remove. 19px is comfortably above the 16px iOS zoom threshold. Everything else on that class string — `input-verbatim w-full resize-none rounded border border-ink-300 bg-paper-2 px-4 py-3 text-ink-900 placeholder:text-ink-500 disabled:opacity-50` — is unchanged, as are `ref`, `id`, `value`, `onChange`, `onKeyDown`, `placeholder`, `disabled`, and `rows={3}`.

`src/app/globals.css:82` `.input-verbatim { min-height: 76px }` → `min-height: 7.5rem` (120px: three 31px lines, plus `py-3`'s 24px, plus the 2px border, under `box-sizing: border-box`). 76px was three lines at the old 17px. `field-sizing: content`, `max-height: 40vh`, and `overflow-y: auto` are unchanged.

**`max-height: 40vh` stays `vh`, not `dvh`.** This is a cap on a control, not a layout dimension. On iOS, `dvh` tracks the URL bar and would make the cap jitter while the participant types; `vh` holds still. Under `interactive-widget: resizes-content` (K1.8) `vh` already resolves against the keyboard-shrunk layout viewport, which is the behaviour that matters.

**The send row becomes a column on narrow screens.** `:388` `<div className="flex items-end gap-3">` → `<div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-3">`, and the `Button` at `:406–413` gains `className="min-h-11 w-full sm:w-auto"`. Two reasons: `px-4` + `pl-8` leaves 327px at 375px, which a side-by-side field and button crowd; and DIRECTION §7 makes the Send button the *only* way to send on touch, so it earns a full-width, 44px-tall target. `type`, `variant="primary"`, `onClick={() => handleSend()}`, `disabled={!input.trim() || isAiThinking}`, and the visible word `Send` are all unchanged — `InterviewChat.greeting.test.tsx:79,253,337,347` and `research-workflow.spec.ts:25` all resolve it by the accessible name `Send`.

`:415` the keyboard hint: `text-[12px]` → `text-[13px] leading-[20px]`. 12px sans is not a step in DIRECTION §3 — the 12px step is Plex Mono coordinate type, and this is a sans hint. Meta 13/20 is the correct step. The string `⌘/Ctrl + Enter to send` and the `[@media(pointer:coarse)]:hidden` guard are unchanged; the mobile Send-only rule depends on that guard and it is on the keep list.

`:370–387` the error block is unchanged in every respect: position (first child of the composer column, above the field), `role="alert"`, both message strings, the `Try again` control, its `disabled={isAiThinking}`, and `handleRetryGreeting`. It stays a filled terracotta block (§7 "Failure: filled terracotta block"); it does not become a `Notice`.

### K1.6 Auto-scroll: stay pinned, never yank

Today `:76–78` runs `messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })` on every change to `interviewHistory` or `isAiThinking`, unconditionally. That was tolerable when the scrollport was a transcript pane. Now it moves the whole page, so an unconditional scroll drags a participant who has scrolled up to re-read their own earlier answer — on the surface whose entire premise is that the participant's words are the primary text.

Three changes, and only these three.

**1. The ref moves.** `:346` `<div ref={messagesEndRef} />` leaves the log's inner column and becomes the last child of `<main>`, after the composer/closing block. Scrolling to it therefore lands at true document bottom, where the composer has released to its natural position and both the last turn and the field are visible.

**2. A pin flag, updated from a passive scroll listener.** Add next to the other refs at `:63–66`:

```tsx
const stickToBottomRef = useRef(true);
```

and a new effect immediately after the mount effect at `:68–73`:

```tsx
// The participant may scroll up to re-read an earlier answer. Auto-scroll is
// for people already at the live edge; it must never move the page under
// someone who is reading. 120px ≈ four lines of body leading.
useEffect(() => {
  const updatePin = () => {
    const remaining =
      document.documentElement.scrollHeight - window.innerHeight - window.scrollY;
    stickToBottomRef.current = remaining <= 120;
  };
  updatePin();
  window.addEventListener('scroll', updatePin, { passive: true });
  return () => window.removeEventListener('scroll', updatePin);
}, []);
```

**3. The scroll effect becomes conditional and reduced-motion aware.** `:76–78` becomes:

```tsx
useEffect(() => {
  if (!stickToBottomRef.current) return;
  const reduced =
    typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  messagesEndRef.current?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'end' });
}, [interviewHistory, isAiThinking]);
```

The dependency array is unchanged. `prefers-reduced-motion` is honoured because a smooth page scroll is motion and DIRECTION §5 makes reduced-motion instant everywhere.

**4. Sending re-pins.** In `handleSend`, on the line immediately after `addMessage(userMsg)` (`:160`), add `stickToBottomRef.current = true;`. Sending is an unambiguous statement that the participant is at the live edge; without this, a participant who scrolled up, then scrolled back down to type, could send and not see their own turn land if the browser reports them a hair outside the threshold.

Nothing else in `handleSend` changes.

**jsdom note for K7:** `tests/setup.ts:52–54` stubs `Element.prototype.scrollIntoView` and `:27–39` stubs `matchMedia` with `matches: false`. In jsdom `scrollHeight` is 0 and `innerHeight` is 768, so `remaining` is negative and the flag stays `true` — every existing test keeps its current behaviour without touching the setup file. Do not modify `tests/setup.ts`.

### K1.7 The closing block — in flow, at measure, left-aligned

`:351–366`. The `isComplete ?` ternary, `handleViewAnalysis`, both branch strings, and the `Button`'s label logic are unchanged.

- `:352` `<div className="border-t border-ink-300 bg-paper-0 px-6 py-8">` → `<div className="border-t border-ink-300 px-4 py-8 sm:px-6">`. It is **not** sticky: nothing more will be composed, and pinning a terminal block over the transcript would hide the last turn the participant just read. `bg-paper-0` is dropped for the same reason it was dropped from the log — the root div paints the ground and this block never overlaps anything.
- `:353` `<div className="mx-auto max-w-measure space-y-4 text-center">` → `<div className="mx-auto max-w-measure space-y-4">`. `text-center` is the kill named in A1. It stays flush left, **not** indented `pl-8`: this is the system closing the document, not the participant speaking.
- `:354` the `<h3>` keeps its element, its level, and both strings (`Preview conversation complete` / `Interview conversation complete`) — `research-workflow.spec.ts:26` matches `/conversation complete/` level-agnostically and `InterviewChat.greeting.test.tsx:224` matches `Preview conversation complete` exactly. Its `font-sans text-[18px] leading-[26px] font-semibold text-ink-900` is Slice H's and is correct; leave it.
- `:357` unchanged in every respect. `Your responses have not been saved yet.` is a fail-closed honesty statement pinned by `InterviewChat.greeting.test.tsx:201–202`, and H already moved it to 15/24 body ink for exactly that reason.
- `:362` the `Button` loses `className="mx-auto"` and gains nothing. Left-aligned, natural width. `type`, `variant="primary"`, `onClick={handleViewAnalysis}` and the label ternary are unchanged.

### K1.8 The `viewport` export

`src/app/layout.tsx` currently exports `metadata` only, so Next serves its default viewport — `width=device-width, initial-scale=1` (`node_modules/next/dist/lib/metadata/default-metadata.js:23–32`). Add, immediately after the `metadata` export at `:28–31`:

```tsx
import type { Metadata, Viewport } from 'next'

// A bottom-pinned composer needs the software keyboard to shrink the layout
// viewport, not just the visual one. Chromium honours interactive-widget;
// browsers that do not implement it ignore the token and keep today's
// behaviour, so this is additive. Zoom is deliberately left enabled.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  interactiveWidget: 'resizes-content',
}
```

Read against `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/generate-viewport.md` and `node_modules/next/dist/lib/metadata/types/extra-types.d.ts:44–54`, both in the installed Next 16, not from memory:

- The field is `interactiveWidget`, camelCase, typed `'resizes-visual' | 'resizes-content' | 'overlays-content'`. Next maps it to the `interactive-widget` viewport token (`lib/metadata/constants.js:31`).
- The `viewport` object export is **only supported in Server Components**. `src/app/layout.tsx` has no `'use client'`, so this is legal there. It must not be added to any `'use client'` component.
- A route may not export both `viewport` and `generateViewport`. Nothing else in the repo exports either; `grep -rn "generateViewport\|export const viewport" src/` must return only this new line.
- Merging is per key (`lib/metadata/resolve-metadata.js:315–345`), so `width` and `initialScale` would survive from the default even if omitted. They are written explicitly anyway: the rendered `<meta>` is now this file's contract, and a future reader should not have to know Next's default table to predict it.

**`maximumScale` and `userScalable` are not set, and must not be.** Pinch-zoom is an accessibility requirement, and disabling it is the standard reflex when a mobile keyboard misbehaves. K5 pins their absence with an assertion.

**What `resizes-content` does and does not buy.** Where it is honoured, the keyboard shrinks the layout viewport, so `sticky bottom: 0` resolves above the keyboard and `40vh` caps against the space actually visible. Where it is not honoured, the token is inert and the page behaves exactly as it does today. It is **not** a claim that iOS Safari is fixed — that is what the real-device pass in K7 exists to determine, and Open question 2 records the named fallback if it is not.

---

## K2. A2 — the receipt

`src/components/Synthesis.tsx`, participant branch only (`:195–267`), plus one new module.

### K2.1 `src/lib/receiptFacts.ts` (new)

A pure module so the formatting is unit-testable without rendering, and so no date maths lives in a component.

```ts
/**
 * Facts for the participant's submission receipt (DIRECTION §7 "Receipt").
 * Display-only, derived from the tab's own transcript and the server-issued
 * consent timestamp already in the store. Nothing here is authority; the
 * durable record is the saved interview.
 */

/** Turns the participant contributed. `system` messages are not turns. */
export function participantTurnCount(transcript: ReadonlyArray<{ role: string }>): number {
  return transcript.filter((message) => message.role === 'user').length
}

/**
 * Milliseconds from the first to the last message. Null when the transcript
 * cannot span an interval (fewer than two messages) or a timestamp is not a
 * usable number — the caller omits the row rather than printing a guess.
 */
export function transcriptElapsedMs(transcript: ReadonlyArray<{ timestamp: number }>): number | null {
  if (transcript.length < 2) return null
  const first = transcript[0].timestamp
  const last = transcript[transcript.length - 1].timestamp
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null
  const elapsed = last - first
  return elapsed >= 0 ? elapsed : null
}

/** `m:ss`, or `h:mm:ss` past an hour. Never "0 min" for a short interview. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const pad = (value: number) => String(value).padStart(2, '0')
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}

/**
 * `2026-09-05 14:32 UTC` from the server-issued epoch-millisecond consent
 * timestamp. UTC and not a locale format: this line exists so the participant
 * can compare what they see against the record the researcher holds, and a
 * locale-rendered local time is not the value that was stored. Null for any
 * value the consent API could not have issued (`api/consent/route.ts:100`
 * returns `recorded.consent.acceptedAt`, validated as a positive safe integer
 * at `participantConsent.ts:70–72`).
 */
export function formatConsentTimestamp(acceptedAt: number | null): string | null {
  if (acceptedAt === null || !Number.isSafeInteger(acceptedAt) || acceptedAt <= 0) return null
  return `${new Date(acceptedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}
```

`m:ss` rather than `N min` is deliberate. The brief keeps "0 min durations" out of this train as a data question on the researcher side; on the participant's own receipt a genuinely four-minute interview reading `0 min` would be a UI defect, and `4:12` is both honest and tabular.

### K2.2 The `saved` branch becomes a receipt

`Synthesis.tsx:207–215`. The heading and the sentence are unchanged, verbatim, in that order:

```tsx
<Verbatim as="h1" className="text-[28px] font-normal leading-[36px] text-ink-900">
  Interview submitted
</Verbatim>
<p className="font-sans text-[15px] leading-[24px] text-ink-700" role="status" aria-live="polite">
  Your responses have been saved. It is now safe to close this tab.
</p>
```

`research-workflow.spec.ts:66–67` resolves the heading by name and the sentence by its full text; `Synthesis.register.test.tsx:79` resolves the heading at level 1; `Synthesis.completion.test.tsx:61–62,82` and `Synthesis.lifecycle.test.tsx` resolve both by text. None of them may change.

After the sentence, and only when at least one fact is derivable:

```tsx
{receiptFacts.length > 0 ? (
  <>
    <Rule className="mt-2" />
    <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-6 gap-y-2">
      {receiptFacts.map((fact) => (
        <React.Fragment key={fact.term}>
          <dt><Label>{fact.term}</Label></dt>
          <dd><Coordinate className="text-[13px] text-ink-700">{fact.value}</Coordinate></dd>
        </React.Fragment>
      ))}
    </dl>
  </>
) : null}
```

built from, inside the `viewMode === 'participant'` block and above the `return`:

```tsx
const elapsedMs = transcriptElapsedMs(interviewHistory);
const consentAccepted = formatConsentTimestamp(consentTimestamp);
const receiptFacts = participantState === 'saved'
  ? [
      { term: 'Turns contributed', value: String(participantTurnCount(interviewHistory)) },
      ...(elapsedMs === null ? [] : [{ term: 'Elapsed', value: formatElapsed(elapsedMs) }]),
      ...(consentAccepted === null ? [] : [{ term: 'Consent accepted', value: consentAccepted }]),
    ]
  : [];
```

`consentTimestamp` is added to the `useStore()` destructure at `:35–45`. It is `number | null` (`store.ts:95`), set only from the server response (`Consent.tsx:48` → `store.ts:199–202`), and it is in `partialize` (`store.ts:379`), so it survives the sessionStorage rehydration that `research-workflow.spec.ts:71` exercises with a reload.

Notes that are load-bearing:

- **Terms are written in sentence case.** `Label` uppercases in CSS (`ui/Label.tsx:17`), so the rendered text is `TURNS CONTRIBUTED` while `textContent` — and therefore `getByText('Turns contributed')` — stays sentence case.
- **`Coordinate` supplies the mono register** (`ui/Coordinate.tsx:9`: `font-mono text-[12px] text-ink-500 [font-variant-numeric:tabular-nums]`). The className override lifts it to meta 13/20 ink-700, because 12px is coordinate type inside a researcher's apparatus and this is a document a participant reads on a phone. `cn` is `twMerge(clsx(…))`, so both overrides land cleanly. Do not edit `Coordinate` — it is a frozen primitive.
- **`items-baseline`** sits the 11px term and the 13px value on one line rather than top-aligning two different type sizes.
- **The fact block is outside the live region.** The sentence keeps `role="status" aria-live="polite"` and is what gets announced when the state flips to `saved`; the `<dl>` renders in the same commit and would only add noise to that announcement.
- **`React.Fragment` is written out, not `<>`**, because the fragment needs a `key`. `React` is already imported at `:3`.

### K2.3 Missing values are omitted, never filled

If a value cannot be derived, its row does not render. If none can, no `<Rule>` and no `<dl>` render at all.

This is the same ruling the brief made for D1: a footer that printed `receipt unsigned` read as a failure, and the fix was to drop the clause, not to print a nicer placeholder. A receipt row reading `unknown` or `—` claims the system tried to record something and could not. Omission claims nothing.

The realistic cases: `Elapsed` is absent for a single-message transcript (which the fixtures in `Synthesis.lifecycle.test.tsx:34` and `Synthesis.register.test.tsx:43` produce, and which a real participant cannot reach, since a saved interview has at minimum a greeting and one answer). `Consent accepted` is absent when a session was rehydrated without it. `Turns contributed` is always derivable when the branch renders at all, because `Synthesis.tsx:138` refuses to analyze an empty transcript.

### K2.4 What the receipt does not get

- **No transcript download.** DIRECTION §8 keeps it behind the privacy/consent review; the brief repeats it. Do not add a button, and do not add one that is disabled.
- **No researcher contact.** No such field exists on `StudyConfig` (`types.ts`); adding one belongs to Slice M's StudySetup rebuild.
- **No icon and no `Disclosure`.** `Synthesis.register.test.tsx:50` asserts `svg` count 0 and `:81` asserts no `[role="note"]` across all four participant states. `Disclosure` renders `role="note"` (`ui/Disclosure.tsx:13`).
- **No change to the other three participant states.** `analysis-failed` (`:216–234`), `save-failed` (`:235–253`), and `finalizing` (`:254–263`) keep every string, every `Notice`, every `role="alert"`, and both buttons. The receipt is a receipt of a completed save.
- **No change to the shell** at `:205–206` (`min-h-dvh bg-paper-0 px-4 py-12 sm:px-8 sm:py-20`, `mx-auto max-w-measure space-y-6`).

### K2.5 Imports

`Synthesis.tsx:8` already imports `Button, Citation, Coordinate, Label, Notice, Page, Rule, Verbatim` — every primitive the receipt needs. **Do not edit line 8.** Add one new statement after `:10`:

```tsx
import { formatConsentTimestamp, formatElapsed, participantTurnCount, transcriptElapsedMs } from '@/lib/receiptFacts';
```

Slice I will rewrite line 8 when it extracts `SynthesisReading`. Keeping K off that line is what makes the two diffs non-conflicting.

---

## K3. A3 — the consent echo, and where it actually lands

`src/components/Consent.tsx:42–48` receives the server timestamp and then, in the same synchronous block, calls `giveConsent(data.acceptedAt!)`, `initializeProfile(...)`, `setStep('interview')`, and `router.push('/interview')`. There is no render between the response arriving and the navigation. The component cannot echo the value on screen.

**Ruling: the echo lands on the A2 receipt, not on `Consent.tsx`.** The receipt's `Consent accepted` row prints exactly the value the consent API returned — `acceptedAt` from `api/consent/route.ts:100`, stored verbatim by `store.ts:199–202`, read back by K2.2. DIRECTION §7's "server `acceptedAt` timestamp shown back in mono" is satisfied, in mono, on the one screen where a participant has a reason to check it.

**Do not manufacture a moment to show it.** Holding the participant on a confirmation step between consenting and being interviewed — a delay, an interstitial, a two-stage button — would insert a gate the flow does not have, for the sake of a number nobody is looking for at that instant. `handleConsent` is untouched by this slice.

**What `Consent.tsx` does change in Slice K:** five class strings, and nothing else. `:104`, `:110`, `:114`, `:118` are `<p className="text-[13px] text-ink-500">` inheriting the `<ol>`'s `leading-[24px]` (`:101`), producing 13/24, which is not a step; each gains `leading-[20px]`. `:126` uses `leading-5`, a Tailwind-scale leading utility; it becomes `leading-[20px]`, which renders identically and matches the rest of the file. No text, no structure, no radius, no `role`.

`Consent.serverConsent.test.tsx:32,33,34,45–48,63–64,76–77,91,119,121` and `Consent.pluralization.test.tsx:28–29,39` all resolve by text, role or accessible name and are untouched by a leading change.

---

## K4. Load-bearing assertions

### Pass unchanged — `tests/unit/InterviewChat.greeting.test.tsx`

Nothing in this file is rewritten. That is the strongest available evidence that A1 is a layout change and not a behaviour change; if any of these breaks, the fix is in the component.

| line | assertion | why it survives |
|---|---|---|
| `:51` | `getByPlaceholderText('Take as much space as you need.')` | placeholder unchanged |
| `:67,113,122,125` | greeting text renders once | greeting effect untouched |
| `:69,87,114,183,371` | textarea enabled after settle | `disabled={isAiThinking}` untouched |
| `:78–79` | textarea named `Your response`, button named `Send` | label and button text unchanged |
| `:90` | no message committed on greeting rejection | `handleRetryGreeting`/init untouched |
| `:106–107,115` | disabled + `Composing a follow-up…` while pending | composing block unchanged, still inside the log |
| `:144–148,154–162` | session selector reaches both API calls | untouched |
| `:150–151,178–179,324,336–339` | Cmd/Ctrl+Enter and Send both send | `handleTextareaKeyDown` untouched |
| `:201–202` | `/responses have not been saved yet/i` present, `/responses have been saved/i` absent | K1.7 changes no string |
| `:204–207` | `continue to save interview` drives `currentStep` and `router.push('/synthesis')` | `handleViewAnalysis` untouched |
| `:224–226` | `Preview conversation complete`, `/will not be added to study data/i`, `continue preview` | K1.7 changes no string |
| `:244,255,268,281,297–301` | markdown memoization and speaker switching | `InterviewTurn` untouched |
| `:318–321` | plain Enter never sends | untouched |
| `:347–350` | Send disabled on empty input | `disabled` expression untouched |
| `:387–388` | `getByRole('log')` with `aria-live="polite"` | both attributes stay on the same element |
| `:394–396` | `You:` and `Interviewer:` `.sr-only` nodes found **inside** the log | **this is the assertion that forbids moving the turns out of the log**; only the composer moves |

### Pass unchanged — participant `Synthesis` suites

| file:line | assertion | why it survives |
|---|---|---|
| `Synthesis.register.test.tsx:50` | `svg` count 0 across all four participant states | the receipt renders no icon |
| `Synthesis.register.test.tsx:68,79,90,101` | `heading` level 1 by name in each of the four states | headings unchanged |
| `Synthesis.register.test.tsx:70,81,92,103` | no `[role="note"]` | no `Disclosure` is added |
| `Synthesis.register.test.tsx:51–54` | no `stone-*` class anywhere | tokens only |
| `Synthesis.completion.test.tsx:60–66` | `Finalizing…` then `Interview submitted`, `/safe to close/i`, no bottom line, no export button, one save call | receipt adds no control |
| `Synthesis.completion.test.tsx:76–83` | save-failure copy, retry, then `Interview submitted` | failure branches untouched |
| `Synthesis.lifecycle.test.tsx` (whole file) | every submission-identity, StrictMode-replay, stale-attempt and retry assertion; `:50,73,79,134,180,185,201,208,225` resolve `Interview submitted` by text | K touches nothing above `:195`; the receipt is downstream of `participantState` |
| `Synthesis.sessionHeaders.test.tsx:59–71` | selector propagation to synthesis and save | untouched |
| `Synthesis.trace.test.tsx` (whole file) | participant/preview evidence rendering | K touches no theme rendering |

Note for the implementer: in `Synthesis.lifecycle.test.tsx` the fixture transcript is one message (`:34`) and `beginParticipantSession` nulls `consentTimestamp` (`store.ts:316`), so those renders exercise the omission path in K2.3 — one row, `Turns contributed 1`. That is intended and asserted in K5.

### Pass unchanged — `Consent`

`Consent.serverConsent.test.tsx:32,33,34,45–48,63–64,76–77,91,102–107,119,121–124`; `Consent.pluralization.test.tsx:28–29,39`. K3 changes leading only.

### Pass unchanged — `tests/e2e/research-workflow.spec.ts`

| line | assertion | why it survives |
|---|---|---|
| `:22` | `I consent — begin the interview` | untouched |
| `:23` | greeting visible by exact text | untouched |
| `:24` | `getByLabel('Your response')` fills the textarea | the `sr-only` label and `htmlFor` are unchanged |
| `:25` | `Send` clicked by exact name | button text unchanged |
| `:26` | `getByRole('heading', { name: /conversation complete/ })` | `<h3>` and both strings unchanged |
| `:56,60,64` | `Continue to save interview`, `Retry finalization`, `Retry save` | untouched |
| `:58,62` | the two failure headings | untouched |
| `:66–67` | `Interview submitted` heading and the safe-to-close sentence by full text | the sentence stays alone in its own `<p>` |
| `:71–73` | reload retains success without a second synthesis call | `consentTimestamp` and `interviewHistory` are both in `partialize` (`store.ts:379,381`), so the receipt re-renders with real values after rehydration |
| `:111,114` | preview `completeConversation` and `Continue preview` | untouched |
| `:113,116` | 375px, no horizontal overflow on the preview recovery page | that page is `Synthesis`'s preview branch, which K does not touch |

### Rewritten by this slice

**None.** No existing assertion is rewritten or deleted. If the implementer finds one that must be, stop and report it rather than editing the test — a broken assertion here means the layout change moved something A1 said would not move.

---

## K5. New regressions

Smallest realistic regression at the boundary each one protects. Do not snapshot any component in this slice.

**`tests/unit/receiptFacts.test.ts`**
- `participantTurnCount` counts only `role === 'user'`, excluding `ai` and `system`.
- `transcriptElapsedMs` returns null for `[]` and for a single message; returns the difference for two; returns null for a negative difference and for a non-finite timestamp.
- `formatElapsed(0)` is `0:00`; `formatElapsed(34_000)` is `0:34`; `formatElapsed(252_000)` is `4:12`; `formatElapsed(3_912_000)` is `1:05:12`. No output contains the string `min`.
- `formatConsentTimestamp(1_700_000_000_000)` is `2023-11-14 22:13 UTC`; `null`, `0`, `-1`, `1.5` and `Number.MAX_SAFE_INTEGER + 2` all return null.

**`tests/unit/Synthesis.receipt.test.tsx`**
- Saved state with a two-message transcript 252s apart and `consentTimestamp: 1_700_000_000_000`: `Turns contributed`, `Elapsed` and `Consent accepted` all resolve by text; `4:12` and `2023-11-14 22:13 UTC` are present; the block is a `<dl>` with three `<dt>`/`<dd>` pairs.
- Saved state with a one-message transcript: `Elapsed` is absent and `Turns contributed` is present.
- Saved state with `consentTimestamp: null`: `Consent accepted` is absent, and the document contains no text matching `/unknown|not recorded|—/`.
- The safe-to-close sentence still carries `role="status"` and reads verbatim, and the `<dl>` is **not** inside it.
- `finalizing`, `save-failed` and `analysis-failed` render no `<dl>` and no `Turns contributed` text.
- No `svg` and no `[role="note"]` in the saved state (a second guard beside `Synthesis.register.test.tsx`, local to the receipt).

**`tests/unit/InterviewChat.page.test.tsx`**
- Exactly one `main` landmark, and `getByRole('log')` is inside it.
- The composer's textarea is **not** inside the log element (`log.contains(textarea) === false`), while both `.sr-only` speaker prefixes still are.
- The element carrying the textarea's composer block has `sticky` and `bottom-0` in its className, and the completion block (rendered with `isComplete: true`) does not.
- **No element from the composer up to `document.body` carries an `overflow-` class.** This is the real regression: `position: sticky` fails silently under an overflow ancestor and jsdom cannot show it.
- The completion block's inner column has no `text-center`, and no ancestor of the heading does either.
- No element in the rendered tree has `h-dvh` or `h-screen` in its className.

**`tests/unit/InterviewChat.autoscroll.test.tsx`**
- With the page at the bottom, a new arriving turn calls `scrollIntoView` on the end sentinel.
- With `document.documentElement.scrollHeight` stubbed to 4000, `window.innerHeight` 800 and `window.scrollY` 0, and a `scroll` event dispatched on `window`, a new arriving turn calls `scrollIntoView` **zero** additional times.
- After that, sending via the `Send` button calls `scrollIntoView` again — sending re-pins.
- With `matchMedia('(prefers-reduced-motion: reduce)')` returning `matches: true`, the call carries `behavior: 'auto'`; with the default stub it carries `behavior: 'smooth'`.
- Unmounting removes the `scroll` listener (spy on `window.removeEventListener`).

**`tests/unit/layout.viewport.test.ts`**
- `import { viewport } from '@/app/layout'` gives `width === 'device-width'`, `initialScale === 1`, `interactiveWidget === 'resizes-content'`.
- `maximumScale` and `userScalable` are `undefined` — pinch-zoom must stay enabled.
- The module exports no `generateViewport`.

---

## K6. Verification

Focused gates first, per the AGENTS.md change map. `InterviewChat` and `Consent` are on the participant-flow row; `Synthesis.tsx` is on the **Completion and export** row, which pulls in the receipt/lifecycle/save suites and `npm run test:e2e`.

```bash
# Participant flow: consent, session, isolation
npx vitest run tests/unit/InterviewChat.greeting.test.tsx tests/unit/InterviewChat.page.test.tsx \
  tests/unit/InterviewChat.autoscroll.test.tsx tests/unit/Consent.serverConsent.test.tsx \
  tests/unit/Consent.pluralization.test.tsx tests/unit/participantHeaders.test.ts \
  tests/unit/participantSessionHeaders.test.ts tests/unit/api.consent.test.ts \
  tests/unit/store.participantIsolation.test.ts tests/unit/participantConsent.test.ts

# Completion row: receipt, lifecycle, save
npx vitest run tests/unit/Synthesis.register.test.tsx tests/unit/Synthesis.completion.test.tsx \
  tests/unit/Synthesis.lifecycle.test.tsx tests/unit/Synthesis.sessionHeaders.test.tsx \
  tests/unit/Synthesis.trace.test.tsx tests/unit/Synthesis.receipt.test.tsx \
  tests/unit/receiptFacts.test.ts tests/unit/synthesisReceipt.test.ts \
  tests/unit/api.save.idempotent.test.ts tests/unit/layout.viewport.test.ts
```

Then the proportional full gate — the completion row names `npm run test:e2e`, and `layout.tsx` is on every route:

```bash
npm run check
DEPLOYMENT_MODE=standalone npm run build
npm run test:e2e
```

Then the greps, each of which must return no output except where noted:

```bash
grep -rn "h-dvh\|h-screen" src/components/InterviewChat.tsx   # no output: the pane split is gone
grep -rn "text-center" src/components/InterviewChat.tsx       # no output: A1's centered panel is gone
grep -rn "overflow-" src/components/InterviewChat.tsx         # no output: nothing may break sticky
grep -rn "generateViewport\|export const viewport" src/       # exactly one hit: src/app/layout.tsx
grep -rn "user-scalable\|userScalable\|maximumScale" src/     # no output
grep -rn "lucide-react\|framer-motion" src/                   # no output: no dependency was added
grep -rn "font-serif" src/components/InterviewChat.tsx        # no output: serif comes from .input-verbatim
grep -rn "leading-5\b" src/components/Consent.tsx             # no output
npm run lint                                                  # the design law is a CI gate, not advice
```

---

## K7. Inspection at 375px and 1280px

Run the participant flow through a real generated link (`/p/<token>`), not researcher preview, so `PreviewBanner` is absent and the running head is visible.

**375px, Chromium:**
- `/interview` on the first question: the composer sits **directly under** the greeting, indented to the same left axis as a participant answer would be. There is no paper void beneath it and no pinned bar at the fold — this is the defect `11b-interview-typed-mobile.png` recorded.
- Type a long answer: the field grows to its 40vh cap and then scrolls internally; the page does not develop a horizontal scrollbar (`document.documentElement.scrollWidth <= window.innerWidth`).
- After four or five exchanges the transcript exceeds the viewport: the composer is pinned at the bottom with an opaque paper ground and a visible top hairline, transcript text passes cleanly beneath it, and the running head is pinned at the top.
- Scroll to the very bottom: the composer releases to its natural position and the last turn is fully visible above it, not clipped.
- Scroll up four screens and wait for an interviewer reply to arrive: **the page does not move.** Scroll back down and send: the page follows.
- `Send` is full width and at least 44px tall; the `⌘/Ctrl + Enter to send` hint is not rendered.
- Force a greeting failure (block the interview API): the terracotta block is square, filled, above the field, and reads `The interviewer could not start. This is not an AI reply — please try again.` with a working `Try again`.
- Complete the interview: the closing block is left-aligned at measure, the button is left-aligned, and the heading and the "not saved yet" sentence read at 18/26 and 15/24.
- `/synthesis` after save: the receipt reads heading, sentence, hairline, then three rows. Terms are 11px uppercase ink-500; values are mono, 13px, ink-700, colon-aligned. Nothing wraps.

**Real device, iOS Safari — this is the gate the brief names and Chromium emulation does not satisfy:**
- Tap the composer on a short transcript. Confirm the field is fully visible above the keyboard and the caret is not under it.
- Tap the composer on a transcript three screens long. Confirm the same. **If the composer is behind the keyboard here, stop and report it — this is the finding Open question 2 exists for; do not improvise a fix.**
- Type past three lines. Confirm the field grows upward and the caret stays visible.
- Dismiss the keyboard. Confirm the composer returns to the viewport bottom without the page jumping.
- Send. Confirm the page scrolls to the new turn and the composer stays reachable.
- Pinch-zoom. Confirm it works — `maximumScale`/`userScalable` must not have crept in.
- Rotate to landscape mid-interview. Confirm no clipping and no lost scroll position.

**Real device, Android Chrome:** the same six steps. This is where `interactive-widget: resizes-content` is honoured, so the composer should sit directly above the keyboard and the 40vh cap should measure against the reduced viewport.

**1280px:** the transcript column is centred at 34rem, the composer is at the same measure and the same indent, and the running head spans the full width with its hairline. Nothing about the page suggests a chat client.

**Known and expected, not a K regression:** in researcher preview (`/setup` → Preview → `/interview`) the ochre `PreviewBanner` covers the running head once the page scrolls. See K1.2 and Open question 1.

Leave the dev server runnable for the orchestrator's screenshot pass.

---

## Hard constraints

- Files that may change: `src/components/InterviewChat.tsx`, `src/components/Synthesis.tsx` (**lines 195–267 only, plus one new import statement after line 10**), `src/components/Consent.tsx` (the five class strings in K3 only), `src/app/layout.tsx` (the `viewport` export and the `Viewport` type import only), `src/app/globals.css` (`.input-verbatim`'s `min-height` only), `src/lib/receiptFacts.ts` (new), and the tests named in K5. Nothing else.
- **No store, service, `types.ts`, API route, `proxy.ts`, `auth.ts`, `kv.ts`, `researcherContext.ts`, `canonicalStudy.ts`, or `participantConsent.ts` change.** The receipt reads `consentTimestamp`, which already exists (`store.ts:95,199–202,379`); it does not add a field, does not persist anything, and is not authority for anything.
- **Do not touch `Synthesis.tsx:1–194` or `:268–501`.** Those are Slice I's. In particular, do not edit the import list at `:8`, do not touch the two `receipt` footers Slice I owns, and do not extract `SynthesisReading` here.
- **Do not edit any file in `src/components/ui/`.** `Button`, `Label`, `Rule`, `Coordinate`, `Verbatim`, `Turn`, `Notice`, `Icon`, `Disclosure`, `Citation`, `Page` and `Field` are frozen contracts. `Coordinate`'s size and colour are overridden by className at the call site, which is what its `HTMLAttributes` signature is for.
- **Do not edit `PreviewBanner.tsx`, `Export.tsx`, `InterviewDetail.tsx`, `DemoSimulation.tsx`, or any researcher component.**
- **Do not edit `eslint.config.mjs`, `tailwind.config.ts`, or `tests/setup.ts`.** The slice needs no new token, no new keyframe, no lint exemption and no new jsdom shim; if lint blocks a class, the class is wrong.
- **No new npm dependency and no removal.** No scroll or virtualization library.
- **No `data-theme`, no `dark:`, no theme toggle, no `prefers-color-scheme`.**
- Do not commit; leave the working tree for review. npm only (`package-lock.json` authoritative), Node ≥ 24.19.

## Deferred, do not attempt

- **Participant transcript download** — DIRECTION §8 and the brief both hold it behind the privacy/consent review. Not even a disabled control.
- **Researcher contact on the receipt** — no such field exists on `StudyConfig`; Slice M adds it when StudySetup is rebuilt (brief, A2).
- **C1 `SynthesisReading`, B1 honest footers, B3 `divergentViews`/`researchImplications`, C2 `Tabs`, C5 the shared provider module** — Slice I.
- **B2 aggregate citations** — Slice L. **C6/F1 StudySetup** — Slice M.
- **The `WithMargin` unfold (B4)** — struck by decision of record 4.
- **`Interview Dashboard` / `Back to Dashboard` renames** — Slice H's ruling 3 gives them to Slice I.
- **The `<h3>` in the closing block becoming an `<h2>`.** The document now has an `<h1>` in the running head and an `<h3>` at the end with no `<h2>` between. It is a real gap, but changing a heading level touches the one thing A1 promised not to move, and `research-workflow.spec.ts:26` and `InterviewChat.greeting.test.tsx:224` both resolve it today. Fix it in a slice that owns the participant heading outline.
- **The `PreviewBanner` / running-head sticky collision** — K1.2, Open question 1.
- **Night theme, typeset export, the merged InterviewDetail reading, aggregate persistence.**

## Rulings (Fable, 2026-09-05) — settled; the text above stands except where a ruling amends it

1. **Q1 — in scope, K owns it.** A1 turns an intermittent collision into a permanent one on every researcher preview, so K fixes it. Amendment to K1.2 and the Hard constraints: `src/components/PreviewBanner.tsx` may change for this purpose only. `PreviewBanner` measures its own rendered height with a `ResizeObserver` on its root element and writes it to `document.documentElement.style` as `--preview-banner-height` (px), clearing the property on unmount (the banner is conditional, so the property must not linger). The running head in `InterviewChat.tsx` becomes `sticky top-[var(--preview-banner-height,0px)] z-20` (Tailwind 3 arbitrary value; lint-safe — no palette involved). Nothing else about `PreviewBanner` changes: its `sticky top-0 z-50`, its `Disclosure`, its `participantPages` gate, its copy, and `handleExit` are untouched. New regression in `tests/unit/InterviewChat.page.test.tsx`: the running head's className contains `top-[var(--preview-banner-height,0px)]`; and in a new `tests/unit/PreviewBanner.height.test.tsx`: mounting on a participant page in preview sets the property, unmounting removes it (stub `ResizeObserver` locally in the test file, not in `tests/setup.ts`).
2. **Q2 — adopted.** Do not build the `visualViewport` fallback speculatively. The handback names the iOS pass as outstanding; the owner runs it on the Vercel preview deployment and the fallback is authorised only on an observed failure.
3. **Q3 — keep `m:ss`.**
4. **Q4 — keep UTC** with the literal suffix.
5. **Q5 — keep the `<main>` landmark.**

## Open questions as originally drafted (for the record)

1. **The `PreviewBanner` covers the running head in preview.** Both are `sticky top: 0`; the banner is `z-50`. Pre-existing, but A1 makes it permanent instead of intermittent. The clean fix gives `PreviewBanner` a height published as a custom property that the participant running head offsets against — two files, one of which no Initiative 3 slice owns. **Recommendation: out of scope for K, named in the handback, fixed by whichever slice next opens the shell.** Ships as specced (unfixed) unless the orchestrator says otherwise.

2. **`interactive-widget` is not implemented everywhere, and iOS Safari is the case that matters.** `resizes-content` is the correct declaration and is inert where unsupported, so setting it cannot regress anything. But if the K7 real-device pass finds the composer behind the iOS keyboard, the remedy is a `visualViewport` `resize`/`scroll` listener that writes the keyboard overlap to a custom property, with the composer at `bottom: var(--keyboard-inset, 0px)`. That is roughly fifteen lines and a well-understood pattern. **Recommendation: do not build it speculatively.** Run the device pass first, report what iOS actually does, and let the orchestrator authorize it as a K follow-up commit. Building it blind adds a listener the slice may not need.

3. **`Elapsed` is `m:ss`, not `N min`.** `4:12` is honest, tabular and never reads `0 min`. The cost is that a participant may read `14:23` as a duration in hours and minutes at a glance. Alternatives are `14 min 23 s` (prose in a mono block) or `14 min` (which loses short interviews). **Recommendation: keep `m:ss`.** The mono register signals a measured quantity, and the row's term is `ELAPSED`, not `TIME`.

4. **`Consent accepted` is UTC, not the participant's local time.** The row exists so the participant can compare what they see against the record the researcher holds, and the server stored an epoch millisecond, not a locale rendering. Local time would be friendlier and would need an explicit `Intl.DateTimeFormat` option set plus a resolved-zone suffix to stay unambiguous, and would make the unit test environment-dependent. **Recommendation: keep UTC**, with the literal ` UTC` suffix so it is never mistaken for local.

5. **The `<main>` landmark is an addition the brief did not ask for.** It brings the interview page in line with `/consent` and `/synthesis`, which both have one, and gives screen-reader users a jump target the flagship currently lacks. It adds one implicit role and is covered by a test. **Recommendation: keep it.** If the orchestrator wants K to add no roles at all, drop the `<main>` and keep the rest of K1.1 — the sticky mechanics do not depend on it.
