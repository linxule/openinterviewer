# Slice C — Researcher shell + register tables (Initiative 1, depends on Slice A)

Builds the persistent researcher app shell and re-registers `src/components/StudyList.tsx` and `src/components/Dashboard.tsx` as ruled register tables. Context: `docs/design/DIRECTION-final.md` §7 "Researcher workspace", §8 Initiative 1, amendment A2. Prerequisite: Slice A primitives exist in `src/components/ui/`. Slice B (participant flagship) is in flight in another session and touches `InterviewChat.tsx`, `Consent.tsx`, `globals.css`, `eslint.config.mjs`; assume the ESLint allowlist has already lost those two files and edit it additively.

**Prime directive: this is a re-registering of the surface, not a logic rewrite.** Every data fetch, effect, handler, storage-warning branch, reconciliation path, Load Sample / Clear Sample behavior, delete-pending branch, export flow, logout, and page-level access gate must survive with identical behavior. `loadStudies`, `loadInterviews`, `runReconciliation`, `handleDelete`, `handleLoadSample`, `handleClearSample`, `handleExportAll`, `handleViewInterview`, `handleLogout`, the two `eslint-disable-next-line react-hooks/exhaustive-deps` mount gates, `isPendingStudyStub` branching, and every `disabled=` condition are moved and restyled, never rewritten. If a change is not named below, do not make it.

## C1. Where the shell lives — route group, decided

The app has no shared shell today; every researcher screen builds its own `router.push()` nav cluster. The six researcher routes are `/studies`, `/studies/[id]`, `/setup`, `/dashboard`, `/dashboard/interview/[id]`, `/settings` — four top-level directories under `src/app/`. Participant, demo, landing, login, and onboarding routes must NOT receive the shell.

**Mechanism: a route group.** Move the four directories under a new `src/app/(researcher)/` group and give the group one `layout.tsx`. Route groups do not appear in URLs, so every path, `src/proxy.ts`'s `protectedRoutes` list, `src/lib/hostedOAuth.ts`'s `allowedRoots`, and all existing `router.push('/studies')` calls keep working untouched. Rejected alternative: wrapping each page's component in `<ResearcherShell>` by hand — six integration points a future page can silently forget, and it puts client chrome inside every page's tree instead of above it.

```
git mv src/app/studies   "src/app/(researcher)/studies"
git mv src/app/dashboard "src/app/(researcher)/dashboard"
git mv src/app/setup     "src/app/(researcher)/setup"
git mv src/app/settings  "src/app/(researcher)/settings"
```

The six `page.tsx` files move **byte-for-byte**. In particular:

- **Do not move `await enforceResearcherPageSetup()` into the layout.** It stays in each page. Layouts are not re-evaluated on every client navigation within the group; the gate must remain page-level or hosted accounts without BYOS setup can reach a page that never re-checks. This is a hard requirement, not a preference.
- `src/app/(researcher)/setup/page.tsx` keeps its `Suspense` boundary and its `SetupLoading` fallback verbatim (still legacy `stone-*` markup — Slice D owns `StudySetup`).

`src/app/(researcher)/layout.tsx` — a server component, no gating, no `'use client'`:

```tsx
import ResearcherShell from '@/components/shell/ResearcherShell';

export default function ResearcherLayout({ children }: { children: React.ReactNode }) {
  return <ResearcherShell>{children}</ResearcherShell>;
}
```

## C2. `src/components/shell/ResearcherShell.tsx` (new, `'use client'`)

New directory `src/components/shell/` — deliberately not `src/components/ui/`, so the ESLint ratchet applies to it in full (no `stone-`, no raw `font-serif`, no scoped evidence/disclosure vars).

**Theme:** light Paper only. Every color through the token scale (`bg-paper-*`, `text-ink-*`, `text-action`, `border-ink-*`). No `dark:` variants, no `data-theme` reads or writes, no theme toggle — the researcher Night toggle is a later slice, and token-only styling is what keeps it cheap.

Structure:

