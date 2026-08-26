# Slice G — The long tail and ratchet zero (Initiative 1, depends on Slices A–F)

Re-registers the last six legacy surfaces — `src/components/Export.tsx`, `src/components/Login.tsx`, `src/components/OAuthLogin.tsx`, `src/app/self-host/page.tsx`, `src/app/p/[token]/page.tsx`, and the `SetupLoading` fallback in `src/app/(researcher)/setup/page.tsx` — flips the root `<body>` to Paper, removes the last dead CSS and Tailwind config from the old palette, and **empties the migration ratchet**. Context: `docs/design/DIRECTION-final.md` §2 (tokens, "permanent CI grep for the old palette"), §5 Motion, §6 Iconography, §7 "Participant", amendments A1, A6, A8.

**Prerequisites, strictly ordered.** **Slice F must be accepted first.** F deletes the last references to `.prose` and `.preview-banner` in `globals.css`, and F and G both edit `eslint.config.mjs` — concurrent edits to the same working tree are forbidden. The full order is A → B → C → D → E → F → G, and G is the terminus: after it, no file in `src/` carries a class from the pre-Verbatim palette and the allowlist mechanism that made the migration incremental is deleted.

**Prime directive: this is a re-registering of the surface, not a logic rewrite.** Every handler, effect, fetch, redirect guard, and disabled expression survives byte-for-byte in behavior. In `Export` that means `generateJSON` and `generateTranscript` (**including every line of their output, character for character — these are file formats a researcher's downstream tooling may already parse**), `downloadFile`, `handleDownloadJSON`, `handleDownloadTranscript`, `handleCopyJSON` and its 2000ms timeout, `handleNewParticipant`, `handleNewStudy`, `handleReturnToSynthesis`, `handleRunPreviewAgain`, `handleReturnToStudySetup`, and the `extractedFields` / `totalFields` derivations. In `Login` that means the readiness `useEffect` and its `.catch` fallback, the OAuth-error `useEffect` and its whole `errorMessages` map, `handleSubmit`, and **both** open-redirect guards (`rawReturnTo`/`returnTo` at `:22–25` and the duplicate inside `handleSubmit` at `:89–92`) — copied character for character, both of them, even though they are redundant. In `OAuthLogin` that means `handleOAuth`, its `encodeURIComponent(returnTo)`, and the `// eslint-disable-next-line @next/next/no-location-assign-relative-destination` comment above the assignment. In `p/[token]` that means the whole `loadStudyFromLink` effect, its dependency array, the `beginParticipantSession` call with its `aiTransport` ternary, and the `currentStep` switch. If a change is not named below, do not make it.

## G1. Laws that bind this slice

- **Tokens only, everywhere, with no exemption left to fall back on.** After G there is no allowlist, so every file in `src/` is subject to the design-law rule. `bg-paper-*`, `text-ink-*`, `border-ink-*`, `text-action`, `text-success`, `text-error`.
- **Light only (A6).** Four of these six surfaces are public or participant-facing (`/`→`/login`, `/self-host`, `/p/<token>`, `/export`). No `dark:` variants, no `data-theme`, no toggle.
- **Apparatus-light for participants (A1).** `p/[token]` and `Export`'s participant branch carry no turn numbers, no receipt hashes, no model ids, no coordinates of any kind.
- **No wine anywhere in this slice.** Nothing here cites anything. `Citation` is imported by no file; no file may contain `var(--evidence`. (Slice F §F2 states the reasoning in full; it binds here too.)
- **Ochre once per screen (A8), and `Export`'s preview notice is not it.** `PreviewBanner` renders above `/export` whenever `viewMode === 'preview'` (`src/components/PreviewBanner.tsx:13`), so the page-level ochre band is already on screen. `Export`'s preview copy stays a plain subtitle — see `slice-F-spec.md` §F7.2, the one-band rule, which G inherits rather than re-litigates. `Disclosure` is imported by **no file in Slice G**.
- **No decorative icons (§6), no motion (§5).** All six files must end with **no `lucide-react` import** and **no `framer-motion` import**. Every `motion.div` becomes a plain `div`; every `initial` / `animate` / `transition` prop is deleted. No spinners: `Loader2` is replaced by the sentence the surface should have been showing all along. No skeletons.
- **Radius discipline:** `0` for structure, `rounded` for controls. Every `rounded-lg`, `rounded-xl`, `rounded-2xl`, `rounded-full` in these six files dies.
- **Serif is human speech, consent text, and interpretation prose.** In this slice that means serif appears **twice**: `Export`'s participant heading and `p/[token]`'s error heading, both through `Verbatim`, both because they bookend the participant's document (see G4.1 and G7). No raw `font-serif` class anywhere.
- **Triage density (A2).** Measure applies to prose only. Never to the stats row, never to a form row, never to a code block.

## G2. `src/app/layout.tsx` — the body finally turns to paper

This is the smallest diff in the slice and the one with the widest blast radius: every route in the app inherits it.

**Change exactly one attribute.** Line 43:

```tsx
<body className="min-h-dvh bg-paper-0 font-sans text-ink-700 antialiased">
```

- `bg-stone-900` → `bg-paper-0`. This is the change three earlier specs deferred to here by name (`slice-C-spec.md` §C2 final paragraph, `slice-D-spec.md` §D3.2, §D9, `slice-E-spec.md` Deferred).
- `min-h-screen` → `min-h-dvh`, matching every other frame in the migrated app and behaving correctly with mobile browser chrome.
- `text-ink-700` is added so the document has a token default instead of inheriting the browser's black. Every migrated component already sets its own text colour, so nothing visibly changes except in nodes that never set one.
- `font-sans` and `antialiased` stay.

**Everything else in this file is untouched:** the three `next/font/google` loaders and their exact `subsets` / `weight` / `style` / `display` / `variable` options, the `<html lang="en">` element and its `${sourceSerif4.variable} ${publicSans.variable} ${ibmPlexMono.variable}` className, the `metadata` export, and the `<PreviewBanner />` render above `{children}`. Do not add a `data-theme` attribute, a theme script, or a `suppressHydrationWarning`.

**iOS overscroll, resolved here.** Slices C and D noted that iOS rubber-band scrolling exposed a dark band because the body was `stone-900`; with `bg-paper-0` the propagated canvas background is paper and the note is discharged. Verify this at 375px in G11 rather than assuming it. If the bounce area still paints a non-paper colour, the bounded fix is to add `bg-paper-0` to the `<html>` element's className as well — take it if needed, and say in the handback which of the two you shipped.

## G3. `src/app/p/[token]/page.tsx` — the participant's front door

A6 and A1 at their strictest: this is the first thing a participant ever sees, before consent, and it must be warm, light, and free of apparatus. Delete the `Loader2` import (and with it the whole `lucide-react` line) and the `⚠️` emoji in its `w-16 h-16 rounded-full bg-stone-800` circle — a decorative glyph in a circle is exactly the shape §6 and §10 kill.

All three states share the frame `<main className="flex min-h-dvh items-center justify-center bg-paper-0 px-4 py-12">` with an inner `<div className="w-full max-w-measure">`, matching `Consent.tsx`'s no-study branch so the two screens read as one flow.

| state | markup | copy |
|---|---|---|
| `loading` | `<p className="font-sans text-[15px] text-ink-500">` | `Loading interview...` verbatim (three periods, not an ellipsis character) |
| `error` | `Verbatim as="h1"` at `text-[28px] font-normal leading-[36px] text-ink-900`, then the message at 15px `text-ink-700`, then the guidance at 13px `text-ink-500` | `Unable to Load Interview`, `{error}`, `Please check that you have the correct link or contact the researcher.` — all verbatim |
| no `studyConfig` | `<p className="font-sans text-[15px] text-ink-500">` | `Study configuration not found.` verbatim |

The `error` heading is serif for the same reason `Consent.tsx`'s study-name heading is: this is the participant's document, not the researcher's workspace, and the two ends of that document should be set in the same face. `text-center` dies in all three states.

The three error strings produced inside the effect (`No participant link code provided`, `Invalid or expired link`, `The participant session could not be established`, `Failed to load study configuration`) are logic and are unchanged.

The `switch (currentStep)` at the foot of the file — including the `default` returning `<Consent />` — is unchanged.

## G4. `src/components/Export.tsx`

`/export` is not inside the `(researcher)` route group, so `Export` keeps its own page frame in both branches (the same asymmetry `slice-F-spec.md` §F4 called out for `Synthesis`).

### G4.1 Participant branch

```tsx
<main className="min-h-dvh bg-paper-0 px-4 py-12 sm:px-8 sm:py-20">
  <div className="mx-auto max-w-measure space-y-6">
```

`text-center`, the card, and the `rounded-xl` all die. Heading `<Verbatim as="h1" className="text-[28px] font-normal leading-[36px] text-ink-900">Return to interview completion</Verbatim>` — copy verbatim; `Export.mode.test.tsx:32` matches it as an exact, level-agnostic heading name. Body `Submission status is shown on the previous screen. This page does not provide researcher export controls.` verbatim at `font-sans text-[15px] leading-[24px] text-ink-700`. Control: `<Button variant="primary" onClick={handleReturnToSynthesis} className="w-full">Return to completion status</Button>`, copy verbatim.

**Hard constraint, pinned by `:33–34`: this branch must contain no button whose accessible name matches `/download json/i` and none matching `/new participant/i`.** Do not hoist any export control above the `viewMode === 'participant'` early return.

### G4.2 Researcher and preview branch — frame and header

`<main className="min-h-dvh bg-paper-0">` wrapping `<Page className="py-10 md:py-14">`. `max-w-2xl mx-auto`, `p-4 sm:p-8`, `text-center`, the `w-16 h-16 rounded-full` `CheckCircle` circle, and the outer `bg-stone-800/50 rounded-xl border border-stone-700 p-5 sm:p-8` sheet all die.

- `<Label>Session complete</Label>` — new eyebrow copy, additive.
- `<h1 className="font-sans text-[24px] font-semibold leading-[32px] text-ink-900">{viewMode === 'preview' ? 'Preview complete' : 'Interview Complete'}</h1>` — expression copied character for character; `:46` matches `Preview complete` as an exact heading name.
- Subtitle `<p className="font-sans text-[15px] leading-[24px] text-ink-700 max-w-measure">` carrying the existing ternary verbatim (`Review or export this local preview. It was not added to study data.` / `Export your data and start a new session`). `:47` matches `/was not added to study data/i`; keep the sentence as a direct text child of a single element so the query stays unambiguous. **This stays a plain subtitle, not an ochre band** — G1's one-band rule.
- Then `<Rule className="my-8" />`.

### G4.3 Stats and profile

The four stat tiles lose their `bg-stone-800 rounded-xl p-4` boxes and become a ruled register: `<dl role="group" aria-label="Session summary" className="grid grid-cols-2 gap-x-6 sm:grid-cols-4">`, each cell `border-t border-ink-300 py-4`, left-aligned, with `<Coordinate className="block text-[28px] leading-[36px] text-ink-900">` above `<Label className="mt-1 block">` (twMerge resolves `Coordinate`'s 12px/`ink-500` defaults in favour of the overrides — the same treatment `slice-F-spec.md` §F6.4 uses for `StudyDetail`'s summary). All four value expressions are copied character for character, including `{questionProgress.questionsAsked.length}/{studyConfig?.coreQuestions.length || 0}` and `{extractedFields.length}/{totalFields}`. The four labels `Messages`, `Questions`, `Profile`, `Themes` are verbatim.

Participant profile summary keeps its `participantProfile && extractedFields.length > 0` gate and its whole per-field mapping — the `schema?.label || f.fieldId` lookup and the four-branch value expression (`f.value` / `Declined` / `Unclear` / `—`) are copied character for character. `Participant Profile` becomes a `Label` eyebrow (the `<h3>` and its `User` icon die), and the rows become a ruled `<dl>`: `<div className="flex items-baseline justify-between gap-4 border-t border-ink-300 py-2">` with `<dt className="font-sans text-[13px] text-ink-500">` and `<dd className="font-sans text-[13px] text-ink-900">`. The `refused` branch keeps its `italic` (the slant is the meaning — a declined field is not a value) as `text-ink-500 italic`. The `bg-stone-800 rounded-xl` box dies.

### G4.4 Export controls

`Export Data` heading verbatim, `font-sans text-[15px] font-semibold text-ink-900`. The three controls lose their `w-10 h-10 rounded-lg` icon tiles, their `FileJson` / `FileText` / `Copy` / `Check` / `Download` icons, and their `rounded-xl` borders. Each becomes a full-width ruled row:

```tsx
<button type="button" onClick={…} className="group block w-full border-t border-ink-300 py-4 text-left">
  <span className="block font-sans text-[15px] font-medium text-ink-900 group-hover:text-action">{title}</span>
  <span className="block font-sans text-[13px] text-ink-500">{description}</span>
</button>
```

All six strings verbatim: `Download JSON` / `Full structured data with profile + transcript`; `Download Transcript` / `Markdown transcript with profile summary`; `Copy to Clipboard` (flipping to `Copied!` on `jsonCopied`) / `Copy JSON data to clipboard`. `:48` matches `/download json/i` as a button name, so the accessible name must keep containing that phrase.

The copied state's `border-green-700 bg-green-900/30` and `text-green-300` die; on `jsonCopied` the title span alone takes `text-success`. No icon swap, no background change — the word changing to `Copied!` is the feedback.

### G4.5 Next actions

`What&apos;s Next?` heading verbatim (entity included), same type as `Export Data`, preceded by `<Rule className="my-8" />` in place of the `pt-4 border-t border-stone-700`. Both branches keep their `viewMode === 'preview'` gate and their DOM order exactly:

| branch | control | variant | handler |
|---|---|---|---|
| preview | `Run preview again` | `primary` | `handleRunPreviewAgain` |
| preview | `Return to study setup` | `quiet` | `handleReturnToStudySetup` |
| otherwise | `New Participant (Same Study)` | `primary` | `handleNewParticipant` |
| otherwise | `Create New Study` | `quiet` | `handleNewStudy` |

All four labels verbatim; all four buttons `className="w-full"`; `RotateCcw` deleted. `:49–51` match `/run preview again/i` and `/return to study setup/i` and assert that **no** button named `/new participant/i` exists in the preview branch — so the branch gate must not be flattened into a single always-rendered row.

## G5. `src/components/Login.tsx`

A public auth surface: light Paper, document register, no icons.

- **Frame:** `<main className="flex min-h-dvh items-center justify-center bg-paper-0 px-4 py-12">` with an inner `<div className="w-full max-w-sm">`. The `motion.div` and its `initial`/`animate` scale props are deleted along with the `framer-motion` import. The card becomes `<div className="border border-ink-300 bg-paper-1 p-6 md:p-8">` — radius 0, one hairline, no shadow.
- **Loading branch** (`!modeLoaded`): `<main className="flex min-h-dvh items-center justify-center bg-paper-0"><p className="font-sans text-[15px] text-ink-500">Loading…</p></main>`. `Loader2` deleted. (New copy; the branch currently shows a bare spinner and therefore says nothing to a screen reader. Do not add `role="status"` — no test expects an announcement here and adding one is a feature, matching the call `slice-E-spec.md` §E4.4 made for the partial-Redis notice.)
- **Header:** the `w-12 h-12 rounded-full` `Lock` circle dies. `<Label>Researcher access</Label>` (new eyebrow, additive), then `<h1 className="font-sans text-[24px] font-semibold leading-[32px] text-ink-900">Researcher Login</h1>` — copy verbatim, Public Sans per Slice D's rule that an `h1` naming a workspace is a page title, not a display line. The subtitle keeps its three-branch ternary character for character (`Sign in to access your research dashboard` / `Enter your admin password to access the dashboard` / `Sign-in is unavailable because this server is not configured.`) at `font-sans text-[13px] text-ink-500`. `text-center` dies.
- **Error block:** keeps its `(error || (mode === 'hosted' && !configReady))` condition and its `{error || 'This hosted instance is missing required configuration.'}` expression verbatim. Becomes `border-l-2 border-error bg-paper-2 px-4 py-3` with a `Label` eyebrow `Sign-in failed` and the message at 13px `text-ink-700`. `AlertCircle` deleted; `bg-red-500/10 border-red-500/30 text-red-400` dies. **Add no `role`** — it has none today.
- **Hosted branch:** the `configReady` ternary is unchanged. The not-ready sentence `Sign-in is disabled until the operator completes server configuration.` is verbatim at 13px `text-ink-500` (`Login.readiness.test.tsx:33` matches it) and `text-center` dies.
- **Standalone form:** the `<form onSubmit={handleSubmit} className="space-y-4">` survives. Route the password control through the `Field` primitive — `<Field label="Password" htmlFor="password">` wrapping the existing `<input>` — keeping `type="password"`, `value`, `onChange`, `autoFocus`, and the placeholder `Enter admin password` verbatim, plus `className="w-full"` so `Field`'s control classes merge to full width. No test walks the DOM from this input, so `Field`'s label-nesting is safe here (contrast `slice-E-spec.md` §E4.3, where two `parentElement` walks forbade it). The whole `focus:outline-none focus:ring-2 focus:ring-stone-500 focus:border-stone-500` cluster is deleted — the token focus ring in `globals.css` covers it.
- **Submit:** `<Button type="submit" variant="primary" disabled={!password.trim() || loading} className="w-full">{loading ? 'Logging in...' : 'Login'}</Button>` — both labels and the `disabled` expression verbatim, `Loader2` deleted.
- **Footer:** `<Rule className="mt-6" />` then `Back home` verbatim as a text button (`mt-6 block font-sans text-[13px] text-ink-500 hover:text-ink-900`, `min-h-11`) with its `router.push('/')` handler. `text-center` dies.

## G6. `src/components/OAuthLogin.tsx`

- **The not-configured branch keeps returning a node with no button.** `<p className="font-sans text-[13px] text-ink-500">Sign-in is not configured on this server.</p>` — copy verbatim. `OAuthLogin.providers.test.tsx:14` asserts `queryByRole('button')` finds **nothing** in this branch and `:15` matches `/not configured/i`; do not add a control, a link, or a `Disclosure` here.
- **Both provider buttons** become `<Button type="button" variant="quiet" disabled={loading} onClick={() => handleOAuth('google' | 'github')} className="w-full">` with the labels `Sign in with Google` and `Sign in with GitHub` verbatim. Both render gates (`providers.google &&`, `providers.github &&`) are unchanged; `Login.readiness.test.tsx:34–35, 49–50` and `OAuthLogin.providers.test.tsx:8–9` all resolve these buttons by name.
- **Both brand SVGs are KEPT — RULED by the orchestrator (see Open question 2).** Sign-in brand marks are functional affordances (§6 keeps icons for true affordances), not decoration: users scan for the familiar mark, and Google's brand guidelines effectively require their mark on a "Sign in with Google" control. Keep both SVGs exactly as they are, inside the restyled quiet `Button`s, each preceded by a scoped comment: `{/* Brand mark: functional sign-in affordance, exempt from the no-decorative-icons rule (§6) — orchestrator ruling, slice G */}`. The buttons' own chrome still migrates to tokens (`bg-white`/`gray-*`/`stone-*` die per the next bullet); only the SVG glyphs and their intrinsic brand colors survive.
- `Loader2` is deleted along with the whole `lucide-react` import; `Button`'s `disabled:opacity-50` carries the loading state. `bg-white`, `hover:bg-gray-50`, `text-gray-800`, `border-gray-200`, `bg-stone-700`, `hover:bg-stone-600`, `text-white`, and both `rounded-xl` all die.
- `handleOAuth`, its template URL, its `encodeURIComponent(returnTo)`, the `returnTo = '/studies'` default, and the `eslint-disable-next-line` comment above `window.location.href` are untouched.

## G7. `src/app/self-host/page.tsx`

A server component with no state — markup and copy only. Delete the whole `lucide-react` line (`ArrowLeft`, `ExternalLink`, `ShieldCheck`, `Terminal`).

- **Frame:** `<main className="min-h-dvh bg-paper-0">` wrapping `<Page className="py-12 md:py-20">` with `space-y-16` between sections (multiples of the 28px body leading, §4). `bg-stone-900 px-6 py-12 text-stone-100` and `mx-auto max-w-3xl space-y-8` both die — `Page` owns the frame.
- **Back link:** `<Link href="/" className="font-sans text-[13px] text-ink-500 underline underline-offset-2 hover:text-ink-900">Back home</Link>`, copy verbatim, no icon.
- **Cover:** `<Label>Self-host OpenInterviewer</Label>` (the existing `text-sm uppercase tracking-wide` eyebrow, copy verbatim, now at `Label`'s 11px/0.08em), then `<h1 className="font-sans text-[24px] font-semibold leading-[32px] text-ink-900 md:text-[32px] md:leading-[40px]">Your deployment, credentials, and storage</h1>` verbatim, then the lede paragraph verbatim at `font-sans text-[17px] leading-[28px] text-ink-700 max-w-measure`. **Sans, not serif** — this is operator documentation, not speech or interpretation.
- **Setup block:** `<h2 className="font-sans text-[15px] font-semibold text-ink-900">Agent-friendly setup</h2>` verbatim. The `<pre>` keeps `overflow-x-auto` and its `<code>{cloneCommands}</code>` child with the `cloneCommands` template literal **unchanged, character for character including the comment line and the trailing `npm run dev`** — a researcher copies this into a shell. Restyle: `overflow-x-auto bg-paper-2 p-4 font-mono text-[13px] leading-[20px] text-ink-900`. Radius 0; `rounded-xl bg-stone-950` dies. The trailing paragraph (`The setup checker reports missing variable names and invalid shapes only…`) is verbatim at 13px `text-ink-500`, `max-w-measure`. The section's `rounded-2xl border border-stone-700 bg-stone-800/60 p-6` becomes `border-t border-ink-300 pt-6`.
- **The two cards become one ruled column,** matching the landing page's treatment of its two deployment entries (`slice-D-spec.md` §D2.6): `divide-y divide-ink-300 border-t border-ink-300`, each entry `py-6`. `grid gap-4 sm:grid-cols-2` and both `rounded-2xl border border-stone-700 p-5` die. Headings `Security essentials` and `Full runbook` verbatim at `font-sans text-[15px] font-semibold text-ink-900`; both bodies verbatim at `font-sans text-[15px] leading-[24px] text-ink-700 max-w-measure`.
- **The runbook link** keeps its `href` verbatim (`https://github.com/linxule/openinterviewer#3-run-a-self-hosted-standalone-instance`) and its text `Open the setup guide` verbatim, restyled `mt-3 inline-block font-sans text-[13px] font-medium text-action underline underline-offset-2`. The trailing `ExternalLink` icon is deleted. It is an external `<a>`, not a `next/link`; keep it that way and do not add `target="_blank"` (it does not have one today).

## G8. `src/app/(researcher)/setup/page.tsx` — the `SetupLoading` fallback

The three lines Slices C, D, and E each explicitly refused to touch. `SetupLoading` renders **inside** `ResearcherShell`, which already owns `min-h-dvh bg-paper-0` and a `<Page>` container, so it must not draw a second full-height frame:

```tsx
function SetupLoading() {
  return <p className="py-16 font-sans text-[15px] text-ink-500">Loading…</p>;
}
```

Delete the `Loader2` import and the whole `lucide-react` line. **Nothing else in this file changes** — `await enforceResearcherPageSetup()` stays exactly where it is, in the page (`slice-C-spec.md` §C1 makes this a hard requirement, not a preference), and the `<Suspense fallback={<SetupLoading />}>` boundary around `<StudySetup />` is untouched.

## G9. `globals.css` and `tailwind.config.ts` — the last of the old palette

### G9.1 Delete the custom scrollbar

`globals.css` lines 43–60 (`::-webkit-scrollbar`, `-track`, `-thumb`, `-thumb:hover`) hard-code `#1c1917`, `#57534e`, and `#78716c` — dark-palette hexes that paint a charcoal scrollbar down the side of a paper page. Delete all four rules and the `/* Custom scrollbar */` comment.

**Deleted, not re-tokened.** DIRECTION defines no scrollbar token, §11 sets the texture budget at zero, and the platform's own scrollbar is the one piece of chrome the design should not be re-drawing. These are `-webkit-` selectors, so no grep gate applies; just confirm no component references a scrollbar utility (`grep -rn "scrollbar" src/`).

By this point `globals.css` should contain: the two token blocks, the token focus ring, the citation-note animation and its reduced-motion guard, and the `@layer components` block (`.trace-ring`, `.input-verbatim`, `.prose-verbatim`, `.composing-bar`). If any legacy block remains, name it in the handback rather than deleting it on the strength of this spec.

### G9.2 Delete the `stone` scale from `tailwind.config.ts`

```js
colors: {
  stone: {
    850: '#1c1917',
  },
  ...
}
```

`stone-850` was a custom shade added for the old dark demo. Grep-gate it — `grep -rn "stone-850" src/` — and, once clean (Slice D removes the last two consumers, `DemoSimulation.tsx` and `Landing.tsx`), delete the whole three-line `stone` entry. Leave `paper`, `ink`, `action`, `success`, `error`, `maxWidth.measure`, `boxShadow.note`, and the three `fontFamily` stacks exactly as they are. Do **not** add `evidence` or `disclosure` to the Tailwind scale — A4 keeps them scoped to the primitives, and that is load-bearing, not an oversight.

## G10. Ratchet zero (`eslint.config.mjs`)

Three changes, in this order.

### G10.1 Delete the allowlist mechanism outright

Remove the last seven entries **and the `legacyDesignAllowlist` const itself and the `ignores:` key that consumes it**, so the block reads:

```js
{
  // Verbatim design law — DIRECTION-final.md §2 and §3. Every file under src/ is
  // covered; there is no exemption list. Exempting a file again means arguing for
  // it in a diff, not appending a line.
  files: ['src/**/*.{ts,tsx}'],
  rules: {
    'no-restricted-syntax': ['error', ...restrictedSyntaxRules(designLawPatterns)],
  },
},
```

**Deleting the array is the point, and it is preferred over leaving it empty.** An empty array is a one-line append away from being non-empty, and the comment above it (`remove each file from this list as its slice migrates it`) invites exactly that. Deleting the mechanism makes a future exemption a visible structural change that a reviewer has to consent to. Also delete the four-line comment block above the `src/app/**/setup/page.tsx` entry, which documents a migration that is now finished.

### G10.2 Make the ratchet enforce the whole old palette

DIRECTION §2 asks for a "permanent CI grep for the old palette". Until now the rule has banned only `stone-`; the amber, purple, blue, green, red, and white classes were removed slice by slice with nothing stopping their return. Extend `designLawPatterns`, and add a `primitivesOnly` flag so the `src/components/ui/**` override stops being a hand-maintained filter:

```js
const designLawPatterns = [
  {
    regex: 'stone-',
    message: 'Tailwind stone-* utilities are legacy. Use the paper/ink token scale — see docs/design/DIRECTION-final.md.',
  },
  {
    regex: '(amber|blue|cyan|emerald|fuchsia|gray|green|indigo|lime|neutral|orange|pink|purple|red|rose|sky|slate|teal|violet|yellow|zinc)-(50|[1-9]00|950)',
    message: 'Tailwind default-palette utilities are banned. Use paper/ink/action/success/error — see docs/design/DIRECTION-final.md §2.',
  },
  {
    regex: '(text|bg|border|fill|stroke|placeholder|divide|ring|from|via|to)-(white|black)',
    message: 'Absolute white/black is not in the palette. Use paper-*/ink-* — see docs/design/DIRECTION-final.md §2.',
  },
  {
    regex: 'font-serif',
    primitivesOnly: true,
    message: 'Raw font-serif is reserved for src/components/ui primitives — see docs/design/DIRECTION-final.md.',
  },
  {
    regex: 'var\\(--evidence',
    primitivesOnly: true,
    message: '--evidence is scoped to src/components/ui primitives, not general-purpose use — see docs/design/DIRECTION-final.md.',
  },
  {
    regex: 'var\\(--disclosure',
    primitivesOnly: true,
    message: '--disclosure is scoped to src/components/ui primitives, not general-purpose use — see docs/design/DIRECTION-final.md.',
  },
];
```

and change the primitives block's filter from an equality test on `stone-` to:

```js
...restrictedSyntaxRules(designLawPatterns.filter((p) => !p.primitivesOnly)),
```

so the palette rules apply inside `src/components/ui/**` too — a primitive has no more business reaching for `amber-500` than a screen does — while `font-serif` and the two scoped custom properties remain exactly where A4 puts them.

**The digit anchor on the second pattern is load-bearing, not decoration.** A bare `red-` matches the substring inside `'oi:cred-refused'`, `'oi:cred-not-found'`, and eight other Lua-tag literals in `src/lib/platformDb.ts` (`:732–902`); requiring a Tailwind shade suffix is what keeps the rule from failing lint on storage code that has nothing to do with colour. **Verify this with `npm run lint`, not by inspection** — esquery's attribute-regex handling is the kind of thing that is easier to run than to reason about, and `slice-C-spec.md` §C6 hit the same class of problem with glob escaping. If a pattern proves unworkable in the selector syntax, ship the ones that work, say which one did not and why in the handback, and do not silently loosen a message.

### G10.3 Ban `framer-motion` at the import

DIRECTION §5 replaces the motion vocabulary with two named gestures and §10 kills `fade-up-20px` by name; every slice from B to G has deleted `motion.div`s, and nothing stops the next contributor adding one back. Add to the same `src/**` block:

```js
'no-restricted-imports': ['error', {
  paths: [{
    name: 'framer-motion',
    message: 'Motion is two named gestures in CSS (settle, the trace) — see docs/design/DIRECTION-final.md §5.',
  }],
}],
```

`lucide-react` is **not** banned: §6 keeps Lucide for functional actions (send/copy/download/close/chevron/external/check/alert) even though the migration happens to end with zero icons shipped. Leave both packages in `package.json` — pruning a dependency touches `package-lock.json` and is a supply-chain decision, not a design one. See Open question 3.

## G11. Tests

### Must keep passing, ideally untouched

- **`tests/unit/Export.mode.test.tsx`** — load-bearing, in the order it uses them: `getByRole('heading', { name: 'Return to interview completion' })` as an **exact, level-agnostic** name (`:32`); `queryByRole('button', { name: /download json/i })` **absent** in participant mode (`:33`); `queryByRole('button', { name: /new participant/i })` **absent** in participant mode (`:34`); `getByRole('button', { name: /return to completion status/i })` and, after the click, `useStore.getState().currentStep === 'synthesis'` and `router.replace('/synthesis')` (`:36–39`); `getByRole('heading', { name: 'Preview complete' })` exact (`:46`); `getByText(/was not added to study data/i)` (`:47`); `getByRole('button', { name: /download json/i })` present in preview (`:48`); `/run preview again/i` and `/return to study setup/i` present (`:49–50`); `/new participant/i` **absent** in preview (`:51`).
- **`tests/unit/Login.readiness.test.tsx`** — load-bearing: `findByText(/sign-in is disabled until the operator completes server configuration/i)` (`:33`); `queryByRole('button', { name: /sign in with google/i })` and `/sign in with github/i` both **absent** when `ready: false` even though both providers are configured (`:34–35`) — the fail-closed behaviour is on DIRECTION §9's unconditional keep list; `findByRole('button', { name: /sign in with google/i })` present and `/sign in with github/i` absent when `ready: true` with only Google configured (`:49–50`). Both cases mock `fetch` with a bare `{ json }` object, so the component must keep using `.then(res => res.json())` and must not start reading `res.ok`.
- **`tests/unit/OAuthLogin.providers.test.tsx`** — load-bearing: `getByRole('button', { name: /sign in with google/i })` with `providers={{ google: true, github: false }}` (`:8`); and with no providers, `queryByRole('button')` **absent** (`:14`) and `getByText(/not configured/i)` present (`:15`). The first of these is the direct guard on G6: if a brand SVG were kept inside a `<button>`, `:14` would still pass, but any additional control would break it.

If any of these breaks, the fix is in the component, not the test.

### New, smallest realistic regressions

- **`tests/unit/Export.register.test.tsx`**
  - in preview mode, `container.querySelectorAll('svg')` has length `0`, and no rendered element carries a class matching `/stone-|rounded-xl|rounded-full/`;
  - in preview mode there is **no** element with `role="note"` (the one-band rule: `Export` carries no ochre of its own);
  - the four summary values render inside `font-mono` elements and the group is reachable as `getByRole('group', { name: 'Session summary' })`;
  - clicking `Copy to Clipboard` (with `navigator.clipboard.writeText` stubbed) flips the visible label to `Copied!` and calls the stub exactly once with a string that `JSON.parse`s to an object whose `study.id` is the seeded study id — the cheapest possible guard that `generateJSON` was not touched;
  - in participant mode, `container.querySelectorAll('svg')` has length `0`.
- **`tests/unit/Login.paper.test.tsx`**
  - with `mode: 'standalone'`, `getByLabelText('Password')` resolves to an `input[type="password"]` and typing into it enables the `Login` button, which is disabled while the field is empty;
  - `container.querySelectorAll('svg')` has length `0` in the standalone and hosted-not-ready states; in the hosted-ready state the ONLY `svg` nodes are inside the two OAuth provider buttons (the kept brand marks — assert `svg` count equals the number of rendered provider buttons and every `svg` has a `button` ancestor);
  - the error block (hosted, `ready: false`) renders the exact sentence `This hosted instance is missing required configuration.` and carries **no** `role="alert"` (the assertion that documents G5's deliberate non-change);
  - no rendered element carries a class matching `/stone-|red-500|red-400/`.

Do not snapshot any component in this slice.

## G12. Verification — the canonical ladder plus the terminal greps

```bash
npm run lint && npm run typecheck && npm run test
DEPLOYMENT_MODE=standalone npm run build
npm run test:e2e
```

Then the greps that close Initiative 1. **Every one must return no output**, and the handback must paste the results:

```bash
# 1. The old palette is gone from src/ entirely.
grep -rn "stone-" src/
grep -rnE "\b(amber|blue|cyan|emerald|fuchsia|gray|green|indigo|lime|neutral|orange|pink|purple|red|rose|sky|slate|teal|violet|yellow|zinc)-(50|[1-9]00|950)\b" src/
grep -rnE "(text|bg|border|fill|stroke|placeholder|divide|ring|from|via|to)-(white|black)\b" src/

# 2. The motion and icon vocabularies are gone.
grep -rn "framer-motion" src/
grep -rn "lucide-react" src/

# 3. The ratchet has no exemptions left.
grep -n "legacyDesignAllowlist\|ignores:" eslint.config.mjs

# 4. Dead CSS and config are gone.
grep -rn "preview-banner\|::-webkit-scrollbar\|stone-850" src/ tailwind.config.ts
grep -rn "\bprose\b" src/ --include='*.tsx' --include='*.ts' | grep -v prose-verbatim
```

If grep 2's `lucide-react` line returns a hit, that is not automatically a failure — §6 permits functional icons — but it must be named in the handback with the file and the icon, because at spec time the expectation is zero.

Then, by hand:

- **Body audit.** Load `/`, `/demo`, `/login`, `/self-host`, `/consent`, and `/p/<token>` and confirm every one sits on paper with no dark band anywhere, including during route transitions.
- **iOS overscroll (G2).** At 375px, scroll past the top and bottom of `/login` and `/consent` and confirm the rubber-band area paints paper. Record in the handback whether `bg-paper-0` on `<body>` sufficed or `<html>` needed it too.
- **Auth audit.** Walk `/login` in all three modes (hosted-ready, hosted-not-ready, standalone) and confirm the fail-closed branch still shows no usable sign-in control. This is honesty behaviour on DIRECTION §9's keep list and the reskin must not have widened it.
- **Participant front door.** Load `/p/<invalid-token>` and confirm the error state is warm paper with no emoji, no spinner, and no rail.
- **Shell audit.** Confirm `/setup`'s loading fallback does not draw a second full-height column inside the shell.
- 375 / 1024 / 1440 visual pass on `/login`, `/self-host`, `/export`, and `/p/<invalid-token>`.

Leave the dev server runnable for the orchestrator's screenshots. **This is the last slice of Initiative 1**, so the handback should also state plainly whether every one of the sixteen named screens now renders in the Verbatim register, and name any that do not.

## Hard constraints

- Files that may change: `src/components/Export.tsx`, `src/components/Login.tsx`, `src/components/OAuthLogin.tsx`, `src/app/self-host/page.tsx`, `src/app/p/[token]/page.tsx`, `src/app/(researcher)/setup/page.tsx` (only `SetupLoading` and the `lucide-react` import, per G8), `src/app/layout.tsx` (only the `<body>` className, per G2, plus `<html>` only if G2's overscroll check demands it), `src/app/globals.css` (only the scrollbar deletion, per G9.1), `tailwind.config.ts` (only the `stone` entry, per G9.2), `eslint.config.mjs` (per G10), and the tests in G11. Nothing else.
- **`generateJSON`, `generateTranscript`, and `handleDownloadTranscript`'s output are file formats, not markup.** Not one character of their emitted strings changes — not a heading level, not a separator, not a label. If a reviewer sees a diff line inside those functions that is not pure reformatting, that is a defect.
- Both open-redirect guards in `Login.tsx` survive verbatim (`:22–25` and `:89–92`), including the duplication. Consolidating them is a security-adjacent refactor and belongs in its own PR with its own review.
- No store, service, type, API route, `proxy.ts`, `hostedOAuth.ts`, or `researcherAccess.ts` changes.
- Do not touch `src/components/shell/**`, anything under `src/components/ui/` (frozen contracts), or any component migrated by Slices B–F. If a primitive genuinely cannot express something here, style around it in the component and record why in the handback; do not edit the primitive.
- No new dependencies, and no dependency removals (see G10.3 and Open question 3). No `framer-motion` and no `lucide-react` in any file this slice writes.
- No `data-theme` wiring and no theme toggle; light Paper only, tokens only (A6).
- Do not commit; leave the working tree for review. `docs/` is untracked — leave it. npm only (`package-lock.json` authoritative), Node ≥ 24.19.

## Deferred, do not attempt

- **The researcher Night theme toggle.** Every slice has been token-only precisely so this stays cheap: a `data-theme="night"` attribute, a persisted preference, and a control in the shell. The `[data-theme="night"]` block already exists in `globals.css:24–41` and is currently dead code. It is its own PR, gated on the researcher walkthrough (A9), and A6 forbids it ever reaching the participant flow or the demo.
- **Participant transcript download** on `Export`'s participant branch (DIRECTION §7 Receipt, Initiative 3) — ships only after the privacy/consent review.
- **Typeset HTML/PDF export** (Initiative 3).
- **Consolidating `Login.tsx`'s duplicated redirect guard.**
- **Pruning `framer-motion` and `lucide-react` from `package.json`** — see Open question 3.
- **`Slice F1: StudySetup document IA`** (`slice-E-spec.md` §E1) and the merged `InterviewDetail` reading (`slice-F-spec.md` Deferred) both remain open; neither is Initiative 1 work.

## Open questions for the orchestrator

1. **Delete the allowlist array, or leave it empty?** G10.1 deletes the const, the `ignores:` key, and the migration comments, on the reasoning that an empty array plus a comment saying "remove each file as its slice migrates it" is an invitation, while deleting the mechanism makes a future exemption an argued diff. The counter-argument is that a future contributor adding a legitimately-exempt file (a vendored third-party widget, say) now has to re-derive the mechanism. This spec takes the delete; it is a two-line difference either way and the orchestrator should confirm.

2. **The OAuth brand marks — RULED (orchestrator, 2026-08-26): keep both, with a scoped exemption comment.** Rationale: §6 keeps icons for functional affordances; sign-in brand recognition is functional, and Google's brand guidelines effectively require their mark on their button. G6 and the `Login.paper.test.tsx` spec above are already updated to this ruling. (Owner may veto — recorded in the session board update.)

3. **Prune `framer-motion` and `lucide-react` from `package.json`?** After G, `src/` imports neither. G10.3 bans `framer-motion` at the import but leaves both packages installed, because removing a dependency rewrites `package-lock.json` and is a supply-chain decision. `framer-motion` is a clear candidate for removal (§5 and §10 kill its whole vocabulary); `lucide-react` is not (§6 explicitly keeps Lucide for functional actions, and the migration ending with zero icons is a fact about these sixteen screens, not a rule). Recommend removing `framer-motion` in a separate one-line PR after G lands.

4. **`Export`'s stats row.** G4.3 keeps all four counters (`Messages`, `Questions`, `Profile`, `Themes`) because they are existing copy and the slice is a reskin. But `Themes` counts `synthesis?.themes.length`, which is a count of model output presented as a session statistic beside three counts of things the participant actually did — a small category error that the old boxed tiles hid and the new ruled register will make more legible, not less. If the owner wants it dropped, it is one cell and one label; if not, it stays exactly as it is.
