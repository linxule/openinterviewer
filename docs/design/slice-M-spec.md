# Slice M — StudySetup decomposed, and the study as a revisable document (Initiative 3, depends on Slice I)

Takes the last structural debt in the researcher workspace — a 1,497-line `src/components/StudySetup.tsx` that holds the create-idempotency apparatus, twenty-two `useState` fields, eight form sections, and every provider-availability branch in one file — and splits it into a lib module, a draft hook, and eight section components (C6). On that foundation it ships **F1** as `slice-E-spec.md` §E1 defined it: sections readable at measure, a per-section inline **Edit** affordance, `studyRevision` made legible, the authored consent text rendered as a serif reading sheet, and the optional researcher-contact field that Slice K's receipt has been waiting for. It also closes D6 and D7's four remaining StudySetup sites and adopts `Notice` in the seven blocks Slice H deliberately left alone.

Context: `docs/design/initiative-3-brief.md` (Move C6, D6/D7 rows, "A2 … adding one belongs to Slice M"), `docs/design/slice-E-spec.md` §E1 and its Deferred list (which names this slice by name), `docs/design/DIRECTION-final.md` §3 (type scale), §4 (rules over boxes, reading measure never applies to lists), §6 (iconography), §7 ("StudySetup becomes a revisable document"), §9/§10, §11. Format follows `docs/design/slice-H-spec.md`.

**Prerequisites: Slices H and I, merged.** `Notice`, `Icon`, `Field`, `Coordinate`, `Label`, `Rule`, `Verbatim`, and `Button` are frozen primitives. H11 already changed this file's consent default (`useState(studyConfig?.consentText ?? '')`), its `buildConfig` templating, its client-side bracket guard, and its consent `Field` hint; all four survive this slice unchanged in behaviour. Slice L (aggregate citations) does not touch any file here and may run in either order.

**Prime directive: this is a decomposition and a re-registering, not a logic rewrite.** Every handler, effect, ref, fetch, guard, disabled expression, and error branch survives byte-for-byte in behaviour. The idempotency apparatus is the single most important constraint in the slice: `setupIntentKey`, `isCreateIntentKey`, `adoptCreateIdempotencyKey`, `readAuthorityEpoch`/`writeAuthorityEpoch`, `readPersistedCreateIdempotency`/`persistCreateIdempotency`, `authorityEpochRef`, `lastAuthRef`, `actionGenerationRef`, `createCompletedRef`, `intentKeyRef`, `createIdempotencyKeyRef`, `applySaveIfCurrent`, and `handleSaveStudy`'s complete `classification.outcome` ladder — including the `window.confirm` path at `:770–776`, the repair-pending 202 path at `:749–757`, the two idempotency error codes at `:780–787`, the four-branch 503 message at `:788–797`, and the `finally` ticket check at `:808–812` — move file position and nothing else. `handlePreview`, `handleGenerateLink`, `handleCopyLink`, `requireResearcherAuth`, `requireConfiguredProvider`, `requireValidModel`, `loadExampleStudy`'s call site, and all seven `useEffect`s with their exact dependency arrays and their **exact current order** are equally frozen. If a change is not named below, do not make it.

## M1. Laws that bind this slice

- **Effect order is preserved exactly.** Today's seven effects run in this order: savedStudyId sync (`:221`), auth check (`:232`), config status (`:246`), prefill hydration (`:300`), intent key (`:356`), authority epoch (`:403`), studyConfig sync (`:425`). All seven stay in `StudySetup.tsx`, in that order, with their dependency arrays unchanged. **`useStudyDraft` declares no `useEffect`** — it owns state, mutators, and `buildConfig`, and exports callbacks the container's effects call. Moving effect 7 into a hook called at the top of the component would silently make it run before the prefill effect and invert which one wins on mount; that is the class of regression this slice exists to prevent.
- **Tokens only.** `bg-paper-*`, `text-ink-*`, `border-ink-*`, `text-action`, `text-success`, `text-error`. `eslint.config.mjs:6–43` enforces this on all of `src/**` with no allowlist. `src/components/studySetup/**` is ordinary component code, not a primitive directory: it may not use raw `font-serif`, `var(--evidence)`, or `var(--disclosure)`. The consent reading sheet gets its serif from the `Verbatim` primitive (M7).
- **Radius 0 for structure, `rounded` for controls.** The bordered card at `:928` dies (D7). Inputs, textareas, selects, and `Button` keep their radius.
- **Icons are `aria-hidden`, always.** The four `×` sites become `<Icon name="close" />` with the existing `aria-label` unchanged (M8). No other icon enters this file; in particular the Edit affordance is a word, not a chevron.
- **Reading measure applies to prose only (A2).** Section descriptions, the research question and description read views, and the consent sheet take `max-w-measure`. No element that contains a form control, and no question/topic/profile register row in either mode, may carry it.
- **Honesty copy is verbatim (§9).** Not one word changes in the participant-link sentence (`Share this opaque link with participants. Study settings and credentials are never embedded in the URL.`), the OpenRouter ZDR sentence, the custom-model hint (`Custom OpenRouter model; privacy and structured-output requirements still fail closed at request time.`), the OpenRouter slug help (`Use a provider/model slug of at most 200 characters. Automatic routing is not supported.`), the consent `Field` hint H11 added, the repair-pending body, and all four provider-unavailable branches including both `<code>` elements.
- **Light only.** No `dark:` variant, no `data-theme` read or write, no toggle.
- **No new dependency.** No `lucide-react`, no `framer-motion`.

## M2. `src/lib/studyDraftSession.ts` — the lifted session apparatus (C6, first half)

`StudySetup.tsx:45–117` is browser-session bookkeeping that has nothing to do with rendering a form: the storage keys, the UUID shape, the authority epoch, and the create-key adoption rule. It moves whole, with every function body byte-identical.

**Moves, unchanged:** `UUID_V4` (`:45`), `IDEM_STATE_STORAGE`, `AUTH_EPOCH_STORAGE` (`:46–47`), `PersistedCreateIdempotency` (`:49–53`), `canUseSessionStorage` (`:55–56`), `readAuthorityEpoch` (`:58–63`), `writeAuthorityEpoch` (`:65–68`), `readPersistedCreateIdempotency` (`:70–87`), `persistCreateIdempotency` (`:89–92`), `setupIntentKey` (`:94–98`), `isCreateIntentKey` (`:100–102`), `adoptCreateIdempotencyKey` (`:104–117`).

**Exported:** `UUID_V4`, `readAuthorityEpoch`, `writeAuthorityEpoch`, `persistCreateIdempotency`, `setupIntentKey`, `isCreateIntentKey`, `adoptCreateIdempotencyKey`, and the `PersistedCreateIdempotency` type. `canUseSessionStorage` and `readPersistedCreateIdempotency` stay module-private — `adoptCreateIdempotencyKey` is their only caller and keeping them private is what makes "one UUID v4 per create intent" a property of the module rather than a convention.

**The name.** Not `studyCreateIdempotency.ts`: `src/lib/createIdempotency.ts` already exists and is the *server's* create-idempotency mapping (AGENTS.md "Storage and tenancy"). Two modules a character apart, one client and one server, is a navigation trap. `studyDraftSession.ts` says what it is — the browser-session state a study draft carries between mounts.

**Do not** move `isProviderConfigured`, `PROVIDER_STATUS_FIELD`, `PROVIDER_ENV_NAME`, `ConfigStatus`, or `PROFILE_PRESETS` here. They are UI-facing and go to M4.

The extraction earns a direct unit test (M12), which the apparatus has never had: today every one of these functions is exercised only through a full component render.

## M3. `src/components/studySetup/useStudyDraft.ts` — the draft hook (C6, second half)

A new directory `src/components/studySetup/`, following `src/components/shell/`'s precedent for a component family with a private module surface.

### M3.1 What the hook owns

