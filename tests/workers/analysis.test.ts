// Durable analysis RPCs in the real WorkspaceStore (workerd SQLite): researcher
// retry/status (JOB-04, API-01/02) and the consumer's claim/start/finish
// fences (JOB-03/08/10). Rows are seeded directly; no provider is involved.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { ANALYSIS_COLUMNS, projectInterview, type AnalysisRow } from '../../cloudflare/workspace/projection';
import {
  ANALYSIS_ATTACH_MARGIN_MS,
  ANALYSIS_CLAIM_LEASE_MS,
  ANALYSIS_MAX_DISPATCH_ATTEMPTS,
  ANALYSIS_MAX_PRESTART_AGE_MS,
  ANALYSIS_RETRY_RECEIPT_TTL_MS,
  QUEUED_SYNTHESIS_DEADLINE_MS,
  type AcceptAnalysisRetryInput,
  type AnalysisStatusBody,
  type ClaimAnalysisJobOutcome,
} from '../../src/lib/storage/analysisProtocol';
import { testEnv, workspaceStub } from './helpers';
import {
  analysisRow,
  captureQueue,
  deleteInterviewLikeStudyDeletion,
  deliver,
  fenceOf,
  frozenInput,
  HOUR_MS,
  installProviderFixture,
  jobRow,
  mutationSeq,
  PROVIDER_MODELS,
  resetWorkspace,
  seedInterview,
  seedJob,
  sqlRows,
  sqlRun,
  SYNTHESIS,
  type SeededInterview,
} from './jobFixtures';

const OTHER_EPOCH = 'ep_ffffffffffffffffffffffffffffffff';
const REQUIRED_REMAINING = QUEUED_SYNTHESIS_DEADLINE_MS + ANALYSIS_ATTACH_MARGIN_MS;

function retryInput(seeded: SeededInterview, overrides: Partial<AcceptAnalysisRetryInput> = {}): AcceptAnalysisRetryInput {
  return {
    studyId: seeded.studyId,
    interviewId: seeded.interviewId,
    requestKeyDigest: `digest-${crypto.randomUUID()}`,
    requestFingerprint: 'fingerprint-v2-expected-0',
    expectedGeneration: 0,
    input: frozenInput(seeded.config, 1),
    now: Date.now(),
    ...overrides,
  };
}

function expectClosedBody(body: AnalysisStatusBody): void {
  const allowed = new Set(['status', 'generation', 'phase', 'pollAfterMs', 'failureKind', 'recoveryRequired']);
  for (const key of Object.keys(body)) expect(allowed.has(key), `unexpected key ${key}`).toBe(true);
  const serialized = JSON.stringify(body);
  for (const forbidden of ['synthesis', 'jobId', 'claim', 'epoch', 'nonce', 'lease']) {
    expect(serialized).not.toContain(forbidden);
  }
}

