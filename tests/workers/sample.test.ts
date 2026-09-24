import { beforeEach, describe, expect, it } from 'vitest';
import { reset } from 'cloudflare:test';
import { DEMO_INTERVIEWS, DEMO_STUDIES } from '../../src/lib/demoData';
import { testEnv, workspaceStub } from './helpers';
import {
  alarmAt,
  count,
  createStudy,
  DAY,
  enrolParticipant,
  mutationSeq,
  persistInput,
  sampleInterview,
  sampleStudy,
  setMaintenance,
  sql,
  T0,
} from './fixtures';

beforeEach(async () => {
  await reset();
});

const STUDY_ID = 'demo-study-synthetic';

function fixtures() {
  const study = sampleStudy(STUDY_ID);
  const interviews = [
    sampleInterview(STUDY_ID, 'interview-demo-one', T0 - 3 * DAY),
    sampleInterview(STUDY_ID, 'interview-demo-two', T0 - 2 * DAY),
  ];
  return { studies: [study], interviews, now: T0 };
}

const CLEAR = { studyIds: [STUDY_ID], interviewIds: ['interview-demo-one', 'interview-demo-two'], now: T0 + DAY };

describe('seedSampleWorkspace (ST-07)', () => {
  it('ST-07: seeds the fixture set atomically as legacy analysis-less records with no job or wake-up', async () => {
    const input = fixtures();
    const seq = await mutationSeq();
    expect(await workspaceStub().seedSampleWorkspace(input)).toEqual({ status: 'seeded', studiesSeeded: 1, interviewsSeeded: 2 });

    expect(await workspaceStub().getStudy({ studyId: STUDY_ID })).toEqual({ status: 'found', study: input.studies[0] });
    for (const interview of input.interviews) {
      expect(await workspaceStub().getInterview({ interviewId: interview.id })).toStrictEqual({ status: 'found', interview });
    }
    expect(await sql(`SELECT id, sample_fixture, study_revision FROM interviews ORDER BY id`)).toEqual([
      { id: 'interview-demo-one', sample_fixture: 1, study_revision: 1 },
      { id: 'interview-demo-two', sample_fixture: 1, study_revision: 1 },
    ]);
    expect(await count('studies', 'sample_fixture = 1')).toBe(1);
    expect(await count('analysis')).toBe(0);
    expect(await count('analysis_jobs')).toBe(0);
    expect(await alarmAt()).toBeNull();
    expect(await mutationSeq()).toBe(seq + 1);

    const eligible = await workspaceStub().readAggregateInputs({
      studyId: STUDY_ID, studyRevision: 1, cursor: null, pageSize: 10, maxPageBytes: 1_000_000,
    });
    expect(eligible.status === 'ok' && eligible.totalEligible).toBe(2);
  });

  it('ST-07: the shipped fixture set seeds, lists as legacy analyzed records and clears completely', async () => {
    const studies = structuredClone(DEMO_STUDIES);
    const interviews = structuredClone(DEMO_INTERVIEWS);
    expect(await workspaceStub().seedSampleWorkspace({ studies, interviews, now: T0 }))
      .toEqual({ status: 'seeded', studiesSeeded: studies.length, interviewsSeeded: interviews.length });
    const listed = await workspaceStub().listInterviews({ scope: 'study', studyId: studies[0].id, maximum: 1_000 });
    if (listed.status !== 'ok') throw new Error(listed.status);
    expect(listed.items).toHaveLength(interviews.length);
    expect(listed.items.every((item) => item.synthesis !== null && item.analysis === undefined)).toBe(true);

    expect(await workspaceStub().clearSampleWorkspace({
      studyIds: studies.map((study) => study.id),
      interviewIds: interviews.map((interview) => interview.id),
      now: T0,
    })).toEqual({ status: 'cleared', studiesDeleted: studies.length, interviewsDeleted: interviews.length });
    expect(await count('studies')).toBe(0);
    expect(await count('interviews')).toBe(0);
  });

  it('ST-07: seeding refuses any collision and writes nothing when it refuses', async () => {
    const input = fixtures();
    await workspaceStub().seedSampleWorkspace(input);
    expect(await workspaceStub().seedSampleWorkspace(input)).toEqual({ status: 'already-seeded' });
    await reset();

    await sql(
      `INSERT INTO interviews (id, study_id, record_json, fingerprint, created_at, completed_at, sample_fixture)
       VALUES ('interview-demo-two', 'real-study', '{}', 'fp', 1, 1, 0)`,
    );
    expect(await workspaceStub().seedSampleWorkspace(input)).toEqual({ status: 'already-seeded' });
    expect(await count('studies')).toBe(0);
    await reset();

    await sql(
      `INSERT INTO deletion_fences (kind, target_id, deleted_at, expires_at, sample_fixture) VALUES ('study', ?, ?, ?, 0)`,
      STUDY_ID,
      T0 - DAY,
      T0 + DAY,
    );
    expect(await workspaceStub().seedSampleWorkspace(input)).toEqual({ status: 'already-seeded' });
    expect(await count('studies')).toBe(0);
  });

  it('ST-07: fixtures carrying analysis state are refused (they must stay legacy records)', async () => {
    const input = fixtures();
    input.interviews[0] = { ...input.interviews[0], analysis: { status: 'complete', attempts: 1, lastAttemptAt: T0 } };
    expect(await workspaceStub().seedSampleWorkspace(input)).toEqual({ status: 'unavailable' });
    expect(await count('interviews')).toBe(0);
  });

  it('OPS-01: seeding and clearing are researcher mutations held outside open', async () => {
    await setMaintenance('draining');
    expect(await workspaceStub().seedSampleWorkspace(fixtures())).toEqual({ status: 'held', reason: 'maintenance' });
    expect(await workspaceStub().clearSampleWorkspace(CLEAR)).toEqual({ status: 'held', reason: 'maintenance' });
  });
});

