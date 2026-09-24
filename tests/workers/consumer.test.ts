// The real Queue consumer against the real WorkspaceStore with synthetic
// provider HTTP (JOB-01/02/05/06/07/08/10, RT-05). The alarm dispatches into an
// intercepted producer; captured envelopes are delivered with
// createMessageBatch and every acknowledgement is asserted explicitly.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDurableObjectAlarm } from 'cloudflare:test';
import {
  ANALYSIS_ATTACH_MARGIN_MS,
  QUEUED_SYNTHESIS_DEADLINE_MS,
} from '../../src/lib/storage/analysisProtocol';
import { TRANSPORT_RETRY_DELAY_SECONDS } from '../../cloudflare/analysis/consumer';
import { testEnv, workspaceStub } from './helpers';
import {
  analysisRow,
  captureConsole,
  captureQueue,
  deleteInterviewLikeStudyDeletion,
  deliver,
  editStudy,
  fenceOf,
  GATEWAY_BASE,
  GATEWAY_ENV,
  installProviderFixture,
  jobRow,
  mutationSeq,
  PROVIDER_MODELS,
  resetWorkspace,
  seedJob,
  sqlRows,
  sqlRun,
  SYNTHESIS,
  TRANSCRIPT_MARKER,
  type QueueCapture,
} from './jobFixtures';

const OTHER_EPOCH = 'ep_ffffffffffffffffffffffffffffffff';

let queue: QueueCapture;

