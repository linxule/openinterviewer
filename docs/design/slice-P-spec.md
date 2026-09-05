# Slice P — Save first, analyze later

Answers the owner's question of 2026-09-05: *"Why should the interviewee be doing this retrying, right? If they hit submit and if there are errors with the summarizer, that should be the issue for the researcher to figure out, right? So once the interviewee is finalized then they should be able to exit."*

Today the participant's transcript is hostage to a provider call. `Synthesis.tsx:151-180` calls `/api/synthesis`, receives a server-signed receipt, and only then calls `/api/interviews/save`, which **requires** that receipt (`interviewSubmission.ts:133-135`, `save/route.ts:139-151`). A provider failure at that moment leaves the whole interview in one browser tab, shows the participant `We couldn't finalize your interview`, and hands them a `Retry finalization` button. This week that happened twice in production for two unrelated provider reasons and a participant was stranded.

**Prime directive.** *The transcript is durable the moment the participant finishes. The analysis is a second, retryable, researcher-owned act performed entirely on the server.* Nothing the browser holds is ever the only copy of a completed interview, and no participant is ever asked to retry a model call.

Context to read before implementing: `AGENTS.md` in full, especially "Participant and AI flow", the "Completion and export" change-map row, and the invariants on untrusted browser synthesis, fail-closed uncertainty, and atomic/idempotent completion persistence. `docs/design/DIRECTION-final.md` §7 (Participant flagship, Receipt; Researcher workspace, Provenance footer), §9 (honesty copy is a keep list), §10 (no skeletons, no fabricated content). `docs/design/slice-K-spec.md` K2 (the receipt the participant actually sees). `docs/design/slice-N-spec.md` N4/N12 (the storage-train exemplar: one `SET`, size cap, arity, fault cuts). `docs/design/slice-O-spec.md` — this slice **amends** parts of it; see P17.

This spec assumes `feat/synthesis-uses-study-model` has landed: `resolveSynthesisModel(studyConfig)` returns `studyConfig.aiModel` and throws when the study names none (`src/lib/providers/synthesisModel.ts:23-30`). Every "the analysis model" below means the study's configured model **at the moment the analysis ran**.

---

## P1. Laws that bind this slice

1. **"Browser-supplied … synthesis … are untrusted"** (AGENTS.md). After this slice the browser never carries a synthesis toward storage at all. That is a strengthening, not a weakening — P9 argues the receipt out of existence on exactly that ground.
2. **"AI/provider failure is an error. Never substitute a plausible research response, synthesis, or greeting."** An interview whose analysis failed renders as *pending* or *failed*, never as an empty synthesis, never as a placeholder bottom line, and never with the study's research question echoed back as a finding.
3. **"Completion persistence and study mutation remain atomic and idempotent under retries and concurrency."** The save path keeps its P1/Finish guard protocol byte-for-byte. The new analysis write is a separate single-key compare-and-set in Lua; two concurrent runs must never both write (P6).
4. **"Study revision, link status, ownership, consent, rate limits, and storage uncertainty fail closed."** A deferred analysis that cannot resolve its study, its provider, or its lease is recorded as `failed`, never silently dropped and never retried in a loop.
5. **Counts-only logging** (`requestLog.ts:5-29`). The stored `analysis` record carries an enum and integers. No provider error body, no message, no stack, no model output ever reaches it.
6. **Verdicts are never stored** (`evidence.ts`, render-time classification). Nothing here changes that: `withRecordBackedEvidence` still runs at read time in the aggregate route.
7. **No genre vocabulary** in copy, labels or `aria-label`s: no "apparatus", "colophon", "marginalia", "provenance" as a user-facing noun.

---

## P2. Repo facts this spec is built on

Verified by reading source at spec time on `feat/synthesis-uses-study-model`, whose working tree carries the in-flight study-model change (it removes `SYNTHESIS_MODEL_BY_PROVIDER` and the four `*_SYNTHESIS_MODEL` constants, so line numbers in `src/types.ts` and `src/lib/providerRegistry.ts` shift by a few lines against `main` at `cf67d1c`). Re-verify any anchor that looks stale.

1. **The participant never sees the synthesis today.** `Synthesis.tsx:202` returns the participant branch before the reading is reached; the `SynthesisReading` at `:382` is the researcher/preview branch only, and `tests/unit/Synthesis.register.test.tsx:70-114` asserts all four participant states carry no icons and no `role="note"`. The brief's premise that "Slice K's receipt shows the participant their synthesis" is **false**. Slice P therefore removes no reading from the participant flow — only the wait and two error states.
2. **The participant's synthesis call is the only thing standing between finishing and saving.** `Synthesis.tsx:151-180`: `synthesizeInterview` → `setSynthesis` → `doSave`. `doSave` refuses without `attempt.result` (`:82`).
3. **The save route hard-requires a receipt.** `validateInterviewSubmission` throws on a missing `synthesis._receipt` (`interviewSubmission.ts:133-135`); `save/route.ts:149-151` returns 403 when `verifySynthesisReceipt` returns null.
4. **`StoredInterview.synthesis` is already `SynthesisResult | null`** (`types.ts:254`), and `makeStoredInterview` already defaults it to `null` (`tests/fixtures/models.ts:54`). The nullable case is typed, fixtured, and unexercised on the write path.
5. **Stored interviews are one opaque JSON value with no read-side field allowlist.** `encodeInterviewValue` is `oi:interview:` + `JSON.stringify` (`kv.ts:133-135`); `decodeStoredInterview` (`:117-131`) checks only `id`, `studyId`, `status`, `createdAt`, `completedAt` and casts. A new field round-trips with no kv read edit.
6. **Completion persistence is immutable by fingerprint, not by field.** `PERSIST_COMPLETED_INTERVIEW_P1_SCRIPT` refuses when a stored fingerprint differs from the request's (`kv.ts:369-371`) and when `valid_immutable` fails (`:375-377`); `valid_immutable` (`:310-316`) checks `id`, `studyId`, `status`, `createdAt`, `completedAt` and nothing else. **Attaching an analysis to a stored record therefore does not break the duplicate path**, provided the fingerprint does not cover the analysis. P5.2 makes that a rule.
7. **There is a purpose-built Lua JSON patcher that preserves untouched value types.** `STUDY_JSON_LUA` (`src/lib/studyJsonLua.ts:8-86`) exposes `json_object_members`, `json_object_value` and `patch_json_object`, which locate member boundaries by scanning and replace only named members — precisely because `cjson` loses empty-array types on a round trip. It is currently used by `STUDY_CAS_LUA` and the persist Finish script (`kv.ts:419`).
8. **Every Redis script result goes through a closed wire parser.** `parseFamilyWire` (`wire/parse.ts:34-45`) accepts only tags registered in `FAMILY_TAGS` (`wire/types.ts:99-196`) with an exact arity. A new script needs a new family and a new parser, and `tests/unit/wire.malformedMatrix.test.ts` and `wire.registry.test.ts` will hold it to that.
9. **`after` exists and is stable in this Next.** `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md` — exported from `next/server`, stable since 15.1.0, explicitly supported in Route Handlers, where `cookies()`/`headers()` may be called inside the callback. Installed Next is 16.3.4. On Vercel it is implemented with `waitUntil`, which extends the invocation past the flushed response; its duration is bounded by the route's `maxDuration`.
10. **No `maxDuration` is configured anywhere.** There is no `vercel.json`, and `next.config.js` sets only `reactStrictMode` and `turbopack.root`. Every function runs on the platform default, which is short. P7.3 makes this an explicit export rather than a hope.
11. **The Redis client cache is module-scoped with no per-request disposal.** `getResearcherClient` (`kvClient.ts:281-313`) memoizes on a canonical cache key with `lastUsed` bookkeeping and evicts only via `evictResearcherClients`. A client captured by an `after` closure is still usable after the response is flushed.
12. **The aggregate route already skips un-analyzed interviews and says so.** `synthesis/aggregate/route.ts:72-74` filters `studyRevision === study.revision && interview.synthesis`; `StudyDetail.tsx:63-66` recomputes the same predicate client-side and `:408-410` renders `covers N of M interviews`. Slice P adds interviews with no synthesis to that population; **the existing footer clause is the correct honest response and needs no change.**
13. **`generate-followup` reads the stored aggregate, not the interviews.** It re-derives `eligibleIds` with the same `interview.synthesis` predicate (`generate-followup/route.ts:96-100`) purely to refuse an aggregate naming an ineligible interview. An interview that lost eligibility cannot exist here: analysis only ever adds a synthesis, never removes one.
14. **Researcher study writes run under `'read'` authority today.** `synthesis/aggregate/route.ts:43` gates with `getAuthorizedResearcherStudyContext(studyId, 'read')` and then writes a stored aggregate. `AUTHORITY_PURPOSES` (`platformDb.ts:98-106`) is a closed enum whose members are covered by schema tests; the analyze route reuses `'read'` rather than adding a member.
15. **The hosted `synthesis` platform budget is participant-shaped.** `HOSTED_AI_RATE_LIMIT_POLICY.synthesis.session` is `{ maximum: 2, windowSeconds: 86_400 }` (`platformAiRateLimit.ts:36-40`), keyed on the participant session or, absent one, the researcher's session cookie (`:85-86`). A researcher batch of twelve would be refused after two. P8.3 adds an `analysis` operation rather than bending this one.
16. **`/api/synthesis` has exactly one participant caller and one preview caller.** `services/interviewApi.ts:105-137` is called only from `Synthesis.tsx:154`, with `researcherPreview` set from `viewMode`. After P1 the participant branch no longer calls it.
17. **`LIMITS.synthesis` and `refundParticipantRateLimit` have one call site each.** `rateLimit.ts:40-48` is consumed only at `synthesis/route.ts:120-127`; `refundParticipantRateLimit` is called only at `synthesis/route.ts:192-198`. Both sit inside `if (!isAdmin)`.
18. **The e2e suite drives the whole failure choreography.** `tests/e2e/research-workflow.spec.ts:53-70` sets `workflow.failNextSynthesis`, expects `We couldn't finalize your interview`, clicks `Retry finalization`, then sets `interruptStorageAfterSynthesis` and clicks `Retry save`. `workflow-fixture.ts:117-138` classifies calls by response shape and owns both fault switches. This is the single largest test rewrite in the slice.
19. **The demo seed interviews all carry a synthesis.** `demoData.ts:188,290,393`. They are `complete` under P14's derivation with no backfill.
20. **The submission body is bounded at 512 000 bytes** (`save/route.ts:45`, `interviewSubmission.ts:126`) and a synthesis is bounded by `validateSynthesisResult` (`providerValidation.ts:155`). Dropping the synthesis from the submission makes the save body strictly smaller.

