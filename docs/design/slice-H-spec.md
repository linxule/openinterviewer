# Slice H — Truthful chrome and the two missing primitives (Initiative 3, first slice, depends on nothing)

Fixes the five defects that make the shipped interface say something false or unfinished — D3 (a document that reads "1 core questions"), D4 (a bracketed placeholder in the text participants sign), D5 (an ID column that prints the word `session-`), D7 (Tailwind-scale sizes and boxed structure in the flagship and the login form), D9 (a real surface with no navigation) — and builds the two primitives the rest of the train depends on: `Notice` (C3) and `Icon` (C4). Context: `docs/design/initiative-3-brief.md` (defect table, Move C, decisions of record 1 and 2) and `docs/design/DIRECTION-final.md` §3 (type scale), §4 (rules over boxes, radius), §6 (iconography), §7 (Participant / Researcher workspace), §9 (keep list), §10 (kill list).

**Prerequisites: none.** Slice H is the base of the Initiative 3 train. Slices I, K, and M all rebase on it, and I and M adopt `Notice` in the files they own (Settings, Onboarding, StudySetup). Do not adopt `Notice` or `Icon` in those three files here — see H9 and the Hard constraints.

**Prime directive: this is a correctness and vocabulary pass, not a logic rewrite.** Every handler, effect, fetch, guard, ref, and disabled expression survives byte-for-byte in behaviour, and every re-registered block renders the same DOM shape with different classes. In `Consent` that means `handleConsent`, `handleBack`, the whole `providerDisclosure` ternary chain, and the `providerConfigurationReady` derivation. In `InterviewChat` that means the greeting effect and `greetingStartedRef`, `handleSend`, `handleRetryGreeting`, `handleTextareaKeyDown`, `handleFinishEarly`, `handleViewAnalysis`, the autogrow effect, and the scroll effect. In `StudySetup` that means the entire idempotency apparatus (`setupIntentKey`, `adoptCreateIdempotencyKey`, `authorityEpochRef`, `intentKeyRef`, `createIdempotencyKeyRef`, `applySaveIfCurrent`, and the full `classification.outcome` ladder including the `window.confirm` path) — the only lines that change in that file are the four named in H11. In `Dashboard`, `StudyList`, `StudyDetail`, `Export`, and `Synthesis`, every storage call, reconciliation path, `alert()`, and `window.confirm` is untouched. If a change is not named below, do not make it.

## H1. Laws that bind this slice

- **Tokens only.** `bg-paper-*`, `text-ink-*`, `border-ink-*`, `text-action`, `text-success`, `text-error`. `eslint.config.mjs:6–43` enforces this on all of `src/**`; there is no allowlist to fall back on.
- **Wine and ochre stay inside `src/components/ui/`.** Neither `Notice` nor `Icon` may reference `var(--evidence)` or `var(--disclosure)`. Nothing in this slice cites anything, and nothing in this slice is disclosure chrome. `Disclosure` keeps its one existing consumer (`Consent.tsx:133`) and gains none.
- **Radius: 0 for structure, `rounded` for controls.** The three structural `rounded` blocks named in D7 die. The textarea at `InterviewChat.tsx:402`, the read-only link input at `StudyDetail.tsx:880`, the `Button` primitive's own `rounded`, and the menu panel at `StudyList.tsx:388` are controls and keep theirs.
- **No new npm dependency.** `Icon` is six inline SVGs. Do not add `lucide-react` back (it was removed from `package.json` in the 2026-09-05 maintenance train); do not add any icon package.
- **Icons are aria-hidden, always.** Every `Icon` render is decorative at the accessibility layer; the accessible name comes from adjacent `sr-only` text or from the host control's `aria-label`. No `Icon` ever carries a `title`, a `role="img"`, or an `aria-label` of its own.
- **Honesty copy is verbatim (§9).** Not one word changes in: `This is not an AI reply — please try again.`, `Your responses have not been saved yet…`, `Preview responses will not be added to study data.`, `The researcher is the study's data controller…`, `This interview is unavailable until the researcher reviews and saves its AI provider settings.`, `Take as much space as you need.`, `Your keys · your database`. Type sizes and radii change; strings do not.
- **Light only.** No `dark:` variant, no `data-theme` read or write, no toggle. Four of the eleven files touched here are participant-facing.
- **Behaviour byte-identical except where named.** In particular: no `role` is added to or removed from any existing block, no heading level changes, and no accessible name changes. The one deliberate exception is `ResearcherShell`'s `aria-current` placement, which H10 changes on purpose.

## H2. `src/components/ui/Notice.tsx` — the ruled status block (C3)

The pattern `border-l-2 border-<tone> bg-paper-2 px-4 py-3` appears 27 times across 8 files (`grep -rn "border-l-2" src/`). One primitive, three tones, an eyebrow slot and a body slot.

```tsx
import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Label } from './Label'

export interface NoticeProps extends HTMLAttributes<HTMLDivElement> {
  tone?: 'neutral' | 'error' | 'success'
  /** Label eyebrow above the body. Omit for a body-only notice. */
  eyebrow?: ReactNode
  children: ReactNode
}

const toneBorder: Record<NonNullable<NoticeProps['tone']>, string> = {
  neutral: 'border-ink-500',
  error: 'border-error',
  success: 'border-success',
}

export function Notice({ tone = 'neutral', eyebrow, children, className, ...props }: NoticeProps) {
  return (
    <div className={cn('border-l-2 bg-paper-2 px-4 py-3', toneBorder[tone], className)} {...props}>
      {eyebrow ? <Label>{eyebrow}</Label> : null}
      {children}
    </div>
  )
}
```

Four contract decisions, each load-bearing:

1. **`Notice` renders no icon, ever.** `Synthesis.register.test.tsx:50` asserts `container.querySelectorAll('svg').length === 0` across all four participant states, and `StudyDetail.register.test.tsx:105,109,113` asserts the same across all three tabs. Both files adopt `Notice` in H9. An icon inside the primitive would break four assertions at once for decoration, and §6 admits icons for *functional actions*, which a status block is not.
2. **`Notice` renders `children` directly, with no injected body wrapper.** Existing call sites carry their own body element and their own type: `<p className="mt-1 text-[13px] text-ink-700">` after an eyebrow, `<p className="text-[13px] text-ink-700">` without one, and `<p className="font-sans text-[15px] leading-[24px] text-ink-700" role="alert">` in the two `Synthesis` participant blocks. Injecting a wrapper would change the DOM in nine places and move a `role="alert"` off the element that carries it. The frame is the duplication; the body is not.
3. **`...props` spreads onto the root `<div>`.** `role="status"` (`Dashboard.tsx:225`, `StudyList.tsx:227`, `StudyDetail.tsx:396`) and any future `id`/`aria-*` pass through unchanged. Do not hard-code a `role`.
4. **Class order matters.** `cn` is `twMerge(clsx(...))`, so a caller passing `className="mb-6"` merges cleanly and a caller passing a conflicting border colour would win. No current caller does; do not add one.