1. **Skip link**, first focusable node: `<a href="#researcher-main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded focus:bg-paper-1 focus:px-3 focus:py-2">Skip to content</a>`.
2. **Rail, `lg:` (≥1024px) only** — `<nav aria-label="Researcher">`: `hidden lg:flex lg:fixed lg:inset-y-0 lg:left-0 lg:w-60 lg:flex-col bg-paper-1 border-r border-ink-300 px-5 py-6`.
   - Wordmark: `next/link` to `/studies`, text `OpenInterviewer`, `font-sans text-[15px] font-semibold text-ink-900`. No icon, no logo mark.
   - Destination list, `mt-8 flex flex-col gap-0.5`. Two entries, in order: `Studies` → `/studies`, `Settings` → `/settings`. Each is a `next/link`, `font-sans text-[14px] py-1.5 pl-3 border-l-2`; inactive `border-transparent text-ink-700 hover:text-ink-900`; active `border-action text-action font-semibold` plus `aria-current="page"`.
   - Active test: `pathname === href || pathname.startsWith(href + '/')`. `/dashboard` and `/dashboard/interview/*` and `/setup` are children of the Studies destination for highlighting purposes — treat `Studies` as active for any pathname not under `/settings`.
   - Account block, pushed down with `mt-auto`, above the footer: `Label` reading `Account`, then a `Button variant="quiet"` with the word `Log out`, full width, `text-[13px]`.
   - Footer: `<Coordinate>Your keys · your database</Coordinate>` (copy exactly as in DIRECTION §7), `mt-4 block`.
3. **Top bar, below `lg`** — `<nav aria-label="Researcher">`: `lg:hidden sticky top-0 z-40 flex h-14 items-center gap-4 border-b border-ink-300 bg-paper-0 px-4`. Wordmark left; the same two destinations as inline text links (`text-[13px]`, active gets `text-action font-semibold` + `aria-current="page"`); `Log out` as a quiet text button at the right (`ml-auto text-[13px] text-ink-500 hover:text-ink-900`). Two destinations plus account fit on a 375px bar — no hamburger, no drawer, no `Sheet`.
4. **Main region**: `<main id="researcher-main" className="min-h-dvh bg-paper-0 lg:pl-60">`, containing `<Page className="py-6 lg:py-10">` with the breadcrumb, then `{children}`.
5. **Mobile footer**: the same `Coordinate` line renders once more inside `<main>` below the children, `lg:hidden mt-12 block`, so the promise is visible on phones where the rail is absent.

`handleLogout` moves here **verbatim** from the two components it is being deleted from:

```ts
const handleLogout = async () => {
  try {
    await fetch('/api/auth', { method: 'DELETE' });
    router.push('/login');
  } catch (error) {
    console.error('Logout error:', error);
  }
};
```

The shell renders regardless of hosted/standalone mode and makes **no network call of its own** — no `/api/config/mode` fetch. `Settings` is unconditional because `/settings` is already reachable in both modes (Dashboard links it unconditionally today). This is a named behavior change: StudyList currently hides its Settings link outside hosted mode; the shell's Settings destination is always present. `StudyList`'s `hostedMode` state survives — it still gates reconciliation-on-mount and the Reconcile button.

The root `<body>` keeps `bg-stone-900` this slice (`src/app/layout.tsx` is on the allowlist and belongs to a later slice). The shell's own `min-h-dvh bg-paper-0` covers the viewport; the only visible consequence is dark overscroll bounce on iOS. Do not touch `layout.tsx` to fix it.

## C3. `src/components/shell/breadcrumb.tsx` (new, `'use client'`)

A current-study breadcrumb needs a name the layout cannot know. Ship the smallest mechanism that works today and that Slices D/E extend:

- `BreadcrumbProvider` — context holding `trailing: string | null` plus a setter. Rendered by `ResearcherShell` around everything.
- `useSetTrailingCrumb(label: string | null)` — hook a page component calls; sets on mount/change in a `useEffect` and clears on unmount.
- `<Breadcrumb />` — `<nav aria-label="Breadcrumb">` + `<ol className="flex flex-wrap items-center gap-2 text-[13px] text-ink-500">`. Separator: a `<span aria-hidden="true" className="text-ink-300">/</span>` between items. The last item gets `aria-current="page"` and `text-ink-900`.

Trail derived from `usePathname()`:

| pathname | trail |
|---|---|
| `/studies` | `Studies` |
| `/studies/<id>` | `Studies` / `<trailing ?? id.slice(0,8) in Coordinate>` |
| `/setup` | `Studies` / `New study` |
| `/dashboard` | `Studies` / `Interviews` (+ ` / <trailing>` when set) |
| `/dashboard/interview/<id>` | `Studies` / `Interviews` / `<trailing ?? id.slice(0,8) in Coordinate>` |
| `/settings` | `Settings` |