beforeEach(async () => {
  await resetWorkspace();
  queue = captureQueue();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function dispatchOnce(): Promise<unknown> {
  const before = queue.messages.length;
  expect(await runDurableObjectAlarm(workspaceStub())).toBe(true);
  expect(queue.messages.length).toBe(before + 1);
  return queue.messages[queue.messages.length - 1];
}

describe('end-to-end durable analysis (JOB-01/02/05)', () => {
  it('JOB-01/05 dispatches, claims, starts, calls the frozen provider once and attaches actual provenance', async () => {
    const job = await seedJob({ provider: 'claude' });
    const provider = installProviderFixture({ kind: 'success' });
    const message = await dispatchOnce();
    const result = await deliver([message]);
    expect(result.explicitAcks).toHaveLength(1);
    expect(result.retryMessages).toEqual([]);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toMatchObject({ provider: 'claude', url: 'https://api.anthropic.com/v1/messages' });
    expect(provider.requests[0].body).toMatchObject({ model: PROVIDER_MODELS.claude.requested });
    expect(provider.unexpected).toEqual([]);
    const row = await analysisRow(job.interviewId);
    expect(row).toMatchObject({ status: 'complete', current_generation: 1, attempts: 1, study_revision: 1 });
    expect(JSON.parse(row?.provenance_json ?? 'null')).toEqual({
      aiProvider: 'claude',
      aiModel: PROVIDER_MODELS.claude.served,
      requestedAiModel: PROVIDER_MODELS.claude.requested,
    });
    expect(JSON.parse(row?.synthesis_json ?? 'null')).toEqual(SYNTHESIS);
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'complete', next_due_at: null });
    expect(await workspaceStub().readAnalysisStatus({ studyId: job.studyId, interviewId: job.interviewId }))
      .toEqual({ status: 'ok', body: { status: 'complete', generation: 1 } });
  });

  it('JOB-02 executes the frozen provider, model and revision after the study is edited before claim', async () => {
    const job = await seedJob({ provider: 'openai' });
    const provider = installProviderFixture({ kind: 'success' });
    await editStudy(job.studyId, { aiProvider: 'claude', aiModel: 'claude-opus-5', topicAreas: ['edited'] });
    const result = await deliver([job.message]);
    expect(result.explicitAcks).toHaveLength(1);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toMatchObject({ provider: 'openai' });
    expect(provider.requests[0].body).toMatchObject({ model: PROVIDER_MODELS.openai.requested });
    expect(JSON.stringify(provider.requests[0].body)).not.toContain('edited');
    expect(await analysisRow(job.interviewId)).toMatchObject({ status: 'complete', study_revision: 1 });
  });

  it('JOB-02 keeps the frozen revision when the study changes between the provider result and attachment', async () => {
    const job = await seedJob({ provider: 'gemini' });
    const provider = installProviderFixture({ kind: 'hang' });
    const delivery = deliver([job.message]);
    await vi.waitFor(() => expect(provider.requests).toHaveLength(1), { timeout: 5_000, interval: 10 });
    await editStudy(job.studyId, { aiModel: 'gemini-2.5-pro' });
    provider.release();
    const result = await delivery;
    expect(result.explicitAcks).toHaveLength(1);
    const row = await analysisRow(job.interviewId);
    expect(row).toMatchObject({ status: 'complete', study_revision: 1 });
    expect(JSON.parse(row?.provenance_json ?? 'null')).toMatchObject({ aiProvider: 'gemini', requestedAiModel: PROVIDER_MODELS.gemini.requested });
    expect(provider.requests).toHaveLength(1);
  });

  it('RT-05 reads keys from the current env only and never persists or logs them or participant content', async () => {
    const job = await seedJob({ provider: 'openrouter' });
    installProviderFixture({ kind: 'status', status: 500 });
    const output = captureConsole();
    const message = await dispatchOnce();
    await deliver([message]);
    const rows = JSON.stringify(await sqlRows(`SELECT * FROM analysis_jobs`)) + JSON.stringify(await sqlRows(`SELECT * FROM analysis`));
    const key = testEnv.OPENROUTER_API_KEY as string;
    expect(rows).not.toContain(key);
    expect(JSON.stringify(queue.messages)).not.toContain(key);
    expect(output.text()).not.toContain(key);
    expect(output.text()).not.toContain(TRANSCRIPT_MARKER);
    expect(output.text()).toContain('"event":"analysis.job"');
  });

  it('JOB-02/RT-05 records failed/provider without any provider request when the frozen provider key is missing', async () => {
    const job = await seedJob({ provider: 'gemini' });
    const provider = installProviderFixture({ kind: 'success' });
    const result = await deliver([job.message], { env: { GEMINI_API_KEY: '' } });
    expect(result.explicitAcks).toHaveLength(1);
    expect(provider.requests).toHaveLength(0);
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'failed', failure_kind: 'provider', started_at: null });
    expect(await analysisRow(job.interviewId)).toMatchObject({ status: 'failed', failure_kind: 'provider', recovery_required: 0, attempts: 1 });
  });

  it.each([
    ['an SDK base-URL override', { ANTHROPIC_BASE_URL: 'https://attacker.invalid' }],
    ['an SDK custom-header override', { ANTHROPIC_CUSTOM_HEADERS: 'x-synthetic: 1' }],
    ['an unsupported transport', { AI_TRANSPORT: 'gateway' }],
  ])('RT-05 refuses %s before the start marker, without any provider request', async (_label, env) => {
    const job = await seedJob({ provider: 'claude' });
    const provider = installProviderFixture({ kind: 'success' });
    const output = captureConsole();
    const result = await deliver([job.message], { env });
    expect(result.explicitAcks).toHaveLength(1);
    expect(provider.requests).toHaveLength(0);
    expect(provider.unexpected).toEqual([]);
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'failed', failure_kind: 'provider', started_at: null });
    expect(output.text()).toContain('"reason":"provider-route-invalid"');
    expect(output.text()).not.toContain('attacker');
  });

  it('JOB-02 records failed/provider before the start marker, without any provider request, when the frozen model is no longer supported', async () => {
    const job = await seedJob({ provider: 'openai' });
    await sqlRun(
      `UPDATE analysis_jobs SET input_json = json_set(input_json, '$.requestedModel', 'gpt-retired'), requested_model = 'gpt-retired'
        WHERE job_id = ?`,
      job.jobId,
    );
    const provider = installProviderFixture({ kind: 'success' });
    const result = await deliver([job.message]);
    expect(result.explicitAcks).toHaveLength(1);
    expect(provider.requests).toHaveLength(0);
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'failed', failure_kind: 'provider', started_at: null });
  });

  it('JOB-09/R2 records failed/provider before the start marker, without any provider request, when the frozen adapter cannot be loaded', async () => {
    const job = await seedJob({ provider: 'openrouter' });
    const provider = installProviderFixture({ kind: 'success' });
    const output = captureConsole();
    vi.doMock('../../src/lib/providers/openrouter', () => {
      throw new Error('synthetic adapter load failure');
    });
    let result: Awaited<ReturnType<typeof deliver>>;
    try {
      result = await deliver([job.message]);
    } finally {
      vi.doUnmock('../../src/lib/providers/openrouter');
    }
    expect(result.explicitAcks).toHaveLength(1);
    expect(result.retryMessages).toEqual([]);
    expect(provider.requests).toHaveLength(0);
    expect(provider.unexpected).toEqual([]);
    // The consumer loads the adapter before the start marker, so the known
    // failure is recorded with no started attempt.
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'failed', failure_kind: 'provider', started_at: null });
    expect(await analysisRow(job.interviewId)).toMatchObject({ status: 'failed', failure_kind: 'provider', recovery_required: 0, attempts: 1 });
    const events = output.text().split('\n').flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
    expect(events).toContainEqual(expect.objectContaining({
      event: 'analysis.job', operation: 'execute', reason: 'provider-failure', provider: 'openrouter',
    }));
  });
});

