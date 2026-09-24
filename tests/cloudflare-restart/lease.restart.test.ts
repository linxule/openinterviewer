// VERIFY-01 restart lane: SIGKILL while a paid provider call is in flight.
// The synthetic provider holds the synthesis request, so the job's start
// marker is committed and the call has reached the provider when the runtime
// dies. After a restart on the same persistence directory the job must never
// be retried automatically: when the 180 s claim lease expires, the restored
// alarm's watchdog records recovery-required. This file waits out the real
// lease; it runs beside committed.restart.test.ts.
import { afterAll, describe, expect, it } from 'vitest';
import { ANALYSIS_CLAIM_LEASE_MS, QUEUED_SYNTHESIS_DEADLINE_MS, ANALYSIS_ATTACH_MARGIN_MS } from '../../src/lib/storage/analysisProtocol';
import {
  analysisStatus,
  getInterview,
  jobLogs,
  killRunner,
  makeStateDir,
  operatorStatus,
  participantReadyToSave,
  readEvents,
  removeStateDir,
  save,
  signIn,
  startRunner,
  synthesisRequests,
  waitFor,
  type Runner,
} from './lane';
import { STUDY_MODEL } from './synthetic.mjs';

const live = new Set<Runner>();
const dir = makeStateDir('lease');

afterAll(async () => {
  for (const runner of live) await killRunner(runner).catch(() => undefined);
  removeStateDir(dir);
});

describe('VERIFY-01 SIGKILL during a started provider call (JOB-03/08)', () => {
  it('VERIFY-01/JOB-08 a job whose provider call was in flight at SIGKILL is never retried: after restart the lease watchdog records recovery-required and the provider saw one synthesis request', async () => {
    // The lease must cover the deadline plus the attach margin, or no call starts.
    expect(ANALYSIS_CLAIM_LEASE_MS).toBeGreaterThanOrEqual(QUEUED_SYNTHESIS_DEADLINE_MS + ANALYSIS_ATTACH_MARGIN_MS);

    const first = await startRunner(dir, 'r1', { holdSynthesis: true });
    live.add(first);
    const { researcher, studyId, session, body, interviewId } = await participantReadyToSave(first.workerUrl);
    // No job exists before this request, so the claim (and its lease) is later.
    const saveSentAt = Date.now();
    const reply = await save(first.workerUrl, session, body);
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual({ success: true, id: interviewId, created: true });

    // The consumer claimed, committed its start marker and sent the request.
    await first.held('synthesis', 60_000);
    const [started] = synthesisRequests(dir, 'r1');
    expect(started).toMatchObject({ model: STUDY_MODEL, keyPresented: true });
    await killRunner(first);
    live.delete(first);

    const second = await startRunner(dir, 'r2');
    live.add(second);
    // Read-only operator view: the started job and its lease wake-up survived
    // the kill. Neither sign-in nor operator status can arm an alarm or touch a job.
    const operator = await operatorStatus(second.workerUrl, await signIn(second.workerUrl));
    expect(operator.jobs).toMatchObject({ pending: 0, claimed: 0, started: 1, recoveryRequired: 0 });
    expect(operator.counts).toMatchObject({ interviews: 1, analysis_jobs: 1 });
    // A wake-up survived that is due no later than the lease end (the lease
    // was claimed before the provider request). It may be an earlier
    // dispatch-backoff alarm, which re-arms for the lease when it finds
    // nothing due.
    const leaseEndsBy = started.at + ANALYSIS_CLAIM_LEASE_MS;
    const scheduledAt = operator.alarm.scheduledAt;
    expect(scheduledAt).not.toBeNull();
    expect(scheduledAt!).toBeLessThanOrEqual(leaseEndsBy);
    const requestsBeforeWatchdog = readEvents(dir).filter((event) => event.kind === 'request' && event.runtime === 'r2').length;

    // No further client request until the watchdog has acted on its own.
    const watchdog = await waitFor(
      'the lease-expired watchdog event',
      () => jobLogs(dir, 'r2').find((log) => log.operation === 'watchdog' && log.reason === 'lease-expired'),
      Math.max(0, leaseEndsBy - Date.now()) + 60_000,
      500,
    );
    // Not before the lease could have ended.
    expect(watchdog.at).toBeGreaterThanOrEqual(saveSentAt + ANALYSIS_CLAIM_LEASE_MS);
    expect(readEvents(dir).filter((event) => event.kind === 'request' && event.runtime === 'r2')).toHaveLength(requestsBeforeWatchdog);

    expect(await analysisStatus(second.workerUrl, researcher, studyId, interviewId)).toEqual({
      status: 'failed',
      generation: 1,
      failureKind: 'timeout',
      recoveryRequired: true,
    });
    const interview = await getInterview(second.workerUrl, researcher, studyId, interviewId);
    expect(interview).toMatchObject({ id: interviewId, synthesis: null, analysis: { status: 'failed', generation: 1, recoveryRequired: true } });
    const settled = await operatorStatus(second.workerUrl, await signIn(second.workerUrl));
    expect(settled.jobs).toMatchObject({ pending: 0, claimed: 0, started: 0, recoveryRequired: 1 });
    expect(settled.counts).toMatchObject({ interviews: 1, analysis_jobs: 1 });

    // Give any automatic retry a chance to appear; none may.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    expect(synthesisRequests(dir)).toHaveLength(1);
    expect(synthesisRequests(dir, 'r2')).toEqual([]);
    expect(readEvents(dir).filter((event) => event.kind === 'refused')).toEqual([]);
    await killRunner(second);
    live.delete(second);
  });
});
