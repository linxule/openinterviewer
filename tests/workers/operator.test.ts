// Maintenance modes, operator status, in-flight classification,
// recovery-epoch activation and the point-in-time restore entry point in the
// real WorkspaceStore (OPS-01, OPS-03, JOB-10).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { gate, type OperationClass, type WorkspaceContext, type WorkspaceEnv } from '../../cloudflare/workspace/context';
import type { RestoreBookmarkInput, RestoreBookmarkOutcome } from '../../cloudflare/workspace/rpcTypes';
import type { MaintenanceState } from '../../src/lib/storage/types';
import { testEnv, workspaceStub } from './helpers';

const NOW = Date.now();
const OLD_EPOCH = `ep_${'0'.repeat(31)}f`;
const CONTENT_MARKER = 'synthetic-participant-speech-c41d';
const STATES: MaintenanceState[] = ['open', 'draining', 'frozen', 'recovery'];

type Sql = SqlStorage;

async function withSql<T>(run: (sql: Sql) => T): Promise<T> {
  return runInDurableObject(workspaceStub(), (_instance, state) => run(state.storage.sql));
}

function jobId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function insertStudy(sql: Sql, id: string): void {
  sql.exec(
    `INSERT INTO studies (id, config_json, revision, created_at, updated_at, interview_count, is_locked, sample_fixture)
     VALUES (?, ?, 1, ?, ?, 0, 0, 0)`,
    id, JSON.stringify({ id, name: 'Synthetic', aiProvider: 'openai', aiModel: 'gpt-fixture' }), NOW, NOW,
  );
}

type JobState = 'pending' | 'claimed' | 'started' | 'complete' | 'recovery-required';

/** One interview with its analysis row and one job for generation 1. */
function seedJob(sql: Sql, n: number, state: JobState, options: { epoch?: string; allocatedAt?: number; nextDueAt?: number | null } = {}): string {
  const interviewId = `iv-${n}`;
  const id = jobId(n);
  const epoch = options.epoch ?? testEnv.ANALYSIS_RECOVERY_EPOCH;
  const record = {
    id: interviewId, studyId: 'study-ops', studyName: 'Synthetic', participantProfile: { id: 'p', fields: [], rawContext: '', timestamp: NOW },
    transcript: [{ id: 'm', role: 'user', content: CONTENT_MARKER, timestamp: NOW }], synthesis: null,
    behaviorData: { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] },
    createdAt: NOW + n, completedAt: NOW + n, status: 'completed', studyRevision: 1,
  };
  sql.exec(
    `INSERT INTO interviews (id, study_id, record_json, fingerprint, created_at, completed_at, sample_fixture, study_revision)
     VALUES (?, 'study-ops', ?, ?, ?, ?, 0, 1)`,
    interviewId, JSON.stringify(record), 'f'.repeat(64), NOW + n, NOW + n,
  );
  const projection = state === 'pending' ? 'pending' : state === 'complete' ? 'complete' : state === 'recovery-required' ? 'failed' : 'running';
  sql.exec(
    `INSERT INTO analysis (interview_id, status, current_generation, attempts, last_attempt_at, failure_kind, recovery_required,
       study_revision, synthesis_json, provenance_json, updated_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
    interviewId, projection, state === 'pending' ? 0 : 1, NOW,
    projection === 'failed' ? 'timeout' : null, projection === 'failed' ? 1 : 0,
    projection === 'complete' ? 1 : null,
    projection === 'complete' ? '{"statedPreferences":[],"revealedPreferences":[],"themes":[],"contradictions":[],"keyInsights":[],"bottomLine":"x"}' : null,
    projection === 'complete' ? '{"aiProvider":"openai","aiModel":"gpt-fixture","requestedAiModel":"gpt-fixture"}' : null,
    NOW,
  );
  const frozen = { inputSchemaVersion: 1, studyConfig: { id: 'study-ops' }, studyRevision: 1, requestedProvider: 'openai', requestedModel: 'gpt-fixture' };
  const active = state === 'claimed' || state === 'started';
  const terminal = state === 'complete' || state === 'recovery-required';
  sql.exec(
    `INSERT INTO analysis_jobs (job_id, interview_id, generation, recovery_epoch, state, input_json, requested_provider, requested_model,
       allocated_at, updated_at, dispatch_state, dispatch_attempts, next_due_at, claim_nonce, claimed_at, claim_expires_at, started_at, terminal_at, failure_kind)
     VALUES (?, ?, 1, ?, ?, ?, 'openai', 'gpt-fixture', ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
    id, interviewId, epoch, state, JSON.stringify(frozen), options.allocatedAt ?? NOW, NOW,
    terminal ? 'none' : 'sent',
    options.nextDueAt === undefined ? (terminal ? null : NOW + 3_600_000) : options.nextDueAt,
    active ? `nonce-${n}-abcdefghijklmnop` : null, active ? NOW : null, active ? NOW + 180_000 : null,
    state === 'started' ? NOW : null, terminal ? NOW : null, state === 'recovery-required' ? 'timeout' : null,
  );
  return id;
}

function envelope(n: number, epoch: string) {
  return { workspaceId: testEnv.WORKSPACE_ID, interviewId: `iv-${n}`, jobId: jobId(n), generation: 1, recoveryEpoch: epoch };
}