describe('clearSampleWorkspace (ST-07, JOB-10)', () => {
  it('ST-07/JOB-10: clearing cascades the fixture study and interviews, cancels their jobs, fences them and allows a re-seed', async () => {
    const input = fixtures();
    await workspaceStub().seedSampleWorkspace(input);
    await enrolParticipant(input.studies[0]);
    expect(await workspaceStub().saveAggregate({
      aggregate: {
        studyId: STUDY_ID, studyRevision: 1, interviewIds: ['interview-demo-one', 'interview-demo-two'], interviewCount: 2,
        aiProvider: 'openai', aiModel: 'gpt-5.6-terra', commonThemes: [], divergentViews: [], keyFindings: [],
        researchImplications: [], bottomLine: 'Synthetic.', generatedAt: T0, savedAt: T0,
      },
      now: T0,
    })).toBe('saved');
    const jobId = crypto.randomUUID();
    await sql(
      `INSERT INTO analysis_jobs (job_id, interview_id, generation, recovery_epoch, state, input_json,
         requested_provider, requested_model, allocated_at, updated_at, dispatch_state, next_due_at)
       VALUES (?, 'interview-demo-one', 1, ?, 'pending', '{}', 'openai', 'gpt-5.6-terra', ?, ?, 'unsent', ?)`,
      jobId,
      testEnv.ANALYSIS_RECOVERY_EPOCH,
      T0,
      T0,
      T0,
    );
    const seq = await mutationSeq();

    expect(await workspaceStub().clearSampleWorkspace(CLEAR)).toEqual({ status: 'cleared', studiesDeleted: 1, interviewsDeleted: 2 });

    expect(await count('studies')).toBe(0);
    expect(await count('interviews')).toBe(0);
    expect(await count('aggregates')).toBe(0);
    expect(await count('participant_links')).toBe(0);
    expect(await count('consents')).toBe(0);
    expect(await sql(`SELECT state, next_due_at, terminal_at FROM analysis_jobs WHERE job_id = ?`, jobId))
      .toEqual([{ state: 'cancelled', next_due_at: null, terminal_at: T0 + DAY }]);
    expect(await sql(`SELECT kind, target_id, sample_fixture FROM deletion_fences ORDER BY kind, target_id`)).toEqual([
      { kind: 'interview', target_id: 'interview-demo-one', sample_fixture: 1 },
      { kind: 'interview', target_id: 'interview-demo-two', sample_fixture: 1 },
      { kind: 'study', target_id: STUDY_ID, sample_fixture: 1 },
    ]);
    expect(await mutationSeq()).toBe(seq + 1);

    // Only the fixture seed may recreate the fixed ids its own clear fenced.
    expect((await workspaceStub().seedSampleWorkspace(fixtures())).status).toBe('seeded');
    expect(await count('deletion_fences')).toBe(0);
    expect(await workspaceStub().getAggregate({ studyId: STUDY_ID })).toEqual({ status: 'not-found' });
  });

  it('ST-07: clear never touches a real study or a real interview even when their ids are passed', async () => {
    const study = await createStudy();
    const participant = await enrolParticipant(study);
    const input = await persistInput(participant);
    expect((await workspaceStub().persistCompletedInterview(input)).status).toBe('created');
    const before = {
      studies: await sql(`SELECT * FROM studies`),
      interviews: await sql(`SELECT * FROM interviews`),
      jobs: await sql(`SELECT * FROM analysis_jobs`),
      links: await sql(`SELECT * FROM participant_links`),
    };

    expect(await workspaceStub().clearSampleWorkspace({ studyIds: [study.id], interviewIds: [input.interview.id], now: T0 }))
      .toEqual({ status: 'cleared', studiesDeleted: 0, interviewsDeleted: 0 });
    expect({
      studies: await sql(`SELECT * FROM studies`),
      interviews: await sql(`SELECT * FROM interviews`),
      jobs: await sql(`SELECT * FROM analysis_jobs`),
      links: await sql(`SELECT * FROM participant_links`),
    }).toEqual(before);
    expect(await count('deletion_fences')).toBe(0);
  });

  it('ST-07: a fixture study holding a participant interview refuses the whole clear', async () => {
    const input = fixtures();
    await workspaceStub().seedSampleWorkspace(input);
    const participant = await enrolParticipant(input.studies[0]);
    expect((await workspaceStub().persistCompletedInterview(await persistInput(participant))).status).toBe('created');
    const before = await sql(`SELECT id FROM interviews ORDER BY id`);

    expect(await workspaceStub().clearSampleWorkspace(CLEAR)).toEqual({ status: 'has-participant-data' });
    expect(await sql(`SELECT id FROM interviews ORDER BY id`)).toEqual(before);
    expect(await count('studies', 'id = ?', STUDY_ID)).toBe(1);
    expect(await count('deletion_fences')).toBe(0);
  });

  it('ST-07: a delayed save into a cleared fixture study cannot resurrect it, even after a re-seed', async () => {
    const input = fixtures();
    await workspaceStub().seedSampleWorkspace(input);
    const participant = await enrolParticipant(input.studies[0]);
    const save = await persistInput(participant);

    expect((await workspaceStub().clearSampleWorkspace(CLEAR)).status).toBe('cleared');
    expect(await workspaceStub().persistCompletedInterview(save)).toEqual({ status: 'study-not-found' });

    await workspaceStub().seedSampleWorkspace(fixtures());
    expect(await workspaceStub().persistCompletedInterview(save)).toEqual({ status: 'link-inactive' });
    expect(await count('interviews', 'sample_fixture = 0')).toBe(0);
  });
});
