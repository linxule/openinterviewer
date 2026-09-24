// VERIFY-01 restart lane: a committed participant save across a real process
// kill. The production Worker runs from dist/cloudflare/artifact in a runner
// process (runner.mjs) that persists to a directory this file owns; each
// scenario SIGKILLs the runner's whole process group and starts a new runner
// on the same directory. State is observed only after the restart, through
// the Worker's own API, plus the runner's durable fixture record
// (events.jsonl) for provider request counts.
import { afterAll, describe, expect, it } from 'vitest';
import {
  analysisStatus,
  control,
  getInterview,
  jobLogs,
  killRunner,
  listInterviews,
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
  type AnalysisBody,
  type Runner,
} from './lane';
import { SERVED_MODEL, STUDY_MODEL } from './synthetic.mjs';
import { SYNTHESIS } from '../e2e-cloudflare/fixtureData.mjs';

const live = new Set<Runner>();
const dirs: string[] = [];

async function start(dir: string, runtime: string): Promise<Runner> {
  const runner = await startRunner(dir, runtime);
  live.add(runner);
  return runner;
}

async function kill(runner: Runner): Promise<void> {
  await killRunner(runner);
  live.delete(runner);
}

afterAll(async () => {
  for (const runner of live) await killRunner(runner).catch(() => undefined);
  for (const dir of dirs) removeStateDir(dir);
});

function refusedOutbound(dir: string) {
  return readEvents(dir).filter((event) => event.kind === 'refused');
}

async function awaitTerminal(base: string, researcher: string, studyId: string, interviewId: string): Promise<AnalysisBody> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const body = await analysisStatus(base, researcher, studyId, interviewId);
    if (body.status !== 'pending') return body;
    if (Date.now() > deadline) throw new Error('analysis still pending 30 s after the provider answered');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe('VERIFY-01 committed save across SIGKILL and restart (JOB-01/05, ST-02)', () => {
  it('VERIFY-01/JOB-05 a save committed before SIGKILL keeps its job and wake-up: after restart, with no client request, the alarm dispatches, the Queue consumer runs and the analysis completes with one synthesis request', async () => {
    const dir = makeStateDir('committed');
    dirs.push(dir);
    const first = await start(dir, 'r1');
    const { researcher, studyId, session, body, interviewId } = await participantReadyToSave(first.workerUrl);

    // The runner freezes the runtime as it forwards this reply; the kill follows.
    await control(first, '/freeze-after-save-reply');
    const reply = await save(first.workerUrl, session, body);
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual({ success: true, id: interviewId, created: true });
    await kill(first);
    expect(readEvents(dir).filter((event) => event.kind === 'frozen' && event.runtime === 'r1')).toHaveLength(1);
    // The cut precedes any provider call: the first runtime made no synthesis request.
    expect(synthesisRequests(dir, 'r1')).toEqual([]);

    const second = await start(dir, 'r2');
    // No client request: only the restored alarm and the local Queue consumer can call the provider.
    const [synthesis] = await waitFor('the synthesis request from the restarted runtime', () => {
      const requests = synthesisRequests(dir, 'r2');
      return requests.length > 0 ? requests : null;
    }, 60_000);
    await waitFor('the consumer to finish executing', () => jobLogs(dir, 'r2').find((log) => log.operation === 'execute'), 30_000);
    expect(readEvents(dir).filter((event) => event.kind === 'request' && event.runtime === 'r2')).toEqual([]);
    expect(synthesis).toMatchObject({ model: STUDY_MODEL, keyPresented: true });

    // Only now read, through the restarted Worker's API.
    expect(await awaitTerminal(second.workerUrl, researcher, studyId, interviewId)).toEqual({ status: 'complete', generation: 1 });
    const interview = await getInterview(second.workerUrl, researcher, studyId, interviewId);
    expect(interview).toMatchObject({
      id: interviewId,
      studyId,
      status: 'completed',
      transcript: body.transcript,
      synthesis: SYNTHESIS,
      aiProvider: 'openai',
      aiModel: SERVED_MODEL,
      requestedAiModel: STUDY_MODEL,
      analysis: { status: 'complete', generation: 1 },
    });
    expect((await listInterviews(second.workerUrl, researcher, studyId)).map((row) => row.id)).toEqual([interviewId]);
    const operator = await operatorStatus(second.workerUrl, await signIn(second.workerUrl));
    expect(operator.counts).toMatchObject({ interviews: 1, analysis_jobs: 1 });
    expect(operator.jobs).toMatchObject({ pending: 0, claimed: 0, started: 0, recoveryRequired: 0 });

    // Exactly one synthesis request across both runtimes, and nothing else left the Worker.
    expect(synthesisRequests(dir)).toHaveLength(1);
    expect(refusedOutbound(dir)).toEqual([]);
    await kill(second);
  });

  it('VERIFY-01/ST-02 lost save reply: the object commits, the runtime dies before the client reads the reply, and the same save replayed after restart is a duplicate with one interview, one job and one synthesis request', async () => {
    const dir = makeStateDir('lost-reply');
    dirs.push(dir);
    const first = await start(dir, 'r1');
    const { researcher, studyId, session, body, interviewId } = await participantReadyToSave(first.workerUrl);

    await control(first, '/hold-save-reply');
    const inFlight = save(first.workerUrl, session, body).then(
      (response) => ({ status: response.status }),
      (error: unknown) => ({ lost: error instanceof Error ? error.name : 'unknown' }),
    );
    // The Worker produced this reply, so the object decided; the client has not read it.
    const held = await first.held('save-reply', 30_000);
    await kill(first);
    expect(held.status).toBe(200);
    expect(await inFlight).toHaveProperty('lost');
    expect(synthesisRequests(dir, 'r1')).toEqual([]);

    const second = await start(dir, 'r2');
    // The browser's retry: same body, same participant cookie and session selector.
    const replay = await save(second.workerUrl, session, body);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ success: true, id: interviewId, created: false, duplicate: true });

    expect((await listInterviews(second.workerUrl, researcher, studyId)).map((row) => row.id)).toEqual([interviewId]);
    const operator = await operatorStatus(second.workerUrl, await signIn(second.workerUrl));
    expect(operator.counts).toMatchObject({ interviews: 1, analysis_jobs: 1 });

    // The one committed job runs once; the replay allocated nothing.
    await waitFor('the synthesis request from the restarted runtime', () => synthesisRequests(dir, 'r2').length > 0, 60_000);
    expect(await awaitTerminal(second.workerUrl, researcher, studyId, interviewId)).toEqual({ status: 'complete', generation: 1 });
    expect(synthesisRequests(dir)).toHaveLength(1);
    const after = await operatorStatus(second.workerUrl, await signIn(second.workerUrl));
    expect(after.counts).toMatchObject({ interviews: 1, analysis_jobs: 1 });
    expect(refusedOutbound(dir)).toEqual([]);
    await kill(second);
  });
});
