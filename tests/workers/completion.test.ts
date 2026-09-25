import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictDurableObject, reset, runInDurableObject } from 'cloudflare:test';
import { persistCompletedInterview } from '../../cloudflare/workspace/completion';
import type { WorkspaceContext } from '../../cloudflare/workspace/context';
import type { LinkRevokeOutcome } from '../../src/lib/storage/types';
import type { StoredInterview } from '../../src/types';
import { testEnv, workspaceStub } from './helpers';
import {
  alarmAt,
  captureStoreEvents,
  count,
  createStudy,
  currentStudy,
  DAY,
  enrolParticipant,
  frozenInput,
  HOUR,
  interviewRecord,
  mutationSeq,
  persistInput,
  planRow,
  randomHex64,
  setMaintenance,
  sql,
  T0,
} from './fixtures';

beforeEach(async () => {
  await reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function writesFor(interviewId: string) {
  return {
    interviews: await count('interviews', 'id = ?', interviewId),
    analysis: await count('analysis', 'interview_id = ?', interviewId),
    jobs: await count('analysis_jobs', 'interview_id = ?', interviewId),
    members: await count('budget_members', 'member = ?', interviewId),
  };
}

const NONE = { interviews: 0, analysis: 0, jobs: 0, members: 0 };

describe('persistCompletedInterview commit (ST-02, JOB-01, JOB-05)', () => {
  it('JOB-01/JOB-05: commits transcript, analysis projection, initial job, admission, count/lock and alarm together', async () => {
    const study = await createStudy();
    const participant = await enrolParticipant(study);
    const rows = [planRow(5), planRow(5)];
    const input = await persistInput(participant, { ratePlan: rows });
    const seqBefore = await mutationSeq();

    expect(await workspaceStub().persistCompletedInterview(input)).toEqual({ status: 'created' });

    const [stored] = await sql<{ record_json: string; fingerprint: string; link_id: string; study_revision: number }>(
      `SELECT record_json, fingerprint, link_id, study_revision FROM interviews WHERE id = ?`,
      input.interview.id,
    );
    expect(stored.record_json).toBe(JSON.stringify(input.interview));
    expect(stored.fingerprint).toBe(input.fingerprint);
    expect(stored.link_id).toBe(participant.linkId);
    expect(stored.study_revision).toBe(1);

    expect(await sql(`SELECT status, current_generation, attempts, last_attempt_at FROM analysis WHERE interview_id = ?`, input.interview.id))
      .toEqual([{ status: 'pending', current_generation: 1, attempts: 0, last_attempt_at: T0 }]);
    expect(await sql(
      `SELECT job_id, generation, recovery_epoch, state, input_json, requested_provider, requested_model, next_due_at
         FROM analysis_jobs WHERE interview_id = ?`,
      input.interview.id,
    )).toEqual([{
      job_id: input.initialJobId,
      generation: 1,
      recovery_epoch: testEnv.ANALYSIS_RECOVERY_EPOCH,
      state: 'pending',
      input_json: JSON.stringify(frozenInput(study)),
      requested_provider: 'openai',
      requested_model: 'gpt-5.6-terra',
      next_due_at: T0,
    }]);
    expect(await sql(`SELECT plan_key, expires_at FROM budget_members WHERE member = ? ORDER BY plan_key`, input.interview.id))
      .toEqual(rows
        .map((row) => ({ plan_key: row.key, expires_at: (row.windowStart + row.windowSeconds + 60) * 1000 }))
        .sort((a, b) => a.plan_key.localeCompare(b.plan_key)));

    const after = await currentStudy(study.id);
    expect(after).toMatchObject({ interviewCount: 1, isLocked: true, updatedAt: T0, revision: 1 });
    expect(await mutationSeq()).toBe(seqBefore + 1);
    expect(await alarmAt()).toBe(T0);

    const read = await workspaceStub().getInterview({ interviewId: input.interview.id });
    expect(read).toEqual({
      status: 'found',
      interview: {
        ...input.interview,
        synthesis: null,
        analysis: { status: 'pending', attempts: 0, lastAttemptAt: T0, generation: 1 },
      },
    });
  });

  it('ST-02: concurrent same-fingerprint completions yield one transcript, one charge, one job and a correct count', async () => {
    const study = await createStudy();
    const participant = await enrolParticipant(study);
    const row = planRow(10);
    const first = await persistInput(participant, { ratePlan: [row] });
    const second = { ...first, initialJobId: crypto.randomUUID() };

    const outcomes = await Promise.all([
      workspaceStub().persistCompletedInterview(first),
      workspaceStub().persistCompletedInterview(second),
      workspaceStub().persistCompletedInterview({ ...first, initialJobId: crypto.randomUUID() }),
    ]);

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['created', 'duplicate', 'duplicate']);
    expect(await writesFor(first.interview.id)).toEqual({ interviews: 1, analysis: 1, jobs: 1, members: 1 });
    expect(await count('budget_members', 'plan_key = ?', row.key)).toBe(1);
    expect((await currentStudy(study.id)).interviewCount).toBe(1);
  });

  it('ST-02: concurrent different-fingerprint completions for one interview id yield one transcript and a conflict', async () => {
    const study = await createStudy();
    const participant = await enrolParticipant(study);
    const first = await persistInput(participant);
    const changed = interviewRecord(participant, {
      transcript: [{ id: 'm1', role: 'user', content: 'A different synthetic answer.', timestamp: T0 - HOUR }],
    });
    const second = await persistInput(participant, { interview: changed });
    expect(second.fingerprint).not.toBe(first.fingerprint);

    const outcomes = await Promise.all([
      workspaceStub().persistCompletedInterview(first),
      workspaceStub().persistCompletedInterview(second),
    ]);

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['conflict', 'created']);
    const winner = outcomes[0].status === 'created' ? first : second;
    const stored = await sql<{ fingerprint: string; record_json: string }>(
      `SELECT fingerprint, record_json FROM interviews WHERE id = ?`,
      first.interview.id,
    );
    expect(stored).toEqual([{ fingerprint: winner.fingerprint, record_json: JSON.stringify(winner.interview) }]);
    expect(await count('analysis_jobs')).toBe(1);
    expect((await currentStudy(study.id)).interviewCount).toBe(1);
  });

  it('ST-02: a lost-response replay returns duplicate without a second job, charge, alarm change or mutation', async () => {
    const study = await createStudy();
    const participant = await enrolParticipant(study);
    const input = await persistInput(participant, { ratePlan: [planRow(1)] });
    expect((await workspaceStub().persistCompletedInterview(input)).status).toBe('created');
    const seq = await mutationSeq();

    // The client never saw the reply; it retries the same submission and mints a new job id.
    const replay = await workspaceStub().persistCompletedInterview({ ...input, initialJobId: crypto.randomUUID(), now: T0 + 5_000 });

    expect(replay).toEqual({ status: 'duplicate' });
    expect(await writesFor(input.interview.id)).toEqual({ interviews: 1, analysis: 1, jobs: 1, members: 1 });
    expect(await sql(`SELECT job_id FROM analysis_jobs`)).toEqual([{ job_id: input.initialJobId }]);
    expect(await mutationSeq()).toBe(seq);
    expect(await alarmAt()).toBe(T0);
  });
});

