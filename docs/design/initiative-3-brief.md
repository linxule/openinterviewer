# Initiative 3 — "The document is real" (Verbatim, third train)

Status: APPROVED with decisions of record, 2026-09-05 (v3).

> **Status (2026-09-05, end of day):** the whole train shipped to `main` in one day — Slice H (PR #13), K (#14), I (#15), L (#16), M (#17) — each built by Codex from its `slice-*-spec.md`, reviewed and visually verified at 1280 and 375, and merged on green CI. Slice N was struck (decision 4). Still owed by the owner: the iOS Safari real-device pass on the participant composer (K7) and the researcher walkthrough of the trace UI on both surfaces. First item of the next Storage train: persist the aggregate synthesis (D8, decision 5). Known follow-ups recorded in the slice handbacks: the aggregate catalogue budget (40 000 chars, round-robin) on very large studies; `UUID_V4` duplicated across `studyDraftSession.ts` and `storageService.ts`; echoing `researcherContact` on the consent page. Orchestrator: Fable (Claude Code). Pipeline unchanged: brief → per-slice spec → Codex build → Fable + second-model review → visual pass at 1280 and 375 → accept → commit.

Provenance: v1 written after walking every surface in the new browser suite (52 screenshots, 1280 + 375) and an independent Opus code audit against `DIRECTION-final.md`; v2 amended by an adversarial challenge lane (verdict: proceed amended, 10 amendments, all adopted and each re-verified against source before adoption).

## Where we actually are

Initiatives 1 and 2 shipped (PR #9/#10, 2026-08-27): tokens, fonts, primitives, the researcher shell, register tables, the participant transcript register, EvidenceRef with normalized matching, and the in-flow citation unfold. The Codex maintenance train (`cf67d1c`, 2026-09-05) hardened completion, receipts, and Redis JSON mutation, and added a real browser suite (`tests/e2e/research-workflow.spec.ts`) that boots the whole app against disposable Redis with synthetic providers.

The verdict: the direction landed and reads well. What remains is (a) places where the interface **says something untrue or unfinished**, (b) the flagship participant page still carrying **chat grammar**, and (c) structural debt that makes every further UI change cost double. Nothing here re-litigates `DIRECTION-final.md`; every item cites it.

## Defects found on the walk (fix regardless of the rest)

| # | Where | What | Why it matters |
|---|---|---|---|
| D1 | `InterviewDetail.tsx:411` | Provenance footer always prints `receipt unsigned` for saved interviews | `api/interviews/save/route.ts:138` strips `_receipt` before persistence, so no stored interview can ever be "signed". The footer reads as a failure. The receipt is a 1-hour HS256 token whose only job is done at save time (`synthesisReceipt.ts:53-76`, `save/route.ts:139-152`); the stored record already carries the verified facts (`aiModel`, `studyRevision`, `consentAcceptedAt`, `completedAt`). Fix is copy: drop the receipt clause, print `saved <completedAt>`. No hash, no fingerprint — a researcher has nothing to compare one against. |
| D2 | `StudyDetail.tsx:551` | Footer prints `receipt eyJhbGciOiJI` | First 12 chars of a JWS = the base64 header, identical for every receipt ever issued. Same fix as D1. |
| D3 | `Consent.tsx:107` | "1 core questions" | Pluralization on the document participants sign. |
| D4 | `StudySetup.tsx:176` | Default consent text contains the literal `[research topic]` | Participants see the bracketed placeholder verbatim unless the researcher edits it. `consentText` is already required at the type level (`types.ts:133`), so this is a default-string fix in StudySetup plus a save-time guard against bracketed tokens. |
| D5 | `Dashboard.tsx:335`, `StudyDetail.tsx:618` | ID column renders `session-` | `interview.id.slice(0, 8)` on ids shaped `session-<uuid>` (`save/route.ts:175`). One-line fix: slice after the prefix. |
| D6 | `StudyList.tsx:257`, `StudySetup.tsx:906,1046,1091,1129`, `StudyDetail.tsx:882`, `Export.tsx:315` | Close is a bare `×`; Copy and the row menu are words; ~12 `target=_blank` links have no external mark | `lucide-react` was pruned for install size. §6 still wants functional icons. |
| D7 | `InterviewChat.tsx:354,357,373`, `Consent.tsx:124,139`; `StudySetup.tsx:926`; `Login.tsx` | Four Tailwind-scale sizes, three rounded structural blocks; the entire 1,500px StudySetup form and the login form are each one bordered `bg-paper-1` card | §3/§4 drift ("rules over boxes") in the flagship and two researcher entry surfaces. |
| D8 | `StudyDetail.tsx:33`, `api/synthesis/aggregate/route.ts:136` | Aggregate synthesis is held in `useState` and never persisted; refresh discards a paid synthesis call, and the UI does not say so | Honesty chrome gap. Minimum for this train: the aggregate footer reads `Generated <time> · not saved — regenerate to refresh`. Persisting it is a Storage feature with its own review (see "not in this train"). |
| D9 | `ResearcherShell.tsx` | `/dashboard` is unreachable from the rail; only the breadcrumb (`breadcrumb.tsx:73`) and InterviewDetail's back button (`:152`) lead there | A real surface with no navigation. Decide: add to the rail, or fold into Studies. |

## The three moves

### Move A — The participant page is a page (flagship; DIRECTION §7 "Participant")

**A1. Composer at the end of the document, sticky when long.** Today the transcript scrolls in an `h-dvh` pane and the textarea is pinned to the viewport bottom — chat layout with the bubbles removed. On a phone the first question sits alone at the top with a paper void beneath it (`11b-interview-typed-mobile.png`). The document register says: the answer is written *under the question*. But pinned-bottom has one virtue in-flow loses — on a long transcript the composer is always reachable, and a viewport-bottom field is the well-trodden path for mobile keyboards. So: the composer becomes the **last block in the document flow** (sits directly under the question when the transcript is short) with `position: sticky; bottom: 0` (pins when the transcript is long). The running head (study name · phase sentence · Finish early) stays sticky at the top. The spec must decide the `viewport` meta (`layout.tsx` currently sets none; `interactive-widget=resizes-content` is the candidate) and the slice is tested on a real iPhone, not only in Chromium's emulation. Keep: `role=log`/`aria-live`, the composing rule, Cmd/Ctrl+Enter, the mobile Send-only rule, "Take as much space as you need.", every honesty string, the terracotta fail-closed block. Kill: the pane split, the centered "conversation complete" panel (becomes a final in-flow block at measure, left-aligned).

**A2. The receipt.** The "Interview submitted" page is `Synthesis.tsx:195-` (participant branch), not `Export.tsx` (`Export.tsx:200-216` is a fallback stub). It is a heading and one sentence. §7 specifies: turns contributed · elapsed time · consent `acceptedAt`. `consentTimestamp` is already in the store (`store.ts:199-201`), so the echo is free. Render as a mono fact block under a serif heading. **Researcher contact is dropped from this train** — no such field exists on `StudyConfig`; adding one belongs to Slice M where StudySetup is rebuilt. **Transcript download stays out** until the privacy/consent review (§8, unchanged).

**A3. Consent as a signed document.** Fix D3/D4. Echo the server `acceptedAt` back in mono after acceptance (§7).

**Gate.** DIRECTION §8's A9 moderated test is retired by decision 3 below. A1 ships on the direction's own judgement, with the standard participant-flow gates and a real-device review. The written fallback stays on record for real feedback.

### Move B — Provenance that tells the truth (DIRECTION §7 "Provenance footer", §8 Initiative 2)

**B1. Honest footers (fixes D1, D2, D8).** Copy-only after the challenge: `Synthesized by <model> · study rev N · saved <completedAt>` on InterviewDetail; `Synthesized by <model> · study rev N · generated <time> · not saved — regenerate to refresh` on the aggregate. No receipt clause anywhere in the UI. Touches only the footer JSX inside the shared reading (C1) — no Storage or Completion gate exposure.

**B2. Aggregate citations (I2c).** `quoteRefs?` exists on `AggregateTheme` (`types.ts:351`) and is never read. Prompt asks for `{ quote, interviewId, turnIndex }` per representative quote; server resolves each against the owned interview record with the existing normalized matcher; verified refs graduate to `Citation` with a wine numeral whose note reads `P02 · turn 12 · exploration` + "Read in P02's transcript →" linking to `InterviewDetail` with `traceToTurn`. Unlocatable quotes render as today (serif, no wine). Legacy `representativeQuotes` render unchanged. Prompt + types + provider validation → Providers/provenance gates; telemetry counts extended to aggregate. **Specced knowing D8: the output is ephemeral until aggregate persistence ships.**

**B3. Render `divergentViews` and `researchImplications`.** Populated and schema-validated (`types.ts:364,366`), referenced in zero `.tsx`. Two ruled sections on the aggregate reading, same grammar as Key Findings. The model already produces them and the researcher already paid for them.

**B4. Margin unfold (§7 A7) — struck by decision 4; kept here for the record.** `WithMargin` (`ui/Page.tsx:12-31`) is exported and unused. At ≥1024px the open citation note may render in the 18rem margin, baseline-aligned, with the ~400ms wine border-draw; below 1024px the in-flow footnote stays exactly as shipped. Only if everything else lands with budget left — the in-flow unfold is honest and works on the designed (mobile) case.

### Move C — Structure that stops the bleeding (slice-F/G deferred lists)

**C1. `SynthesisReading`.** `Synthesis.tsx:327-458` and `InterviewDetail.tsx:262-400` are ~130 identical lines differing by one string and one button; `StudyDetail.tsx:484-560` is a third variant. One component, three consumers, byte-identical output pinned by the existing register tests. Prerequisite for B1–B3 so the aggregate reading is not a fourth fork.

**C2. `Tabs` primitive.** `StudyDetail.tsx:412-429` has a tablist without `aria-controls`/`tabpanel`/roving tabindex; `InterviewDetail.tsx:203-226` is plain buttons. One implementation, both consumers.

**C3. `Notice` primitive.** The `border-l-2 border-* bg-paper-2 px-4 py-3` block appears 27 times across 8 files. One primitive with `tone: 'neutral' | 'error' | 'success'`, eyebrow + body slots. **Adopted per file by whichever slice owns that file** — Slice H creates it and adopts it only in files no later slice rewrites.

**C4. `Icon` set, no dependency.** Six inline SVGs in `ui/Icon.tsx` — close, copy, external, chevron, check, alert — 16/18px, `aria-hidden` with adjacent `sr-only` text or `aria-label`. Fixes D6 without re-adding 27 MiB.

**C5. Shared provider module.** `AI_PROVIDER_SETUP`, `emptyValidationState`, `initialProviderRecord`, `ValidationBadge` exist twice (`Settings.tsx:38-152`, `Onboarding.tsx:50-157`); the OpenRouter disclosure copy has already drifted ("requests fail" vs "a request fails"). Extract once.

**C6. `StudySetup` decomposition → Slice F1.** Lift idempotency/session helpers (`:57-140`) to a lib module, `useStudyDraft` for the ~25 `useState` calls, section components (Core Questions and Topic Areas are one component with two labels), and the bordered card at `:926` dies (D7). Then F1 as `slice-E-spec.md` §E1 defined it: sections readable at measure, per-section Edit, `studyRevision` legible, consent text rendered as a serif sheet, optional researcher-contact field (feeds A2 later). Owns rewriting the three suites that pin the all-mounted shape.

## Explicitly not in this train

- **Persisting aggregate synthesis** (D8's real fix) — Storage feature: new key, atomicity, tenancy, and receipt handling; needs its own spec and the Storage gates.
- Night theme toggle — tokens stay dead until the researcher walkthrough (slice-G Deferred; A6).
- Participant transcript download — after the privacy/consent review only.
- Typeset HTML/PDF export; the merged InterviewDetail single-surface reading; aggregate concordance.
- Any rename, wordmark, or re-litigation of palette/type (DIRECTION §1).
- "0 min" durations: `createdAt` is client-supplied (`save/route.ts:189-191`) and short interviews will read the same in production — a data question, not a UI one.

## Proposed slices and order

| Slice | Contents | Size | Gates (AGENTS.md change map) | Depends on |
|---|---|---|---|---|
| **H** | D3, D4, D5, D7 (flagship files + Login card), D9; create C3 Notice + C4 Icon; adopt them in InterviewChat, Consent, Synthesis, Export, Dashboard, StudyList, StudyDetail only | S/M | Researcher UI: paired component tests; 375px inspection | — |
| **I** | C1 SynthesisReading (with B1 footers and B3 sections), C2 Tabs, C5 provider module (adopt Notice in Settings/Onboarding here) | M | Researcher UI + Completion (`Synthesis.tsx` is on the completion row): register/lifecycle tests, `npm run test:e2e` | H |
| **K** | A1 composer, A2 receipt page, A3 consent echo | M | Participant flow: consent/session/isolation suites, `test:e2e`, 375px + real-device review | H |
| **L** | B2 aggregate citations (I2c) incl. prompt + validation + telemetry | M/L | Providers/provenance: transport/provider/provenance tests, both build contracts, `npm run check` | I |
| **M** | C6 StudySetup decomposition → F1 (adopt Notice in StudySetup here) | L | Researcher UI; idempotency/auth/setup suites rewritten by the slice | I |

Order: H → I → L → M on the researcher track; K branches from H and can run alongside I. K and I both touch `Synthesis.tsx` (participant branch vs. researcher reading) — K rebases on I when I lands; they must not be merged the same day without a joint visual pass. Each slice gets its own `slice-*-spec.md` in the established format (prime directive, per-site instructions, load-bearing test list, Deferred, Open questions) before Codex starts.

## Decisions of record (owner, 2026-09-05)

1. **D4 — templated.** The default consent text is generated from the research question at study-save time (no bracketed token can be saved); the researcher may overwrite it. The Slice H spec defines the template sentence and the save-time guard.
2. **D9 — rail.** `/dashboard` joins the rail as **Interviews** (Studies · Interviews · Settings). Orchestrator's call, delegated by owner.
3. **A9 — retired.** The owner rules the moderated-test gate an unnecessary historical blocker: the direction is opinionated by design and ships on its own judgement. Slice K ships without a flag. The written fallback (a conversational participant layout if the document register chills disclosure) remains on record as the response to real user feedback, not as a precondition.
4. **B4 — not this train.** The in-flow footnote unfold is the answer for now; Slice N is struck. The `WithMargin` primitive stays exported and unused for a future train.
5. **D8 — honest footer now, persistence next.** Aggregate persistence is the first item of the next Storage train, with its own spec and the Storage gates.

## Agent-guide updates implied by the Codex train (separate from any slice)

`AGENTS.md` was touched in `24ac12a` but still lacks: a pointer to `docs/design/DIRECTION-final.md` and the ESLint design law in `eslint.config.mjs` (agents editing UI need to know wine/ochre/serif are lint-scoped to `src/components/ui/`, and that `docs/design/slice-*-spec.md` is the spec format); `tests/e2e/server.mjs` + `workflow-fixture.ts` as the credential-free way to boot the full app; `src/lib/studyJsonLua.ts` in the Storage map; and the Researcher UI row should name `src/components/ui/` as the only place new visual vocabulary is added. `CLAUDE.md` needs no change — it is a pointer and the Next-managed block is intact.
