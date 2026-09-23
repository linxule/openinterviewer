// Authenticated sample-workspace seed/clear (ST-07): fixture-scoped and
// atomic. Seeding writes only the provided synthetic fixtures (never calls a
// model); clearing touches only rows flagged sample_fixture = 1 among the ids
// given, so it can never delete a real study or participant interview.

import type * as Port from '../../src/lib/storage/types';
import type { StoredInterview, StoredStudy } from '../../src/types';
import { bumpMutationSeq, gate, type WorkspaceContext } from './context';
import { sha256Hex } from './participants';
import {
  INTERVIEW_ID,
  isFenced,
  isPlainObject,
  isRevision,
  isSafeTime,
  logStorageFailure,
  MAX_ROW_BYTES,
  readStudyRow,
  STUDY_ID,
  utf8Bytes,
  writeFence,
} from './studies';

const MAX_FIXTURE_STUDIES = 10;
const MAX_FIXTURE_INTERVIEWS = 50;

function isFixtureStudy(study: unknown): study is StoredStudy {
  return isPlainObject(study)
    && typeof study.id === 'string'
    && STUDY_ID.test(study.id)
    && isPlainObject(study.config)
    && study.config.id === study.id
    && isRevision(study.revision)
    && isSafeTime(study.createdAt)
    && isSafeTime(study.updatedAt)
    && typeof study.interviewCount === 'number'
    && Number.isSafeInteger(study.interviewCount)
    && study.interviewCount >= 0
    && typeof study.isLocked === 'boolean';
}

/** Fixtures are legacy analysis-less records: a synthesis, no analysis state. */
function isFixtureInterview(interview: unknown, studyIds: Set<string>): interview is StoredInterview {
  return isPlainObject(interview)
    && typeof interview.id === 'string'
    && INTERVIEW_ID.test(interview.id)
    && typeof interview.studyId === 'string'
    && studyIds.has(interview.studyId)
    && interview.status === 'completed'
    && isSafeTime(interview.createdAt)
    && isSafeTime(interview.completedAt)
    && !('analysis' in interview)
    && (interview.studyRevision === undefined || isRevision(interview.studyRevision));
}