---

## P3. The participant flow

### P3.1 Finish is save

`Synthesis.tsx`, participant path only. The effect at `:127-182` splits: the participant branch saves, the researcher/preview branch keeps today's analyze-then-(non-persisting)-save behaviour verbatim.

```tsx
// Participant completion is a save. The analysis is the server's problem and
// the researcher's; a participant who finished must never be asked to retry a
// model call to make their own words durable.
const saveOnly = async () => { await doSave(attempt); };
```

`doSave` loses its `!attempt.result` guard (`:82`) and stops sending `synthesis` for participants. Everything else in the completion apparatus survives byte-for-byte: `sameCompletionInputs`, `isCurrentAttempt`, `activeAttempt`, the StrictMode replay discipline, `mounted`, and the submission-identity rules `Synthesis.lifecycle.test.tsx` exists to pin.

`participantState` (`:203-211`) loses two arms and becomes three:

| state | when | copy |
|---|---|---|
| `finalizing` | save in flight | unchanged, verbatim |
| `save-failed` | `saveStatus === 'failed'` | unchanged, verbatim |
| `saved` | `saveStatus === 'saved'` | unchanged, verbatim, plus the K2 receipt |

`analysis-failed` and `rate-limited` are deleted from the participant branch, along with `handleRetryAnalysis` and `analysisError` on that path. `Retry save` stays: a *storage* failure is still the participant's to retry, because the transcript really is only in the tab until the save lands. That distinction is the whole point — the participant retries storage, never the model.

**The receipt says nothing about the analysis.** `Your responses have been saved. It is now safe to close this tab.` is already true and already on DIRECTION §9's keep list. Adding "your analysis is being prepared" would tell the participant about a process they have no stake in, cannot influence, and may not get. What the saved screen *does* gain is the researcher's own thank-you text and contact line — P12.

### P3.2 Participants see no analysis, and that is the status quo

P2.1: they never did. The owner's framing settles the only open part — participants should not wait for it — and the code already never showed it to them. This slice does not add a participant-facing analysis and does not remove one.

### P3.3 `/api/synthesis` becomes researcher-preview only

With no participant caller left (P2.16), the route's participant half is dead code holding a live trust boundary open. It fails closed instead: after the context resolves, `if (!isAdmin) return 403 'Interview analysis is generated by the researcher.'`, above the consent check. Consequences, all of them deletions:

- The `!isAdmin` consent block (`:94-128`) and the `participantRateLimitResponse` call go with it.
- `LIMITS.synthesis` (`rateLimit.ts:40-48`) loses its only consumer and is **deleted**.
- `refundParticipantRateLimit` (`rateLimit.ts:199-214`) loses its only call site and is **deleted**, together with `REFUND_LIMITS_SCRIPT` (`:82-89`) and the `rateLimit.refund` entry in `REQUEST_LOG_EVENT_ALLOWLIST` (`requestLog.ts:28`).
- `tests/unit/rateLimit.participant.test.ts:94-145` loses its `refundParticipantRateLimit` describe block; the rest of the file stands.
- `hostedAiRateLimitResponse(request, 'synthesis', …)` stays on the preview path with `participantSessionId: undefined`, exactly as `isAdmin` already passes it (`:135`).

**This is a deletion, not a deprecation.** A refund helper with no caller is a loaded gun for the next person who adds a participant-facing provider call and reaches for the nearest-looking budget.

---

## P4. The shapes (`src/types.ts`)

```ts
/** How the analysis of one interview stands. Enums and counts only. */
export type InterviewAnalysisStatus = 'pending' | 'running' | 'complete' | 'failed';

/**
 * Why the last attempt did not produce a synthesis. Deliberately coarse: a
 * provider message, status line or payload must never reach a stored record
 * or a researcher's screen (AGENTS.md counts-only logging).
 */
export type InterviewAnalysisFailureKind =
  | 'provider'       // the provider call threw or returned an error
  | 'invalid-output' // the response did not validate as a SynthesisResult
  | 'too-large'      // the synthesis exceeded MAX_ATTACHED_SYNTHESIS_BYTES
  | 'timeout'        // the deferred run did not finish inside its lease
  | 'storage';       // the attach write failed

export interface InterviewAnalysisState {
  status: InterviewAnalysisStatus;
  /** Completed attempts, successful or not. Never decremented. */
  attempts: number;
  /** Epoch ms of the most recent attempt start. */
  lastAttemptAt: number;
  /** Present only while `running`; the CAS token (P6). */
  claimId?: string;
  claimedAt?: number;
  /** Present only when `status === 'failed'`. */
  failureKind?: InterviewAnalysisFailureKind;
  /** The study revision the successful analysis ran under. */
  studyRevision?: number;
}

export interface StoredInterview {
  // ... unchanged through consentAcceptedAt ...

  /**
   * The provider and model that produced this record's SYNTHESIS, written by
   * the server at analysis time. With the study's model now driving synthesis,
   * this equals the study config at the moment the analysis ran — which is not
   * necessarily the config the conversation ran under, because an analysis may
   * be run days later, after an edit. That is why `conductedBy*` still exists.
   */
  aiProvider?: AIProviderType;
  aiModel?: string;
  requestedAiModel?: string;
  routedProvider?: string;

  /** Slice O. Unchanged by this slice. */
  conductedByProvider?: AIProviderType;
  conductedByModel?: string;

  /**
   * Absent on every record written before Slice P. Read it through
   * `analysisStatus()` (src/lib/analysisState.ts), never directly: a legacy
   * record's status is derived from whether it carries a synthesis.
   */
  analysis?: InterviewAnalysisState;

  participantLinkId?: string;
}
```

No other type changes. `SynthesisResult`, `AggregateSynthesisResult`, `SynthesisProvenance` and every `EvidenceRef` shape are untouched.

---

## P5. The save route (`src/app/api/interviews/save/route.ts`)

### P5.1 The submission loses its synthesis

`interviewSubmission.ts`:

- `ValidInterviewSubmission.synthesis` becomes `SynthesisResult | null`, and `_receipt` leaves the type entirely.
- `:133-137` becomes: `input.synthesis === undefined || input.synthesis === null` → `null`; otherwise `validateSynthesisResult(input.synthesis)` with **no** `_receipt` requirement.
- The explicit seven-field return copy at `:139-147` is unchanged in shape. It remains a whitelist, and P16 pins that with an adversarial regression rather than trusting it to stay one.

**Why still accept a synthesis at all?** Researcher preview (`isAdmin`) posts one so the preview save can echo `{ preview: true }` without a special client path, and `Synthesis.tsx`'s preview branch is not being rewritten. A participant body carrying a synthesis is accepted by the validator and then **discarded by the route** — P5.2 writes `synthesis: null` unconditionally on the participant path. That is the whole trust story in one line: the field is parsed so the shape stays uniform, and never read.

### P5.2 The route

Replacing `:138-151` (receipt verification) and the two provenance blocks:

```ts
    const interview: StoredInterview = {
      // ... unchanged through consentAcceptedAt ...
      synthesis: null,
      // No aiProvider/aiModel/requestedAiModel/routedProvider: this record has
      // not been analyzed. They are written by the analysis writer, once.
      conductedByProvider: canonical.study.config.aiProvider,
      conductedByModel: canonical.study.config.aiModel,
      analysis: { status: 'pending', attempts: 0, lastAttemptAt: now },
      participantLinkId: linkId,
    };
```

and the fingerprint (`:207-221`):

```ts
    const fingerprint = submissionFingerprint({
      id: interviewId,
      studyId: canonical.study.id,
      participantProfile: clientData.participantProfile,
      transcript: clientData.transcript,
      behaviorData: clientData.behaviorData,
      createdAt: clientData.createdAt ?? null,
      consentHash: consentRecord!.consentHash,
      consentAcceptedAt: consentRecord!.acceptedAt,
      conductedByProvider: canonical.study.config.aiProvider,
      conductedByModel: canonical.study.config.aiModel,
    });
```