describe('delivery envelopes (JOB-06/07)', () => {
  it('JOB-07 sends an unknown message version to the dead-letter path without any RPC or provider call', async () => {
    const job = await seedJob();
    const provider = installProviderFixture({ kind: 'success' });
    const result = await deliver([{ ...job.message, v: 2 }]);
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages).toHaveLength(1);
    expect(result.retryOptions).toEqual([undefined]);
    expect(provider.requests).toHaveLength(0);
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'pending', claim_nonce: null });
  });

  it('JOB-06 acknowledges malformed, foreign-workspace and foreign-epoch envelopes without writes', async () => {
    const job = await seedJob();
    const provider = installProviderFixture({ kind: 'success' });
    const before = await mutationSeq();
    const result = await deliver([
      { ...job.message, transcript: 'x' },
      { ...job.message, generation: 0 },
      'not an object',
      { ...job.message, workspaceId: 'ws_ffffffffffffffffffffffffffffffff' },
      { ...job.message, recoveryEpoch: OTHER_EPOCH },
    ]);
    expect(result.explicitAcks).toHaveLength(5);
    expect(result.retryMessages).toEqual([]);
    expect(provider.requests).toHaveLength(0);
    expect(await mutationSeq()).toBe(before);
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'pending', claim_nonce: null });
  });

  it('JOB-06 acknowledges duplicate and out-of-order deliveries without a second provider call or write', async () => {
    const job = await seedJob();
    const provider = installProviderFixture({ kind: 'success' });
    expect((await deliver([job.message])).explicitAcks).toHaveLength(1);
    const afterFirst = await mutationSeq();
    const duplicate = await deliver([job.message, job.message]);
    expect(duplicate.explicitAcks).toHaveLength(2);
    expect(provider.requests).toHaveLength(1);
    expect(await mutationSeq()).toBe(afterFirst);

    // An old generation's envelope after a newer generation exists.
    await sqlRun(`UPDATE analysis_jobs SET state = 'failed', failure_kind = 'provider' WHERE job_id = ?`, job.jobId);
    await sqlRun(`UPDATE analysis SET status = 'failed', failure_kind = 'provider', synthesis_json = NULL, provenance_json = NULL WHERE interview_id = ?`, job.interviewId);
    const retry = await workspaceStub().acceptAnalysisRetry({
      studyId: job.studyId,
      interviewId: job.interviewId,
      requestKeyDigest: 'digest-out-of-order-0001',
      requestFingerprint: 'fingerprint-v2-expected-1',
      expectedGeneration: 1,
      input: JSON.parse((await jobRow(job.jobId)).input_json),
      now: Date.now(),
    });
    expect(retry).toMatchObject({ status: 'accepted', body: { generation: 2 } });
    const beforeOld = await mutationSeq();
    expect((await deliver([job.message])).explicitAcks).toHaveLength(1);
    expect(provider.requests).toHaveLength(1);
    expect(await mutationSeq()).toBe(beforeOld);
  });

  it('JOB-07 retries transport, without a provider call, when the claim outcome cannot be confirmed', async () => {
    const job = await seedJob();
    const provider = installProviderFixture({ kind: 'success' });
    const namespace = testEnv.WORKSPACE_STORE;
    const brokenNamespace = {
      getByName: () => ({ claimAnalysisJob: async () => { throw new Error('synthetic RPC loss'); } }),
      jurisdiction: () => brokenNamespace,
    };
    const result = await deliver([job.message], { env: { WORKSPACE_STORE: brokenNamespace as unknown as typeof namespace } });
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages).toHaveLength(1);
    expect(result.retryOptions).toEqual([{ delaySeconds: TRANSPORT_RETRY_DELAY_SECONDS }]);
    expect(provider.requests).toHaveLength(0);
  });
});