beforeEach(async () => {
  await resetWorkspace();
  captureQueue();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readAnalysisStatus (API-02)', () => {
  it('API-02 projects a queued generation as a closed pending body', async () => {
    const job = await seedJob();
    const outcome = await workspaceStub().readAnalysisStatus({ studyId: job.studyId, interviewId: job.interviewId });
    expect(outcome).toEqual({ status: 'ok', body: { status: 'pending', generation: 1, phase: 'queued', pollAfterMs: 2000 } });
    if (outcome.status === 'ok') expectClosedBody(outcome.body);
  });

  it('API-02 projects a claimed generation as running and a recorded failure without detail', async () => {
    const job = await seedJob();
    const stub = workspaceStub();
    await stub.claimAnalysisJob({ ...fenceOf(job), claimNonce: crypto.randomUUID(), now: Date.now() });
    expect(await stub.readAnalysisStatus({ studyId: job.studyId, interviewId: job.interviewId })).toEqual({
      status: 'ok',
      body: { status: 'pending', generation: 1, phase: 'running', pollAfterMs: 2000 },
    });
    await sqlRun(`UPDATE analysis_jobs SET state = 'failed', failure_kind = 'provider', next_due_at = NULL WHERE job_id = ?`, job.jobId);
    await sqlRun(`UPDATE analysis SET status = 'failed', failure_kind = 'provider' WHERE interview_id = ?`, job.interviewId);
    const failed = await stub.readAnalysisStatus({ studyId: job.studyId, interviewId: job.interviewId });
    expect(failed).toEqual({ status: 'ok', body: { status: 'failed', generation: 1, failureKind: 'provider', recoveryRequired: false } });
    if (failed.status === 'ok') expectClosedBody(failed.body);
  });

  it('API-02/JOB-03 projects recovery-required as timeout with recoveryRequired true', async () => {
    const job = await seedJob();
    await sqlRun(`UPDATE analysis_jobs SET state = 'recovery-required', failure_kind = 'timeout', next_due_at = NULL WHERE job_id = ?`, job.jobId);
    await sqlRun(`UPDATE analysis SET status = 'failed', failure_kind = 'timeout', recovery_required = 1 WHERE interview_id = ?`, job.interviewId);
    expect(await workspaceStub().readAnalysisStatus({ studyId: job.studyId, interviewId: job.interviewId })).toEqual({
      status: 'ok',
      body: { status: 'failed', generation: 1, failureKind: 'timeout', recoveryRequired: true },
    });
  });

  it('API-02 reports an eligible legacy record as not-scheduled generation 0 and a legacy synthesis as complete', async () => {
    const legacy = await seedInterview();
    expect(await workspaceStub().readAnalysisStatus({ studyId: legacy.studyId, interviewId: legacy.interviewId })).toEqual({
      status: 'ok',
      body: { status: 'pending', generation: 0, phase: 'not-scheduled' },
    });
    const analyzed = await seedInterview({ record: { synthesis: SYNTHESIS } });
    expect(await workspaceStub().readAnalysisStatus({ studyId: analyzed.studyId, interviewId: analyzed.interviewId })).toEqual({
      status: 'ok',
      body: { status: 'complete', generation: 0 },
    });
  });

  it('API-02/JOB-10 projects restored nonterminal state without an active job as recovery-required', async () => {
    const running = await seedInterview({ record: { analysis: { status: 'running', attempts: 1, lastAttemptAt: 1 } } });
    expect(await workspaceStub().readAnalysisStatus({ studyId: running.studyId, interviewId: running.interviewId })).toEqual({
      status: 'ok',
      body: { status: 'failed', generation: 0, failureKind: 'timeout', recoveryRequired: true },
    });
    const job = await seedJob();
    await sqlRun(`DELETE FROM analysis_jobs WHERE job_id = ?`, job.jobId);
    expect(await workspaceStub().readAnalysisStatus({ studyId: job.studyId, interviewId: job.interviewId })).toEqual({
      status: 'ok',
      body: { status: 'failed', generation: 1, failureKind: 'timeout', recoveryRequired: true },
    });
  });

  it('API-02/JOB-04 projects attempted generation-0 pending state as recovery-required, never not-scheduled (F7)', async () => {
    const stub = workspaceStub();
    const status = (seeded: SeededInterview) => stub.readAnalysisStatus({ studyId: seeded.studyId, interviewId: seeded.interviewId });
    const recovery = { status: 'ok', body: { status: 'failed', generation: 0, failureKind: 'timeout', recoveryRequired: true } };
    const attempted = await seedInterview({ record: { analysis: { status: 'pending', attempts: 2, lastAttemptAt: 1 } } });
    expect(await status(attempted)).toEqual(recovery);
    const untried = await seedInterview({ record: { analysis: { status: 'pending', attempts: 0, lastAttemptAt: 1 } } });
    expect(await status(untried)).toEqual({ status: 'ok', body: { status: 'pending', generation: 0, phase: 'not-scheduled' } });
    // An imported generation-0 analysis row carries the same uncertainty.
    const imported = await seedInterview();
    await sqlRun(`INSERT INTO analysis (interview_id, status, current_generation, attempts, last_attempt_at, recovery_required, updated_at)
      VALUES (?, 'pending', 0, 3, 1, 0, 1)`, imported.interviewId);
    expect(await status(imported)).toEqual(recovery);
    // The explicit retry the disclosure offers is still accepted against generation 0.
    expect(await stub.acceptAnalysisRetry(retryInput(attempted))).toMatchObject({ status: 'accepted', body: { generation: 1 } });
    expect(await analysisRow(attempted.interviewId)).toMatchObject({ current_generation: 1, attempts: 2 });
  });

  it('API-02/JOB-04 treats an unfinished interview as not analyzable, as the Redis attach script does', async () => {
    const unfinished = await seedInterview({ record: { status: 'in_progress' } });
    const stub = workspaceStub();
    expect(await stub.readAnalysisStatus({ studyId: unfinished.studyId, interviewId: unfinished.interviewId })).toEqual({ status: 'not-found' });
    expect(await stub.acceptAnalysisRetry(retryInput(unfinished))).toEqual({ status: 'not-found' });
    expect(await sqlRows(`SELECT job_id FROM analysis_jobs WHERE interview_id = ?`, unfinished.interviewId)).toHaveLength(0);
    expect(await analysisRow(unfinished.interviewId)).toBeNull();
    // A job for an unfinished interview can only come from a corrupt import: never claimed.
    const job = await seedJob({ record: { status: 'in_progress' } });
    expect(await stub.claimAnalysisJob({ ...fenceOf(job), claimNonce: crypto.randomUUID(), now: Date.now() })).toEqual({ status: 'corrupt' });
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'pending', claim_nonce: null });
    expect(await analysisRow(job.interviewId)).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('API-02 refuses another study, a missing interview and a corrupt record distinctly', async () => {
    const job = await seedJob();
    const stub = workspaceStub();
    expect(await stub.readAnalysisStatus({ studyId: 'another-study', interviewId: job.interviewId })).toEqual({ status: 'not-found' });
    expect(await stub.readAnalysisStatus({ studyId: job.studyId, interviewId: 'missing' })).toEqual({ status: 'not-found' });
    await sqlRun(`UPDATE analysis_jobs SET state = 'failed', next_due_at = NULL WHERE job_id = ?`, job.jobId);
    await sqlRun(`UPDATE analysis SET status = 'failed', failure_kind = 'provider-message' WHERE interview_id = ?`, job.interviewId);
    expect(await stub.readAnalysisStatus({ studyId: job.studyId, interviewId: job.interviewId })).toEqual({ status: 'corrupt' });
    const broken = await seedInterview();
    await sqlRun(`UPDATE interviews SET record_json = '{"id":' WHERE id = ?`, broken.interviewId);
    expect(await stub.readAnalysisStatus({ studyId: broken.studyId, interviewId: broken.interviewId })).toEqual({ status: 'corrupt' });
  });
});