**The fingerprint must not cover `analysis` or `synthesis`.** This is the load-bearing rule of the whole slice. The fingerprint is the identity of the *submission*, and the analysis is not part of the submission; it is written later, by a different actor, possibly several times. If it entered the fingerprint, a `persist-repair` retry arriving after a successful analysis would compute a different fingerprint, fail the guard comparison at `:242-249`, and return an opaque 404 for a record that saved perfectly. `synthesis` leaves the fingerprint for the same reason and because it is now always `null` on this path.

Everything else in the route is unchanged: bounded body read, context resolution and `new-persist` purpose, the study-id mismatch refusals, `loadCanonicalStudy`, consent verification and its 503/428, the `isAdmin` preview short-circuit, `getSavePersistRatePlan`, the `persistRepairOnly` guard comparison, every `persistence.status` mapping, and the 500 catch site.

### P5.3 The response

```ts
    return NextResponse.json({
      success: true,
      id: interview.id,
      created: persistence.status === 'created',
      ...(persistence.status === 'duplicate' ? { duplicate: true } : {}),
    });
```

Unchanged. It says nothing about the analysis: the participant's client has no use for the fact and the response must not become a place where an analysis outcome is awaited.

---

## P6. The analysis writer (`src/lib/kv.ts`)

### P6.1 Why a new script rather than a second `persistCompletedInterview`

The persist protocol is an *immutable create*: P1 refuses any request whose fingerprint differs from the stored one, and Finish re-derives the study's `interviewCount`, sets `isLocked`, and ZADDs the rate plan. Re-running it to attach an analysis would re-consume save budget, re-touch the study record, and require the fingerprint to change — three side effects for a two-field patch. The analysis gets its own single-key script.

### P6.2 `ATTACH_INTERVIEW_ANALYSIS_SCRIPT`

One key: `interview:<id>`. Built as `${STUDY_JSON_LUA}` plus the body below, reusing `json_object_value` and `patch_json_object` (P2.7). `encode_study` is unused there and harmless; amend the module's doc comment to say it is the shared JSON patcher, and change no Lua.

```
KEYS[1] = interview:<id>
ARGV[1] = op            'claim' | 'complete' | 'fail'
ARGV[2] = interviewId
ARGV[3] = nowMs         (decimal string)
ARGV[4] = leaseMs       (decimal string)
ARGV[5] = claimId       (claim: the new token; complete/fail: the token held)
ARGV[6] = analysisJson  the full replacement `analysis` member, as JSON text
ARGV[7] = synthesisJson complete only: the `synthesis` member, as JSON text; '' otherwise
```

Behaviour:

- Read `KEYS[1]`; require the `oi:interview:` prefix, else `oi:analysis-notfound`. Strip the prefix to get raw JSON text.
- `json_object_value(raw, 'status')` must be `"completed"`, else `oi:analysis-notfound`. `json_object_value(raw, 'id')` must equal `ARGV[2]`, else `oi:analysis-notfound`.
- Effective state: decode the small `analysis` member if present; otherwise derive `complete` when the `synthesis` member is neither absent nor the literal `null`, and `pending` otherwise. **This is the same derivation as P14, executed once more inside the script**, so a legacy record cannot be re-analyzed by accident.
- `claim`: `complete` → `oi:analysis-done`. `running` with `nowMs - claimedAt < leaseMs` → `oi:analysis-busy`. Otherwise `patch_json_object(raw, {{'analysis', ARGV[6]}})`, `SET`, return `{'oi:analysis-claimed', ARGV[5]}`.
- `complete`: current must be `running` with `claimId == ARGV[5]`; if it is already `complete`, return `oi:analysis-done`; any other mismatch is `oi:analysis-stale`. Otherwise patch **both** members in one `patch_json_object` call and one `SET`, return `oi:analysis-written`.
- `fail`: same claim check, patches `analysis` only, returns `oi:analysis-recorded`.

Every path is one read and at most one `SET` inside a single `EVAL`, so there is **no multi-write prefix, no crash window, and no new fault cut**. `tests/helpers/faultManifest.ts` is not edited. If an implementation finds it needs a cut here, it has added a second write and left the design.

### P6.3 The wire family

`FAMILY_TAGS` (`wire/types.ts:99`) gains an `analysis` family and `FamilyName` (`:72-85`) gains the member:

```ts
  analysis: {
    'oi:analysis-unavailable': { arity: 1 },
    'oi:analysis-notfound': { arity: 1 },
    'oi:analysis-busy': { arity: 1 },
    'oi:analysis-done': { arity: 1 },
    'oi:analysis-stale': { arity: 1 },
    'oi:analysis-written': { arity: 1 },
    'oi:analysis-recorded': { arity: 1 },
    'oi:analysis-claimed': { arity: 2, payloadKind: 'string' },
  },
```

with `parseAnalysisResult` in `wire/parse.ts` alongside `parsePersistResult` (`:307-313`), mapping tags to a closed `AnalysisWireOutcome` union. `wire.registry.test.ts` and `wire.malformedMatrix.test.ts` gain the family; every other family's matrix is untouched.

### P6.4 The TypeScript surface

```ts
/**
 * The serialized ceiling for one attached synthesis. The same number as
 * MAX_STORED_AGGREGATE_BYTES: the largest analysis this deployment has ever
 * been willing to store. Checked before the client is resolved, so an
 * oversized synthesis costs no Redis round trip.
 */
export const MAX_ATTACHED_SYNTHESIS_BYTES = 256_000;

/** How long one claim may hold the record before another run may take over. */
export const ANALYSIS_CLAIM_LEASE_MS = 180_000;

export type ClaimAnalysisResult =
  | { status: 'claimed'; claimId: string; attempts: number }
  | { status: 'busy' } | { status: 'already-complete' }
  | { status: 'not-found' } | { status: 'unavailable' };

export async function claimInterviewAnalysis(
  interviewId: string, client?: RedisPort, nowMs?: number,
): Promise<ClaimAnalysisResult>;

export type AttachAnalysisResult =
  | { status: 'written' } | { status: 'already-complete' }
  | { status: 'stale' } | { status: 'too-large' }
  | { status: 'not-found' } | { status: 'unavailable' };

export async function attachInterviewAnalysis(input: {
  interviewId: string;
  claimId: string;
  synthesis: SynthesisResult;
  provenance: SynthesisProvenance;
  studyRevision: number;
}, client?: RedisPort): Promise<AttachAnalysisResult>;

export async function recordInterviewAnalysisFailure(
  interviewId: string, claimId: string,
  failureKind: InterviewAnalysisFailureKind, client?: RedisPort,
): Promise<AttachAnalysisResult>;
```

`claimId` is `randomUUID()`. The id guard is the same `ID` shape the submission validator already enforces; a malformed id never constructs a key. `attachInterviewAnalysis` writes the four provenance fields into the same patch as `synthesis` and `analysis`, so a record never carries a synthesis without the model that produced it.

**The delete cascade is unaffected.** No new key, no new prefix, no arity change in `DELETE_EMPTY_STUDY_SCRIPT` or `deleteStudy`.

---

## P7. The mechanism: `after()` in the save route

### P7.1 The recommendation

**(a): run the analysis inside the save request, after the response, via `after()` from `next/server`, with the researcher-triggered route of P8 as the recovery path for everything it cannot finish.**

```ts
import { after } from 'next/server';
export const maxDuration = 120;

// ... after the success response is constructed, before returning it:
    if (persistence.status === 'created') {
      const kvClient = context.kvClient;
      const study = canonical.study;
      const keys = providerKeysFromContext(context);
      after(async () => {
        await runInterviewAnalysis({
          interviewId: interview.id, study, kvClient, providerKeys: keys,
          platformAuthority: { researcherId: context.researcherId, participantSessionId },
        });
      });
    }
```

`runInterviewAnalysis` is one new module, `src/lib/interviewAnalysis.ts`, shared verbatim with P8's route. Deferred work is scheduled **only on `created`** — never on `duplicate`, and never on any refusal — so a retrying participant cannot schedule a second run.

### P7.2 Why not the other two

**(b) a fire-and-forget request from the participant's page.** It reintroduces the exact dependency the slice exists to remove: a participant who closes the tab the instant they see "safe to close" — which the copy explicitly invites — cancels the analysis. It also needs a participant-authenticated route that performs a provider call, which is a new participant-facing AI surface with its own abuse budget, its own consent re-verification, and its own retry semantics, all to do work the server was already holding every input for.

**(c) researcher-triggered only.** Correct, and shipped — but as the *only* path it makes the common case (nothing failed) require a manual press per interview. The owner's complaint is about who does the retrying, not about who does the first attempt.

`after()` keeps the participant's response on the same latency it has today minus a provider call, does the work in the process that already holds the canonical study, the resolved provider keys and a live Redis client, and needs no new authenticated surface.

### P7.3 Failure modes, each with its answer

