// The single alarm in the real WorkspaceStore (workerd SQLite + alarms):
// outbox dispatch, lease watchdog, dispatch budget, quarantine and bounded
// cleanup (JOB-04/05/06/07/08/10, OPS-01). The Queue producer is intercepted;
// no provider request can happen here.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import {
  ANALYSIS_ALARM_BATCH,
  ANALYSIS_ALARM_FAILURE_RETRY_MS,
  ANALYSIS_ATTACH_MARGIN_MS,
  ANALYSIS_MAX_DISPATCH_ATTEMPTS,
  ANALYSIS_MAX_PRESTART_AGE_MS,
  ANALYSIS_TERMINAL_JOB_RETENTION_MS,
  ANALYSIS_WATCHDOG_AFTER_SEND_MS,
  QUEUED_SYNTHESIS_DEADLINE_MS,
  dispatchBackoffMs,
} from '../../src/lib/storage/analysisProtocol';
import {
  runAlarm,
  quarantineBackoffMs,
  CLEANUP_BATCH,
  CLEANUP_INTERVAL_MS,
  LINK_CLEANUP_GRACE_MS,
  QUARANTINE_MAX_MS,
} from '../../cloudflare/workspace/scheduler';
import { claimAnalysisJob } from '../../cloudflare/workspace/analysis';
import { testEnv, workspaceStub } from './helpers';
import {
  analysisRow,
  captureConsole,
  captureQueue,
  currentAlarm,
  deleteInterviewLikeStudyDeletion,
  fenceOf,
  HOUR_MS,
  installProviderFixture,
  jobRow,
  mutationSeq,
  resetWorkspace,
  seedJob,
  SEND_RESPONSE,
  sqlRows,
  sqlRun,
  TRANSCRIPT_MARKER,
  workspaceContext,
  type QueueCapture,
} from './jobFixtures';

const OTHER_EPOCH = 'ep_ffffffffffffffffffffffffffffffff';
const OTHER_WORKSPACE_ID = 'ws_ffffffffffffffffffffffffffffffff';
const REQUIRED_REMAINING = QUEUED_SYNTHESIS_DEADLINE_MS + ANALYSIS_ATTACH_MARGIN_MS;

let queue: QueueCapture;