async function reset(): Promise<void> {
  await runInDurableObject(workspaceStub(), async (_instance, state) => {
    const sql = state.storage.sql;
    for (const table of ['analysis_jobs', 'analysis', 'interviews', 'aggregates', 'participant_links', 'consents', 'budget_windows', 'studies', 'operator_audit']) {
      sql.exec(`DELETE FROM ${table}`);
    }
    sql.exec(`UPDATE workspace_meta SET maintenance_state = 'open', maintenance_version = 0, activated_epoch = ?`, testEnv.ANALYSIS_RECOVERY_EPOCH);
    insertStudy(sql, 'study-ops');
    await state.storage.deleteAlarm();
  });
}

async function meta(): Promise<{ maintenance_state: string; maintenance_version: number; activated_epoch: string; mutation_seq: number }> {
  return withSql((sql) => sql
    .exec<{ maintenance_state: string; maintenance_version: number; activated_epoch: string; mutation_seq: number }>(
      `SELECT maintenance_state, maintenance_version, activated_epoch, mutation_seq FROM workspace_meta`,
    )
    .one());
}

async function job(id: string) {
  return withSql((sql) => sql
    .exec<{ state: string; claim_nonce: string | null; next_due_at: number | null; dispatch_attempts: number; dispatch_state: string; failure_kind: string | null }>(
      `SELECT state, claim_nonce, next_due_at, dispatch_attempts, dispatch_state, failure_kind FROM analysis_jobs WHERE job_id = ?`,
      id,
    )
    .one());
}

async function analysis(interviewId: string) {
  return withSql((sql) => sql
    .exec<{ status: string; failure_kind: string | null; recovery_required: number }>(
      `SELECT status, failure_kind, recovery_required FROM analysis WHERE interview_id = ?`,
      interviewId,
    )
    .one());
}

async function auditRows(): Promise<Array<{ action: string; detail: Record<string, unknown> }>> {
  return withSql((sql) => sql
    .exec<{ action: string; detail_json: string }>(`SELECT action, detail_json FROM operator_audit ORDER BY seq`)
    .toArray()
    .map((row) => ({ action: row.action, detail: JSON.parse(row.detail_json) as Record<string, unknown> })));
}

async function transition(from: MaintenanceState, to: MaintenanceState, classifyInFlight?: boolean) {
  const current = await meta();
  return workspaceStub().transitionMaintenance({
    expectedState: from,
    expectedVersion: current.maintenance_version,
    nextState: to,
    classifyInFlight,
    now: Date.now(),
  });
}

let queueSends: unknown[];
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await reset();
  queueSends = [];
  vi.spyOn(testEnv.ANALYSIS_QUEUE, 'send').mockImplementation(async (body: unknown) => {
    queueSends.push(body);
    return { metadata: {} } as QueueSendResponse;
  });
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('network is not available to operator tests');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('operator status (OPS-01)', () => {
  it('OPS-01: reports table counts, job states, oldest active age, alarm and epoch without research content', async () => {
    await withSql((sql) => {
      seedJob(sql, 1, 'pending', { allocatedAt: NOW - 60_000 });
      seedJob(sql, 2, 'claimed');
      seedJob(sql, 3, 'started');
      seedJob(sql, 4, 'recovery-required');
      seedJob(sql, 5, 'complete');
    });
    const alarm = NOW + 7_200_000;
    await runInDurableObject(workspaceStub(), (_instance, state) => state.storage.setAlarm(alarm));
    const status = await workspaceStub().operatorStatus();
    expect(status).toMatchObject({
      status: 'ok',
      workspaceId: testEnv.WORKSPACE_ID,
      schemaVersion: 1,
      maintenance: { state: 'open', version: 0 },
      epoch: { activated: testEnv.ANALYSIS_RECOVERY_EPOCH, configuredMatches: true },
      jobs: { pending: 1, claimed: 1, started: 1, recoveryRequired: 1 },
      alarm: { scheduledAt: alarm },
    });
    if (status.status !== 'ok') return;
    expect(status.counts).toMatchObject({ studies: 1, interviews: 5, analysis: 5, analysis_jobs: 5, workspace_meta: 1 });
    expect(status.jobs.oldestActiveAgeMs).toBeGreaterThanOrEqual(60_000);
    expect(JSON.stringify(status)).not.toContain(CONTENT_MARKER);
  });
});