| mode | what happens | why it is acceptable |
|---|---|---|
| **Function timeout mid-analysis** | The `running` claim is left behind. After `ANALYSIS_CLAIM_LEASE_MS` the next claim takes over. The record reads *pending* until then. | The transcript is already durable. `export const maxDuration = 120` on the save route (P2.10) makes the ceiling explicit rather than platform-default. |
| **Platform does not honour `waitUntil`** | The callback may not run at all. Record stays `pending`. | Recovery is P8's route and P11's batch action, which exist regardless. Nothing is lost and nothing is corrupted. |
| **Double run** — an `after` callback and a researcher press racing | Both call `claimInterviewAnalysis`; exactly one gets `claimed`, the other gets `busy` and returns without a provider call. | The claim is a single-key CAS inside one `EVAL` (P6.2). Two runs cannot both write. |
| **A very late `after` finishing after a researcher's newer run** | Its `complete` finds a different `claimId` and returns `stale`. The newer result stands. | Last-claim-wins is the only ordering the record can observe, and it is the one a researcher would pick. |
| **Provider failure** | `recordInterviewAnalysisFailure(…, 'provider')`. The record reads *failed*, the researcher gets a button. | Law 2: an error is an error. |
| **`attach` fails on storage** | Nothing is written; the claim expires; the record returns to *pending*. | Fail closed. The paid call is lost, which is the honest cost of a Redis outage. |
| **The study was edited between save and analysis** | The analysis runs against the current config and records `analysis.studyRevision`. | P11.2 prints the divergence rather than hiding it. Refusing instead would make any edited study's pending interviews permanently unanalyzable. |
| **The study was deleted** | `loadCanonicalStudy` fails; the run exits without claiming. | The interview is gone with the study; there is nothing to write to. |

`runInterviewAnalysis` never throws to its caller and never retries internally. One attempt, one recorded outcome.

---

## P8. Researcher-triggered analysis

### P8.1 The route

**New: `POST /api/interviews/[id]/analyze`**, a sibling of the existing `GET /api/interviews/[id]/route.ts`.

- `export const dynamic = 'force-dynamic'`, `export const maxDuration = 120`.
- `studyId` comes from the query string, validated with the route's existing `STUDY_ID_PATTERN` (`interviews/[id]/route.ts:17`) and **required in both modes** — unlike the GET, which allows standalone to omit it. Authority is per-study; an analyze without one has nothing to gate on.
- `getAuthorizedResearcherStudyContext(studyId, 'read')` then `configurationRequiredResponse`, byte-identical to `aggregate/route.ts:43-56`. P2.14 is the precedent: this is the shape a researcher-authenticated write already takes.
- Load the interview with `getInterviewChecked` + `mapInterviewLoad`, then **`if (mapped.interview.studyId !== studyId) return 404`** — the same cross-tenant refusal as `interviews/[id]/route.ts:58-60`. This is the line P16 attacks directly.
- `loadCanonicalStudy({ kvClient, tokenStudyId: studyId })` for the config and revision.
- `hostedAiRateLimitResponse(request, 'analysis', { researcherId: gated.researcherId })`.
- `await runInterviewAnalysis(...)` — the researcher waits for this one, because they pressed a button and expect an outcome.
- Response: `{ status: 'complete' | 'failed' | 'busy' | 'already-complete', failureKind? }` with 200 for all four. A `failed` analysis is a successful report of a failure, and the UI needs the kind to choose its copy; `providerErrorResponse` is not used, because the researcher is not being told a provider fact, they are being told a record fact.

### P8.2 The batch

**No batch route.** StudyDetail's "Analyze N pending" iterates the pending ids **sequentially** against the same single-interview route, updating the register row by row.

Sequential and client-driven, for three reasons in the order that decides it: one write path means one place where the claim CAS lives; partial progress is visible and survives a closed tab, because each interview is committed on its own; and a server-side batch would need its own bounded fan-out, its own partial-failure vocabulary and its own timeout budget to do worse. The press is capped at **25 interviews**; beyond that the button analyzes the oldest 25 and the count updates.

### P8.3 Rate limits move to the researcher

`platformAiRateLimit.ts` gains an `analysis` operation (P2.15):

```ts
  analysis: {
    session: { maximum: 100, windowSeconds: 3_600 },
    network: { maximum: 200, windowSeconds: 3_600 },
    researcher: { maximum: 500, windowSeconds: 86_400 },
  },
```

`session` at 100/hour admits a 25-interview batch four times an hour; `researcher` at 500/day bounds the platform's exposure. The `after()` path keeps consuming `'synthesis'` with the participant session, exactly as the participant-triggered call does today — one save, one analysis, inside the existing budget.

Participant-side: `LIMITS.synthesis` is deleted (P3.3). `LIMITS.save` is unchanged — it is now the only participant-facing completion budget, and at `{ session: 2/day }` it still admits the one legitimate retry a storage failure needs.

---

## P9. The receipt is retired

### P9.1 The argument

The receipt exists for exactly one reason: the browser carried a synthesis to a route that had to store it, and a synthesis that came from a browser is untrusted. The signature bound it to the study, the revision, the participant session and a digest of the very transcript being saved, so the route could accept an object it did not produce.

After this slice **no synthesis is ever produced in one process and stored by another**. `runInterviewAnalysis` calls the provider and writes the result in the same function, holding the canonical study it loaded itself. There is nothing to bind, because nothing crosses a trust boundary. Signing a value and verifying it four lines later in the same call stack is not a security control; it is a comment with a cryptographic budget. The aggregate route reached the same conclusion in slice N (`N5.2`) and replaced its receipt with `aggregateProvenance`.

### P9.2 What is deleted

From `src/lib/synthesisReceipt.ts`: `RECEIPT_VERSION`, `AUDIENCE`, `ISSUER`, `canonicalize`, `digest`, `createSynthesisReceipt` (`:36-72`), `verifySynthesisReceipt` (`:74-138`) and the v2 compatibility branch (`:117-127`). The `jose` import goes; check whether `jose` is still used by `auth.ts` before touching `package.json` — it is, so no dependency is removed.

**What survives**, and is the whole remaining file: `SynthesisProvenance`, `validBoundedText`, `validateProvenance` and `aggregateProvenance` — still called by `synthesis/aggregate/route.ts:162` and `generate-followup/route.ts:72`, and now also by `runInterviewAnalysis` to gate its own write. The file keeps its name with a rewritten header comment; renaming it to `provenance.ts` in the same diff that deletes a signing path is two reviews wearing one hat, and is listed in Deferred.

From `src/app/api/synthesis/route.ts`: the `createSynthesisReceipt` call (`:157-169`) and `_receipt` in the response (`:185`). Preview returns the bare synthesis.

From `src/lib/interviewSubmission.ts`: the `_receipt` requirement (`:133-135`) and the `& { _receipt: string }` intersections (`:121`, `:136`).

From `src/app/api/interviews/save/route.ts`: the `verifySynthesisReceipt` import and call, the 403, and the `const { _receipt, ...verifiedSynthesis }` destructure (`:138`).

### P9.3 What goes with it, in tests

- **`tests/unit/synthesisReceipt.test.ts`** — every case that signs or verifies a per-interview receipt is deleted; the `aggregateProvenance` cases stay in the file. If nothing remains, delete the file and move the provenance cases into `tests/unit/api.followup.provenance.test.ts`, which already exercises `validateProvenance` through a route.
- **`tests/unit/api.save.idempotent.test.ts`** — the `receiptMock` hoist (`:55-56`) and the `vi.mock('@/lib/synthesisReceipt')` go; `:128-143` loses `expect(verifySynthesisReceipt).not.toHaveBeenCalled()`; `:189-220` ("stores signed generation-time provenance when provider resolution changes before save") is **deleted outright** — the fact it protects no longer exists, because save writes no provenance at all. Its replacement lives at P16 on the analysis writer.
- **`tests/unit/api.synthesis.telemetry.test.ts`** — the two refund cases (`:218`, `:234`) are deleted with the refund helper; the evidence-telemetry cases are rewritten to run as `isAdmin`.
- **`tests/e2e/research-workflow.spec.ts`** — see P16.

---

## P10. `src/lib/interviewAnalysis.ts` (new)

One exported function, called from two places and nowhere else.

```ts
export type RunAnalysisOutcome =
  | { status: 'complete' } | { status: 'already-complete' } | { status: 'busy' }
  | { status: 'failed'; failureKind: InterviewAnalysisFailureKind }
  | { status: 'not-found' };

export async function runInterviewAnalysis(input: {
  interviewId: string;
  study: StoredStudy;
  kvClient: RedisPort;
  providerKeys: ProviderKeys;
  platformAuthority?: { researcherId?: string | null; participantSessionId?: string };
}): Promise<RunAnalysisOutcome>
```

Sequence, and nothing else:

1. `claimInterviewAnalysis`. Anything but `claimed` returns immediately, with no provider call. This is the concurrency gate; it is first.
2. `getInterviewChecked` for the transcript, profile and behaviour. A record that vanished between claim and read returns `not-found`.
3. `getInterviewProvider(study.config, providerKeys)` → `provider.synthesizeInterview(...)`, with the same four arguments `synthesis/route.ts:151-156` passes.
4. `validateProvenance` on `result.execution`. A result that does not name the provider and model that actually ran is `invalid-output` (AGENTS.md).
5. `attachInterviewAnalysis`. `too-large` and `unavailable` map to `failed`/`'too-large'` and `failed`/`'storage'` respectively; `stale` returns `busy` without a second write.
6. Any throw from step 3 → `recordInterviewAnalysisFailure(..., 'provider')`; a validation throw → `'invalid-output'`. **The caught error is passed to `logRequestFailure`, which is the only thing that ever sees it**, and never to the record.
7. Evidence telemetry, counts only, in a swallowing `try` — lifted verbatim from `synthesis/route.ts:170-184` with `route: '/api/interviews/[id]/analyze'`.

The function never throws and never loops.

---

## P11. UI

### P11.1 `src/lib/analysisState.ts` (new)