describe('save admission (ST-06)', () => {
  it('ST-06: concurrent saves by different sessions never exceed a fixed-window maximum', async () => {
    const study = await createStudy();
    const shared = planRow(2);
    const participants = await Promise.all([1, 2, 3, 4, 5].map(() => enrolParticipant(study)));
    const inputs = await Promise.all(participants.map((participant) => persistInput(participant, { ratePlan: [shared] })));

    const outcomes = await Promise.all(inputs.map((input) => workspaceStub().persistCompletedInterview(input)));

    const statuses = outcomes.map((outcome) => outcome.status).sort();
    expect(statuses).toEqual(['created', 'created', 'rate-limited', 'rate-limited', 'rate-limited']);
    expect(await count('budget_members', 'plan_key = ?', shared.key)).toBe(2);
    expect(await count('interviews')).toBe(2);
    expect(await count('analysis_jobs')).toBe(2);
    expect((await currentStudy(study.id)).interviewCount).toBe(2);
  });

  it('ST-06: a denied save charges no admission row, even the ones that had room', async () => {
    const study = await createStudy();
    const roomy = planRow(5);
    const full = planRow(1);
    const earlier = await enrolParticipant(study);
    expect((await workspaceStub().persistCompletedInterview(await persistInput(earlier, { ratePlan: [full] }))).status)
      .toBe('created');

    const participant = await enrolParticipant(study);
    const input = await persistInput(participant, { ratePlan: [roomy, full] });
    expect(await workspaceStub().persistCompletedInterview(input)).toEqual({ status: 'rate-limited' });

    expect(await count('budget_members', 'plan_key = ?', roomy.key)).toBe(0);
    expect(await count('budget_members', 'plan_key = ?', full.key)).toBe(1);
    expect(await writesFor(input.interview.id)).toEqual(NONE);
  });

  it('ST-06: a zero maximum is not a limit (Redis parity) and a replay never charges twice', async () => {
    const study = await createStudy();
    const participant = await enrolParticipant(study);
    const unlimited = planRow(0);
    const input = await persistInput(participant, { ratePlan: [unlimited] });
    expect((await workspaceStub().persistCompletedInterview(input)).status).toBe('created');
    expect((await workspaceStub().persistCompletedInterview(input)).status).toBe('duplicate');
    expect(await count('budget_members', 'plan_key = ?', unlimited.key)).toBe(1);
  });
});