beforeEach(async () => {
  await resetWorkspace();
  queue = captureQueue();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function makeDue(jobId: string): Promise<void> {
  await sqlRun(`UPDATE analysis_jobs SET next_due_at = ? WHERE job_id = ?`, Date.now() - 1, jobId);
}

/** Run the object's alarm now; seeds an alarm first if none is scheduled. */
async function fireAlarm(): Promise<void> {
  const stub = workspaceStub();
  if ((await currentAlarm()) === null) {
    await runInDurableObject(stub, (_instance, state) => state.storage.setAlarm(Date.now() + HOUR_MS));
  }
  expect(await runDurableObjectAlarm(stub)).toBe(true);
}

describe('dispatch (JOB-05/06)', () => {
  it('JOB-06 sends one identifier-only envelope after committing its reservation, then records the send', async () => {
    const job = await seedJob();
    const provider = installProviderFixture({ kind: 'success' });
    const before = Date.now();
    await fireAlarm();
    expect(queue.messages).toEqual([job.message]);
    expect(Object.keys(queue.messages[0] as object).sort()).toEqual(
      ['generation', 'interviewId', 'jobId', 'recoveryEpoch', 'v', 'workspaceId'],
    );
    expect(JSON.stringify(queue.messages)).not.toContain(TRANSCRIPT_MARKER);
    const row = await jobRow(job.jobId);
    expect(row).toMatchObject({ state: 'pending', dispatch_state: 'sent', dispatch_attempts: 1 });
    expect(row.next_due_at as number).toBeGreaterThanOrEqual(before + ANALYSIS_WATCHDOG_AFTER_SEND_MS);
    const alarm = await currentAlarm();
    expect(alarm).not.toBeNull();
    expect(alarm as number).toBeLessThanOrEqual(row.next_due_at as number);
    expect(await analysisRow(job.interviewId)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(provider.requests).toHaveLength(0);
  });

  it('JOB-06/07 keeps the reservation and its backoff durable when the send acknowledgement is lost', async () => {
    const job = await seedJob();
    const provider = installProviderFixture({ kind: 'success' });
    queue.fail = true;
    const first = Date.now();
    await fireAlarm();
    let row = await jobRow(job.jobId);
    expect(row).toMatchObject({ state: 'pending', dispatch_state: 'reserved', dispatch_attempts: 1 });
    expect(row.next_due_at as number).toBeGreaterThanOrEqual(first + dispatchBackoffMs(1));
    expect(row.next_due_at as number).toBeLessThan(first + dispatchBackoffMs(2) + 1_000);
    expect((await currentAlarm()) as number).toBeLessThanOrEqual(row.next_due_at as number);

    await makeDue(job.jobId);
    const second = Date.now();
    await fireAlarm();
    row = await jobRow(job.jobId);
    expect(row).toMatchObject({ dispatch_state: 'reserved', dispatch_attempts: 2 });
    expect(row.next_due_at as number).toBeGreaterThanOrEqual(second + dispatchBackoffMs(2));

    queue.fail = false;
    await makeDue(job.jobId);
    await fireAlarm();
    expect(await jobRow(job.jobId)).toMatchObject({ dispatch_state: 'sent', dispatch_attempts: 3 });
    expect(queue.messages).toEqual([job.message]);
    expect(provider.requests).toHaveLength(0);
  });

  it('JOB-06 never acknowledges a send over a claim that raced it', async () => {
    const job = await seedJob();
    const nonce = crypto.randomUUID();
    const state = await runInDurableObject(workspaceStub(), (_instance, objectState) => objectState);
    // The consumer's claim lands while the object awaits the Queue send.
    vi.mocked(testEnv.ANALYSIS_QUEUE.send).mockImplementation(async (body: unknown) => {
      queue.messages.push(body);
      const claimed = await claimAnalysisJob(workspaceContext(state), { ...fenceOf(job), claimNonce: nonce, now: Date.now() });
      expect(claimed.status).toBe('claimed');
      return SEND_RESPONSE;
    });
    await fireAlarm();
    const row = await jobRow(job.jobId);
    expect(row).toMatchObject({ state: 'claimed', claim_nonce: nonce, dispatch_attempts: 1 });
    expect(row.next_due_at).toBe(row.claim_expires_at);
  });

  it('JOB-06 re-arms no later than the watchdog check in the same unit that records the send', async () => {
    const job = await seedJob();
    // Attempt 7 backs off 320 s, later than the 300 s watchdog check after an acknowledged send.
    await sqlRun(`UPDATE analysis_jobs SET dispatch_attempts = 6, dispatch_state = 'reserved', next_due_at = ? WHERE job_id = ?`,
      Date.now() - 1, job.jobId);
    expect(dispatchBackoffMs(7)).toBeGreaterThan(ANALYSIS_WATCHDOG_AFTER_SEND_MS);
    const commits: Array<{ alarm: number | null; due: number | null; dispatchState: string }> = [];
    await runInDurableObject(workspaceStub(), (_instance, state) => {
      const storage = state.storage;
      const original = storage.transaction.bind(storage) as (closure: () => Promise<unknown>) => Promise<unknown>;
      // Observe the durable state right after each committed unit, as a crash there would leave it.
      vi.spyOn(storage, 'transaction').mockImplementation((async (closure: () => Promise<unknown>) => {
        const result = await original(closure);
        const row = storage.sql
          .exec<{ next_due_at: number | null; dispatch_state: string }>(`SELECT next_due_at, dispatch_state FROM analysis_jobs WHERE job_id = ?`, job.jobId)
          .one();
        commits.push({ alarm: await storage.getAlarm(), due: row.next_due_at, dispatchState: row.dispatch_state });
        return result;
      }) as typeof storage.transaction);
    });
    await fireAlarm();
    const recorded = commits.find((commit) => commit.dispatchState === 'sent');
    expect(recorded).toBeDefined();
    expect(recorded?.alarm).not.toBeNull();
    expect(recorded?.alarm as number).toBeLessThanOrEqual(recorded?.due as number);
    expect(await jobRow(job.jobId)).toMatchObject({ dispatch_state: 'sent', dispatch_attempts: 7 });
  });

  it('JOB-06 processes at most 25 due rows per alarm and re-arms immediately for the rest', async () => {
    const jobs = [];
    for (let index = 0; index < ANALYSIS_ALARM_BATCH + 2; index += 1) jobs.push(await seedJob());
    await sqlRun(`UPDATE analysis_jobs SET next_due_at = ?`, Date.now() - 1);
    // One alarm invocation, called directly so no background alarm can interleave.
    const sent = await runInDurableObject(workspaceStub(), async (_instance, state) => {
      await runAlarm(workspaceContext(state), undefined);
      return {
        messages: queue.messages.length,
        unsent: state.storage.sql.exec(`SELECT job_id FROM analysis_jobs WHERE dispatch_state = 'unsent'`).toArray().length,
      };
    });
    expect(sent).toEqual({ messages: ANALYSIS_ALARM_BATCH, unsent: 2 });
    // The immediate re-arm dispatches the remainder well before the 5 s backoff wake-up.
    await vi.waitFor(() => expect(queue.messages).toHaveLength(ANALYSIS_ALARM_BATCH + 2), { timeout: dispatchBackoffMs(1) - 2_000, interval: 25 });
    expect(new Set(queue.messages.map((message) => (message as { jobId: string }).jobId)).size).toBe(ANALYSIS_ALARM_BATCH + 2);
  });
});

describe('dispatch budget (JOB-07)', () => {
  it('JOB-07 records failed/storage and stops after 16 dispatch attempts', async () => {
    const job = await seedJob();
    await sqlRun(`UPDATE analysis_jobs SET dispatch_attempts = ?, dispatch_state = 'sent', next_due_at = ? WHERE job_id = ?`,
      ANALYSIS_MAX_DISPATCH_ATTEMPTS, Date.now() - 1, job.jobId);
    await fireAlarm();
    expect(queue.messages).toHaveLength(0);
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'failed', failure_kind: 'storage', next_due_at: null });
    expect(await analysisRow(job.interviewId)).toMatchObject({ status: 'failed', failure_kind: 'storage', recovery_required: 0 });
    expect(await workspaceStub().readAnalysisStatus({ studyId: job.studyId, interviewId: job.interviewId }))
      .toEqual({ status: 'ok', body: { status: 'failed', generation: 1, failureKind: 'storage', recoveryRequired: false } });
  });

  it('JOB-07 records failed/storage 24 hours after allocation even with budget left', async () => {
    const job = await seedJob();
    await sqlRun(`UPDATE analysis_jobs SET allocated_at = ?, next_due_at = ? WHERE job_id = ?`,
      Date.now() - ANALYSIS_MAX_PRESTART_AGE_MS, Date.now() - 1, job.jobId);
    await fireAlarm();
    expect(queue.messages).toHaveLength(0);
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'failed', failure_kind: 'storage' });
  });

  it('JOB-06/07 re-sends an acknowledged but unclaimed delivery for one budget unit when no consumer contact followed it', async () => {
    const job = await seedJob();
    await fireAlarm();
    expect(await jobRow(job.jobId)).toMatchObject({ dispatch_state: 'sent', dispatch_attempts: 1 });
    await makeDue(job.jobId);
    await fireAlarm();
    expect(queue.messages).toEqual([job.message, job.message]);
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'pending', dispatch_state: 'sent', dispatch_attempts: 2 });
  });

  /** A consumer invocation working through other deliveries (F6 consumer contact). */
  async function consumerWorksOn(other: Awaited<ReturnType<typeof seedJob>>): Promise<void> {
    const outcome = await workspaceStub().claimAnalysisJob({ ...fenceOf(other), claimNonce: crypto.randomUUID(), now: Date.now() });
    expect(outcome.status).toBe('claimed');
  }

  it('JOB-07/F6 defers an acknowledged delivery behind a live consumer backlog without charging or re-sending', async () => {
    const job = await seedJob();
    const other = await seedJob();
    await fireAlarm();
    expect(await jobRow(job.jobId)).toMatchObject({ dispatch_state: 'sent', dispatch_attempts: 1 });
    const sends = () => queue.messages.filter((message) => (message as { jobId: string }).jobId === job.jobId).length;
    expect(sends()).toBe(1);
    // After this delivery was acknowledged, the consumer keeps claiming earlier work.
    await sqlRun(`UPDATE analysis_jobs SET updated_at = ? WHERE job_id = ?`, Date.now() - 60_000, job.jobId);
    await consumerWorksOn(other);
    await makeDue(job.jobId);
    const before = Date.now();
    await fireAlarm();
    const deferred = await jobRow(job.jobId);
    expect(deferred).toMatchObject({ state: 'pending', dispatch_state: 'sent', dispatch_attempts: 1 });
    expect(deferred.next_due_at as number).toBeGreaterThanOrEqual(before + ANALYSIS_WATCHDOG_AFTER_SEND_MS);
    expect((await currentAlarm()) as number).toBeLessThanOrEqual(deferred.next_due_at as number);
    expect(sends()).toBe(1);

    // No consumer contact during the next interval: the delivery is presumed lost.
    await makeDue(job.jobId);
    await fireAlarm();
    expect(sends()).toBe(2);
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'pending', dispatch_state: 'sent', dispatch_attempts: 2 });
  });

  it('JOB-07/F6 applies budget exhaustion only when a unit must be charged', async () => {
    const job = await seedJob();
    const other = await seedJob();
    await consumerWorksOn(other);
    // All 16 units spent; the last delivery was acknowledged before the consumer's latest contact.
    await sqlRun(`UPDATE analysis_jobs SET dispatch_attempts = ?, dispatch_state = 'sent', updated_at = ?, next_due_at = ? WHERE job_id = ?`,
      ANALYSIS_MAX_DISPATCH_ATTEMPTS, Date.now() - 60_000, Date.now() - 1, job.jobId);
    await fireAlarm();
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'pending', dispatch_state: 'sent', dispatch_attempts: ANALYSIS_MAX_DISPATCH_ATTEMPTS });
    expect(queue.messages).toHaveLength(0);
    // The consumer then goes quiet: the next check would need a 17th unit.
    await makeDue(job.jobId);
    await fireAlarm();
    expect(queue.messages).toHaveLength(0);
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'failed', failure_kind: 'storage', next_due_at: null });
  });

  it('JOB-07/F6 keeps the 24-hour pre-start cap while the consumer is live', async () => {
    const job = await seedJob();
    const other = await seedJob();
    await consumerWorksOn(other);
    await sqlRun(`UPDATE analysis_jobs SET dispatch_attempts = 1, dispatch_state = 'sent', allocated_at = ?, updated_at = ?, next_due_at = ? WHERE job_id = ?`,
      Date.now() - ANALYSIS_MAX_PRESTART_AGE_MS, Date.now() - 60_000, Date.now() - 1, job.jobId);
    await fireAlarm();
    expect(queue.messages).toHaveLength(0);
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'failed', failure_kind: 'storage', next_due_at: null });
  });
});