Non-final crumbs are `next/link`s (`hover:text-ink-900 underline-offset-2 hover:underline`). Slice C wires exactly one consumer, in `Dashboard`: when `selectedStudyId` is set and resolves to a non-pending study, call `useSetTrailingCrumb(study.config.name)`; otherwise `null`. That proves the mechanism and is honest — the filter *is* the dashboard's current study.

## C4. `StudyList.tsx` — register of studies

**Deleted outright:** the entire `framer-motion` import and every `motion.div` (all six); every `lucide-react` import — the file must end with **no `lucide-react` import at all**; the `w-10 h-10 rounded-xl bg-stone-700` icon tile and its `BookOpen`; the `min-h-screen bg-stone-900 p-4 sm:p-8` + `max-w-5xl mx-auto` page frame (the shell owns the frame now); the `All Interviews` button (`router.push('/dashboard')`); the `Account & connections` button and its `hostedMode` gate; the `Logout` button and `handleLogout` (both move to the shell); the two-column card grid; every `rounded-xl` / `rounded-2xl`; the `border-purple-700/50 text-purple-400 hover:bg-purple-900/30` classes on both Load Sample buttons — **this is where the stray purple dies**; the `Loader2` spinners (replaced by text); the status pills' `rounded-full` treatment.

**Header**, above the table: `h1` `My Studies` in `font-sans text-[24px] leading-[32px] font-semibold text-ink-900`; beneath it the existing count line (`{studies.length} {studies.length === 1 ? 'study' : 'studies'}`) at `text-[13px] text-ink-500`. Right-aligned action row (`flex flex-wrap gap-2`), page actions only:

- `Create Study` — `Button variant="primary"`, `onClick={() => router.push('/setup')}`, copy unchanged.
- `Clear Sample` / `Load Sample` — `Button variant="quiet"`, copy unchanged (**exact strings, both branches**), `disabled` conditions unchanged (`loadingSample` / `loadingSample || !!kvWarning`). While `loadingSample`, the button stays labeled `Load Sample`/`Clear Sample` and relies on `disabled` — do not swap the label, an existing test matches these accessible names.

Then a `<Rule />`.

**Notice blocks** (replacing the amber/green/red cards), all in the same register: `border-l-2 px-4 py-3 bg-paper-2` with a `Label` eyebrow and 13px `text-ink-700` body. No icons.

- `kvWarning` → `border-error`. Eyebrow keeps the existing conditional heading verbatim (`Workspace unavailable` vs `Storage Not Configured`), body is `kvWarning`, and the conditional README sentence stays verbatim.
- `operationNotice` → `border-error`, `role="status"`, eyebrow `Pending reconciliation`, body verbatim, and the `hostedMode`-gated `Reconcile` button as `Button variant="quiet"` with `disabled={isReconciling}` — same handler, same gate.
- `sampleMessage` → `border-success` on `'success'`, `border-error` on `'error'`; body verbatim; the dismiss control keeps its `setSampleMessage(null)` handler, renders the character `×`, and gains `aria-label="Dismiss message"`.

**Empty state** (`studies.length === 0`): no icon circle, no card. Left-aligned inside a `max-w-measure` block — prose may use the measure, the table below never may. Heading `font-sans text-[18px] font-semibold text-ink-900`, body 15px `text-ink-700`, both branches' copy verbatim. Both `Create Study` and `Load Sample` buttons stay, with their existing `!kvWarning` gates and `disabled={loadingSample}`; the trailing sample-explanation sentence stays verbatim. **The empty state's `Load Sample` plus the header's is exactly two — an existing test asserts that count.**

**The register table** (`studies.length > 0`): wrapper `<div className="overflow-x-auto">` — never `max-w-measure`, never any measure-bearing ancestor. `<table className="w-full border-collapse text-left">`.

`<thead>`, `<tr className="border-b border-ink-300">`, each `<th scope="col" className="px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500">`:

