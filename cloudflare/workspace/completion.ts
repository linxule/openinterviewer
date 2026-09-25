// Immutable completion (ST-02/03/04, JOB-01/02/05): the transcript, its
// analysis projection, the initial generation-1 job, save-admission
// membership, the study count/lock and the durable wake-up commit together in
// one storage.transaction, or not at all. Authority is re-checked at the write
// boundary before duplicate detection, so a replay after revoke, edit or
// delete is refused rather than confirmed.

import type * as Port from '../../src/lib/storage/types';
import { ANALYSIS_INPUT_SCHEMA_VERSION, type FrozenAnalysisInput } from '../../src/lib/storage/analysisProtocol';
import type { StoredInterview } from '../../src/types';
import type * as Rpc from './rpcTypes';
import {
  allocateGeneration,
  armAlarmNoLaterThan,
  bumpMutationSeq,
  gate,
  jobStateIsActive,
  type WorkspaceContext,
  type WorkspaceMeta,
} from './context';
import { consentMatches, readConsent, resolveLink, sha256Hex } from './participants';
import { logRequestEvent } from '../../src/lib/requestLog';
import { isProviderCommitment } from '../../src/lib/providerCommitment';
import {
  decodeStudyRow,
  INTERVIEW_ID,
  isFenced,
  isHex64,
  isPlainObject,
  isRevision,
  isSafeTime,
  logCorruptRecord,
  logStorageFailure,
  MAX_ROW_BYTES,
  readStudyRow,
  STUDY_ID,
  utf8Bytes,
} from './studies';

const MAX_PERSIST_RATE_PLAN = 4;
const RATE_PLAN_KEY = /^interview-rate:[a-f0-9]{64}:\d{1,16}$/;
const JOB_ID = /^[a-f0-9-]{36}$/;
const PROVIDERS = new Set(['gemini', 'claude', 'openai', 'openrouter']);
const MAX_MODEL_LENGTH = 200;
const MAX_WINDOW_SECONDS = 31 * 24 * 60 * 60;
/** Budget members outlive their fixed window by one minute, as on Redis. */
const MEMBER_GRACE_SECONDS = 60;

const ANALYSIS_STATUSES = new Set(['pending', 'running', 'complete', 'failed']);

type Outcome = Port.PersistCompletedInterviewOutcome;
type PlanRow = Port.PersistCompletedInterviewInput['ratePlan'][number];
/** Either a refusal, or the canonical frozen inputs the new completion commits with. */
type Decision = { refuse: Outcome } | { frozen: FrozenAnalysisInput };

type Prepared = {
  input: Rpc.PersistInput;
  interview: StoredInterview;
  frozen: FrozenAnalysisInput;
  recordJson: string;
  sessionDigest: string;
};

function isValidPlanRow(row: unknown): row is PlanRow {
  return isPlainObject(row)
    && typeof row.key === 'string'
    && RATE_PLAN_KEY.test(row.key)
    && typeof row.maximum === 'number'
    && Number.isSafeInteger(row.maximum)
    && row.maximum >= 0
    && typeof row.windowSeconds === 'number'
    && Number.isSafeInteger(row.windowSeconds)
    && row.windowSeconds > 0
    && row.windowSeconds <= MAX_WINDOW_SECONDS
    && isSafeTime(row.windowStart);
}

function isValidFrozen(frozen: unknown, studyId: string, revision: number): frozen is FrozenAnalysisInput {
  return isPlainObject(frozen)
    && frozen.inputSchemaVersion === ANALYSIS_INPUT_SCHEMA_VERSION
    && isPlainObject(frozen.studyConfig)
    && frozen.studyConfig.id === studyId
    && frozen.studyRevision === revision
    && typeof frozen.requestedProvider === 'string'
    && PROVIDERS.has(frozen.requestedProvider)
    && typeof frozen.requestedModel === 'string'
    && frozen.requestedModel.length > 0
    && frozen.requestedModel.length <= MAX_MODEL_LENGTH
    && (frozen.disclosedTransport === undefined || frozen.disclosedTransport === 'cloudflare-gateway');
}

