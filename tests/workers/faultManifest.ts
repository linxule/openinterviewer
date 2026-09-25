// Cloudflare fault manifest (VERIFY-01). Every cut in the Cloudflare
// storage and job protocol that matters for durability or paid-call safety:
// where the process, RPC or reply can stop, what durable state proves the
// outcome, what the caller sees, what moves the work forward, and the tests
// that exercise it (file plus exact test title).
//
// Derived from the code: each storage transaction, synchronous-KV write and
// alarm write in cloudflare/workspace/*.ts, each WorkspaceStore RPC, the
// Queue consumer's RPC boundaries in cloudflare/analysis/*.ts, and the M0
// crash probes (evidence/M0-feasibility.md). tests/unit/
// cloudflareFaultManifest.test.ts scans those sources and fails when a write
// site or RPC is neither named by an entry (`code`) nor listed in
// NON_CUT_SURFACES, when a named symbol no longer exists, when an entry has no
// coverage, or when a covering title is not an active test in its file.
//
// Plain data: no imports, so the Node unit tier can read it. Titles are the
// literal source text (an `it.each` title keeps its `%s`/`$name` placeholder).

export type FaultCoverage = { file: string; title: string };

export type CloudflareFaultCut = {
  id: string;
  /** Source symbols this cut belongs to, as `<path>#<function or method>`. */
  code: string[];
  cut: string;
  durableEvidence: string;
  expectedReply: string;
  nextAction: string;
  coverage: FaultCoverage[];
};

const COMPLETION = 'tests/workers/completion.test.ts';
const ANALYSIS = 'tests/workers/analysis.test.ts';
const SCHEDULER = 'tests/workers/scheduler.test.ts';
const CONSUMER = 'tests/workers/consumer.test.ts';
const JOB_FAULTS = 'tests/workers/jobFaults.test.ts';
const FAULT_CUTS = 'tests/workers/faultCuts.test.ts';
const DURABLE_CLIENT = 'tests/workers/durableClient.test.ts';
const STUDIES = 'tests/workers/studies.test.ts';
const PARTICIPANTS = 'tests/workers/participants.test.ts';
const READS = 'tests/workers/reads.test.ts';
const SAMPLE = 'tests/workers/sample.test.ts';
const LOGIN = 'tests/workers/login.test.ts';
const EXPORTS = 'tests/workers/exports.test.ts';
const BACKUP = 'tests/workers/backup.test.ts';
const OPERATOR = 'tests/workers/operator.test.ts';
const SCHEMA = 'tests/workers/schema.migrations.test.ts';
const RESEARCHER_ROUTES = 'tests/workers/researcherRoutes.test.ts';
const RESEARCHER_AI = 'tests/workers/researcherAi.test.ts';
const RESTART_COMMITTED = 'tests/cloudflare-restart/committed.restart.test.ts';
const RESTART_LEASE = 'tests/cloudflare-restart/lease.restart.test.ts';
const RESTART_TRANSACTION = 'tests/cloudflare-restart/transaction.restart.test.ts';
const OPERATOR_CLI = 'tests/setup-cloudflare/operator.test.mjs';
const OPERATOR_ROUTES = 'tests/unit/api.operator.routes.test.ts';

const WS = 'cloudflare/workspace';
const STORE = `${WS}/WorkspaceStore.ts`;

const RESTART_S1 = 'VERIFY-01/JOB-05 a save committed before SIGKILL keeps its job and wake-up: after restart, with no client request, the alarm dispatches, the Queue consumer runs and the analysis completes with one synthesis request';
const RESTART_S2 = 'VERIFY-01/ST-02 lost save reply: the object commits, the runtime dies before the client reads the reply, and the same save replayed after restart is a duplicate with one interview, one job and one synthesis request';
const RESTART_S3 = 'VERIFY-01/JOB-08 a job whose provider call was in flight at SIGKILL is never retried: after restart the lease watchdog records recovery-required and the provider saw one synthesis request';
const RESTART_TX = 'VERIFY-01/JOB-05 SIGKILL while a transaction holding SQL and an earlier alarm is still open leaves neither after restart; the committed row and its own alarm survive and fire unprompted';