```ts
/**
 * The one derivation of an interview's analysis state. Legacy records (saved
 * before Slice P) carry no `analysis` member; their status is read off the
 * synthesis the server itself wrote, which is a stored fact about the record,
 * not an inference from a different one.
 */
export function analysisStatus(interview: Pick<StoredInterview, 'analysis' | 'synthesis'>):
  InterviewAnalysisStatus {
  if (interview.analysis) return interview.analysis.status;
  return interview.synthesis ? 'complete' : 'pending';
}

export function isAwaitingAnalysis(interview: …): boolean {
  const status = analysisStatus(interview);
  return status === 'pending' || status === 'running' || status === 'failed';
}
```

Every read surface calls this. **No component reimplements the derivation**, and no component reads `interview.analysis?.status` directly.

### P11.2 `InterviewDetail.tsx`

The Analysis tab's `interview.synthesis ? … : <p>No analysis available for this interview.</p>` (`:266-286`) becomes a four-way switch on `analysisStatus(interview)`:

- **`complete`** — today's reading and footer, unchanged. The footer gains one clause when the analysis ran under a different revision than the interview: `analyzed at study rev N`, appended through `ProvenanceFooter`'s existing `note` prop, which needs no edit.
- **`pending`** — `Analysis pending` as a `Notice tone="neutral"`, body `This interview was saved. Its analysis has not run yet.`, plus a `Run analysis` primary button.
- **`running`** — `Analysis running` as a `Notice tone="neutral"`, body `An analysis started {relative time}. Give it a moment, then reload.` The `Run analysis` button is present but disabled until the lease elapses, at which point the row reads `pending` on the next load anyway.
- **`failed`** — `Analysis failed` as a `Notice tone="error"`, body one sentence per `failureKind`, and a `Run analysis` button. The copy names the kind and nothing else:

| kind | body |
|---|---|
| `provider` | `The model provider did not return an analysis. This is not an analysis — run it again.` |
| `invalid-output` | `The model returned something this study could not read as an analysis. Run it again.` |
| `too-large` | `The analysis was too large to store. Run it again, or shorten the study's topic areas.` |
| `timeout` | `The analysis did not finish in time. Run it again.` |
| `storage` | `The analysis could not be saved. Run it again.` |

The `This is not an analysis` construction mirrors the participant flow's `This is not an AI reply` (DIRECTION §9, keep list) and is the same refusal to fabricate.

**Attempt counts are not printed.** `attempts: 3` on a researcher's screen is a number they cannot act on; the button is the action. The count exists on the record for support and for the register's sort, not for display.

### P11.3 `Dashboard.tsx`

The existing `Status` column (`:315-317`, cell `:369-373`) prints `interview.status`, which is `completed` for every row and has been telling the researcher nothing. It becomes the analysis column:

| `analysisStatus` | cell |
|---|---|
| `complete` | `analyzed` |
| `pending` / `running` | `awaiting analysis` |
| `failed` | `analysis failed`, in `text-error` |

The header stays `Status`. Slice O's `Conducted` and `Synthesized` model columns (O7.1) are unchanged and keep their `lg:table-cell` breakpoint; `Synthesized` reads `not recorded` for an un-analyzed interview, which is now a common and correct state rather than a legacy one.

### P11.4 `StudyDetail.tsx`

**The header count** (`:423`) gains a second clause when any interview is awaiting analysis:

> `12 interviews · 3 awaiting analysis`

computed from one `useMemo` beside `eligibleInterviewCount` (`:63-66`), over data already in state.

**The batch action** sits on the Interviews tab, above the register, only when the awaiting count is non-zero:

> `Analyze 3 pending` — a `variant="primary"` button, disabled while `operationPending` or a batch is running, label `Analyzing 2 of 3…` in flight.

**The register** gains one `Analysis` column at `md:table-cell`, same vocabulary as P11.3. A failed row's cell is `text-error`.

**The aggregate footer needs no change.** P2.12: `covers N of M interviews` already fires whenever a stored aggregate covers fewer interviews than the eligible set, and un-analyzed interviews are simply not eligible. `tests/unit/StudyDetail.aggregate.test.tsx:198-222` already pins that clause and must keep passing untouched.

**The `interviews.length < 2` gate on the Analyze All button** (`:488`) becomes `eligibleInterviewCount < 2`, and the prompt at `:535-538` reads `Need at least 2 analyzed interviews to generate aggregate analysis.` The old gate would have offered a button that the route refuses at `aggregate/route.ts:76-85` — a real bug the moment un-analyzed interviews exist.

---

## P12. The thank-you screen

Answers the owner's addendum of 2026-09-05: *"maybe we should provide a template, but also allow researchers to have like the thank you screen, right? And they have questions or they have concerns, they can reach out to the researcher at whatever email. So a proper thank you screen."*

### P12.1 Four more repo facts

21. **`researcherContact` already exists and is deliberately unverifiable.** `StudyConfig.researcherContact` (`types.ts:129-135`) is optional free text, bounded at 200 characters (`studyConfigValidation.ts:27,197-200`), documented as "deliberately not format-validated: the server cannot verify a contact, so it must never be presented as verified". It renders in two places today: the consent footer (`Consent.tsx:132-134`) and the receipt's `Researcher contact` row (`Synthesis.tsx:220-222`) — **the only `<dl>` row that opts out of mono**, via a `mono: false` special case.
22. **The placeholder refusal lives only in the create/update validators.** `validateStudyConfigForCreate:221` and `validateStudyConfigUpdate:249` run `CONSENT_TEXT_PLACEHOLDER`; plain `validateStudyConfig` does not. That matters because `loadCanonicalStudy` calls the plain one on **every participant request** (`canonicalStudy.ts:45`). A new *required* config field would 503 every study saved before this slice.
23. **`consentText` is frozen at save because a hash binds it.** `useStudyDraft.ts:223` substitutes `defaultConsentText(researchQuestion)` when the field is blank, and `save/route.ts:119` feeds the stored string to `verifyParticipantConsent`, whose consent hash covers it. **No hash binds a thank-you screen**, so it must *not* be frozen.
24. **A researcher cannot reach the participant's saved state, in any mode.** `Synthesis.tsx:202` gates the participant branch on `viewMode === 'participant'`, and a preview save returns `{ preview: true }` (`save/route.ts:155-162`) which `:103` maps to `saveStatus: 'preview'` → `participantState: 'save-failed'`. There is therefore **no participant-preview surface to watermark**; P12.5 answers "where does the researcher see it" a different way.

### P12.2 The field

```ts
  /**
   * Optional. The researcher-authored screen a participant reads once their
   * interview is saved. Absent means "render the generated default" — and
   * unlike `consentText` it is deliberately NOT frozen into the record at save
   * time, because no consent hash binds it and a stored copy would freeze one
   * deployment's default forever.
   */
  thankYouText?: string;
```

`studyConfigValidation.ts`: `'thankYouText'` joins `STUDY_CONFIG_FIELDS` (`:29-49`), `MAX_THANK_YOU_TEXT_LENGTH = 4_000` joins the constants (a screen, not the 20 000-character legal sheet consent is), and the shape check sits beside `researcherContact`'s at `:197-200`:

```ts
  if (value.thankYouText !== undefined
    && !isBoundedString(value.thankYouText, MAX_THANK_YOU_TEXT_LENGTH, true)) {
    return { ok: false, error: 'Thank-you screen must be 4000 characters or fewer' };
  }
```

and the placeholder refusal joins the two create/update guards only, guarded on presence:

```ts
  if (result.ok && result.config.thankYouText !== undefined
    && BRACKETED_PLACEHOLDER.test(result.config.thankYouText)) {
    return { ok: false, error: THANK_YOU_TEXT_PLACEHOLDER_ERROR };
  }
```

**Optional, not required — this is fact 22 made load-bearing.** Making it required would take every study in production offline for participants the moment this deploys.

### P12.3 The default and the template are two different artifacts

New `src/lib/thankYouText.ts`:

```ts
import { BRACKETED_PLACEHOLDER } from './consentText';

/**
 * What a participant reads when the researcher wrote nothing. Complete prose,
 * interpolated from the study, and containing no placeholder — the same rule
 * `defaultConsentText` follows, for the same reason.
 */
export function defaultThankYouText(studyName: string): string {
  return [
    'Thank you for taking part.',
    `Your responses have been saved and will be used in the study "${studyName.trim()}".`,
    'You can close this tab now.',
  ].join('\n\n');
}

/**
 * A starting point the researcher presses once and then edits. It is the only
 * path by which brackets enter a draft, and saving it unedited is refused.
 */
export const THANK_YOU_TEMPLATE = [
  'Thank you for taking part in [study name].',
  'Your responses have been saved. [Say what happens next: when the study closes, whether you will share findings, how long the data is kept.]',
  'You can close this tab now.',
].join('\n\n');

export const THANK_YOU_TEXT_PLACEHOLDER_ERROR =
  'The thank-you screen cannot contain a bracketed placeholder such as [study name]. Replace it with the words participants should read.';
```

`consentText.ts` renames its regex export to `BRACKETED_PLACEHOLDER` — it was never about consent — and keeps `export const CONSENT_TEXT_PLACEHOLDER = BRACKETED_PLACEHOLDER` so `studyConfigValidation.ts:7` and `tests/unit/consentText.test.ts:2` compile untouched. One regex, in the module that already owns it.