describe('response loss and crashes (JOB-08)', () => {
  it('JOB-08 replays a lost claim reply with the same nonce and never lets a second invocation call the provider', async () => {
    const job = await seedJob();
    const provider = installProviderFixture({ kind: 'hang' });
    const first = deliver([job.message]);
    await vi.waitFor(() => expect(provider.requests).toHaveLength(1), { timeout: 5_000, interval: 10 });
    // A duplicate delivery while the first invocation holds the started job.
    const second = await deliver([job.message]);
    expect(second.explicitAcks).toHaveLength(1);
    expect(provider.requests).toHaveLength(1);
    provider.release();
    expect((await first).explicitAcks).toHaveLength(1);
    expect(await analysisRow(job.interviewId)).toMatchObject({ status: 'complete', attempts: 1 });
  });

  it('JOB-08 replays a lost claim reply once through a failing transport and proceeds with the same nonce', async () => {
    const job = await seedJob();
    const provider = installProviderFixture({ kind: 'success' });
    const real = testEnv.WORKSPACE_STORE;
    let claimCalls = 0;
    const nonces: string[] = [];
    const flaky = {
      jurisdiction: () => flaky,
      getByName: (name: string) => {
        const stub = real.getByName(name);
        return {
          claimAnalysisJob: async (input: { claimNonce: string }) => {
            claimCalls += 1;
            nonces.push(input.claimNonce);
            const outcome = await stub.claimAnalysisJob(input as never);
            if (claimCalls === 1) throw new Error('synthetic lost reply after commit');
            return outcome;
          },
          markAnalysisStarted: (input: never) => stub.markAnalysisStarted(input),
          finishAnalysisJob: (input: never) => stub.finishAnalysisJob(input),
        };
      },
    };
    const result = await deliver([job.message], { env: { WORKSPACE_STORE: flaky as unknown as typeof real } });
    expect(result.explicitAcks).toHaveLength(1);
    expect(claimCalls).toBe(2);
    expect(new Set(nonces).size).toBe(1);
    expect(provider.requests).toHaveLength(1);
    expect(await analysisRow(job.interviewId)).toMatchObject({ status: 'complete', attempts: 1 });
  });

  it('JOB-08 does not call the provider when the start marker cannot be confirmed', async () => {
    const job = await seedJob();
    const provider = installProviderFixture({ kind: 'success' });
    const real = testEnv.WORKSPACE_STORE;
    const noStart = {
      jurisdiction: () => noStart,
      getByName: (name: string) => {
        const stub = real.getByName(name);
        return {
          claimAnalysisJob: (input: never) => stub.claimAnalysisJob(input),
          markAnalysisStarted: async (input: never) => {
            await stub.markAnalysisStarted(input);
            throw new Error('synthetic lost start reply');
          },
          finishAnalysisJob: (input: never) => stub.finishAnalysisJob(input),
        };
      },
    };
    const result = await deliver([job.message], { env: { WORKSPACE_STORE: noStart as unknown as typeof real } });
    expect(result.retryMessages).toHaveLength(1);
    expect(result.retryOptions).toEqual([{ delaySeconds: TRANSPORT_RETRY_DELAY_SECONDS }]);
    expect(provider.requests).toHaveLength(0);
    // The marker committed; a redelivery cannot adopt it.
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'started' });
    expect((await deliver([job.message])).explicitAcks).toHaveLength(1);
    expect(provider.requests).toHaveLength(0);
  });

  it('JOB-08 recovers a lost attach reply from the terminal receipt without calling the provider again', async () => {
    const job = await seedJob();
    const provider = installProviderFixture({ kind: 'success' });
    const real = testEnv.WORKSPACE_STORE;
    const outcomes: unknown[] = [];
    const lostReply = {
      jurisdiction: () => lostReply,
      getByName: (name: string) => {
        const stub = real.getByName(name);
        return {
          claimAnalysisJob: (input: never) => stub.claimAnalysisJob(input),
          markAnalysisStarted: (input: never) => stub.markAnalysisStarted(input),
          finishAnalysisJob: async (input: never) => {
            const outcome = await stub.finishAnalysisJob(input);
            outcomes.push(outcome);
            if (outcomes.length === 1) throw new Error('synthetic lost attach reply after commit');
            return outcome;
          },
        };
      },
    };
    const result = await deliver([job.message], { env: { WORKSPACE_STORE: lostReply as unknown as typeof real } });
    expect(result.explicitAcks).toHaveLength(1);
    expect(outcomes).toEqual([{ status: 'written', replayed: false }, { status: 'written', replayed: true }]);
    expect(provider.requests).toHaveLength(1);
    expect(await analysisRow(job.interviewId)).toMatchObject({ status: 'complete', attempts: 1 });
  });

  it('JOB-08 acknowledges without a false failure when the attach reply is lost, leaving the watchdog to settle it', async () => {
    const job = await seedJob();
    const provider = installProviderFixture({ kind: 'success' });
    const real = testEnv.WORKSPACE_STORE;
    const noFinish = {
      jurisdiction: () => noFinish,
      getByName: (name: string) => {
        const stub = real.getByName(name);
        return {
          claimAnalysisJob: (input: never) => stub.claimAnalysisJob(input),
          markAnalysisStarted: (input: never) => stub.markAnalysisStarted(input),
          finishAnalysisJob: async () => { throw new Error('synthetic storage outage'); },
        };
      },
    };
    const result = await deliver([job.message], { env: { WORKSPACE_STORE: noFinish as unknown as typeof real } });
    expect(result.explicitAcks).toHaveLength(1);
    expect(provider.requests).toHaveLength(1);
    const row = await jobRow(job.jobId);
    expect(row).toMatchObject({ state: 'started' });
    expect(row.next_due_at).toBe(row.claim_expires_at);
    expect(await analysisRow(job.interviewId)).toMatchObject({ status: 'running', failure_kind: null });
  });

  it('JOB-08 turns a started job whose invocation died into recovery-required, and a late delivery never calls again', async () => {
    const job = await seedJob();
    const provider = installProviderFixture({ kind: 'success' });
    const stub = workspaceStub();
    const nonce = crypto.randomUUID();
    await stub.claimAnalysisJob({ ...fenceOf(job), claimNonce: nonce, now: Date.now() });
    await stub.markAnalysisStarted({
      ...fenceOf(job), claimNonce: nonce, requiredRemainingMs: QUEUED_SYNTHESIS_DEADLINE_MS + ANALYSIS_ATTACH_MARGIN_MS, now: Date.now(),
    });
    await sqlRun(`UPDATE analysis_jobs SET claim_expires_at = ?, next_due_at = ? WHERE job_id = ?`, Date.now() - 1, Date.now() - 1, job.jobId);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'recovery-required' });
    expect((await deliver([job.message])).explicitAcks).toHaveLength(1);
    expect(provider.requests).toHaveLength(0);
    expect(await stub.finishAnalysisJob({
      ...fenceOf(job), claimNonce: nonce, now: Date.now(),
      outcome: { kind: 'complete', synthesis: SYNTHESIS, provenance: { aiProvider: 'openai', aiModel: 'gpt-5.6-terra', requestedAiModel: 'gpt-5.6-terra' } },
    })).toEqual({ status: 'stale' });
  });
});

