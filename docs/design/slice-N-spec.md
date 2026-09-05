# Slice N — Persist the aggregate synthesis (Storage train, first slice)

Implements **D8**'s real fix from `docs/design/initiative-3-brief.md`: the aggregate synthesis becomes a stored record in the researcher's own database instead of a value in one browser tab's `useState`. Decision of record 5 deferred exactly this to "the next Storage train, with its own spec and the Storage gates". This is that spec.

The letter is reused. `initiative-3-brief.md` decision 4 struck a *different* Slice N (the `WithMargin` margin unfold, Move B4). That slice was never built and no file carries its name; B4 remains struck and is not revived here.

Context to read before implementing, in order: `AGENTS.md` in full — "Storage and tenancy", every "Non-negotiable invariant", the change map's Storage/tenancy and Completion-and-export rows, and the `tests/integration/` tier; `README.md`'s storage and privacy sections; `docs/design/slice-L-spec.md` (the aggregate shapes, `validateResolvedAggregateSynthesis`, the round-trip hazard L2.7, the receipt fixed point L1.5); `docs/design/slice-I-spec.md` §I3.2 (`ProvenanceFooter`'s grammar and props).

**Prime directive.** *A paid model call is never lost, and a stored record never claims more than it is.* The route stores what it just verified, and if the write fails it still returns the result with the footer that says it was not stored. The reader states what the stored aggregate covers — how many interviews, at which study revision — as a fact, next to the timestamp, and never regenerates anything on its own, because regenerating costs the researcher money.

---

## N1. Laws that bind this slice

1. **"Browser-supplied study configuration, provider/model choice, identity, timestamps, synthesis, and ownership are untrusted"** (AGENTS.md). After this slice no route accepts an aggregate synthesis from a browser at all. The server writes the object it built and reads back its own copy. This is the invariant's strongest available form, and it is what makes N9's rewrite of `generate-followup` a hardening rather than a convenience.
2. **"Completion persistence and study mutation remain atomic and idempotent under retries and concurrency"** (AGENTS.md). The aggregate write is a single `SET` of one prefixed string: there is no torn value and no multi-key prefix to leave half-written. Concurrency is last-writer-wins, and N12 says why that is correct for this record and would not be for an interview.
3. **"Hosted study create/delete is a durable cross-database operation. Preserve the operation marker/tombstone and reconciliation protocol"** (AGENTS.md). The aggregate key is deleted *inside* `DELETE_EMPTY_STUDY_SCRIPT`, so both the route and `studyOperationReconciler` inherit the cascade with no new call site and no new ordering to get wrong (N6).
4. **"Study revision, link status, ownership, consent, rate limits, and storage uncertainty fail closed"** (AGENTS.md). A read that cannot decide is `unavailable` and surfaces as 503 with `retryable: true`, never as "no analysis exists". A stored value that does not decode is treated as absent, which is the closed direction for a cache.
5. **Research data lives in the researcher-owned database.** The aggregate is reached only through `gated.context.kvClient`, the same client that loaded the study and the interviews it summarizes. The platform control-plane Redis never holds an aggregate and never learns one exists.
6. **"Evidence citation matching (render-time classification; verdicts never stored)"** (AGENTS.md architecture map). Unchanged. The stored aggregate carries claims plus server-resolved interview ids, exactly what Slice L signs today. No `EvidenceMatch`, no verdict, no `quotedFromRecord` is ever written.
7. **No genre vocabulary** in copy, labels, `aria-label`s, or comments: no "apparatus", "colophon", "marginalia", "concordance".

---

## N2. Repo facts this spec is built on

Verified by reading source at spec time on `main` at `31ddc58`, with Initiative 3 slices H, K, I, L and M applied. Re-verify any that look stale.

1. **The aggregate is returned and then dropped.** `src/app/api/synthesis/aggregate/route.ts:186` returns `{ synthesis: { ...fullResult, _receipt: receipt } }` and writes nothing. `StudyDetail.tsx:36` holds it in `useState` and `:269` sets it. There is no read path.
2. **Slice I's footer is unconditional.** `StudyDetail.tsx:499-508` passes `verb="generated"` and `note="not saved — regenerate to refresh"` with no condition, because `slice-I-spec.md` §I3.2 correctly observed there was no state in which the aggregate *was* saved. This slice creates that state.
3. **Key and value prefixes are two separate conventions.** Key prefixes are bare (`interview:`, `study:`, `study-interviews:`, `study-operation-result:`, `study-mutation-guard:`, `study-persisting:`, `interview-persisting:` — `kv.ts:18-27,802-804`). Stored values carry an `oi:` type prefix (`oi:interview:`, `oi:study:`, `oi:fp:`, `oi:pguard:`, `oi:receipt:`, `oi:smg:` — `kv.ts:23-26,805-806`) and are decoded through `parsePrefixedJson` (`src/lib/wire/parse.ts:93-106`). The new key follows both.
4. **A study with interviews cannot be deleted.** `DELETE_EMPTY_STUDY_SCRIPT` returns `{'oi:conflict'}` when `SCARD` on the study-interview index is non-zero (`kv.ts:1454-1456`), and `deleteInterview` (`kv.ts:704-716`) has **zero callers in `src/`**. So an orphan aggregate is today unreachable by construction — an aggregate needs two interviews (`aggregate/route.ts:76`) and two interviews block the delete. The cascade in N6 is therefore not repairing a live bug; it is refusing to depend on an accident of two unrelated invariants.
5. **The delete script is arity-checked per mode.** `#KEYS ~= 5` hosted, `#KEYS ~= 6` standalone (`kv.ts:1384-1389`), against the two key arrays at `kv.ts:1554-1569`. Adding a key means editing all four places; nothing else indexes those arrays.
6. **Fault cuts are real, and the manifest is enforcing.** `injectNamedProductionFailpoint` (`src/lib/redisNodeAdapter.ts:93-103`) rewrites a production script to `do return {'oi:failpoint'} end` after the last `-- fault cut <id>` comment, so writes before the marker commit and the caller sees `unavailable`. `assertFaultCutsCovered()` (`tests/helpers/faultManifest.ts:52-57`) fails the run for any id in `FAULT_CUTS` without a `coverFaultCut` call, and it runs at the end of `tests/integration/redis.crashCuts.test.ts:860-864`.
7. **`npm run test:redis-crash` runs exactly one file** — `tests/integration/redis.crashCuts.test.ts` — and `npm run test:adversarial` runs exactly three (`package.json:29-30`). A new file under `tests/integration/` would be executed by neither. This slice therefore extends `redis.crashCuts.test.ts` rather than adding a file (N13).
8. **Every command this slice needs already exists on the port.** `RedisPort` declares `get`, `set`, `del` and `eval` (`src/lib/redisPort.ts:15-20`), the node-redis test adapter implements the same interface, and the new key is written with a plain `SET` and deleted inside an existing `eval`. **No new Redis command, no new wire family, no new tag** — `src/lib/wire/types.ts:99-197` is untouched, and so are `parse.ts` and `registry.ts`.
9. **Account deletion never touches BYOS research keys by prefix.** `src/lib/platformDb.accountDelete.ts` plans operations over platform records (`researcher:`, `participant-link:`, `create-idemp:`, `study-op-receipt:` — `:336-361`) plus a client eviction. It enumerates no researcher-database key, so it needs no change and gains no new orphan.
10. **The studies list loads every study record.** `loadOwnedStudies` → `loadAllowedStudies` (`src/lib/ownedStudies.ts:115-126,146-160`) calls `getStudyChecked` once per owned study, up to `MAX_OWNED_STUDIES = 1_000` (`:14`). This is the decisive argument against storing the aggregate inside `StoredStudy` (N4.1).
11. **`storageService.getStudy` has exactly one consumer.** `StudyDetail.tsx:94`. (`getStudy` in `kv.ts` has server callers at `api/studies/[id]/route.ts:123`, `canonicalStudy.ts:38`, `researcherContext.ts:623,721`; those are the server function, not the browser client.)
12. **`generate-followup` already re-derives everything except content.** It rebuilds `studyId`, `studyRevision`, `interviewIds`, `interviewCount` and all four provenance fields from the parent study and the verified receipt (`generate-followup/route.ts:113-126`), and it re-checks every id against the current eligible set (`:105-112`). Only `providerSynthesis` — the content fields — comes from the body. Reading the stored record replaces the body and deletes the receipt step; every other check survives verbatim.
13. **The aggregate receipt's only verifier is that one line.** `verifyAggregateSynthesisReceipt` is called from `generate-followup/route.ts:70` and nowhere else in `src/`. `createAggregateSynthesisReceipt` is called from `aggregate/route.ts:160` and nowhere else. Both are 1-hour HS256 tokens (`synthesisReceipt.ts:203`) whose whole job is securing a browser round trip.
14. **`createAggregateSynthesisReceipt` is also the provenance gate.** It calls the private `validateProvenance` and throws `Aggregate synthesis provenance is incomplete` when the object does not name a known provider/model pair (`synthesisReceipt.ts:188-189`). That throw is the only thing enforcing AGENTS.md's last invariant on the aggregate path, and it must survive the receipt's removal (N5.2).
15. **`readBoundedJsonObject(request, 256_000)`** is the existing bound on an aggregate crossing the wire (`generate-followup/route.ts:50`). That number is reused as the stored-value ceiling (N4.4). The aggregate route's own body bound is `4_096` (`aggregate/route.ts:25`) and does not change — its body is one `studyId`.
16. **Provider validation caps do not bound the record usefully.** `MAX_PROVIDER_LIST_ITEMS = 100`, `MAX_PROVIDER_TEXT = 20_000` (`providerValidation.ts:32-33`), applied to `commonThemes`, `divergentViews`, `keyFindings` and `researchImplications` (`:284,303` and the list helper). The worst-case valid aggregate is several megabytes. A byte ceiling on the encoded value is not optional.
17. **The export is workspace-wide, not study-scoped.** `GET /api/interviews/export` takes no study id; hosted resolves `inspection.allowedIds` and standalone calls `getAllInterviewsChecked(context.kvClient, 500)` (`export/route.ts:136-191`). Distinct study ids are derivable from the loaded interviews in both modes without a second authority query.
18. **Three unit suites mock `@/lib/kv` with an explicit object literal** and will call `undefined(...)` the moment a route imports a new kv function: `api.aggregate.revision.test.ts:19-25`, `api.followup.provenance.test.ts:20-24`, `api.export.csvFormulas.test.ts:24-28`. Each needs the new function added to its mock (N13).
19. **`_receipt` is never stored on an interview.** `save/route.ts:138` destructures it off and `:188` stores `verifiedSynthesis`. That is the precedent this slice follows exactly: verify, strip, store the verified facts.
20. **The e2e suite boots real handlers against disposable Redis.** `tests/e2e/server.mjs` plus `workflow-fixture.ts` intercept only provider and Upstash HTTP; the application's own storage calls are real. Persistence therefore works in `research-workflow.spec.ts` with no fixture change, and a page reload is a genuine end-to-end proof.

---

## N3. The shapes (`src/types.ts`)

```ts
export interface AggregateSynthesisResult {
  // ... unchanged through generatedAt ...
  /**
   * Server clock at the moment this aggregate was written to the researcher's
   * database. Present exactly when the record is stored: a response carrying
   * no `savedAt` was generated and not saved, and the footer says so. Never
   * client-supplied.
   */
  savedAt?: number;
  _receipt?: string;            // Server-signed aggregate content and provenance
}

/**
 * The aggregate as it is stored: the verified facts, no receipt, plus the
 * server's write timestamp. `save/route.ts:138` is the precedent — a signature
 * whose job is discharged is not part of the record it secured.
 */
export type StoredAggregateSynthesis =
  Omit<AggregateSynthesisResult, '_receipt'> & { savedAt: number };
```

`AggregateSynthesisResult` gains one optional field and loses nothing. `AggregateTheme`, `AggregateQuoteClaim`, `AggregateThemeClaim` and `AggregateSynthesisProviderPayload` are untouched — Slice L's shapes are the stored shapes.

**N3.1 `savedAt` is the only "is it stored" bit.** There is no sibling `saved: boolean` on the response envelope. The object is what survives into `useState`, into the reload, and into the zip; a flag on the envelope would be a second source of truth for a fact the object already carries, and only one of the two would still be true after a page load. Every consumer asks `synthesis.savedAt !== undefined`.

---

## N4. Storage (`src/lib/kv.ts`)

### N4.1 One aggregate per study, latest replaces, its own key

**Cardinality: one.** Not a history. A history needs a member index, a listing endpoint, a retention rule, and a UI that lets a researcher choose among versions — none of which exists or is asked for — and it grows without bound inside a database the deployment does not own and cannot prune. The aggregate is a cache of one model call over the whole current-revision interview set; the honest recovery for "I want the old one" is that there is no old one, and the honest recovery for "I want a current one" is the button. **Latest replaces.**

**Its own key, not a field on `StoredStudy`.** Embedding it would make the delete cascade and the atomic write free (both come from the study CAS scripts and `studyJsonLua.ts`), which is genuinely attractive. It is rejected because `loadAllowedStudies` reads *every* owned study record to render the studies list (N2.10): a workspace with fifty analyzed studies would ship fifty aggregates on every list load, and `replaceStudyConfigAtomic` would rewrite a multi-hundred-kilobyte JSON value on every config edit. The list payload and the study-mutation path are both hot; the aggregate is cold and read on exactly one screen.

```ts
export const STUDY_AGGREGATE_PREFIX = 'study-aggregate:';
export const AGGREGATE_VALUE_PREFIX = 'oi:aggregate:';
```

Key: `study-aggregate:<studyId>`, in the same database as `study:<studyId>` and `interview:<id>` — the researcher-owned Redis in hosted mode, the deployment's Upstash in standalone. Reached only through the `RedisPort` a gated request context hands over.

### N4.2 Encode and decode

```ts
export function encodeAggregateValue(aggregate: StoredAggregateSynthesis): string {
  return `${AGGREGATE_VALUE_PREFIX}${JSON.stringify(aggregate)}`;
}

/**
 * A stored aggregate that does not decode is absent. The `studyId` check is a
 * key/value mixup guard; the `_receipt` check is a structural refusal — a
 * receipt in the record means something other than this route wrote it.
 */
function decodeStoredAggregate(value: unknown, studyId: string): StoredAggregateSynthesis | null {
  const parsed = parsePrefixedJson(value, AGGREGATE_VALUE_PREFIX);
  if (!parsed.ok) return null;
  const rec = parsed.payload;
  if (rec.studyId !== studyId) return null;
  if ('_receipt' in rec) return null;
  if (!Number.isSafeInteger(rec.studyRevision) || (rec.studyRevision as number) < 0) return null;
  if (!Number.isSafeInteger(rec.savedAt) || !Number.isSafeInteger(rec.generatedAt)) return null;
  if (!Array.isArray(rec.interviewIds) || rec.interviewIds.length === 0) return null;
  if (rec.interviewIds.some(id => typeof id !== 'string' || id.length === 0 || id.length > 200)) return null;
  if (rec.interviewCount !== rec.interviewIds.length) return null;
  if (!Array.isArray(rec.commonThemes) || !Array.isArray(rec.divergentViews)) return null;
  if (!Array.isArray(rec.keyFindings) || !Array.isArray(rec.researchImplications)) return null;
  if (typeof rec.bottomLine !== 'string') return null;
  if (typeof rec.aiProvider !== 'string' || typeof rec.aiModel !== 'string') return null;
  return parsed.payload as unknown as StoredAggregateSynthesis;
}
```

Shaped after `decodeStoredInterview` (`kv.ts:115-127`) and deliberately structural only. `kv.ts` imports `@/types`, `./wire/*`, `./rateLimit`, `./requestLog`, `./studyJsonLua`, `./mode`, `./kvClient` and `./redisPort` and nothing else; it does not import `providerValidation`, and this slice does not make it. Deep content validation of a stored aggregate happens where the content is *used* — in `generate-followup`, through `validateResolvedAggregateSynthesis` (N9.3).

### N4.3 Read

```ts
export type AggregateLoadResult =
  | { status: 'found'; aggregate: StoredAggregateSynthesis }
  | { status: 'not-found' }
  | { status: 'unavailable' };

export async function getStudyAggregateChecked(
  studyId: string,
  client?: RedisPort,
): Promise<AggregateLoadResult> {
  try {
    const kv = resolveClient(client);
    const raw = await kv.get(`${STUDY_AGGREGATE_PREFIX}${studyId}`);
    const decoded = decodeStoredAggregate(raw, studyId);
    return decoded ? { status: 'found', aggregate: decoded } : { status: 'not-found' };
  } catch (error) {
    logRequestFailure({ event: 'kv.unavailable' }, error);
    return { status: 'unavailable' };
  }
}
```

Three states, mapped by callers exactly like `getStudyChecked`/`mapStudyLoad`: `unavailable` is 503 with `retryable: true`, never 404 (Law 4). There is no unchecked `getStudyAggregate` twin — every caller in this slice is a request handler and every one of them must distinguish "no analysis" from "storage did not answer".

### N4.4 Write

```ts
/**
 * The serialized ceiling for one stored aggregate. The same number as
 * generate-followup's request bound (route.ts:50) — the largest aggregate this
 * deployment has ever been willing to move over a wire. Provider caps allow a
 * valid aggregate several megabytes wide (MAX_PROVIDER_LIST_ITEMS ×
 * MAX_PROVIDER_TEXT), so a byte ceiling is load-bearing, not belt-and-braces.
 */
export const MAX_STORED_AGGREGATE_BYTES = 256_000;

export type SaveAggregateResult = 'saved' | 'too-large' | 'unavailable';

export async function saveStudyAggregate(
  aggregate: StoredAggregateSynthesis,
  client?: RedisPort,
): Promise<SaveAggregateResult> {
  if (!STUDY_ID_TOKEN.test(aggregate.studyId)) return 'unavailable';
  const value = encodeAggregateValue(aggregate);
  if (new TextEncoder().encode(value).byteLength > MAX_STORED_AGGREGATE_BYTES) return 'too-large';
  try {
    const kv = resolveClient(client);
    await kv.set(`${STUDY_AGGREGATE_PREFIX}${aggregate.studyId}`, value);
    return 'saved';
  } catch (error) {
    logRequestFailure({ event: 'kv.unavailable' }, error);
    return 'unavailable';
  }
}
```

- **One `SET`, no options, no TTL, no Lua.** A single-key `SET` of one string cannot leave a torn value: Redis either has the old value or the new one. There is no multi-key prefix here, so there is no fault cut to name on the write path.
- `STUDY_ID_TOKEN` (`kv.ts:807`) is the same id guard `deleteStudy` applies, so a malformed id can never construct a key.
- `new TextEncoder().encode(...).byteLength` rather than `Buffer.byteLength`, matching `requestBody.ts:16` and keeping the module free of Node globals.
- The size refusal happens **before** the client is resolved. An oversized aggregate costs no Redis round trip and no BYOS acquire.
- Both non-`saved` results are recoverable by the caller and never destructive: the previous stored aggregate, if any, survives a `too-large` or `unavailable` write untouched.

---

## N5. The write path (`src/app/api/synthesis/aggregate/route.ts`)

**The route persists. The browser never posts an aggregate back.** The server has the resolved, provenance-checked object in hand at `:158`; sending it to a browser so the browser can send it back is the round trip `slice-L-spec.md` L2.7 identified as a rollout hazard, and the only reason it existed was that there was nowhere to put the object.

### N5.1 The diff, after `fullResult` is built (`:146-158`)

```ts
    // The provenance gate that createAggregateSynthesisReceipt used to apply
    // as a side effect of signing. A record that does not name the provider
    // and model that actually ran is not storable (AGENTS.md).
    if (!aggregateProvenance(fullResult)) {
      return NextResponse.json(
        { error: 'Failed to generate aggregate synthesis' },
        { status: 500 },
      );
    }

    // Persist before responding, but never at the cost of the result: a write
    // that fails returns the aggregate anyway, without `savedAt`, and the
    // footer reads `not saved — regenerate to refresh`. The paid call is not
    // thrown away because Redis blinked.
    const savedAt = Date.now();
    const stored: StoredAggregateSynthesis = { ...fullResult, savedAt };
    const write = await saveStudyAggregate(stored, gated.context.kvClient);

    // ... telemetry block, unchanged ...

    return NextResponse.json({ synthesis: write === 'saved' ? stored : fullResult });
```

`fullResult` (`:146-158`) is unchanged, including `generatedAt: Date.now()`. `savedAt` is a second `Date.now()` taken at write time; the two differ by the storage round trip and the footer prints `savedAt`, because that is what the verb `saved` names.

### N5.2 The receipt is gone from this route

`createAggregateSynthesisReceipt(fullResult)` at `:160` is deleted, `_receipt` leaves the response at `:186`, and the import at `:16` goes. Its provenance half is preserved by one new export in `src/lib/synthesisReceipt.ts`:

```ts
/**
 * The aggregate provenance gate: null when the record does not name a known
 * provider and the model that actually ran. Exported because the aggregate is
 * now stored rather than signed, and the check outlived the signature.
 */
export function aggregateProvenance(
  synthesis: Omit<AggregateSynthesisResult, '_receipt'>,
): SynthesisProvenance | null {
  return validateProvenance(synthesis);
}
```

`createAggregateSynthesisReceipt` is rewritten to `const provenance = aggregateProvenance(synthesis);` so there is exactly one implementation. Nothing else in `synthesisReceipt.ts` changes: `AGGREGATE_AUDIENCE`, `AGGREGATE_RECEIPT_VERSION`, `createAggregateSynthesisReceipt` and `verifyAggregateSynthesisReceipt` all stay in the tree with their tests passing. After this slice they have no caller in `src/`; **deleting them is a named follow-up, not this slice** (Deferred), because removing signing code and its security tests in the same diff that changes a storage path is two reviews wearing one hat.

**Signing to discard was considered and rejected.** Keeping `createAggregateSynthesisReceipt` at `:160` purely for its throw would mint an HS256 token nobody verifies, and the next reader would reasonably conclude something downstream trusts it. A function named for the check is what the route actually needs.

### N5.3 What the route does not do

- It does not change authorization, `getStudyChecked`, `getStudyInterviewsChecked`, the two-interview minimum, `hostedAiRateLimitResponse`, provider resolution, `withRecordBackedEvidence`, the position→id resolution at `:130-143`, `providerErrorResponse`, or the 500 catch site.
- It does not read the existing stored aggregate before writing. There is nothing to merge and nothing to compare; see N12.
- It does not delete a stored aggregate on failure. A provider error leaves the previous analysis in place, which is what a researcher who just watched a retry fail expects to still be there.

---

## N6. Delete cascade (`src/lib/kv.ts`) and reconciliation

The aggregate key is deleted **inside `DELETE_EMPTY_STUDY_SCRIPT`**, not by the route. `deleteStudy` has two callers — the DELETE handler (`api/studies/[id]/route.ts:303`) and `studyOperationReconciler.ts:147` — and putting the cascade in the script means both inherit it, in the same atomic unit, with no ordering for either to get wrong. A route-level `del` before or after the script would be a second write with a crash window between them; that is the shape AGENTS.md warns about when it says a superficially simpler sequence reintroduces orphans.

### N6.1 Key arity

`deleteStudy` (`kv.ts:1554-1569`) appends the aggregate key to both arrays:

```ts
    const keys = hosted
      ? [ `${STUDY_PREFIX}${id}`, `${STUDY_INDEX_PREFIX}${id}`, receiptKey(markerId),
          mutationGuardKey(id), persistingKey(id), `${STUDY_AGGREGATE_PREFIX}${id}` ]
      : [ `${STUDY_PREFIX}${id}`, `${STUDY_INDEX_PREFIX}${id}`, ALL_STUDIES_KEY, receiptKey(markerId),
          mutationGuardKey(id), persistingKey(id), `${STUDY_AGGREGATE_PREFIX}${id}` ];
```

The arity guards at `kv.ts:1384-1389` become `#KEYS ~= 6` (hosted) and `#KEYS ~= 7` (standalone). Every other index in the script is unchanged; the new key is read through a mode-branched local, matching how the script already resolves `guardKey` and `persistSet`:

```lua
local aggregateKey
if mode == 'hosted' then
  aggregateKey = KEYS[6]
else
  aggregateKey = KEYS[7]
end
```

### N6.2 Placement and the new fault cut

Between the interview-conflict refusal (`kv.ts:1454-1456`) and the `EXISTS` branch (`:1458`):

```lua
if redis.call('SCARD', KEYS[2]) > 0 then
  return {'oi:conflict', 'oi:revision:0'}
end

-- The aggregate is a cache of a paid model call. Deleting it here means a
-- refused delete (the study still has interviews) never destroys it, and the
-- study record is never removed while its aggregate survives. A crash at D5
-- leaves a live study without its cached analysis, which the researcher can
-- regenerate; the reverse order would leave a value no code path can reach.
redis.call('DEL', aggregateKey)
-- fault cut D5: aggregate cache removed, study record still present
```

Three properties follow, in order of importance:

1. **No orphan is possible.** Every path that removes `study:<id>` passes this line first, including the `EXISTS == 0` branch that sweeps a study already gone, so a stale key left by any earlier partial state is cleaned on the next delete.
2. **A refused delete costs nothing.** The conflict return is above the `DEL`, so pressing Delete on a study with interviews leaves the analysis intact.
3. **The residue of a crash is harmless and named.** D5 leaves a study with no cached aggregate. The researcher sees the pre-analysis prompt and can re-run it.

`'D5'` joins `FAULT_CUTS` in `tests/helpers/faultManifest.ts:22` on the Delete line, and `assertFaultCutsCovered()` will fail the integration suite until N13's test covers it.

### N6.3 Replay and reconciliation

- The receipt-replay branches (`kv.ts:1419-1431`) return before the `DEL`. A `deleted` receipt only exists if a prior run wrote it, and the receipt is written *after* the deletes — so a replay that short-circuits has already had its aggregate removed. A `cancelled` receipt means the study was never deleted and its aggregate correctly survives.
- `studyOperationReconciler.finishThenDeletePendingStudy` (`:117-152`) calls `deleteStudy` and needs no edit. Orphan detection has nothing new to learn: the reconciler reasons about operation records and persist guards, and the aggregate is neither.
- Hosted account deletion is unaffected (N2.9).

---

## N7. The read path

### N7.1 A sibling endpoint, not the study payload

**New route: `GET /api/studies/[id]/aggregate`** (`src/app/api/studies/[id]/aggregate/route.ts`), a sibling of `participant-links/route.ts` in the same folder.

`GET /api/studies/[id]` is left alone. It is the study record's endpoint; an aggregate can be two hundred kilobytes, and folding it in would put the analysis behind the same payload as the config that four server call sites and the study page load. A sibling endpoint keeps `mapStudyLoad` and `storageService.getStudy` untouched, gives the aggregate its own 404 and 503, and costs no latency because the browser fetches all three in one `Promise.all`.

```ts
// GET /api/studies/[id]/aggregate - Read the stored aggregate synthesis
// Protected: Requires authenticated session and study read authority
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const gated = await getAuthorizedResearcherStudyContext(id, 'read');
    const denied = configurationRequiredResponse(gated);
    if (denied) return denied;
    if (!gated.authorized || !gated.context) {
      return NextResponse.json(
        {
          error: gated.error || 'Unauthorized',
          retryable: gated.retryable,
          ...(gated.code ? { code: gated.code } : {}),
        },
        { status: gated.statusCode ?? 401 },
      );
    }

    const loaded = await getStudyAggregateChecked(id, gated.context.kvClient);
    if (loaded.status === 'unavailable') {
      return NextResponse.json(
        { error: 'Analysis storage is temporarily unavailable.', retryable: true },
        { status: 503 },
      );
    }
    return NextResponse.json({ aggregate: loaded.status === 'found' ? loaded.aggregate : null });
  } catch (error) {
    logRequestFailure({
      event: 'route.failure',
      route: '/api/studies/[id]/aggregate',
      method: 'GET',
      status: 500,
      requestId: createRequestId(request.headers.get('x-request-id')),
    }, error);
    return NextResponse.json({ error: 'Failed to fetch aggregate analysis' }, { status: 500 });
  }
}
```

The gate is `getAuthorizedResearcherStudyContext(id, 'read')` — byte-identical to `GET /api/studies/[id]:49` and `aggregate/route.ts:43`. Absent is `{ aggregate: null }` with 200, not 404: "this study has no analysis yet" is the normal state of most studies, and it is what the reader renders as the pre-analysis prompt.

### N7.2 `src/services/storageService.ts`

```ts
export async function getStudyAggregate(id: string): Promise<AggregateSynthesisResult | null> {
  try {
    const response = await fetch(`/api/studies/${encodeURIComponent(id)}/aggregate`, { cache: 'no-store' });
    const data = await response.json().catch(() => ({})) as {
      aggregate?: AggregateSynthesisResult | null;
      code?: string;
      error?: string;
    };
    throwIfTypedStorageFailure(response, data);
    if (!response.ok) return null;
    return data.aggregate ?? null;
  } catch (error) {
    if (error instanceof StudyOperationPendingError || error instanceof ResearcherStorageUnavailableError) {
      throw error;
    }
    logRequestFailure({ event: 'route.failure' }, error);
    return null;
  }
}
```

Copied from `getStudy` (`:342-364`) with `cache: 'no-store'` added, matching the participant-links fetch in `StudyDetail.tsx:63`. `throwIfTypedStorageFailure` keeps the pending-operation and storage-unavailable paths behaving exactly as the other two loads do inside the same `Promise.all`.

### N7.3 `src/components/StudyDetail.tsx`

**`loadStudyData` (`:90-113`)** gains a third parallel load:

```tsx
      const [studyData, interviewData, aggregateData] = await Promise.all([
        getStudy(studyId),
        getStudyInterviews(studyId),
        getStudyAggregate(studyId),
      ]);
      setStudy(studyData);
      setInterviews(interviewData);
      setAggregateSynthesis(aggregateData);
      setAggregateOpenNotes({});
      setStorageUnavailable(null);
```

**`aggregateOpenNotes` reset rule: reset to `{}` whenever `setAggregateSynthesis` is called with a new object** — in `loadStudyData` above and in `handleGenerateAggregateSynthesis` (`:270`, unchanged). The keys are `${themeIndex}:${refIndex}` positions, so carrying them across a different aggregate would collapse an unrelated note. `{}` means every note open, matching `AggregateReading`'s `?? true` (`SynthesisReading.tsx:211`).

**The stored object needs nothing from the reading.** `AggregateReading` takes `AggregateSynthesisResult`; `savedAt` is an extra field it does not read, `_receipt` was already unread, and `resolveAggregateThemeEvidence` classifies at render time from `interviewIndex`, which `StudyDetail` builds from the loaded interviews (`:58`). A stored aggregate and a fresh one render through the same code path with no branch.

**Render order changes so a stored analysis is never hidden.** Today `:471-513` reads `interviews.length < 2 ? <msg> : aggregateSynthesis ? <reading> : <prompt>`. It becomes:

```tsx
            {aggregateSynthesis ? (
              /* the reading, follow-up block and footer, as below */
            ) : interviews.length < 2 ? (
              <p className="mt-3 text-[13px] text-ink-500">
                Need at least 2 interviews to generate aggregate analysis.
              </p>
            ) : (
              <p className="mt-3 text-[13px] text-ink-500">
                Click &quot;Analyze All Interviews&quot; to generate cross-interview insights.
              </p>
            )}
```

Both strings are verbatim from today. The button's `disabled={... || interviews.length < 2}` (`:464`) is unchanged, so the fewer-than-two case still cannot start a call; it just no longer suppresses a record that exists.

---

## N8. Staleness, binding, and the footer (`StudyDetail.tsx`)

A stored aggregate is bound to the `studyRevision` and the `interviewIds` it was built from. When a third interview lands or the researcher edits the study, the stored aggregate is **stale, not wrong**: it is a true statement about the two interviews at revision 3. The reader prints what it covers and stops there. **Nothing regenerates automatically**, because regeneration is a paid provider call and no interface may spend a researcher's money on a page load.

### N8.1 The derived values

```tsx
  // The same predicate the route filters on (aggregate/route.ts:72-74), so the
  // count in the footer is the count a re-analysis would actually cover.
  const eligibleInterviewCount = useMemo(
    () => (study ? interviews.filter(i => i.studyRevision === study.revision && i.synthesis).length : 0),
    [interviews, study],
  );
  const aggregateSaved = aggregateSynthesis?.savedAt !== undefined;
  const aggregateIsStale = Boolean(
    study && aggregateSynthesis && aggregateSynthesis.studyRevision !== study.revision,
  );
  const aggregateNote = (() => {
    if (!aggregateSynthesis) return undefined;
    if (!aggregateSaved) return 'not saved — regenerate to refresh';
    const facts: string[] = [];
    if (aggregateSynthesis.interviewCount < eligibleInterviewCount) {
      facts.push(`covers ${aggregateSynthesis.interviewCount} of ${eligibleInterviewCount} interviews`);
    }
    if (aggregateIsStale) facts.push(`study is now rev ${study!.revision}`);
    return facts.length > 0 ? facts.join(' · ') : undefined;
  })();
```

`ProvenanceFooter` joins its segments with ` · ` (`SynthesisReading.tsx:359-364`), so a two-fact note renders as two more segments in the same rule. The component is **not edited**.

### N8.2 The footer

```tsx
                <ProvenanceFooter
                  model={aggregateSynthesis.aiModel}
                  studyRevision={aggregateSynthesis.studyRevision}
                  timestamp={
                    Number.isFinite(aggregateSaved ? aggregateSynthesis.savedAt : aggregateSynthesis.generatedAt)
                      ? formatDate((aggregateSaved ? aggregateSynthesis.savedAt : aggregateSynthesis.generatedAt)!)
                      : 'time unrecorded'
                  }
                  verb={aggregateSaved ? 'saved' : 'generated'}
                  note={aggregateNote}
                />
```

The four lines it can print, verbatim:

```
Synthesized by gemini-2.5-flash · study rev 4 · saved Jan 2, 2026, 10:00 AM
Synthesized by gemini-2.5-flash · study rev 4 · saved Jan 2, 2026, 10:00 AM · covers 2 of 3 interviews
Synthesized by gemini-2.5-flash · study rev 3 · saved Jan 2, 2026, 10:00 AM · covers 2 of 3 interviews · study is now rev 5
Synthesized by gemini-2.5-flash · study rev 4 · generated Jan 2, 2026, 10:00 AM · not saved — regenerate to refresh
```

Rules:

1. **`not saved — regenerate to refresh` survives only for the persistence-failed response.** Character for character from `slice-I-spec.md` §I3.2. It is now conditional, and the condition is `savedAt === undefined`.
2. **The note states facts, not warnings.** No "stale", no "outdated", no colour, no icon. `covers 2 of 3 interviews` and `study is now rev 5` are both readings of the record.
3. **`covers N of M` is suppressed when `M <= N`.** A study edit can drop the eligible count below what the aggregate covered; `covers 3 of 0 interviews` is not a sentence, and `study is now rev 5` already carries that fact.
4. `formatDate` is `StudyDetail`'s existing local formatter (`:318-326`), unchanged — one screen, one date format.
5. `model || 'unrecorded model'` and `studyRevision ?? '—'` fallbacks live in `ProvenanceFooter` and are untouched.

### N8.3 The button

```tsx
                {isGeneratingAggregate
                  ? 'Analyzing...'
                  : aggregateSynthesis ? 'Re-analyze All Interviews' : 'Analyze All Interviews'}
```

The brief's phrasing was "Re-analyze". `Re-analyze All Interviews` keeps the original's object: the control is full-width at 375px (`className="w-full sm:w-auto"`, `:466`) and a bare verb on a wide button names nothing. `Analyzing...` is unchanged for both states — the work is the same work.

### N8.4 The follow-up control

`generate-followup` refuses an aggregate whose revision is behind the study's (`route.ts:86`, preserved at N9.2). A control that is guaranteed to fail is exactly the dishonest chrome this train exists to remove, so it is disabled with the reason in place of the helper sentence:

```tsx
                  <Button
                    variant="quiet"
                    onClick={handleGenerateFollowup}
                    disabled={operationPending || isGeneratingFollowup || aggregateIsStale}
                  >
                    {isGeneratingFollowup ? 'Generating...' : 'Create Follow-up Study'}
                  </Button>
                  <p className="mt-2 text-[13px] text-ink-500">
                    {aggregateIsStale
                      ? `Re-analyze first: this analysis was made at study rev ${aggregateSynthesis.studyRevision} and the study is now at rev ${study!.revision}.`
                      : 'Generate a new study based on gaps and patterns found in this analysis.'}
                  </p>
```

A *fewer-interviews* aggregate is **not** disabled. `generate-followup` only requires that every id it names is still eligible (`route.ts:105-112`), and a new interview arriving does not make an old one ineligible, so the call still succeeds and the follow-up is still built from real findings.

---

## N9. `generate-followup` reads the server's own copy

**The browser payload is dropped cleanly. No fallback release.** The route stops parsing a body, stops verifying a receipt, and loads the stored aggregate.

The dual path was considered and rejected. `slice-L-spec.md` L6.2 already demonstrates how a "one release" compatibility branch becomes permanent ("The legacy branch is permanent, not transitional"), and here the branch would keep alive the exact thing AGENTS.md's first invariant forbids — a browser-supplied synthesis — for the sake of a window bounded by a 1-hour receipt (`synthesisReceipt.ts:203`). The cost of the clean switch is that a researcher whose tab was open across the deploy, and who presses Create Follow-up Study on an aggregate generated before it, gets one honest error telling them to run the analysis again. No data is lost, nothing silently produces a wrong answer, and the button is the same button they would press anyway.

### N9.1 The tamper guarantee survives, stronger

`tests/unit/api.followup.provenance.test.ts:205-214` pins that browser-tampered aggregate content never reaches a provider. After this slice that is structurally true for *all* browser content, because none is read. The test is rewritten (N13) to assert the stronger property: a POST whose body carries a fabricated `bottomLine` and a fabricated `interviewIds` produces a call to `generateFollowupStudy` with the **stored** aggregate's content, or no call at all — the body is never consulted.

### N9.2 The diff

Deleted: the import of `readBoundedJsonObject` (`:16`) and `verifyAggregateSynthesisReceipt` (`:20`), and the whole block `:50-94` from `readBoundedJsonObject` through the provenance-comparison `409`. Added, in its place, after `parentStudy` is resolved at `:48`:

```ts
    const loadedAggregate = await getStudyAggregateChecked(parentStudy.id, gated.context.kvClient);
    if (loadedAggregate.status === 'unavailable') {
      return NextResponse.json(
        { error: 'Analysis storage is temporarily unavailable.', retryable: true },
        { status: 503 },
      );
    }
    if (loadedAggregate.status === 'not-found') {
      return NextResponse.json(
        { error: 'Run the aggregate analysis for this study before generating a follow-up.' },
        { status: 409 },
      );
    }
    const stored = loadedAggregate.aggregate;

    // Same three refusals as the receipt path enforced, now over a record the
    // server wrote: revision binding, complete provenance, and shape.
    if (stored.studyRevision !== parentStudy.revision) {
      return NextResponse.json(
        { error: 'Synthesis provenance does not match the current study.' },
        { status: 409 },
      );
    }
    const signedProvenance = aggregateProvenance(stored);
    if (!signedProvenance) {
      return NextResponse.json(
        { error: 'Stored analysis provenance is incomplete. Re-analyze this study.' },
        { status: 409 },
      );
    }
    let providerSynthesis;
    try {
      providerSynthesis = validateResolvedAggregateSynthesis(stored);
    } catch {
      return NextResponse.json({ error: 'Missing or invalid synthesis data' }, { status: 400 });
    }
    const interviewIds = stored.interviewIds;
```

`:96-126` — the interview load, the eligible-id check, and the `synthesis` assembly — are preserved **verbatim**, reading `stored` where they read `metadata`. `generatedAt` comes from `stored.generatedAt` with the existing `Number.isSafeInteger` guard. `:128-185` — rate limit, provider resolution, `generateFollowupStudy`, `followUpConfig` — do not change by one character.

### N9.3 Why `validateResolvedAggregateSynthesis` stays

The stored record lives in a database the researcher owns and can edit by hand. `decodeStoredAggregate` (N4.2) is structural; this is the route that feeds the object to a model, so it applies the full content validator that Slice L built for exactly this shape — including its refusal of a ref carrying `interviewIndex` instead of `interviewId`, which is how an unresolved payload is caught. The function keeps a real caller and a real job.

### N9.4 The browser stops sending a body

`StudyDetail.handleGenerateFollowup` (`:280-313`): the `headers` and `body` options are removed, leaving `fetch(url, { method: 'POST' })`. The `if (operationPending || !aggregateSynthesis)` guard at `:281` stays — the control only exists when an aggregate is on screen, and the alert is the belt-and-braces path.

---

## N10. Export (`src/app/api/interviews/export/route.ts`)

**The zip includes each study's stored aggregate, as a separate file.** An analysis the researcher paid for and can read on screen but cannot take with them is a hole in the data-out path, and the export already carries every transcript and every per-interview synthesis, so the aggregate introduces no new privacy boundary. `Export.tsx` and the markdown/CSV generators are not edited — the aggregate is JSON, next to the interview JSON, and is not summarized into `summary.csv`.

```ts
async function loadStudyAggregates(
  interviews: StoredInterview[],
  kvClient: RedisPort,
): Promise<Map<string, StoredAggregateSynthesis> | 'unavailable'> {
  const aggregates = new Map<string, StoredAggregateSynthesis>();
  for (const studyId of new Set(interviews.map(interview => interview.studyId))) {
    const loaded = await getStudyAggregateChecked(studyId, kvClient);
    if (loaded.status === 'unavailable') return 'unavailable';
    if (loaded.status === 'found') aggregates.set(studyId, loaded.aggregate);
  }
  return aggregates;
}
```

`buildExportResponse(interviews, aggregates)` gains the second parameter and one loop after the per-interview files (`:99-105`):

```ts
  for (const [studyId, aggregate] of aggregates) {
    zip.file(`aggregates/${studyId}.json`, JSON.stringify(aggregate, null, 2));
  }
```

- **Study ids come from the interviews already loaded**, so neither mode needs a second authority query and the hosted path stays inside `inspection.allowedIds` by construction. Interviews are already capped at 500, so the distinct-study loop is bounded by that.
- **`unavailable` fails the export closed** — 503 with `retryable: true`, the same body shape `mapCollectionLoad` produces for an unavailable interview load. Law 4 does not carve out caches, and the researcher can retry.
- The stored object already carries `savedAt`, `studyRevision`, `interviewIds`, `interviewCount` and all four provenance fields, so the file is self-describing with no extra assembly.
- A study with no aggregate contributes no file. There is no empty `aggregates/` directory and no placeholder.

---

## N11. Telemetry and logging

**No new event, no new field, no `src/lib/requestLog.ts` edit.** The AGENTS.md "Structured request logs" row is not tripped.

- A failed aggregate write logs `{ event: 'kv.unavailable' }` from inside `saveStudyAggregate`, which is what every other storage failure in `kv.ts` does; `logRequestFailure` already sanitizes the error.
- A failed read logs the same from `getStudyAggregateChecked`.
- The new GET route's catch site logs `route.failure` with `route: '/api/studies/[id]/aggregate'`, matching every sibling handler.
- The `synthesis.evidence` block in `aggregate/route.ts:165-184` is unchanged and still counts only. **Counts only, ever**: no quote, no theme name, no bottom line, no interview id, no study id in a log line (ADR-003).
- The stored aggregate is never logged, in whole or in part, on any path.

---

## N12. Atomicity, idempotency and concurrency

**Two researchers, or one researcher in two tabs, pressing Analyze at the same time: last writer wins, and that is correct here.** Both calls run the full provider request against the same current-revision interview set and produce two aggregates that differ only in wording and `generatedAt`. Whichever `SET` lands second is the stored record; the other browser holds an equally valid aggregate whose `savedAt` says it was stored, and a reload replaces it with the winner. Nothing is lost that was not a duplicate of the same paid question.

This is deliberately weaker than the interview persist path, and the difference is the point: an interview is an immutable participant record where a lost write destroys data no one can reproduce, so `persistCompletedInterview` carries a fingerprint, a guard, an idempotency replay and a two-phase Lua commit. An aggregate is a derived cache of a repeatable call. Giving it a CAS or a guard would add a failure mode ("someone else is analyzing, try later") to buy consistency between two answers to the same question.

- **The write cannot tear.** One `SET`, one key, one string (N4.4). There is no state in which a reader sees half of an aggregate.
- **The write is idempotent under retry.** Re-running the same route with the same inputs overwrites with an equivalent value; there is no counter to double-increment and no set to double-add.
- **The value is bounded** at `MAX_STORED_AGGREGATE_BYTES`, checked before any client is touched.
- **A stale reader is bounded by one page load.** `StudyDetail` reads the aggregate in `loadStudyData`, which also runs after `runReconciliation` (`:120-122`).
- **Nothing in the delete path can interleave badly.** The `DEL` is inside the delete script, and a `SET` that lands after a completed delete would require a route to be mid-flight on a study that just became undeletable-then-deleted; the aggregate route re-resolves authority and loads the study before the provider call, and the residue would be swept by the `EXISTS == 0` branch on the next delete (N6.2).

---

## N13. Tests

### Must keep passing, unchanged

- **`tests/unit/kv.atomicPersistence.test.ts`** in full, including `:353`'s `deleteStudy('study-delete', client)` expectation. The delete script gains one key and one `DEL`; every outcome it returns is unchanged. If this file moves, the arity edit was wrong.
- **`tests/unit/kv.createDeleteReceipts.test.ts`, `kv.mutationSerialization.test.ts`, `kv.persistGuard.delete.test.ts`, `kv.checkedCollections.test.ts`** in full. Receipts, mutation guards, persist guards and collection loading are untouched.
- **`tests/unit/api.study.operationSaga.test.ts`** and **`tests/unit/studyOperationReconciler.test.ts`** in full. Both mock `deleteStudy` itself, so the script's new key is invisible to them, and that is the correct level for a saga test.
- **`tests/unit/api.study.deleteNoGetShortcut.test.ts`, `api.studies.reconcile.test.ts`, `api.study.createOwnership.test.ts`, `api.study.createIdempotency.test.ts`** in full.
- **`tests/unit/synthesisReceipt.test.ts`** in full, including `:205`'s empty-`commonThemes` aggregate. `createAggregateSynthesisReceipt` and `verifyAggregateSynthesisReceipt` keep their behaviour exactly; only the private provenance check is now reached through an exported name.
- **`tests/unit/SynthesisReading.test.tsx`** in full. `ProvenanceFooter` and both readings are not edited; the `verb="generated"` + `note` case still passes because the props did not change, only the values `StudyDetail` supplies.
- **`tests/unit/AggregateReading.citations.test.tsx`, `evidence.aggregate.test.ts`, `evidence.test.ts`, `aggregateSchema.roundTrip.test.ts`, `prompts.aggregateCatalogue.test.ts`, `api.aggregate.citations.test.ts`** in full. Slice L's chain — prompt, schema, validator, resolution, matching, rendering — is not touched by persistence. `api.aggregate.citations.test.ts` needs the mock addition below but no assertion change.
- **`tests/unit/StudyDetail.register.test.tsx`, `StudyDetail.participantLinks.test.tsx`, `InterviewDetail.reading.test.tsx`, `InterviewDetail.trace.test.tsx`, `Export.register.test.tsx`, `Export.mode.test.tsx`, `requestLog.test.ts`, `api.synthesis.telemetry.test.ts`** in full.
- **`tests/unit/hosted.sharedByos.adversarial.test.ts`** everything except the two additions below.
- **`tests/e2e/demo-no-provider.spec.ts`** in full — the keyless demo still makes no request.

### Rewritten by this slice, and why

1. **`tests/unit/api.aggregate.revision.test.ts`** — `kvMock` (`:19-25`) gains `saveStudyAggregate: vi.fn()`, defaulted to `'saved'` in `beforeEach`, or the route calls `undefined(...)`. The receipt assertion at `:132-134` and the `receiptMock` at `:39-40` are replaced: `createAggregateSynthesisReceipt` is no longer called, so mock `@/lib/synthesisReceipt` with `aggregateProvenance: vi.fn(() => ({ aiProvider: 'gemini', aiModel: '…', requestedAiModel: '…' }))` and assert instead that `saveStudyAggregate` was called once with an object whose `studyId`, `studyRevision`, `interviewIds` and resolved `commonThemes[0].quoteRefs[0].interviewId` match, and whose `savedAt` is a safe integer. `:121`'s `toHaveBeenCalledWith(study.config, [synthesis, synthesis], 2)` and `:128`'s body `toMatchObject` pass unchanged apart from `_receipt` leaving the response. Add: the response `synthesis.savedAt` is present when the write returns `'saved'`, and **absent** when it returns `'unavailable'` or `'too-large'` — with the aggregate itself still returned and the status still 200. That pair is the prime directive's direct regression.
2. **`tests/unit/api.followup.provenance.test.ts`** — the deepest rewrite in the slice, and it must end up asserting *more*. `kvMock` gains `getStudyAggregateChecked: vi.fn()`; `receiptMock` becomes `{ aggregateProvenance: vi.fn() }`. The `aggregate` fixture (`:44-58`) drops `_receipt` and gains `savedAt`, and is returned from `getStudyAggregateChecked` rather than posted. `request(synthesis)` becomes `request()` with no body. Cases: current-revision provenance still reaches the provider (`:122`); a stored aggregate whose refs carry `interviewId` is accepted and one carrying `interviewIndex` is rejected 400 before any provider call (`:149,:164`, now over the stored record — the `validateResolvedAggregateSynthesis` guard of N9.3); a stored `interviewIds` containing an old-revision id is 409 before any provider call (`:195`); `status: 'not-found'` is 409 and `status: 'unavailable'` is 503, both with no provider call; a stored `studyRevision` behind the parent's is 409. **The tamper case (`:205`) becomes the stronger one**: a POST whose body carries `{ synthesis: { ...aggregate, bottomLine: 'Fabricated finding.' } }` still calls `generateFollowupStudy` with the *stored* bottom line, proving the body is not read. The two provider-error branches (`:216`, `:231`) pass with only the `request()` signature changed.
3. **`tests/unit/api.export.csvFormulas.test.ts`** — `kvMock` (`:24-28`) gains `getStudyAggregateChecked: vi.fn().mockResolvedValue({ status: 'not-found' })`. Every existing CSV assertion passes unchanged; the formula-injection guards are the point of the file and must not move.
4. **`tests/unit/StudyDetail.aggregate.test.tsx`** — the fetch stub gains a `/aggregate` branch returning `{ aggregate: null }` so the initial load has a third response. `generateAggregate()` still clicks `Analyze All Interviews` (no aggregate exists at that moment). The footer assertion at `:135-142` keeps its `receipt`/`unsigned` negatives verbatim and its regex becomes the saved form once the POST fixture gains `savedAt` — split it into the four cases in N13's new list below rather than stretching one assertion.
5. **`tests/helpers/faultManifest.ts:22`** — `'D1', 'D2', 'D3', 'D4', 'D5',`.
6. **`tests/integration/redis.crashCuts.test.ts`** — extended, not replaced; see below. A new file under `tests/integration/` would be run by neither `test:redis-crash` nor `test:adversarial` (N2.7), and `assertFaultCutsCovered()` requires D5's coverage to be registered in *this* file.

### New, smallest realistic regressions

- **New `tests/unit/kv.aggregatePersistence.test.ts`** (node environment, a stub `RedisPort` like the other `kv.*` suites): `saveStudyAggregate` writes `study-aggregate:<id>` with a value starting `oi:aggregate:` and returns `'saved'`; a round trip through `getStudyAggregateChecked` returns a deep-equal record; a value written for study A is `not-found` when read as study B (the mixup guard); a record carrying `_receipt` decodes as `not-found`; a record whose `interviewCount` disagrees with `interviewIds.length` decodes as `not-found`; a non-prefixed string, a JSON array, a bare object and `null` all decode as `not-found`; a `get` that throws yields `{ status: 'unavailable' }` and a `set` that throws yields `'unavailable'`; an aggregate whose encoded value exceeds `MAX_STORED_AGGREGATE_BYTES` returns `'too-large'` **with no call on the client at all** (assert the stub's `set` was never invoked); a malformed `studyId` returns `'unavailable'` with no call.
- **Extend `tests/integration/redis.crashCuts.test.ts`** inside the `standalone create/delete W1/W2/S1–S4/D1–D4` describe, against the disposable `redis-server`:
  - **Round trip and cascade.** Create a study; `saveStudyAggregate`; `getStudyAggregateChecked` returns it; `getStudyAggregateChecked` for a fresh uuid is `not-found`; `deleteStudy` returns `deleted` and `redis.get('study-aggregate:<id>')` is `null`.
  - **D5.** With an aggregate stored, `armCut('D5')`, `deleteStudy` returns `unavailable`, `study:<id>` is still truthy, `study-aggregate:<id>` is gone; `coverFaultCut('D5')`; the retry returns `deleted`.
  - **A refused delete keeps the analysis.** `redis.sadd('study-interviews:<id>', 'interview-x')` makes the conflict branch fire; `deleteStudy` returns `conflict` and the aggregate is **still present**. This is the assertion that pins the `DEL`'s placement below the conflict return.
  - **Hosted arity.** With `DEPLOYMENT_MODE` set to hosted for one call, the six-key array is accepted and a five-key call is refused as `unavailable` — the guard at `kv.ts:1384` doing its job after the arity change.
- **New `tests/unit/api.studyAggregate.read.test.ts`** (node environment, mocking `@/lib/researcherContext` and `@/lib/kv` as the sibling route tests do): an authorized read returns `{ aggregate: <record> }` with 200; `not-found` returns `{ aggregate: null }` with **200, not 404**; `unavailable` returns 503 with `retryable: true`; an unauthorized context returns the gate's status with no kv call; `getStudyAggregateChecked` is called with the id from `params` and the gated `kvClient`, never a default client.
- **Extend `tests/unit/StudyDetail.aggregate.test.tsx`** — four footer cases and two control cases, all through the rendered footer text:
  - a stored aggregate loaded on mount (the `/aggregate` stub returns one with `savedAt`) renders without any click, its footer matches `/^Synthesized by .+ · study rev 4 · saved .+$/`, matches neither `/receipt/i` nor `/unsigned/i` nor `/not saved/`, and the button reads `Re-analyze All Interviews`;
  - a POST response **without** `savedAt` renders `· not saved — regenerate to refresh`;
  - a stored aggregate with `interviewCount: 2` against three eligible interviews appends `· covers 2 of 3 interviews`;
  - a stored aggregate with `studyRevision: 3` against a study at revision 4 appends `· study is now rev 4`, and `Create Follow-up Study` is disabled with the `Re-analyze first:` sentence in place of the default helper;
  - with a stored aggregate and fewer than two interviews, the reading renders and the `Need at least 2 interviews` sentence does not (the N7.3 render-order rule);
  - clicking `Create Follow-up Study` on a current aggregate issues a POST with **no body** (assert the `fetch` mock's second argument has no `body` key).
- **Extend `tests/unit/hosted.sharedByos.adversarial.test.ts`** — two cases in the existing cross-tenant matrices: at `:550`, B's `GET /api/studies/<A study>/aggregate` returns the same 403/409 as the other study-scoped surfaces **with zero BYOS reads**; at `:708`, B's export contains no `aggregates/<A study>.json` entry even though A's aggregate sits in the shared database.
- **Extend `tests/e2e/research-workflow.spec.ts`** after the existing aggregate block (`:126`): after asserting the citation chain, assert the footer matches `/· saved /` and does **not** match `/not saved/`; then `await page.goto(studyUrl)` and assert, without clicking anything, that the bottom line, the `t.2` citation trigger and a `/· saved /` footer are all present, and that the button reads `Re-analyze All Interviews`. Finally, `expect(workflow.calls.filter(call => call.operation === 'aggregate')).toHaveLength(1)` at the end of the test — **still one**, after a reload that displayed the analysis. That single number is the whole slice: the second read cost nothing.

Do not snapshot any component in this slice.

---

## N14. Verification

Two change-map rows are tripped. **Storage/tenancy** (`kv.ts`, the delete script, the new route, the reconciler's cascade) requires the atomicity/tenancy/saga suites plus `npm run check`. **Completion and export** (`export/route.ts`) requires the receipt/lifecycle/save suites plus `npm run test:e2e`. **Researcher UI** is tripped by `StudyDetail.tsx`. **Providers/provenance is not tripped** — no prompt, adapter, schema, transport or provider-validation file changes; if an implementation finds it needs one, stop and hand back. **Structured request logs is not tripped** (N11).

```bash
# Storage / tenancy
npx vitest run tests/unit/kv.aggregatePersistence.test.ts tests/unit/kv.atomicPersistence.test.ts \
  tests/unit/kv.createDeleteReceipts.test.ts tests/unit/kv.mutationSerialization.test.ts \
  tests/unit/kv.persistGuard.delete.test.ts tests/unit/kv.checkedCollections.test.ts \
  tests/unit/api.study.operationSaga.test.ts tests/unit/studyOperationReconciler.test.ts \
  tests/unit/api.study.deleteNoGetShortcut.test.ts tests/unit/api.studies.reconcile.test.ts \
  tests/unit/api.studyAggregate.read.test.ts tests/unit/ownedStudies.test.ts

# Completion, export, and the two routes that changed shape
npx vitest run tests/unit/api.aggregate.revision.test.ts tests/unit/api.aggregate.citations.test.ts \
  tests/unit/api.followup.provenance.test.ts tests/unit/synthesisReceipt.test.ts \
  tests/unit/api.export.csvFormulas.test.ts tests/unit/Export.mode.test.tsx \
  tests/unit/api.save.idempotent.test.ts tests/unit/api.save.evidenceRefs.test.ts

# Researcher UI
npx vitest run tests/unit/StudyDetail.aggregate.test.tsx tests/unit/StudyDetail.register.test.tsx \
  tests/unit/StudyDetail.participantLinks.test.tsx tests/unit/AggregateReading.citations.test.tsx \
  tests/unit/SynthesisReading.test.tsx
```

Then the full gate, including the real-wire suites that are the only place the cascade and the cross-tenant claims are actually exercised, and a hosted build with the non-secret fixture environment from `.github/workflows/ci.yml`:

```bash
npm run check
npm run test:redis-crash
npm run test:adversarial
DEPLOYMENT_MODE=standalone npm run build
DEPLOYMENT_MODE=hosted     AI_TRANSPORT=direct  npm run build
npm run test:e2e
git diff --check
```

Then the greps, each of which must return no output except where noted:

```bash
grep -rn "study-aggregate:" src/                  # kv.ts only (the prefix constant and the delete key arrays)
grep -rn "oi:aggregate:" src/                     # kv.ts only
grep -rn "_receipt" src/app/api/synthesis/aggregate/   # nothing (the per-interview route keeps its own receipt)
grep -rn "verifyAggregateSynthesisReceipt" src/   # synthesisReceipt.ts only (declaration; no caller)
grep -rn "readBoundedJsonObject" "src/app/api/studies/[id]/generate-followup/"  # nothing (participant-links keeps its bound)
grep -rn "aggregate" src/lib/platformDb*.ts src/lib/platformSchema.ts   # nothing: no aggregate in the control plane
git diff --stat src/lib/wire/ src/lib/redisPort.ts src/lib/kvClient.ts  # empty
git diff --stat src/lib/requestLog.ts src/lib/prompts/ src/lib/providers/ src/lib/providerSchemas.ts  # empty
git diff --stat src/components/SynthesisReading.tsx src/lib/evidence.ts # empty
```

Then by hand, at **375px** and 1280px, on `/studies/<id>` → Overview, against a study with at least three interviews:

- Press **Analyze All Interviews**. The footer reads `… · saved <date>` with no `not saved` clause. **Reload the page.** The whole analysis is still there, the citations still open, the wine numerals still trace, and the button now reads `Re-analyze All Interviews`. That reload is the slice.
- Complete a fourth interview, reload, and confirm the footer gains `· covers 3 of 4 interviews` and nothing regenerated on its own.
- Edit the study (bump the revision), reload, and confirm the footer gains `· study is now rev N`, that `Create Follow-up Study` is disabled, and that the helper sentence names both revisions. Press **Re-analyze** and confirm both clauses disappear.
- Delete a study that has an analysis but no interviews, then re-create a study and confirm no stale analysis appears. (`redis-cli KEYS 'study-aggregate:*'` against the local instance is the direct check.)
- Download the export and confirm the zip contains `aggregates/<studyId>.json` with `savedAt`, `studyRevision` and `interviewIds`, and that a study with no analysis contributes no file.
- At 375px confirm the footer wraps as a paragraph and does not push the page body into horizontal scroll: it is now up to five ` · ` segments on the longest line, one more than any footer in the system today.

Leave the dev server runnable for the orchestrator's screenshot pass.

---

## Hard constraints

- **Files that may change:** `src/types.ts`, `src/lib/kv.ts`, `src/lib/synthesisReceipt.ts` (the one new export and the one-line delegation only), `src/app/api/synthesis/aggregate/route.ts`, `src/app/api/studies/[id]/aggregate/route.ts` (new), `src/app/api/studies/[id]/generate-followup/route.ts`, `src/app/api/interviews/export/route.ts`, `src/services/storageService.ts`, `src/components/StudyDetail.tsx`, `tests/helpers/faultManifest.ts`, and the tests and fixtures in N13. **Nothing else.**
- **No new Redis command and no new wire family.** `src/lib/wire/`, `src/lib/redisPort.ts`, `src/lib/redisNodeAdapter.ts` and `src/lib/kvClient.ts` are untouched. The write is `SET`, the read is `GET`, the delete is a `DEL` inside an existing `eval`.
- **The aggregate never enters the platform control plane.** No `platformDb*.ts`, no `platformSchema.ts`, no `ownedStudies.ts` change. Hosted research data stays in the researcher-owned database.
- **`StoredStudy` does not gain a field.** `studyJsonLua.ts`, `STUDY_CAS_LUA`, `replaceStudyConfigAtomic`, `setStudyLinksEnabled` and `CREATE_STUDY_SCRIPT` are not edited.
- **The delete cascade lives in the Lua script, not in a route.** If an implementation finds itself adding a `del` next to a `deleteStudy` call, it has reintroduced the orphan window this slice exists to close.
- **No provider, prompt, schema, adapter, transport or evidence change.** `src/lib/prompts/`, `src/lib/providers/`, `src/lib/providerSchemas.ts`, `src/lib/providerValidation.ts`, `src/lib/evidence.ts`, `src/lib/aiTransport.ts` and `src/lib/ai.ts` all show an empty diff. Slice L's chain is complete and this slice only stores its output.
- **`src/components/ui/` is a frozen contract.** `ProvenanceFooter`, `AggregateReading`, `SynthesisReading`, `Citation`, `Coordinate`, `Verbatim`, `Button`, `Notice`, `Icon`, `Tabs` are not edited. The footer changes are the *values* `StudyDetail` passes.
- **Do not edit `eslint.config.mjs`, `tailwind.config.ts`, `src/app/globals.css`, or `src/app/layout.tsx`.** This slice adds no class, token, keyframe or primitive.
- **`not saved — regenerate to refresh` is preserved character for character** and rendered only when `savedAt` is absent. It is not softened, reworded, or deleted.
- **No automatic regeneration, anywhere.** No effect, no retry, no "refresh if stale". Every provider call on this surface starts with a click.
- **Do not edit `src/lib/demoData.ts`, `src/components/DemoSimulation.tsx`, `src/app/demo`, `src/components/Synthesis.tsx`, `src/components/InterviewDetail.tsx`, or `src/components/Export.tsx`.** The sample workspace seeds no aggregate and the keyless demo still makes no request.
- No new dependency and no dependency removal. npm only (`package-lock.json` authoritative), Node ≥ 24.19. Light Paper only, no `data-theme` wiring.
- **Do not commit.** Leave the working tree for review, preserve unrelated dirty files, and review only the scoped diff.

---

## Deferred, do not attempt

- **Deleting the aggregate receipt machinery.** After this slice `createAggregateSynthesisReceipt`, `verifyAggregateSynthesisReceipt`, `AGGREGATE_AUDIENCE`, `AGGREGATE_RECEIPT_VERSION`, `UnsignedAggregateSynthesis` and `AggregateSynthesisResult._receipt` have no caller in `src/`. Removing them and their tests is a small, separate, purely subtractive diff and belongs in its own review. The handback must name it.
- **An aggregate history.** One record per study, latest replaces (N4.1). Versions, diffs and a picker are a product decision, not a storage one.
- **Regenerating a stale aggregate automatically**, on load, on a new interview, or on a study edit. It costs money and the researcher decides.
- **Deleting the aggregate when the study revision advances.** A stale analysis is a true statement about an earlier revision, and destroying a paid result because someone fixed a typo in the consent text is the wrong trade. The footer says what it covers.
- **Per-study export.** `/api/interviews/export` stays workspace-wide; a study-scoped export is its own feature.
- **Summarizing the aggregate into `summary.csv`** or the markdown transcripts. It is a cross-interview record and does not belong in a per-interview row.
- **Serving verdicts from storage.** `slice-L-spec.md` Open question 5 asked where a non-browser consumer of the aggregate gets its match verdicts. The exported JSON carries claims, exactly as the stored record does, and matching stays render-time. Answering that question means a shared server-side renderer, which is the deferred concordance surface's problem.
- **The aggregate concordance**, the catalogue budget on very large studies, typeset export, night theme, participant transcript download — all still on Initiative 3's "not in this train" list.
- **The A9 researcher walkthrough** of the trace UI on both surfaces and the iOS Safari participant pass (K7) are still owed by the owner and unaffected by this slice.

---

## Rulings (Fable, 2026-09-05) — settled; the text above stands

1. **Q1 — switch cleanly**, as specced. No browser-supplied aggregate reaches any route after this slice; one re-analysis for a tab open across the deploy is the price.
2. **Q2 — as specced**; record the 256 KB ceiling in the handback. If a deployment ever produces a `too-large` aggregate, a distinct honest note is a one-field follow-up.
3. **Q3 — the count**, as specced.
4. **Q4 — fail closed**, as specced. A partial export that silently omits an analysis is the failure this train exists to end.
5. **Q5 — last-writer-wins**, as specced.
6. **Confirmed:** the receipt machinery is left in place with its tests and its removal is a named follow-up; the fault cut is `D5`; the cascade lives in `DELETE_EMPTY_STUDY_SCRIPT` and nowhere else.

## Open questions as originally drafted (for the record)

1. **Should `generate-followup` accept a browser-supplied aggregate for one release?** N9 switches cleanly, so a researcher whose tab predates the deploy gets a 409 telling them to run the analysis again, which costs one provider call they did not plan to spend. The fallback would cost a second trust path for an object the server now owns, kept alive by a receipt that expires in an hour, in the one route where AGENTS.md's first invariant is most directly at stake — and `slice-L-spec.md` L6.2 is the standing evidence that such branches do not get removed. **Recommendation: switch cleanly, as specced.** If the owner would rather not spend that call, the smaller mitigation is a copy change, not a code path: the 409's message already tells the researcher exactly what to press.

2. **Should a `too-large` aggregate be a visible error rather than an unsaved result?** N5 returns the aggregate with no `savedAt`, so the footer reads `not saved — regenerate to refresh` — which is true but unhelpful, because regenerating will produce another oversized result and the researcher will loop. The honest alternative is a distinct note (`too large to save`) that tells them re-running will not help. That needs a second bit on the response, which N3.1 argues against, or a length check in the browser, which duplicates the ceiling. **Recommendation: ship as specced and record the limit in the handback.** 256 KB is roughly a hundred themes with full citations; a study that exceeds it has a prompt-budget problem (`slice-L-spec.md` L4.1's catalogue budget) that the concordance surface is meant to solve, and inventing copy for a case no deployment has produced is speculative.

3. **Is `covers 2 of 3 interviews` the right grammar, given the register calls rows `Interview N` and citations call participants `P0N`?** The footer's count is a cardinality, not a coordinate, so it collides with neither. But a researcher reading `covers 2 of 3` cannot tell *which* two, and the aggregate's `interviewIds` knows. Naming them (`covers P01, P02 of 3 interviews`) is accurate and gets long fast. **Recommendation: the count, as specced.** Which two is a question the deferred concordance answers properly; the footer's job is to say the analysis is not about everything on the screen.

4. **Should the export fail closed when one study's aggregate read is unavailable?** N10 returns 503, consistent with Law 4 and with how the same route already handles an unavailable interview load. The counter-argument is real: the researcher loses a transcript export over a cache read, and the transcripts are the irreplaceable half. **Recommendation: fail closed, as specced.** A partial export that silently omits an analysis is the failure mode this train exists to eliminate, and the retry is one click. If the owner prefers otherwise, the honest alternative is to include a manifest file naming the studies whose analysis could not be read — not to omit them silently.

5. **Last-writer-wins on concurrent analyses (N12).** Two tabs produce two valid answers to the same question and the second write wins; the first tab keeps showing an aggregate whose `savedAt` says it was stored, when in fact it was superseded. A conditional write (store `generatedAt` and refuse an older one) would fix the display at the cost of a read-modify-write and a new refusal state. **Recommendation: as specced.** Both answers are equally true, the divergence resolves on the next load, and the alternative buys consistency between two paraphrases of the same finding at the price of a failure mode a researcher would have to be taught.