| # | header | cell content | responsive |
|---|---|---|---|
| 1 | `Study` | primary button (below) + description second line | always |
| 2 | `Interviews` | `Coordinate`, `pending ? 0 : study.interviewCount` | always |
| 3 | `Created` | `Coordinate`, `formatDate(study.createdAt)`, `—` when pending | `hidden md:table-cell` |
| 4 | `Questions` | `Coordinate`, `study.config.coreQuestions.length`, `—` when pending | `hidden md:table-cell` |
| 5 | `Status` | `Locked` / `Editable` / `Reconciliation pending` | always |
| 6 | `<span className="sr-only">Actions</span>` | actions menu | always |

`<tbody>` rows: `border-b border-ink-200 hover:bg-paper-1`, cells `px-3 py-3 align-top text-[13px] text-ink-700`.

- **Row primary control** — cell 1 holds a real `<button type="button" data-row-primary>` whose text is `name` (`isPendingStudyStub(study) ? 'Study change pending' : study.config.name`), styled `font-sans text-[14px] font-medium text-ink-900 text-left hover:text-action hover:underline underline-offset-2`, `onClick={() => router.push(`/studies/${study.id}`)}`. This replaces the click-anywhere `<div className="cursor-pointer">`, which was mouse-only. The `<tr>` keeps `onClick` for pointer convenience; give it no `role`, no `tabIndex` — the button is the accessible target.
- Second line in cell 1: `study.config.description` when present and not pending, `line-clamp-1 text-[13px] text-ink-500`; when pending, `Reconciliation pending ({study.phase})` verbatim.
- **Status cell**: plain text, not a pill — `Locked` / `Editable` in 13px, `text-ink-500` when locked and `text-success` when editable; pending renders `Reconciliation pending` in `text-error`.
- **Actions**: the trigger becomes a text button reading `Actions` (`text-[13px] text-ink-500 hover:text-ink-900`), keeping **exactly** `aria-label={`Open actions for ${name}`}` (an existing test matches this string) and gaining `aria-haspopup="menu"` + `aria-expanded={menuOpenId === study.id}`. The popover keeps its `absolute right-0 mt-1 w-48 z-10` geometry with `bg-paper-1 border border-ink-300 shadow-note` and no radius above `rounded`. Its three items keep their labels verbatim — `View Details`, `Edit & Generate Link`, `Delete` — their handlers verbatim (including the `sessionStorage.setItem('prefillStudyConfig', …)` line and the `?prefill=edit&studyId=` push) and their `disabled` expressions verbatim. `Delete` is `text-error`. While `deletingId === study.id` the label stays `Delete` and the button stays disabled. Add: `onKeyDown` on the popover closing it on `Escape` and returning focus to the trigger. Do not add click-outside dismissal — note it as a follow-up.

**Keyboard navigation** (both tables, same implementation): `<tbody onKeyDown={…}>` — on `ArrowDown`/`ArrowUp`, collect `HTMLButtonElement`s matching `[data-row-primary]` inside the tbody, find the index of `document.activeElement`, move focus one step (clamped, no wrap), `preventDefault()`. Nothing else — no roving tabindex, no `role="grid"`, no Home/End.

## C5. `Dashboard.tsx` — register of interviews

**Deleted outright:** all `framer-motion`; **all** `lucide-react` imports; the `FolderOpen` icon tile; the `min-h-screen bg-stone-900 p-4 sm:p-8` + `max-w-5xl` frame; the `My Studies` button (`/studies`), the `Back to Setup` button (`/setup`), the `Account & connections` button (`/settings`), the `Logout` button and `handleLogout` — all four are shell destinations now; the `Lightbulb` bottom-line callout box; the per-row `Eye` button (redundant once the row has a primary button); the `Filter` icon; every `rounded-xl`/`rounded-2xl`/`rounded-full`; the `Loader2` spinners.

**Header**: `h1` `Interview Dashboard`, same type as StudyList's; count line `{interviews.length} interview{interviews.length !== 1 ? 's' : ''} collected` at 13px `text-ink-500`. One page action remains: `Export All` — `Button variant="primary"`, same `interviews.length > 0` render gate, same `disabled={exporting || operationPending}`, same handler; label stays `Export All` in both states. Then a `<Rule />`.