describe('deletion and restore fences (JOB-10)', () => {
  it('JOB-10 acknowledges a queued delivery for a deleted interview without resurrecting it', async () => {
    const job = await seedJob();
    const provider = installProviderFixture({ kind: 'success' });
    const message = await dispatchOnce();
    await deleteInterviewLikeStudyDeletion(job);
    expect((await deliver([message])).explicitAcks).toHaveLength(1);
    expect(provider.requests).toHaveLength(0);
    expect(await analysisRow(job.interviewId)).toBeNull();
    expect(await sqlRows(`SELECT id FROM interviews WHERE id = ?`, job.interviewId)).toHaveLength(0);
  });

  it('JOB-10 drops a running result after deletion without recreating any record', async () => {
    const job = await seedJob();
    const provider = installProviderFixture({ kind: 'hang' });
    const delivery = deliver([job.message]);
    await vi.waitFor(() => expect(provider.requests).toHaveLength(1), { timeout: 5_000, interval: 10 });
    await deleteInterviewLikeStudyDeletion(job);
    provider.release();
    expect((await delivery).explicitAcks).toHaveLength(1);
    expect(await analysisRow(job.interviewId)).toBeNull();
    expect(await sqlRows(`SELECT id FROM interviews WHERE id = ?`, job.interviewId)).toHaveLength(0);
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'cancelled' });
  });

  it('JOB-10 rejects old envelopes and claims after the object activates another recovery epoch', async () => {
    const job = await seedJob();
    const provider = installProviderFixture({ kind: 'success' });
    await sqlRun(`UPDATE workspace_meta SET activated_epoch = ?`, OTHER_EPOCH);
    expect((await deliver([job.message])).explicitAcks).toHaveLength(1);
    expect(provider.requests).toHaveLength(0);
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'pending', claim_nonce: null });
    // The Worker's own epoch moved too: the old envelope is now foreign.
    await sqlRun(`UPDATE workspace_meta SET activated_epoch = ?`, testEnv.ANALYSIS_RECOVERY_EPOCH);
    expect((await deliver([job.message], { env: { ANALYSIS_RECOVERY_EPOCH: OTHER_EPOCH } })).explicitAcks).toHaveLength(1);
    expect(provider.requests).toHaveLength(0);
  });

  it('OPS-01 acknowledges deliveries held by frozen maintenance without a provider call', async () => {
    const job = await seedJob();
    const provider = installProviderFixture({ kind: 'success' });
    await sqlRun(`UPDATE workspace_meta SET maintenance_state = 'frozen'`);
    expect((await deliver([job.message])).explicitAcks).toHaveLength(1);
    expect(provider.requests).toHaveLength(0);
    await sqlRun(`UPDATE workspace_meta SET maintenance_state = 'open'`);
    // Unfreezing leaves the job pending for its next dispatch.
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'pending' });
  });
});