describe('write-boundary authority (ST-03)', () => {
  it('ST-03: an edited study refuses a save pinned to the old revision', async () => {
    const study = await createStudy();
    const participant = await enrolParticipant(study);
    const input = await persistInput(participant);
    const edited = await workspaceStub().replaceStudyConfig({
      studyId: study.id,
      expectedRevision: 1,
      config: { ...study.config, name: 'Edited' },
      now: T0,
    });
    expect(edited.status).toBe('updated');

    expect(await workspaceStub().persistCompletedInterview(input)).toEqual({ status: 'revision-stale' });
    expect(await writesFor(input.interview.id)).toEqual(NONE);
  });

  it('ST-03: disabling links refuses the save before the revision check', async () => {
    const study = await createStudy();
    const participant = await enrolParticipant(study);
    const input = await persistInput(participant);
    expect((await workspaceStub().setStudyLinksEnabled({ studyId: study.id, enabled: false, now: T0 })).status).toBe('updated');

    expect(await workspaceStub().persistCompletedInterview(input)).toEqual({ status: 'links-disabled' });
    expect(await workspaceStub().persistCompletedInterview({ ...input, allowDisabledLinks: true }))
      .toEqual({ status: 'revision-stale' });
    expect(await writesFor(input.interview.id)).toEqual(NONE);
  });

  it('ST-03: a revoked link refuses the save', async () => {
    const study = await createStudy();
    const participant = await enrolParticipant(study);
    const input = await persistInput(participant);
    expect((await workspaceStub().revokeParticipantLink({ studyId: study.id, linkId: participant.linkId, now: T0 })).status)
      .toBe('revoked');

    expect(await workspaceStub().persistCompletedInterview(input)).toEqual({ status: 'link-inactive' });
    expect(await writesFor(input.interview.id)).toEqual(NONE);
  });

  it('ST-03: a link past its absolute expiry refuses the save although no cleanup ran', async () => {
    const study = await createStudy();
    const participant = await enrolParticipant(study, { expiresAt: T0 + HOUR });
    expect(await count('participant_links', 'id = ?', participant.linkId)).toBe(1);

    const input = await persistInput(participant, { now: T0 + HOUR });
    expect(await workspaceStub().persistCompletedInterview(input)).toEqual({ status: 'link-inactive' });
    const justBefore = await persistInput(participant, { now: T0 + HOUR - 1 });
    expect((await workspaceStub().persistCompletedInterview(justBefore)).status).toBe('created');
  });

  it('ST-03: a missing link or a link for another study or revision is inactive', async () => {
    const study = await createStudy();
    const other = await createStudy();
    const participant = await enrolParticipant(study);
    const foreign = await enrolParticipant(other);

    const unknown = await persistInput(participant);
    unknown.identity = { ...unknown.identity, linkId: randomHex64() };
    expect(await workspaceStub().persistCompletedInterview(unknown)).toEqual({ status: 'link-inactive' });

    const crossed = await persistInput(participant);
    crossed.identity = { ...crossed.identity, linkId: foreign.linkId };
    expect(await workspaceStub().persistCompletedInterview(crossed)).toEqual({ status: 'link-inactive' });

    const missing = await persistInput(participant);
    missing.identity = { ...missing.identity, linkId: null };
    expect(await workspaceStub().persistCompletedInterview(missing)).toEqual({ status: 'link-inactive' });
    expect(await count('interviews')).toBe(0);
  });

  it('ST-03: a deleted study refuses the save as not found', async () => {
    const study = await createStudy();
    const participant = await enrolParticipant(study);
    const input = await persistInput(participant);
    expect(await workspaceStub().deleteStudy({ studyId: study.id, now: T0 })).toEqual({ status: 'deleted', success: true });

    expect(await workspaceStub().persistCompletedInterview(input)).toEqual({ status: 'study-not-found' });
    expect(await writesFor(input.interview.id)).toEqual(NONE);
  });

  it('ST-03: missing, mismatched or expired consent refuses the save', async () => {
    const study = await createStudy();
    const participant = await enrolParticipant(study);

    const wrongHash = await persistInput(participant);
    wrongHash.consent = { ...wrongHash.consent, consentHash: randomHex64() };
    expect(await workspaceStub().persistCompletedInterview(wrongHash)).toEqual({ status: 'consent-required' });

    const otherSession = await persistInput(participant);
    otherSession.consent = { ...otherSession.consent, participantSessionId: crypto.randomUUID() };
    expect(await workspaceStub().persistCompletedInterview(otherSession)).toEqual({ status: 'consent-required' });

    const noSession = await persistInput(participant);
    noSession.identity = { ...noSession.identity, participantSessionId: null };
    expect(await workspaceStub().persistCompletedInterview(noSession)).toEqual({ status: 'consent-required' });

    const expired = await persistInput(participant, { now: participant.consentAcceptedAt + 4 * HOUR });
    expect(await workspaceStub().persistCompletedInterview(expired)).toEqual({ status: 'consent-required' });
    expect(await count('interviews')).toBe(0);
  });

  it('ST-03: a replay of a committed save after revoke or edit is refused, never confirmed', async () => {
    const study = await createStudy();
    const participant = await enrolParticipant(study);
    const input = await persistInput(participant);
    expect((await workspaceStub().persistCompletedInterview(input)).status).toBe('created');

    await workspaceStub().revokeParticipantLink({ studyId: study.id, linkId: participant.linkId, now: T0 });
    expect(await workspaceStub().persistCompletedInterview(input)).toEqual({ status: 'link-inactive' });

    await workspaceStub().replaceStudyConfig({ studyId: study.id, expectedRevision: 1, config: study.config, now: T0 });
    expect(await workspaceStub().persistCompletedInterview(input)).toEqual({ status: 'revision-stale' });

    expect(await writesFor(input.interview.id)).toEqual({ interviews: 1, analysis: 1, jobs: 1, members: 0 });
  });

  it('ST-03: a revoke issued once the save has read its link is applied only after the save commits', async () => {
    const study = await createStudy();
    const participant = await enrolParticipant(study);
    const input = await persistInput(participant);
    let revoke: Promise<LinkRevokeOutcome> | undefined;
    let revokedBeforeCommit: unknown = 'unobserved';

    // The revoke is issued the moment the save reads the link row. The link is
    // read again just before commit (when the save reads the alarm): an
    // implementation with any gap between its authority check and its writes
    // would observe the revoke there (verified against such a variant).
    const outcome = await runInDurableObject(workspaceStub(), async (_instance, state) => {
      let fired = false;
      const sqlProxy = new Proxy(state.storage.sql, {
        get(target, property) {
          if (property === 'exec') {
            return (query: string, ...bindings: SqlStorageValue[]) => {
              if (!fired && query.includes('FROM participant_links')) {
                fired = true;
                revoke = workspaceStub().revokeParticipantLink({ studyId: study.id, linkId: participant.linkId, now: T0 });
              }
              return target.exec(query, ...bindings);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const storage = new Proxy(state.storage, {
        get(target, property) {
          if (property === 'getAlarm') {
            return async () => {
              revokedBeforeCommit = target.sql
                .exec<{ revoked_at: number | null }>(`SELECT revoked_at FROM participant_links WHERE id = ?`, participant.linkId)
                .one().revoked_at;
              return target.getAlarm();
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const ws: WorkspaceContext = { sql: sqlProxy, storage, env: testEnv, objectName: state.id.name };
      return persistCompletedInterview(ws, input);
    });

    expect(revoke).toBeDefined();
    expect(outcome).toEqual({ status: 'created' });
    expect(revokedBeforeCommit).toBeNull();
    expect(await revoke).toEqual({ status: 'revoked', revokedAt: T0 });
    expect(await writesFor(input.interview.id)).toEqual({ interviews: 1, analysis: 1, jobs: 1, members: 0 });
    // Once the revoke has committed, a replay of the same save is refused.
    expect(await workspaceStub().persistCompletedInterview(input)).toEqual({ status: 'link-inactive' });
  });

  it('ST-03: the record must carry the verified session id, link and consent evidence it is written under', async () => {
    const study = await createStudy();
    const owner = await enrolParticipant(study);
    const other = await enrolParticipant(study);
    const events = captureStoreEvents();

    // Session A's valid authority cannot write session B's interview id.
    const foreignId = await persistInput(owner, { interview: interviewRecord(other, { participantLinkId: owner.linkId }) });
    expect(await workspaceStub().persistCompletedInterview(foreignId)).toEqual({ status: 'conflict' });

    const wrongLink = await persistInput(owner, { interview: interviewRecord(owner, { participantLinkId: other.linkId }) });
    expect(await workspaceStub().persistCompletedInterview(wrongLink)).toEqual({ status: 'conflict' });

    const wrongHash = await persistInput(owner, { interview: interviewRecord(owner, { consentHash: randomHex64() }) });
    expect(await workspaceStub().persistCompletedInterview(wrongHash)).toEqual({ status: 'conflict' });

    const wrongTime = await persistInput(owner, {
      interview: interviewRecord(owner, { consentAcceptedAt: owner.consentAcceptedAt + 1 }),
    });
    expect(await workspaceStub().persistCompletedInterview(wrongTime)).toEqual({ status: 'conflict' });

    const { consentHash: _hash, consentAcceptedAt: _at, ...withoutEvidence } = interviewRecord(owner);
    void _hash; void _at;
    expect(await workspaceStub().persistCompletedInterview(await persistInput(owner, { interview: withoutEvidence })))
      .toEqual({ status: 'conflict' });

    expect(await count('interviews')).toBe(0);
    expect(events()).toHaveLength(5);
    expect(events().every((event) => event.reason === 'invalid')).toBe(true);

    // Each session's own save is unaffected by the refused attempts.
    expect(await workspaceStub().persistCompletedInterview(await persistInput(other))).toEqual({ status: 'created' });
    expect(await workspaceStub().persistCompletedInterview(await persistInput(owner))).toEqual({ status: 'created' });
  });

  it('ST-07: a fenced interview id is never recreated', async () => {
    const study = await createStudy();
    const participant = await enrolParticipant(study);
    const input = await persistInput(participant);
    await sql(
      `INSERT INTO deletion_fences (kind, target_id, deleted_at, expires_at) VALUES ('interview', ?, ?, ?)`,
      input.interview.id,
      T0 - HOUR,
      T0 + 30 * DAY,
    );
    expect(await workspaceStub().persistCompletedInterview(input)).toEqual({ status: 'conflict' });
    expect(await writesFor(input.interview.id)).toEqual(NONE);
  });
});

describe('maintenance and epoch holds (OPS-01)', () => {
  it('OPS-01: draining still accepts an existing session save; frozen and epoch mismatch hold it', async () => {
    const study = await createStudy();
    const draining = await enrolParticipant(study);
    const frozen = await enrolParticipant(study);
    const mismatched = await enrolParticipant(study);

    await setMaintenance('draining');
    expect((await workspaceStub().persistCompletedInterview(await persistInput(draining))).status).toBe('created');

    await setMaintenance('frozen');
    expect(await workspaceStub().persistCompletedInterview(await persistInput(frozen)))
      .toEqual({ status: 'held', reason: 'maintenance' });

    await setMaintenance('open');
    await sql(`UPDATE workspace_meta SET activated_epoch = ?`, 'ep_ffffffffffffffffffffffffffffffff');
    expect(await workspaceStub().persistCompletedInterview(await persistInput(mismatched)))
      .toEqual({ status: 'held', reason: 'recovery-epoch-mismatch' });
    expect(await count('interviews')).toBe(1);
  });
});

describe('transaction and wake-up durability (ST-04, JOB-05)', () => {
  it('ST-04/JOB-05: a failed generation allocation rolls back every completion write and arms no alarm', async () => {
    const study = await createStudy();
    const participant = await enrolParticipant(study);
    const reused = crypto.randomUUID();
    // A terminal job elsewhere already owns this job id, so the allocation INSERT fails.
    await sql(
      `INSERT INTO analysis_jobs (job_id, interview_id, generation, recovery_epoch, state, input_json,
         requested_provider, requested_model, allocated_at, updated_at, dispatch_state, terminal_at)
       VALUES (?, 'session-unrelated-synthetic', 1, ?, 'complete', '{}', 'openai', 'gpt-5.6-terra', ?, ?, 'none', ?)`,
      reused,
      testEnv.ANALYSIS_RECOVERY_EPOCH,
      T0 - DAY,
      T0 - DAY,
      T0 - DAY,
    );
    const seq = await mutationSeq();
    const input = await persistInput(participant, { ratePlan: [planRow(3)], jobId: reused });

    expect(await workspaceStub().persistCompletedInterview(input)).toEqual({ status: 'unavailable' });

    expect(await writesFor(input.interview.id)).toEqual(NONE);
    expect(await currentStudy(study.id)).toMatchObject({ interviewCount: 0, isLocked: false });
    expect(await mutationSeq()).toBe(seq);
    expect(await alarmAt()).toBeNull();

    // The same submission then commits normally with a fresh job id.
    expect((await workspaceStub().persistCompletedInterview({ ...input, initialJobId: crypto.randomUUID() })).status)
      .toBe('created');
  });

  it('ST-04/JOB-05: a failure while registering the alarm rolls back the SQL already written', async () => {
    const study = await createStudy();
    const participant = await enrolParticipant(study);
    const input = await persistInput(participant, { ratePlan: [planRow(3)] });

    const outcome = await runInDurableObject(workspaceStub(), async (_instance, state) => {
      const storage = new Proxy(state.storage, {
        get(target, property) {
          if (property === 'setAlarm') {
            return async () => {
              throw new Error('injected alarm registration failure');
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const ws: WorkspaceContext = { sql: state.storage.sql, storage, env: testEnv, objectName: state.id.name };
      return persistCompletedInterview(ws, input);
    });

    expect(outcome).toEqual({ status: 'unavailable' });
    expect(await writesFor(input.interview.id)).toEqual(NONE);
    expect(await currentStudy(study.id)).toMatchObject({ interviewCount: 0, isLocked: false });
    expect(await alarmAt()).toBeNull();
  });

  it('ST-04/JOB-05: an object restart preserves the committed completion, its job and its wake-up', async () => {
    const study = await createStudy();
    const participant = await enrolParticipant(study);
    const input = await persistInput(participant);
    expect((await workspaceStub().persistCompletedInterview(input)).status).toBe('created');

    await evictDurableObject(workspaceStub());

    expect(await alarmAt()).toBe(T0);
    expect(await sql(`SELECT job_id, state, next_due_at FROM analysis_jobs`))
      .toEqual([{ job_id: input.initialJobId, state: 'pending', next_due_at: T0 }]);
    expect((await workspaceStub().getInterview({ interviewId: input.interview.id })).status).toBe('found');
    // A replay after the restart still recognizes the committed submission.
    expect(await workspaceStub().persistCompletedInterview({ ...input, initialJobId: crypto.randomUUID() }))
      .toEqual({ status: 'duplicate' });
  });

  it('JOB-05: an earlier existing alarm is kept and a later one is pulled forward', async () => {
    const study = await createStudy();
    const first = await enrolParticipant(study);
    const second = await enrolParticipant(study);
    await runInDurableObject(workspaceStub(), (_instance, state) => state.storage.setAlarm(T0 - HOUR));

    expect((await workspaceStub().persistCompletedInterview(await persistInput(first))).status).toBe('created');
    expect(await alarmAt()).toBe(T0 - HOUR);

    await runInDurableObject(workspaceStub(), (_instance, state) => state.storage.setAlarm(T0 + HOUR));
    expect((await workspaceStub().persistCompletedInterview(await persistInput(second))).status).toBe('created');
    expect(await alarmAt()).toBe(T0);
  });
});

describe('frozen inputs and integrity (JOB-02, ST-05)', () => {
  it('JOB-02: the initial job keeps save-time configuration after a study edit', async () => {
    const study = await createStudy();
    const participant = await enrolParticipant(study);
    const input = await persistInput(participant);
    expect((await workspaceStub().persistCompletedInterview(input)).status).toBe('created');

    const edited = await workspaceStub().replaceStudyConfig({
      studyId: study.id,
      expectedRevision: 1,
      config: { ...study.config, aiProvider: 'claude', aiModel: 'claude-sonnet-5' },
      now: T0 + 1,
    });
    expect(edited.status).toBe('updated');
    expect(await sql(`SELECT input_json, requested_provider, requested_model FROM analysis_jobs`)).toEqual([{
      input_json: JSON.stringify(frozenInput(study)),
      requested_provider: 'openai',
      requested_model: 'gpt-5.6-terra',
    }]);
  });

  it('JOB-02: the durable backend requires frozen inputs bound to the expected revision', async () => {
    const study = await createStudy();
    const participant = await enrolParticipant(study);
    const input = await persistInput(participant);

    const { initialAnalysis: _omitted, ...withoutFrozen } = input;
    void _omitted;
    expect(await workspaceStub().persistCompletedInterview(withoutFrozen as typeof input)).toEqual({ status: 'unavailable' });
    expect(await workspaceStub().persistCompletedInterview({
      ...input,
      initialAnalysis: { ...frozenInput(study), studyRevision: 2 },
    })).toEqual({ status: 'unavailable' });
    expect(await workspaceStub().persistCompletedInterview({
      ...input,
      initialAnalysis: { ...frozenInput(study), requestedModel: '' },
    })).toEqual({ status: 'unavailable' });
    expect(await count('interviews')).toBe(0);
  });

  it('JOB-02: the initial job freezes the stored configuration of the verified revision, never a differing caller copy', async () => {
    const study = await createStudy();
    const participant = await enrolParticipant(study);
    const events = captureStoreEvents();
    const refusals = [
      { ...frozenInput(study), studyConfig: { ...study.config, researchQuestion: 'A question never stored' } },
      { ...frozenInput(study), requestedProvider: 'claude' as const },
      { ...frozenInput(study), requestedModel: 'some-other-model' },
      {
        ...frozenInput(study),
        studyConfig: { ...study.config, aiProvider: 'claude' as const, aiModel: 'some-other-model' },
        requestedProvider: 'claude' as const,
        requestedModel: 'some-other-model',
      },
    ];
    for (const initialAnalysis of refusals) {
      const input = { ...(await persistInput(participant)), initialAnalysis };
      expect(await workspaceStub().persistCompletedInterview(input)).toEqual({ status: 'unavailable' });
    }
    expect(await count('interviews')).toBe(0);
    expect(await count('analysis_jobs')).toBe(0);
    expect(events()).toHaveLength(refusals.length);
    expect(events().every((event) => event.reason === 'invalid')).toBe(true);

    // Key order and extra members of the caller's copy never reach the frozen row.
    const reordered = Object.fromEntries(Object.entries(study.config).reverse()) as typeof study.config;
    const input = await persistInput(participant);
    const accepted = { ...input, initialAnalysis: { ...frozenInput(study), studyConfig: reordered, injected: 'dropped' } };
    expect(await workspaceStub().persistCompletedInterview(accepted)).toEqual({ status: 'created' });
    expect(await sql(`SELECT input_json FROM analysis_jobs`)).toEqual([{ input_json: JSON.stringify(frozenInput(study)) }]);
  });

  it('the record\'s provider commitment must be the stored configuration\'s, naming that revision\'s provider and model', async () => {
    const study = await createStudy({ aiProviderCommitment: 'fixed' });
    const participant = await enrolParticipant(study);
    const events = captureStoreEvents();
    const refusals: Array<Partial<StoredInterview>> = [
      {},
      { providerCommitment: 'may-change' },
      { providerCommitment: 'fixed', conductedByModel: 'some-other-model' },
      { providerCommitment: 'fixed', conductedByProvider: 'claude' },
      { providerCommitment: 'sometimes' as never },
    ];
    for (const overrides of refusals) {
      const record = interviewRecord(participant, overrides);
      if (!('providerCommitment' in overrides)) delete (record as Partial<StoredInterview>).providerCommitment;
      expect(await workspaceStub().persistCompletedInterview(await persistInput(participant, { interview: record })))
        .toEqual({ status: 'unavailable' });
    }
    expect(await count('interviews')).toBe(0);
    expect(events().length).toBe(refusals.length - 1);

    const kept = interviewRecord(participant, { providerCommitment: 'fixed' });
    expect(await workspaceStub().persistCompletedInterview(await persistInput(participant, { interview: kept })))
      .toEqual({ status: 'created' });
  });

  it('a study without a provider commitment refuses a record that claims one', async () => {
    const study = await createStudy();
    const participant = await enrolParticipant(study);
    const record = interviewRecord(participant, { providerCommitment: 'fixed' });
    expect(await workspaceStub().persistCompletedInterview(await persistInput(participant, { interview: record })))
      .toEqual({ status: 'unavailable' });
    expect(await workspaceStub().persistCompletedInterview(await persistInput(participant)))
      .toEqual({ status: 'created' });
  });

  it('JOB-02: a study without an explicit provider accepts the caller-resolved installation provider', async () => {
    const study = await createStudy({ aiProvider: undefined });
    const participant = await enrolParticipant(study);
    const input = await persistInput(participant);
    const resolved = { ...input, initialAnalysis: { ...frozenInput(study), requestedProvider: 'gemini' as const } };
    expect(await workspaceStub().persistCompletedInterview(resolved)).toEqual({ status: 'created' });
    expect(await sql(`SELECT requested_provider, requested_model FROM analysis_jobs`))
      .toEqual([{ requested_provider: 'gemini', requested_model: 'gpt-5.6-terra' }]);
  });

  it('ST-05: a lost-response replay of an imported generation-0 or analysis-less record is a duplicate, never corrupt', async () => {
    const study = await createStudy();
    for (const analysis of ['complete', 'pending', 'failed', 'none'] as const) {
      const participant = await enrolParticipant(study);
      const input = await persistInput(participant);
      // A Node-era save that committed before cutover and was imported (F7 mapping).
      await sql(
        `INSERT INTO interviews (id, study_id, record_json, fingerprint, created_at, completed_at,
           participant_session_id, link_id, sample_fixture, study_revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1)`,
        input.interview.id, study.id, JSON.stringify(input.interview), input.fingerprint,
        input.interview.createdAt, input.interview.completedAt, participant.sessionId, participant.linkId,
      );
      if (analysis !== 'none') {
        await sql(
          `INSERT INTO analysis (interview_id, status, current_generation, attempts, last_attempt_at, failure_kind,
             recovery_required, study_revision, synthesis_json, provenance_json, updated_at)
           VALUES (?, ?, 0, 1, ?, ?, 0, ?, ?, ?, ?)`,
          input.interview.id, analysis, T0,
          analysis === 'failed' ? 'provider' : null,
          analysis === 'complete' ? 1 : null,
          analysis === 'complete' ? JSON.stringify({ statedPreferences: [], revealedPreferences: [], themes: [], contradictions: [], keyInsights: [], bottomLine: 'Synthetic.' }) : null,
          analysis === 'complete' ? JSON.stringify({ aiProvider: 'openai', aiModel: 'gpt-5.6-terra', requestedAiModel: 'gpt-5.6-terra' }) : null,
          T0,
        );
      }
      const events = captureStoreEvents();
      expect(await workspaceStub().persistCompletedInterview(input)).toEqual({ status: 'duplicate' });
      expect(events()).toEqual([]);
      vi.restoreAllMocks();
    }
    expect(await count('analysis_jobs')).toBe(0);
    expect(await count('interviews')).toBe(4);
  });

  it('ST-05: a duplicate replay over a broken initial-job invariant is refused and nothing is rewritten', async () => {
    const study = await createStudy();
    const participant = await enrolParticipant(study);
    const input = await persistInput(participant);
    expect((await workspaceStub().persistCompletedInterview(input)).status).toBe('created');
    await sql(`DELETE FROM analysis_jobs`);
    const before = await sql(`SELECT * FROM interviews`);
    const analysisBefore = await sql(`SELECT * FROM analysis`);

    const events = captureStoreEvents();
    expect(await workspaceStub().persistCompletedInterview({ ...input, initialJobId: crypto.randomUUID() }))
      .toEqual({ status: 'unavailable' });
    expect(events()).toEqual([expect.objectContaining({ reason: 'corrupt-record', operation: 'persistCompletedInterview' })]);

    expect(await sql(`SELECT * FROM interviews`)).toEqual(before);
    expect(await sql(`SELECT * FROM analysis`)).toEqual(analysisBefore);
    expect(await count('analysis_jobs')).toBe(0);
  });
});

describe('record round trip and limits (ST-08)', () => {
  it('ST-08: Unicode, empty shapes, optional legacy fields and absent provenance round-trip byte-for-byte', async () => {
    const study = await createStudy();
    const participant = await enrolParticipant(study);
    const unicode = 'Grüße — 你好 — مرحبا — é — 🧪🏳️‍🌈 — "quoted" \\ back\\slash — line separator';
    const base = interviewRecord(participant);
    const { conductedByProvider: _p, conductedByModel: _m, participantLinkId: _l, ...legacyShape } = base;
    void _p; void _m; void _l;
    const interview = {
      ...legacyShape,
      studyName: unicode,
      participantProfile: { id: base.id, fields: [], rawContext: '', timestamp: T0 - HOUR },
      transcript: [
        { id: 'm1', role: 'ai' as const, content: unicode, timestamp: T0 - HOUR },
        { id: 'm2', role: 'user' as const, content: '', timestamp: T0 - HOUR + 1 },
      ],
      behaviorData: { timePerTopic: {}, messagesPerTopic: { [unicode]: 0 }, topicsExplored: [], contradictions: [] },
    };
    const input = await persistInput(participant, { interview });
    expect((await workspaceStub().persistCompletedInterview(input)).status).toBe('created');

    const [row] = await sql<{ record_json: string }>(`SELECT record_json FROM interviews WHERE id = ?`, interview.id);
    expect(row.record_json).toBe(JSON.stringify(interview));

    const expected = {
      ...interview,
      synthesis: null,
      analysis: { status: 'pending', attempts: 0, lastAttemptAt: T0, generation: 1 },
    };
    const single = await workspaceStub().getInterview({ interviewId: interview.id });
    expect(single).toStrictEqual({ status: 'found', interview: expected });
    if (single.status !== 'found') throw new Error('unreachable');
    expect(Array.isArray(single.interview.behaviorData.topicsExplored)).toBe(true);
    expect(Array.isArray(single.interview.behaviorData.timePerTopic)).toBe(false);
    expect('aiProvider' in single.interview || 'aiModel' in single.interview || 'requestedAiModel' in single.interview).toBe(false);
    expect('conductedByProvider' in single.interview).toBe(false);

    const listed = await workspaceStub().listInterviews({ scope: 'study', studyId: study.id, maximum: 10 });
    expect(listed).toStrictEqual({ status: 'ok', items: [expected] });
  });

  it('ST-08: the maximum valid submission (about 512,000 bytes) persists and reads back intact', async () => {
    const study = await createStudy();
    const participant = await enrolParticipant(study);
    const transcript: ReturnType<typeof interviewRecord>['transcript'] = [];
    const encoder = new TextEncoder();
    const chunk = 'synthétique ✓ '.repeat(400).slice(0, 5_000);
    let index = 0;
    while (encoder.encode(JSON.stringify(transcript)).byteLength < 505_000) {
      transcript.push({ id: `m${index}`, role: index % 2 ? 'user' : 'ai', content: chunk, timestamp: T0 - HOUR + index });
      index += 1;
    }
    const interview = interviewRecord(participant, { transcript });
    const recordBytes = encoder.encode(JSON.stringify(interview)).byteLength;
    expect(recordBytes).toBeGreaterThan(505_000);
    expect(recordBytes).toBeLessThan(520_000);

    const input = await persistInput(participant, { interview });
    expect((await workspaceStub().persistCompletedInterview(input)).status).toBe('created');
    const read = await workspaceStub().getInterview({ interviewId: interview.id });
    if (read.status !== 'found') throw new Error(`read ${read.status}`);
    expect(read.interview.transcript).toStrictEqual(transcript);
    const [row] = await sql<{ bytes: number }>(
      `SELECT LENGTH(CAST(record_json AS BLOB)) AS bytes FROM interviews WHERE id = ?`,
      interview.id,
    );
    expect(row.bytes).toBe(recordBytes);
  });

  it('ST-08: a record above the measured row ceiling is refused before any write', async () => {
    const study = await createStudy();
    const participant = await enrolParticipant(study);
    const oversized = interviewRecord(participant, {
      transcript: Array.from({ length: 400 }, (_, index) => ({
        id: `m${index}`,
        role: 'user' as const,
        content: 'x'.repeat(5_000),
        timestamp: T0 - HOUR,
      })),
    });
    expect(await workspaceStub().persistCompletedInterview(await persistInput(participant, { interview: oversized })))
      .toEqual({ status: 'unavailable' });
    expect(await count('interviews')).toBe(0);
  });
});