/** Input validation and every await (digests) happen before the transaction. */
async function prepare(input: Rpc.PersistInput): Promise<Prepared | null> {
  if (!isPlainObject(input) || !isPlainObject(input.interview)) return null;
  const interview = input.interview;
  if (
    typeof interview.id !== 'string'
    || !INTERVIEW_ID.test(interview.id)
    || typeof interview.studyId !== 'string'
    || !STUDY_ID.test(interview.studyId)
    || interview.status !== 'completed'
    || !isSafeTime(interview.createdAt)
    || !isSafeTime(interview.completedAt)
    || (interview.studyRevision !== undefined && !isRevision(interview.studyRevision))
    || (interview.consentTransport !== undefined && interview.consentTransport !== 'cloudflare-gateway')
    || (interview.providerCommitment !== undefined && !isProviderCommitment(interview.providerCommitment))
  ) {
    return null;
  }
  if (
    !isHex64(input.fingerprint)
    || !isRevision(input.expectedStudyRevision)
    || typeof input.allowDisabledLinks !== 'boolean'
    || !isSafeTime(input.now)
    || typeof input.initialJobId !== 'string'
    || !JOB_ID.test(input.initialJobId)
    || !Array.isArray(input.ratePlan)
    || input.ratePlan.length > MAX_PERSIST_RATE_PLAN
    || !input.ratePlan.every(isValidPlanRow)
    || !isPlainObject(input.identity)
    || !isPlainObject(input.consent)
    || typeof input.consent.participantSessionId !== 'string'
    || !isHex64(input.consent.consentHash)
  ) {
    return null;
  }
  if (interview.studyRevision !== undefined && interview.studyRevision !== input.expectedStudyRevision) return null;
  // The initial generation's frozen inputs are required on this backend.
  if (!isValidFrozen(input.initialAnalysis, interview.studyId, input.expectedStudyRevision)) return null;

  const recordJson = JSON.stringify(interview);
  const frozenJson = JSON.stringify(input.initialAnalysis);
  const identityBytes = utf8Bytes(interview.id) + utf8Bytes(interview.studyId) + utf8Bytes(input.fingerprint)
    + utf8Bytes(input.identity.participantSessionId ?? '') + utf8Bytes(input.identity.linkId ?? '');
  // Measured assembled-row ceiling below the platform's 2 MB row limit.
  if (utf8Bytes(recordJson) + identityBytes + 64 > MAX_ROW_BYTES) return null;
  if (utf8Bytes(frozenJson) + 512 > MAX_ROW_BYTES) return null;

  return {
    input,
    interview,
    frozen: input.initialAnalysis,
    recordJson,
    sessionDigest: await sha256Hex(input.consent.participantSessionId),
  };
}

/**
 * A committed interview replays as a duplicate while its analysis state is
 * consistent: no analysis row (supported legacy input), a generation-0 row in
 * any valid status (the F7 import mapping), a settled generation, or an
 * active generation that still has its job. Anything else is corrupt.
 */
function replayInvariantHolds(ws: WorkspaceContext, interviewId: string): boolean {
  const analysis = ws.sql
    .exec<{ status: string; current_generation: number }>(
      `SELECT status, current_generation FROM analysis WHERE interview_id = ?`,
      interviewId,
    )
    .toArray()[0];
  if (!analysis) return true;
  const generation = analysis.current_generation;
  if (!Number.isSafeInteger(generation) || generation < 0 || !ANALYSIS_STATUSES.has(analysis.status)) return false;
  if (generation === 0 || (analysis.status !== 'pending' && analysis.status !== 'running')) return true;
  const job = ws.sql
    .exec<{ state: string }>(
      `SELECT state FROM analysis_jobs WHERE interview_id = ? AND generation = ?`,
      interviewId,
      generation,
    )
    .toArray()[0];
  return Boolean(job) && jobStateIsActive(job.state as Parameters<typeof jobStateIsActive>[0]);
}

/** JSON text with object keys sorted, so equal values compare equal whatever their key order. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, member: unknown) =>
    isPlainObject(member)
      ? Object.fromEntries(Object.keys(member).sort().map((key) => [key, member[key]]))
      : member,
  );
}

/** A caller-supplied value contradicted the object's own authority; content-free. */
function logInvalid(): void {
  logRequestEvent({ event: 'workspace.store', reason: 'invalid', operation: 'persistCompletedInterview' });
}