export const CLOUDFLARE_FAULT_CUTS: ReadonlyArray<CloudflareFaultCut> = [
  // ---------- Participant completion (JOB-01/05, ST-02/04) ----------
  {
    id: 'CF-COMPLETION-ROLLBACK',
    code: [`${WS}/completion.ts#persistCompletedInterview`, `${WS}/completion.ts#write`, `${WS}/context.ts#allocateGeneration`, `${STORE}#persistCompletedInterview`],
    cut: 'A throw inside the completion transaction after the interview SQL: the initial job id conflicts at allocation, or registering the alarm fails.',
    durableEvidence: 'Nothing: no interview, analysis row, job, budget member, study count or lock change, mutation-sequence bump or alarm.',
    expectedReply: '`unavailable`; the save route answers 503 with `retryable: true` and the browser keeps the transcript.',
    nextAction: 'The browser retries the same save, which commits normally as `created` with a fresh job id.',
    coverage: [
      { file: COMPLETION, title: 'ST-04/JOB-05: a failed generation allocation rolls back every completion write and arms no alarm' },
      { file: COMPLETION, title: 'ST-04/JOB-05: a failure while registering the alarm rolls back the SQL already written' },
    ],
  },
  {
    id: 'CF-COMPLETION-LOST-REPLY',
    code: [`${WS}/completion.ts#persistCompletedInterview`, `${STORE}#persistCompletedInterview`],
    cut: 'The completion transaction committed and its reply was lost: a thrown RPC, or the runtime SIGKILLed after the Worker produced the reply and before the client read it.',
    durableEvidence: 'One interview, its analysis row (pending, generation 1), one pending job (dispatch unsent, due at save time), an alarm no later than that, the budget members, the study count and lock, and one mutation-sequence bump.',
    expectedReply: 'A thrown RPC is `ambiguous` in the durable client and 503 `retryable` at the route; after a process kill the connection fails.',
    nextAction: 'The same save (body, participant cookie and session selector) replays as `duplicate` (200, `created: false, duplicate: true`) without a second job, charge, alarm change or mutation; the committed alarm dispatches with no request.',
    coverage: [
      { file: COMPLETION, title: 'ST-02: a lost-response replay returns duplicate without a second job, charge, alarm change or mutation' },
      { file: DURABLE_CLIENT, title: 'ST-01: a committed-but-lost completion reply is reported as ambiguous, never created' },
      { file: RESTART_COMMITTED, title: RESTART_S2 },
    ],
  },
  {
    id: 'CF-COMPLETION-KILL-AFTER-REPLY',
    code: [`${WS}/completion.ts#persistCompletedInterview`, `${STORE}#alarm`, `${WS}/scheduler.ts#runAlarm`],
    cut: 'The completion committed and the client read `created`; the runtime died before its alarm dispatched the job.',
    durableEvidence: 'The committed rows above and the alarm persisted with the object.',
    expectedReply: '200 `{ success: true, created: true }` before the cut.',
    nextAction: 'After restart the persisted alarm fires with no request, dispatches, and the Queue consumer claims, calls the provider once and attaches.',
    coverage: [
      { file: COMPLETION, title: 'ST-04/JOB-05: an object restart preserves the committed completion, its job and its wake-up' },
      { file: RESTART_COMMITTED, title: RESTART_S1 },
    ],
  },

  // ---------- Researcher retry (JOB-04/05, API-01) ----------
  {
    id: 'CF-RETRY-ROLLBACK',
    code: [`${WS}/analysis.ts#acceptAnalysisRetry`, `${STORE}#acceptAnalysisRetry`],
    cut: 'A throw inside the retry-allocation transaction: the alarm cannot be committed.',
    durableEvidence: 'Nothing: no job, no analysis row for a legacy record, no retry receipt, no mutation-sequence bump.',
    expectedReply: '`unavailable`; the analyze route answers 503 `retryable`.',
    nextAction: 'The client retries the same intentional action (same Idempotency-Key and body), which allocates once.',
    coverage: [
      { file: ANALYSIS, title: 'JOB-05 rolls back the whole retry allocation when its alarm cannot be committed' },
    ],
  },
  {
    id: 'CF-RETRY-LOST-REPLY',
    code: [`${WS}/analysis.ts#acceptAnalysisRetry`, `${WS}/analysis.ts#storeRetryReceipt`, `${STORE}#acceptAnalysisRetry`],
    cut: 'The retry allocation committed and its reply was lost, or the object restarted before replying.',
    durableEvidence: 'A pending generation N+1 job, the receipt binding the scoped key digest to that generation and request fingerprint (7-day expiry), an alarm no later than its due time, and a mutation-sequence bump.',
    expectedReply: 'A thrown RPC is `unavailable` in the durable client (the commit may have happened); the analyze route answers 503 `retryable` so the client repeats the same key and body.',
    nextAction: 'The same key and body replay the receipt (same generation, current outcome); another key gets the existing active work; the same key with other intent is `key-conflict`; no second paid attempt.',
    coverage: [
      { file: ANALYSIS, title: 'JOB-05/API-01 keeps a committed allocation and its wake-up across an object restart before the reply' },
      { file: ANALYSIS, title: 'JOB-10 replays a receipt with the current outcome and an expired receipt cannot allocate over another generation' },
      { file: ANALYSIS, title: 'JOB-04 returns existing active work to a second key and records that key against it' },
      { file: ANALYSIS, title: 'JOB-04 races an initial job and two retry keys to a single active generation and one provider request' },
    ],
  },
  {
    id: 'CF-STATUS-WAKEUP',
    code: [`${WS}/analysis.ts#readAnalysisStatus`, `${WS}/analysis.ts#restoreLostWakeUp`, `${STORE}#readAnalysisStatus`],
    cut: 'A status read finds due nonterminal work with no alarm (a hold that was cleared without a maintenance transition) and arms one.',
    durableEvidence: 'Only an alarm at the earliest due job, and only when none existed; no job or receipt changes.',
    expectedReply: 'The closed status body; a lost reply changes nothing.',
    nextAction: 'The restored alarm runs the scheduler; the read never dispatches, retries or calls a provider itself.',
    coverage: [
      { file: SCHEDULER, title: 'JOB-05 restores a wake-up lost under an epoch mismatch once the configuration is corrected' },
    ],
  },

  // ---------- Scheduler: dispatch (JOB-05/06/07) ----------
  {
    id: 'CF-DISPATCH-RESERVE',
    code: [`${WS}/scheduler.ts#settleDueJob`, `${WS}/scheduler.ts#reserveDispatch`, `${WS}/scheduler.ts#runAlarm`],
    cut: 'The alarm committed a send reservation and its backoff wake-up; the process died, or `queue.send` threw, before the send was recorded.',
    durableEvidence: 'The job `reserved` with `dispatch_attempts` + 1 and `next_due_at` = now + backoff (5 s doubling, 30 min cap), and an alarm no later than that.',
    expectedReply: 'None (alarm handler).',
    nextAction: 'The backoff alarm reserves again (one budget unit) and re-sends; exhaustion at 16 attempts or 24 h records failed/storage.',
    coverage: [
      { file: SCHEDULER, title: 'JOB-06/07 keeps the reservation and its backoff durable when the send acknowledgement is lost' },
      { file: SCHEDULER, title: 'JOB-06 sends one identifier-only envelope after committing its reservation, then records the send' },
    ],
  },
  {
    id: 'CF-DISPATCH-SEND-RECORD',
    code: [`${WS}/scheduler.ts#dispatch`],
    cut: '`queue.send` succeeded but the conditional record (`sent`, watchdog check in 5 min) did not commit, or a claim or a freeze committed while the send was awaited.',
    durableEvidence: 'The reservation unchanged (a message may already be queued), or the racing claim with its lease, or the frozen state.',
    expectedReply: 'None (alarm handler).',
    nextAction: 'A second delivery can follow; the consumer claim deduplicates (`busy`, `terminal`, `stale`) without a second provider call; a raced claim keeps its lease; a freeze suspends dispatch.',
    coverage: [
      { file: SCHEDULER, title: 'JOB-06 never acknowledges a send over a claim that raced it' },
      { file: SCHEDULER, title: 'JOB-06 re-arms no later than the watchdog check in the same unit that records the send' },
      { file: SCHEDULER, title: 'OPS-01/F11 stops dispatch and cleanup when a freeze commits while a Queue send is in flight' },
      { file: CONSUMER, title: 'JOB-06 acknowledges duplicate and out-of-order deliveries without a second provider call or write' },
    ],
  },
  {
    id: 'CF-DISPATCH-DELIVERY-LOST',
    code: [`${WS}/scheduler.ts#settleDueJob`, `${WS}/scheduler.ts#exhaust`],
    cut: 'A recorded send is never claimed: Queue retention or dead-lettering, or the local Queue losing its in-memory message when the runtime restarts.',
    durableEvidence: 'The job `pending`/`sent` with its watchdog due 5 min after the send, and an alarm.',
    expectedReply: 'None.',
    nextAction: 'The watchdog re-sends for one budget unit unless a consumer contacted the object since (then it waits another interval without charging); 16 attempts or 24 h record failed/storage.',
    coverage: [
      { file: SCHEDULER, title: 'JOB-06/07 re-sends an acknowledged but unclaimed delivery for one budget unit when no consumer contact followed it' },
      { file: SCHEDULER, title: 'JOB-07/F6 defers an acknowledged delivery behind a live consumer backlog without charging or re-sending' },
      { file: SCHEDULER, title: 'JOB-07 records failed/storage and stops after 16 dispatch attempts' },
      { file: SCHEDULER, title: 'JOB-07 records failed/storage 24 hours after allocation even with budget left' },
    ],
  },
  {
    id: 'CF-ALARM-FAILURE',
    code: [`${WS}/scheduler.ts#runAlarm`, `${WS}/scheduler.ts#runScheduler`, `${STORE}#alarm`],
    cut: 'Storage fails during the alarm, a settlement throws, or the object is held (uninitialized, schema, identity).',
    durableEvidence: 'A retry alarm 30 s ahead persisted before the handler returns (hourly while held); a failing row is quarantined in memory and never patched.',
    expectedReply: 'None; the handler returns normally so platform alarm retries are not the recovery path.',
    nextAction: 'The retry alarm runs the scheduler again; a quarantined row is retried after its doubling backoff (up to 1 h).',
    coverage: [
      { file: SCHEDULER, title: 'JOB-07 persists a retry alarm before returning when storage fails during the alarm' },
      { file: SCHEDULER, title: 'JOB-06/F13 quarantines a row whose settlement fails, without patching it or starving the rest of the batch' },
      { file: SCHEMA, title: 'an unsupported future schema refuses readiness, reads, mutations and dispatch, and keeps a wake-up' },
      { file: SCHEDULER, title: 'ST-09/JOB-05 keeps an hourly wake-up under a workspace identity mismatch, with no send and no write' },
    ],
  },
  {
    id: 'CF-ALARM-BATCH-AND-CLEANUP',
    code: [`${WS}/scheduler.ts#cleanup`, `${WS}/scheduler.ts#cleanupSteps`, `${WS}/scheduler.ts#rearm`],
    cut: 'The alarm stops after a bounded batch (25 due rows, 100 cleanup rows per family) or between cleanup and the final re-arm.',
    durableEvidence: 'Cleanup deletes only expired receipts, windows, fences, consents, links and old terminal job detail, never a current or active generation; the re-arm commits the earliest due time.',
    expectedReply: 'None.',
    nextAction: 'An immediate re-arm when a batch was full, otherwise the earliest due job or cleanup; any job-capable RPC restores a missing wake-up.',
    coverage: [
      { file: SCHEDULER, title: 'JOB-06 processes at most 25 due rows per alarm and re-arms immediately for the rest' },
      { file: SCHEDULER, title: 'JOB-10 deletes only expired rows and prunes old terminal detail but never the current or active generation' },
      { file: SCHEDULER, title: 'JOB-10 bounds cleanup per alarm and re-arms immediately when a batch was full' },
    ],
  },

  // ---------- Scheduler: watchdog transitions (JOB-03/08/10) ----------
  {
    id: 'CF-WATCHDOG-CLAIM-EXPIRED',
    code: [`${WS}/scheduler.ts#settleDueJob`, `${WS}/scheduler.ts#reserveDispatch`],
    cut: 'The consumer invocation died after its claim committed and before its start marker.',
    durableEvidence: 'The job `claimed` with its nonce, a 180 s lease on the object clock, attempts counted once, and an alarm no later than the lease end.',
    expectedReply: 'None.',
    nextAction: 'At lease expiry the watchdog returns it to pending with a fresh reservation (one budget unit); the old nonce can no longer start; an unexpired lease stays covered by the alarm.',
    coverage: [
      { file: SCHEDULER, title: 'JOB-08 returns an expired unstarted claim to pending with a fresh dispatch and fences the old nonce' },
      { file: SCHEDULER, title: 'JOB-05 keeps an unexpired lease covered by the alarm instead of redispatching it' },
    ],
  },
  {
    id: 'CF-WATCHDOG-STARTED-EXPIRED',
    code: [`${WS}/scheduler.ts#settleDueJob`, `${WS}/analysis.ts#settleJob`],
    cut: 'The process died after the start marker, possibly with the provider request in flight.',
    durableEvidence: 'The job `started` with `started_at`, its lease and an alarm no later than the lease end; the provider fixture saw one request.',
    expectedReply: 'None; the researcher sees pending/running until the lease ends.',
    nextAction: 'At lease expiry the watchdog records recovery-required (`failed`, `failureKind: timeout`, `recoveryRequired: true`), never pending; only an explicit researcher retry starts another paid attempt.',
    coverage: [
      { file: SCHEDULER, title: 'JOB-08 marks a started job whose process died recovery-required after the lease, never pending' },
      { file: CONSUMER, title: 'JOB-08 turns a started job whose invocation died into recovery-required, and a late delivery never calls again' },
      { file: RESTART_LEASE, title: RESTART_S3 },
    ],
  },
  {
    id: 'CF-WATCHDOG-FENCES',
    code: [`${WS}/scheduler.ts#settleDueJob`],
    cut: 'A due job whose interview is gone or fenced, whose analysis row does not point at it, or which still carries another recovery epoch.',
    durableEvidence: 'Cancelled (deleted parent), untouched and quarantined (structural corruption), or recovery-required (foreign epoch); nothing is dispatched.',
    expectedReply: 'None.',
    nextAction: 'No automatic work; a foreign-epoch job needs an explicit researcher retry.',
    coverage: [
      { file: SCHEDULER, title: 'JOB-10 cancels a due job whose interview is gone instead of dispatching it' },
      { file: SCHEDULER, title: 'JOB-04/F13 quarantines a due job whose live interview has no matching analysis row, without writing it' },
      { file: FAULT_CUTS, title: 'JOB-10: a due job still carrying another recovery epoch is settled recovery-required by the alarm, never dispatched' },
    ],
  },

  // ---------- Queue consumer RPC boundaries (JOB-06/07/08/09) ----------
  {
    id: 'CF-CONSUME-ENVELOPE',
    code: ['cloudflare/analysis/consumer.ts#handleMessage'],
    cut: 'A delivery that is an unknown version, malformed, for another workspace or epoch, a duplicate or out of order.',
    durableEvidence: 'None written.',
    expectedReply: 'Explicit ack; an unknown version is retried to the dead-letter queue.',
    nextAction: 'Nothing executes; the outbox and watchdog remain authoritative.',
    coverage: [
      { file: CONSUMER, title: 'JOB-07 sends an unknown message version to the dead-letter path without any RPC or provider call' },
      { file: CONSUMER, title: 'JOB-06 acknowledges malformed, foreign-workspace and foreign-epoch envelopes without writes' },
      { file: CONSUMER, title: 'JOB-06 acknowledges duplicate and out-of-order deliveries without a second provider call or write' },
    ],
  },
  {
    id: 'CF-CONSUMER-CONTACT',
    code: [`${WS}/analysis.ts#recordConsumerContact`],
    cut: 'The consumer-contact write (durable synchronous KV, outside SQL and backups, before each consumer RPC) throws; it is advisory and never blocks the RPC.',
    durableEvidence: '`analysis.consumerContactAt` absent or older than the send.',
    expectedReply: 'None; the RPC proceeds.',
    nextAction: 'The watchdog charges the dispatch budget as if no consumer ran, still bounded by 16 attempts and 24 h.',
    coverage: [
      { file: SCHEDULER, title: 'JOB-06/07 re-sends an acknowledged but unclaimed delivery for one budget unit when no consumer contact followed it' },
      { file: SCHEDULER, title: 'JOB-07/F6 applies budget exhaustion only when a unit must be charged' },
    ],
  },
  {
    id: 'CF-CLAIM-LOST-REPLY',
    code: [`${WS}/analysis.ts#claimAnalysisJob`, `${STORE}#claimAnalysisJob`, 'cloudflare/analysis/consumer.ts#processJob', 'cloudflare/analysis/consumer.ts#withOneReplay'],
    cut: 'The claim committed and its reply was lost.',
    durableEvidence: 'The job `claimed` with this invocation\'s nonce and lease, attempts + 1 once, and an alarm no later than the lease end.',
    expectedReply: 'A thrown RPC in the consumer.',
    nextAction: 'The same invocation replays once with the same nonce (`claimed`, `replayed: true`, no second attempt count); if still unconfirmed it retries the transport without a provider call; any other invocation gets `busy`; the lease watchdog recovers an abandoned claim.',
    coverage: [
      { file: CONSUMER, title: 'JOB-08 replays a lost claim reply once through a failing transport and proceeds with the same nonce' },
      { file: CONSUMER, title: 'JOB-07 retries transport, without a provider call, when the claim outcome cannot be confirmed' },
      { file: ANALYSIS, title: 'JOB-08 claims once, counts one attempt, replays the same nonce and refuses another invocation' },
    ],
  },
  {
    id: 'CF-START-MARKER',
    code: [`${WS}/analysis.ts#markAnalysisStarted`, `${STORE}#markAnalysisStarted`, 'cloudflare/analysis/consumer.ts#processJob'],
    cut: 'The start marker committed and its reply was lost, or the lease left too little time for the deadline plus the attach margin.',
    durableEvidence: 'The job `started` (or still `claimed` when the lease was insufficient); no provider request.',
    expectedReply: 'A thrown RPC or `lease-insufficient` in the consumer.',
    nextAction: 'The same invocation replays once; unconfirmed means no provider call and a transport retry; a redelivery cannot adopt the marker (`busy`); the watchdog records recovery-required at lease end.',
    coverage: [
      { file: CONSUMER, title: 'JOB-08 does not call the provider when the start marker cannot be confirmed' },
      { file: ANALYSIS, title: 'JOB-08 requires enough lease for the deadline plus attach margin before the start marker' },
    ],
  },
  {
    id: 'CF-PROVIDER-CALL',
    code: ['cloudflare/analysis/execute.ts#executeQueuedSynthesis', 'cloudflare/analysis/execute.ts#createQueuedSynthesisProvider'],
    cut: 'The single provider request fails, times out, is aborted, loses its network or returns an error after the start marker.',
    durableEvidence: 'The settlement written by finish: failed/provider (400/401/402/403/404/422/429), failed/invalid-output or failed/too-large, or recovery-required (timeout, abort, network, 5xx).',
    expectedReply: 'The classified outcome; the SDK retries nothing (`maxRetries: 0`, `retries: none`).',
    nextAction: 'No automatic retry; an explicit researcher retry with a new key and the expected generation starts the next paid attempt.',
    coverage: [
      { file: JOB_FAULTS, title: 'JOB-09 $name makes exactly one outbound request and settles per the classification table' },
    ],
  },
  {
    id: 'CF-FINISH-LOST-REPLY',
    code: [`${WS}/analysis.ts#finishAnalysisJob`, `${WS}/analysis.ts#settleJob`, `${STORE}#finishAnalysisJob`],
    cut: 'The attach (or a terminal failure) committed and its reply was lost.',
    durableEvidence: 'Synthesis, actual provenance, the frozen study revision and the terminal receipt carrying the claim nonce, written together with a mutation-sequence bump; `next_due_at` cleared.',
    expectedReply: 'A thrown RPC in the consumer.',
    nextAction: 'The same invocation replays and reads its receipt (`written`, `replayed: true`); the provider is never called again.',
    coverage: [
      { file: CONSUMER, title: 'JOB-08 recovers a lost attach reply from the terminal receipt without calling the provider again' },
      { file: ANALYSIS, title: 'JOB-03/JOB-08 attaches synthesis, provenance and the frozen revision atomically and replays the receipt' },
    ],
  },
  {
    id: 'CF-FINISH-UNCONFIRMED',
    code: [`${WS}/analysis.ts#finishAnalysisJob`, 'cloudflare/analysis/consumer.ts#processJob'],
    cut: 'The attach could not be confirmed at all (storage outage on both attempts) after a provider result.',
    durableEvidence: 'The job still `started` with its lease and alarm; no failure recorded.',
    expectedReply: 'The consumer acknowledges the message without recording a false failure.',
    nextAction: 'The watchdog records recovery-required at lease end.',
    coverage: [
      { file: CONSUMER, title: 'JOB-08 acknowledges without a false failure when the attach reply is lost, leaving the watchdog to settle it' },
    ],
  },
  {
    id: 'CF-FINISH-LATE-OR-STALE',
    code: [`${WS}/analysis.ts#finishAnalysisJob`],
    cut: 'A result arrives after the lease on the object clock, for another generation, job or epoch, or after its interview was deleted.',
    durableEvidence: 'Unchanged.',
    expectedReply: '`lease-expired` or `stale`.',
    nextAction: 'The result is dropped; no second write and no provider call.',
    coverage: [
      { file: ANALYSIS, title: 'JOB-08 rejects a late result after lease expiry without writing' },
      { file: ANALYSIS, title: 'JOB-08/F14 rejects a result after the lease on the object clock when the caller clock runs behind' },
      { file: ANALYSIS, title: 'JOB-04/JOB-10 treats another generation, job or epoch as stale without writes' },
      { file: CONSUMER, title: 'JOB-10 drops a running result after deletion without recreating any record' },
    ],
  },

  // ---------- Researcher export snapshot (ST-08, F1) ----------
  {
    id: 'CF-EXPORT-CAPTURE',
    code: [`${WS}/exports.ts#beginExport`, `${WS}/exports.ts#readExportPage`, `${WS}/exports.ts#verifyExportSequence`, `${WS}/exports.ts#storeSnapshot`, `${WS}/exports.ts#pruneSnapshots`, `${STORE}#beginExport`, `${STORE}#readExportPage`, `${STORE}#verifyExportSequence`],
    cut: 'The export snapshot (durable synchronous KV, outside SQL and backups) is discarded between pages by its 24 h TTL or the 8-snapshot cap, or a captured row is deleted or a captured aggregate replaced mid-stream.',
    durableEvidence: 'The research mutation sequence identifies the captured state.',
    expectedReply: 'A lost snapshot is recaptured while the sequence is unchanged; otherwise the page or final check reports `changed` and the stream errors instead of closing cleanly.',
    nextAction: 'The researcher starts a new export.',
    coverage: [
      { file: EXPORTS, title: 'ST-08: a discarded snapshot is recaptured only while the sequence is unchanged' },
      { file: EXPORTS, title: 'ST-08: stored snapshots are bounded in number and the capture ceiling is enforced' },
      { file: EXPORTS, title: 'ST-08: a streamed export survives concurrent collection, and a captured-row deletion errors it without finalizing' },
    ],
  },

  // ---------- Operational backup, import, activation, restore, maintenance (OPS-01/02/03, JOB-10, ST-09/10) ----------
  {
    id: 'CF-BACKUP-PAGE',
    code: [`${WS}/operator.ts#exportBackupPage`, `${STORE}#exportBackupPage`],
    cut: 'The watermark `<maintenanceVersion>:<mutationSeq>` changes between pages, the workspace is not held, or the export is interrupted.',
    durableEvidence: 'No writes; the held state and its watermark.',
    expectedReply: '409 `WATERMARK_CHANGED` or `NOT_FROZEN`; an interrupted CLI export leaves no manifest or trailer.',
    nextAction: 'The operator restarts the export from the first page; an incomplete file is rejected before import.',
    coverage: [
      { file: BACKUP, title: 'OPS-02: a watermark change between pages is detected (mutation sequence or maintenance version)' },
      { file: BACKUP, title: 'OPS-02: backup export is refused while the workspace is open or draining' },
      { file: OPERATOR_CLI, title: 'OPS-02 an interrupted export leaves no manifest or trailer and reports the held state' },
      { file: 'tests/unit/backupFormat.test.ts', title: 'OPS-02: rejects a missing trailer, missing manifest and a missing chunk' },
    ],
  },
  {
    id: 'CF-IMPORT-CHUNK',
    code: [`${WS}/operator.ts#importBackupChunk`, `${STORE}#importBackupChunk`],
    cut: 'A chunk transaction committed and its reply was lost, or it rolled back on a constraint violation.',
    durableEvidence: 'The chunk\'s rows, its `import.chunk` audit (and `import.begin` for the first), and a mutation-sequence bump; or nothing.',
    expectedReply: '`accepted` (`duplicate: false`) or `rejected` with an error class and counts only; an unknown outcome is 503.',
    nextAction: 'The CLI resends the same (family, index): `accepted`, `duplicate: true`, with no duplicated rows; a different chunk at that position is `chunk-conflict`.',
    coverage: [
      { file: BACKUP, title: 'ST-10: import reproduces counts, checksums, references and original expiries; duplicate chunks are idempotent' },
      { file: BACKUP, title: 'ST-10: the source metadata row must match the manifest watermark; oversized rows and SQL constraint violations are refused with counts only' },
      { file: OPERATOR_CLI, title: 'OPS-02 import resends the same chunk after an unknown outcome' },
      { file: OPERATOR_CLI, title: 'OPS-02 import is resumable by chunk identity after an interruption' },
    ],
  },
  {
    id: 'CF-IMPORT-FINALIZE',
    code: [`${WS}/operator.ts#importBackupChunk`, `${WS}/operator.ts#finalizeImport`],
    cut: 'Finalize committed (counts, references and identities checked; `import.finalize` audit) and its reply was lost.',
    durableEvidence: 'The `import.finalize` audit row with the manifest digest and counts.',
    expectedReply: '`finalized` with counts, or `rejected` (`chunk-missing`, `count-mismatch`, `reference-invalid`).',
    nextAction: 'Replaying finalize returns the same `finalized` counts; activation may proceed.',
    coverage: [
      { file: BACKUP, title: 'ST-10: import reproduces counts, checksums, references and original expiries; duplicate chunks are idempotent' },
      { file: BACKUP, title: 'ST-10: import refuses a backup whose epoch was not rotated, and finalize refuses dangling references' },
    ],
  },
  {
    id: 'CF-EPOCH-ACTIVATE',
    code: [`${WS}/operator.ts#activateRecoveryEpoch`, `${WS}/operator.ts#settleRecoveryRequired`, `${STORE}#activateRecoveryEpoch`],
    cut: 'Activation committed (every restored nonterminal generation recovery-required, the deployment epoch activated, a mutation-sequence bump, an audit row) and its reply was lost.',
    durableEvidence: 'The activated epoch equals the Worker binding; restored jobs are recovery-required; the `epoch.activate` audit row.',
    expectedReply: '`activated` with `reconciledJobs`; an unknown outcome is 503.',
    nextAction: 'A replay answers `already-active`; old envelopes, claims and results are stale; the operator resumes work explicitly.',
    coverage: [
      { file: OPERATOR, title: 'JOB-10/OPS-03: activation reconciles every nonterminal generation to recovery-required, then old envelopes, claims and results are rejected' },
      { file: OPERATOR, title: 'JOB-10: activation never re-adopts an epoch this object already superseded, and always advances the watermark' },
      { file: BACKUP, title: 'JOB-10/ST-10: imported nonterminal jobs stay held until activation reconciles them to recovery-required' },
      { file: OPERATOR_CLI, title: 'JOB-10 recovery activate maps a held workspace to refused (exit 2) and an unknown outcome to exit 1' },
    ],
  },
  {
    id: 'CF-RESTORE-SCHEDULE',
    code: [`${WS}/operator.ts#restoreToBookmark`, `${WS}/operator.ts#restoreRefusal`, `${STORE}#restoreToBookmark`, `${STORE}#restartAfterReply`],
    cut: 'A point-in-time restore was scheduled (OPS-03 step 4) and the object reset after replying, so the reply can be lost; or the platform refused the time or bookmark. The platform applying the restore is remote only: local workerd refuses both point-in-time calls.',
    durableEvidence: 'Nothing is written before the reset (no SQL row, audit row, alarm or mutation-sequence change: the restore would rewind them), only a `restore.schedule` log event without content. After the reset the object opens on the bookmark and `status` reports the restored state and version with `configuredMatches: false`. A refusal changes nothing and never resets the object.',
    expectedReply: '`scheduled` with `bookmark` and `undoBookmark` (200); `bookmark-refused` (422) and every precondition refusal come before any point-in-time storage call; a thrown RPC is 503 `OUTCOME_UNKNOWN` and the CLI exits 1 with the current status.',
    nextAction: 'The operator reads `status`: a state or version other than the one sent means the restore ran; unchanged means the same command is repeated. A replay that meets another version conflicts, and the epoch stays unactivated until the explicit epoch check and activation.',
    coverage: [
      { file: OPERATOR, title: 'OPS-03: refuses before any point-in-time storage call unless held at the expected version with the epoch already rotated' },
      { file: OPERATOR, title: 'OPS-03: a time resolves to a bookmark, the restore is scheduled for the next session, the reply goes out, then the object restarts' },
      { file: OPERATOR, title: 'OPS-03: a bookmark is scheduled as given, from recovery as well as frozen; a platform refusal schedules nothing and never restarts' },
      { file: OPERATOR, title: 'OPS-03: through the RPC stub the scheduled reply reaches the caller, then the object really resets and reopens' },
      { file: OPERATOR, title: 'OPS-03: the local runtime has no point-in-time recovery: through the RPC stub its storage refuses and nothing is scheduled' },
      { file: OPERATOR_ROUTES, title: 'maps a thrown RPC (the object may have restarted before replying) to an unknown outcome' },
      { file: OPERATOR_CLI, title: 'OPS-03 recovery restore reports a definite refusal as exit 2 and an unknown outcome as exit 1 with the current status' },
    ],
  },
  {
    id: 'CF-MAINTENANCE-TRANSITION',
    code: [`${WS}/operator.ts#transitionMaintenance`, `${WS}/operator.ts#classifyInFlight`, `${WS}/operator.ts#audit`, `${STORE}#transitionMaintenance`],
    cut: 'A compare-and-set transition committed (state, version + 1, audit, and for frozen the classification of in-flight attempts) and its reply was lost.',
    durableEvidence: 'The new state and version and its `maintenance.transition` audit row.',
    expectedReply: '`transitioned`; an unknown outcome is 503 and the CLI exits 1 with the current status.',
    nextAction: 'The same request replays as `already`; a stale view gets `conflict` with the current state and never undoes a newer decision.',
    coverage: [
      { file: OPERATOR, title: 'OPS-01: compare-and-set transitions follow the allowed graph, resolve lost replies and audit without content' },
      { file: OPERATOR, title: 'OPS-01: freezing with in-flight attempts requires explicit classification (claimed → pending, started → recovery-required)' },
      { file: OPERATOR_CLI, title: 'OPS-01 maintenance keeps an unknown outcome or an unrecognized 5xx as exit 1 with the current status' },
    ],
  },
  {
    id: 'CF-MAINTENANCE-RESUME-ALARM',
    code: [`${WS}/operator.ts#transitionMaintenance`],
    cut: 'A transition that resumes work (frozen or recovery to open or draining) must re-arm the scheduler, which stayed inert while held.',
    durableEvidence: 'The new state and an alarm for the object\'s own now, committed in one transaction; entering a held state leaves the alarm alone.',
    expectedReply: '`transitioned`.',
    nextAction: 'The alarm runs dispatch, watchdog and cleanup and computes its next wake-up.',
    coverage: [
      { file: OPERATOR, title: 'OPS-01/JOB-05: leaving frozen re-arms the alarm by the object clock, in the transition, whatever the caller clock says' },
      { file: OPERATOR, title: 'OPS-01/JOB-05: entering a held state leaves the alarm alone; classification uses the object clock for due times' },
    ],
  },

  // ---------- Schema and bootstrap (ST-09, F2) ----------
  {
    id: 'CF-MIGRATION',
    code: [`${WS}/migrate.ts#applyMigrations`],
    cut: 'A migration statement fails, or the process dies while a migration runs.',
    durableEvidence: 'Each migration and its ledger row commit in one transactionSync: all or nothing.',
    expectedReply: 'The constructor throws and the object resets; a checksum mismatch, gap or incompatible newer schema holds the object as `schema-unsupported`.',
    nextAction: 'The next start retries the pending migration.',
    coverage: [
      { file: SCHEMA, title: 'an interrupted migration leaves no partial schema or ledger row and is retried on the next start' },
      { file: SCHEMA, title: 'refuses a ledger whose checksum differs from this build and applies nothing' },
    ],
  },
  {
    id: 'CF-BOOTSTRAP-METADATA',
    code: [`${STORE}#initialize`, `${STORE}#readiness`],
    cut: 'The migrations committed but the process died before the first `workspace_meta` insert (a separate statement after applyMigrations).',
    durableEvidence: 'Schema and ledger without metadata.',
    expectedReply: 'Readiness held until the next start.',
    nextAction: 'The next start writes the metadata only under `WORKSPACE_BOOTSTRAP` open or recovery (otherwise `workspace-uninitialized`), without re-running migrations.',
    coverage: [
      { file: FAULT_CUTS, title: 'ST-09: an object whose migrations committed but whose metadata insert never ran initializes it on the next start without re-running migrations' },
    ],
  },

  // ---------- Studies, links, consent, admission (ST-01/03/06/07) ----------
  {
    id: 'CF-STUDY-CREATE',
    code: [`${WS}/studies.ts#createStudy`, `${STORE}#createStudy`],
    cut: 'The study and its 7-day create receipt committed and the reply was lost.',
    durableEvidence: 'One study row and its receipt keyed by the Idempotency-Key digest and config fingerprint.',
    expectedReply: '`ambiguous` in the durable client; the route answers 503 `retryable`.',
    nextAction: 'The same key and fingerprint return the original study without a second row; the same key with another fingerprint is `key-reuse`.',
    coverage: [
      { file: STUDIES, title: 'ST-01: a same-key same-fingerprint replay returns the original study without a second row' },
      { file: STUDIES, title: 'ST-01: a reused key with another fingerprint is key-reuse' },
    ],
  },
  {
    id: 'CF-STUDY-EDIT',
    code: [`${WS}/studies.ts#mutateStudy`, `${STORE}#replaceStudyConfig`, `${STORE}#setStudyLinksEnabled`],
    cut: 'An expected-revision edit or links toggle committed and its reply was lost.',
    durableEvidence: 'The advanced revision; count and lock preserved.',
    expectedReply: '`ambiguous` in the durable client; the route answers 503 `retryable`.',
    nextAction: 'A replay against the old expected revision is a revision conflict, never a double edit; the researcher refreshes.',
    coverage: [
      { file: STUDIES, title: 'ST-03: replaceStudyConfig is an expected-revision compare-and-set that preserves count and lock' },
      { file: STUDIES, title: 'ST-03: toggling links advances the revision and patches only linksEnabled' },
    ],
  },
  {
    id: 'CF-STUDY-DELETE',
    code: [`${WS}/studies.ts#deleteStudy`, `${WS}/studies.ts#writeFence`, `${STORE}#deleteStudy`],
    cut: 'The delete cascade committed (links, consent, aggregate, jobs cancelled, deletion fences, receipt) and its reply was lost; or a populated delete was refused.',
    durableEvidence: 'Fences for the study and its interviews that outlive restarts; a refused delete leaves nothing behind.',
    expectedReply: '`deleted` (idempotent for an unknown id) or the refusal; a thrown RPC is `ambiguous` and the route answers 503 `retryable`.',
    nextAction: 'A replay reports deleted; late saves, deliveries and results cannot recreate anything.',
    coverage: [
      { file: STUDIES, title: 'ST-07: deletion cascades links, consent and aggregate, fences the id through restart and marks the receipt' },
      { file: STUDIES, title: 'ST-07: a refused populated delete has no side effects, so later edits and saves still succeed' },
      { file: CONSUMER, title: 'JOB-10 acknowledges a queued delivery for a deleted interview without resurrecting it' },
    ],
  },
  {
    id: 'CF-LINK-CREATE',
    code: [`${WS}/participants.ts#createParticipantLink`, `${STORE}#createParticipantLink`],
    cut: 'A participant link committed and its reply was lost.',
    durableEvidence: 'A link row holding only the SHA-256 digest of a code nobody received; it counts toward the link quota until it expires or is revoked.',
    expectedReply: '`ambiguous` in the durable client; the route answers 503 `retryable`.',
    nextAction: 'The researcher creates another link; the unusable one can be revoked from the list. No provider call is involved.',
    coverage: [
      { file: PARTICIPANTS, title: 'ST-03: link creation stores only the digest and re-checks study, links and revision at the write' },
      { file: PARTICIPANTS, title: 'ST-03: the workspace quota counts unexpired unrevoked links only' },
      { file: DURABLE_CLIENT, title: 'ST-01: a thrown RPC is never success: reads are unavailable and mutations ambiguous where their union allows' },
    ],
  },
  {
    id: 'CF-LINK-REVOKE',
    code: [`${WS}/participants.ts#revokeParticipantLink`, `${STORE}#revokeParticipantLink`],
    cut: 'A revocation committed and its reply was lost.',
    durableEvidence: 'The link marked revoked.',
    expectedReply: '`ambiguous` in the durable client; the route answers 503.',
    nextAction: 'A replay reports the prior revocation; saves under the link are refused, including replays of committed saves.',
    coverage: [
      { file: PARTICIPANTS, title: 'ST-03: revocation checks owner, then expiry, then prior revocation' },
      { file: COMPLETION, title: 'ST-03: a replay of a committed save after revoke or edit is refused, never confirmed' },
    ],
  },
  {
    id: 'CF-CONSENT',
    code: [`${WS}/participants.ts#recordConsent`, `${STORE}#recordConsent`],
    cut: 'Consent committed and its reply was lost.',
    durableEvidence: 'The consent row bound to session, study revision and consent hash, with its absolute expiry.',
    expectedReply: 'A thrown RPC is `unavailable` in the durable client (the commit may have happened); the consent route answers 503.',
    nextAction: 'A replay is first-writer-wins and never renews acceptance time or expiry.',
    coverage: [
      { file: PARTICIPANTS, title: 'ST-03: consent is first-writer-wins and a replay never renews acceptance time or absolute expiry' },
    ],
  },
  {
    id: 'CF-ADMISSION',
    code: [`${WS}/participants.ts#admitParticipantRequest`, `${WS}/budget.ts#chargeBudgetWindows`, `${STORE}#admitParticipantRequest`],
    cut: 'A greeting, interview or save admission charge committed and its reply was lost, before any provider call.',
    durableEvidence: 'The charged budget window members.',
    expectedReply: 'A thrown RPC is `unavailable` in the durable client; the route fails closed (503) before any provider call.',
    nextAction: 'A retry is charged again inside the same fixed window, so paid participant calls stay bounded by the window maximum.',
    coverage: [
      { file: PARTICIPANTS, title: 'ST-06: concurrent admissions never exceed the maximum' },
      { file: PARTICIPANTS, title: 'ST-06: a window opens at first consumption, never slides and restarts after it expires' },
      { file: PARTICIPANTS, title: 'ST-06: a denial reports the 0-based rejected row and mutates no scope' },
    ],
  },

  {
    id: 'CF-RESEARCHER-AI-ADMISSION',
    code: [`${WS}/budget.ts#admitResearcherAiRequest`, `${WS}/budget.ts#chargeBudgetWindows`, `${STORE}#admitResearcherAiRequest`],
    cut: 'A researcher AI budget charge (preview, aggregate or follow-up) committed and its reply was lost, before any provider call.',
    durableEvidence: 'The charged session and workspace budget windows.',
    expectedReply: 'A thrown RPC is `unavailable` in the durable client; the route fails closed (503) before any provider call.',
    nextAction: 'A retry is charged again inside the same fixed windows, so researcher-initiated paid calls stay bounded by the window maxima.',
    coverage: [
      { file: RESEARCHER_AI, title: 'D15: concurrent admissions never exceed the maximum' },
      { file: RESEARCHER_AI, title: 'D15: a denial reports the 0-based rejected row and mutates no scope' },
      { file: RESEARCHER_AI, title: 'D15/F26: the researcher-ai gate admits while open or draining and holds while frozen or in recovery' },
    ],
  },
  {
    id: 'CF-RETRY-BUDGET',
    code: [`${WS}/analysis.ts#acceptAnalysisRetry`, `${WS}/budget.ts#chargeBudgetWindows`, `${STORE}#acceptAnalysisRetry`],
    cut: 'A retry allocation charges the researcher `analysis` budget inside its own transaction: the charge and the new generation commit together or not at all.',
    durableEvidence: 'Charged windows only alongside a new generation, its receipt and a mutation-sequence bump; a refusal or limit leaves neither.',
    expectedReply: '`limited` (the analyze route answers 429 with Retry-After) with nothing allocated, or the usual allocation outcomes.',
    nextAction: 'A receipt replay or a second key against active work is answered without a charge; after the window the same action allocates.',
    coverage: [
      { file: RESEARCHER_AI, title: 'D15: only a newly allocated generation is charged; a receipt replay and existing active work are free' },
      { file: RESEARCHER_AI, title: 'D15: an exhausted budget is limited and allocates nothing: no job, receipt, analysis row or sequence bump' },
    ],
  },

  // ---------- Aggregates, sample workspace, sign-in (ST-07/08, F5, F26) ----------
  {
    id: 'CF-AGGREGATE-SAVE',
    code: [`${WS}/reads.ts#saveAggregate`, `${STORE}#saveAggregate`],
    cut: 'The aggregate synthesis provider call returned (paid) and then the aggregate write committed, or not, and its reply was lost.',
    durableEvidence: 'The latest aggregate replaces the previous one with a mutation-sequence bump, or nothing.',
    expectedReply: 'A thrown RPC is `unavailable` in the durable client (the write may have committed); the route answers 503.',
    nextAction: 'Regenerating is a new, explicit researcher action (a new paid call); draining, frozen and recovery refuse before any provider call.',
    coverage: [
      { file: READS, title: 'ST-08: an aggregate round-trips exactly, the latest replaces, and each write advances the mutation sequence' },
      { file: READS, title: 'ST-07: a missing or deleted study refuses the aggregate write' },
      { file: RESEARCHER_ROUTES, title: 'F26/OPS-01: aggregate synthesis is refused before any provider call when draining begins after its readiness check' },
    ],
  },
  {
    id: 'CF-SAMPLE-WORKSPACE',
    code: [`${WS}/sample.ts#seedSampleWorkspace`, `${WS}/sample.ts#clearSampleWorkspace`, `${STORE}#seedSampleWorkspace`, `${STORE}#clearSampleWorkspace`],
    cut: 'A sample seed or clear committed and its reply was lost.',
    durableEvidence: 'The whole fixture set as legacy records with no job, or its complete removal with jobs cancelled and fences written.',
    expectedReply: 'A thrown seed RPC is `unavailable` and a thrown clear is `ambiguous` in the durable client; the route answers 503.',
    nextAction: 'A replayed seed refuses the collision and writes nothing; a delayed save or delivery cannot resurrect cleared fixtures.',
    coverage: [
      { file: SAMPLE, title: 'ST-07: seeding refuses any collision and writes nothing when it refuses' },
      { file: SAMPLE, title: 'ST-07/JOB-10: clearing cascades the fixture study and interviews, cancels their jobs, fences them and allows a re-seed' },
      { file: SAMPLE, title: 'ST-07: a delayed save into a cleared fixture study cannot resurrect it, even after a re-seed' },
    ],
  },
  {
    id: 'CF-LOGIN-BUDGET',
    code: [`${WS}/login.ts#admitLoginAttempt`, `${WS}/login.ts#refundLoginAttempt`, `${STORE}#admitLoginAttempt`, `${STORE}#refundLoginAttempt`],
    cut: 'A sign-in admission committed and its reply was lost, or the refund after a correct password was lost.',
    durableEvidence: 'The attempt counted in both fixed windows (operational state, outside backups and the mutation sequence).',
    expectedReply: 'A lost admission fails closed (503); a lost refund still signs in.',
    nextAction: 'The attempt stays counted until its window ends; nothing else depends on it.',
    coverage: [
      { file: LOGIN, title: 'F5 a concurrent burst from one client reaches the password comparison at most 10 times' },
      { file: LOGIN, title: 'F5 only failures stay counted: a refunded success leaves room for the tenth failure' },
      { file: 'tests/unit/api.auth.cloudflare.test.ts', title: 'F5 a lost refund leaves the attempt counted and still signs in; the event carries no content' },
    ],
  },

  // ---------- M0 crash probes (evidence/M0-feasibility.md) ----------
  {
    id: 'M0-THROW-AFTER-ALARM',
    code: ['cloudflare/probe/probe-worker.ts#rollbackAfterSql'],
    cut: '`transaction(async)`: SQL insert, `await setAlarm()`, then a throw.',
    durableEvidence: 'Neither the row nor the alarm.',
    expectedReply: 'The throw propagates to the caller.',
    nextAction: 'The caller retries; nothing was committed.',
    coverage: [
      { file: FAULT_CUTS, title: 'M0: a throw after SQL and an awaited setAlarm inside storage.transaction rolls back both on the WorkspaceStore storage' },
      { file: COMPLETION, title: 'ST-04/JOB-05: a failed generation allocation rolls back every completion write and arms no alarm' },
    ],
  },
  {
    id: 'M0-ALARM-REJECTS',
    code: ['cloudflare/probe/probe-worker.ts#alarmRegistrationFails'],
    cut: 'SQL insert, then `setAlarm` rejects inside the transaction.',
    durableEvidence: 'Neither the row nor an alarm.',
    expectedReply: 'The rejection propagates; production maps it to `unavailable`.',
    nextAction: 'The caller retries the same action.',
    coverage: [
      { file: COMPLETION, title: 'ST-04/JOB-05: a failure while registering the alarm rolls back the SQL already written' },
      { file: ANALYSIS, title: 'JOB-05 rolls back the whole retry allocation when its alarm cannot be committed' },
    ],
  },
  {
    id: 'M0-COMPETING-DEADLINES',
    code: ['cloudflare/probe/probe-worker.ts#competing', `${WS}/context.ts#armAlarmNoLaterThan`],
    cut: 'Competing deadlines (late, earlier, later) under the minimum-deadline rule.',
    durableEvidence: 'The earliest deadline is the alarm.',
    expectedReply: 'The committed snapshot.',
    nextAction: 'The alarm fires at the earliest due time and recomputes the next one.',
    coverage: [
      { file: COMPLETION, title: 'JOB-05: an earlier existing alarm is kept and a later one is pulled forward' },
    ],
  },
  {
    id: 'M0-KILL-AFTER-COMMIT',
    code: ['cloudflare/probe/probe-worker.ts#commitThenStall'],
    cut: 'SQL and alarm committed, then SIGKILL of the whole runtime before the RPC reply; restart on the same persistence directory with no request.',
    durableEvidence: 'The row exists and the alarm fires unprompted after restart.',
    expectedReply: 'The client sees a socket error.',
    nextAction: 'The restored alarm does its work; a replay is recognized as already committed.',
    coverage: [
      { file: RESTART_COMMITTED, title: RESTART_S2 },
      { file: RESTART_COMMITTED, title: RESTART_S1 },
      { file: RESTART_TRANSACTION, title: RESTART_TX },
    ],
  },
  {
    id: 'M0-KILL-INSIDE-TRANSACTION',
    code: ['cloudflare/probe/probe-worker.ts#stallInsideTransaction'],
    cut: 'SIGKILL while an uncommitted transaction holding SQL and `setAlarm` is still open; restart on the same persistence directory.',
    durableEvidence: 'Neither the row nor its alarm; earlier committed state and its own alarm survive.',
    expectedReply: 'The client sees a socket error.',
    nextAction: 'The caller retries; the earlier committed alarm fires unprompted.',
    coverage: [
      { file: RESTART_TRANSACTION, title: RESTART_TX },
    ],
  },
];