Body-type convention for reviewers (not enforced by the primitive): eyebrow present → body is `<p className="mt-1 text-[13px] text-ink-700">`; eyebrow absent → `<p className="text-[13px] text-ink-700">`. The two `Synthesis` participant blocks are the deliberate exception at 15/24, because they are the participant's document, not the researcher's register.

Export from `src/components/ui/index.ts`: `export { Notice, type NoticeProps } from './Notice'`.

## H3. `src/components/ui/Icon.tsx` — six functional marks, no dependency (C4)

```tsx
export type IconName = 'close' | 'copy' | 'external' | 'chevron' | 'check' | 'alert'

export interface IconProps {
  name: IconName
  /** 16 for inline row controls, 18 for buttons. Default 16. */
  size?: 16 | 18
  className?: string
}
```

Implementation rules:

- One `<svg>` with `viewBox="0 0 24 24"`, `width={size}`, `height={size}`, `fill="none"`, `stroke="currentColor"`, `strokeWidth={1.5}`, `strokeLinecap="round"`, `strokeLinejoin="round"`, `aria-hidden="true"`, `focusable="false"`, and `className={cn('shrink-0', className)}`.
- Colour is always inherited (`currentColor`). `Icon` sets no colour class of its own, so it takes the tone of the control it sits in — including the `group-hover:text-action` on `Export`'s rows.
- Path data, keyed by name (Lucide geometry, ISC-licensed, inlined per C4 — put the attribution in a file-header comment):

| name | `d` |
|---|---|
| `close` | `M18 6 6 18M6 6l12 12` |
| `copy` | `M8 8h11a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z` and `M4 16V5a1 1 0 0 1 1-1h11` |
| `external` | `M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6` |
| `chevron` | `m6 9 6 6 6-6` (down; rotate with a `className` if a caller ever needs another direction) |
| `check` | `M20 6 9 17l-5-5` |
| `alert` | `M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z` |

**`external` and `alert` ship with no consumer in this slice, and that is correct.** Every `target="_blank"` link in the repo lives in `Settings.tsx` and `Onboarding.tsx` (17 of them; `grep -rn 'target="_blank"' src/`), both owned by Slice I. `alert` is for Slice I's and M's notice adoption if they want it. Build all six now so the set is decided once; H12 covers all six with a primitive test.

Export from `src/components/ui/index.ts`: `export { Icon, type IconName, type IconProps } from './Icon'`.

## H4. `src/components/Consent.tsx` — D3 and D7

Three lines change. Nothing else in the file moves.

**`:107` — pluralization (D3).** Replace

```tsx
<p className="text-ink-900">{studyConfig.coreQuestions.length} core questions about your experiences</p>
```

with

```tsx
<p className="text-ink-900">
  {studyConfig.coreQuestions.length} core question{studyConfig.coreQuestions.length !== 1 ? 's' : ''} about your experiences
</p>
```

Use exactly this shape — `!== 1 ? 's' : ''` — matching the precedent already in `Dashboard.tsx:178` and `StudyList.tsx:186`. The surrounding text nodes stay in one `<p>` with no wrapping element, so `getByText(/1 core question about your experiences/)` resolves against the paragraph's `textContent`.

**`:124` — the data notice loses its radius (D7).** `rounded bg-paper-2 p-4 …` → `bg-paper-2 p-4 …`. Everything else on that block, including the `font-mono` span carrying `providerDisclosure` and every word of the controller sentence, is verbatim. **This block does not become a `Notice`**: it is a standing fact block (a `bg-paper-2` well with mono for the machine-verifiable clause), not a status notice, and it has no left rule today.

**`:139` — the consent error loses its radius and its Tailwind-scale size (D7).** `rounded bg-error px-4 py-3 text-sm text-paper-1` → `bg-error px-4 py-3 font-sans text-[15px] leading-[24px] text-paper-1`. **It stays a filled terracotta block** — DIRECTION §7 "Participant / Failure: filled terracotta block" is explicit, and this is the participant's fail-closed surface. It does not become a `Notice`. `role="alert"` stays exactly where it is: `Consent.serverConsent.test.tsx:121` resolves this block by role and asserts its text.

## H5. `src/components/InterviewChat.tsx` — D7

Three lines change. The pane split, the sticky composer, and the centered completion panel are **Slice K's** work (Move A1); do not restructure the layout here.

- **`:354`** `font-sans text-lg font-semibold text-ink-900` → `font-sans text-[18px] leading-[26px] font-semibold text-ink-900`. The element stays an `<h3>` and both branch strings stay verbatim; `research-workflow.spec.ts:26` matches `/conversation complete/` level-agnostically and `InterviewChat.greeting.test.tsx:224` matches `Preview conversation complete` exactly.
- **`:357`** `text-sm text-ink-500` → `font-sans text-[15px] leading-[24px] text-ink-700`. **This is a deliberate two-part change and the reviewer should see it as one.** DIRECTION §3's scale has no 14px step; the two candidates are 13/20 meta and 15/24 UI body. This paragraph carries `Your responses have not been saved yet.` — a fail-closed honesty statement pinned by `InterviewChat.greeting.test.tsx:201–202` — and rounding it down to meta grey would shrink and mute the one sentence on the screen that must be read. It moves up to body type and body ink. Both branch strings stay verbatim.
- **`:373`** `flex items-start justify-between gap-3 rounded bg-error px-4 py-3 text-sm text-paper-1` → `flex items-start justify-between gap-3 bg-error px-4 py-3 font-sans text-[15px] leading-[24px] text-paper-1`. Filled terracotta stays filled (§7); only the radius and the Tailwind-scale size go. `role="alert"`, the `Try again` control, its `disabled={isAiThinking}`, and `handleRetryGreeting` are untouched.

`text-center` on `:353` stays — killing the centered completion panel is A1, and A1 is Slice K.

## H6. `src/components/Login.tsx` — the bordered card dies (D7)