**Why the default has no brackets and the template does.** Whatever a researcher gets by doing nothing must be finished prose a participant can read — that is exactly why `defaultConsentText` interpolates the research question instead of shipping `[research topic]`. The bracketed version is an authoring affordance, and the create/update refusal is what stops a researcher from forgetting they pressed it.

### P12.4 What the participant reads

`Synthesis.tsx`, `participantState === 'saved'` only, between the safe-to-close sentence and the K2 receipt block:

```tsx
<Verbatim as="h1" …>Interview submitted</Verbatim>
<p … role="status" aria-live="polite">Your responses have been saved. It is now safe to close this tab.</p>

<Verbatim as="div" className="max-w-measure whitespace-pre-wrap text-[19px] leading-[31px] text-ink-700">
  {studyConfig.thankYouText?.trim() || defaultThankYouText(studyConfig.name)}
</Verbatim>
{studyConfig.researcherContact ? (
  <p className="font-sans text-[15px] leading-[24px] text-ink-700">
    Questions or concerns? Contact:{' '}
    <span className="text-ink-900">{studyConfig.researcherContact}</span>
  </p>
) : null}

<Rule className="mt-2" />
{/* …the K2 <dl>, unchanged except for P12.4's last bullet… */}
```

- **The heading and the safe-to-close sentence stay first, verbatim.** They are the fail-closed confirmation, they are on DIRECTION §9's keep list, and they are resolved by name or by full text in `research-workflow.spec.ts:66-67`, `Synthesis.register.test.tsx:79`, `Synthesis.completion.test.tsx:61-62,82` and throughout `Synthesis.lifecycle.test.tsx`. A participant learns their words are safe before they read anything else. Open question 5 asks whether the owner wants the thank-you to lead instead; that is a keep-list change and needs their word, not mine.
- **Serif at 19/31** — the participant's own reading register (DIRECTION §3), because this is a person writing to a person. It is the same law that sets the consent sheet in serif, and it makes the thank-you the only reading-register block on the page, which is where the eye settles.
- **`whitespace-pre-wrap`, never markdown.** `ConsentSection.tsx:16` sets the precedent. Rendering researcher-authored text as markdown would let a stored study put a link on a participant's screen.
- **The contact line is omitted when absent, never fabricated, and never linkified.** No `mailto:`, because `researcherContact` is free text the server cannot verify (fact 21) and an anchor presents an unverified string as an actionable address.
- **The `<dl>` loses its `Researcher contact` row** (`Synthesis.tsx:220-222`). The contact now has a sentence that tells the participant what to do with it; the `<dl>` goes back to being what `Coordinate` is for — machine-verifiable facts in mono. That row was already the only one passing `mono: false`, which was the tell that it never belonged there.
- **No icon, no `Disclosure`, no wine, no ochre.** `Synthesis.register.test.tsx:82-92` asserts zero `svg` and zero `role="note"` in the saved state and must keep passing.
- **The other two participant states get nothing.** Thanking someone on `save-failed` would thank them for an interview that is not saved.

### P12.5 Where it is edited, and where a researcher sees it

**Its own section**, `src/components/studySetup/ThankYouSection.tsx`, `id="thank-you-text"`, label `Thank-You Screen`, placed immediately after `ConsentSection`. Not folded into the consent section: a `Section` has one `Edit` control and one read sheet (`Section.tsx:15-35`), and two independently authored texts, read at opposite ends of the participant's journey, would have to share both.

**Read view** — the same `bg-paper-2` serif sheet as `ConsentSheet` (`ConsentSection.tsx:12-21`), labelled `What participants will read after they finish`, rendering `draft.thankYouText.trim() || defaultThankYouText(draft.name)` and the contact line under the same absent-means-omitted rule. **This read view is the preview.** Fact 24 says no participant-preview surface reaches the saved state, so the setup sheet is where a researcher checks their own copy — exactly as they already check their consent text, and with the same watermarking as the rest of the setup document.

**Edit body** — a `Field` with a `rows={4}` textarea, hint `Leave blank to use a default. Square brackets are not allowed — participants read this text exactly as written.`, plus one `Button variant="quiet"` reading `Insert a template` that sets the draft to `THANK_YOU_TEMPLATE`.

`useStudyDraft.ts` gains `thankYouText` state and `setThankYouText` beside `researcherContact` (`:81`, `:189`, `:206`, `:239`), and one line in `buildConfig` beside `:225`:

```ts
    ...(thankYouText.trim() ? { thankYouText: thankYouText.trim() } : {}),
```

**Not** `|| defaultThankYouText(...)`, which is what the consent line one row above does. Fact 23 is the difference: a blank field stays absent and the default is applied at render, so improving the default improves every study that never overrode it.

### P12.6 Tests

- **`tests/unit/thankYouText.test.ts`** — `defaultThankYouText` names the study, trims it, and contains no `[`; `THANK_YOU_TEMPLATE` contains one and `BRACKETED_PLACEHOLDER` matches it; the two are never equal.
- **`tests/unit/studyConfigValidation.test.ts`**, beside the `researcherContact` block at `:193-226` — create and update both refuse a `thankYouText` containing `[study name]` with `THANK_YOU_TEXT_PLACEHOLDER_ERROR`; both accept it absent; both accept 4 000 characters and refuse 4 001. **And the guard that matters: plain `validateStudyConfig` accepts a config with no `thankYouText` *and* one carrying a bracketed value** — a study saved before this slice must still serve participants (fact 22).
- **`tests/unit/Synthesis.receipt.test.tsx`** — saved state with no `thankYouText` renders the default and the document contains no `[`; with one, renders it verbatim including its line breaks; with a `researcherContact`, renders `Questions or concerns? Contact:` exactly once and no `a[href^="mailto:"]`; without one, that string is absent and nothing replaces it; the `Researcher contact` `<dl>` row at `:105` is gone; `finalizing` and `save-failed` render no thank-you text.
- **`tests/unit/StudySetup.document.test.tsx`** — a `Thank-You Screen` section with its own `Edit` control; its read sheet renders the default for a blank draft; `Insert a template` fills the textarea with bracketed text and saving then surfaces the placeholder error.
- **`tests/e2e/research-workflow.spec.ts`**, in the rewritten participant journey (P16) — the default thank-you text is visible on the receipt, and `await page.locator('body').innerText()` contains no `[`.

---

## P13. Export

- **Per-interview JSON already carries it.** `export/route.ts:120` and `InterviewDetail.tsx:97` serialize the whole record, so `synthesis: null` and the `analysis` object appear in both with no edit. This is the brief's requirement, met by doing nothing.
- **`summary.csv` gains one column**, appended after the last existing one so `cells[6]` stays put (`tests/unit/api.export.csvFormulas.test.ts:106`) — and after slice O's two, if O has landed:

  ```ts
  'Interview ID,Study,Date,Duration (min),Messages,Themes,Key Insight,…,Analysis',
  ```

  with `csvCell(analysisStatus(interview))`. `Themes` and `Key Insight` are already `0` and `''` for an interview with no synthesis (`:133-134`), which is correct and needs no edit.
- **`generateTranscript`** (`:24-84`) is unchanged. Its analysis section is already conditional on `interview.synthesis`.
- **The aggregate export is untouched.**

---

## P14. Migration

**Yes, derived at read time, and it is not a guess.** Every record written before this slice has a non-null synthesis, because the save route refused without a verified receipt (P2.3) and the receipt's digest covered the synthesis. So `synthesis !== null` is a stored fact the server itself wrote, and reading `complete` off it is a derivation, not an inference.

This is deliberately the opposite call from slice O11, and the difference is worth naming: O refuses to fill a missing `conductedByModel` from `study.config.aiModel` because that reads a **different record** whose value may have changed since. P14 reads the **same record's own field**, written by the same route in the same transaction. One is inference across a boundary; the other is arithmetic.

No backfill: no migration script, no `demoData.ts` edit (P2.19 — its three interviews carry syntheses and derive `complete`), no `makeStoredInterview` change (`tests/fixtures/models.ts:54` already defaults `synthesis: null`, so every fixture interview derives `pending`, which is the right default for a slice about pending analyses).

The derivation is executed in exactly two places: `analysisStatus()` for every read surface, and the Lua claim path (P6.2), so a legacy record cannot be re-analyzed by a claim that failed to notice its synthesis.

---

## P15. Telemetry

One new event name in `REQUEST_LOG_EVENT_ALLOWLIST` (`requestLog.ts:23-29`): `'interview.analysis'`, logged once per `runInterviewAnalysis` with `route`, `operation` (`'deferred'` or `'researcher'`), `status`, and `reason` for a failure — reusing the existing `reason` field, whose allowlist (`:31-43`) already contains `unavailable`, `invalid` and `too-large`; add `provider-failure` and `timeout` to it. `rateLimit.refund` is **removed** from the event allowlist with its helper (P3.3).

No new allowlisted field. No interview id, no study id, no model output, no error text. `tests/unit/requestLog.test.ts` gains the two allowlist assertions it already makes for every other member.

---

## P16. Tests

### Must keep passing, unchanged