describe('lease watchdog (JOB-08)', () => {
  it('JOB-08 returns an expired unstarted claim to pending with a fresh dispatch and fences the old nonce', async () => {
    const job = await seedJob();
    const stub = workspaceStub();
    const nonce = crypto.randomUUID();
    await stub.claimAnalysisJob({ ...fenceOf(job), claimNonce: nonce, now: Date.now() });
    // The claiming invocation dies; the object restarts and the lease runs out.
    await evictDurableObject(stub);
    await sqlRun(`UPDATE analysis_jobs SET claim_expires_at = ?, next_due_at = ? WHERE job_id = ?`, Date.now() - 1, Date.now() - 1, job.jobId);
    await fireAlarm();
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'pending', claim_nonce: null, dispatch_state: 'sent', dispatch_attempts: 1 });
    expect(await analysisRow(job.interviewId)).toMatchObject({ status: 'pending', attempts: 1 });
    expect(queue.messages).toEqual([job.message]);
    // The old invocation can no longer start.
    expect(await stub.markAnalysisStarted({ ...fenceOf(job), claimNonce: nonce, requiredRemainingMs: REQUIRED_REMAINING, now: Date.now() }))
      .toEqual({ status: 'stale' });
  });

  it('JOB-08 marks a started job whose process died recovery-required after the lease, never pending', async () => {
    const job = await seedJob();
    const stub = workspaceStub();
    const nonce = crypto.randomUUID();
    await stub.claimAnalysisJob({ ...fenceOf(job), claimNonce: nonce, now: Date.now() });
    await stub.markAnalysisStarted({ ...fenceOf(job), claimNonce: nonce, requiredRemainingMs: REQUIRED_REMAINING, now: Date.now() });
    // Crash after the start marker: the object restarts, the lease runs out.
    await evictDurableObject(stub);
    await sqlRun(`UPDATE analysis_jobs SET claim_expires_at = ?, next_due_at = ? WHERE job_id = ?`, Date.now() - 1, Date.now() - 1, job.jobId);
    expect(await currentAlarm()).not.toBeNull();
    await fireAlarm();
    expect(queue.messages).toHaveLength(0);
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'recovery-required', failure_kind: 'timeout', next_due_at: null });
    expect(await stub.readAnalysisStatus({ studyId: job.studyId, interviewId: job.interviewId }))
      .toEqual({ status: 'ok', body: { status: 'failed', generation: 1, failureKind: 'timeout', recoveryRequired: true } });
    // No new invocation adopts permission to call.
    expect(await stub.claimAnalysisJob({ ...fenceOf(job), claimNonce: crypto.randomUUID(), now: Date.now() })).toEqual({ status: 'terminal' });
  });

  it('JOB-05 keeps an unexpired lease covered by the alarm instead of redispatching it', async () => {
    const job = await seedJob();
    const stub = workspaceStub();
    await stub.claimAnalysisJob({ ...fenceOf(job), claimNonce: crypto.randomUUID(), now: Date.now() });
    const leased = await jobRow(job.jobId);
    await sqlRun(`UPDATE analysis_jobs SET next_due_at = ? WHERE job_id = ?`, Date.now() - 1, job.jobId);
    await fireAlarm();
    expect(queue.messages).toHaveLength(0);
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'claimed', next_due_at: leased.claim_expires_at });
    expect((await currentAlarm()) as number).toBeLessThanOrEqual(leased.claim_expires_at as number);
  });
});