`:112` currently wraps the whole form in `<div className="border border-ink-300 bg-paper-1 p-6 md:p-8">`. §4 is "rules over boxes"; a login form is not a raised sheet. Delete that element and let the content sit on `bg-paper-0`, structured by rules:

- Delete the opening and closing tags of the `border … bg-paper-1 p-6 md:p-8` div. The `<main>` frame at `:110` and the `w-full max-w-sm` div at `:111` are unchanged.
- The header block at `:113` loses `mb-6`; insert `<Rule className="my-6" />` immediately after it. (`Rule` is already imported.)
- Everything inside is otherwise byte-identical: the `Label`, the `h1`, the three-branch subtitle ternary, the error block at `:125–132`, the hosted/standalone branch, the `Field`-wrapped password input, the submit `Button` and its `disabled` expression, and the closing `<Rule className="mt-6" />` + `Back home` button.
- **Both open-redirect guards survive verbatim** (`:21–24` and `:88–91`), including the duplication. Consolidating them is a security-adjacent refactor with its own review.

`Login`'s error block at `:126–131` **becomes a `Notice`** (ruling on Open question 1): `<Notice tone="error" eyebrow="Sign-in failed" className="mb-4">` wrapping the existing `<p className="mt-1 font-sans text-[13px] text-ink-700">` verbatim. No `role` is added — `Login.paper.test.tsx:91–105` asserts the missing-configuration sentence carries no `role="alert"`. `Login.paper.test.tsx:42–55` (`svg` count 0 in standalone), `:91–105` (the missing-configuration sentence carries no `role="alert"`), and `:107–122` (no legacy classes) must all pass unchanged; none of them touches the card.

## H7. `src/lib/interviewId.ts` and the ID column — D5

`interview.id.slice(0, 8)` on an id shaped `session-<uuid>` (`src/app/api/interviews/save/route.ts:175`) renders the literal string `session-` in three places. New module:

```ts
const ID_PREFIXES = ['session-', 'interview-']

/**
 * Display-only. Saved interview ids are `session-<uuid>`; the seeded sample
 * workspace uses `interview-demo-<name>`. Either prefix is identical across
 * rows, so strip it and show the part a researcher can distinguish rows by.
 * A short remainder (the sample workspace's `demo-sarah`) is shown whole.
 */
export function shortInterviewId(id: string): string {
  const prefix = ID_PREFIXES.find((candidate) => id.startsWith(candidate))
  const body = prefix ? id.slice(prefix.length) : id
  return body.length <= 12 ? body : body.slice(0, 8)
}
```

(Ruling on Open question 4: the `interview-` prefix and the ≤12 whole-remainder rule are in scope, so the sample workspace reads `demo-sarah`, not `intervie`.)

It is a shared module rather than a two-line local helper because three surfaces render the same column and must not drift; it is in `src/lib/` because it is a fact about the id shape the save route mints, not about any one component.

Three call sites:

| file:line | before | after |
|---|---|---|
| `Dashboard.tsx:335` | `<Coordinate>{interview.id.slice(0, 8)}</Coordinate>` | `<Coordinate>{shortInterviewId(interview.id)}</Coordinate>` |
| `StudyDetail.tsx:618` | `<Coordinate>{interview.id.slice(0, 8)}</Coordinate>` | `<Coordinate>{shortInterviewId(interview.id)}</Coordinate>` |
| `shell/breadcrumb.tsx:85` | `{ label: trailing ?? id.slice(0, 8), … }` | `{ label: trailing ?? shortInterviewId(id), … }` |

The breadcrumb site is the same defect on the same identifier and is in scope. `ResearcherShell.test.tsx:54–62` passes an id of `abc123`, which has no prefix and is shorter than eight characters, so `shortInterviewId('abc123') === 'abc123'` and that assertion holds unchanged.

**Do not touch `Dashboard.tsx:206` or `breadcrumb.tsx:59`** — both slice *study* ids, which are bare UUIDs with no prefix.

## H8. D6 — the four icon sites in this slice's files

D6 also names `StudySetup.tsx:906,1046,1091,1129`. **Those belong to Slice M** (which owns the StudySetup rewrite and the test that forbids icons there). Four sites here:

**`StudyList.tsx:251–258` — the dismiss `×`.** Replace the bare `×` text child with `<Icon name="close" />`. The button keeps `type="button"`, `onClick={() => setSampleMessage(null)}`, `aria-label="Dismiss message"`, and its classes, and gains `min-h-11 min-w-11 flex items-center justify-center` so the 16px mark still has a 44px touch target at 375px. Because the `Icon` is `aria-hidden`, the accessible name remains `Dismiss message`.

**`StudyList.tsx:373–385` — the "Actions" row-menu trigger.** Keep the visible word `Actions`; add the chevron after it. The button becomes `className="inline-flex items-center gap-1 min-h-11 text-[13px] text-ink-500 hover:text-ink-900"` with children `Actions` then `<Icon name="chevron" className={menuOpenId === study.id ? 'rotate-180' : undefined} />`. `aria-label={\`Open actions for ${name}\`}`, `aria-haspopup="menu"`, `aria-expanded`, the `ref` callback, and the `onClick` toggle are all unchanged — `StudyOperationRecovery.ui.test.tsx:151` resolves this control by the exact accessible name `Open actions for Pending Delete Study`, and an `aria-hidden` child cannot change it.

**`StudyDetail.tsx:882–884` — Copy.** `<Button variant="quiet" onClick={handleCopyLink} className="inline-flex items-center gap-2">` with children `<Icon name={copied ? 'check' : 'copy'} />` then `<span>{copied ? 'Copied!' : 'Copy'}</span>`. `handleCopyLink` and its 2000ms timeout are untouched. Both labels verbatim. This button only renders inside `{participantLink && …}` at `:873`, which is why `StudyDetail.register.test.tsx:113` (no `svg` on the Study settings tab) still passes: that test never generates a link.

**`Export.tsx:315–326` — Copy to Clipboard.** The row button gains an icon before its title span:

```tsx
<span className="flex items-center gap-2">
  <Icon name={jsonCopied ? 'check' : 'copy'} />
  <span className={`font-sans text-[15px] font-medium group-hover:text-action ${jsonCopied ? 'text-success' : 'text-ink-900'}`}>
    {jsonCopied ? 'Copied!' : 'Copy to Clipboard'}
  </span>
</span>
```

The outer `<button>`, `handleCopyJSON`, both labels, and the description span are unchanged. **This is the one place in the slice that breaks an existing assertion** — see H12.

