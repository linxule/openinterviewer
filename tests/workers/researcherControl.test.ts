// Synthetic release regressions through the actual production DO RPC boundary.
import { beforeEach, describe, expect, it } from 'vitest';
import { evictDurableObject, reset, runInDurableObject } from 'cloudflare:test';
import type { ExplorationAnswer, ExplorationReservation } from '../../src/lib/exploration/types';
import { MIGRATIONS } from '../../cloudflare/workspace/schema';
import { applyMigrations } from '../../cloudflare/workspace/migrate';
import { createDurableWorkspaceStore } from '../../src/lib/storage/durableObject';
import { testEnv, workspaceStub } from './helpers';
import { count, createStudy, currentStudy, enrolParticipant, mutationSeq, persistInput, randomHex64, sql, T0 } from './fixtures';

beforeEach(async () => { await reset(); });

async function notebook() {
  const study = await createStudy();
  const participant = await enrolParticipant(study);
  const input = await persistInput(participant);
  expect(await workspaceStub().persistCompletedInterview(input)).toEqual({ status: 'created' });
  const answer: ExplorationAnswer = {
    id: crypto.randomUUID(), studyId: study.id, question: 'What synthetic concern is overlooked?',
    scope: { studyId: study.id, selection: {}, sources: [{ interviewId: input.interview.id, studyRevision: 1, contentHash: randomHex64() }],
      totalSaved: 1, selectedCount: 1, excludedCount: 0, unknownProfileCount: 0, pendingAnalysisCount: 1, sourceFingerprint: randomHex64() },
    createdAt: T0, updatedAt: T0, status: 'running', requestFingerprint: randomHex64(), promptVersion: 1,
  };
  const reservation: ExplorationReservation = { answer, keyDigest: randomHex64(), expectedStudyRevision: 1 };
  return { study, participant, input, answer, reservation };
}

const RESULT = {
  answer: 'A synthetic overlooked concern.', findings: [], limitations: ['Synthetic fixture only.'],
};
const EXECUTION = { provider: 'openai' as const, requestedModel: 'gpt-5.6-terra', model: 'gpt-fixture' };

/** Invoke the real RPC, then lose exactly its first committed reply. */
function loseCommittedReply(method: string) {
  let loseReply = true;
  return createDurableWorkspaceStore({
    namespace: { getByName: () => {
      const target = workspaceStub() as unknown as Record<string, (input: unknown) => Promise<unknown>>;
      return new Proxy({}, { get: (_unused, operation: string) => async (input: unknown) => {
        const result = await target[operation](input);
        if (operation === method && loseReply) {
          loseReply = false;
          throw new Error('synthetic committed reply loss');
        }
        return result;
      } });
    } },
    workspaceId: testEnv.WORKSPACE_ID, jurisdiction: '', rateLimitSalt: 'synthetic-notebook-fault-salt',
  }).exploration!;
}