describe('restore, maintenance and deletion fences (JOB-10, OPS-01)', () => {
  it('JOB-10 leaves a restored alarm inert under an epoch mismatch and does not re-arm', async () => {
    const job = await seedJob();
    await makeDue(job.jobId);
    await sqlRun(`UPDATE workspace_meta SET activated_epoch = ?`, OTHER_EPOCH);
    await fireAlarm();
    expect(queue.messages).toHaveLength(0);
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'pending', dispatch_state: 'unsent', dispatch_attempts: 0 });
    expect(await currentAlarm()).toBeNull();
  });

  it('ST-09/JOB-05 keeps an hourly wake-up under a workspace identity mismatch, with no send and no write', async () => {
    const job = await seedJob();
    await makeDue(job.jobId);
    const stub = workspaceStub();
    const rowBefore = await jobRow(job.jobId);
    const metaBefore = await sqlRows(`SELECT * FROM workspace_meta`);
    // The object's stored alarm fires under a deployment whose WORKSPACE_ID no
    // longer names it (a changed or invalid binding).
    let originalEnv: unknown;
    await runInDurableObject(stub, (instance) => {
      const target = instance as unknown as { env: Record<string, unknown> };
      originalEnv = target.env;
      target.env = { ...target.env, WORKSPACE_ID: OTHER_WORKSPACE_ID };
    });
    const firedAt = Date.now();
    try {
      await fireAlarm();
    } finally {
      await runInDurableObject(stub, (instance) => {
        (instance as unknown as { env: unknown }).env = originalEnv;
      });
    }
    const alarm = await currentAlarm();
    expect(alarm).not.toBeNull();
    expect(alarm as number).toBeGreaterThanOrEqual(firedAt + HOUR_MS);
    expect(alarm as number).toBeLessThan(firedAt + HOUR_MS + 60_000);
    expect(queue.messages).toHaveLength(0);
    expect(testEnv.ANALYSIS_QUEUE.send).not.toHaveBeenCalled();
    expect(await jobRow(job.jobId)).toEqual(rowBefore);
    expect(await sqlRows(`SELECT * FROM workspace_meta`)).toEqual(metaBefore);
  });

  it('JOB-05 restores a wake-up lost under an epoch mismatch once the configuration is corrected', async () => {
    const job = await seedJob();
    const stub = workspaceStub();
    const nonce = crypto.randomUUID();
    await stub.claimAnalysisJob({ ...fenceOf(job), claimNonce: nonce, now: Date.now() });
    await stub.markAnalysisStarted({ ...fenceOf(job), claimNonce: nonce, requiredRemainingMs: REQUIRED_REMAINING, now: Date.now() });
    await sqlRun(`UPDATE analysis_jobs SET claim_expires_at = ?, next_due_at = ? WHERE job_id = ?`, Date.now() - 1, Date.now() - 1, job.jobId);
    await sqlRun(`UPDATE workspace_meta SET activated_epoch = ?`, OTHER_EPOCH);
    await fireAlarm();
    // Inert and not re-armed by itself while held.
    expect(await currentAlarm()).toBeNull();
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'started' });
    // The binding is corrected without an activation or maintenance transition.
    await sqlRun(`UPDATE workspace_meta SET activated_epoch = ?`, testEnv.ANALYSIS_RECOVERY_EPOCH);
    expect(await stub.readAnalysisStatus({ studyId: job.studyId, interviewId: job.interviewId }))
      .toEqual({ status: 'ok', body: { status: 'pending', generation: 1, phase: 'running', pollAfterMs: 2000 } });
    // That read found due work without an alarm and restored it; the platform runs it.
    await vi.waitFor(async () => expect((await jobRow(job.jobId)).state).toBe('recovery-required'), { timeout: 5_000, interval: 25 });
    expect(await stub.readAnalysisStatus({ studyId: job.studyId, interviewId: job.interviewId }))
      .toEqual({ status: 'ok', body: { status: 'failed', generation: 1, failureKind: 'timeout', recoveryRequired: true } });
  });

  it('OPS-01/F11 stops dispatch and cleanup when a freeze commits while a Queue send is in flight', async () => {
    const first = await seedJob();
    const second = await seedJob();
    await sqlRun(`UPDATE analysis_jobs SET next_due_at = ? WHERE job_id = ?`, Date.now() - 2, first.jobId);
    await makeDue(second.jobId);
    await sqlRun(`INSERT INTO consents (session_digest, study_id, record_json, expires_at) VALUES ('c-expired', 's', '{}', ?)`, Date.now() - 1_000);
    await sqlRun(`UPDATE workspace_meta SET maintenance_state = 'draining'`);
    const [{ maintenance_version: version }] = await sqlRows<{ maintenance_version: number }>(`SELECT maintenance_version FROM workspace_meta`);
    const secondBefore = await jobRow(second.jobId);
    const seqBefore = await mutationSeq();
    const transitions: unknown[] = [];
    vi.mocked(testEnv.ANALYSIS_QUEUE.send).mockImplementation(async (body: unknown) => {
      queue.messages.push(structuredClone(body));
      // The operator's freeze commits while the object awaits this send.
      if (transitions.length === 0) {
        transitions.push(await workspaceStub().transitionMaintenance({
          expectedState: 'draining', expectedVersion: version, nextState: 'frozen', now: Date.now(),
        }));
      }
      return SEND_RESPONSE;
    });
    await fireAlarm();
    expect(transitions).toEqual([{ status: 'transitioned', state: 'frozen', version: version + 1 }]);
    expect(queue.messages).toEqual([first.message]);
    // Nothing after the freeze: no acknowledgement record, no second reservation, no cleanup.
    expect(await jobRow(first.jobId)).toMatchObject({ state: 'pending', dispatch_state: 'reserved', dispatch_attempts: 1 });
    expect(await jobRow(second.jobId)).toEqual(secondBefore);
    expect(await sqlRows(`SELECT session_digest FROM consents WHERE session_digest = 'c-expired'`)).toHaveLength(1);
    expect(await mutationSeq()).toBe(seqBefore);

    // Resuming re-arms; the refused delivery is re-sent for a new unit and cleanup runs.
    expect(await workspaceStub().transitionMaintenance({ expectedState: 'frozen', expectedVersion: version + 1, nextState: 'open', now: Date.now() }))
      .toMatchObject({ status: 'transitioned', state: 'open' });
    await makeDue(first.jobId);
    await fireAlarm();
    expect(await jobRow(first.jobId)).toMatchObject({ dispatch_state: 'sent', dispatch_attempts: 2 });
    expect(await jobRow(second.jobId)).toMatchObject({ dispatch_state: 'sent', dispatch_attempts: 1 });
    expect(await sqlRows(`SELECT session_digest FROM consents WHERE session_digest = 'c-expired'`)).toHaveLength(0);
  });

  it('OPS-01/F11 stops the remaining rows and cleanup when a freeze commits during a send that then fails', async () => {
    const first = await seedJob();
    const second = await seedJob();
    await sqlRun(`UPDATE analysis_jobs SET next_due_at = ? WHERE job_id = ?`, Date.now() - 2, first.jobId);
    await makeDue(second.jobId);
    await sqlRun(`INSERT INTO consents (session_digest, study_id, record_json, expires_at) VALUES ('c-expired', 's', '{}', ?)`, Date.now() - 1_000);
    await sqlRun(`UPDATE workspace_meta SET maintenance_state = 'draining'`);
    const [{ maintenance_version: version }] = await sqlRows<{ maintenance_version: number }>(`SELECT maintenance_version FROM workspace_meta`);
    const secondBefore = await jobRow(second.jobId);
    vi.mocked(testEnv.ANALYSIS_QUEUE.send).mockImplementation(async () => {
      await workspaceStub().transitionMaintenance({ expectedState: 'draining', expectedVersion: version, nextState: 'frozen', now: Date.now() });
      throw new Error('synthetic queue send failure');
    });
    await fireAlarm();
    expect(vi.mocked(testEnv.ANALYSIS_QUEUE.send)).toHaveBeenCalledTimes(1);
    expect(await jobRow(first.jobId)).toMatchObject({ state: 'pending', dispatch_state: 'reserved', dispatch_attempts: 1 });
    expect(await jobRow(second.jobId)).toEqual(secondBefore);
    expect(await sqlRows(`SELECT session_digest FROM consents WHERE session_digest = 'c-expired'`)).toHaveLength(1);
  });

  it('OPS-01/F11 skips cleanup when a freeze commits during the last send of the batch', async () => {
    const job = await seedJob();
    await makeDue(job.jobId);
    await sqlRun(`INSERT INTO consents (session_digest, study_id, record_json, expires_at) VALUES ('c-expired', 's', '{}', ?)`, Date.now() - 1_000);
    await sqlRun(`UPDATE workspace_meta SET maintenance_state = 'draining'`);
    const [{ maintenance_version: version }] = await sqlRows<{ maintenance_version: number }>(`SELECT maintenance_version FROM workspace_meta`);
    vi.mocked(testEnv.ANALYSIS_QUEUE.send).mockImplementation(async () => {
      await workspaceStub().transitionMaintenance({ expectedState: 'draining', expectedVersion: version, nextState: 'frozen', now: Date.now() });
      throw new Error('synthetic queue send failure');
    });
    await fireAlarm();
    expect(await jobRow(job.jobId)).toMatchObject({ dispatch_state: 'reserved', dispatch_attempts: 1 });
    expect(await sqlRows(`SELECT session_digest FROM consents WHERE session_digest = 'c-expired'`)).toHaveLength(1);
  });

  it('OPS-01 fences dispatch while frozen and dispatches while draining', async () => {
    const job = await seedJob();
    await makeDue(job.jobId);
    await sqlRun(`UPDATE workspace_meta SET maintenance_state = 'frozen'`);
    await fireAlarm();
    expect(queue.messages).toHaveLength(0);
    expect(await currentAlarm()).toBeNull();
    await sqlRun(`UPDATE workspace_meta SET maintenance_state = 'draining'`);
    await fireAlarm();
    expect(queue.messages).toEqual([job.message]);
  });

  it('JOB-04/F13 quarantines a due job whose live interview has no matching analysis row, without writing it', async () => {
    const missing = await seedJob();
    const mismatched = await seedJob();
    await makeDue(missing.jobId);
    await makeDue(mismatched.jobId);
    await sqlRun(`DELETE FROM analysis WHERE interview_id = ?`, missing.interviewId);
    await sqlRun(`UPDATE analysis SET current_generation = 2 WHERE interview_id = ?`, mismatched.interviewId);
    const before = [await jobRow(missing.jobId), await jobRow(mismatched.jobId)];
    const logs = captureConsole();
    const start = Date.now();
    await fireAlarm();
    expect(queue.messages).toHaveLength(0);
    expect([await jobRow(missing.jobId), await jobRow(mismatched.jobId)]).toEqual(before);
    const corrupt = () => logs.text().split('\n').filter((line) => line.includes('"operation":"alarm"') && line.includes('"reason":"corrupt-record"'));
    expect(corrupt()).toHaveLength(2);
    // Out of the scan until its release: no immediate retry loop.
    expect((await currentAlarm()) as number).toBeGreaterThanOrEqual(start + ANALYSIS_ALARM_FAILURE_RETRY_MS);
    await fireAlarm();
    expect([await jobRow(missing.jobId), await jobRow(mismatched.jobId)]).toEqual(before);
    expect(corrupt()).toHaveLength(2);
  });

  it('JOB-10 cancels a due job whose interview is gone instead of dispatching it', async () => {
    const job = await seedJob();
    await makeDue(job.jobId);
    await sqlRun(`INSERT INTO deletion_fences (kind, target_id, deleted_at, expires_at) VALUES ('study', ?, ?, ?)`,
      job.studyId, Date.now(), Date.now() + HOUR_MS);
    await fireAlarm();
    expect(queue.messages).toHaveLength(0);
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'cancelled', next_due_at: null });
  });

  it('JOB-10 dispatches nothing for a job cancelled by deletion', async () => {
    const job = await seedJob();
    await deleteInterviewLikeStudyDeletion(job);
    await fireAlarm();
    expect(queue.messages).toHaveLength(0);
    expect(await sqlRows(`SELECT id FROM interviews WHERE id = ?`, job.interviewId)).toHaveLength(0);
  });
});