Do **not** add icons to `Download JSON` or `Download Transcript`: `download` is not in the six-name set and adding a seventh is a scope decision, not a defect fix.

## H9. Notice adoption — five files, seventeen sites

Adopt in exactly these files: `Synthesis.tsx`, `Dashboard.tsx`, `StudyList.tsx`, `StudyDetail.tsx`, and `Login.tsx` (the one site in H6). `InterviewChat`, `Consent`, and `Export` are in the permitted set but **contain no instance of the pattern** — the two participant error blocks are filled terracotta per §7 (H4, H5) and `Export` has no notice block at all. Say so in the handback rather than inventing one.

Every conversion must produce byte-identical rendered classes. The mapping is mechanical:

| file:line | tone | eyebrow | other props |
|---|---|---|---|
| `Synthesis.tsx:221` | `error` | — | — |
| `Synthesis.tsx:240` | `error` | — | — |
| `Synthesis.tsx:294` | `success` | `Saved` | — |
| `Synthesis.tsx:302` | `neutral` | `Preview` | — |
| `Synthesis.tsx:310` | `error` | `Not saved` | — |
| `Synthesis.tsx:321` | `neutral` | `Saving` | — |
| `Dashboard.tsx:225` | `error` | `Pending reconciliation` | `role="status"`, `className="mb-6"` |
| `Dashboard.tsx:241` | `error` | `Workspace` | `className="mb-6"` |
| `StudyList.tsx:213` | `error` | the existing conditional expression | `className="mb-6"` |
| `StudyList.tsx:227` | `error` | `Pending reconciliation` | `role="status"`, `className="mb-6"` |
| `StudyList.tsx:245` | `sampleMessage.type` | — | `className="mb-6 flex items-start gap-3"` |
| `StudyDetail.tsx:396` | `error` | `Pending reconciliation` | `role="status"`, `className="mb-6"` |
| `StudyDetail.tsx:658` | `neutral` | the existing interview-count template literal | — |
| `StudyDetail.tsx:769` | `error` | — | `className="mt-3"` |
| `StudyDetail.tsx:796` | `error` | — | `className="mt-3 flex items-center justify-between gap-3"` |
| `StudyDetail.tsx:886` | `error` | — | — |

(Sixteen rows here plus `Login.tsx:126` in H6.) Notes:

