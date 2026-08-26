# Slice E — StudySetup as document + Settings + Onboarding (Initiative 1, depends on Slices A and C)

Re-registers `src/components/StudySetup.tsx`, `src/components/Settings.tsx`, and `src/components/Onboarding.tsx` onto the Verbatim system. Context: `docs/design/DIRECTION-final.md` §7 "Researcher workspace", amendments A2, A6, A8. Prerequisites: Slice A primitives exist in `src/components/ui/`; **Slice C must be accepted first** — `/setup` and `/settings` now live under the `(researcher)` route group and are wrapped by `ResearcherShell`, which owns the page frame these three components currently build for themselves.

**Prime directive: this is a re-registering of the surface, not a logic rewrite.** Every store call, effect, handler, ref, validation path, error branch, and disabled expression survives byte-for-byte in behavior. In `StudySetup` that means the whole idempotency apparatus — `setupIntentKey`, `isCreateIntentKey`, `adoptCreateIdempotencyKey`, `readAuthorityEpoch`/`writeAuthorityEpoch`, `readPersistedCreateIdempotency`/`persistCreateIdempotency`, `authorityEpochRef`, `lastAuthRef`, `actionGenerationRef`, `createCompletedRef`, `intentKeyRef`, `createIdempotencyKeyRef`, `applySaveIfCurrent`, `handleSaveStudy` and its full `classification.outcome` ladder including the `window.confirm` path, `handlePreview`, `handleGenerateLink`, `handleCopyLink`, `buildConfig`, `requireResearcherAuth`, `requireConfiguredProvider`, `requireValidModel`, and all six `useEffect`s with their exact dependency arrays. In `Settings` and `Onboarding` that means `validateAiKey`, `validateRedis`, `handleSave`, `clearCredential`, `deleteAccount`, `saveAndComplete`, `refreshProfile`, and the `AI_PROVIDER_SETUP` tables in both files (labels, ids, placeholders, URLs, `steps`, and every word of `guidance`). If a change is not named below, do not make it.

## E1. Structural decision: faithful reskin now, left-nav IA deferred

The adopted direction restructures `StudySetup` as left-nav'd paper sheets (Basics · Research question & topic guide · Profile schema · AI provider · Consent text). **This slice does not do that**, and the reason is concrete rather than cautious: three existing test files query across sections in a single render, so any IA that mounts one sheet at a time breaks them.

- `tests/unit/StudySetup.auth.test.tsx:293–299` clicks `Current Role` (Profile Fields), `Add Question` (Core Questions), and `Add Topic` (Topic Areas) in one render with no navigation between them.
- `tests/unit/StudySetup.auth.test.tsx:147` asserts `getAllByRole('button', { name: /preview/i })).toHaveLength(2)` — the header `Preview` and the footer `Preview Saved Study` must be mounted simultaneously.
- `tests/unit/StudySetup.auth.test.tsx:151` and `:181` assert on `Generate Participant Link` and `Save Study` in the same render as the AI-provider radios.

Rewriting those three suites to drive a section switcher would be a large, unreviewable diff landing in the same PR as a visual migration, and it would put the idempotency regressions (`StudySetup.idempotency.test.tsx`) at risk for a layout reason. So:

**What this slice ships:** a faithful reskin — every section stays mounted, in its current DOM order, with its current heading string — rendered as ruled paper sheets on the shell's page ground, using `Field`, `Button`, `Label`, `Rule`, and `Coordinate`, plus a non-switching in-page **section index** on `lg:` that gives the document its left-nav affordance without unmounting anything (E2.2).

**What is deferred**, as a named follow-up — *"Slice F1: StudySetup document IA"* — and must not be attempted here: true section switching or routing; per-section inline **Edit** affordances; making `studyRevision` legible in the UI; rendering the authored consent text in serif as a readable sheet; and renaming sections to the adopted five-section vocabulary (`Study Details` → `Basics`, and so on). F1 owns the test rewrite that unblocks all of it.

## E2. Laws that bind all three files