**Study filter**: keep the `<select>` and its exact option-building logic (`All Studies`, and `isPendingStudyStub(study) ? \`Pending ${study.id.slice(0, 8)}\` : \`${study.config.name} (${study.interviewCount} interviews)\``). Render it through the Slice A `Field` primitive with label `Study` and `htmlFor="dashboard-study-filter"`; keep the `Clear filter` text button and its handler, styled `text-[13px] text-ink-500 hover:text-ink-900`. Keep the `studies.length > 0` render gate. Wire `useSetTrailingCrumb` here per C3.

**Notices**: `operationPending` and `warning` become the same `border-l-2 px-4 py-3 bg-paper-2` blocks as C4, both `border-error`. `operationPending` eyebrow `Pending reconciliation`, body `A study operation is already in progress.` verbatim, plus the `Reconcile` `Button variant="quiet"` with `disabled={isReconciling}` and the same handler. `warning` eyebrow `Workspace`, body = `warning` verbatim.

**Empty state**: all three branches (`operationPending`, `warning`, neither) keep their headings and bodies verbatim; no icon circle, no card, `max-w-measure`, same type scale as C4's empty state. The `Create Study Link` button survives as `Button variant="primary"` with its `router.push('/setup')`.

**The register table** — same wrapper, markup, header styling, row styling, and `data-row-primary` keyboard contract as C4.

| # | header | cell content | responsive |
|---|---|---|---|
| 1 | `ID` | `Coordinate`, `interview.id.slice(0, 8)` | always |
| 2 | `Study` | primary button + bottom-line second line | always |
| 3 | `Participant` | the existing extracted-fields join, `—` when absent | `hidden md:table-cell` |
| 4 | `Started` | `Coordinate`, `formatDate(interview.createdAt)` | `hidden sm:table-cell` |
| 5 | `Duration` | `Coordinate`, `formatDuration(createdAt, completedAt)` | `hidden md:table-cell` |
| 6 | `Turns` | `Coordinate`, `interview.transcript.length` | `hidden md:table-cell` |
| 7 | `Model` | `Coordinate`, `interview.aiModel ?? '—'` | `hidden lg:table-cell` |
| 8 | `Status` | `interview.status` verbatim | always |

- Row primary button: text is `interview.studyName`, `onClick={() => handleViewInterview(interview.id, interview.studyId)}` — the handler and its `?studyId=${encodeURIComponent(studyId)}` query survive exactly. `<tr>` keeps its `onClick` for pointer users.
- Cell 2 second line: `interview.synthesis?.bottomLine` when present, `line-clamp-1 text-[13px] text-ink-500`. The insight stays visible; only the boxed `Lightbulb` callout dies.
- Cell 3 keeps the existing pipeline verbatim: `fields.filter(f => f.status === 'extracted' && f.value).slice(0, 3).map(f => f.value).join(' • ')`.
- Status cell: plain text, `text-ink-500` for `completed`, `text-ink-900` for `in_progress`. No pill.
- The `Model` column is new display of `interview.aiModel`, which is already on `StoredInterview` and never rendered — it is a read of existing data, not a new fetch.

## C6. Ratchet (`eslint.config.mjs`)

- Remove `'src/components/Dashboard.tsx'` and `'src/components/StudyList.tsx'` from `legacyDesignAllowlist`. Both files must then pass clean.
- **Update the moved path**: the allowlist entry `'src/components/… src/app/setup/page.tsx'` no longer matches after the route-group move and that file still carries `stone-*` markup. Replace it with `'src/app/**/setup/page.tsx'` — a literal `src/app/(researcher)/setup/page.tsx` risks glob parsing of the parentheses, and the existing file already escapes brackets for `p/\\[token\\]`. Verify with `npm run lint`, not by inspection.
- Make no other allowlist edits. Slice B's session is removing `InterviewChat.tsx` and `Consent.tsx` from the same array; keep your diff to the three lines above so the merge is trivial.
- `src/components/shell/**` gets no exemption entry. It must satisfy the ratchet as written.
- `src/components/Settings.tsx` stays legacy this slice. Its stray blue (`bg-blue-500/5 border-blue-400/20`, `Settings.tsx:479`) is the last non-token accent after this slice and dies in Slice D — do not touch it, do not add a TODO to that file.

## C7. Tests

Update, preserving every behavioral assertion:

- `tests/unit/StudyOperationRecovery.ui.test.tsx` — expected to keep passing unchanged. Its three load-bearing assertions are `getAllByRole('button', { name: 'Load Sample' })).toHaveLength(2)`, `getByRole('button', { name: 'Open actions for Pending Delete Study' })` followed by `{ name: 'Delete' }`, and the reconciliation-ordering + notice-text checks. If any of them breaks, the fix is in the component, not the test.

New, smallest realistic regressions:

- `tests/unit/ResearcherShell.test.tsx` — with `usePathname` mocked: both destinations render as links to `/studies` and `/settings`; the active one carries `aria-current="page"` and the other does not; a `/dashboard/interview/abc123` pathname produces a breadcrumb `nav` whose items read `Studies`, `Interviews`, and the trailing id; the mono line `Your keys · your database` is present; the skip link targets `#researcher-main`; clicking `Log out` calls `fetch('/api/auth', { method: 'DELETE' })` and then `router.push('/login')`.
- `tests/unit/StudyList.register.test.tsx` — with studies loaded: `getByRole('table')` exists; each row exposes a button named after its study; `ArrowDown` on a focused row button moves focus to the next row's button and `ArrowUp` moves back, without wrapping past the ends; **no ancestor of the table carries `max-w-measure`** (walk `parentElement` up to `document.body` and assert the class is absent on every node); the row button's click calls `router.push('/studies/<id>')`.
- `tests/unit/Dashboard.register.test.tsx` — column headers `ID`, `Study`, `Started`, `Status` are present; the row primary button calls `router.push` with the interview path including the encoded `studyId`; the same measure-free-ancestor assertion; `Export All` is disabled when a study operation is pending; the same arrow-key focus assertions.

Do not snapshot the tables.

## C8. Verification (must all pass, in order)

```bash
npm run lint          # zero warnings; ratchet now covers Dashboard, StudyList, shell/
npm run typecheck
npm run test
DEPLOYMENT_MODE=standalone npm run build
npm run test:e2e      # demo untouched — must still pass
```

Then, before handing back, confirm by hand that `/studies`, `/dashboard`, `/settings`, and `/setup` still render behind the shell and that `/demo`, `/`, `/consent`, `/interview`, `/login`, and `/onboarding` do **not** show a rail. The route-group move is the one change in this slice that can silently reshape routing; `npm run build` printing the same six researcher routes as before is the check that it did not.

A 375 / 1024 / 1440 visual pass happens post-slice — leave the dev server runnable.

## Hard constraints

- Files that may change: the four `git mv`d route directories (contents byte-for-byte), new `src/app/(researcher)/layout.tsx`, new `src/components/shell/*`, `src/components/StudyList.tsx`, `src/components/Dashboard.tsx`, `eslint.config.mjs` (three lines, per C6), and the tests in C7.
- Do not touch `src/app/layout.tsx`, `src/app/globals.css`, `src/components/InterviewChat.tsx`, `src/components/Consent.tsx`, or anything under `src/components/ui/` — Slice B's session owns three of those and the primitives are frozen contracts. If a primitive genuinely cannot express something here, style around it in the shell and record why; do not edit the primitive.
- No store, service, type, API route, `proxy.ts`, or `researcherAccess.ts` changes. `enforceResearcherPageSetup()` stays exactly where it is, in every page.
- No new dependencies. No `framer-motion` and no `lucide-react` in any file this slice writes or migrates.
- No `data-theme` wiring and no theme toggle; light Paper only, tokens only, so the Night toggle stays a later slice's cheap addition.
- Deferred, do not attempt: the duplicate Tabs implementations (DIRECTION §7), click-outside dismissal for the row actions menu, `Settings.tsx`'s blue, `layout.tsx`'s `bg-stone-900` body.
- Do not commit; leave the working tree for review. `docs/` is untracked — leave it. npm only (`package-lock.json` authoritative), Node ≥ 24.19.

## Orchestrator notes (Fable, post-review)

- **Known transitional state, do not fix**: `StudySetup` and `StudyDetail` remain legacy dark (`bg-stone-900` inner frames) and will render as dark slabs inside the light shell until Slices D/E migrate them. This is accepted mid-migration ugliness. Do not restyle, wrap, or "harmonize" them.
- **Sequencing**: this slice must not start until Slice B is accepted — both edit `eslint.config.mjs`, and concurrent edits to the same working tree are forbidden.