The twelve editable fields plus the two identity fields, their mutators, and `buildConfig`:

```ts
export interface StudyDraft {
  name: string; description: string; researchQuestion: string;
  coreQuestions: string[]; topicAreas: string[]; profileSchema: ProfileField[];
  aiBehavior: AIBehavior; aiProvider: AIProviderType; aiModel: string;
  enableReasoning: boolean | undefined; linkExpiration: LinkExpirationOption;
  consentText: string; researcherContact: string;

  savedStudyId: string | null;
  parentStudyInfo: { id: string; name: string } | null;
  isDirty: boolean;

  setName(value: string): void;            // every setter below also sets isDirty
  setDescription(value: string): void;
  setResearchQuestion(value: string): void;
  setResearcherContact(value: string): void;
  selectProvider(id: AIProviderType): void;  // provider + DEFAULT_MODEL_BY_PROVIDER reset
  setAiModel(value: string): void;
  setAiBehavior(value: AIBehavior): void;
  setEnableReasoning(value: boolean | undefined): void;
  setLinkExpiration(value: LinkExpirationOption): void;
  setConsentText(value: string): void;
  addQuestion(): void; removeQuestion(index: number): void;
  updateQuestion(index: number, value: string): void;
  addTopic(): void; removeTopic(index: number): void;
  updateTopic(index: number, value: string): void;
  addProfileField(preset?: ProfileField): void;
  removeProfileField(id: string): void;
  updateProfileField(id: string, updates: Partial<ProfileField>): void;
  toggleFieldRequired(id: string): void;

  setSavedStudyId(value: string | null): void;   // not dirtying
  setParentStudyInfo(value: { id: string; name: string } | null): void;
  setIsDirty(value: boolean): void;
  hydratePrefill(config: Partial<StudyConfig>): void;   // not dirtying
  syncFromStudyConfig(config: StudyConfig): void;       // not dirtying
  buildConfig(): StudyConfig;
}

export function useStudyDraft(studyConfig: StudyConfig | null): StudyDraft
```

Every `useState` initialiser at `:146–195` moves verbatim, including `studyConfig?.consentText ?? ''` (H11.2) and `DEFAULT_MODEL_BY_PROVIDER[studyConfig?.aiProvider || 'gemini']`. `researcherContact` initialises `studyConfig?.researcherContact ?? ''` (M9).

**The dirtying rule is the one behavioural consolidation.** Today `setIsDirty(true)` is repeated at twenty-three call sites inline in JSX; in the hook it lives once per mutator. Three of those mutators are conditional today and must stay conditional: `removeQuestion` only dirties inside `coreQuestions.length > 1` (`:445–450`), `removeTopic` inside `topicAreas.length > 1` (`:460–465`), and `addProfileField(preset)` only dirties when the preset is not already present (`:474–490`). Reproduce all three exactly.

**`selectProvider`** is the three statements at `:1172–1177` as one method: `setAiProvider(id)`, `setAiModel(DEFAULT_MODEL_BY_PROVIDER[id])`, `setIsDirty(true)`. It exists so the radio's `onChange` cannot drift from the model reset — the reset is what keeps a Claude study from carrying a Gemini model id.

**`hydratePrefill`** is the assignment block at `:308–323` verbatim (`if (config.name) setName(config.name)` and its eleven siblings, plus the `aiProvider`/`aiModel` else-if at `:315–320` and the `config.enableReasoning !== undefined` check at `:321`), extended with `if (config.researcherContact) setResearcherContact(config.researcherContact)`. It does **not** touch `isDirty`, `savedStudyId`, `parentStudyInfo`, or `sessionStorage` — all four stay in the container's effect, which owns `searchParams`.

**`syncFromStudyConfig`** is the assignment block at `:426–439` verbatim, extended with `setResearcherContact(config.researcherContact ?? '')`. It does not touch `isDirty`.

**`buildConfig`** is `:511–533` verbatim, with one addition (M9): `...(researcherContact.trim() ? { researcherContact: researcherContact.trim() } : {})`. The key must be **absent**, not empty-string, when the field is blank — the server validator requires content when the key is present.

### M3.2 What stays in `StudySetup.tsx`

`participantLink`, `isGeneratingLink`, `linkCopied`, `linkError`, `isAuthenticated`, `isPreviewLoading`, `isSaving`, `saveSuccess`, `saveError`, `savePending`, `configStatus`, `configStatusError`, the six refs and the four `initial*` computations at `:197–213`, all seven effects, all four handlers, `applySaveIfCurrent`, the three `require*` guards, and every derived value at `:541–552` and `:815–850`. The container calls `useStudyDraft(studyConfig)` on its first line so the hook's `useState` calls precede `:197`'s reads of `studyConfig?.id`, exactly as today.

## M4. `src/components/studySetup/` — the section components

Files, all new:

| file | contents |
|---|---|
| `useStudyDraft.ts` | M3 |
| `providerStatus.ts` | `ConfigStatus` (`:22–29`), `PROVIDER_STATUS_FIELD` (`:31–36`), `PROVIDER_ENV_NAME` (`:38–43`), `isProviderConfigured` (`:119–122`) — moved verbatim, shared by the container and `ProviderSection` |
| `Section.tsx` | the read/edit shell (M5) |
| `StudyDetailsSection.tsx` | name, research question, description, researcher contact |
| `ProfileFieldsSection.tsx` | `PROFILE_PRESETS` (`:125–131`), `availablePresets` (`:841–843`), quick-add, rows |
| `PromptListSection.tsx` | Core Questions **and** Topic Areas — one component, two label sets |
| `ProviderSection.tsx` | radios, model `Field`, OpenRouter custom input, reasoning `Field`, four status blocks |
| `InterviewStyleSection.tsx` | `behaviorOptions` (`:818–834`) and the radios |
| `LinkSettingsSection.tsx` | the expiration `Field` |
| `ConsentSection.tsx` | the textarea `Field` and the serif reading sheet (M7) |

Prop shape: every section takes `draft: StudyDraft`, `editing: boolean`, and `onEdit: () => void`. `ProviderSection` additionally takes `configStatus`, `configStatusError`, `isAuthenticated`, `selectedProviderConfigured`, `selectedModelValid`, `providerOptions`, `selectedProviderName`, `selectedProviderEnvName`, `selectedProviderModels`, `isCustomOpenRouterModel`, `onOpenSettings`, and `onOpenSelfHost` — all computed in the container and passed down, so the guard expressions the save/preview/link paths read stay in one place and stay byte-identical.

Passing the whole `draft` object means a keystroke in any field re-renders every section. That is exactly what happens today in one component; it is not a regression and it is not worth memoising. Do not add `React.memo`, `useMemo`, or `useCallback` anywhere in this slice — a performance change hidden inside a decomposition is unreviewable.

**The Participant Link block (`:1404–1456`) and the Submit block (`:1459–1478`) are not sections.** They have no read mode, no Edit control, and no index entry, and they stay in `StudySetup.tsx` exactly as they are. `Generate Participant Link`, `Login as Researcher`, `Preview Saved Study`, and both trailing explanation sentences keep their strings and their `disabled` expressions.

## M5. F1 — the revisable document

### M5.1 The card dies (D7)

`:927–928` today:

```tsx
<div className="lg:grid lg:grid-cols-[1fr_13rem] lg:items-start lg:gap-10">
  <div className="space-y-12 border border-ink-300 bg-paper-1 p-5 md:p-8">
```

becomes

```tsx
<div className="lg:grid lg:grid-cols-[1fr_13rem] lg:items-start lg:gap-10">
  <div className="space-y-12">
```

The grid wrapper survives. Sections are already separated by `<Rule />`; §4 is "rules over boxes" and the hairlines are the structure. Nothing else on the wrapper changes and the `<Rule />` between every pair of sections stays, including the conditional `{isValid && <Rule />}` at `:1456`.