// RT-11 / D9 through the real consumer: the gateway route from this
// invocation's env, the exact header set, the consent coverage check before
// the start marker, and the one-request outcome classes.
describe('Cloudflare AI Gateway transport in the Queue consumer (RT-11, D9)', () => {
  const GATEWAY_URL = {
    claude: `${GATEWAY_BASE}/anthropic/v1/messages`,
    openai: `${GATEWAY_BASE}/openai/responses`,
    gemini: `${GATEWAY_BASE}/google-ai-studio/v1beta/interactions`,
    openrouter: `${GATEWAY_BASE}/openrouter/chat/completions`,
  } as const;
  const EXACT = {
    'cf-aig-authorization': `Bearer ${GATEWAY_ENV.CF_AI_GATEWAY_TOKEN}`,
    'cf-aig-collect-log': 'false',
    'cf-aig-collect-log-payload': 'false',
    'cf-aig-skip-cache': 'true',
    'cf-aig-max-attempts': '1',
    'cf-aig-no-wholesale': 'true',
  };
  const cfAig = (headers: Record<string, string>) =>
    Object.fromEntries(Object.entries(headers).filter(([name]) => name.startsWith('cf-aig-')));

  it.each(['claude', 'openai', 'gemini', 'openrouter'] as const)(
    '%s: one request to the native gateway path with exactly the six cf-aig headers; provenance records the gateway',
    async (providerName) => {
      const job = await seedJob({ provider: providerName, disclosedTransport: 'cloudflare-gateway' });
      const provider = installProviderFixture({ kind: 'success' });
      const output = captureConsole();
      const result = await deliver([job.message], { env: GATEWAY_ENV });
      expect(result.explicitAcks).toHaveLength(1);
      expect(provider.unexpected).toEqual([]);
      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0].url).toBe(GATEWAY_URL[providerName]);
      expect(cfAig(provider.requests[0].headers)).toEqual(EXACT);
      const row = await analysisRow(job.interviewId);
      expect(row).toMatchObject({ status: 'complete' });
      expect(JSON.parse(row?.provenance_json ?? 'null')).toMatchObject({
        aiProvider: providerName,
        aiModel: PROVIDER_MODELS[providerName].served,
        requestedAiModel: PROVIDER_MODELS[providerName].requested,
        aiTransport: 'cloudflare-gateway',
      });
      const read = await workspaceStub().getInterview({ interviewId: job.interviewId });
      expect(read).toMatchObject({ status: 'found', interview: { aiTransport: 'cloudflare-gateway', consentTransport: 'cloudflare-gateway' } });
      expect(output.text()).toContain('"transport":"cloudflare-gateway"');
      expect(output.text()).not.toContain(GATEWAY_ENV.CF_AI_GATEWAY_TOKEN);
    },
  );

  it('routes through the gateway from the invocation env even when process.env says direct', async () => {
    const job = await seedJob({ provider: 'claude', disclosedTransport: 'cloudflare-gateway' });
    vi.stubEnv('AI_TRANSPORT', 'direct');
    try {
      const provider = installProviderFixture({ kind: 'success' });
      await deliver([job.message], { env: GATEWAY_ENV });
      expect(provider.requests.map((request) => request.url)).toEqual([GATEWAY_URL.claude]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('D9: a direct-consented job on the gateway is refused before the start marker with zero requests', async () => {
    const job = await seedJob({ provider: 'claude' });
    const provider = installProviderFixture({ kind: 'success' });
    const output = captureConsole();
    const result = await deliver([job.message], { env: GATEWAY_ENV });
    expect(result.explicitAcks).toHaveLength(1);
    expect(provider.requests).toHaveLength(0);
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'failed', failure_kind: 'provider', started_at: null });
    expect(output.text()).toContain('"reason":"transport-not-disclosed"');
  });

  it('D9: a gateway-consented job may always run direct (covered)', async () => {
    const job = await seedJob({ provider: 'openai', disclosedTransport: 'cloudflare-gateway' });
    const provider = installProviderFixture({ kind: 'success' });
    await deliver([job.message]);
    expect(provider.requests.map((request) => request.url)).toEqual(['https://api.openai.com/v1/responses']);
    expect(Object.keys(provider.requests[0].headers).filter((name) => name.startsWith('cf-aig-'))).toEqual([]);
    const row = await analysisRow(job.interviewId);
    expect(row).toMatchObject({ status: 'complete' });
    expect(JSON.parse(row?.provenance_json ?? 'null')).not.toHaveProperty('aiTransport');
  });

  it.each([
    ['the default gateway', { CF_AI_GATEWAY_ID: 'default' }],
    ['a malformed account ID', { CF_AI_GATEWAY_ACCOUNT_ID: 'acct' }],
    ['a missing Run token', { CF_AI_GATEWAY_TOKEN: '' }],
    ['gateway identifiers on direct', { AI_TRANSPORT: 'direct' }],
  ])('refuses %s before the start marker with zero requests, never falling back to direct', async (_label, override) => {
    const job = await seedJob({ provider: 'claude', disclosedTransport: 'cloudflare-gateway' });
    const provider = installProviderFixture({ kind: 'success' });
    const output = captureConsole();
    const result = await deliver([job.message], { env: { ...GATEWAY_ENV, ...override } });
    expect(result.explicitAcks).toHaveLength(1);
    expect(provider.requests).toHaveLength(0);
    expect(provider.unexpected).toEqual([]);
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'failed', failure_kind: 'provider', started_at: null });
    expect(output.text()).toContain('"reason":"provider-route-invalid"');
  });

  it('refuses when the invocation is not a Cloudflare capability, before any request', async () => {
    const job = await seedJob({ provider: 'claude', disclosedTransport: 'cloudflare-gateway' });
    const provider = installProviderFixture({ kind: 'success' });
    const result = await deliver([job.message], { env: { ...GATEWAY_ENV, DEPLOYMENT_TARGET: 'node' } });
    expect(result.explicitAcks).toHaveLength(1);
    expect(provider.requests).toHaveLength(0);
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'failed', failure_kind: 'provider', started_at: null });
  });

  it('D12: a gateway 401 AiGatewayError after the start marker is a known failure, one request', async () => {
    const job = await seedJob({ provider: 'claude', disclosedTransport: 'cloudflare-gateway' });
    const provider = installProviderFixture({
      kind: 'status',
      status: 401,
      body: { success: false, name: 'AiGatewayError', httpCode: 401, internalCode: 2009, message: 'Unauthorized' },
    });
    const output = captureConsole();
    const result = await deliver([job.message], { env: GATEWAY_ENV });
    expect(result.explicitAcks).toHaveLength(1);
    expect(provider.requests).toHaveLength(1);
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'failed', failure_kind: 'provider' });
    expect((await jobRow(job.jobId)).started_at).not.toBeNull();
    expect(output.text()).toContain('"origin":"gateway"');
    expect(output.text()).not.toContain('Unauthorized');
  });

  it.each([
    ['a gateway 502', { kind: 'status', status: 502 } as const],
    ['a gateway 524', { kind: 'status', status: 524 } as const],
    ['a dropped connection', { kind: 'network' } as const],
  ])('%s after the start marker is recovery-required with exactly one request', async (_label, behavior) => {
    const job = await seedJob({ provider: 'openai', disclosedTransport: 'cloudflare-gateway' });
    const provider = installProviderFixture(behavior);
    const result = await deliver([job.message], { env: GATEWAY_ENV });
    expect(result.explicitAcks).toHaveLength(1);
    expect(result.retryMessages).toEqual([]);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0].url).toBe(GATEWAY_URL.openai);
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'recovery-required' });
  });
});