- **`tests/unit/kv.atomicPersistence.test.ts`** in full, especially `:105` (hosted key arity), `:126` (Finish ZADDs once, derives lock/count, deletes the guard last), `:150` (duplicate equivalence ignores request `Date.now`) and `:157` (Finish uses the frozen guard). The persist protocol does not move in this slice; if this file moves, the analysis writer reached into it.
- **`tests/unit/StudyDetail.aggregate.test.tsx`** in full, especially the anchored footer regexes at `:166`, `:191` and the `covers N of M` case at `:198-222`. P11.4 adds a column and a button, not a footer clause.
- **`tests/unit/api.save.evidenceRefs.test.ts`** — rewritten only where it asserts a `_receipt`; both cases must still prove that a new-shape and a legacy-shape synthesis survive the round trip, now through `attachInterviewAnalysis` rather than save.
- **`tests/unit/evidence.test.ts`, `evidence.aggregate.test.ts`, `api.aggregate.citations.test.ts`, `api.aggregate.revision.test.ts`, `kv.aggregatePersistence.test.ts`, `api.followup.provenance.test.ts`** in full.
- **`tests/unit/api.participant.canonicalContext.test.ts`** in full — the canonical-study authority rules are untouched.
- **`tests/unit/Synthesis.lifecycle.test.tsx`** — every submission-identity, StrictMode-replay and stale-attempt case must survive. The two analysis-failure cases (`:225-257`) move to the preview branch or are deleted with the participant states they describe; **everything else in the file is the contract that P3.1 promises not to break.**
- **`tests/unit/Synthesis.register.test.tsx`** — the three surviving participant states keep their level-1 headings, zero icons, zero `role="note"` and zero `stone-*` classes. The `analysis-failed` case at `:104-114` is deleted with the state.
- **`tests/unit/wire.persist.test.ts`, `wire.authority.test.ts`, `wire.account.test.ts`** in full — a new family must not perturb an existing one.
- **`tests/unit/Dashboard.idColumn.test.tsx`, `StudyDetail.register.test.tsx`, `StudyDetail.participantLinks.test.tsx`, `InterviewDetail.trace.test.tsx`, `Export.mode.test.tsx`, `DemoSimulation.*`** in full.

### Rewritten, and why

1. **`tests/unit/api.save.idempotent.test.ts`** — the receipt mock and the generation-time-provenance case go (P9.3). Every remaining case drops `_receipt` from its body and gains, on the persisted object, `analysis: { status: 'pending', attempts: 0, lastAttemptAt: expect.any(Number) }` and `synthesis: null`. The hand-computed fingerprint at `:404-416` loses `synthesis`, `aiProvider`, `aiModel`, `requestedAiModel`, `routedProvider` and gains slice O's two conducting keys. The `after` call is mocked at the module boundary; the deferred callback is not exercised here.
2. **`tests/unit/Synthesis.completion.test.tsx`** — `:63` becomes "shows participants a safe-to-close confirmation as soon as the save succeeds, with no synthesis call": assert `synthesizeInterview` is never called and `saveCompletedInterview` is called once with `synthesis: null`. `:77` (save failure, retry, then success) stands as written — storage retry is still the participant's.
3. **`tests/unit/api.synthesis.telemetry.test.ts`** — every case runs as `isAdmin`; the two refund cases are deleted; one new case asserts a participant token gets 403 without a provider call.
4. **`tests/unit/api.export.csvFormulas.test.ts`** — one appended cell; every existing `cells[n]` index at `:88`, `:99`, `:106` is unchanged by construction.
5. **`tests/e2e/research-workflow.spec.ts`** — the participant choreography at `:53-70` is rewritten; see the last bullet below.

### New, smallest realistic regressions

- **`tests/unit/api.save.noSynthesis.test.ts`** — *the headline test of the slice.* With `synthesizeInterview` mocked to reject and no `_receipt` anywhere in the body, a participant save returns 200 with `created: true`, `persistCompletedInterview` is called once with `synthesis: null` and `analysis.status === 'pending'`, and the response body mentions no analysis. **Provider down, participant saved.**
- **`tests/unit/interviewAnalysis.idempotent.test.ts`** — the concurrency contract, against mocked kv primitives:
  - two `runInterviewAnalysis` calls in one `Promise.all` produce exactly **one** `synthesizeInterview` call and exactly **one** `attachInterviewAnalysis` call; the loser returns `busy`.
  - a run whose `attach` returns `stale` makes no second write attempt.
  - a run against a record already `complete` makes no provider call at all.
  - a provider throw records `failureKind: 'provider'` and the thrown value appears nowhere in the arguments passed to `recordInterviewAnalysisFailure`.
  - an oversized synthesis records `'too-large'` and never reaches `client.eval`.
- **`tests/unit/kv.analysisAttach.test.ts`** — the script surface: `claimInterviewAnalysis` sends one `eval` with exactly one key and the `claim` op; `attachInterviewAnalysis` refuses above `MAX_ATTACHED_SYNTHESIS_BYTES` **before** resolving a client (spy on `resolveClient` or on `eval`); each wire tag maps to its documented result; an unknown tag maps to `unavailable`.
- **`tests/unit/api.analyze.authority.test.ts`** — *the tenancy test.* A researcher authorized for `study-b` requesting `POST /api/interviews/<id-in-study-a>/analyze?studyId=study-b` gets **404** and no provider call; the same request with `?studyId=study-a` gets 401/403 from `getAuthorizedResearcherStudyContext` and no provider call; a missing `studyId` gets 400 in both modes.
- **`tests/unit/analysisState.test.ts`** — the derivation: a record with `analysis` returns its status; a legacy record with a synthesis returns `complete`; a legacy record with `synthesis: null` returns `pending`; `isAwaitingAnalysis` is true for all three of pending, running, failed.
- **`tests/unit/InterviewDetail.analysis.test.tsx`** — each of the four states renders its heading and, for the three non-complete ones, a `Run analysis` button; the `failed` notice carries `role`-appropriate error tone; **no state renders a `SynthesisReading` when `synthesis` is null**; the five `failureKind` bodies each render exactly once for their kind.
- **`tests/unit/StudyDetail.analysisBatch.test.tsx`** — with three interviews of which one is `pending` and one `failed`, the header reads `3 interviews · 2 awaiting analysis`, the button reads `Analyze 2 pending`, pressing it issues exactly two POSTs **sequentially** (assert ordering, not just count), and the register updates. With every interview analyzed, neither the clause nor the button renders. With one analyzed interview, `Analyze All Interviews` is disabled and the prompt names *analyzed* interviews.
- **`tests/unit/wire.analysis.test.ts`** — every `analysis` tag parses at its declared arity; wrong arity, coerced payload, non-array and unknown tag all map to `unavailable`; a `persist` tag is refused by the `analysis` family and vice versa.
- **`tests/integration/redis.crashCuts.test.ts`** — one added case against disposable Redis: claim, then attach, on a record whose transcript contains an **empty array** and an empty string, and assert the untouched members round-trip byte-identically (this is the `patch_json_object` property, and real Redis `cjson` is the only place it is genuinely exercised). No new fault cut is registered; `assertFaultCutsCovered()` must still pass untouched.
- **`tests/e2e/research-workflow.spec.ts`** — the rewritten journey, and the one that answers the owner directly:
  1. Participant one completes the conversation with `workflow.failNextSynthesis = true` set **before** pressing the finish button. Assert the `Interview submitted` heading and `Your responses have been saved. It is now safe to close this tab.` **appear anyway**, and that no `Retry finalization` control exists anywhere on the page.
  2. Reload; the receipt still renders; no second save.
  3. Participant two completes normally, with `interruptStorageAfterSynthesis` replaced by a storage fault at save time so `Retry save` is still exercised — the participant's one remaining retry.
  4. Researcher opens participant one's interview: the Analysis tab reads `Analysis pending` or `Analysis failed` and offers `Run analysis`.
  5. Press it. The interview's analysis completes, the reading renders, and the provenance footer names the **study's** model — `expect(interview.aiModel).toBe(studyModel)`, where `studyModel` is the model the study was created with — the concrete consequence of `feat/synthesis-uses-study-model`, which deleted the per-provider synthesis constants the spec previously imported here.
  6. `Analyze All Interviews` then succeeds, and every existing aggregate-citation assertion (`:110-125`) passes unchanged.

  `workflow-fixture.ts` needs no new switch: `failNextSynthesis` (`:124-126`) already fires on the next synthesis-shaped call whenever it happens, which is now a server-initiated one.

Do not snapshot any component in this slice.

---

## P17. What of slice O survives, and what this slice supersedes

The brief expected O's "Conducted vs Synthesized" split to mostly dissolve once synthesis uses the study model. **It does the opposite.** With slice P, an analysis can run days after the save — after a config edit that advanced the revision. `conductedByModel` is the config at save; `aiModel` is the model that actually produced the synthesis, at analysis time. They now diverge in a realistic, common case that could not occur before, and the two columns become genuinely two facts rather than one fact printed twice.

**Survives unchanged:** the `conductedByProvider`/`conductedByModel` fields and their doc comments (O4); the save-route write and its place in the fingerprint (O5, with P5.2's key list); the `ConductingModelsNotice` multi-model reminder on both tabs (O8, Ruling 1); the Dashboard's two model columns (O7.1); `ProvenanceFooter`'s `conductedBy` clause (O6); the never-infer-from-current-config rule (O11) and its greps (O14).

**Superseded by this slice:**

- **O7.2's reasoning is now false.** "Within one study the synthesis model is a per-provider constant and cannot vary unless the provider changed" no longer holds: it is the study's model, and it can vary across analyses. StudyDetail's interview register therefore gains a `Synthesized` column alongside `Conducted`, at the same `md:table-cell` breakpoint. The column O declined is the column P needs.
- **O3.3's honest limit is halved.** `Conducted by` is still the model that was *asked for*; `Synthesized by` is still provider-reported. That asymmetry stands. But both now name models the researcher chose, so the footer's two clauses are finally about the same kind of thing.
- **O13's `api.save.idempotent.test.ts` rewrite is absorbed** into P16's larger rewrite of the same file. Implement O's fingerprint keys and P's removals in one pass.
- **O's open question 3** (a mid-interview edit silently ending a participant's session) is untouched and still open.