describe('acceptAnalysisRetry (JOB-04, API-01)', () => {
  it('API-01/JOB-04 allocates generation 1 for a legacy record with expectedGeneration 0, armed and receipted', async () => {
    const legacy = await seedInterview();
    const stub = workspaceStub();
    const before = await mutationSeq();
    const input = retryInput(legacy);
    const outcome = await stub.acceptAnalysisRetry(input);
    expect(outcome).toEqual({ status: 'accepted', body: { status: 'pending', generation: 1, phase: 'queued', pollAfterMs: 2000 } });
    const jobs = await sqlRows<{ job_id: string; generation: number; state: string; recovery_epoch: string; input_json: string; next_due_at: number }>(
      `SELECT job_id, generation, state, recovery_epoch, input_json, next_due_at FROM analysis_jobs WHERE interview_id = ?`,
      legacy.interviewId,
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ generation: 1, state: 'pending', recovery_epoch: testEnv.ANALYSIS_RECOVERY_EPOCH });
    expect(JSON.parse(jobs[0].input_json)).toEqual(input.input);
    expect(await analysisRow(legacy.interviewId)).toMatchObject({ status: 'pending', current_generation: 1, attempts: 0 });
    expect(await mutationSeq()).toBe(before + 1);

    // Replay with the same key never allocates again.
    expect(await stub.acceptAnalysisRetry({ ...input, now: Date.now() })).toEqual(outcome);
    expect(await sqlRows(`SELECT job_id FROM analysis_jobs WHERE interview_id = ?`, legacy.interviewId)).toHaveLength(1);
    // Same key, different intent: conflict without allocation.
    expect(await stub.acceptAnalysisRetry({ ...input, requestFingerprint: 'fingerprint-v2-expected-1', expectedGeneration: 1 }))
      .toEqual({ status: 'key-conflict' });
    expect(await sqlRows(`SELECT job_id FROM analysis_jobs WHERE interview_id = ?`, legacy.interviewId)).toHaveLength(1);
  });

  it('JOB-05 commits the retry allocation together with a durable alarm no later than its due time', async () => {
    const legacy = await seedInterview();
    const outcome = await workspaceStub().acceptAnalysisRetry(retryInput(legacy));
    expect(outcome.status).toBe('accepted');
    // The due alarm may run in the background (getAlarm() is null while a
    // handler runs). At every quiescent point a wake-up exists no later than
    // the earliest due job; a lost wake-up would stay null and time out.
    const observed = await vi.waitFor(async () => {
      const snapshot = await runInDurableObject(workspaceStub(), async (_instance, state) => ({
        alarm: await state.storage.getAlarm(),
        due: state.storage.sql.exec<{ due: number | null }>(`SELECT MIN(next_due_at) AS due FROM analysis_jobs`).one().due,
      }));
      if (snapshot.alarm === null) throw new Error('no alarm observed yet');
      return snapshot;
    }, { timeout: 3_000, interval: 20 });
    expect(observed.due).not.toBeNull();
    expect(observed.alarm as number).toBeLessThanOrEqual(observed.due as number);
  });

  it('JOB-05 rolls back the whole retry allocation when its alarm cannot be committed', async () => {
    const legacy = await seedInterview();
    const stub = workspaceStub();
    await runInDurableObject(stub, (_instance, state) => {
      vi.spyOn(state.storage, 'setAlarm').mockRejectedValueOnce(new Error('synthetic alarm write failure'));
    });
    const before = await mutationSeq();
    const input = retryInput(legacy);
    expect(await stub.acceptAnalysisRetry(input)).toEqual({ status: 'unavailable' });
    expect(await sqlRows(`SELECT job_id FROM analysis_jobs WHERE interview_id = ?`, legacy.interviewId)).toHaveLength(0);
    expect(await analysisRow(legacy.interviewId)).toBeNull();
    expect(await sqlRows(`SELECT key_digest FROM idempotency_receipts WHERE key_digest = ?`, input.requestKeyDigest)).toHaveLength(0);
    expect(await mutationSeq()).toBe(before);
    // The same intentional action succeeds once storage recovers.
    expect(await stub.acceptAnalysisRetry(input)).toMatchObject({ status: 'accepted', body: { generation: 1 } });
  });

  it('JOB-05/API-01 keeps a committed allocation and its wake-up across an object restart before the reply', async () => {
    const legacy = await seedInterview();
    const stub = workspaceStub();
    const input = retryInput(legacy);
    const accepted = await stub.acceptAnalysisRetry(input);
    await evictDurableObject(stub);
    expect(await workspaceStub().acceptAnalysisRetry({ ...input, now: Date.now() })).toEqual(accepted);
    const jobs = await sqlRows<{ next_due_at: number | null }>(`SELECT next_due_at FROM analysis_jobs WHERE interview_id = ?`, legacy.interviewId);
    expect(jobs).toHaveLength(1);
    await vi.waitFor(async () => {
      const alarm = await runInDurableObject(workspaceStub(), (_instance, state) => state.storage.getAlarm());
      expect(alarm).not.toBeNull();
    }, { timeout: 3_000, interval: 20 });
  });

  it('JOB-04 returns existing active work to a second key and records that key against it', async () => {
    const job = await seedJob();
    const stub = workspaceStub();
    const input = retryInput(job, { expectedGeneration: 5 });
    const outcome = await stub.acceptAnalysisRetry(input);
    expect(outcome).toEqual({ status: 'existing', body: { status: 'pending', generation: 1, phase: 'queued', pollAfterMs: 2000 } });
    expect(await sqlRows(`SELECT job_id FROM analysis_jobs WHERE interview_id = ?`, job.interviewId)).toHaveLength(1);
    const receipts = await sqlRows<{ disposition: string; result_json: string }>(
      `SELECT disposition, result_json FROM idempotency_receipts WHERE operation_family = 'analysis-retry' AND key_digest = ?`,
      input.requestKeyDigest,
    );
    expect(receipts).toEqual([{ disposition: 'existing', result_json: JSON.stringify({ generation: 1 }) }]);
  });

  it('JOB-04 races an initial job and two retry keys to a single active generation', async () => {
    const job = await seedJob();
    const stub = workspaceStub();
    const outcomes = await Promise.all([
      stub.acceptAnalysisRetry(retryInput(job, { expectedGeneration: 1 })),
      stub.acceptAnalysisRetry(retryInput(job, { expectedGeneration: 1 })),
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['existing', 'existing']);
    expect(await sqlRows(`SELECT job_id FROM analysis_jobs WHERE interview_id = ? AND state IN ('pending','claimed','started')`, job.interviewId))
      .toHaveLength(1);
  });

  it('JOB-04 lets exactly one of two racing keys allocate after a terminal failure', async () => {
    const job = await seedJob();
    await sqlRun(`UPDATE analysis_jobs SET state = 'failed', failure_kind = 'provider', next_due_at = NULL WHERE job_id = ?`, job.jobId);
    await sqlRun(`UPDATE analysis SET status = 'failed', failure_kind = 'provider' WHERE interview_id = ?`, job.interviewId);
    const stub = workspaceStub();
    const outcomes = await Promise.all([
      stub.acceptAnalysisRetry(retryInput(job, { expectedGeneration: 1, requestFingerprint: 'fingerprint-v2-expected-1' })),
      stub.acceptAnalysisRetry(retryInput(job, { expectedGeneration: 1, requestFingerprint: 'fingerprint-v2-expected-1' })),
    ]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['accepted', 'existing']);
    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({ body: { status: 'pending', generation: 2 } });
    }
    const jobs = await sqlRows<{ generation: number; state: string; job_id: string }>(
      `SELECT generation, state, job_id FROM analysis_jobs WHERE interview_id = ? ORDER BY generation`,
      job.interviewId,
    );
    expect(jobs.map((row) => [row.generation, row.state])).toEqual([[1, 'failed'], [2, 'pending']]);
    expect(jobs[1].job_id).not.toBe(job.jobId);
  });

  it('API-01 refuses a mismatched terminal expectedGeneration and a stale study revision without allocation', async () => {
    const job = await seedJob();
    await sqlRun(`UPDATE analysis_jobs SET state = 'failed', failure_kind = 'provider', next_due_at = NULL WHERE job_id = ?`, job.jobId);
    await sqlRun(`UPDATE analysis SET status = 'failed', failure_kind = 'provider' WHERE interview_id = ?`, job.interviewId);
    const stub = workspaceStub();
    expect(await stub.acceptAnalysisRetry(retryInput(job, { expectedGeneration: 0 }))).toEqual({ status: 'state-changed' });
    expect(await stub.acceptAnalysisRetry(retryInput(job, { expectedGeneration: 1, input: frozenInput(job.config, 7) })))
      .toEqual({ status: 'state-changed' });
    expect(await sqlRows(`SELECT job_id FROM analysis_jobs WHERE interview_id = ?`, job.interviewId)).toHaveLength(1);
  });

  it('JOB-10 replays a receipt with the current outcome and an expired receipt cannot allocate over another generation', async () => {
    const job = await seedJob();
    await sqlRun(`UPDATE analysis_jobs SET state = 'failed', failure_kind = 'provider', next_due_at = NULL WHERE job_id = ?`, job.jobId);
    await sqlRun(`UPDATE analysis SET status = 'failed', failure_kind = 'provider' WHERE interview_id = ?`, job.interviewId);
    const stub = workspaceStub();
    const input = retryInput(job, { expectedGeneration: 1 });
    expect(await stub.acceptAnalysisRetry(input)).toMatchObject({ status: 'accepted', body: { generation: 2 } });
    await sqlRun(`UPDATE analysis_jobs SET state = 'complete', next_due_at = NULL WHERE interview_id = ? AND generation = 2`, job.interviewId);
    await sqlRun(
      `UPDATE analysis SET status = 'complete', synthesis_json = ?, provenance_json = ?, study_revision = 1 WHERE interview_id = ?`,
      JSON.stringify(SYNTHESIS),
      JSON.stringify({ aiProvider: 'openai', aiModel: PROVIDER_MODELS.openai.served, requestedAiModel: PROVIDER_MODELS.openai.requested }),
      job.interviewId,
    );
    expect(await stub.acceptAnalysisRetry({ ...input, now: Date.now() }))
      .toEqual({ status: 'accepted', body: { status: 'complete', generation: 2 } });

    // Once complete, a new key sees already-complete.
    expect(await stub.acceptAnalysisRetry(retryInput(job, { expectedGeneration: 2 })))
      .toEqual({ status: 'already-complete', body: { status: 'already-complete', generation: 2 } });

    // An expired receipt is not replayed; its stale expectedGeneration cannot allocate.
    const later = input.now + ANALYSIS_RETRY_RECEIPT_TTL_MS + 1;
    await sqlRun(`UPDATE analysis_jobs SET state = 'failed', failure_kind = 'provider' WHERE interview_id = ? AND generation = 2`, job.interviewId);
    await sqlRun(`UPDATE analysis SET status = 'failed', failure_kind = 'provider', synthesis_json = NULL, provenance_json = NULL WHERE interview_id = ?`, job.interviewId);
    expect(await stub.acceptAnalysisRetry({ ...input, now: later })).toEqual({ status: 'state-changed' });
    expect(await sqlRows(`SELECT job_id FROM analysis_jobs WHERE interview_id = ?`, job.interviewId)).toHaveLength(2);
  });

  it('JOB-10 allows an explicit retry of restored uncertainty only against its current generation', async () => {
    const job = await seedJob();
    await sqlRun(`DELETE FROM analysis_jobs WHERE job_id = ?`, job.jobId);
    const stub = workspaceStub();
    expect(await stub.acceptAnalysisRetry(retryInput(job, { expectedGeneration: 0 }))).toEqual({ status: 'state-changed' });
    expect(await stub.acceptAnalysisRetry(retryInput(job, { expectedGeneration: 1, requestFingerprint: 'fingerprint-v2-expected-1' })))
      .toMatchObject({ status: 'accepted', body: { generation: 2 } });
  });

  it('JOB-04/OPS-01 refuses retries while draining, under an epoch mismatch and for a deleted parent', async () => {
    const legacy = await seedInterview();
    const stub = workspaceStub();
    await sqlRun(`UPDATE workspace_meta SET maintenance_state = 'draining'`);
    expect(await stub.acceptAnalysisRetry(retryInput(legacy))).toEqual({ status: 'held', reason: 'maintenance' });
    await sqlRun(`UPDATE workspace_meta SET maintenance_state = 'open', activated_epoch = ?`, OTHER_EPOCH);
    expect(await stub.acceptAnalysisRetry(retryInput(legacy))).toEqual({ status: 'held', reason: 'recovery-epoch-mismatch' });
    await sqlRun(`UPDATE workspace_meta SET activated_epoch = ?`, testEnv.ANALYSIS_RECOVERY_EPOCH);
    await deleteInterviewLikeStudyDeletion(legacy);
    expect(await stub.acceptAnalysisRetry(retryInput(legacy))).toEqual({ status: 'not-found' });
    expect(await sqlRows(`SELECT job_id FROM analysis_jobs WHERE interview_id = ?`, legacy.interviewId)).toHaveLength(0);
  });
});