/**
 * Write sites and RPCs the source scan finds that are not cuts of their own,
 * with the reason. A helper listed here runs only inside the named
 * transaction; a read-only surface writes nothing durable.
 */
export const NON_CUT_SURFACES: Readonly<Record<string, string>> = {
  [`${WS}/context.ts#bumpMutationSeq`]: 'helper: runs inside the caller\'s transaction',
  [`${WS}/context.ts#earliestJobDue`]: 'read helper',
  [`${WS}/participants.ts#getParticipantLink`]: 'read-only transactionSync',
  [`${WS}/participants.ts#listParticipantLinks`]: 'read-only transactionSync',
  [`${WS}/participants.ts#verifyConsent`]: 'read-only transactionSync',
  [`${WS}/reads.ts#getInterview`]: 'read-only transactionSync',
  [`${WS}/reads.ts#listInterviews`]: 'read-only transactionSync',
  [`${WS}/reads.ts#getAggregate`]: 'read-only transactionSync',
  [`${WS}/reads.ts#readAggregateInputs`]: 'read-only transactionSync',
  [`${WS}/studies.ts#getStudy`]: 'read-only transactionSync',
  [`${WS}/studies.ts#listStudies`]: 'read-only transactionSync',
  [`${STORE}#getStudy`]: 'read-only RPC',
  [`${STORE}#listStudies`]: 'read-only RPC',
  [`${STORE}#getParticipantLink`]: 'read-only RPC',
  [`${STORE}#listParticipantLinks`]: 'read-only RPC',
  [`${STORE}#verifyConsent`]: 'read-only RPC',
  [`${STORE}#getInterview`]: 'read-only RPC',
  [`${STORE}#listInterviews`]: 'read-only RPC',
  [`${STORE}#getAggregate`]: 'read-only RPC',
  [`${STORE}#readAggregateInputs`]: 'read-only RPC',
  [`${STORE}#operatorStatus`]: 'read-only RPC (reads the alarm, never sets it)',
};
