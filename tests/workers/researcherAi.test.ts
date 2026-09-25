// Researcher AI budget in the real WorkspaceStore (workerd SQLite, D15): the
// admitResearcherAiRequest RPC (check-all-then-charge in one transaction,
// first-consumption windows, the researcher-ai maintenance gate), key domain
// separation through the durable client, and the analysis retry's charge,
// taken only when a new generation is allocated.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import type { AcceptAnalysisRetryInput } from '../../src/lib/storage/analysisProtocol';
import { createDurableWorkspaceStore } from '../../src/lib/storage/durableObject';
import { testEnv, workspaceStub } from './helpers';
import { count, randomHex64, setMaintenance, sql, T0 } from './fixtures';
import {
  captureQueue,
  frozenInput,
  mutationSeq,
  resetWorkspace,
  seedInterview,
  seedJob,
  sqlRows,
  type SeededInterview,
} from './jobFixtures';

const SALT = 'synthetic-rate-limit-salt-0123456789abcdef';

beforeEach(async () => {
  await resetWorkspace();
  captureQueue();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function realStore() {
  return createDurableWorkspaceStore({
    namespace: testEnv.WORKSPACE_STORE,
    workspaceId: testEnv.WORKSPACE_ID,
    jurisdiction: '',
    rateLimitSalt: SALT,
  });
}

describe('admitResearcherAiRequest (D15)', () => {
  it('D15: a denial reports the 0-based rejected row and mutates no scope', async () => {
    const session = randomHex64();
    const workspace = randomHex64();
    const counters = [
      { key: session, maximum: 1, windowSeconds: 3_600 },
      { key: workspace, maximum: 100, windowSeconds: 86_400 },
    ];
    expect(await workspaceStub().admitResearcherAiRequest({ operation: 'aggregate', counters, now: T0 })).toEqual({ status: 'admitted' });
    const before = await sql(`SELECT * FROM budget_windows ORDER BY scope_key`);

    expect(await workspaceStub().admitResearcherAiRequest({ operation: 'aggregate', counters, now: T0 + 1_000 }))
      .toEqual({ status: 'limited', rejectedIndex: 0, retryAfterSeconds: 3_599 });
    expect(await sql(`SELECT * FROM budget_windows ORDER BY scope_key`)).toEqual(before);
  });

  it('D15: a window opens at first consumption, never slides and restarts after it expires', async () => {
    const counters = [{ key: randomHex64(), maximum: 2, windowSeconds: 600 }];
    const admit = (now: number) => workspaceStub().admitResearcherAiRequest({ operation: 'greeting', counters, now });
    expect(await admit(T0)).toEqual({ status: 'admitted' });
    expect(await admit(T0 + 300_000)).toEqual({ status: 'admitted' });
    expect(await admit(T0 + 599_999)).toEqual({ status: 'limited', rejectedIndex: 0, retryAfterSeconds: 1 });
    expect(await admit(T0 + 600_000)).toEqual({ status: 'admitted' });
    expect(await sql(`SELECT count, window_seconds, expires_at FROM budget_windows`))
      .toEqual([{ count: 1, window_seconds: 600, expires_at: T0 + 1_200_000 }]);
  });

  it('D15: concurrent admissions never exceed the maximum', async () => {
    const counters = [{ key: randomHex64(), maximum: 3, windowSeconds: 3_600 }];
    const outcomes = await Promise.all(Array.from({ length: 10 }, () =>
      workspaceStub().admitResearcherAiRequest({ operation: 'followup', counters, now: T0 })));
    expect(outcomes.filter((outcome) => outcome.status === 'admitted')).toHaveLength(3);
    expect(outcomes.filter((outcome) => outcome.status === 'limited')).toHaveLength(7);
    expect(await sql(`SELECT count FROM budget_windows`)).toEqual([{ count: 3 }]);
  });

  it('D15: an unknown operation, raw keys or no counters are refused without a write', async () => {
    const valid = [{ key: randomHex64(), maximum: 5, windowSeconds: 60 }];
    const stub = workspaceStub();
    expect(await stub.admitResearcherAiRequest({ operation: 'save' as never, counters: valid, now: T0 })).toEqual({ status: 'unavailable' });
    expect(await stub.admitResearcherAiRequest({
      operation: 'synthesis',
      counters: [{ key: 'researcher-ai:synthesis:researcher:86400:workspace', maximum: 5, windowSeconds: 60 }],
      now: T0,
    })).toEqual({ status: 'unavailable' });
    expect(await stub.admitResearcherAiRequest({ operation: 'synthesis', counters: [], now: T0 })).toEqual({ status: 'unavailable' });
    expect(await count('budget_windows')).toBe(0);
  });

  it('D15/F26: the researcher-ai gate admits while open or draining and holds while frozen or in recovery', async () => {
    const counters = [{ key: randomHex64(), maximum: 50, windowSeconds: 60 }];
    const admit = () => workspaceStub().admitResearcherAiRequest({ operation: 'interview', counters, now: T0 });
    for (const state of ['open', 'draining'] as const) {
      await setMaintenance(state);
      expect(await admit(), state).toEqual({ status: 'admitted' });
    }
    for (const state of ['frozen', 'recovery'] as const) {
      await setMaintenance(state);
      expect(await admit(), state).toEqual({ status: 'held', reason: 'maintenance' });
    }
    expect(await sql(`SELECT count FROM budget_windows`)).toEqual([{ count: 2 }]);
  });

  it('D15: researcher and participant budgets never share a row, even for the same subject text', async () => {
    const store = realStore();
    const participant = [{ key: 'rate-limit:greeting:session:600:subject', maximum: 1, windowSeconds: 600 }];
    const researcher = [{ key: 'researcher-ai:greeting:session:600:subject', maximum: 1, windowSeconds: 600 }];
    expect(await store.admitParticipantRequest({ operation: 'greeting', counters: participant, now: T0 })).toEqual({ status: 'admitted' });
    expect((await store.admitParticipantRequest({ operation: 'greeting', counters: participant, now: T0 })).status).toBe('limited');

    expect(await store.admitResearcherAiRequest({ operation: 'greeting', counters: researcher, now: T0 })).toEqual({ status: 'admitted' });
    const rows = await sql<{ scope_key: string; count: number }>(`SELECT scope_key, count FROM budget_windows ORDER BY scope_key`);
    expect(rows).toEqual([
      { scope_key: createHmac('sha256', SALT).update(participant[0].key).digest('hex'), count: 1 },
      { scope_key: createHmac('sha256', SALT).update(researcher[0].key).digest('hex'), count: 1 },
    ].sort((a, b) => a.scope_key.localeCompare(b.scope_key)));

    // The client never charges a participant key as a researcher budget, or sends it at all.
    expect(await store.admitResearcherAiRequest({ operation: 'greeting', counters: participant, now: T0 })).toEqual({ status: 'unavailable' });
    expect(await count('budget_windows')).toBe(2);
  });
});

describe('acceptAnalysisRetry researcher AI charge (D15)', () => {
  function retryInput(seeded: SeededInterview, budget: AcceptAnalysisRetryInput['budget'], overrides: Partial<AcceptAnalysisRetryInput> = {}): AcceptAnalysisRetryInput {
    return {
      studyId: seeded.studyId,
      interviewId: seeded.interviewId,
      requestKeyDigest: `digest-${crypto.randomUUID()}`,
      requestFingerprint: 'fingerprint-v2-expected-0',
      expectedGeneration: 0,
      input: frozenInput(seeded.config, 1),
      budget,
      now: Date.now(),
      ...overrides,
    };
  }

  const windowCount = async (key: string) =>
    (await sqlRows<{ count: number }>(`SELECT count FROM budget_windows WHERE scope_key = ?`, key))[0]?.count ?? 0;

  it('D15: only a newly allocated generation is charged; a receipt replay and existing active work are free', async () => {
    const seeded = await seedInterview();
    const key = randomHex64();
    const budget = [{ key, maximum: 100, windowSeconds: 3_600 }];
    const stub = workspaceStub();
    const input = retryInput(seeded, budget);

    expect(await stub.acceptAnalysisRetry(input)).toMatchObject({ status: 'accepted', body: { generation: 1 } });
    expect(await windowCount(key)).toBe(1);

    // A lost reply replayed with the same key and body.
    expect(await stub.acceptAnalysisRetry({ ...input, now: Date.now() })).toMatchObject({ status: 'accepted', body: { generation: 1 } });
    // Another key while generation 1 is still active.
    expect(await stub.acceptAnalysisRetry(retryInput(seeded, budget, { expectedGeneration: 1 })))
      .toMatchObject({ status: 'existing', body: { generation: 1 } });
    expect(await windowCount(key)).toBe(1);
  });

  it('D15: a refusal before allocation (state changed, missing interview) is never charged', async () => {
    const seeded = await seedInterview();
    const key = randomHex64();
    const budget = [{ key, maximum: 100, windowSeconds: 3_600 }];
    const stub = workspaceStub();
    expect(await stub.acceptAnalysisRetry(retryInput(seeded, budget, { expectedGeneration: 4 }))).toEqual({ status: 'state-changed' });
    expect(await stub.acceptAnalysisRetry(retryInput(seeded, budget, { interviewId: 'interview-missing' }))).toEqual({ status: 'not-found' });
    expect(await count('budget_windows')).toBe(0);
  });

  it('D15: an exhausted budget is limited and allocates nothing: no job, receipt, analysis row or sequence bump', async () => {
    const seeded = await seedInterview();
    const budget = [
      { key: randomHex64(), maximum: 100, windowSeconds: 3_600 },
      { key: randomHex64(), maximum: 0, windowSeconds: 86_400 },
    ];
    const sequence = await mutationSeq();

    expect(await workspaceStub().acceptAnalysisRetry(retryInput(seeded, budget))).toEqual({ status: 'limited', retryAfterSeconds: 86_400 });

    expect(await count('analysis_jobs', 'interview_id = ?', seeded.interviewId)).toBe(0);
    expect(await count('analysis', 'interview_id = ?', seeded.interviewId)).toBe(0);
    expect(await count('idempotency_receipts')).toBe(0);
    expect(await count('budget_windows')).toBe(0);
    expect(await mutationSeq()).toBe(sequence);
  });

  it('D15: malformed budget counters refuse the retry without allocating', async () => {
    const seeded = await seedInterview();
    const outcome = await workspaceStub().acceptAnalysisRetry(
      retryInput(seeded, [{ key: 'researcher-ai:analysis:researcher:86400:workspace', maximum: 1, windowSeconds: 1 }]),
    );
    expect(outcome).toEqual({ status: 'unavailable' });
    expect(await count('analysis_jobs')).toBe(0);
  });

  it('D15: the durable client charges the salted analysis counters through the retry', async () => {
    const seeded = await seedJob();
    await sql(`UPDATE analysis_jobs SET state = 'failed', failure_kind = 'provider', next_due_at = NULL WHERE job_id = ?`, seeded.jobId);
    await sql(`UPDATE analysis SET status = 'failed', failure_kind = 'provider' WHERE interview_id = ?`, seeded.interviewId);
    const rawKey = 'researcher-ai:analysis:researcher:86400:workspace';

    const outcome = await realStore().acceptAnalysisRetry({
      studyId: seeded.studyId,
      interviewId: seeded.interviewId,
      rawIdempotencyKey: crypto.randomUUID(),
      apiVersion: 2,
      expectedGeneration: 1,
      input: frozenInput(seeded.config, 1),
      budget: [{ key: rawKey, maximum: 500, windowSeconds: 86_400 }],
      now: Date.now(),
    });

    expect(outcome).toMatchObject({ status: 'accepted', body: { generation: 2 } });
    expect(await sql(`SELECT scope_key, count FROM budget_windows`))
      .toEqual([{ scope_key: createHmac('sha256', SALT).update(rawKey).digest('hex'), count: 1 }]);
  });
});