describe('claim, start and finish fences (JOB-03/08)', () => {
  it('JOB-08 claims once, counts one attempt, replays the same nonce and refuses another invocation', async () => {
    const job = await seedJob();
    const stub = workspaceStub();
    const nonce = crypto.randomUUID();
    // The typed stub drops the variant carrying `unknown` fields; the RPC returns it intact.
    const first = await stub.claimAnalysisJob({ ...fenceOf(job), claimNonce: nonce, now: Date.now() }) as ClaimAnalysisJobOutcome;
    expect(first).toMatchObject({ status: 'claimed', replayed: false });
    if (first.status !== 'claimed') throw new Error('unreachable');
    expect(first.inputs.frozen).toEqual(frozenInput(job.config, 1));
    expect(first.inputs.interview.id).toBe(job.interviewId);
    expect(Array.isArray(first.inputs.interview.transcript)).toBe(true);
    const afterFirst = await analysisRow(job.interviewId);
    expect(afterFirst).toMatchObject({ status: 'running', attempts: 1 });

    // Lost claim reply: the same invocation replays its nonce without a second attempt.
    const replay = await stub.claimAnalysisJob({ ...fenceOf(job), claimNonce: nonce, now: Date.now() });
    expect(replay).toMatchObject({ status: 'claimed', replayed: true });
    expect((await analysisRow(job.interviewId))?.attempts).toBe(1);
    // Another invocation cannot assume ownership.
    expect(await stub.claimAnalysisJob({ ...fenceOf(job), claimNonce: crypto.randomUUID(), now: Date.now() }))
      .toEqual({ status: 'busy' });
    const row = await jobRow(job.jobId);
    expect(row).toMatchObject({ state: 'claimed', claim_nonce: nonce });
    expect(row.claim_expires_at).toBe(row.next_due_at);
  });

  it('JOB-08 requires enough lease for the deadline plus attach margin before the start marker', async () => {
    const job = await seedJob();
    const stub = workspaceStub();
    const nonce = crypto.randomUUID();
    await stub.claimAnalysisJob({ ...fenceOf(job), claimNonce: nonce, now: Date.now() });
    expect(await stub.markAnalysisStarted({ ...fenceOf(job), claimNonce: nonce, requiredRemainingMs: ANALYSIS_CLAIM_LEASE_MS + 1, now: Date.now() }))
      .toEqual({ status: 'lease-insufficient' });
    expect((await jobRow(job.jobId)).state).toBe('claimed');
    expect(await stub.markAnalysisStarted({ ...fenceOf(job), claimNonce: crypto.randomUUID(), requiredRemainingMs: REQUIRED_REMAINING, now: Date.now() }))
      .toEqual({ status: 'stale' });
    const started = await stub.markAnalysisStarted({ ...fenceOf(job), claimNonce: nonce, requiredRemainingMs: REQUIRED_REMAINING, now: Date.now() });
    expect(started).toMatchObject({ status: 'started', replayed: false });
    // Lost start reply: the same invocation, which has not called the provider, confirms its marker.
    expect(await stub.markAnalysisStarted({ ...fenceOf(job), claimNonce: nonce, requiredRemainingMs: REQUIRED_REMAINING, now: Date.now() }))
      .toMatchObject({ status: 'started', replayed: true });
    const row = await jobRow(job.jobId);
    expect(row.state).toBe('started');
    expect(row.started_at).not.toBeNull();
    // A started job is never claimable again.
    expect(await stub.claimAnalysisJob({ ...fenceOf(job), claimNonce: nonce, now: Date.now() })).toEqual({ status: 'busy' });
  });

  async function startedJob() {
    const job = await seedJob();
    const stub = workspaceStub();
    const nonce = crypto.randomUUID();
    await stub.claimAnalysisJob({ ...fenceOf(job), claimNonce: nonce, now: Date.now() });
    await stub.markAnalysisStarted({ ...fenceOf(job), claimNonce: nonce, requiredRemainingMs: REQUIRED_REMAINING, now: Date.now() });
    return { job, stub, nonce };
  }

  const provenance = {
    aiProvider: 'openai' as const,
    aiModel: PROVIDER_MODELS.openai.served,
    requestedAiModel: PROVIDER_MODELS.openai.requested,
  };

  it('JOB-03/JOB-08 attaches synthesis, provenance and the frozen revision atomically and replays the receipt', async () => {
    const { job, stub, nonce } = await startedJob();
    const before = await mutationSeq();
    const finish = { ...fenceOf(job), claimNonce: nonce, now: Date.now(), outcome: { kind: 'complete' as const, synthesis: SYNTHESIS, provenance } };
    expect(await stub.finishAnalysisJob(finish)).toEqual({ status: 'written', replayed: false });
    const row = await analysisRow(job.interviewId);
    expect(row).toMatchObject({ status: 'complete', current_generation: 1, study_revision: 1, attempts: 1 });
    expect(JSON.parse(row?.synthesis_json ?? 'null')).toEqual(SYNTHESIS);
    expect(JSON.parse(row?.provenance_json ?? 'null')).toEqual(provenance);
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'complete', next_due_at: null });
    expect(await mutationSeq()).toBe(before + 1);
    // Lost attach reply: the same invocation reads its committed receipt.
    expect(await stub.finishAnalysisJob({ ...finish, now: Date.now() })).toEqual({ status: 'written', replayed: true });
    // Anyone else is stale, including a failure report.
    expect(await stub.finishAnalysisJob({ ...finish, claimNonce: crypto.randomUUID() })).toEqual({ status: 'stale' });
    expect(await mutationSeq()).toBe(before + 1);
    // The public projection carries the attached result; the immutable record is untouched.
    const projected = await runInDurableObject(workspaceStub(), (_instance, state) => {
      const record = state.storage.sql.exec<{ record_json: string }>(`SELECT record_json FROM interviews WHERE id = ?`, job.interviewId).one();
      const analysis = state.storage.sql.exec<AnalysisRow>(`SELECT ${ANALYSIS_COLUMNS} FROM analysis WHERE interview_id = ?`, job.interviewId).one();
      return { interview: projectInterview(record.record_json, job.interviewId, analysis), recordJson: record.record_json };
    });
    expect(projected.interview).toMatchObject({
      synthesis: SYNTHESIS,
      aiProvider: 'openai',
      aiModel: PROVIDER_MODELS.openai.served,
      requestedAiModel: PROVIDER_MODELS.openai.requested,
      analysis: { status: 'complete', attempts: 1, generation: 1, studyRevision: 1 },
    });
    expect(JSON.parse(projected.recordJson).synthesis).toBeNull();
  });

  it('JOB-08 rejects a late result after lease expiry without writing', async () => {
    const { job, stub, nonce } = await startedJob();
    await sqlRun(`UPDATE analysis_jobs SET claim_expires_at = ? WHERE job_id = ?`, Date.now() - 1, job.jobId);
    const before = await mutationSeq();
    expect(await stub.finishAnalysisJob({
      ...fenceOf(job), claimNonce: nonce, now: Date.now(), outcome: { kind: 'complete', synthesis: SYNTHESIS, provenance },
    })).toEqual({ status: 'lease-expired' });
    expect(await stub.finishAnalysisJob({ ...fenceOf(job), claimNonce: nonce, now: Date.now(), outcome: { kind: 'uncertain' } }))
      .toEqual({ status: 'lease-expired' });
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'started' });
    expect(await analysisRow(job.interviewId)).toMatchObject({ status: 'running', synthesis_json: null });
    expect(await mutationSeq()).toBe(before);
  });

  it('JOB-03 records oversized, invalid-provenance and uncertain outcomes as their terminal classes', async () => {
    const big = await startedJob();
    const huge = { ...SYNTHESIS, keyInsights: Array.from({ length: 14 }, () => 'x'.repeat(19_999)) };
    expect(await big.stub.finishAnalysisJob({
      ...fenceOf(big.job), claimNonce: big.nonce, now: Date.now(), outcome: { kind: 'complete', synthesis: huge, provenance },
    })).toEqual({ status: 'too-large' });
    expect(await analysisRow(big.job.interviewId)).toMatchObject({ status: 'failed', failure_kind: 'too-large', recovery_required: 0, synthesis_json: null });

    const wrong = await startedJob();
    expect(await wrong.stub.finishAnalysisJob({
      ...fenceOf(wrong.job), claimNonce: wrong.nonce, now: Date.now(),
      outcome: { kind: 'complete', synthesis: SYNTHESIS, provenance: { ...provenance, requestedAiModel: 'gpt-5.6-sol' } },
    })).toEqual({ status: 'written', replayed: false });
    expect(await analysisRow(wrong.job.interviewId)).toMatchObject({ status: 'failed', failure_kind: 'invalid-output', synthesis_json: null });

    const uncertain = await startedJob();
    expect(await uncertain.stub.finishAnalysisJob({
      ...fenceOf(uncertain.job), claimNonce: uncertain.nonce, now: Date.now(), outcome: { kind: 'uncertain' },
    })).toEqual({ status: 'written', replayed: false });
    expect(await jobRow(uncertain.job.jobId)).toMatchObject({ state: 'recovery-required', failure_kind: 'timeout' });
    expect(await uncertain.stub.readAnalysisStatus({ studyId: uncertain.job.studyId, interviewId: uncertain.job.interviewId }))
      .toEqual({ status: 'ok', body: { status: 'failed', generation: 1, failureKind: 'timeout', recoveryRequired: true } });
  });

  it('JOB-08 records a pre-start known failure from the claim owner only', async () => {
    const job = await seedJob();
    const stub = workspaceStub();
    const nonce = crypto.randomUUID();
    await stub.claimAnalysisJob({ ...fenceOf(job), claimNonce: nonce, now: Date.now() });
    // Uncertainty requires a start marker; a claim alone cannot become recovery-required.
    expect(await stub.finishAnalysisJob({ ...fenceOf(job), claimNonce: nonce, now: Date.now(), outcome: { kind: 'uncertain' } }))
      .toEqual({ status: 'stale' });
    expect(await stub.finishAnalysisJob({
      ...fenceOf(job), claimNonce: nonce, now: Date.now(), outcome: { kind: 'failed', failureKind: 'provider' },
    })).toEqual({ status: 'written', replayed: false });
    expect(await analysisRow(job.interviewId)).toMatchObject({ status: 'failed', failure_kind: 'provider', recovery_required: 0 });
  });

  it('JOB-04/JOB-10 treats another generation, job or epoch as stale without writes', async () => {
    const { job, stub, nonce } = await startedJob();
    const before = await mutationSeq();
    const outcome = { kind: 'complete' as const, synthesis: SYNTHESIS, provenance };
    expect(await stub.finishAnalysisJob({ ...fenceOf(job), generation: 2, claimNonce: nonce, now: Date.now(), outcome })).toEqual({ status: 'stale' });
    expect(await stub.finishAnalysisJob({ ...fenceOf(job), recoveryEpoch: OTHER_EPOCH, claimNonce: nonce, now: Date.now(), outcome })).toEqual({ status: 'stale' });
    expect(await stub.finishAnalysisJob({ ...fenceOf(job), jobId: crypto.randomUUID(), claimNonce: nonce, now: Date.now(), outcome })).toEqual({ status: 'stale' });
    expect(await stub.claimAnalysisJob({ ...fenceOf(job), workspaceId: 'ws_ffffffffffffffffffffffffffffffff', claimNonce: nonce, now: Date.now() }))
      .toEqual({ status: 'stale' });
    await sqlRun(`UPDATE workspace_meta SET activated_epoch = ?`, OTHER_EPOCH);
    expect(await stub.finishAnalysisJob({ ...fenceOf(job), claimNonce: nonce, now: Date.now(), outcome })).toEqual({ status: 'stale' });
    expect(await stub.claimAnalysisJob({ ...fenceOf(job), claimNonce: crypto.randomUUID(), now: Date.now() })).toEqual({ status: 'stale' });
    await sqlRun(`UPDATE workspace_meta SET activated_epoch = ?`, testEnv.ANALYSIS_RECOVERY_EPOCH);
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'started' });
    expect(await mutationSeq()).toBe(before);
  });

  it('OPS-01 holds consumer RPCs in frozen maintenance and lets them settle while draining', async () => {
    const job = await seedJob();
    const stub = workspaceStub();
    await sqlRun(`UPDATE workspace_meta SET maintenance_state = 'frozen'`);
    expect(await stub.claimAnalysisJob({ ...fenceOf(job), claimNonce: crypto.randomUUID(), now: Date.now() })).toEqual({ status: 'held' });
    await sqlRun(`UPDATE workspace_meta SET maintenance_state = 'draining'`);
    expect(await stub.claimAnalysisJob({ ...fenceOf(job), claimNonce: crypto.randomUUID(), now: Date.now() }))
      .toMatchObject({ status: 'claimed' });
  });

  it('JOB-10 never resurrects a deleted interview from a late claim or result', async () => {
    const { job, stub, nonce } = await startedJob();
    await deleteInterviewLikeStudyDeletion(job);
    const before = await mutationSeq();
    expect(await stub.finishAnalysisJob({
      ...fenceOf(job), claimNonce: nonce, now: Date.now(), outcome: { kind: 'complete', synthesis: SYNTHESIS, provenance },
    })).toEqual({ status: 'stale' });
    expect(await stub.claimAnalysisJob({ ...fenceOf(job), claimNonce: crypto.randomUUID(), now: Date.now() })).toEqual({ status: 'cancelled' });
    expect(await analysisRow(job.interviewId)).toBeNull();
    expect(await sqlRows(`SELECT id FROM interviews WHERE id = ?`, job.interviewId)).toHaveLength(0);
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'cancelled' });
    expect(await mutationSeq()).toBe(before);
  });

  it('JOB-08/F14 measures the claim lease on the object clock when the caller clock runs ahead', async () => {
    const job = await seedJob();
    const stub = workspaceStub();
    const nonce = crypto.randomUUID();
    const outcome = await stub.claimAnalysisJob({ ...fenceOf(job), claimNonce: nonce, now: Date.now() + 10 * 60_000 });
    expect(outcome.status).toBe('claimed');
    const row = await jobRow(job.jobId);
    expect((row.claim_expires_at as number) - Date.now()).toBeLessThanOrEqual(ANALYSIS_CLAIM_LEASE_MS);
    expect(row.next_due_at).toBe(row.claim_expires_at);
    // A caller clock far ahead cannot make the remaining lease look insufficient either.
    expect(await stub.markAnalysisStarted({ ...fenceOf(job), claimNonce: nonce, requiredRemainingMs: REQUIRED_REMAINING, now: Date.now() + 10 * 60_000 }))
      .toMatchObject({ status: 'started', replayed: false });
  });

  it('JOB-08/F14 rejects a result after the lease on the object clock when the caller clock runs behind', async () => {
    const { job, stub, nonce } = await startedJob();
    await sqlRun(`UPDATE analysis_jobs SET claim_expires_at = ? WHERE job_id = ?`, Date.now() - 1, job.jobId);
    const before = await mutationSeq();
    expect(await stub.finishAnalysisJob({
      ...fenceOf(job), claimNonce: nonce, now: Date.now() - 10 * 60_000, outcome: { kind: 'complete', synthesis: SYNTHESIS, provenance },
    })).toEqual({ status: 'lease-expired' });
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'started' });
    expect(await mutationSeq()).toBe(before);
  });

  it('JOB-07 refuses a late delivery 24 hours after allocation, recording failed/storage without a provider request', async () => {
    const job = await seedJob();
    await sqlRun(`UPDATE analysis_jobs SET allocated_at = ?, dispatch_state = 'sent', dispatch_attempts = ? WHERE job_id = ?`,
      Date.now() - ANALYSIS_MAX_PRESTART_AGE_MS - HOUR_MS, ANALYSIS_MAX_DISPATCH_ATTEMPTS, job.jobId);
    const provider = installProviderFixture({ kind: 'success' });
    const result = await deliver([job.message]);
    expect(result.explicitAcks).toHaveLength(1);
    expect(provider.requests).toHaveLength(0);
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'failed', failure_kind: 'storage', claim_nonce: null, next_due_at: null });
    expect(await analysisRow(job.interviewId)).toMatchObject({ status: 'failed', failure_kind: 'storage', attempts: 0 });
    expect(await workspaceStub().claimAnalysisJob({ ...fenceOf(job), claimNonce: crypto.randomUUID(), now: Date.now() }))
      .toEqual({ status: 'terminal' });
  });

  it('JOB-07 refuses the start marker once the 24-hour pre-start cap has passed', async () => {
    const job = await seedJob();
    const stub = workspaceStub();
    const nonce = crypto.randomUUID();
    await stub.claimAnalysisJob({ ...fenceOf(job), claimNonce: nonce, now: Date.now() });
    await sqlRun(`UPDATE analysis_jobs SET allocated_at = ? WHERE job_id = ?`, Date.now() - ANALYSIS_MAX_PRESTART_AGE_MS - 1, job.jobId);
    expect(await stub.markAnalysisStarted({ ...fenceOf(job), claimNonce: nonce, requiredRemainingMs: REQUIRED_REMAINING, now: Date.now() }))
      .toEqual({ status: 'stale' });
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'failed', failure_kind: 'storage', started_at: null, next_due_at: null });
    expect(await analysisRow(job.interviewId)).toMatchObject({ status: 'failed', failure_kind: 'storage', recovery_required: 0 });
  });

  it('ST-05 refuses a corrupt frozen input without claiming', async () => {
    const job = await seedJob();
    await sqlRun(`UPDATE analysis_jobs SET input_json = '{"broken":' WHERE job_id = ?`, job.jobId);
    expect(await workspaceStub().claimAnalysisJob({ ...fenceOf(job), claimNonce: crypto.randomUUID(), now: Date.now() }))
      .toEqual({ status: 'corrupt' });
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'pending', claim_nonce: null });
    expect(await analysisRow(job.interviewId)).toMatchObject({ status: 'pending', attempts: 0 });
  });
});