### M5.2 The section index stays on the right — ruling on slice-E open question 3

`slice-E-spec.md` open question 3 asked whether the in-page index should move left to match the adopted direction's "left-nav'd sheets". **It stays right**, and the reason is structural rather than aesthetic: `ResearcherShell` renders a fixed `lg:w-60` rail on the left of every researcher route, so a left index puts two navigation columns side by side at 1024px and makes the form the third column of a page that has one subject. It also matches `WithMargin` (`ui/Page.tsx:22–31`), where the apparatus column is column three — the index is apparatus, and apparatus sits in the margin. No class changes; `:1481–1491` is untouched apart from taking its labels from the same `sections` array as today.

The index keeps its eight entries, keeps every label **exactly equal to the section's `<h2>` string**, and gains no scroll-spy, no `IntersectionObserver`, and no active state. It must keep resolving to eight ids that are all mounted at once in both document and edit mode — that is the assertion (M12) that fails loudly if someone later turns the index into a switcher.

### M5.3 Document mode and edit mode — the decision, and why

**Ship read-mode for saved studies and edit-mode for new studies.**

A new study has nothing to read: every section opens with its fields visible, exactly as today. A saved study opens as a document — each section renders a compact read view with an **Edit** control that reveals that section's fields. This is DIRECTION §7 verbatim ("sections readable at measure, per-section inline Edit, making `studyRevision` legible") and it is the honest register for the action involved: per AGENTS.md's invariant and `README.md:240`, saving an existing study advances its revision and invalidates the links and participant sessions issued for the previous one. An interface that opens twenty-five live inputs over a study with participants in flight invites an accidental revision bump; one that opens a document and asks you to choose a section does not.

The alternative — always-editable, with the Edit control dropped — was considered and rejected: it makes `studyRevision` a decoration rather than a consequence, and it leaves F1 with nothing but a rename.

**Derivation, stated precisely because three suites depend on it:**

```ts
const editStudyId = initialPrefill === 'edit' ? searchParams.get('studyId') : null;
const [documentMode, setDocumentMode] = useState(() => Boolean(existingServerId || editStudyId));
const [openSections, setOpenSections] = useState<string[]>([]);
const isEditing = (id: string) => !documentMode || openSections.includes(id);
const openSection = (id: string) => setOpenSections((open) => open.includes(id) ? open : [...open, id]);
```

`existingServerId` is the value already computed at `:198`. `initialPrefill` is already read at `:197`. Both are available synchronously on first render, which is why the initialiser is correct for the `?prefill=edit&studyId=…` entry from `StudyList.tsx:408` even though `savedStudyId` is not set until the prefill effect runs.

`documentMode` is set to `false` in exactly one place and never back to `true`: the existing savedStudyId-sync effect at `:221–229`, in its `else` branch (a null or `study-`-prefixed client id). That is the branch `loadExampleStudy` triggers, so **Load Example on a saved study reveals every section**, and `loadExampleStudy` itself stays `onClick={loadExampleStudy}` with no wrapper. Do not set `documentMode` anywhere else. In particular the repair-pending 202 path sets `savedStudyId` without navigating (`:749–757`); if `documentMode` tracked `savedStudyId` the form would collapse into read mode under a researcher who is mid-repair.

There is **no per-section Cancel.** The draft is one document with one Save; a per-section revert would need per-section snapshots and a second source of truth for every field. An opened section stays open until the page is left. Say so in the handback.

**Opening a section must not set `isDirty`.** `openSection` touches `openSections` only. If opening Edit dirtied the draft, the header's Save button would enable on a study nobody had changed, and a no-op save would advance the revision and invalidate live participant links. This is the one line of M5.3 that is a correctness constraint rather than a design one.

### M5.4 `Section.tsx`

```tsx
export interface SectionProps {
  id: string
  label: string            // equals the <h2> string and the index entry
  description?: string
  editing: boolean
  onEdit: () => void
  action?: ReactNode       // the section's own header control, rendered only when editing
  read: ReactNode
  children: ReactNode      // edit-mode body
}
```

Renders:

```tsx
<section id={id} className="space-y-4">
  <div className="flex items-center justify-between gap-3">
    <h2 className="font-sans text-[15px] font-semibold text-ink-900">{label}</h2>
    {editing ? action ?? null : (
      <button
        type="button"
        onClick={onEdit}
        className="min-h-11 font-sans text-[13px] font-medium text-action underline underline-offset-2"
      >
        Edit<span className="sr-only"> {label}</span>
      </button>
    )}
  </div>
  {description ? (
    <p className="max-w-measure font-sans text-[13px] leading-[20px] text-ink-500">{description}</p>
  ) : null}
  {editing ? children : read}
</section>
```

The accessible name of the Edit control is therefore `Edit Core Questions`, `Edit AI Provider`, and so on — unique per section, and matched by exact name in the rewritten suites. It is a word, not an icon: §6 admits icons for functional actions, and this action already has the shortest possible name.