describe('alarm failure and bounded cleanup (JOB-07/10)', () => {
  it('JOB-07 persists a retry alarm before returning when storage fails during the alarm', async () => {
    const job = await seedJob();
    await makeDue(job.jobId);
    const stub = workspaceStub();
    await runInDurableObject(stub, (_instance, state) => {
      vi.spyOn(state.storage, 'transaction').mockRejectedValueOnce(new Error('synthetic storage fault'));
      vi.spyOn(state.storage, 'transactionSync').mockImplementationOnce(() => {
        throw new Error('synthetic storage fault');
      });
    });
    const before = Date.now();
    await fireAlarm();
    const alarm = await currentAlarm();
    expect(alarm).not.toBeNull();
    expect(alarm as number).toBeGreaterThanOrEqual(before + ANALYSIS_ALARM_FAILURE_RETRY_MS - 1_000);
    expect(queue.messages).toHaveLength(0);
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'pending', dispatch_attempts: 0 });
    // The failed row sits out a quarantine as long as the retry delay. An
    // object restart, which forgets the quarantine, stands in for that wait.
    await evictDurableObject(stub);
    await fireAlarm();
    expect(queue.messages).toEqual([job.message]);
  });

  it('JOB-06/F13 quarantines a row whose settlement fails, without patching it or starving the rest of the batch', async () => {
    const first = await seedJob();
    const second = await seedJob();
    await sqlRun(`UPDATE analysis_jobs SET next_due_at = ? WHERE job_id = ?`, Date.now() - 2, first.jobId);
    await makeDue(second.jobId);
    const untouched = await jobRow(first.jobId);
    const stub = workspaceStub();
    await runInDurableObject(stub, (_instance, state) => {
      vi.spyOn(state.storage, 'transaction').mockRejectedValueOnce(new Error('synthetic row fault'));
    });
    const before = Date.now();
    await fireAlarm();
    expect(queue.messages).toEqual([second.message]);
    expect(await jobRow(first.jobId)).toEqual(untouched);
    // A wake-up exists no later than the failed row's release.
    expect((await currentAlarm()) as number).toBeLessThanOrEqual(before + ANALYSIS_ALARM_FAILURE_RETRY_MS + 1_000);
    // An early wake-up keeps skipping it; after the release it settles normally.
    await fireAlarm();
    expect(await jobRow(first.jobId)).toEqual(untouched);
    await evictDurableObject(stub);
    await fireAlarm();
    expect(queue.messages).toEqual([second.message, first.message]);
  });

  it('JOB-06/F13 doubles a repeatedly failing row\'s quarantine up to an hour', () => {
    expect([1, 2, 3, 8, 50].map(quarantineBackoffMs)).toEqual([
      ANALYSIS_ALARM_FAILURE_RETRY_MS,
      2 * ANALYSIS_ALARM_FAILURE_RETRY_MS,
      4 * ANALYSIS_ALARM_FAILURE_RETRY_MS,
      QUARANTINE_MAX_MS,
      QUARANTINE_MAX_MS,
    ]);
  });

  it('JOB-10 deletes only expired rows and prunes old terminal detail but never the current or active generation', async () => {
    const now = Date.now();
    const past = now - 1_000;
    const future = now + 3 * HOUR_MS;
    await sqlRun(`INSERT INTO consents (session_digest, study_id, record_json, expires_at) VALUES ('c-old', 's', '{}', ?), ('c-new', 's', '{}', ?)`, past, future);
    await sqlRun(`INSERT INTO idempotency_receipts (operation_family, key_digest, fingerprint, disposition, created_at, expires_at)
      VALUES ('analysis-retry', 'r-old', 'f', 'accepted', ?, ?), ('analysis-retry', 'r-new', 'f', 'accepted', ?, ?)`, past, past, now, future);
    await sqlRun(`INSERT INTO budget_windows (scope_key, count, window_seconds, expires_at) VALUES ('w-old', 1, 60, ?), ('w-new', 1, 60, ?)`, past, future);
    await sqlRun(`INSERT INTO budget_members (plan_key, member, expires_at) VALUES ('p', 'm-old', ?), ('p', 'm-new', ?)`, past, future);
    await sqlRun(`INSERT INTO deletion_fences (kind, target_id, deleted_at, expires_at) VALUES ('study', 'f-old', ?, ?), ('study', 'f-new', ?, ?)`, past, past, now, future);
    await sqlRun(`INSERT INTO participant_links (id, study_id, study_revision, created_at, expires_at) VALUES
      ('l-old', 's', 1, ?, ?), ('l-recent', 's', 1, ?, ?), ('l-never', 's', 1, ?, NULL)`,
      past, now - LINK_CLEANUP_GRACE_MS - 1, past, past, past);

    const old = now - ANALYSIS_TERMINAL_JOB_RETENTION_MS - 1;
    const superseded = await seedJob();
    // Generation 1 failed long ago; generation 2 is current and also old.
    await sqlRun(`UPDATE analysis_jobs SET state = 'failed', failure_kind = 'provider', next_due_at = NULL, terminal_at = ? WHERE job_id = ?`, old, superseded.jobId);
    await sqlRun(`INSERT INTO analysis_jobs (job_id, interview_id, generation, recovery_epoch, state, input_json, requested_provider,
        requested_model, allocated_at, updated_at, dispatch_state, dispatch_attempts, terminal_at)
      SELECT ?, interview_id, 2, recovery_epoch, 'complete', input_json, requested_provider, requested_model, ?, ?, 'none', 1, ?
        FROM analysis_jobs WHERE job_id = ?`, crypto.randomUUID(), old, old, old, superseded.jobId);
    await sqlRun(`UPDATE analysis SET status = 'complete', current_generation = 2, synthesis_json = '{}', provenance_json = '{}' WHERE interview_id = ?`, superseded.interviewId);
    const active = await seedJob();
    await sqlRun(`UPDATE analysis_jobs SET allocated_at = ?, updated_at = ?, next_due_at = ? WHERE job_id = ?`, old, old, future, active.jobId);

    await fireAlarm();
    const keys = async (query: string) => (await sqlRows<{ k: string }>(query)).map((row) => row.k).sort();
    expect(await keys(`SELECT session_digest AS k FROM consents`)).toEqual(['c-new']);
    expect(await keys(`SELECT key_digest AS k FROM idempotency_receipts`)).toEqual(['r-new']);
    expect(await keys(`SELECT scope_key AS k FROM budget_windows`)).toEqual(['w-new']);
    expect(await keys(`SELECT member AS k FROM budget_members`)).toEqual(['m-new']);
    expect(await keys(`SELECT target_id AS k FROM deletion_fences`)).toEqual(['f-new']);
    expect(await keys(`SELECT id AS k FROM participant_links`)).toEqual(['l-never', 'l-recent']);
    const remaining = await sqlRows<{ interview_id: string; generation: number; state: string }>(
      `SELECT interview_id, generation, state FROM analysis_jobs ORDER BY interview_id, generation`,
    );
    expect(remaining).toEqual(expect.arrayContaining([
      { interview_id: superseded.interviewId, generation: 2, state: 'complete' },
      { interview_id: active.interviewId, generation: 1, state: 'pending' },
    ]));
    expect(remaining).toHaveLength(2);
    // Remaining expiries wake cleanup no sooner than the cleanup interval.
    const alarm = await currentAlarm();
    expect(alarm).not.toBeNull();
    expect(alarm as number).toBeLessThanOrEqual(future);
    expect(alarm as number).toBeGreaterThanOrEqual(now + CLEANUP_INTERVAL_MS - 1_000);
  });

  it('JOB-10 bounds cleanup per alarm and re-arms immediately when a batch was full', async () => {
    const past = Date.now() - 1_000;
    for (let index = 0; index < CLEANUP_BATCH + 5; index += 1) {
      await sqlRun(`INSERT INTO consents (session_digest, study_id, record_json, expires_at) VALUES (?, 's', '{}', ?)`, `c-${index}`, past);
    }
    await runInDurableObject(workspaceStub(), (_instance, state) => runAlarm(workspaceContext(state), undefined));
    expect(await sqlRows(`SELECT session_digest FROM consents`)).toHaveLength(5);
    await vi.waitFor(async () => expect(await sqlRows(`SELECT session_digest FROM consents`)).toHaveLength(0), { timeout: 5_000, interval: 25 });
  });
});