---

## P18. Verification

Three change-map rows are tripped: **Completion and export**, **Storage/tenancy**, **Researcher UI**.

```bash
# Completion and export
npx vitest run tests/unit/api.save.idempotent.test.ts tests/unit/api.save.noSynthesis.test.ts \
  tests/unit/api.save.evidenceRefs.test.ts tests/unit/interviewAnalysis.idempotent.test.ts \
  tests/unit/api.analyze.authority.test.ts tests/unit/api.synthesis.telemetry.test.ts \
  tests/unit/Synthesis.completion.test.tsx tests/unit/Synthesis.lifecycle.test.tsx \
  tests/unit/Synthesis.register.test.tsx tests/unit/Synthesis.receipt.test.tsx \
  tests/unit/api.export.csvFormulas.test.ts tests/unit/Export.register.test.tsx \
  tests/unit/thankYouText.test.ts tests/unit/consentText.test.ts \
  tests/unit/studyConfigValidation.test.ts tests/unit/StudySetup.document.test.tsx

# Storage and wire
npx vitest run tests/unit/kv.atomicPersistence.test.ts tests/unit/kv.analysisAttach.test.ts \
  tests/unit/kv.aggregatePersistence.test.ts tests/unit/kv.persistGuard.delete.test.ts \
  tests/unit/wire.analysis.test.ts tests/unit/wire.persist.test.ts \
  tests/unit/wire.malformedMatrix.test.ts tests/unit/wire.registry.test.ts

# Researcher UI and the derivation
npx vitest run tests/unit/analysisState.test.ts tests/unit/InterviewDetail.analysis.test.tsx \
  tests/unit/InterviewDetail.reading.test.tsx tests/unit/Dashboard.register.test.tsx \
  tests/unit/StudyDetail.analysisBatch.test.tsx tests/unit/StudyDetail.aggregate.test.tsx \
  tests/unit/StudyDetail.register.test.tsx tests/unit/SynthesisReading.test.tsx \
  tests/unit/rateLimit.participant.test.ts tests/unit/platformAiRateLimit.test.ts \
  tests/unit/requestLog.test.ts
```

Then the proportional full gate:

```bash
npm run check
DEPLOYMENT_MODE=standalone npm run build
DEPLOYMENT_MODE=hosted AI_TRANSPORT=direct npm run build
npm run test:e2e
npm run test:redis-crash
npm run test:adversarial
git diff --check
```

`test:redis-crash` and `test:adversarial` are **required** here, unlike slice O: this slice adds a Lua script and a wire family, and real-wire round-tripping of a patched interview value is the only evidence that `patch_json_object` preserves the record.

Then the greps, each of which must return no output except where noted:

```bash
grep -rn "_receipt" src/                                  # no output
grep -rn "createSynthesisReceipt\|verifySynthesisReceipt" src/ tests/   # no output
grep -rn "refundParticipantRateLimit\|REFUND_LIMITS_SCRIPT" src/ tests/ # no output
grep -rn "analysis?.status\|analysis\.status" src/components/           # no output: use analysisStatus()
grep -rn "interview.synthesis ?" src/components/                        # no output: use analysisStatus()
grep -rn "export const maxDuration" src/app/api/                        # exactly two: save and analyze
grep -rn "after(" src/app/api/                                          # exactly one: the save route
grep -rn "mailto" src/components/ src/lib/thankYouText.ts               # no output
grep -rn "defaultThankYouText" src/                                     # exactly two: Synthesis.tsx, ThankYouSection.tsx
npm run lint
```

The fourth and fifth are the derivation guard: a component that branches on `synthesis` truthiness has reimplemented P14 and will disagree with the Lua on the next legacy record.

Then by hand, at **375px** and 1280px, with a study whose provider key is deliberately wrong so analysis fails:

- Complete a participant interview through a real `/p/<token>` link. The receipt appears with no perceptible wait and no mention of analysis.
- `/dashboard` — the Status column reads `awaiting analysis`; no horizontal body scroll at 375px.
- `/studies/<id>` — the header reads `1 interview · 1 awaiting analysis`; the batch button is present; the Interviews register's Analysis cell is legible at 375px.
- `/dashboard/interview/<id>` → Analysis — the failed notice wraps rather than overflowing at 375px; `Run analysis` is at least 44px tall.
- Fix the key, press `Run analysis`, and confirm the reading and the footer render without a reload.
- `/setup?prefill=edit&studyId=<id>` → Thank-You Screen: the read sheet renders in serif at measure; `Insert a template` fills the field; saving unedited surfaces the placeholder error; the saved screen then matches the sheet.

---

## Hard constraints

- **The participant never waits on a provider call to make their interview durable.** Any implementation where a save is gated on a synthesis has missed the slice.
- **The submission fingerprint covers no analysis field and no synthesis.** P5.2.
- **Two runs never both write.** The claim CAS is the first thing `runInterviewAnalysis` does and the only gate.
- **`runInterviewAnalysis` is the only function that calls `synthesizeInterview` for a stored interview**, and it lives in one module called from exactly two places.
- **No provider error text, message, status line or payload reaches a stored record, a response body, or a screen.** Only `InterviewAnalysisFailureKind`.
- **The analysis state is derived in exactly two places**: `analysisStatus()` and the Lua claim path.
- No new Redis key, no new prefix, no delete-cascade arity change, no new fault cut. One new script, one new wire family.
- No new npm dependency. `jose` stays for `auth.ts`.
- Wine and ochre appear nowhere in this slice. The pending/running notices are `tone="neutral"`; the failed notice is `tone="error"`.
- **`thankYouText` is optional in `validateStudyConfig` and placeholder-checked only on create/update.** A required field, or a placeholder check on the read path, takes every existing study offline for participants.
- **No bracketed placeholder ever reaches a participant**, and `researcherContact` is never linkified, never format-validated, and never rendered when absent.
- Do not commit; leave the working tree for review. npm only, Node ≥ 24.19.

## Deferred, do not attempt

- **Renaming `synthesisReceipt.ts` to `provenance.ts`** once it holds only provenance. Housekeeping, its own diff.
- **Automatic retry of a failed analysis.** No backoff schedule, no cron, no queue. A `failed` record waits for a researcher.
- **A server-side batch route.** P8.2.
- **Deleting `AGGREGATE_*` receipt machinery**, already named as deferred in slice N.
- **Re-analysis of an already-complete interview** (a "Re-run analysis" button on a `complete` record). The claim path refuses it by design; offering it means deciding whether the old synthesis is kept, which is a records question, not a UI one.
- **Analysis at a pinned historical config.** P7.3 records the revision the analysis ran under; reconstructing the config it *should* have run under needs a per-study config history, which slice O already deferred.
- **Real turn-time execution provenance** (slice O's deferred item), and a dynamic model list from each provider's `models` endpoint.
- **Backfilling any record or `demoData.ts`.**

---

## Open questions for the owner

1. **Should a researcher be able to analyze an interview saved at an older study revision, or should that be refused?** The spec allows it and records `analysis.studyRevision` so the footer can say the analysis ran under a newer config. Refusing instead would make every pending interview permanently unanalyzable the moment the researcher fixes a typo in the research question, which seems worse — but it means a study can end up holding analyses produced under two different prompts, and the aggregate mixes them. The alternative is to refuse and offer the researcher a "revert to rev N to analyze" path, which is a different feature.

2. **`maxDuration = 120` on the save route: is the deployment on a plan that allows it?** The value is asserted in code and enforced by the platform. If the account's ceiling is lower, the deferred analysis will be cut short more often and more interviews will land on the researcher's `Run analysis` button — correct behaviour, but a worse default. This changes only the number, not the design, and I need the plan's actual ceiling to pick it.

3. **Should the participant's receipt say anything at all about the analysis?** The spec says no, on the grounds that it is a process the participant has no stake in and cannot influence, and that promising it creates an expectation the system may not meet. The counter-argument is a consent one: a participant who consented to "your interview will be analyzed" may reasonably want confirmation that it will be. If the answer is yes, the honest sentence is `Your researcher will review this interview.` and it costs one line — but it changes the K2 receipt, whose copy is currently on the keep list.

5. **Should the thank-you text lead the saved screen instead of following the confirmation?** The spec puts `Interview submitted` and `Your responses have been saved. It is now safe to close this tab.` first, because they are the fail-closed confirmation and both are on DIRECTION §9's keep list, with the researcher's words immediately beneath in the reading register. A "proper thank-you screen" might reasonably open with the thank-you and demote the system's sentence to a line under it. That is a keep-list change and four test suites resolve those strings, so it needs an explicit ruling rather than my judgement.

4. **Is `Status` the right header for the Dashboard's new analysis column, or should the existing `completed`/`in_progress` value keep it?** Today's column is dead — every stored interview is `completed`. Reusing the header avoids adding an eighth column to a register that already sheds four below 1024px. But `status` also names a real field on the record, and a future `in_progress` feature would want it back.