The `<h2>` string, the `id`, and the description paragraph are copy-verbatim from today for all eight sections (`:946`, `:983`, `:988–990`, `:1067`, `:1072–1074`, `:1105`, `:1110–1112`, `:1142`, `:1143–1148`, `:1330`, `:1362`, `:1363–1365`). The one addition is `<h2>Consent Text</h2>`, which the section does not have today (E3.4 dropped it and let `Field`'s label carry the name). It comes back because the section now needs a heading row to hang the Edit control on. `Field label="Consent Text"` stays, so the string appears twice in the DOM: once naming the section, once naming the control. `getByLabelText('Consent Text')` still resolves uniquely because only the label labels a control; no test does `getByText('Consent Text')`.

The AI Provider description keeps its Gateway ternary (`:1145–1147`) and must therefore be passed as a `ReactNode`, not a `string` — widen `description` to `ReactNode`.

### M5.5 Read views, section by section

Read views are prose or ruled registers, never boxes, and follow A2: **prose takes measure, lists do not.**

| section | read view |
|---|---|
| `study-details` | study name at `font-sans text-[15px] font-medium text-ink-900`; research question at `max-w-measure font-sans text-[15px] leading-[24px] text-ink-700`; description at `max-w-measure … text-ink-500`, omitted when blank; researcher contact as `<Coordinate className="block">`, omitted when blank |
| `profile-fields` | a ruled register: one `border-b border-ink-300 py-3` row per field, label at 15px, `extractionHint` at 13px `text-ink-500`, and the `REQ`/`OPT` `Coordinate` chip in its current classes but as a `<span>`, not a button. Empty → `No profile fields.` at `text-[13px] text-ink-500` |
| `core-questions` / `topic-areas` | `<ol>` of the non-blank items (the same `.trim()` filter `buildConfig` applies), each row `flex items-start gap-2` with `<Coordinate className="w-6 pt-0.5 text-right">{n}.</Coordinate>` and the text at `max-w-measure font-sans text-[15px] leading-[24px] text-ink-700`. Empty → `No questions yet.` / `No topic areas yet.` |
| `ai-provider` | `<Coordinate className="block">{selectedProviderName} · {aiModel}</Coordinate>`, plus a second `Coordinate` line `reasoning: automatic / more thinking / minimize thinking` **only** under the same condition the control renders (`aiProvider === 'gemini' && configStatus?.aiTransport !== 'gateway'`), plus **all four status blocks, unconditionally in both modes** (M5.6) |
| `ai-interview-style` | the selected `behaviorOptions` entry: `label` at 15px medium, `desc` at 13px `text-ink-500` |
| `link-settings` | `<Coordinate className="block">` carrying the selected `<option>`'s text (`Never expire`, `Expire after 7 days`, `Expire after 30 days`, `Expire after 90 days`) |
| `consent-text` | the serif reading sheet (M7) and nothing else |

Five new strings enter the product, all read-mode empties and all plain: `No profile fields.`, `No questions yet.`, `No topic areas yet.`, and the two `reasoning:` prefixes. Nothing else is new copy. The existing edit-mode empty line (`No profile fields yet. Add some above to gather participant information.`) stays verbatim in edit mode, where "above" is true.

### M5.6 The provider status blocks render in both modes

The four blocks at `:1150–1157` (no provider configured), `:1275–1283` (`role="alert"`, invalid model), `:1285–1289` (`role="status"`, checking), and `:1291–1324` (`role="alert"`, provider unavailable) are **not** editing affordances. They are the fail-closed signal that this study cannot be saved, previewed, or linked, and they carry the two follow-up controls (`Account & connections`, `Open self-host setup guide`) a researcher needs in order to fix it. Hiding them behind an Edit click would put a security-relevant state one interaction away from a researcher who has no reason to click. They render inside `ProviderSection` outside the `editing` branch, with their conditions, roles, headings, bodies, `<code>` elements, and button labels byte-identical.

This is also what keeps `StudySetup.auth.test.tsx:145`, `:153–154`, `:178–184`, `:188–189`, and `:199` passing with no rewrite in the saved-study case.

## M6. `studyRevision`, made legible

### M6.1 Where the number comes from

`revision` lives on `StoredStudy` (`src/types.ts:321`), not on `StudyConfig` — it is server-owned, monotonic, and advanced inside `replaceStudyConfigAtomic` (`kv.ts:1216`, `:1258`). `StudySetup` never sees it today. Two sources, both needed:

1. **On mount, when the study is already saved.** A new effect, placed **last** (after the studyConfig sync at `:425`, so the seven existing effects keep their order and their relative position):

   ```ts
   useEffect(() => {
     if (!savedStudyId) { setStudyRevision(null); return; }
     let cancelled = false;
     void (async () => {
       try {
         const res = await fetch(`/api/studies/${savedStudyId}`);
         if (!res.ok) return;
         const data = await res.json();
         const revision = data?.study?.revision;
         if (!cancelled && Number.isSafeInteger(revision) && revision >= 1) setStudyRevision(revision);
       } catch { /* display only: never surface, never block */ }
     })();
     return () => { cancelled = true; };
   }, [savedStudyId]);
   ```

   `GET /api/studies/[id]` (`route.ts:41–79`) is the same endpoint `handlePreview` already calls at `:581`. The request is **display-only and fail-silent**: it must never call `setSaveError`, `setLinkError`, `setIsAuthenticated`, or `router.push`, and a 401/404/503 leaves `studyRevision` null. A study whose revision cannot be read is still fully editable — the server, not this line, is the authority on what a save may do.

2. **After a save.** `handleSaveStudy`'s success and pending-create branches already receive `classification.body.study`. Widen that type in `src/lib/studyMutationClassification.ts:11` from `study?: { id: string; config?: unknown }` to `study?: { id: string; config?: unknown; revision?: number }`, and in both branches add `if (Number.isSafeInteger(study.revision)) setStudyRevision(study.revision)` next to the existing `setSavedStudyId(study.id)`. No classification logic changes; the widened field is optional and every existing narrowing still holds.

### M6.2 What it renders

A standing fact block under the header, rendered only when `documentMode` — a new study has no revision to speak of. Standing explanation is a fact block, not a `Notice` (slice-E E2's precedent, which Slice H preserved):

```tsx
{documentMode && (
  <div className="mb-6 bg-paper-2 px-4 py-3">
    <Label>Revision</Label>
    {studyRevision === null ? null : (
      <Coordinate className="mt-1 block">Study revision {studyRevision}</Coordinate>
    )}
    <p className="mt-2 max-w-measure font-sans text-[13px] leading-[20px] text-ink-700">
      Editing a study advances its revision and invalidates links and participant sessions issued
      for the previous revision. Generate and distribute a new link after a consequential edit.
    </p>
  </div>
)}
```

The two sentences are `README.md:240` **verbatim**, so the interface and the operator documentation cannot drift; the same rule is AGENTS.md's invariant "Editing a study advances its revision and invalidates older participant authority" and `StudyDetail.tsx:751`'s `Replaced by study edit` link status. `Study revision 4` is mono because it is a machine-verifiable fact (§3 conventions), matching `StudyDetail.tsx:777`'s existing `Study revision {link.studyRevision}` line.

**When the revision is unknown the line is omitted, not filled with a dash.** `SynthesisReading.tsx:304` prints `study rev ${studyRevision ?? '—'}` because a provenance footer has a fixed shape; here there is no shape to preserve, and D1/D2 are the standing lesson that a placeholder in a fact position reads as a fact. Slice K's receipt already omits rows it cannot fill; do the same.

## M7. Consent text as a serif reading sheet

The authored consent text is the one string in this form that a participant reads as a document, and DIRECTION §3's first law makes serif the register for consent text specifically. `ConsentSection` renders the sheet in **both** modes, below the textarea in edit mode and alone in read mode:

```tsx
<div className="bg-paper-2 p-4">
  <Label>What participants will read</Label>
  <Verbatim className="mt-2 max-w-measure whitespace-pre-wrap text-[17px] leading-[28px] text-ink-700">
    {consentText.trim() || defaultConsentText(researchQuestion)}
  </Verbatim>
</div>
```

Three decisions in that block:

- **Below, not beside.** At 1280px the form column is roughly 700px wide once the shell's 240px rail, the page inset, and the 13rem section index are subtracted; splitting it gives two 330px columns, and the reading measure is 34rem. A cramped side-by-side would make the sheet unreadable on the one surface whose whole purpose is readability, and §11 requires marginalia layouts to be designed mobile-first. Below, at measure, is the same block at every width.
- **A blank field previews the generated default.** `defaultConsentText(researchQuestion)` is exactly what `buildConfig` will store (H11.2), so the sheet shows the researcher the text their participants will actually sign before they save it. This is what makes H11's hint (`Leave blank to generate this from your research question when you save.`) checkable instead of a promise.
- **`Verbatim`, not a raw `font-serif` class.** The design law is lint-scoped to `src/components/ui/`; `src/components/studySetup/` is not a primitive directory.

`whitespace-pre-wrap` and the 17/28 sizing match `Consent.tsx:93–95`, which is the surface this is previewing. The textarea, its `value`, `onChange`, `rows={4}`, and H11's `hint` are unchanged.

## M8. D6 and D7's remaining StudySetup sites

### M8.1 The four `×` controls become `Icon` (D6)

| site | control | change |
|---|---|---|
| `:903–909` | save-error dismiss | child `×` → `<Icon name="close" />`; keep `onClick={() => setSaveError(null)}` and `aria-label="Dismiss save error"`; add `min-h-11 min-w-11 inline-flex items-center justify-center` to the existing classes |
| `:1042–1049` | remove profile field | child `×` → `<Icon name="close" />`; keep `aria-label={\`Remove ${field.label \|\| 'profile field'}\`}`; replace `p-1.5` with `min-h-11 min-w-11 inline-flex items-center justify-center` |
| `:1086–1095` | remove question | child `×` → `<Icon name="close" />`; keep `aria-label={\`Remove question ${i + 1}\`}` and the `coreQuestions.length > 1` gate; classes keep `min-h-11`, add `min-w-11 inline-flex items-center justify-center` |
| `:1124–1133` | remove topic | as above with `Remove topic ${i + 1}` and the `topicAreas.length > 1` gate |

The 44px target follows H8's `StudyList` dismiss precedent — a 16px mark needs it at 375px. Because `Icon` is `aria-hidden`, all four accessible names are unchanged, which is what keeps `StudySetup.auth.test.tsx:297–299` passing untouched.

### M8.2 Seven notice blocks become `Notice` (C3)

The brief's D7 row says six; there are **seven**, and the seventh is the one H11 did not create. Report the count in the handback. Every conversion must render byte-identical classes.

| site | today | becomes |
|---|---|---|
| `:897–911` | save error, `border-l-2 border-error`, flex row with dismiss | `<Notice tone="error" className="mb-6 flex items-start justify-between gap-3">`, children unchanged (the inner `<div>` with its own `<Label>Save Failed</Label>` plus the dismiss button) — no `eyebrow` prop, following H9's `StudyDetail.tsx:796` precedent for flex notices |
| `:913–925` | save pending, `border-l-2 border-error`, flex row with `My Studies` | `<Notice tone="error" className="mb-6 flex items-start justify-between gap-3">`, children unchanged |
| `:929–942` | follow-up, `border-l-2 border-ink-500` | `<Notice tone="neutral" eyebrow="Follow-up Study">` wrapping the existing `<p className="mt-1 text-[13px] text-ink-700">` |
| `:1150–1157` | no provider configured | `<Notice tone="error" eyebrow="No provider configured">` wrapping the existing `<p className="mt-1 …">` |
| `:1275–1283` | invalid model | `<Notice tone="error" role="alert">` wrapping the existing `<p className="text-[13px] text-ink-700">` |
| `:1285–1289` | checking providers | `<Notice tone="neutral" role="status">` wrapping the existing `<p>` |
| `:1291–1324` | provider unavailable | `<Notice tone="error" role="alert">`, children unchanged (the `<h4>`, the four-branch `<p>` with both `<code>` elements, and the two conditional buttons) — no `eyebrow`, because the block's name is an `<h4>` and a `Label` would change its heading structure |

`Notice` spreads `...props` onto its root div, so `role="alert"` and `role="status"` pass through and land on exactly the elements that carry them today. Do not add a `role` to any block that lacks one, and do not add a second `role="alert"` anywhere: `StudySetup.auth.test.tsx:278` and `:282` call `getByRole('alert')` in the singular.

**Not notices, leave both:** the provider radio `<label>` at `:1161–1167` and the behaviour radio `<label>` at `:1335–1341` both use `border-l-2` as the selectable-row idiom (E3.6). They match the grep and are not status blocks.

## M9. `researcherContact` on `StudyConfig` — included, and the whole path

**Decision: include it.** Three reasons. `Consent.tsx:126–132` already tells every participant "Contact the researcher for retention, access, and deletion details" and the product gives them no contact — that is a live honesty gap, not a feature request. Slice K's receipt (`Synthesis.tsx`, participant branch) omits rows whose value is missing, so the receipt row is four lines. And the brief routed the field here explicitly (A2, and `slice-K-spec.md:341,572`); no later slice owns StudySetup, so excluding it strands the gap indefinitely.

Five files.

### M9.1 `src/types.ts`

After `consentText: string;` (`src/types.ts:133`):

```ts
  /**
   * Optional. Shown to participants on their submission receipt so they can
   * reach the study's data controller. Free text — a name, an address, a lab
   * page — and deliberately not format-validated: the server cannot verify a
   * contact, so it must never be presented as verified.
   */
  researcherContact?: string;
```

### M9.2 `src/lib/studyConfigValidation.ts`

- `MAX_RESEARCHER_CONTACT_LENGTH = 200`, beside the other bounds.
- `'researcherContact'` added to `STUDY_CONFIG_FIELDS` (`:28–46`).
- In `validateStudyConfig`, with the other optional-field checks (after the `generatedFrom` check at `:191–195`):

  ```ts
  if (value.researcherContact !== undefined
    && !isBoundedString(value.researcherContact, MAX_RESEARCHER_CONTACT_LENGTH, true)) {
    return { ok: false, error: 'Researcher contact must be 200 characters or fewer' };
  }
  ```

**This one goes in `validateStudyConfig` itself, unlike H11.3's bracket rule, and the difference matters.** The bracket rule is an authoring policy that would fail closed on studies stored before it existed, which is why H11.3 confined it to the two write-path wrappers. This is a bound on an optional field: every study already stored omits the key, so the check is vacuously true on the entire read path (`canonicalStudy.ts:42`, `researcherContext.ts:632,730`, `generate-link/route.ts:84`) and no participant can lose access to a study they consented to. Putting it in the shared validator is what makes the bound an invariant of canonical shape rather than a rule the next write path can forget.

No API route changes: `POST /api/studies` (`studies/route.ts:172`) and `PUT /api/studies/[id]` (`[id]/route.ts:154`) both reach the field through the wrappers, and `readStudyMutationBody`'s allowed set is `config`/`confirmed`/`linksEnabled`, unchanged.

### M9.3 `src/app/api/studies/[id]/generate-followup/route.ts`

One line in `followUpConfig` (`:158–175`), beside `consentText`: `researcherContact: parentStudy.config.researcherContact,`. A follow-up is the same researcher; dropping the contact silently would be a defect the researcher cannot see.

### M9.4 `src/components/studySetup/StudyDetailsSection.tsx`

After the Description field:

```tsx
<Field
  label="Researcher Contact (optional)"
  htmlFor="study-researcher-contact"
  hint="Shown to participants on their submission receipt — how to reach you about retention, access, or deletion."
>
  <input
    type="text"
    value={draft.researcherContact}
    onChange={(e) => draft.setResearcherContact(e.target.value)}
    placeholder="e.g., Dr. Amara Osei · research@university.edu"
    maxLength={200}
    className="w-full"
  />
</Field>
```

`maxLength={200}` matches the server bound. It sits in **Study Details, not Consent Text**, deliberately: `hashConsentText` (`participantConsent.ts:43–44`) binds the consent record to `consentText` alone, and placing the contact inside the consent section would suggest it is part of the signed document when it is not.

### M9.5 `src/components/Synthesis.tsx` — the receipt row

In the participant branch's `receiptFacts` (`:206–213`), after `Consent accepted`:

```ts
...(studyConfig.researcherContact
  ? [{ term: 'Researcher contact', value: studyConfig.researcherContact, mono: false }]
  : []),
```

and give the fact objects an optional `mono?: boolean` (default true) that selects the `<dd>` rendering at `:233`: `mono !== false ? <Coordinate className="text-[13px] text-ink-700">{value}</Coordinate> : <span className="font-sans text-[13px] text-ink-700">{value}</span>`. A turn count and a UTC timestamp are machine-verifiable facts; a person's name and address are not, and §3's mono convention is for the former. The three existing rows keep `Coordinate` and their exact strings.

## M10. Section vocabulary — ruling: no renames

`slice-E-spec.md` §E1 deferred "renaming sections to the adopted five-section vocabulary (`Study Details` → `Basics`, and so on)" to this slice. **Not adopted.** The five-sheet list (`Basics · Research question & topic guide · Profile schema · AI provider · Consent text`) appears in E1 as a description of a proposal sketch, never as a decision of record: DIRECTION §7 asks only for "sections readable at measure, per-section inline Edit, making `studyRevision` legible", and `initiative-3-brief.md`'s C6 enumerates the component decomposition as seven section components over today's eight headings, not five. Collapsing to five would fold Link Settings — participant-access policy, including expiry — under an AI-provider heading, and would merge Core Questions and Topic Areas into one heading when C6 explicitly asks for one *component* with two labels. Renaming `Study Details` to `Basics` on its own buys nothing and costs the index-label/heading identity rule that E3.2 established and M5.2 keeps.

All eight `<h2>` strings, all eight section ids, and all eight index labels are unchanged.

## M11. Verbatim inventory — the strings and queries other suites depend on

Every one of these must survive this slice unchanged. The e2e spec (`tests/e2e/research-workflow.spec.ts`) creates a study through this form and is the gate that catches a silent rename:

| where | what | used by |
|---|---|---|
| `Field label="Study Name *"` | exact label | `research-workflow.spec.ts:12` (`getByLabel`, exact) |
| `Field label="Research Question *"` | exact label | `research-workflow.spec.ts:13` |
| placeholder `Question 1...` (`Question ${i + 1}...`) | exact placeholder | `research-workflow.spec.ts:14`, `StudySetup.document.test.tsx:99` |
| placeholder `e.g., AI Adoption in Healthcare` | exact placeholder | auth, idempotency, recovery suites |
| placeholder `What are you trying to understand?` | exact placeholder | auth, idempotency, recovery suites |
| placeholder `Field label (e.g., Current Role)` | exact placeholder | `StudySetup.document.test.tsx:92` |
| radio names resolved from the wrapping `<label>` text | `Google Gemini`, `Anthropic Claude`, `^OpenAI`, `OpenRouter` | `research-workflow.spec.ts:15`, `StudySetup.auth.test.tsx:156,176,187,209–219,240–243,259–263,273` |
| button `Save Study` / `Update Study` / `Saved` / `Repair pending` / `Saving...` / `Saved!` | the full label ternary at `:879`, character for character | `research-workflow.spec.ts:16`, all three unit suites |
| exactly two buttons matching `/preview/i` | header `Preview` + footer `Preview Saved Study` | `StudySetup.auth.test.tsx:147` |
| button `Preview` (exact) | header action | `research-workflow.spec.ts:119` |
| buttons `Add Question`, `Add Topic`, `Add Custom`, `+ {preset.label}` | exact | `StudySetup.auth.test.tsx:293–295`, `document.test.tsx:91` |
| `Remove question 2`, `Remove topic 2`, `Remove Current Role` | exact `aria-label`s | `StudySetup.auth.test.tsx:297–299` |
| `getByLabelText('Model')`, `('AI Reasoning Mode')`, `('OpenRouter model ID')` | exact | `StudySetup.auth.test.tsx:213–220,274–276` |
| `Generate Participant Link`, `Login required to generate participant links.`, `Account & connections`, `Open self-host setup guide` | exact | `StudySetup.auth.test.tsx:122,151,153,183` |
| `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `npm run setup:check` as standalone `<code>` text nodes | exact `getByText` | `StudySetup.auth.test.tsx:179,180,189` |
| `Google Gemini is not available`, `Anthropic Claude is not available`, `OpenRouter is not available`, `Provider availability could not be verified` | exact | `StudySetup.auth.test.tsx:145,158,178,188,199` |
| `Study saved; repair pending`, `/already used with a different study/i`, `Follow-up Study`, `Save Failed` | exact | idempotency and recovery suites |
| `Checking configured AI providers…` | exact (the ellipsis is one character) | every suite's `readyToSave` gate |
| the ZDR sentence | exact | `StudySetup.auth.test.tsx:221` |

`research-workflow.spec.ts:118–119` visits `/setup` after a study has been saved, so it renders in **document mode** — `studyConfig` is persisted to `sessionStorage` (`store.ts:361–362`) and carries a server UUID. The header action row is outside every section, so `Preview` resolves and the step passes unchanged. Confirm this by running the suite, not by reasoning about it.

## M12. Tests

### Must keep passing, unchanged

- **`tests/unit/StudySetup.auth.test.tsx`** — eight of the nine cases. `:116–124` (login-required block), `:163–190` (standalone guidance, both `<code>` nodes, the self-host push, the `/Vercel dashboard|github\.com/` absence at `:185`), `:192–201` (fail-closed on 503), `:203–222` (four providers, model reset, reasoning control, ZDR sentence), `:224–246` (Gateway filtering and `setAiTransport`), `:248–265` (hosted filtering), `:267–288` (custom OpenRouter, `maxLength`, the singular `role="alert"`, the Save gate), and `:290–300` (the three removal `aria-label`s) all seed `studyConfig: null` and therefore render in edit mode exactly as today.
- **`tests/unit/StudySetup.idempotency.test.tsx`** — six of the seven cases: `:157–187` (one POST, UUID v4 `Idempotency-Key`, reuse after 202, `config.id` absent), `:189–207` (key restored across remounts), `:209–246` (a new key per follow-up intent), `:271–307` (stale response ignored, distinct keys), `:309–321` (reuse/consumed surface as errors), `:323–350` (the `saveStudy` unit). All create-intent; all edit mode. **If any of these breaks, the decomposition touched the apparatus and the fix is in the source, not the test.**
- **`tests/unit/StudyOperationRecovery.ui.test.tsx:78–128`** — the create-202 repair-pending path. `storeMock.state.studyConfig` is null, so this renders in edit mode; it is the direct guard that the 202 branch still sets `savedStudyId`, still calls `setStudyConfig`, still shows `Study saved; repair pending` and the `Repair pending` button, and still does not navigate. Its `fetchMock` throws on any unexpected path, which is also the guard that M6.1's revision fetch does not fire for an unsaved study.
- **`tests/unit/StudySetup.document.test.tsx:69–81`** (the eight-section index, all mounted at once) and `:88–105` (no reading measure on register rows).
- **`tests/unit/studyConfigValidation.test.ts`** in full, including `:23–34` (unknown top-level and nested fields — both use an invented `injected` key, unaffected by a new allowed field), `:148–167` (partial-edit merge), and the consent-placeholder block at `:170+`.
- **`tests/unit/api.study.configValidation.test.ts`** `:80–89` (unknown create fields rejected before any persistence write) and the rest of the file.
- **`tests/unit/canonicalStudy.validation.test.ts`** — the read path is untouched; `researcherContact` is optional and absent from every fixture.
- **`tests/unit/Synthesis.register.test.tsx`** and Slice K's receipt suite — `makeStudyConfig()` sets no `researcherContact`, so the row is omitted and the receipt renders exactly three facts as today.
- **`tests/e2e/research-workflow.spec.ts`** in full, especially `:12–17` and `:118–119` (M11).

### Rewritten by this slice, and why

E1 said F1 "owns rewriting the three suites that pin the all-mounted shape". In practice the read/edit split touches **two cases in two suites**, because every other case renders a new study. Keep the rewrites this small; a large diff across the idempotency suite is a sign the mode derivation is wrong.

1. **`tests/unit/StudySetup.auth.test.tsx:126–161`** — `blocks a hosted Claude-only account from saving or publishing the default Gemini study`. It seeds a saved study (a UUID `id`), so it now opens in document mode. **One line is added** before `:156`:

   ```ts
   fireEvent.click(screen.getByRole('button', { name: 'Edit AI Provider' }));
   ```

   Everything before it is unchanged and is the direct proof of M5.6: `Google Gemini is not available` (`:145`), the disabled `Saved` button (`:146`), both disabled `/preview/i` buttons (`:147–150`), the disabled `Generate Participant Link` (`:151`), and the `Account & connections` push (`:153–154`) all resolve in **read mode**, with no Edit click. Add one assertion after the render, before `:145`: the `Edit AI Provider` control exists and the provider radios are **not** in the document — that is what pins document mode as the default for a saved study.

2. **`tests/unit/StudySetup.idempotency.test.tsx:248–269`** — `never sends Idempotency-Key on edit PUT`. Two changes:
   - The seeded study opens in document mode, so add `fireEvent.click(screen.getByRole('button', { name: 'Edit Study Details' }))` before the `fireEvent.change` at `:259`.
   - M6.1's revision fetch issues a `GET /api/studies/<id>` on mount, which the shared mock currently records into `fetchMock.posts` (`:123–132`), breaking `expect(fetchMock.posts).toHaveLength(1)`. Change the mock to record mutations only — `if (method !== 'GET') fetchMock.posts.push(...)` — and keep returning `jsonResponse(fetchMock.createStatus, fetchMock.createBody)` for the GET. This is a fixture correction, not a weakened assertion: the file's subject is which mutation went out with which header, and every existing assertion about method, URL, header, body, and `crypto.randomUUID` call count survives verbatim, including `:268`'s `expect(crypto.randomUUID).not.toHaveBeenCalled()`.

3. **`tests/unit/StudySetup.document.test.tsx:83–86`** — `carries no decorative icons`, `container.querySelectorAll('svg')` length 0. M8.1 puts `Icon` in four functional controls, so the count assertion is now wrong about the rule it was protecting. **The rule is §6's, and it is "no decorative icons", not "no icons".** Rewrite as: every `<svg>` in the document has a `<button>` ancestor, carries `aria-hidden="true"`, and carries no `role`, `title`, or `aria-label` of its own; and no `<h2>` or `<section>` contains a direct `<svg>` child. Then drive the four sites: add a profile field, add a question, add a topic, and assert each remove control's accessible name is unchanged and contains exactly one `aria-hidden` `svg`. This assertion is strictly stronger than the count — it survives the next functional icon and still fails on a decorative one.

### New, smallest realistic regressions

- **`tests/unit/studyDraftSession.test.ts`** — the apparatus, tested directly for the first time: `setupIntentKey` returns `edit:<id>` / `followup:<parent>` / `followup` / `create` for the four input shapes; `isCreateIntentKey` accepts `create` and every `followup*` and rejects `edit:*`; `adoptCreateIdempotencyKey` returns the persisted key when `intentKey` and `authorityEpoch` both match, mints a new one when either differs, and mints a new one when the stored key fails `UUID_V4`; `readAuthorityEpoch` returns 0 for absent, non-numeric, negative, and non-safe-integer values; `writeAuthorityEpoch`/`readAuthorityEpoch` round-trip; a corrupt `IDEM_STATE_STORAGE` value does not throw.
- **Extend `tests/unit/StudySetup.document.test.tsx`** with a document-mode describe block, seeding a saved study (a UUID `id`, as `StudySetup.auth.test.tsx:136–141` does):
  - all eight section ids are present and the index still resolves to all eight, exactly as in edit mode — the switcher guard, now in both modes;
  - each of the eight sections exposes exactly one control named `Edit <section label>`, and no section renders a form control before its Edit control is clicked (assert on `study-details`, `core-questions`, and `link-settings`);
  - clicking `Edit Core Questions` reveals `Question 1...` and leaves `study-details` in read mode — the sections are independent;
  - clicking `Edit Study Details` does **not** enable the `Saved` button (`isDirty` is untouched by opening a section) — the correctness assertion from M5.3;
  - the read view renders each core question inside an element carrying `max-w-measure`, and no ancestor of a profile-field read row carries it — A2 in both directions;
  - `Study revision 3` renders in mono when `GET /api/studies/<id>` resolves with `{ study: { revision: 3 } }`, the two README sentences render verbatim, and when the same GET returns 503 **no** `Study revision` text appears, no error notice appears, and the form is still editable;
  - a new study (`studyConfig: null`) renders no `Study revision` block and no `Edit` control at all.
- **`tests/unit/StudySetup.consentSheet.test.tsx`** — with a blank consent field and a research question filled in, the sheet renders `defaultConsentText(researchQuestion)` and contains no `[`; typing into the textarea replaces the sheet's text; the sheet element carries the serif class the `Verbatim` primitive applies and `whitespace-pre-wrap`.
- **Extend `tests/unit/studyConfigValidation.test.ts`** — a config with `researcherContact: 'Dr. Amara Osei · research@university.edu'` validates; a 201-character value is rejected; `researcherContact: ''` is rejected; **a config with no `researcherContact` key validates on all three of `validateStudyConfig`, `validateStudyConfigForCreate`, and `validateStudyConfigUpdate`** — that last one is the assertion that documents why this bound, unlike the bracket rule, belongs in the shared validator.
- **Extend Slice K's receipt suite** — a study config with `researcherContact` renders a `Researcher contact` row whose value is not in mono; a config without it renders no such row and the receipt still shows three facts.
- **`tests/unit/StudySetup.notices.test.tsx`** — in the 503 config-status state, the provider-unavailable block is the document's only `role="alert"`, renders `border-l-2 border-error bg-paper-2 px-4 py-3`, and still contains the `Open self-host setup guide` control; in the checking state the block carries `role="status"`; the follow-up block (driven by a `prefill=followup` prefill) carries neither role.

Do not snapshot any component in this slice.

## M13. Verification

Focused gates first, per the AGENTS.md change map. This slice is on the **Researcher UI** row, and M9 puts it on **Auth/participant authority** as well (it changes `types.ts` and `studyConfigValidation.ts`) and touches the **Completion and export** row through `Synthesis.tsx`:

```bash
# StudySetup itself and the three suites that pin its shape
npx vitest run tests/unit/StudySetup.auth.test.tsx tests/unit/StudySetup.document.test.tsx \
  tests/unit/StudySetup.idempotency.test.tsx tests/unit/StudySetup.notices.test.tsx \
  tests/unit/StudySetup.consentSheet.test.tsx tests/unit/studyDraftSession.test.ts \
  tests/unit/StudyOperationRecovery.ui.test.tsx

# Study mutation, validation, and the read path M9 must not disturb
npx vitest run tests/unit/studyConfigValidation.test.ts tests/unit/api.study.configValidation.test.ts \
  tests/unit/api.study.createIdempotency.test.ts tests/unit/canonicalStudy.validation.test.ts \
  tests/unit/consentText.test.ts

# The receipt row
npx vitest run tests/unit/Synthesis.register.test.tsx
```

Then the proportional full gate — a type change plus a validator change crosses a trust boundary, and the e2e suite creates a study through this exact form:

```bash
npm run check
npm run test:e2e
```

Then the greps, each of which must return no output except where noted:

```bash
grep -rn "lucide-react\|framer-motion" src/                          # no dependency was re-added
grep -c "" src/components/StudySetup.tsx                             # well under 600; report the number
grep -rn "border-l-2" src/components/StudySetup.tsx src/components/studySetup/
                                                                     # only the two radio-row idioms
grep -rn "setIsDirty" src/components/studySetup/*.tsx                # none: dirtying lives in the hook
grep -rn "font-serif" src/components/studySetup/                     # none: the sheet uses Verbatim
grep -rn "useEffect" src/components/studySetup/                      # none: M1's effect-order law
```

Then by hand, at **375px** and 1280px:

- **`/setup` (new study)** — every section open, no Edit control, no revision block, no card outline. The eight sections are separated by hairlines on `bg-paper-0`. The consent sheet previews the generated default as soon as the research question is filled; typing in the textarea replaces it. Save with the consent field blank, then reopen the study and confirm the stored text is the template.
- **`/setup?prefill=edit&studyId=<id>` from `/studies` → Actions → Edit & Generate Link** — the document opens in read mode, `Study revision N` renders in mono under the header with both README sentences beneath it, and every section shows an Edit control. Open one section; confirm the Save button stays disabled until a field actually changes. Change a field, save, and confirm the revision advances and `/studies/<id>` → Study settings shows the older link as `Replaced by study edit`.
- **A study with a misconfigured provider, in read mode** — the provider-unavailable alert is visible without clicking Edit, and its `Account & connections` / `Open self-host setup guide` control still navigates.
- **`Load Example` on a saved study** — every section reveals itself and the revision block disappears.
- **The four remove controls** — each is a close mark with a 44px target at 375px, and each still announces its full name in VoiceOver or the accessibility inspector.
- **The section index at 1024px and 1440px** — eight entries on the right, scrolling rather than switching, with the shell rail on the left and no third column of navigation.
- **375px** — no horizontal overflow on `/setup` in either mode; the consent sheet reads at full width; the index is absent and every section is still reachable.

Leave the dev server runnable for the orchestrator's screenshot pass.

## Hard constraints

- Files that may change: `src/lib/studyDraftSession.ts` (new), `src/components/studySetup/**` (new: `useStudyDraft.ts`, `providerStatus.ts`, `Section.tsx`, `StudyDetailsSection.tsx`, `ProfileFieldsSection.tsx`, `PromptListSection.tsx`, `ProviderSection.tsx`, `InterviewStyleSection.tsx`, `LinkSettingsSection.tsx`, `ConsentSection.tsx`), `src/components/StudySetup.tsx`, `src/lib/studyMutationClassification.ts` (M6.1's one optional field), `src/types.ts` (M9.1), `src/lib/studyConfigValidation.ts` (M9.2), `src/app/api/studies/[id]/generate-followup/route.ts` (M9.3, one line), `src/components/Synthesis.tsx` (M9.5, the participant receipt only), and the tests in M12. Nothing else.
- **The idempotency apparatus changes file position and nothing else.** No renamed function, no changed signature, no reordered statement inside `handleSaveStudy`, no altered `classification.outcome` branch, no touched `window.confirm` path, no new early return before `buildConfig()`. H11.2's bracket guard stays exactly where it is, inside the `try`, immediately after `const config = buildConfig();`.
- **All seven `useEffect`s stay in `StudySetup.tsx`, in their current order, with their current dependency arrays.** The revision effect (M6.1) is added as the eighth and last. `useStudyDraft` contains no `useEffect`.
- **`validateStudyConfig`'s existing checks are not modified.** M9.2 adds one optional-field check and one entry to `STUDY_CONFIG_FIELDS`; H11.3's placement of the bracket rule in the two write-path wrappers is untouched.
- **No change to `Synthesis.tsx` outside the participant branch's `receiptFacts` array and the `<dd>` rendering.** The researcher reading, `SynthesisReading`, the save/retry handlers, and every honesty string are Slice I's and K's and stay as they are.
- Do not edit any primitive in `src/components/ui/`. `Notice`, `Icon`, `Field`, `Button`, `Label`, `Rule`, `Coordinate`, `Verbatim`, `Tabs`, `ExternalLink`, and `Page` are frozen contracts. If a call site cannot express something through them, style around it in the section component and say so in the handback.
- Do not edit `eslint.config.mjs`, `tailwind.config.ts`, `src/app/globals.css`, `src/app/layout.tsx`, or `src/app/(researcher)/setup/page.tsx` (including its `SetupLoading` fallback). This slice needs no new token and no config change; if lint blocks a class, the class is wrong.
- Do not edit `src/components/StudyList.tsx`, `StudyDetail.tsx`, `Settings.tsx`, `Onboarding.tsx`, `Consent.tsx`, `InterviewChat.tsx`, `Export.tsx`, `Dashboard.tsx`, `InterviewDetail.tsx`, `providerSetup.tsx`, or anything in `src/components/shell/`.
- No `React.memo`, `useMemo`, or `useCallback` anywhere in this slice.
- No new dependency. No `data-theme` wiring, no theme toggle.
- Do not commit; leave the working tree for review. npm only (`package-lock.json` authoritative), Node ≥ 24.19.

## Deferred, do not attempt

- **Section switching or per-section routing.** The eight sections stay mounted simultaneously in both modes; the index scrolls. A URL-addressable section (`/setup#core-questions` as state) is a routing change with its own review.
- **Per-section Cancel / revert.** M5.3 explains why. If it is wanted later it needs a per-section snapshot of the draft and a decision about what "revert" means for a section a save has already partially consumed.
- **The five-section vocabulary.** Ruled out in M10, with reasons; reopening it is a decision of record, not a spec change.
- **Echoing `researcherContact` on the consent page.** `Consent.tsx:126–132` tells participants to contact the researcher and still gives them no address; the receipt (M9.5) covers the post-submission case, not the pre-consent one. `Consent.tsx` is not this slice's file and the change is participant-facing copy inside a consent document, so it belongs in its own slice with the participant gates. Recommend it as the next small participant slice.
- **Format-validating `researcherContact`.** Deliberately free text (M9.1). An email regex would reject a lab page and would imply a verification the server never performs.
- **Showing `interviewCount` or `isLocked` in the revision block.** The mount GET returns both; the soft-lock warning already reaches the researcher through `handleSaveStudy`'s `confirm-required` ladder, and adding a second, unsynchronised copy of that fact to the header would create two places for it to be wrong.
- **Persisting aggregate synthesis, night theme, participant transcript download, typeset export, the `WithMargin` unfold (B4).** Unchanged from the brief.
- **Deduplicating `UUID_V4`** between `studyDraftSession.ts` and `services/storageService.ts:33`. Two copies of one regex is not worth a cross-boundary import in a slice this size; note it in the handback.

## Rulings (Fable, 2026-09-05) — settled; the text above stands

1. **Q1 — read-mode for saved studies, as specced.** DIRECTION §7 asks for per-section Edit by name, and the one-click cost is the honest price of a save that invalidates live participant links. The `?prefill=edit` remedy stays on the shelf unless a researcher walkthrough finds the click annoying.
2. **Q2 — keep the revision fetch**, display-only and fail-silent as specced.
3. **Q3 — keep `researcherContact`.** The consent document already promises a contact the product does not supply; that is an honesty gap, and no later slice owns StudySetup. The full path (M9.1–M9.5) ships in this slice under the Auth/participant-authority gates.
4. **Q4 — keep the directory**; report line counts in the handback.
5. **Q5 — accept the duplicated `Consent Text` string.**
6. **Rulings the spec settled itself are confirmed:** index stays right; no five-section rename; seven notice blocks; the `svg`-count assertion is replaced by the stronger no-decorative-icons assertion.

## Open questions as originally drafted (for the record)

1. **Document mode as the default for a saved study is the slice's one behavioural opinion.** It is what DIRECTION §7 asks for and it costs exactly two added lines across two existing test cases (M12), which is a good sign the derivation is right. The cost is one extra click for a researcher who came to `/setup` specifically to change a field, and `StudyList`'s entry point is literally named "Edit & Generate Link" — which is an argument that the researcher's intent is already known at navigation time. **Recommendation: ship read-mode as specced**, and if the walkthrough finds the click annoying, the cheap remedy is to have `?prefill=edit` open all sections while a bare `/setup` on a persisted saved study opens none. That is a one-line change to the `documentMode` initialiser and no test moves.
2. **The revision fetch is a new request on `/setup`.** It is display-only, fail-silent, and hits an endpoint `handlePreview` already uses, but it is still a request that exists only so a number can be printed. The alternative is to show the revision only after a save, which makes it invisible at the moment it matters most — opening a study that has live participant links. **Recommendation: keep the fetch**, and if the orchestrator would rather avoid it, the second-cheapest source is to have `StudyList.tsx:407` stash `study.revision` alongside the prefill config, which costs a two-line edit to a file this slice otherwise does not open and still leaves a direct `/setup?prefill=edit` visit with no number.
3. **`researcherContact` is included, and it is the only part of this slice that crosses a trust boundary.** M9 justifies it and specs the whole path, but it is separable: dropping it removes three files from the change set (`types.ts`, `studyConfigValidation.ts`, the follow-up route) and downgrades the gate from `npm run check` plus the auth row to the Researcher UI row alone. **Recommendation: keep it** — the field closes a gap the consent document already opened, and no later slice owns StudySetup — but if the orchestrator wants Slice M to be a pure structural change, splitting M9 into a one-file follow-up slice is clean and nothing else in M depends on it.
4. **Ten new files is a lot of surface for one slice.** The alternative is a single `src/components/studySetup/sections.tsx` holding all eight section components, which trades eight small files for one 500-line file. **Recommendation: keep the directory** — the point of C6 is that no file in this family should be hard to hold in one's head, and the section components have genuinely independent read views — but say so in the handback with the final line counts so the orchestrator can judge.
5. **The `<h2>Consent Text</h2>` restored in M5.4 duplicates the `Field`'s label string.** The alternative is to leave the section headingless and hang the Edit control off the `Field` label row, which is inconsistent with the other seven sections. **Recommendation: accept the duplication**; it is not an a11y failure and it is the only way the section index label, the heading, and the Edit control's accessible name all agree.