describe('researcher control and durable notebooks', () => {
  it('access pause/resume retains live link and consent authority; revoked links never revive', async () => {
    const study = await createStudy();
    const participant = await enrolParticipant(study);
    const revoked = await enrolParticipant(study);
    await workspaceStub().revokeParticipantLink({ studyId: study.id, linkId: revoked.linkId, now: T0 });
    await workspaceStub().setStudyLinksEnabled({ studyId: study.id, enabled: false, now: T0 + 1 });
    expect((await currentStudy(study.id)).revision).toBe(1);
    expect(await workspaceStub().getParticipantLink({ linkId: participant.linkId, purpose: 'exchange', now: T0 + 1 })).toEqual({ status: 'not-found' });
    expect(await workspaceStub().recordConsent({ participantSessionId: participant.sessionId, studyId: study.id,
      studyRevision: 1, consentHash: participant.consentHash, now: T0 + 1 })).toEqual({ status: 'conflict' });
    expect(await workspaceStub().persistCompletedInterview(await persistInput(participant))).toEqual({ status: 'links-disabled' });
    await workspaceStub().setStudyLinksEnabled({ studyId: study.id, enabled: true, now: T0 + 2 });
    const resumed = await currentStudy(study.id);
    expect(resumed.revision).toBe(1);
    expect((await workspaceStub().getParticipantLink({ linkId: participant.linkId, purpose: 'exchange', now: T0 + 2 })).status).toBe('found');
    expect(await workspaceStub().persistCompletedInterview(await persistInput({ ...participant, study: resumed }))).toEqual({ status: 'created' });
    expect(await workspaceStub().persistCompletedInterview(await persistInput({ ...revoked, study: resumed }))).toEqual({ status: 'link-inactive' });
  });

  it('a structurally identical config save does not change revision, time or links', async () => {
    const study = await createStudy();
    const reordered = Object.fromEntries(Object.entries(study.config).reverse()) as typeof study.config;
    expect(await workspaceStub().replaceStudyConfig({ studyId: study.id, expectedRevision: 1, config: reordered, now: T0 })).toEqual({ status: 'updated', study });
    expect((await currentStudy(study.id)).revision).toBe(1);
  });

  it('stale protocol edits and no-op saves never undo a concurrent access pause or resume', async () => {
    const study = await createStudy({ linksEnabled: true });
    await workspaceStub().setStudyLinksEnabled({ studyId: study.id, enabled: false, now: T0 });
    expect(await workspaceStub().replaceStudyConfig({ studyId: study.id, expectedRevision: 1, config: study.config, now: T0 + 1 })).toMatchObject({
      status: 'updated', study: { revision: 1, updatedAt: T0, config: { linksEnabled: false } },
    });
    const edited = await workspaceStub().replaceStudyConfig({ studyId: study.id, expectedRevision: 1,
      config: { ...study.config, name: 'Content edit from before pause' }, now: T0 + 2 });
    expect(edited).toMatchObject({ status: 'updated', study: { revision: 2, config: { linksEnabled: false } } });
    if (edited.status !== 'updated') throw new Error('edit refused');
    await workspaceStub().setStudyLinksEnabled({ studyId: study.id, enabled: true, now: T0 + 3 });
    expect(await workspaceStub().replaceStudyConfig({ studyId: study.id, expectedRevision: 2,
      config: { ...edited.study.config, name: 'Content edit from before resume' }, now: T0 + 4 })).toMatchObject({
      status: 'updated', study: { revision: 3, config: { linksEnabled: true } },
    });
  });

  it('reservation replay returns its original attempt after refresh/eviction and rejects fingerprint reuse', async () => {
    const { reservation, study, answer } = await notebook();
    expect(await workspaceStub().reserveExploration(reservation)).toEqual({ status: 'created', answer });
    await evictDurableObject(workspaceStub());
    expect(await workspaceStub().reserveExploration({ ...reservation, answer: { ...answer, id: crypto.randomUUID() } })).toEqual({ status: 'replay', answer });
    await workspaceStub().replaceStudyConfig({ studyId: study.id, expectedRevision: 1, config: { ...study.config, name: 'Edited after answer' }, now: T0 + 1 });
    expect(await workspaceStub().lookupExploration({ studyId: study.id, keyDigest: reservation.keyDigest, requestFingerprint: answer.requestFingerprint })).toEqual({ status: 'found', answer });
    expect(await workspaceStub().reserveExploration({ ...reservation, answer: { ...answer, requestFingerprint: randomHex64() } })).toEqual({ status: 'key-reuse' });
    expect(await workspaceStub().listExplorations({ studyId: study.id, maximum: 500 })).toEqual({ status: 'ok', answers: [answer] });
    expect(await count('exploration_answers')).toBe(1);
    expect(await count('budget_windows')).toBe(0);
  });

  it('a notebook receipt write failure rolls back reservation content and permits one same-key retry', async () => {
    const { reservation, answer } = await notebook();
    const before = await mutationSeq();
    await sql(`CREATE TRIGGER notebook_fail_receipt BEFORE INSERT ON idempotency_receipts
      WHEN NEW.operation_family = 'exploration' BEGIN SELECT RAISE(ABORT, 'synthetic receipt write failure'); END`);
    expect(await workspaceStub().reserveExploration(reservation)).toEqual({ status: 'unavailable' });
    expect(await count('exploration_answers')).toBe(0);
    expect(await count('idempotency_receipts', "operation_family = 'exploration'")).toBe(0);
    expect(await mutationSeq()).toBe(before);
    await sql('DROP TRIGGER notebook_fail_receipt');
    expect(await workspaceStub().reserveExploration(reservation)).toEqual({ status: 'created', answer });
    expect(await workspaceStub().reserveExploration(reservation)).toEqual({ status: 'replay', answer });
    expect(await count('exploration_answers')).toBe(1);
    expect(await count('budget_windows')).toBe(0);
  });

  it('a committed notebook reservation with a lost RPC reply replays after eviction without another attempt or charge', async () => {
    const { reservation, answer } = await notebook();
    const store = loseCommittedReply('reserveExploration');
    expect(await store.reserve(reservation)).toEqual({ status: 'unavailable' });
    const committed = await mutationSeq();
    await evictDurableObject(workspaceStub());
    expect(await store.reserve({ ...reservation, answer: { ...answer, id: crypto.randomUUID() } })).toEqual({ status: 'replay', answer });
    expect(await mutationSeq()).toBe(committed);
    expect(await count('exploration_answers')).toBe(1);
    expect(await count('idempotency_receipts', "operation_family = 'exploration'")).toBe(1);
    expect(await count('budget_windows')).toBe(0);
  });

  it('a mutation-sequence failure rolls back both notebook completion and failure settlement', async () => {
    const { reservation, answer } = await notebook();
    await workspaceStub().reserveExploration(reservation);
    const before = await mutationSeq();
    const identity = { studyId: answer.studyId, answerId: answer.id, requestFingerprint: answer.requestFingerprint };
    await sql(`CREATE TRIGGER notebook_fail_mutation BEFORE UPDATE OF mutation_seq ON workspace_meta
      BEGIN SELECT RAISE(ABORT, 'synthetic mutation write failure'); END`);
    expect(await workspaceStub().completeExploration({ ...identity, result: RESULT, execution: EXECUTION, now: T0 + 1 })).toEqual({ status: 'unavailable' });
    expect(await workspaceStub().failExploration({ ...identity, status: 'failed', failureKind: 'provider', now: T0 + 1 })).toEqual({ status: 'unavailable' });
    expect(await workspaceStub().getExploration(identity)).toEqual({ status: 'found', answer });
    expect(await mutationSeq()).toBe(before);
    await sql('DROP TRIGGER notebook_fail_mutation');
    expect(await workspaceStub().completeExploration({ ...identity, result: RESULT, execution: EXECUTION, now: T0 + 2 })).toMatchObject({ status: 'saved', answer: { status: 'complete' } });
  });

  it('committed notebook settlements with lost RPC replies replay unchanged without another paid attempt', async () => {
    const { reservation, answer } = await notebook();
    await workspaceStub().reserveExploration(reservation);
    const identity = { studyId: answer.studyId, answerId: answer.id, requestFingerprint: answer.requestFingerprint };
    const failure = { ...identity, status: 'recovery-required' as const, failureKind: 'storage', now: T0 + 1 };
    const failingStore = loseCommittedReply('failExploration');
    expect(await failingStore.fail(failure)).toEqual({ status: 'unavailable' });
    const failureSequence = await mutationSeq();
    await evictDurableObject(workspaceStub());
    expect(await failingStore.fail({ ...failure, now: T0 + 2 })).toMatchObject({ status: 'saved', answer: { status: 'recovery-required', updatedAt: T0 + 1 } });
    expect(await mutationSeq()).toBe(failureSequence);
    const completion = { ...identity, result: RESULT, execution: EXECUTION, now: T0 + 3 };
    const completingStore = loseCommittedReply('completeExploration');
    expect(await completingStore.complete(completion)).toEqual({ status: 'unavailable' });
    const completedSequence = await mutationSeq();
    await evictDurableObject(workspaceStub());
    expect(await completingStore.complete({ ...completion, now: T0 + 4 })).toMatchObject({ status: 'saved', answer: { status: 'complete', updatedAt: T0 + 3, result: RESULT, execution: EXECUTION } });
    expect(await mutationSeq()).toBe(completedSequence);
    expect(await count('exploration_answers')).toBe(1);
    expect(await count('budget_windows')).toBe(0);
  });

  it('reserve refuses changed revision, foreign sources and missing ancestry without writes', async () => {
    const { reservation, study, answer } = await notebook();
    expect(await workspaceStub().reserveExploration({ ...reservation, expectedStudyRevision: 2 })).toEqual({ status: 'revision-stale' });
    const other = await notebook();
    expect(await workspaceStub().reserveExploration({ ...reservation, answer: { ...answer, scope: { ...answer.scope, sources: other.answer.scope.sources } } })).toEqual({ status: 'unavailable' });
    expect(await workspaceStub().reserveExploration({ ...reservation, answer: { ...answer, parentAnswerId: crypto.randomUUID() } })).toEqual({ status: 'unavailable' });
    expect(await count('exploration_answers', 'study_id = ?', study.id)).toBe(0);
  });

  it('save-only recovery persists one answer/provenance and protects it from changed settlement', async () => {
    const { reservation, answer } = await notebook();
    await workspaceStub().reserveExploration(reservation);
    const identity = { studyId: answer.studyId, answerId: answer.id, requestFingerprint: answer.requestFingerprint };
    expect((await workspaceStub().failExploration({ ...identity, status: 'recovery-required', failureKind: 'storage', now: T0 + 1 })).status).toBe('saved');
    const completion = { ...identity, result: RESULT, execution: EXECUTION, now: T0 + 2 };
    const saved = await workspaceStub().completeExploration(completion);
    expect(saved).toMatchObject({ status: 'saved', answer: { ...answer, status: 'complete', result: RESULT, execution: EXECUTION, updatedAt: T0 + 2 } });
    expect(await workspaceStub().completeExploration({ ...completion, now: T0 + 3 })).toEqual(saved);
    expect(await workspaceStub().completeExploration({ ...completion, result: { ...RESULT, answer: 'Changed result' } })).toEqual({ status: 'conflict' });
    expect(await workspaceStub().failExploration({ ...identity, status: 'failed', failureKind: 'provider', now: T0 + 3 })).toEqual({ status: 'conflict' });
  });

  it('populated deletion cascades all content, consumes receipts, fences replays and preserves another study', async () => {
    const { reservation, study, answer, input } = await notebook();
    await workspaceStub().reserveExploration(reservation);
    const other = await notebook();
    expect(await workspaceStub().deleteStudy({ studyId: study.id, expectedRevision: 2, deleteInterviews: true, now: T0 + 1 })).toMatchObject({ status: 'conflict' });
    expect(await workspaceStub().getExploration({ studyId: study.id, answerId: answer.id })).toEqual({ status: 'found', answer });
    expect(await workspaceStub().deleteStudy({ studyId: study.id, expectedRevision: 1, deleteInterviews: true, now: T0 + 2 })).toEqual({ status: 'deleted', success: true });
    expect(await workspaceStub().deleteStudy({ studyId: study.id, deleteInterviews: true, now: T0 + 3 })).toEqual({ status: 'deleted', success: true });
    expect(await workspaceStub().persistCompletedInterview(input)).toEqual({ status: 'study-not-found' });
    expect(await workspaceStub().completeExploration({ studyId: study.id, answerId: answer.id, requestFingerprint: answer.requestFingerprint, result: RESULT, execution: EXECUTION, now: T0 + 3 })).toEqual({ status: 'study-not-found' });
    for (const table of ['interviews', 'participant_links', 'consents', 'aggregates', 'exploration_answers']) {
      expect(await count(table, 'study_id = ?', study.id)).toBe(0);
    }
    expect(await count('analysis_jobs', 'interview_id = ?', input.interview.id)).toBe(0);
    expect(await count('analysis', 'interview_id = ?', input.interview.id)).toBe(0);
    expect(await sql(`SELECT result_json FROM idempotency_receipts WHERE target_id = ?`, study.id)).toEqual([{ result_json: null }, { result_json: null }]);
    expect((await currentStudy(other.study.id)).interviewCount).toBe(1);
  });

  it('completion versus populated deletion cannot leave orphaned transcripts or provider inputs', async () => {
    const study = await createStudy();
    const participant = await enrolParticipant(study);
    const input = await persistInput(participant);
    const outcomes = await Promise.all([
      workspaceStub().persistCompletedInterview(input),
      workspaceStub().deleteStudy({ studyId: study.id, deleteInterviews: true, expectedRevision: 1, now: T0 + 1 }),
    ]);
    expect(outcomes[1]).toEqual({ status: 'deleted', success: true });
    for (const table of ['studies', 'interviews', 'analysis', 'analysis_jobs']) expect(await count(table)).toBe(0);
  });

  it('scoped and all-study snapshot exports coexist and include exact notebook artifacts', async () => {
    const first = await notebook();
    const second = await notebook();
    await workspaceStub().reserveExploration(first.reservation);
    await workspaceStub().reserveExploration(second.reservation);
    const all = await workspaceStub().beginExport({ maximum: 100 });
    const scoped = await workspaceStub().beginExport({ maximum: 100, studyId: first.study.id });
    if (all.status !== 'ok' || scoped.status !== 'ok') throw new Error('export refused');
    expect(all.sequence).toBe(scoped.sequence);
    expect(scoped.count).toBe(1);
    let cursor: string | null = null;
    const ids: string[] = []; const answerIds: string[] = [];
    do {
      const page = await workspaceStub().readExportPage({ sequence: scoped.sequence, studyId: first.study.id, cursor, pageSize: 1, maxPageBytes: 1024 * 1024 });
      if (page.status !== 'ok') throw new Error(page.status);
      ids.push(...page.interviews.map(interview => interview.id));
      answerIds.push(...(page.explorations ?? []).map(answer => answer.id));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(ids).toEqual([first.input.interview.id]); expect(answerIds).toEqual([first.answer.id]);
    expect(await workspaceStub().verifyExportSequence({ sequence: all.sequence })).toEqual({ status: 'unchanged' });
    expect(await workspaceStub().verifyExportSequence({ sequence: scoped.sequence, studyId: first.study.id })).toEqual({ status: 'unchanged' });
    await workspaceStub().failExploration({ studyId: first.study.id, answerId: first.answer.id, requestFingerprint: first.answer.requestFingerprint, status: 'failed', failureKind: 'provider', now: T0 + 1 });
    expect(await workspaceStub().verifyExportSequence({ sequence: scoped.sequence, studyId: first.study.id })).toEqual({ status: 'changed' });
  });

  it('old schema readers fail closed after notebook migration and preserve existing artifacts', async () => {
    const { reservation } = await notebook();
    await workspaceStub().reserveExploration(reservation);
    const outcome = await runInDurableObject(workspaceStub(), (_instance, state) => applyMigrations(state.storage, [MIGRATIONS[0]]));
    expect(outcome).toEqual({ status: 'schema-unsupported', storedVersion: 2, reason: 'newer-incompatible' });
    expect(await count('exploration_answers')).toBe(1);
  });

  it('the atomic per-study notebook cap refuses excess work without a receipt or truncated listing', async () => {
    const { reservation, answer } = await notebook();
    await runInDurableObject(workspaceStub(), (_instance, state) => {
      for (let index = 0; index < 500; index += 1) {
        const item = { ...answer, id: `answer-${index}` };
        state.storage.sql.exec(`INSERT INTO exploration_answers (id, study_id, record_json, request_fingerprint, created_at, updated_at, status)
          VALUES (?, ?, ?, ?, ?, ?, 'running')`, item.id, item.studyId, JSON.stringify(item), item.requestFingerprint, item.createdAt, item.updatedAt);
      }
    });
    expect(await workspaceStub().reserveExploration(reservation)).toEqual({ status: 'quota' });
    expect(await workspaceStub().listExplorations({ studyId: answer.studyId, maximum: 499 })).toEqual({ status: 'too-large' });
    const all = await workspaceStub().listExplorations({ studyId: answer.studyId, maximum: 500 });
    expect(all.status === 'ok' && all.answers.length).toBe(500);
    expect(await count('idempotency_receipts', "operation_family = 'exploration'")).toBe(0);
  });

  it('recovery activation classifies a restored running reservation as uncertain, never allocates another attempt', async () => {
    const { reservation, answer } = await notebook();
    await workspaceStub().reserveExploration(reservation);
    const oldEpoch = `ep_${'a'.repeat(32)}`;
    expect(oldEpoch).not.toBe(testEnv.ANALYSIS_RECOVERY_EPOCH);
    await sql(`UPDATE workspace_meta SET maintenance_state = 'recovery', activated_epoch = ?`, oldEpoch);
    expect((await workspaceStub().activateRecoveryEpoch({ expectedActivatedEpoch: oldEpoch, now: T0 + 1 })).status).toBe('activated');
    expect(await workspaceStub().getExploration({ studyId: answer.studyId, answerId: answer.id })).toMatchObject({
      status: 'found', answer: { status: 'recovery-required', failureKind: 'restored-attempt', updatedAt: T0 + 1 },
    });
    expect(await count('exploration_answers')).toBe(1);
    expect(await count('budget_windows')).toBe(0);
  });

  it('a notebook larger than one RPC remains readable through bounded, non-overlapping pages', async () => {
    const { answer } = await notebook();
    const result = { answer: 'a'.repeat(20_000), findings: Array.from({ length: 12 }, (_, index) => ({
      heading: `Synthetic ${index}`, interpretation: 'b'.repeat(8_000), supporting: [], challenging: [], uncertain: [],
    })), limitations: [] };
    await runInDurableObject(workspaceStub(), (_instance, state) => {
      for (let index = 0; index < 150; index += 1) {
        const item: ExplorationAnswer = { ...answer, id: `large-answer-${index}`, status: 'complete', result, execution: EXECUTION };
        state.storage.sql.exec(`INSERT INTO exploration_answers (id, study_id, record_json, request_fingerprint, created_at, updated_at, status)
          VALUES (?, ?, ?, ?, ?, ?, 'complete')`, item.id, item.studyId, JSON.stringify(item), item.requestFingerprint, item.createdAt, item.updatedAt);
      }
    });
    const first = await workspaceStub().listExplorations({ studyId: answer.studyId, maximum: 500, pageSize: 25 });
    if (first.status !== 'ok' || !first.nextCursor) throw new Error('paged notebook refused');
    expect(first.answers).toHaveLength(25);
    const next = await workspaceStub().listExplorations({ studyId: answer.studyId, maximum: 500, pageSize: 25, cursor: first.nextCursor });
    if (next.status !== 'ok') throw new Error('second page refused');
    expect(next.answers).toHaveLength(25);
    expect(new Set([...first.answers, ...next.answers].map(item => item.id)).size).toBe(50);
    expect(await workspaceStub().listExplorations({ studyId: answer.studyId, maximum: 500, pageSize: 26 })).toEqual({ status: 'unavailable' });
    expect(await workspaceStub().listExplorations({ studyId: answer.studyId, maximum: 500, pageSize: 25, cursor: 'bad-cursor' })).toEqual({ status: 'unavailable' });
  });

  it('operator freeze refuses running notebooks until explicitly classified, without creating another paid attempt', async () => {
    const { reservation, answer } = await notebook();
    await workspaceStub().reserveExploration(reservation);
    expect(await workspaceStub().transitionMaintenance({ expectedState: 'open', expectedVersion: 0, nextState: 'draining', now: T0 + 1 })).toMatchObject({ status: 'transitioned' });
    expect(await workspaceStub().transitionMaintenance({ expectedState: 'draining', expectedVersion: 1, nextState: 'frozen', now: T0 + 2 }))
      .toEqual({ status: 'in-flight', claimed: 0, started: 0, explorations: 1 });
    expect(await workspaceStub().getExploration({ studyId: answer.studyId, answerId: answer.id })).toEqual({ status: 'found', answer });
    expect(await workspaceStub().transitionMaintenance({ expectedState: 'draining', expectedVersion: 1, nextState: 'frozen', classifyInFlight: true, now: T0 + 3 })).toMatchObject({ status: 'transitioned' });
    expect(await workspaceStub().getExploration({ studyId: answer.studyId, answerId: answer.id })).toMatchObject({ status: 'found', answer: { status: 'recovery-required', failureKind: 'maintenance' } });
    expect(await count('budget_windows')).toBe(0);
  });

  it('a failure after notebook freeze classification rolls back the answer, operator state and audit together', async () => {
    const { reservation, answer } = await notebook();
    await workspaceStub().reserveExploration(reservation);
    await workspaceStub().transitionMaintenance({ expectedState: 'open', expectedVersion: 0, nextState: 'draining', now: T0 + 1 });
    const before = await mutationSeq();
    const audits = await count('operator_audit');
    await sql(`CREATE TRIGGER notebook_fail_freeze BEFORE UPDATE OF maintenance_state ON workspace_meta
      WHEN NEW.maintenance_state = 'frozen' BEGIN SELECT RAISE(ABORT, 'synthetic freeze write failure'); END`);
    const freeze = { expectedState: 'draining' as const, expectedVersion: 1, nextState: 'frozen' as const, classifyInFlight: true, now: T0 + 2 };
    expect(await workspaceStub().transitionMaintenance(freeze)).toEqual({ status: 'unavailable' });
    expect(await workspaceStub().getExploration({ studyId: answer.studyId, answerId: answer.id })).toEqual({ status: 'found', answer });
    expect(await sql(`SELECT maintenance_state, maintenance_version FROM workspace_meta`)).toEqual([{ maintenance_state: 'draining', maintenance_version: 1 }]);
    expect(await mutationSeq()).toBe(before);
    expect(await count('operator_audit')).toBe(audits);
    await sql('DROP TRIGGER notebook_fail_freeze');
    expect(await workspaceStub().transitionMaintenance(freeze)).toMatchObject({ status: 'transitioned', state: 'frozen', version: 2 });
    await evictDurableObject(workspaceStub());
    expect(await workspaceStub().transitionMaintenance(freeze)).toEqual({ status: 'already', state: 'frozen', version: 2 });
    expect(await workspaceStub().getExploration({ studyId: answer.studyId, answerId: answer.id })).toMatchObject({ status: 'found', answer: { status: 'recovery-required', failureKind: 'maintenance' } });
    expect(await count('budget_windows')).toBe(0);
  });
});