/**
 * Every refusal, in the Redis P1 order extended with link and consent: study,
 * links enabled, revision, frozen configuration, link, consent, the record's
 * identity binding, deletion fence, then duplicate / conflict, then save
 * admission. A permitted write receives the canonical frozen inputs.
 */
function decide(ws: WorkspaceContext, prepared: Prepared): Decision {
  const { input, interview } = prepared;
  const now = input.now;
  const refuse = (outcome: Outcome): Decision => ({ refuse: outcome });

  const studyRow = readStudyRow(ws, interview.studyId);
  if (!studyRow) return refuse({ status: 'study-not-found' });
  const study = decodeStudyRow(studyRow);
  if (!study) {
    logCorruptRecord('persistCompletedInterview');
    return refuse({ status: 'unavailable' });
  }
  if (!input.allowDisabledLinks && study.config.linksEnabled === false) return refuse({ status: 'links-disabled' });
  if (study.revision !== input.expectedStudyRevision) return refuse({ status: 'revision-stale' });

  // The object holds the canonical configuration of the verified revision. A
  // caller's differing copy, or a provider/model other than the study's own
  // explicit choice, is refused rather than frozen into the paid job.
  const requested = prepared.frozen;
  if (
    canonicalJson(requested.studyConfig) !== canonicalJson(study.config)
    || (study.config.aiProvider && requested.requestedProvider !== study.config.aiProvider)
    || (study.config.aiModel && requested.requestedModel !== study.config.aiModel)
    // The record's provider commitment is the object's own configuration at
    // this revision, and a fixed one names that revision's provider and model.
    || (interview.providerCommitment ?? null) !== (study.config.aiProviderCommitment ?? null)
    // A fixed one needs the study's own explicit provider and model: it never
    // rests on the installation-default fallback.
    || (interview.providerCommitment === 'fixed'
      && (typeof study.config.aiProvider !== 'string' || typeof study.config.aiModel !== 'string'
        || interview.conductedByProvider !== study.config.aiProvider || interview.conductedByModel !== study.config.aiModel))
  ) {
    logInvalid();
    return refuse({ status: 'unavailable' });
  }

  const linkId = input.identity.linkId;
  if (typeof linkId !== 'string' || !isHex64(linkId)) return refuse({ status: 'link-inactive' });
  const link = resolveLink(ws, linkId, now);
  if (link.status === 'corrupt') {
    logCorruptRecord('persistCompletedInterview');
    return refuse({ status: 'unavailable' });
  }
  if (
    link.status !== 'found'
    || link.link.studyId !== interview.studyId
    || link.link.studyRevision !== input.expectedStudyRevision
  ) {
    return refuse({ status: 'link-inactive' });
  }

  const consent = input.consent;
  if (
    input.identity.participantSessionId !== consent.participantSessionId
    || consent.studyId !== interview.studyId
    || consent.studyRevision !== input.expectedStudyRevision
  ) {
    return refuse({ status: 'consent-required' });
  }
  const stored = readConsent(ws, prepared.sessionDigest, now);
  if (stored === 'malformed') logCorruptRecord('persistCompletedInterview');
  if (stored === 'absent' || stored === 'malformed' || !consentMatches(stored, consent)) {
    return refuse({ status: 'consent-required' });
  }

  // The permanent record must carry the identity it was verified under: the
  // session's own interview id, its link and its stored consent evidence.
  if (
    interview.id !== `session-${consent.participantSessionId}`
    || (interview.participantLinkId !== undefined && interview.participantLinkId !== linkId)
    || interview.consentHash !== stored.consentHash
    || interview.consentAcceptedAt !== stored.acceptedAt
    // The disclosed transport travels from the stored consent to the record
    // and to the initial generation unchanged (D9).
    || (interview.consentTransport ?? null) !== (stored.disclosedTransport ?? null)
    || (requested.disclosedTransport ?? null) !== (stored.disclosedTransport ?? null)
  ) {
    logInvalid();
    return refuse({ status: 'conflict' });
  }

  if (isFenced(ws, 'interview', interview.id, now)) return refuse({ status: 'conflict' });

  const existing = ws.sql
    .exec<{ study_id: string; fingerprint: string }>(
      `SELECT study_id, fingerprint FROM interviews WHERE id = ?`,
      interview.id,
    )
    .toArray()[0];
  if (existing) {
    if (existing.fingerprint !== input.fingerprint || existing.study_id !== interview.studyId) {
      return refuse({ status: 'conflict' });
    }
    if (!replayInvariantHolds(ws, interview.id)) {
      logCorruptRecord('persistCompletedInterview');
      return refuse({ status: 'unavailable' });
    }
    return refuse({ status: 'duplicate' });
  }

  // Check every admission row before charging any of them.
  for (const row of input.ratePlan) {
    if (row.maximum <= 0) continue;
    const member = ws.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM budget_members WHERE plan_key = ? AND member = ?`,
        row.key,
        interview.id,
      )
      .one().n;
    if (member > 0) continue;
    const count = ws.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM budget_members WHERE plan_key = ?`, row.key)
      .one().n;
    if (count >= row.maximum) return refuse({ status: 'rate-limited' });
  }
  return {
    frozen: {
      inputSchemaVersion: ANALYSIS_INPUT_SCHEMA_VERSION,
      studyConfig: study.config,
      studyRevision: study.revision,
      requestedProvider: requested.requestedProvider,
      requestedModel: requested.requestedModel,
      ...(stored.disclosedTransport === 'cloudflare-gateway' ? { disclosedTransport: stored.disclosedTransport } : {}),
    },
  };
}