- `StudyList.tsx:245` currently builds its border colour with a template literal ternary. `tone={sampleMessage.type}` replaces it exactly — `'success' | 'error'` is already the union `NoticeProps['tone']` admits.
- The `<Button>` children inside `Dashboard.tsx:228`, `StudyList.tsx:231`, `StudyDetail.tsx:399`, and `Synthesis.tsx:315` move inside `Notice` unchanged, keeping their `mt-2`.
- `StudyDetail.tsx:698` (`border-l-2 border-ink-300 pl-4` on a core-question `<li>`) and `ResearcherShell.tsx:58` (the rail's active indicator) match the grep but are **not** notice blocks. Leave both.
- **Do not adopt in `Settings.tsx` (3 sites), `Onboarding.tsx` (1), or `StudySetup.tsx` (6).** Slices I and M own those files.

## H10. D9 — `/dashboard` joins the rail as "Interviews"

Decision of record 2: rail, not fold. `ResearcherShell.tsx` and `shell/breadcrumb.tsx`.

**`ResearcherShell.tsx:9–12` — the destination list.** Insert `Interviews` between `Studies` and `Settings`:

```ts
const destinations = [
  { label: 'Studies', href: '/studies' },
  { label: 'Interviews', href: '/dashboard' },
  { label: 'Settings', href: '/settings' },
];
```

Both navs map over this array, so the rail (`:51`) and the mobile top bar (`:90`) both pick it up with no further edit.

**`ResearcherShell.tsx:14–19` — `isDestinationActive`.** The current implementation makes `/studies` active for everything that is not `/settings`, which would light Studies on `/dashboard`. Replace with:

```ts
function isDestinationActive(href: string, pathname: string): boolean {
  const inSettings = pathname === '/settings' || pathname.startsWith('/settings/');
  const inInterviews = pathname === '/dashboard' || pathname.startsWith('/dashboard/');
  if (href === '/settings') return inSettings;
  if (href === '/dashboard') return inInterviews;
  // '/studies' is the fallback destination: it owns /studies, /studies/<id>, and /setup.
  return !inSettings && !inInterviews;
}
```

This preserves today's behaviour for `/setup` and `/studies/<id>` (Studies active) and changes it only for `/dashboard*`. Exactly one destination is ever active.

**`shell/breadcrumb.tsx:70–87` — the two dashboard trails lose their leading `Studies` crumb.** Once Interviews is a sibling of Studies in the rail, a breadcrumb claiming Interviews is a child of Studies contradicts the `aria-current` the rail is setting on the same screen.

```ts
if (pathname === '/dashboard') {
  const items: CrumbItem[] = [{ label: 'Interviews', href: trailing ? '/dashboard' : null }];
  if (trailing) items.push({ label: trailing, href: null });
  return items;
}

const interviewDetailMatch = pathname.match(/^\/dashboard\/interview\/([^/]+)$/);
if (interviewDetailMatch) {
  const id = interviewDetailMatch[1];
  return [
    { label: 'Interviews', href: '/dashboard' },
    { label: trailing ?? shortInterviewId(id), href: null, mono: !trailing },
  ];
}
```

`buildTrail`'s `/settings`, `/studies`, `/studies/<id>`, `/setup`, and fallback branches are unchanged. This rewrites one assertion in `ResearcherShell.test.tsx` — see H12.

**Not in scope:** renaming `Dashboard`'s `<h1>Interview Dashboard</h1>` (`Dashboard.tsx:176`) or `InterviewDetail`'s `Back to Dashboard` button (`InterviewDetail.tsx:152–154`) to match the rail's "Interviews". Both are real coherence gaps the rail change creates; `InterviewDetail` is Slice I's file and the pair should move together. Open question 3.

## H11. D4 — consent text templated from the research question, and the save-time guard

Decision of record 1: the default consent text is generated from the research question at study-save time, no bracketed token can be saved, and the researcher may overwrite. Four files.

### H11.1 `src/lib/consentText.ts` (new)

```ts
/**
 * The default consent text a study saves when the researcher leaves the field
 * blank. Generated from the research question at save time so participants
 * never read an unfilled placeholder. The researcher may overwrite it.
 */
export function defaultConsentText(researchQuestion: string): string {
  return [
    'Thank you for participating in this research study. Your responses will be used to answer the following research question:',
    researchQuestion.trim(),
    'You may stop at any time. Do you consent to participate?',
  ].join('\n\n')
}

/** Any square-bracket pair: an unfilled authoring placeholder. */
export const CONSENT_TEXT_PLACEHOLDER = /\[[^\]]*\]/

export const CONSENT_TEXT_PLACEHOLDER_ERROR =
  'Consent text cannot contain a bracketed placeholder such as [research topic]. Replace it with the words participants should read.'
```

The template keeps the first and the last two sentences of the shipped default verbatim; only the clause carrying `[research topic]` is replaced. The question goes on its own line rather than inside quotation marks so a research question that already ends in `?` does not produce `?".` — `Consent.tsx:93` renders `consentText` with `whitespace-pre-wrap`, so the blank lines render as paragraph breaks in Source Serif 4 at reading measure. For the e2e fixture's question (`How do people resume research?`) the saved text reads:

> Thank you for participating in this research study. Your responses will be used to answer the following research question:
>
> How do people resume research?
>
> You may stop at any time. Do you consent to participate?

### H11.2 `src/components/StudySetup.tsx` — four changes, and only these four

1. **`:174–177`** — the bracketed default dies. `useState(studyConfig?.consentText || 'Thank you … [research topic] …')` becomes `useState(studyConfig?.consentText ?? '')`. `:325` (`if (config.consentText) setConsentText(config.consentText)`) and `:441` (`setConsentText(studyConfig.consentText)`) are unchanged.
2. **`:527`, inside `buildConfig`** — `consentText,` becomes `consentText: consentText.trim() || defaultConsentText(researchQuestion),`. `buildConfig` has exactly one caller, `handleSaveStudy:732`; `handlePreview` and `handleGenerateLink` both re-fetch the saved study from the server (`:583`, `:617`) and never build a config, so this is the only path a consent string reaches storage on.
3. **`:732`, inside `handleSaveStudy`'s `try`** — immediately after `const config = buildConfig();`, add the client-side guard:

   ```ts
   if (CONSENT_TEXT_PLACEHOLDER.test(config.consentText)) {
     setSaveError(CONSENT_TEXT_PLACEHOLDER_ERROR);
     return;
   }
   ```

   Placed inside the existing `try` so the `finally` at `:806–809` still clears `isSaving`. This is convenience, not authority — the server guard in H11.3 is the boundary.
4. **`:1386`** — the `Field` gains a hint so the templating is discoverable: `<Field label="Consent Text" htmlFor="study-consent-text" hint="Leave blank to generate this from your research question when you save. Square brackets are not allowed — participants read this text exactly as written.">`. The `<textarea>` inside, its `value`, `onChange`, `rows`, and classes are unchanged.

Nothing else in the 1,491-line file changes. In particular the D6 sites at `:906,1046,1091,1129`, the bordered card at `:926` (D7), and the six `border-l-2` notice blocks are **Slice M's**, and `StudySetup.document.test.tsx:85` (`svg` count 0) must still pass — which it will, because a `Field` hint renders a `<p>`.

### H11.3 `src/lib/studyConfigValidation.ts` — the server guard, and where it must **not** go

AGENTS.md: browser-supplied study configuration is untrusted. The guard belongs on the server.

**It must go in `validateStudyConfigForCreate` (`:208–214`) and `validateStudyConfigUpdate` (`:217–238`), never in `validateStudyConfig` itself.** `validateStudyConfig` is also a *read-path* gate: `canonicalStudy.ts:42` runs it on the stored study before every participant interview turn, `researcherContext.ts:632,730` run it on stored studies, and `generate-link/route.ts:84` runs it before minting a link. Putting an authoring rule there would fail closed on every study already saved with the bracketed default — participants mid-study would lose access to a study that was valid when they consented to it. The bracket ban is a policy about what may be *written*, not an invariant of canonical shape.

In each of the two write-path wrappers, after the existing `validateStudyConfig(...)` call returns `ok: true`, reject a bracketed consent string:

```ts
if (CONSENT_TEXT_PLACEHOLDER.test(result.config.consentText)) {
  return { ok: false, error: CONSENT_TEXT_PLACEHOLDER_ERROR };
}
```

`POST /api/studies` (`studies/route.ts:172`) and `PUT /api/studies/[id]` (`[id]/route.ts:154`) are the only callers, and both already map an `ok: false` result to a 400 with `error` — no route file changes.

**Known consequence, name it in the handback:** a study saved before this slice with the bracketed default cannot be edited again until the researcher replaces the placeholder. Its participants are unaffected (the read path is untouched), and the link-status toggle is unaffected (`[id]/route.ts:94,133` short-circuits `isLinkOnlyUpdate` before validation). The same applies to a follow-up study generated from such a parent: `generate-followup/route.ts:168` copies the parent's `consentText` into the prefill, and the first save of that follow-up will be rejected with the same message.

## H12. Tests

### Must keep passing, unchanged

- **`tests/unit/Consent.serverConsent.test.tsx`** — `:32` `getByText(/Your responses are sent to Google Gemini\./)`; `:33` the data-controller sentence; `:34` `not.toHaveTextContent(/API key|GEMINI_API_KEY|AIza/i)`; `:45–48` the single `role="alert"` (`Disclosure`) plus the disabled `I consent — begin the interview` button; `:63–64`, `:76–77` the OpenRouter and Gateway disclosure strings; `:91` and `:119` the consent button resolved by name; `:121` `findByRole('alert')` on the error block with `toHaveTextContent('Consent storage is temporarily unavailable')`. H4 changes only classes and one pluralization; every one of these holds.
- **`tests/unit/InterviewChat.greeting.test.tsx`** — `:78–79` the textarea's accessible name `Your response` and the `Send` button; `:107` and `:115` `Composing a follow-up…`; `:201–202` `/responses have not been saved yet/i` present and `/responses have been saved/i` absent; `:204–207` the `continue to save interview` click driving `currentStep` and `router.push('/synthesis')`; `:224–226` `Preview conversation complete`, `/will not be added to study data/i`, and `continue preview`.
- **`tests/unit/StudyDetail.register.test.tsx`** — `:66,107,111` the three `getByRole('tab', …)` resolutions; `:69–71` the column headers; `:74–75` `View interview 1`/`View interview 2`; `:105,109,113` `svg` count 0 on all three tabs (the H8 Copy icon renders only after a link is generated, which this test never does); `:125–127` the `Participant access` switch reading `ENABLED`.
- **`tests/unit/StudyList.register.test.tsx`** — `:65–70` row buttons by study name and the `router.push` target; `:87–97` ArrowDown/ArrowUp roving focus without wrapping. The `Actions` trigger is not `[data-row-primary]`, so H8's chevron cannot enter the roving set.
- **`tests/unit/StudyOperationRecovery.ui.test.tsx`** — `:124–127` the create-202 repair-pending path through `StudySetup`; `:151` `getByRole('button', { name: 'Open actions for Pending Delete Study' })`. The first is the direct guard that H11.2's guard and template did not disturb `handleSaveStudy`'s outcome ladder; the second is the direct guard that H8's chevron did not change an accessible name.
- **`tests/unit/StudySetup.idempotency.test.tsx`** — the whole file, and specifically `:176–186` (one POST, one UUID v4 `Idempotency-Key`, reused after 202, `config.id` absent from the body), `:205`, `:214`, `:245`, `:265–267` (PUT with no key on edit), `:302–305` (a distinct key per create intent). No assertion reads `consentText` from a request body, so H11.2 is invisible to it — but if any of these breaks, the fix is in `StudySetup`, not the test.
- **`tests/unit/StudySetup.document.test.tsx`** — `:74` the eight-section index; `:85` `svg` count 0; `:91–104` no reading measure on register rows. This is the assertion that forbids adopting `Icon` in `StudySetup` (H1, H11.2).
- **`tests/unit/studyConfigValidation.test.ts`** — `:19` a complete fixture config validates; `:148–167` partial-edit merge and unknown-field rejection. The fixture's `consentText` is `Fixture consent text.` (`tests/fixtures/models.ts:25`), which carries no brackets, so H11.3 does not disturb them.
- **`tests/unit/Login.paper.test.tsx`** `:33–39`, `:42–55`, `:57–70`, `:72–89`, `:91–105`, `:107–122` and **`tests/unit/Login.readiness.test.tsx`** in full. H6 deletes a wrapper div and adds a `Rule`; nothing here walks the DOM through the card.
- **`tests/unit/Dashboard.register.test.tsx`** `:73–76`, `:93`, `:95–98`, `:113–114`, `:117–143`; **`tests/unit/Synthesis.register.test.tsx`** in full, especially `:50` (`svg` count 0), which is why `Notice` renders no icon; **`tests/unit/Export.mode.test.tsx`** `:32–39` and `:46–51`, all of which resolve controls by accessible name and are unaffected by an `aria-hidden` icon.
- **`tests/e2e/research-workflow.spec.ts`** — `:12–17` the study-create flow through `Save Study` (the D4 template runs here, unasserted, and must not change the outcome); `:22` `I consent — begin the interview`; `:26` `/conversation complete/`; `:40` and `:79` the `tab`-role queries (the new rail entry is a `link`, so `getByRole('tab', { name: 'Interviews', exact: true })` stays unique); `:80–81` `View interview \d`; `:113–116` the 375px no-horizontal-overflow assertion.

### Rewritten by this slice, and why

- **`tests/unit/ResearcherShell.test.tsx:44–52`** — `treats non-settings pathnames as Studies-active`. Its premise is exactly what D9 fixes. Rewrite as `marks Interviews active on dashboard paths`: with `navigation.pathname = '/dashboard/interview/abc123'`, assert in every `navigation` landmark that the `Interviews` link has `aria-current="page"` and that `Studies` and `Settings` do not. Add a sibling case for `/setup` asserting `Studies` is still the active destination — that is the behaviour the old catch-all was actually protecting and it must not be lost.
- **`tests/unit/ResearcherShell.test.tsx:54–62`** — the breadcrumb trail for an interview detail path. `Studies` is no longer the leading crumb (H10). Rewrite to assert `Interviews` and `abc123` are present and that the breadcrumb contains **no** `Studies` crumb, and that the `Interviews` crumb is a link to `/dashboard`.
- **`tests/unit/ResearcherShell.test.tsx:23–32`** — the title says "both destinations"; it now covers three. The assertions use `getAllByRole` per name with no count, so they pass as written, but rename the case and add `Interviews` → `/dashboard` to the href checks so the rail's contract is actually pinned.
- **`tests/unit/Export.register.test.tsx:28–36`** — `carries no legacy classes or icons in preview mode`. H8 puts one `Icon` in the Copy row. Rewrite the `svg` clause to: every `svg` in preview mode has a `button` ancestor and carries `aria-hidden="true"`, and the count equals 1. Keep the legacy-class clause (`/stone-|rounded-xl|rounded-full/`) exactly as it is. `:68–73` (participant mode, `svg` count 0) stays unchanged — the participant branch has no copy control.

### New, smallest realistic regressions

- **`tests/unit/ui.notice.test.tsx`** — each tone renders the matching border class and always `border-l-2 bg-paper-2 px-4 py-3`; an `eyebrow` renders a `Label`-classed element and omitting it renders none; `children` are direct children with no injected wrapper element; `role="status"` and a caller `className` both reach the root div.
- **`tests/unit/ui.icon.test.tsx`** — all six names render exactly one `<svg>` with `aria-hidden="true"`, `focusable="false"`, `stroke="currentColor"`, and no `role`, `title`, or `aria-label`; `size` drives `width`/`height` with 16 the default; the component sets no colour class (assert `className` matches neither `/text-/` nor `/fill-/` beyond a caller-supplied one).
- **`tests/unit/interviewId.test.ts`** — `shortInterviewId('session-9f1c2b7a-…')` returns the first eight characters after the prefix and never the string `session-`; `shortInterviewId('interview-demo-sarah')` returns `demo-sarah`; a long id with no known prefix is truncated to eight characters; a short id is returned whole.
- **`tests/unit/consentText.test.ts`** — `defaultConsentText` contains no `[` or `]`, embeds the trimmed research question on its own paragraph, and keeps the two closing sentences verbatim; `CONSENT_TEXT_PLACEHOLDER` matches `[research topic]` and does not match the generated text.
- **`tests/unit/Consent.pluralization.test.tsx`** — with a one-question study (`makeStudyConfig()` gives exactly one), `getByText(/1 core question about your experiences/)` resolves and the document has no text matching `/1 core questions/`; with a two-question study, `/2 core questions about your experiences/` resolves.
- **Extend `tests/unit/studyConfigValidation.test.ts`** — `validateStudyConfigForCreate` and `validateStudyConfigUpdate` both reject a config whose `consentText` contains `[research topic]`, with `CONSENT_TEXT_PLACEHOLDER_ERROR`; **and `validateStudyConfig` accepts the same config**, because the read path must keep serving studies stored before this slice. That last assertion is the one that documents H11.3's placement — do not omit it.
- **Extend `tests/unit/StudyDetail.register.test.tsx`** — after generating a participant link (stub `fetch` for `/api/generate-link`), the Copy control's accessible name is `Copy`, it contains exactly one `aria-hidden` `svg`, and clicking it (with `navigator.clipboard.writeText` stubbed) flips the visible label to `Copied!`.
- **`tests/unit/Dashboard.idColumn.test.tsx`** — an interview seeded with `id: 'session-9f1c2b7a-0000-4000-8000-000000000000'` renders an ID cell whose text is `9f1c2b7a` and the table contains no text `session-`.

Do not snapshot any component in this slice.

## H13. Verification

Focused gates first, per the AGENTS.md change map:

```bash
# Researcher UI row (Dashboard, StudyList, StudyDetail, Export, shell, primitives)
npx vitest run tests/unit/Dashboard.register.test.tsx tests/unit/StudyList.register.test.tsx \
  tests/unit/StudyDetail.register.test.tsx tests/unit/StudyDetail.participantLinks.test.tsx \
  tests/unit/Export.register.test.tsx tests/unit/Export.mode.test.tsx \
  tests/unit/ResearcherShell.test.tsx tests/unit/StudyOperationRecovery.ui.test.tsx \
  tests/unit/ui.notice.test.tsx tests/unit/ui.icon.test.tsx tests/unit/interviewId.test.ts

# Participant / preview row (Consent changes, so the consent and session suites run)
npx vitest run tests/unit/Consent.serverConsent.test.tsx tests/unit/Consent.pluralization.test.tsx \
  tests/unit/participantHeaders.test.ts tests/unit/participantSessionHeaders.test.ts \
  tests/unit/api.consent.test.ts tests/unit/store.participantIsolation.test.ts \
  tests/unit/InterviewChat.greeting.test.tsx tests/unit/Synthesis.register.test.tsx

# StudySetup + study-mutation suites (D4 touches saving)
npx vitest run tests/unit/StudySetup.auth.test.tsx tests/unit/StudySetup.document.test.tsx \
  tests/unit/StudySetup.idempotency.test.tsx tests/unit/studyConfigValidation.test.ts \
  tests/unit/consentText.test.ts tests/unit/api.study.configValidation.test.ts \
  tests/unit/api.study.createIdempotency.test.ts tests/unit/canonicalStudy.validation.test.ts
```

Then the proportional full gate — D4 crosses a trust boundary and D9 changes navigation on every researcher route, so run both:

```bash
npm run check
npm run test:e2e
```

Then the greps, each of which must return no output except where noted:

```bash
grep -rn "lucide-react\|framer-motion" src/            # no dependency was re-added
grep -rn "\[research topic\]" src/                     # exactly one hit: the example inside CONSENT_TEXT_PLACEHOLDER_ERROR (src/lib/consentText.ts)
grep -rn "id.slice(0, 8)" src/components/              # only breadcrumb.tsx:59, a study id, may remain
grep -rn "border-l-2 border-\(error\|success\|ink-500\) bg-paper-2" src/components/Synthesis.tsx \
  src/components/Dashboard.tsx src/components/StudyList.tsx src/components/StudyDetail.tsx
```

Then by hand, at **375px** and 1280px:

- **`/consent`** — with a one-question study the list item reads `1 core question about your experiences`; the data notice is a square `bg-paper-2` well; the error state (force it by stubbing a 503) is a square filled terracotta block, not a rounded one.
- **`/interview`** — the completion block's heading and its "not saved yet" sentence read at 18/26 and 15/24; the error block is square. Confirm no layout shift at the top of the transcript, since H5 changes no structure.
- **`/login`** — no card outline; the header, the form, and `Back home` are separated by hairlines on paper. Walk all three modes (hosted-ready, hosted-not-ready, standalone) and confirm the fail-closed branch still shows no usable sign-in control.
- **The rail** — `Studies · Interviews · Settings` in the desktop rail and the mobile top bar. Visit `/studies`, `/studies/<id>`, `/setup`, `/dashboard`, `/dashboard/interview/<id>`, `/settings` and confirm exactly one destination is marked active on each, and that the breadcrumb on the two dashboard routes starts at `Interviews`.
- **`/dashboard` and `/studies/<id>` → Interviews tab** — the ID column shows eight characters of entropy, not `session-`. Check the seeded sample workspace too (Open question 4).
- **`/studies`** — the dismiss `×` on the sample-workspace message is a close mark with a 44px target; the `Actions` trigger shows the chevron and rotates it when the menu is open; the menu still closes on Escape and returns focus to the trigger.
- **`/studies/<id>` → Study settings → Generate New Link** — the Copy button shows the copy mark, flips to the check mark and `Copied!`, and reverts after two seconds.
- **`/export`** (preview) — the Copy row shows the copy mark inline with its title and flips to the check mark on copy.
- **`/setup`** — the consent field is empty on a new study with the hint visible; saving with the field blank stores the templated text (verify by re-opening the study for edit); typing `[topic]` and saving surfaces the placeholder error and performs no navigation.

Leave the dev server runnable for the orchestrator's screenshot pass.

## Hard constraints

- Files that may change: `src/components/ui/Notice.tsx` (new), `src/components/ui/Icon.tsx` (new), `src/components/ui/index.ts` (two exports), `src/lib/interviewId.ts` (new), `src/lib/consentText.ts` (new), `src/lib/studyConfigValidation.ts` (H11.3 only), `src/components/Consent.tsx`, `src/components/InterviewChat.tsx`, `src/components/Login.tsx`, `src/components/Dashboard.tsx`, `src/components/StudyList.tsx`, `src/components/StudyDetail.tsx`, `src/components/Synthesis.tsx`, `src/components/Export.tsx`, `src/components/StudySetup.tsx` (the four changes in H11.2 only), `src/components/shell/ResearcherShell.tsx`, `src/components/shell/breadcrumb.tsx`, and the tests in H12. Nothing else.
- **No API route, store, service, `types.ts`, `proxy.ts`, `auth.ts`, `kv.ts`, `researcherContext.ts`, or `canonicalStudy.ts` change.** H11.3 changes two exported functions in one lib file and no route file.
- **`validateStudyConfig` itself is not modified.** Adding the bracket rule to the shared validator would fail closed on stored studies mid-interview. This is the single most important constraint in the slice.
- **`generateJSON`, `generateTranscript`, and their emitted strings in `Export.tsx` do not change by one character.** They are file formats a researcher's tooling may already parse.
- Do not edit `src/components/Settings.tsx`, `src/components/Onboarding.tsx`, `src/components/InterviewDetail.tsx`, `src/components/DemoSimulation.tsx`, `src/components/Landing.tsx`, `src/components/OAuthLogin.tsx`, or `src/components/PreviewBanner.tsx`.
- Do not edit any existing primitive in `src/components/ui/`. `Button`, `Label`, `Rule`, `Field`, `Coordinate`, `Verbatim`, `Turn`, `Citation`, `Disclosure`, and `Page` are frozen contracts. If `Notice` or a call site cannot express something through them, style around it in the component and say so in the handback.
- Do not edit `eslint.config.mjs`, `tailwind.config.ts`, `src/app/globals.css`, or `src/app/layout.tsx`. This slice needs no new token, no new keyframe, and no config change; if lint blocks a class, the class is wrong.
- No new dependency and no dependency removal. No `data-theme` wiring, no theme toggle.
- Do not commit; leave the working tree for review. npm only (`package-lock.json` authoritative), Node ≥ 24.19.

## Deferred, do not attempt

- **A1, A2, A3's `acceptedAt` echo — Slice K.** The composer as the last block in document flow, the `viewport` meta decision, the receipt fact block, and killing the centered completion panel. Nothing here may pre-empt K's layout decisions. H changes three class strings in `InterviewChat` and touches no structure.
- **B1 honest footers — Slice I.** `StudyDetail.tsx:546–554` still prints `receipt eyJhbGciOiJI` (D2) and `InterviewDetail.tsx:411` still prints `receipt unsigned` (D1). Both are inside the shared reading that C1 extracts; fixing them here would fork the component Slice I is about to unify. **Leave both footers exactly as they are** even though this slice edits `StudyDetail.tsx`.
- **C1 `SynthesisReading`, C2 `Tabs`, C5 the shared provider module — Slice I.** `StudyDetail.tsx:412–429` keeps its `aria-controls`-less tablist; do not add `tabpanel`, roving tabindex, or `aria-controls` here. Four tests and one e2e step resolve those tabs by role today and Slice I owns the rewrite.
- **B2 aggregate citations, B3 `divergentViews`/`researchImplications` — Slices L and I.**
- **C6 / F1 StudySetup decomposition, and D6/D7's StudySetup sites (`:906,1046,1091,1129`, `:926`) — Slice M.**
- **Notice adoption in `Settings.tsx`, `Onboarding.tsx`, `StudySetup.tsx`** — Slices I and M, by file ownership.
- **Persisting aggregate synthesis (D8's real fix)** — the next Storage train, with its own spec and the Storage gates. The honest footer wording is Slice I's B1.
- **The `WithMargin` unfold (B4)** — struck by decision of record 4. `Page.tsx:22–31` stays exported and unused.
- **Night theme, participant transcript download, typeset export.**

## Rulings (Fable, 2026-09-05) — the questions below are settled; text above already reflects them

1. **Q1 — convert.** `Login.tsx:126` becomes a `Notice` (H6/H9 updated). The brief's adoption list names files later slices own, not an exhaustive whitelist.
2. **Q2 — keep the blunt rule.** Decision of record 1 says no bracketed token can be saved; the message names the fix.
3. **Q3 — Slice I** renames `Interview Dashboard` and `Back to Dashboard` to match the rail, in the same diff as C1.
4. **Q4 — adopted.** `shortInterviewId` also strips `interview-` and shows a ≤12-char remainder whole (H7 updated).
5. **Q5 — moot.** `lucide-react` is already absent from `package.json` (maintenance train, 2026-09-05); the spec's earlier claim was stale and is corrected in H1.

## Open questions as originally drafted (for the record)

1. **`Login.tsx:126` — adopt `Notice` or leave it?** The brief's adoption list names seven files and `Login` is not among them, so this spec leaves the block as a hand-rolled `border-l-2 border-error bg-paper-2 px-4 py-3`. But no later slice owns `Login`, so it would be the last hand-rolled instance of the pattern in the repo, sitting in a file this slice is already editing. Converting it is a three-line diff with no test exposure (`Login.paper.test.tsx:91–105` asserts the *absence* of `role="alert"`, which `Notice` preserves by not adding one). **Recommendation: convert it**, and treat the brief's list as naming the files that must not be touched rather than an exhaustive whitelist. Ships as specced (not converted) unless the orchestrator says otherwise.
2. **The bracket rule is blunt: `/\[[^\]]*\]/` rejects every square-bracket pair.** That is the literal decision of record ("no bracketed token can be saved") and it is easy to explain to a researcher. The cost is real: a consent text saying "you may skip any question [including the demographic ones]" or citing "[1]" is rejected. A narrower rule keyed to placeholder shape would let some real placeholders through. **Recommendation: keep the blunt rule**; the error message names the fix and consent text is short.
3. **`Dashboard`'s `<h1>Interview Dashboard</h1>` and `InterviewDetail`'s `Back to Dashboard` button now disagree with the rail's "Interviews".** This spec changes neither: `InterviewDetail` is Slice I's file, and renaming one without the other trades one inconsistency for another. Recommend Slice I renames both to "Interviews" in the same diff as C1.
4. **Sample-workspace ids still truncate badly.** `shortInterviewId` strips `session-` per the brief. The seeded sample workspace uses `interview-demo-sarah` / `-marcus` / `-priya` (`src/lib/demoData.ts:183,285,388`), which render as `intervie` — the same class of defect on a surface a first-time researcher is likely to see first. Extending the helper to strip a leading `interview-` as well is one more line and would render `demo-sar`. Not taken here because the brief names only `session-`; one word from the orchestrator adds it.
5. **`lucide-react` is still in `package.json` with zero importers.** Slice G left it deliberately (§6 keeps Lucide for functional icons, and G ended with none shipped). C4 now answers the icon question with inline SVGs instead, so the package has no remaining rationale. Recommend removing it in a separate one-line PR after H lands — it rewrites `package-lock.json` and is a supply-chain decision, not a design one.