describe('maintenance transitions (OPS-01)', () => {
  it('OPS-01: compare-and-set transitions follow the allowed graph, resolve lost replies and audit without content', async () => {
    const stub = workspaceStub();
    const now = Date.now();
    expect(await stub.transitionMaintenance({ expectedState: 'open', expectedVersion: 0, nextState: 'frozen', now })).toEqual({ status: 'invalid-transition' });
    expect(await stub.transitionMaintenance({ expectedState: 'open', expectedVersion: 0, nextState: 'open', now })).toEqual({ status: 'invalid-transition' });
    expect(await stub.transitionMaintenance({ expectedState: 'open', expectedVersion: 0, nextState: 'draining', now })).toEqual({ status: 'transitioned', state: 'draining', version: 1 });
    // The same request again (lost reply): reported as already applied.
    expect(await stub.transitionMaintenance({ expectedState: 'open', expectedVersion: 0, nextState: 'draining', now })).toEqual({ status: 'already', state: 'draining', version: 1 });
    // A stale view never undoes a newer decision.
    expect(await stub.transitionMaintenance({ expectedState: 'open', expectedVersion: 0, nextState: 'recovery', now })).toEqual({ status: 'conflict', state: 'draining', version: 1 });
    expect(await stub.transitionMaintenance({ expectedState: 'draining', expectedVersion: 1, nextState: 'open', now })).toEqual({ status: 'transitioned', state: 'open', version: 2 });
    expect(await stub.transitionMaintenance({ expectedState: 'open', expectedVersion: 0, nextState: 'draining', now })).toEqual({ status: 'conflict', state: 'open', version: 2 });
    expect(await stub.transitionMaintenance({ expectedState: 'open', expectedVersion: 2, nextState: 'draining', now })).toMatchObject({ status: 'transitioned', version: 3 });
    expect(await stub.transitionMaintenance({ expectedState: 'draining', expectedVersion: 3, nextState: 'frozen', now })).toMatchObject({ status: 'transitioned', version: 4 });
    expect(await stub.transitionMaintenance({ expectedState: 'frozen', expectedVersion: 4, nextState: 'recovery', now })).toMatchObject({ status: 'transitioned', version: 5 });
    expect(await stub.transitionMaintenance({ expectedState: 'recovery', expectedVersion: 5, nextState: 'draining', now })).toEqual({ status: 'invalid-transition' });
    expect(await stub.transitionMaintenance({ expectedState: 'recovery', expectedVersion: 5, nextState: 'frozen', now })).toMatchObject({ status: 'transitioned', version: 6 });
    expect(await stub.transitionMaintenance({ expectedState: 'frozen', expectedVersion: 6, nextState: 'draining', now })).toMatchObject({ status: 'transitioned', version: 7 });

    const rows = await auditRows();
    expect(rows.map((row) => [row.detail.from, row.detail.to, row.detail.version])).toEqual([
      ['open', 'draining', 1], ['draining', 'open', 2], ['open', 'draining', 3], ['draining', 'frozen', 4],
      ['frozen', 'recovery', 5], ['recovery', 'frozen', 6], ['frozen', 'draining', 7],
    ]);
    for (const row of rows) {
      expect(row.action).toBe('maintenance.transition');
      expect(Object.keys(row.detail).sort()).toEqual(['classifiedClaimed', 'classifiedStarted', 'from', 'to', 'version']);
    }
  });

  it('OPS-01: maintenance matrix — draining refuses entry and researcher mutations but keeps consent, admission and settlement; frozen and recovery refuse writes; reads stay open', async () => {
    const env = testEnv as unknown as WorkspaceEnv;
    const classes: OperationClass[] = ['read', 'participant-entry', 'participant-session', 'researcher-mutation', 'researcher-ai', 'job-settlement'];
    const expected: Record<MaintenanceState, OperationClass[]> = {
      open: classes,
      draining: ['read', 'participant-session', 'researcher-ai', 'job-settlement'],
      frozen: ['read'],
      recovery: ['read'],
    };
    for (const state of STATES) {
      const allowed = await runInDurableObject(workspaceStub(), (_instance, durable) => {
        durable.storage.sql.exec(`UPDATE workspace_meta SET maintenance_state = ?`, state);
        const ws: WorkspaceContext = { sql: durable.storage.sql, storage: durable.storage, env, objectName: testEnv.WORKSPACE_ID };
        return classes.filter((operation) => gate(ws, operation).ok);
      });
      expect(allowed, state).toEqual(expected[state]);
    }

    // The same matrix through real RPCs (seeded via SQL).
    await withSql((sql) => seedJob(sql, 10, 'pending'));
    const stub = workspaceStub();
    const linkId = 'a'.repeat(64);
    const counter = { key: 'b'.repeat(64), maximum: 100, windowSeconds: 60 };
    for (const state of STATES) {
      await withSql((sql) => sql.exec(`UPDATE workspace_meta SET maintenance_state = ?`, state));
      const now = Date.now();
      const exchange = await stub.getParticipantLink({ linkId, now, purpose: 'exchange' });
      const session = await stub.getParticipantLink({ linkId, now, purpose: 'session' });
      const mutation = await stub.setStudyLinksEnabled({ studyId: 'study-ops', enabled: false, now });
      const admission = await stub.admitParticipantRequest({ operation: 'greeting', counters: [counter], now });
      const revision = await withSql((sql) => sql.exec<{ revision: number }>(`SELECT revision FROM studies WHERE id = 'study-ops'`).one().revision);
      const consent = await stub.recordConsent({
        participantSessionId: `session-${state}-0123456789`, studyId: 'study-ops', studyRevision: revision, consentHash: 'c'.repeat(64), now,
      });
      const studies = await stub.listStudies({ maximum: 10 });
      const exported = await stub.beginExport({ maximum: 500 });
      const held = { status: 'held', reason: 'maintenance' };
      if (state === 'open') {
        expect(exchange).toEqual({ status: 'not-found' });
        expect(mutation).not.toMatchObject({ status: 'held' });
      } else {
        expect(exchange, state).toEqual(held);
        expect(mutation, state).toEqual(held);
      }
      if (state === 'open' || state === 'draining') {
        expect(session, state).toEqual({ status: 'not-found' });
        expect(admission, state).toEqual({ status: 'admitted' });
        expect(consent, state).toMatchObject({ status: 'accepted' });
      } else {
        expect(session, state).toEqual(held);
        expect(admission, state).toEqual(held);
        expect(consent, state).toEqual(held);
      }
      expect(studies, state).toMatchObject({ status: 'ok' });
      expect(exported, state).toMatchObject({ status: 'ok', count: 1 });
    }

    // Settlement: a draining workspace still lets an accepted job be claimed; frozen does not.
    await withSql((sql) => sql.exec(`UPDATE workspace_meta SET maintenance_state = 'frozen'`));
    const fence = { ...envelope(10, testEnv.ANALYSIS_RECOVERY_EPOCH), claimNonce: 'claim-nonce-0123456789', now: Date.now() };
    expect(await stub.claimAnalysisJob(fence)).toEqual({ status: 'held' });
    await withSql((sql) => sql.exec(`UPDATE workspace_meta SET maintenance_state = 'draining'`));
    expect(await stub.claimAnalysisJob(fence)).toMatchObject({ status: 'claimed', replayed: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('OPS-01: freezing with in-flight attempts requires explicit classification (claimed → pending, started → recovery-required)', async () => {
    const claimed = await withSql((sql) => seedJob(sql, 20, 'claimed'));
    const started = await withSql((sql) => seedJob(sql, 21, 'started'));
    const pending = await withSql((sql) => seedJob(sql, 22, 'pending'));
    expect(await transition('open', 'draining')).toMatchObject({ status: 'transitioned' });
    const before = await meta();
    expect(await transition('draining', 'frozen')).toEqual({ status: 'in-flight', claimed: 1, started: 1 });
    expect((await meta()).maintenance_state).toBe('draining');
    expect((await job(claimed)).state).toBe('claimed');

    expect(await transition('draining', 'frozen', true)).toEqual({ status: 'transitioned', state: 'frozen', version: before.maintenance_version + 1 });
    expect(await job(claimed)).toMatchObject({ state: 'pending', claim_nonce: null, dispatch_state: 'unsent', dispatch_attempts: 1 });
    expect(await analysis('iv-20')).toMatchObject({ status: 'pending' });
    expect(await job(started)).toMatchObject({ state: 'recovery-required', claim_nonce: null, next_due_at: null, failure_kind: 'timeout' });
    expect(await analysis('iv-21')).toEqual({ status: 'failed', failure_kind: 'timeout', recovery_required: 1 });
    expect((await job(pending)).state).toBe('pending');
    expect((await meta()).mutation_seq).toBeGreaterThan(before.mutation_seq);
    const last = (await auditRows()).at(-1)!;
    expect(last.detail).toEqual({ from: 'draining', to: 'frozen', version: before.maintenance_version + 1, classifiedClaimed: 1, classifiedStarted: 1 });

    // The classified claim cannot start: its holder presents a cleared nonce.
    await withSql((sql) => sql.exec(`UPDATE workspace_meta SET maintenance_state = 'draining'`));
    expect(await workspaceStub().markAnalysisStarted({
      ...envelope(20, testEnv.ANALYSIS_RECOVERY_EPOCH), claimNonce: 'nonce-20-abcdefghijklmnop', requiredRemainingMs: 1_000, now: Date.now(),
    })).toEqual({ status: 'stale' });
    expect(queueSends).toEqual([]);
  });

  it('OPS-01/JOB-05: leaving frozen re-arms the alarm by the object clock, in the transition, whatever the caller clock says', async () => {
    // An overdue job and a caller clock a week ahead (F14: caller time is advisory).
    const callerNow = Date.now() + 7 * 24 * 3_600_000;
    await withSql((sql) => {
      const overdue = seedJob(sql, 30, 'pending', { nextDueAt: Date.now() - 1_000 });
      sql.exec(`UPDATE analysis_jobs SET dispatch_state = 'unsent', dispatch_attempts = 0 WHERE job_id = ?`, overdue);
      seedJob(sql, 31, 'complete');
      sql.exec(`UPDATE workspace_meta SET maintenance_state = 'frozen', maintenance_version = 9`);
    });
    expect(await runInDurableObject(workspaceStub(), (_instance, state) => state.storage.getAlarm())).toBeNull();
    expect(await workspaceStub().transitionMaintenance({ expectedState: 'frozen', expectedVersion: 9, nextState: 'open', now: callerNow }))
      .toEqual({ status: 'transitioned', state: 'open', version: 10 });
    const armed = await runInDurableObject(workspaceStub(), (_instance, state) => state.storage.getAlarm());
    // Armed at the object's now, never the caller's week-ahead time. Under load
    // the real alarm may already have fired, dispatched and re-armed a later
    // watchdog; that is minutes ahead, not a week.
    expect(armed === null || armed < callerNow - 24 * 3_600_000).toBe(true);
    if (queueSends.length === 0 && armed !== null && armed <= Date.now()) await runDurableObjectAlarm(workspaceStub());
    await vi.waitFor(() => expect(queueSends).toHaveLength(1));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('OPS-01/JOB-05: entering a held state leaves the alarm alone; classification uses the object clock for due times', async () => {
    const callerNow = Date.now() + 7 * 24 * 3_600_000;
    const claimed = await withSql((sql) => seedJob(sql, 32, 'claimed'));
    const alarm = Date.now() + 3_600_000;
    await runInDurableObject(workspaceStub(), (_instance, state) => state.storage.setAlarm(alarm));
    expect(await transition('open', 'draining')).toMatchObject({ status: 'transitioned' });
    const version = (await meta()).maintenance_version;
    const before = Date.now();
    expect(await workspaceStub().transitionMaintenance({ expectedState: 'draining', expectedVersion: version, nextState: 'frozen', classifyInFlight: true, now: callerNow }))
      .toMatchObject({ status: 'transitioned', state: 'frozen' });
    expect((await job(claimed)).next_due_at!).toBeLessThanOrEqual(Date.now());
    expect((await job(claimed)).next_due_at!).toBeGreaterThanOrEqual(before);
    await workspaceStub().transitionMaintenance({ expectedState: 'frozen', expectedVersion: version + 1, nextState: 'recovery', now: callerNow });
    expect(await runInDurableObject(workspaceStub(), (_instance, state) => state.storage.getAlarm())).toBe(alarm);
    expect(queueSends).toEqual([]);
  });
});

describe('recovery-epoch activation (JOB-10, OPS-03)', () => {
  async function restoredWorkspace(): Promise<void> {
    // A restored database: an old stored epoch and an old open state, with
    // nonterminal generations whose start markers may have been rewound.
    await withSql((sql) => {
      seedJob(sql, 40, 'pending', { epoch: OLD_EPOCH, nextDueAt: NOW - 1_000 });
      seedJob(sql, 41, 'claimed', { epoch: OLD_EPOCH });
      seedJob(sql, 42, 'started', { epoch: OLD_EPOCH });
      seedJob(sql, 43, 'complete', { epoch: OLD_EPOCH });
      sql.exec(`UPDATE workspace_meta SET activated_epoch = ?, maintenance_state = 'open', maintenance_version = 3`, OLD_EPOCH);
    });
  }

  it('JOB-10: a restored alarm and open state stay inert under the epoch mismatch', async () => {
    await restoredWorkspace();
    const pending = jobId(40);
    const before = await job(pending);
    await runInDurableObject(workspaceStub(), (_instance, state) => state.storage.setAlarm(Date.now() + 3_600_000));
    expect(await runDurableObjectAlarm(workspaceStub())).toBe(true);
    expect(await job(pending)).toEqual(before);
    expect(queueSends).toEqual([]);
    expect(await runInDurableObject(workspaceStub(), (_instance, state) => state.storage.getAlarm())).toBeNull();
    // Writes and settlement refuse; the operator can still read.
    expect(await workspaceStub().claimAnalysisJob({ ...envelope(40, OLD_EPOCH), claimNonce: 'claim-nonce-0123456789', now: Date.now() }))
      .toEqual({ status: 'stale' });
    expect(await workspaceStub().setStudyLinksEnabled({ studyId: 'study-ops', enabled: false, now: Date.now() }))
      .toEqual({ status: 'held', reason: 'recovery-epoch-mismatch' });
    expect(await workspaceStub().operatorStatus()).toMatchObject({ status: 'ok', epoch: { activated: OLD_EPOCH, configuredMatches: false } });
    // Only recovery is reachable until activation.
    expect(await transition('open', 'draining')).toEqual({ status: 'held', reason: 'recovery-epoch-mismatch' });
    expect(await transition('open', 'recovery')).toMatchObject({ status: 'transitioned', state: 'recovery' });
    expect(await transition('recovery', 'open')).toEqual({ status: 'held', reason: 'recovery-epoch-mismatch' });
  });

  it('JOB-10/OPS-03: activation reconciles every nonterminal generation to recovery-required, then old envelopes, claims and results are rejected', async () => {
    await restoredWorkspace();
    const stub = workspaceStub();
    const now = Date.now();
    expect(await stub.activateRecoveryEpoch({ expectedActivatedEpoch: OLD_EPOCH, now })).toEqual({ status: 'not-recovery' });
    expect(await transition('open', 'recovery')).toMatchObject({ status: 'transitioned' });
    const before = await meta();
    expect(await stub.activateRecoveryEpoch({ expectedActivatedEpoch: testEnv.ANALYSIS_RECOVERY_EPOCH, now })).toEqual({ status: 'conflict' });
    expect(await stub.activateRecoveryEpoch({ expectedActivatedEpoch: OLD_EPOCH, now })).toEqual({ status: 'activated', reconciledJobs: 3 });
    expect(await stub.activateRecoveryEpoch({ expectedActivatedEpoch: OLD_EPOCH, now })).toEqual({ status: 'already-active' });

    const after = await meta();
    expect(after).toMatchObject({ activated_epoch: testEnv.ANALYSIS_RECOVERY_EPOCH, maintenance_state: 'recovery', maintenance_version: before.maintenance_version });
    expect(after.mutation_seq).toBeGreaterThan(before.mutation_seq);
    for (const n of [40, 41, 42]) {
      expect(await job(jobId(n))).toMatchObject({ state: 'recovery-required', claim_nonce: null, next_due_at: null, failure_kind: 'timeout', dispatch_state: 'none' });
      expect(await analysis(`iv-${n}`)).toEqual({ status: 'failed', failure_kind: 'timeout', recovery_required: 1 });
    }
    expect((await job(jobId(43))).state).toBe('complete');
    expect(await stub.readAnalysisStatus({ studyId: 'study-ops', interviewId: 'iv-40' }))
      .toEqual({ status: 'ok', body: { status: 'failed', generation: 1, failureKind: 'timeout', recoveryRequired: true } });
    expect((await auditRows()).at(-1)).toEqual({
      action: 'epoch.activate',
      detail: { from: OLD_EPOCH, to: testEnv.ANALYSIS_RECOVERY_EPOCH, reconciledJobs: 3 },
    });

    // Leaving recovery is now allowed and dispatches nothing: no generation is executable.
    expect(await transition('recovery', 'open')).toMatchObject({ status: 'transitioned', state: 'open' });
    await runDurableObjectAlarm(stub);
    expect(queueSends).toEqual([]);

    const t = Date.now();
    for (const epoch of [OLD_EPOCH, testEnv.ANALYSIS_RECOVERY_EPOCH]) {
      expect(await stub.claimAnalysisJob({ ...envelope(40, epoch), claimNonce: 'claim-nonce-0123456789', now: t })).not.toMatchObject({ status: 'claimed' });
    }
    expect(await stub.markAnalysisStarted({ ...envelope(42, OLD_EPOCH), claimNonce: 'nonce-42-abcdefghijklmnop', requiredRemainingMs: 1_000, now: t }))
      .toEqual({ status: 'stale' });
    expect(await stub.finishAnalysisJob({ ...envelope(41, OLD_EPOCH), claimNonce: 'nonce-41-abcdefghijklmnop', now: t, outcome: { kind: 'uncertain' } }))
      .toEqual({ status: 'stale' });
    expect(await job(jobId(41))).toMatchObject({ state: 'recovery-required' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('JOB-10: activation never re-adopts an epoch this object already superseded, and always advances the watermark', async () => {
    const stub = workspaceStub();
    const configured = testEnv.ANALYSIS_RECOVERY_EPOCH;
    // A restored workspace with no nonterminal jobs: activation still moves the backup watermark.
    await withSql((sql) => sql.exec(`UPDATE workspace_meta SET activated_epoch = ?, maintenance_state = 'recovery'`, OLD_EPOCH));
    const before = await meta();
    expect(await stub.activateRecoveryEpoch({ expectedActivatedEpoch: OLD_EPOCH, now: Date.now() })).toEqual({ status: 'activated', reconciledJobs: 0 });
    expect((await meta()).mutation_seq).toBeGreaterThan(before.mutation_seq);

    // Configuration rolled back to the superseded epoch: the object refuses it.
    const outcome = await runInDurableObject(workspaceStub(), async (instance) => {
      const env = (instance as unknown as { env: WorkspaceEnv }).env;
      env.ANALYSIS_RECOVERY_EPOCH = OLD_EPOCH;
      try {
        return await (instance as unknown as { activateRecoveryEpoch: (input: unknown) => Promise<unknown> })
          .activateRecoveryEpoch({ expectedActivatedEpoch: configured, now: Date.now() });
      } finally {
        env.ANALYSIS_RECOVERY_EPOCH = configured;
      }
    });
    expect(outcome).toEqual({ status: 'conflict' });
    expect((await meta()).activated_epoch).toBe(configured);
    expect((await auditRows()).filter((row) => row.action === 'epoch.activate').map((row) => [row.detail.from, row.detail.to]))
      .toEqual([[OLD_EPOCH, configured]]);
  });

  it('JOB-10: activation refuses an unset configured epoch and never adopts one from the request', async () => {
    await restoredWorkspace();
    expect(await transition('open', 'recovery')).toMatchObject({ status: 'transitioned' });
    const outcome = await runInDurableObject(workspaceStub(), async (instance) => {
      const env = (instance as unknown as { env: WorkspaceEnv }).env;
      const configured = env.ANALYSIS_RECOVERY_EPOCH;
      env.ANALYSIS_RECOVERY_EPOCH = 'not-an-epoch';
      try {
        return await (instance as unknown as { activateRecoveryEpoch: (input: unknown) => Promise<unknown> })
          .activateRecoveryEpoch({ expectedActivatedEpoch: OLD_EPOCH, now: Date.now() });
      } finally {
        env.ANALYSIS_RECOVERY_EPOCH = configured;
      }
    });
    expect(outcome).toEqual({ status: 'held', reason: 'recovery-epoch-mismatch' });
    expect((await meta()).activated_epoch).toBe(OLD_EPOCH);
  });
});

describe('point-in-time restore entry point (OPS-03)', () => {
  // workerd has no point-in-time recovery (its storage refuses both calls, see
  // the last test), so these tests call the real RPC method on the live
  // instance with the two storage methods and ctx.abort stubbed. Real: the
  // gating, SQLite state, reply and restart ordering. Not exercised locally:
  // the platform resolving a time, restoring storage and reopening the object.
  const BOOKMARK = '0000007b-0000b26e-00001538-0c3e87bb37b3db5cc52eedb93cd3b96b';
  const UNDO = '0000007c-0000b26f-00001539-1c3e87bb37b3db5cc52eedb93cd3b96c';
  const DAY_MS = 24 * 3_600_000;

  /** OPS-03 steps 1-3 done: frozen, and the deployment binds a new epoch the object has not activated. */
  async function rotatedAndFrozen(state: MaintenanceState = 'frozen', version = 5): Promise<void> {
    await withSql((sql) => {
      sql.exec(`UPDATE workspace_meta SET maintenance_state = ?, maintenance_version = ?, activated_epoch = ?`, state, version, OLD_EPOCH);
    });
  }

  function request(overrides: Partial<RestoreBookmarkInput> = {}): RestoreBookmarkInput {
    return { expectedState: 'frozen', expectedVersion: 5, bookmark: BOOKMARK, at: null, now: Date.now(), ...overrides };
  }

  type Stubbed = { outcome: RestoreBookmarkOutcome; events: string[]; abortReasons: unknown[] };

  async function restoreWithStubbedStorage(input: RestoreBookmarkInput, env: Partial<WorkspaceEnv> = {}): Promise<Stubbed> {
    return runInDurableObject(workspaceStub(), async (instance, state) => {
      const events: string[] = [];
      const lookup = vi.spyOn(state.storage, 'getBookmarkForTime').mockImplementation(async (time) => {
        events.push(`lookup:${Number(time)}`);
        return BOOKMARK;
      });
      const schedule = vi.spyOn(state.storage, 'onNextSessionRestoreBookmark').mockImplementation(async (bookmark) => {
        events.push(`schedule:${bookmark}`);
        return UNDO;
      });
      const abort = vi.spyOn(state, 'abort').mockImplementation(() => {
        events.push('abort');
      });
      const instanceEnv = (instance as unknown as { env: WorkspaceEnv }).env;
      const saved = Object.fromEntries(Object.keys(env).map((name) => [name, instanceEnv[name]]));
      Object.assign(instanceEnv, env);
      try {
        const outcome = await (instance as unknown as { restoreToBookmark(input: RestoreBookmarkInput): Promise<RestoreBookmarkOutcome> })
          .restoreToBookmark(input);
        events.push(`reply:${outcome.status}`);
        if (outcome.status === 'scheduled') await vi.waitFor(() => expect(abort).toHaveBeenCalled());
        else await new Promise((resolve) => setTimeout(resolve, 20));
        return { outcome, events, abortReasons: abort.mock.calls.map((call) => call[0]) };
      } finally {
        Object.assign(instanceEnv, saved);
        lookup.mockRestore();
        schedule.mockRestore();
        abort.mockRestore();
      }
    });
  }

  it('OPS-03: refuses before any point-in-time storage call unless held at the expected version with the epoch already rotated', async () => {
    const configured = testEnv.ANALYSIS_RECOVERY_EPOCH;
    const cases: Array<[string, () => Promise<void>, RestoreBookmarkInput, Partial<WorkspaceEnv>, RestoreBookmarkOutcome]> = [
      ['an open workspace', () => withSql((sql) => {
        sql.exec(`UPDATE workspace_meta SET activated_epoch = ?, maintenance_version = 5`, OLD_EPOCH);
      }),
        request({ expectedState: 'open' }), {}, { status: 'not-held', state: 'open', version: 5 }],
      ['a draining workspace', () => rotatedAndFrozen('draining'),
        request({ expectedState: 'draining' }), {}, { status: 'not-held', state: 'draining', version: 5 }],
      ['a stale version', () => rotatedAndFrozen('frozen', 6), request(), {}, { status: 'conflict', state: 'frozen', version: 6 }],
      ['a stale state', () => rotatedAndFrozen('recovery', 5), request(), {}, { status: 'conflict', state: 'recovery', version: 5 }],
      ['an epoch that was never rotated', () => withSql((sql) => {
        sql.exec(`UPDATE workspace_meta SET maintenance_state = 'frozen', maintenance_version = 5`);
      }),
        request(), {}, { status: 'epoch-not-rotated' }],
      ['an unset configured epoch', () => rotatedAndFrozen(), request(), { ANALYSIS_RECOVERY_EPOCH: 'not-an-epoch' }, { status: 'epoch-not-rotated' }],
      ['a configured epoch this object already replaced', async () => {
        await rotatedAndFrozen();
        await withSql((sql) => sql.exec(
          `INSERT INTO operator_audit (at, action, detail_json) VALUES (?, 'epoch.activate', ?)`,
          NOW, JSON.stringify({ from: configured, to: OLD_EPOCH, reconciledJobs: 0 }),
        ));
      }, request(), {}, { status: 'epoch-not-rotated' }],
      ['another workspace identity', () => rotatedAndFrozen(), request(), { WORKSPACE_ID: `ws_${'9'.repeat(32)}` },
        { status: 'held', reason: 'workspace-identity-mismatch' }],
      ['both a bookmark and a time', () => rotatedAndFrozen(), request({ at: Date.now() - 60_000 }), {}, { status: 'invalid-request' }],
      ['neither a bookmark nor a time', () => rotatedAndFrozen(), request({ bookmark: null }), {}, { status: 'invalid-request' }],
      ['a malformed bookmark', () => rotatedAndFrozen(), request({ bookmark: 'not a bookmark; drop' }), {}, { status: 'invalid-request' }],
      ['a time ahead of the object clock', () => rotatedAndFrozen(), request({ bookmark: null, at: Date.now() + 60_000 }), {}, { status: 'invalid-request' }],
      ['a time beyond the 30-day window', () => rotatedAndFrozen(), request({ bookmark: null, at: Date.now() - 31 * DAY_MS }), {}, { status: 'invalid-request' }],
      ['an unknown expected state', () => rotatedAndFrozen(), request({ expectedState: 'paused' as MaintenanceState }), {}, { status: 'invalid-request' }],
      ['a negative expected version', () => rotatedAndFrozen(), request({ expectedVersion: -1 }), {}, { status: 'invalid-request' }],
    ];
    for (const [label, arrange, input, env, expected] of cases) {
      await reset();
      await arrange();
      const before = await meta();
      const audit = await auditRows();
      const result = await restoreWithStubbedStorage(input, env);
      expect(result.outcome, label).toEqual(expected);
      expect(result.events, label).toEqual([`reply:${expected.status}`]);
      expect(await meta(), label).toEqual(before);
      expect(await auditRows(), label).toEqual(audit);
    }
  });

  it('OPS-03: a time resolves to a bookmark, the restore is scheduled for the next session, the reply goes out, then the object restarts', async () => {
    await rotatedAndFrozen();
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    const before = await meta();
    const at = Date.now() - 2 * DAY_MS;
    const result = await restoreWithStubbedStorage(request({ bookmark: null, at }));
    expect(result.outcome).toEqual({ status: 'scheduled', bookmark: BOOKMARK, undoBookmark: UNDO });
    expect(result.events).toEqual([`lookup:${at}`, `schedule:${BOOKMARK}`, 'reply:scheduled', 'abort']);
    expect(result.abortReasons).toEqual(['point-in-time restore scheduled']);
    // Nothing is written: the restore would rewind it.
    expect(await meta()).toEqual(before);
    expect(await auditRows()).toEqual([]);
    const events = logged.map((line) => JSON.parse(line) as Record<string, unknown>).filter((event) => event.event === 'operator.action');
    expect(events).toEqual([expect.objectContaining({ operation: 'restore.schedule' })]);
    expect(events[0]).not.toHaveProperty('reason');
    expect(logged.join('\n')).not.toContain(BOOKMARK.slice(0, 17));
  });

  it('OPS-03: a bookmark is scheduled as given, from recovery as well as frozen; a platform refusal schedules nothing and never restarts', async () => {
    await rotatedAndFrozen('recovery', 8);
    const direct = await restoreWithStubbedStorage(request({ expectedState: 'recovery', expectedVersion: 8 }));
    expect(direct.outcome).toEqual({ status: 'scheduled', bookmark: BOOKMARK, undoBookmark: UNDO });
    expect(direct.events).toEqual([`schedule:${BOOKMARK}`, 'reply:scheduled', 'abort']);

    const refused = await runInDurableObject(workspaceStub(), async (instance, state) => {
      vi.spyOn(state.storage, 'getBookmarkForTime').mockRejectedValue(new Error('outside the retention window'));
      const schedule = vi.spyOn(state.storage, 'onNextSessionRestoreBookmark');
      const abort = vi.spyOn(state, 'abort').mockImplementation(() => undefined);
      const outcome = await (instance as unknown as { restoreToBookmark(input: RestoreBookmarkInput): Promise<RestoreBookmarkOutcome> })
        .restoreToBookmark(request({ expectedState: 'recovery', expectedVersion: 8, bookmark: null, at: Date.now() - DAY_MS }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { outcome, scheduled: schedule.mock.calls.length, aborted: abort.mock.calls.length };
    });
    expect(refused).toEqual({ outcome: { status: 'bookmark-refused' }, scheduled: 0, aborted: 0 });
  });

  it('OPS-03: through the RPC stub the scheduled reply reaches the caller, then the object really resets and reopens', async () => {
    // Only onNextSessionRestoreBookmark is stubbed; ctx.abort is workerd's own.
    // Locally the reopened object finds its storage unchanged (no restore is
    // applied); on Cloudflare it opens on the bookmark.
    await rotatedAndFrozen();
    await runInDurableObject(workspaceStub(), async (instance, state) => {
      (instance as unknown as { restoreProbe?: string }).restoreProbe = 'before-restart';
      vi.spyOn(state.storage, 'onNextSessionRestoreBookmark').mockResolvedValue(UNDO);
    });
    expect(await workspaceStub().restoreToBookmark(request())).toEqual({ status: 'scheduled', bookmark: BOOKMARK, undoBookmark: UNDO });
    await vi.waitFor(async () => {
      const probe = await runInDurableObject(workspaceStub(), (instance) => (instance as unknown as { restoreProbe?: string }).restoreProbe ?? 'fresh');
      expect(probe).toBe('fresh');
    });
    expect(await workspaceStub().operatorStatus()).toMatchObject({
      status: 'ok',
      maintenance: { state: 'frozen', version: 5 },
      epoch: { activated: OLD_EPOCH, configuredMatches: false },
    });
  });

  it('OPS-03: the local runtime has no point-in-time recovery: through the RPC stub its storage refuses and nothing is scheduled', async () => {
    await rotatedAndFrozen();
    const stub = workspaceStub();
    expect(await stub.restoreToBookmark(request({ bookmark: null, at: Date.now() - 60_000 }))).toEqual({ status: 'bookmark-refused' });
    expect(await stub.restoreToBookmark(request())).toEqual({ status: 'bookmark-refused' });
    expect(await meta()).toMatchObject({ maintenance_state: 'frozen', maintenance_version: 5, activated_epoch: OLD_EPOCH });
    expect(await stub.operatorStatus()).toMatchObject({ status: 'ok', epoch: { activated: OLD_EPOCH, configuredMatches: false } });
  });
});