/** All writes of a new completion; returns the initial job's due time. */
function write(ws: WorkspaceContext, prepared: Prepared, frozen: FrozenAnalysisInput, meta: WorkspaceMeta): number {
  const { input, interview } = prepared;
  const now = input.now;
  ws.sql.exec(
    `INSERT INTO interviews (id, study_id, record_json, fingerprint, created_at, completed_at,
       participant_session_id, link_id, sample_fixture, study_revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    interview.id,
    interview.studyId,
    prepared.recordJson,
    input.fingerprint,
    interview.createdAt,
    interview.completedAt,
    input.identity.participantSessionId,
    input.identity.linkId,
    interview.studyRevision ?? null,
  );
  ws.sql.exec(
    `INSERT INTO analysis (interview_id, status, current_generation, attempts, last_attempt_at, updated_at)
     VALUES (?, 'pending', 1, 0, ?, ?)`,
    interview.id,
    now,
    now,
  );
  const due = allocateGeneration(ws, {
    interviewId: interview.id,
    generation: 1,
    jobId: input.initialJobId,
    recoveryEpoch: meta.activatedEpoch,
    frozen,
    now,
  });
  for (const row of input.ratePlan) {
    ws.sql.exec(
      `INSERT INTO budget_members (plan_key, member, expires_at) VALUES (?, ?, ?)
       ON CONFLICT (plan_key, member) DO NOTHING`,
      row.key,
      interview.id,
      (row.windowStart + row.windowSeconds + MEMBER_GRACE_SECONDS) * 1000,
    );
  }
  ws.sql.exec(
    `UPDATE studies
        SET interview_count = (SELECT COUNT(*) FROM interviews WHERE study_id = ?),
            is_locked = 1,
            updated_at = ?
      WHERE id = ?`,
    interview.studyId,
    now,
    interview.studyId,
  );
  bumpMutationSeq(ws.sql, now);
  return due;
}

export async function persistCompletedInterview(ws: WorkspaceContext, input: Rpc.PersistInput): Promise<Outcome> {
  try {
    const prepared = await prepare(input);
    if (!prepared) return { status: 'unavailable' };
    // The callback performs storage operations only: SQL plus the alarm. A
    // throw anywhere (including a failed allocation or alarm write) rolls
    // back every write, and `created` is returned only after commit.
    return await ws.storage.transaction(async (): Promise<Outcome> => {
      const checked = gate(ws, 'participant-session');
      if (!checked.ok) return { status: 'held', reason: checked.reason };
      const decision = decide(ws, prepared);
      if ('refuse' in decision) return decision.refuse;
      const due = write(ws, prepared, decision.frozen, checked.meta);
      await armAlarmNoLaterThan(ws.storage, due);
      return { status: 'created' };
    });
  } catch (error) {
    logStorageFailure('persistCompletedInterview', error);
    return { status: 'unavailable' };
  }
}