- **Light only (A6), tokens only.** `bg-paper-*`, `text-ink-*`, `text-action`, `text-success`, `text-error`, `border-ink-*`. No `dark:` variants, no `data-theme` reads or writes, no theme toggle. Every `stone-*`, `blue-*`, `amber-*`, `green-*`, `red-*`, `purple-*` class dies in this slice.
- **The stray blue dies here.** `Settings.tsx:479` (`bg-blue-500/5 rounded-xl border border-blue-400/20`) is the one Slice C flagged. There is a **second** one the brief did not name: `Onboarding.tsx:338` (`border border-blue-400/20 bg-blue-500/5`). Both go.
- **Ochre is interruptive disclosure only (A8).** The `Disclosure` primitive appears in this slice **zero times**. None of these three surfaces carries synthetic/preview/consent honesty chrome; what they carry is standing explanation (how BYOS credentials are handled) and status (setup incomplete, partial Redis, save failed). Standing explanation is a **fact block** — `bg-paper-2` well, `Label` eyebrow, mono for the machine-verifiable parts — following the precedent Slice B set for the consent data notice. Status is a **ruled notice block** — `border-l-2 px-4 py-3 bg-paper-2` with a `Label` eyebrow and 13px `text-ink-700` body, following the precedent Slice C set in `StudyList`/`Dashboard`. Left-border colour: `border-error` for failure and hard warnings, `border-success` for success, `border-ink-500` for neutral cautions.
- **Triage density (A2).** Reading measure applies to prose only. It **never** applies to a form grid, a field row, a provider table, or a question/topic list. Section descriptions and standing explanations may use `max-w-measure`; nothing with an input in it may.
- **No genre vocabulary in copy (A2).** No "colophon", "apparatus", "marginalia".
- **No decorative icons (§6), no motion.** All three files must end with **no `lucide-react` import** and **no `framer-motion` import**. Every `motion.div` becomes a plain `div` and every `AnimatePresence` is removed (`Onboarding`'s step transitions simply stop animating). No spinners: `Loader2` is replaced by the text the button already shows.
- **Radius discipline:** `0` for structure (sheets, sections, notice blocks), `rounded` for controls. Every `rounded-lg`, `rounded-xl`, `rounded-2xl`, and `rounded-full` dies.
- **Serif appears nowhere in this slice.** These are forms and specification sheets, not documents of speech. `Verbatim` is not imported. No file may contain a raw `font-serif` class — the ratchet will enforce it.
- **The shell owns the frame for two of the three.** `StudySetup` (`/setup`) and `Settings` (`/settings`) render inside `ResearcherShell`, which already provides `min-h-dvh bg-paper-0` and a `<Page>` container. Both components must **delete** their own `min-h-screen bg-stone-900 p-4 sm:p-8` frame, their `max-w-3xl` / `max-w-2xl mx-auto` inner div, and their back-to-studies buttons (the rail is the nav now). **`Onboarding` is different**: `/onboarding` was deliberately excluded from the route group in Slice C, so `Onboarding` keeps and re-registers its own full-page frame (E5.1). Getting this asymmetry backwards produces either a doubly-indented settings page or an unstyled onboarding page.

## E3. `StudySetup.tsx`

### E3.1 Header

`framer-motion` wrapper `<motion.div initial animate className="mb-8">` becomes `<div className="mb-8">`. Deleted: the back-arrow button and its `aria-label="Back to all studies"`; the `w-10 h-10 rounded-xl bg-stone-700` icon tile and its `FileText`; `Lightbulb`, `Eye`, `Loader2`, `Save`, `Check`, `CheckCircle` from the action buttons.

- `<h1 className="font-sans text-[24px] font-semibold leading-[32px] text-ink-900">Study Setup</h1>` — copy verbatim.
- Subtitle `Configure your research interview study` verbatim, `font-sans text-[13px] text-ink-500`, no `ml-[52px]` offset.
- Action row (`flex flex-wrap gap-2`), keeping its `hasRequiredFields` gate and its DOM order exactly:
  - `Load Example` — `Button variant="quiet"`, `onClick={loadExampleStudy}`, copy verbatim.
  - Save — `Button` whose variant is chosen by the existing state ladder, with `className` overrides merged by `cn` (twMerge resolves the border/text conflicts):

    | state | variant | extra className |
    |---|---|---|
    | `savePending` | `quiet` | `border-error text-error` |
    | `savedStudyId && !isDirty` | `quiet` | `border-success text-success` |
    | `saveSuccess` | `primary` | — |
    | otherwise | `primary` | — |

    The label expression is copied **character for character**:
    `{isSaving ? 'Saving...' : savePending ? 'Repair pending' : savedStudyId && isDirty ? 'Update Study' : savedStudyId ? 'Saved' : saveSuccess ? 'Saved!' : 'Save Study'}`.
    The `disabled` expression is copied character for character. The `isSaving || isAuthenticated === null` opacity class is dropped — `Button` already has `disabled:opacity-50`.
  - Preview — `Button variant="quiet"`, `disabled` expression verbatim, label `{isPreviewLoading ? 'Loading...' : 'Preview'}` verbatim.

  `tests/unit/StudySetup.idempotency.test.tsx` matches `Save Study`, `Update Study`, and `Repair pending` as exact accessible names; `tests/unit/StudySetup.auth.test.tsx:146` matches `Saved` and `:147` requires **exactly two** buttons whose name matches `/preview/i` across the whole page. Do not add, remove, or re-word a button that would change that count.

### E3.2 Section index (`lg:` only, non-switching)

A single new element, placed after the header, giving the document its left-nav reading without unmounting anything:

```tsx
<nav aria-label="Study sections" className="hidden lg:block lg:float-right lg:ml-10 lg:w-52">
  <ol className="flex flex-col gap-0.5 border-l border-ink-300 pl-4">
    {/* one <li><a href="#id"> per section, font-sans text-[13px] text-ink-700 hover:text-action */}
  </ol>
</nav>
```

(A `float` is acceptable here; a `lg:grid lg:grid-cols-[1fr_13rem]` wrapper around the form is equally acceptable — pick one, keep the form column ahead of the index in DOM order so tab order is unchanged.)

Seven entries, in DOM order, each label **exactly equal to the section's existing `<h2>` string** so nothing is renamed: `Study Details` → `#study-details`, `Profile Fields` → `#profile-fields`, `Core Questions` → `#core-questions`, `Topic Areas` → `#topic-areas`, `AI Provider` → `#ai-provider`, `AI Interview Style` → `#ai-interview-style`, `Link Settings` → `#link-settings`, `Consent Text` → `#consent-text`. (Eight — the list is the eight always-mounted sections; the conditional Participant Link and Submit blocks are not indexed.) Each section gains the matching `id` on its wrapper `<section>` element and nothing else. No active-section tracking, no scroll spy, no `IntersectionObserver`.

### E3.3 Sheet, notices, and sections

The `motion.div` form wrapper becomes `<div className="space-y-12 border border-ink-300 bg-paper-1 p-5 md:p-8">` — one sheet, radius 0, one hairline, no shadow.

Each section becomes `<section id="…" className="space-y-4">` with `<h2 className="font-sans text-[15px] font-semibold text-ink-900">` (copy verbatim), its existing description paragraph at `font-sans text-[13px] leading-[20px] text-ink-500 max-w-measure` (copy verbatim), and `<Rule />` between sections. The `Sparkles`, `User`, `Clock`, and `LinkIcon` heading icons are deleted.

Notice blocks, all `border-l-2 px-4 py-3 bg-paper-2` with a `Label` eyebrow and a 13px `text-ink-700` body:

- **Save error** (`saveError`) — `border-error`. Eyebrow `Save Failed` (verbatim), body `{saveError}`. The two inline `<svg>` blocks are deleted; the dismiss control keeps `onClick={() => setSaveError(null)}` and `aria-label="Dismiss save error"` verbatim and renders the character `×` (matching Slice C's dismiss idiom).
- **Save pending** (`savePending`) — `border-error`. Eyebrow `Study saved; repair pending` verbatim (`StudySetup.idempotency.test.tsx:175` matches this string), body verbatim, and the `My Studies` control as `Button variant="quiet"` with its `router.push('/studies')` handler. `AlertTriangle` deleted.
- **Follow-up study** (`parentStudyInfo`) — `border-ink-500`. Eyebrow `Follow-up Study` verbatim (`StudySetup.idempotency.test.tsx:290` matches it), body `Based on findings from ` + the parent-study `<button>` restyled `text-action underline underline-offset-2 hover:text-ink-900`, same handler. `GitBranch` deleted; the blue dies.

### E3.4 Fields

Use the Slice A `Field` primitive for every labelled control **except** the three named exceptions below. `Field` nests the control inside its `<label>`, which is safe in `StudySetup` — no test in this file walks `parentElement` from an input.

| control | `Field` props | notes |
|---|---|---|
| Study name | `label="Study Name *"` `htmlFor="study-name"` | placeholder `e.g., AI Adoption in Healthcare` **verbatim** — two test files query by it |
| Research question | `label="Research Question *"` `htmlFor="study-research-question"` | placeholder `What are you trying to understand?` **verbatim**; `rows={2}` kept |
| Description | `label="Description (optional)"` `htmlFor="study-description"` | placeholder verbatim; `rows={2}` kept |
| Model select | `label="Model"` `htmlFor="study-ai-model"` | `getByLabelText('Model')` must keep working; the model-description `<p>` becomes `Field`'s `hint` (an empty description renders nothing, which matches today) |
| Reasoning mode | `label="AI Reasoning Mode"` `htmlFor="study-reasoning-mode"` | `getByLabelText('AI Reasoning Mode')` must keep working; the explanatory `<p>` becomes `hint` |
| Link expiration | `label="Link Expiration"` `htmlFor="study-link-expiration"` | the `<label className="block">` wrapper collapses into `Field`; the trailing `<p>` becomes `hint`, copy verbatim |
| Consent text | `label="Consent Text"` `htmlFor="study-consent-text"` | `rows={4}` kept; the `<h2>Consent Text</h2>` stays as the section heading and `Field`'s label duplicates it — instead, **omit the `<h2>` for this one section** and let `Field`'s label carry the name, keeping `id="consent-text"` on the section. Copy is unchanged either way. |

**Named exceptions — do not route through `Field`:**

1. **OpenRouter custom model ID** — keeps its hand-rolled `<label htmlFor="study-openrouter-custom-model">` + `<input>` + `<p id="study-openrouter-model-help">` structure, because `aria-describedby="study-openrouter-model-help"` and `aria-invalid={!selectedModelValid}` must survive exactly and `Field`'s `hint` carries no id. Restyle the label with `Label` typography and the input with `Field`'s control classes (`bg-paper-2 border border-ink-300 rounded px-3 py-2 text-ink-900 font-sans`). `maxLength={200}`, `autoComplete="off"`, and the placeholder `provider/model` all verbatim.
2. **The participant-link readonly input** — keeps its `readOnly` input + `Copy` button row; restyle the input with the control classes plus `font-mono text-[13px]`. `Copy` / `Copied!` labels verbatim, `Copy` and `Check` icons deleted.
3. **Question and topic rows** — see E3.5.

All `focus:outline-none focus:ring-2 focus:ring-stone-500` clusters are deleted; the token focus ring in `globals.css` covers every control.

### E3.5 Question, topic, and profile rows — register density, not measure

Core Questions and Topic Areas: keep the `{i + 1}.` ordinal, rendered through `<Coordinate className="w-6 pt-3 text-right">{i + 1}.</Coordinate>`. The `<textarea>` keeps `rows={2}` and takes the control classes plus `flex-1 resize-none`. The remove control keeps `aria-label={\`Remove question ${i + 1}\`}` / `Remove topic ${i + 1}` **verbatim** (both are matched by name in `StudySetup.auth.test.tsx:298–299`), keeps its `coreQuestions.length > 1` / `topicAreas.length > 1` gate, keeps `min-h-11`, drops the `X` icon, and renders the character `×` with `text-ink-500 hover:text-error`. `Add Question` / `Add Topic` become `Button variant="quiet"` with `className="text-[13px]"`; both labels verbatim (`Plus` icon deleted, so the accessible name becomes exactly `Add Question` / `Add Topic`, which is what the tests already match).

Profile Fields: each row loses `bg-stone-800 rounded-xl p-4 border border-stone-700` and becomes `border-b border-ink-200 py-4` — a ruled register row, full page width, **never** `max-w-measure`. The two inputs take the control classes plus `text-[13px]`. The required toggle keeps `onClick={() => toggleFieldRequired(field.id)}` and its `title` attribute verbatim, drops `ToggleLeft`/`ToggleRight`, and renders `REQ` / `OPT` through `Coordinate` with `border border-ink-300 rounded px-2 py-1`; required gets `text-ink-900 border-ink-500`, optional `text-ink-500`. The remove control keeps `aria-label={\`Remove ${field.label || 'profile field'}\`}` **verbatim** (matched at `StudySetup.auth.test.tsx:297`) and renders `×`. Quick-add presets keep `+ {preset.label}` **verbatim** (matched as `/Current Role/` at `:293`) as `Button variant="quiet" className="text-[13px] px-3 py-1"` — `rounded-full` dies. `Add Custom` keeps its label and gains nothing. The `No profile fields yet…` empty line is verbatim, `text-[13px] text-ink-500`.

### E3.6 AI Provider and AI Interview Style — selectable rows

Both radio groups keep their `<label>`-wraps-`<input>` structure exactly, because `getByRole('radio', { name: /Anthropic Claude/ })` and its five siblings resolve the accessible name from the wrapping label's text. Restyle each option as a selectable register row, reusing the shell's active-nav idiom:

`className={cn('flex cursor-pointer items-start gap-3 border-l-2 py-3 pl-4', selected ? 'border-l-action bg-paper-2' : 'border-l-transparent hover:bg-paper-2/50')}`

`border-2 rounded-xl` dies. The radio input keeps `name`, `checked`, and its `onChange` handler byte-for-byte (including the `setAiModel(DEFAULT_MODEL_BY_PROVIDER[option.id])` reset and both `setIsDirty(true)` calls); `accent-stone-500` becomes `accent-action`. Option label `font-sans text-[15px] font-medium text-ink-900`; `option.desc` and the OpenRouter ZDR sentence `font-sans text-[13px] text-ink-500` — the ZDR sentence is matched at `StudySetup.auth.test.tsx:221` and is copy-verbatim.

Provider status blocks, all keeping their exact conditions, roles, and copy:

- `providerOptions.length === 0` → ruled block, `border-error`, eyebrow `No provider configured`, body `No AI provider keys are configured for this hosted account. Add one in Account & connections.` verbatim (including the `&amp;` entity).
- `!selectedModelValid` → keeps `role="alert"`, ruled block `border-error`, body verbatim for both branches. **Do not add any other `role="alert"` to this component** — `StudySetup.auth.test.tsx:278` and `:282` call `getByRole('alert')` in the singular in a state where this is the only alert.
- `isAuthenticated === true && !configStatus && !configStatusError` → keeps `role="status"`, ruled block `border-ink-500`, body `Checking configured AI providers…` verbatim, `Loader2` deleted.
- The provider-unavailable block → keeps `role="alert"`, ruled block `border-error`. Its `<h4>` keeps both branch strings verbatim (`Provider availability could not be verified`, `` `${selectedProviderName} is not available` `` — matched three times in `StudySetup.auth.test.tsx`). Its body keeps all four branches verbatim, **including the two `<code>` elements** (`{selectedProviderEnvName}` and `npm run setup:check`), which are matched by exact `getByText` at `:179–180` and `:189` — keep them as `<code className="font-mono text-ink-900">` and do not merge them into surrounding text. The two follow-up controls keep their labels `Account & connections` and `Open self-host setup guide` verbatim (matched at `:153` and `:183`) and become text buttons, `font-sans text-[13px] font-medium text-action underline underline-offset-2`. `AlertTriangle` deleted.

### E3.7 Participant link and submit

- The auth-required block keeps `Login required to generate participant links.` and `Checking researcher sign-in…` verbatim (`StudySetup.auth.test.tsx:122`); it becomes a `bg-paper-2 px-4 py-3` well; `Login as Researcher` becomes `Button variant="quiet"` (label verbatim, `LogIn` icon deleted).
- `Generate Participant Link` becomes `Button variant="primary" className="w-full"`, label and `disabled` expression verbatim (matched at `:151`), `LinkIcon` deleted; the `isGeneratingLink` label `Generating...` verbatim. `linkError` renders `text-[13px] text-error`.
- The opaque-link explanation sentence is verbatim, `text-[13px] text-ink-500`.
- Submit block: `Preview Saved Study` becomes `Button variant="primary" className="w-full"` with its `disabled` expression verbatim and **no `ArrowRight`** — the accessible name must stay exactly `Preview Saved Study` so the `/preview/i` count stays at two. Both trailing explanation sentences (`Researcher sign-in is required…`, `Save changes to preview…`) are verbatim, `text-[13px] text-ink-500`.

## E4. `Settings.tsx`

### E4.1 Frame, header, and the blue

Delete: the `motion.div` wrapper and the `framer-motion` import; **both** page frames (`min-h-screen bg-stone-900 p-4 sm:p-8` + `max-w-2xl mx-auto`, in the standalone branch and the hosted branch) — the shell owns them; both back-to-studies buttons and their `aria-label="Back to studies"`; the `ArrowLeft`, `Database`, `Key`, `Trash2`, `RotateCw`, `Loader2`, `ChevronDown`, `ChevronUp`, `CheckCircle`, `XCircle`, `AlertCircle` imports (the whole `lucide-react` line).

- Loading branch: `<p className="font-sans text-[15px] text-ink-500">Loading…</p>` in place of the centred spinner.
- Standalone branch: `<h1 className="font-sans text-[24px] font-semibold leading-[32px] text-ink-900">Self-hosted settings</h1>` and its subtitle verbatim; the explanation card becomes a `bg-paper-2 p-5` fact block with both paragraphs verbatim and `<code>npm run setup:check</code>` as `font-mono text-ink-900`; `Open self-host guide` becomes `Button variant="quiet"` and `View readiness status` stays an `<a>` styled with the quiet-anchor classes, both labels verbatim.
- Hosted branch: `<h1 …>Settings</h1>` — the exact string, matched as a level-1 heading at `providerSetupCopy.test.tsx:142` and `:174`. `{profile.email}` beneath it as `<Coordinate>` (it is a machine-verifiable fact).
- **`Settings.tsx:479`, the stray blue, dies.** `bg-blue-500/5 rounded-xl border border-blue-400/20` becomes a `bg-paper-2 p-5` fact block: `Label` eyebrow `How hosted BYOS credentials are handled` (today's `<p className="font-medium">` lead-in, verbatim), body verbatim at `font-sans text-[13px] leading-[20px] text-ink-700 max-w-measure`. Not ochre — see E2.

### E4.2 Status icons and validation badges — same announcement, no icons

`StatusIcon` and `ValidationBadge` keep their component signatures, their `role="status" aria-live="polite"` wrappers, and **every existing `sr-only` string verbatim** (`Testing {label} key`, `{label} key validated`, `: configured`, `: not configured`). Only the icon changes: each becomes a visible word marked `aria-hidden="true"` so the announced text is byte-for-byte what it is today.

```tsx
// StatusIcon
<span aria-hidden="true" className={cn('font-sans text-[13px]', configured ? 'text-success' : 'text-ink-500')}>
  {configured ? 'Configured' : 'Not configured'}
</span>

// ValidationBadge: 'Testing…' text-ink-500 · 'Valid' text-success · 'Invalid' text-error
```

The `state.valid === false` branch keeps returning a bare node with no `role="status"`, exactly as today. `Current Status` keeps its `<h2>`, its `grid grid-cols-1 sm:grid-cols-2` layout, and all five row labels verbatim (`Gemini Key`, `Claude Key`, `OpenAI Key`, `OpenRouter Key`, `Redis Storage`).

### E4.3 Provider key rows — the DOM shape is load-bearing

**Do not use `Field` for the provider key inputs or the Redis inputs.** `providerSetupCopy.test.tsx` walks the DOM from these nodes:

- `:122` and `:189` — `within(input.parentElement!).getByRole('button', { name: 'Test' })`. The input's **direct parent** must contain the Test button. `Field` nests the control inside its `<label>`, which would put the Test button outside that parent and fail both assertions.
- `:208–209` — `within(screen.getByText('OpenRouter API Key').parentElement!.parentElement!).getByRole('button', { name: 'Clear' })`. The label element's **grandparent** must contain the Clear button.

So keep the existing three-level shape exactly: a `<div key={provider.id}>` wrapper containing a header row (`<label htmlFor>` + a badge/Clear cluster) and a `<div className="flex flex-col gap-2 sm:flex-row">` holding the input and the Test button as siblings. Restyle in place:

- the `<label>` element itself takes `Label`'s typography (`font-sans text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500`) — do **not** wrap it in the `Label` primitive and do not replace it with a `<span>`; `getByLabelText('Google Gemini API Key')` and `getByText('OpenRouter API Key')` both depend on it being the labelling element with exactly that text.
- the input takes `Field`'s control classes plus `min-w-0 flex-1 text-[13px]`, and keeps `type="password"`, `autoComplete="new-password"`, its `placeholder` expression, its `aria-describedby` expression, its `onChange` (both `setProviderKeys` and the `setProviderValidation` reset), and its id verbatim.
- `Test` becomes `Button variant="quiet" className="text-[13px]"`, label and `disabled` expression verbatim.
- `Clear` keeps its `onClick`, its `disabled={Boolean(lifecycleBusy)}`, and its label expression `{lifecycleBusy === provider.clearTarget ? 'Clearing…' : 'Clear'}` verbatim, restyled `font-sans text-[13px] text-error hover:text-ink-900 disabled:opacity-50`.
- the validation error `<p id={errorId} role="alert">` keeps its role and id, restyled `text-[13px] text-error`.
- the setup-guide toggle keeps `aria-expanded={guideOpen}`, its handler, and its label `{provider.label} setup guide` verbatim (four exact names matched at `:143–146`); the chevron is deleted, so the accessible name becomes exactly the label string. The open panel becomes `bg-paper-2 p-4 text-[13px]` with the `<ol className="list-decimal list-inside">` and every `guidance` node — including all five external `<a href>`s and their exact link text — untouched apart from restyling the anchors to `text-action underline underline-offset-2`.

`AI API Keys` heading, `Update your API keys. Leave blank to keep the current key.`, `Upstash Redis Storage`, and `Update your Redis credentials…` are all verbatim. The Redis section's inline warning sentence (`Warning: changing your Redis URL will disconnect from your current data.`) keeps its wording and becomes `text-error`; the `Clearing this connection never deletes data…` sentence stays `text-ink-500`. The Redis `Setup guide` toggle keeps the exact name `Setup guide` (matched at `:147`). `Test Connection` / `Testing...` and `Connected` are verbatim; `Connected` becomes `text-success`, the error span keeps `id="settings-redis-error"` and `role="alert"`.

### E4.4 Notices, save, and account deletion

- **Onboarding incomplete** (`profile && !profile.onboardingComplete`) — ruled block, `border-ink-500` (a caution, not a failure). Eyebrow `Setup incomplete`, body `Storage and at least one valid AI key are required before studies can run.` verbatim, and `Finish setup` verbatim as a `text-action underline underline-offset-2` button with its `router.push('/onboarding')` handler. `AlertCircle` deleted; the amber dies.
- **Partial Redis** — ruled block, `border-error`, body `Both Redis URL and token are required to update storage credentials.` verbatim, no role added (it has none today).
- **Save feedback row** — `saveSuccess` keeps `role="status" aria-live="polite"` and the text `Saved successfully` verbatim, `text-success`; `saveError` keeps `role="alert"` and `{saveError}`, `text-error`. Icons deleted.
- **Save button** — `Button variant="primary"`, label `{saving ? 'Saving...' : 'Validate & rotate'}` with the ellipsis form and the `&amp;` entity exactly as today (matched at `:195` as `/Validate & rotate/i`), `disabled={saving || !hasChanges}` verbatim, `RotateCw` and `Loader2` deleted.
- **Delete platform account** — keeps `id="account"`, the `<h2>Delete platform account</h2>`, the three-sentence body, the `<label htmlFor="delete-account-confirmation">Enter {profile.email} to confirm</label>`, and the input's id, `type`, `autoComplete="off"`, and handler, all verbatim. Restyle as a ruled block, `border-l-2 border-error bg-paper-2 px-4 py-4`; `Delete account` becomes `Button variant="destructive"` with its `disabled` expression and its `{lifecycleBusy === 'account' ? 'Deleting…' : 'Delete account'}` label verbatim. `Trash2` deleted; `bg-red-500/5 border-red-500/30` dies.

## E5. `Onboarding.tsx` — provisioning your own instrument

### E5.1 Frame and progress

`/onboarding` is **not** inside the researcher route group, so this component keeps its own frame — re-registered: `<div className="flex min-h-dvh items-center justify-center bg-paper-0 p-4 sm:p-8">` with an inner `<div className="w-full max-w-lg">`. The `motion.div` wrapper, the `AnimatePresence`, all four per-step `motion.div`s, and the `framer-motion` import are deleted (steps swap instantly). The whole `lucide-react` import is deleted.

The four-bar progress indicator dies (DIRECTION §10 kills progress dots and bars). It is replaced by one mono line, the humane counter:

```tsx
<Coordinate className="mb-8 block">{`Step ${currentStep + 1} of ${STEPS.length} · ${STEP_LABELS[step]}`}</Coordinate>
```

with a module-level `const STEP_LABELS: Record<Step, string> = { welcome: 'Welcome', 'ai-keys': 'AI API Key', redis: 'Upstash Redis', done: 'Done' }` — each value equal to the step's existing heading string, so no new vocabulary enters the product. No `role`, no `aria-live`: this line must not announce.

The card `bg-stone-800/50 rounded-xl border border-stone-700 p-5 sm:p-8` becomes `border border-ink-300 bg-paper-1 p-5 md:p-8` — the specification sheet.

### E5.2 Welcome step

- `<h1 className="font-sans text-[24px] font-semibold leading-[32px] text-ink-900">` with the existing `Welcome{profile?.name ? \`, ${profile.name.split(' ')[0]}\` : ''}!` expression verbatim. The `w-14 h-14 rounded-full` circle and its `Sparkles` are deleted, and the block is left-aligned (`text-center` dies).
- The BYOS paragraph is verbatim, including `<strong>Bring Your Own Storage</strong>`, at `font-sans text-[15px] leading-[24px] text-ink-700 max-w-measure`.
- The two requirement tiles become a ruled specification list — `<ol>` with `<li className="grid grid-cols-[2rem_1fr] gap-3 border-t border-ink-300 py-4">`, left cell `<Coordinate>{n}</Coordinate>`, right cell the existing title (`AI API Key`, `Upstash Redis`) at `font-sans text-[15px] font-medium text-ink-900` and the existing sub-line (`A Gemini, Claude, OpenAI, or OpenRouter key`, `Your database for studies and interview records`) at `text-[13px] text-ink-500`. All four strings verbatim; `Key` and `Database` icons deleted.
- **`Onboarding.tsx:338`, the second stray blue, dies.** The credential-handling paragraph becomes a `bg-paper-2 p-4` fact block with a `Label` eyebrow `How these credentials are handled` and the body verbatim at `text-[13px] leading-[20px] text-ink-700`.

### E5.3 AI keys and Redis steps

- Headings `AI API Key` and `Upstash Redis` become `<h2 className="font-sans text-[18px] font-semibold text-ink-900">`; both sub-paragraphs verbatim at `text-[13px] text-ink-500`.
- `ValidationBadge` takes the same icon-free treatment as `Settings` (E4.2), with its `role="status" aria-live="polite"` wrappers and `sr-only` strings untouched. The `Connected` chip in the AI-keys step keeps its exact condition and text, restyled `text-[13px] text-success`.
- **The provider key rows keep their DOM shape for the same reason as `Settings`** — `providerSetupCopy.test.tsx:118–122` does `within(screen.getByLabelText(/OpenAI API Key/i).parentElement!).getByRole('button', { name: 'Test' })` against `Onboarding`. Do not use `Field` here; restyle the existing `<label htmlFor>` / input / `Test`-button structure in place, exactly as specified in E4.3.
- The guide toggles keep `aria-expanded` and their labels `How to get {article} {summaryLabel} API key` and `How to set up Upstash Redis` **verbatim** (five exact names matched at `:92–95` and `:129`); chevrons deleted. Both open panels become `bg-paper-2 p-4 text-[13px]` with their `<ol>`s, every step string, the `⚠` line and its two sentences, and every external anchor and link text untouched apart from `text-action underline underline-offset-2`.
- The Redis inputs keep `id`, `type`, `placeholder`, `aria-describedby`, and their `onChange` handlers (including the `setRedisValidation` resets) verbatim, and take `Field`'s control classes without going through `Field`. `Test Connection` / `Testing...` becomes `Button variant="quiet"`, label and `disabled` expression verbatim. The error span keeps `id="onboarding-redis-error"` and `role="alert"`.

### E5.4 Done step and navigation

- The green circle and `CheckCircle` are deleted. `<h2 className="font-sans text-[18px] font-semibold text-ink-900">You&apos;re all set!</h2>` and its paragraph verbatim; the block is left-aligned.
- The two summary lines keep their expressions verbatim (`AI: {availableProviders.map(p => p.summaryLabel).join(' + ')}`, `Storage: Upstash Redis connected`) as `border-t border-ink-300 py-2 font-sans text-[13px] text-ink-900` rows, `CheckCircle`s deleted.
- `saveError` keeps `role="alert"`; ruled block, `border-error`, body `{saveError}` verbatim. `AlertCircle` deleted.
- `Create Your First Study` becomes `Button variant="primary" className="w-full"`, `disabled={saving}` verbatim, label `{saving ? 'Saving...' : 'Create Your First Study'}` with `Loader2` and `ArrowRight` deleted.
- Navigation row keeps its `step !== 'done'` gate, both handlers, and both `disabled` expressions verbatim. `Back` and the `{step === 'welcome' ? 'Get Started' : 'Next'}` control become bare text buttons (`font-sans text-[13px]`, `text-ink-500 hover:text-ink-900` and `text-action` respectively), `min-h-11`, arrows deleted — the accessible names become exactly `Back`, `Get Started`, and `Next`, which is what `:91` and `:123` already match. **`Next` must remain the only button on the page whose name matches `/next/i`.**

## E6. Ratchet (`eslint.config.mjs`)

- Remove `'src/components/StudySetup.tsx'`, `'src/components/Settings.tsx'`, and `'src/components/Onboarding.tsx'` from `legacyDesignAllowlist`. All three must then pass clean under `--max-warnings=0`.
- Make no other allowlist edits and no rule edits. Three lines.
- Assuming Slices C and D have landed, the allowlist after this slice should hold **eleven** entries and no more: `src/components/Synthesis.tsx`, `InterviewDetail.tsx`, `StudyDetail.tsx`, `Export.tsx`, `Login.tsx`, `OAuthLogin.tsx`, `PreviewBanner.tsx`, `src/app/layout.tsx`, `src/app/self-host/page.tsx`, the setup `page.tsx` entry (its glob was rewritten by Slice C and still covers the route wrapper's legacy `SetupLoading` fallback, which this slice does **not** touch), and `src/app/p/\[token\]/page.tsx`. Report the actual list in the handback; do not "tidy" it.

## E7. Tests

**Must keep passing, ideally untouched:**

- `tests/unit/StudySetup.idempotency.test.tsx` — load-bearing: the two placeholders (`e.g., AI Adoption in Healthcare`, `What are you trying to understand?`); the exact button names `Save Study`, `Update Study`, `Repair pending`; the texts `Study saved; repair pending`, `Follow-up Study`, and `/already used with a different study/i`. Every idempotency-body assertion must pass unchanged — if one breaks, the reskin touched logic and the fix is to revert that, not to edit the test.
- `tests/unit/StudySetup.auth.test.tsx` — load-bearing: `getAllByRole('button', { name: /preview/i })).toHaveLength(2)`; the six provider/behaviour radios resolved by wrapping-label text; `getByLabelText('Model')`, `getByLabelText('AI Reasoning Mode')`, `getByLabelText('OpenRouter model ID')`; singular `getByRole('alert')` in the invalid-custom-model state; exact `getByText` on `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, and `npm run setup:check`; exact button names `Account & connections`, `Open self-host setup guide`, `Generate Participant Link`, `Save Study`, `Saved`, `Add Question`, `Add Topic`, `Remove question 2`, `Remove topic 2`, `Remove Current Role`, and the preset matching `/Current Role/`; and the text `Login required to generate participant links.`
- `tests/unit/providerSetupCopy.test.tsx` — load-bearing: the two `parentElement` walks documented in E4.3; `findByRole('heading', { level: 1, name: 'Settings' })`; the nine exact guide-toggle names; the four `getByLabelText('<Provider> API Key')` lookups and their `type="password"` / cleared-value assertions; `getByText('OpenRouter API Key')` as an exact string; `getByRole('button', { name: /Validate & rotate/i })`; every external link name and `href`; the singular `/next/i` button; and `expect(document.body).not.toHaveTextContent(/10 req\/min|250 req\/day|\$5 free|15-100 interviews|256 MB|500K commands/i)` — **do not add any quota, price, or rate number to any of these three files.**
- `tests/unit/StudyOperationRecovery.ui.test.tsx` and `tests/unit/api.onboarding.lifecycle.test.ts` are not expected to move; if they do, investigate rather than edit.

Where an existing test must change, change only the structural query and preserve every behavioural assertion.

**New, smallest realistic regressions:**

- `tests/unit/StudySetup.document.test.tsx`
  - the section index renders a `nav` named `Study sections` whose links resolve to the eight section ids, and **every one of those ids exists in the document at the same time** (this is the assertion that fails loudly if someone later makes the index switch sections instead of scrolling);
  - `container.querySelectorAll('svg')` has length `0`;
  - no ancestor of the profile-field rows or the question rows carries `max-w-measure` (walk `parentElement` to `document.body` and assert the class is absent on every node);
  - the `Save Study` button's `disabled` state still tracks `isAuthenticated`/provider configuration exactly as `StudySetup.auth.test.tsx` expects — assert one case here only if it is not already covered there; do not duplicate.
- `tests/unit/Settings.tokens.test.tsx`
  - with a hosted profile: for each of the four providers, the key input's `parentElement` contains a button named `Test` (a direct guard on the DOM contract E4.3 protects);
  - the `Configured` / `Not configured` words render `aria-hidden="true"` while the existing `sr-only` status strings are still present in the accessible tree;
  - the BYOS explanation block renders with no `role="note"` (it is a fact block, not an ochre `Disclosure`);
  - `container.querySelectorAll('svg')` has length `0`.
- `tests/unit/Onboarding.steps.test.tsx`
  - the progress line renders `Step 1 of 4 · Welcome` and carries no `role` and no `aria-live`;
  - advancing to the AI-keys step renders `Step 2 of 4 · AI API Key`;
  - `container.querySelectorAll('svg')` has length `0` on the welcome, ai-keys, and done steps.

Do not snapshot any of the three components.

## E8. Verification

```bash
npm run lint && npm run typecheck && npm run test
DEPLOYMENT_MODE=standalone npm run build
npm run test:e2e
```

Then, before handing back:

- Load `/setup` and `/settings` behind the shell and confirm neither draws a second page frame, a second back-nav, or a doubled horizontal inset; confirm `/onboarding` still draws its own centred frame and shows **no** researcher rail.
- 375 / 1024 / 1440 visual pass on `/setup`, `/settings`, and `/onboarding`. At 1024 confirm the `StudySetup` section index appears and scrolls rather than switching; below `lg` confirm it is absent and every section is still reachable.
- Confirm no ochre appears anywhere in this slice (E2) and no blue survives in either `Settings.tsx` or `Onboarding.tsx`.

Leave the dev server runnable for the orchestrator's screenshots.

## Hard constraints

- Files that may change: `src/components/StudySetup.tsx`, `src/components/Settings.tsx`, `src/components/Onboarding.tsx`, `eslint.config.mjs` (three lines, per E6), and the tests in E7. Nothing else.
- Do not touch `src/app/globals.css`, `src/app/layout.tsx`, any `page.tsx` (including `src/app/(researcher)/setup/page.tsx` and its `SetupLoading` fallback), anything under `src/components/ui/` (frozen contracts), or `src/components/shell/**`. If a primitive genuinely cannot express something here, style around it in the component and record why; do not edit the primitive.
- No store, service, type, API route, `proxy.ts`, or `researcherAccess.ts` changes. `enforceResearcherPageSetup()` stays exactly where it is.
- No new dependencies. No `framer-motion` and no `lucide-react` in any file this slice writes.
- No `data-theme` wiring and no theme toggle; light Paper only, tokens only (A6).
- Do not commit; leave the working tree for review. `docs/` is untracked — leave it. npm only (`package-lock.json` authoritative), Node ≥ 24.19.

## Deferred, do not attempt

- **Slice F1: StudySetup document IA** — section switching or per-section routing, per-section inline **Edit**, legible `studyRevision`, serif rendering of the authored consent text, and the adopted five-section vocabulary. F1 owns rewriting the three `StudySetup` suites that currently pin the all-mounted shape (E1).
- Sharing the duplicated `AI_PROVIDER_SETUP` / `ValidationBadge` / `emptyValidationState` / `initialProviderRecord` definitions between `Settings.tsx` and `Onboarding.tsx`. They are near-identical and drift-prone, but extracting them is a logic change and belongs in its own PR with its own review.
- `src/app/layout.tsx`'s `bg-stone-900` body, and the `SetupLoading` fallback's legacy markup.

## Open questions for the orchestrator

1. **Settings' `Back to studies` button.** This spec deletes it in both branches on the grounds that the shell's rail is the nav and Slice C deleted the equivalent buttons from `StudyList` and `Dashboard`. If the owner wants a per-page back affordance anywhere in the researcher workspace, that is a shell-level decision (a breadcrumb already exists) and should be made once, not per screen.
2. **`Onboarding`'s frame after the shell exists.** `/onboarding` is deliberately outside the route group, so this slice keeps its standalone centred frame. Worth confirming that is still wanted: a researcher who has just signed in and is provisioning credentials arguably belongs inside the shell with the rail visible, which would move `/onboarding` into the group and delete its frame instead. That is a routing change, so it is out of scope either way — but the answer changes what F1 inherits.
3. **The section index's placement.** E3.2 specifies a right-floated index on `lg:` (the form column keeps the left of the page). The adopted direction says *left*-nav'd sheets. A true left index inside the shell would sit immediately beside the shell's own left rail, giving two stacked navigation columns at 1024px. If the owner prefers the left reading anyway, it is a class change in E3.2 and no test moves.