export async function seedSampleWorkspace(ws: WorkspaceContext, input: Port.SeedSampleInput): Promise<Port.SeedSampleOutcome> {
  try {
    if (
      !isPlainObject(input)
      || !Array.isArray(input.studies)
      || !Array.isArray(input.interviews)
      || input.studies.length === 0
      || input.studies.length > MAX_FIXTURE_STUDIES
      || input.interviews.length > MAX_FIXTURE_INTERVIEWS
      || !isSafeTime(input.now)
      || !input.studies.every(isFixtureStudy)
    ) {
      return { status: 'unavailable' };
    }
    const studyIds = new Set(input.studies.map((study) => study.id));
    const interviewIds = new Set(input.interviews.map((interview) => interview.id));
    if (studyIds.size !== input.studies.length || interviewIds.size !== input.interviews.length) {
      return { status: 'unavailable' };
    }
    if (!input.interviews.every((interview) => isFixtureInterview(interview, studyIds))) return { status: 'unavailable' };

    const studies = input.studies.map((study) => ({ study, configJson: JSON.stringify(study.config) }));
    const interviews: Array<{ interview: StoredInterview; recordJson: string; fingerprint: string }> = [];
    for (const interview of input.interviews) {
      const recordJson = JSON.stringify(interview);
      if (utf8Bytes(recordJson) + 1024 > MAX_ROW_BYTES) return { status: 'unavailable' };
      // Fixtures have no participant submission; the fingerprint column holds
      // the digest of the exact stored record.
      interviews.push({ interview, recordJson, fingerprint: await sha256Hex(recordJson) });
    }
    const now = input.now;

    return ws.storage.transactionSync((): Port.SeedSampleOutcome => {
      const checked = gate(ws, 'researcher-mutation');
      if (!checked.ok) return { status: 'held', reason: checked.reason };
      // Any loaded fixture study (including an older fixture set) means the
      // sample workspace is already present, like the Redis `demo-` check.
      const loaded = ws.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM studies WHERE sample_fixture = 1`)
        .one().n;
      if (loaded > 0) return { status: 'already-seeded' };
      for (const { study } of studies) {
        if (readStudyRow(ws, study.id)) return { status: 'already-seeded' };
        if (isFenced(ws, 'study', study.id, now, { ignoreSampleFences: true })) return { status: 'already-seeded' };
      }
      for (const { interview } of interviews) {
        const exists = ws.sql
          .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM interviews WHERE id = ?`, interview.id)
          .one().n;
        if (exists > 0) return { status: 'already-seeded' };
        if (isFenced(ws, 'interview', interview.id, now, { ignoreSampleFences: true })) return { status: 'already-seeded' };
      }

      for (const { study, configJson } of studies) {
        // The seed is the only writer allowed to recreate ids its own clear fenced.
        ws.sql.exec(`DELETE FROM deletion_fences WHERE kind = 'study' AND target_id = ? AND sample_fixture = 1`, study.id);
        ws.sql.exec(
          `INSERT INTO studies (id, config_json, revision, created_at, updated_at, interview_count, is_locked, sample_fixture)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
          study.id,
          configJson,
          study.revision,
          study.createdAt,
          study.updatedAt,
          study.interviewCount,
          study.isLocked ? 1 : 0,
        );
      }
      for (const { interview, recordJson, fingerprint } of interviews) {
        ws.sql.exec(
          `DELETE FROM deletion_fences WHERE kind = 'interview' AND target_id = ? AND sample_fixture = 1`,
          interview.id,
        );
        // No analysis row and no job: a legacy record whose status derives
        // from its synthesis.
        ws.sql.exec(
          `INSERT INTO interviews (id, study_id, record_json, fingerprint, created_at, completed_at,
             participant_session_id, link_id, sample_fixture, study_revision)
           VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?)`,
          interview.id,
          interview.studyId,
          recordJson,
          fingerprint,
          interview.createdAt,
          interview.completedAt,
          interview.studyRevision ?? null,
        );
      }
      bumpMutationSeq(ws.sql, now);
      return { status: 'seeded', studiesSeeded: studies.length, interviewsSeeded: interviews.length };
    });
  } catch (error) {
    logStorageFailure('seedSampleWorkspace', error);
    return { status: 'unavailable' };
  }
}

export async function clearSampleWorkspace(
  ws: WorkspaceContext,
  input: Port.ClearSampleInput & { now: number },
): Promise<Port.ClearSampleOutcome> {
  try {
    if (
      !isPlainObject(input)
      || !Array.isArray(input.studyIds)
      || !Array.isArray(input.interviewIds)
      || input.studyIds.length > MAX_FIXTURE_STUDIES
      || input.interviewIds.length > MAX_FIXTURE_INTERVIEWS
      || !input.studyIds.every((id) => typeof id === 'string' && STUDY_ID.test(id))
      || !input.interviewIds.every((id) => typeof id === 'string' && INTERVIEW_ID.test(id))
      || !isSafeTime(input.now)
    ) {
      return { status: 'unavailable' };
    }
    const now = input.now;
    const requestedInterviews = new Set(input.interviewIds);

    return ws.storage.transactionSync((): Port.ClearSampleOutcome => {
      const checked = gate(ws, 'researcher-mutation');
      if (!checked.ok) return { status: 'held', reason: checked.reason };

      const fixtureStudies = [...new Set(input.studyIds)].filter((id) => {
        const row = readStudyRow(ws, id);
        return row !== null && row.sample_fixture === 1;
      });
      const fixtureInterviews = [...requestedInterviews].filter((id) => {
        const rows = ws.sql
          .exec<{ sample_fixture: number }>(`SELECT sample_fixture FROM interviews WHERE id = ?`, id)
          .toArray();
        return rows.length === 1 && rows[0].sample_fixture === 1;
      });
      const deletable = new Set(fixtureInterviews);

      // A fixture study that holds anything other than the requested fixture
      // interviews (a participant's real interview) is refused whole.
      for (const studyId of fixtureStudies) {
        const members = ws.sql
          .exec<{ id: string }>(`SELECT id FROM interviews WHERE study_id = ?`, studyId)
          .toArray();
        if (members.some((member) => !deletable.has(member.id))) return { status: 'has-participant-data' };
      }

      const touchedStudies = new Set<string>();
      for (const interviewId of fixtureInterviews) {
        const owner = ws.sql
          .exec<{ study_id: string }>(`SELECT study_id FROM interviews WHERE id = ?`, interviewId)
          .one().study_id;
        touchedStudies.add(owner);
        ws.sql.exec(
          `UPDATE analysis_jobs
              SET state = 'cancelled', next_due_at = NULL, claim_nonce = NULL, claim_expires_at = NULL,
                  terminal_at = ?, updated_at = ?
            WHERE interview_id = ? AND state IN ('pending','claimed','started')`,
          now,
          now,
          interviewId,
        );
        ws.sql.exec(`DELETE FROM analysis WHERE interview_id = ?`, interviewId);
        ws.sql.exec(`DELETE FROM interviews WHERE id = ?`, interviewId);
        writeFence(ws, 'interview', interviewId, now, true);
      }
      for (const studyId of fixtureStudies) {
        touchedStudies.delete(studyId);
        ws.sql.exec(`DELETE FROM studies WHERE id = ?`, studyId);
        ws.sql.exec(`DELETE FROM aggregates WHERE study_id = ?`, studyId);
        ws.sql.exec(`DELETE FROM participant_links WHERE study_id = ?`, studyId);
        ws.sql.exec(`DELETE FROM consents WHERE study_id = ?`, studyId);
        writeFence(ws, 'study', studyId, now, true);
      }
      // A surviving study that lost fixture interviews keeps a derived count.
      for (const studyId of touchedStudies) {
        ws.sql.exec(
          `UPDATE studies SET interview_count = (SELECT COUNT(*) FROM interviews WHERE study_id = ?) WHERE id = ?`,
          studyId,
          studyId,
        );
      }
      if (fixtureStudies.length > 0 || fixtureInterviews.length > 0) bumpMutationSeq(ws.sql, now);
      return { status: 'cleared', studiesDeleted: fixtureStudies.length, interviewsDeleted: fixtureInterviews.length };
    });
  } catch (error) {
    logStorageFailure('clearSampleWorkspace', error);
    return { status: 'unavailable' };
  }
}
