// Verbatim copy of cloudflare/workspace/projection.ts at eaa30a2 (the N-1 release
// before the Cloudflare AI Gateway transport). Used only by rollback-reader
// tests: an N-1 build must read what this build writes. Do not update it.

// Public StoredInterview reconstruction (02-storage.md "Keep transcript data
// separate from mutable synthesis"). The immutable record_json is the exact
// record written at completion (or import); the analysis row owns every
// mutable member. Reads, exports and the Queue consumer all use this one
// projection so SQL internals never reach UI/export consumers.

import type {
  AIProviderType,
  InterviewAnalysisFailureKind,
  InterviewAnalysisState,
  StoredInterview,
  SynthesisResult,
} from '../../../src/types';

export type AnalysisRow = {
  interview_id: string;
  status: 'pending' | 'running' | 'complete' | 'failed';
  current_generation: number;
  attempts: number;
  last_attempt_at: number;
  failure_kind: InterviewAnalysisFailureKind | null;
  recovery_required: number;
  study_revision: number | null;
  synthesis_json: string | null;
  provenance_json: string | null;
  updated_at: number;
};

export const ANALYSIS_COLUMNS = `interview_id, status, current_generation, attempts, last_attempt_at, failure_kind,
  recovery_required, study_revision, synthesis_json, provenance_json, updated_at`;

type Provenance = {
  aiProvider: AIProviderType;
  aiModel: string;
  requestedAiModel: string;
  routedProvider?: string;
};

// Members owned by the analysis row; never taken from the immutable record
// once an analysis row exists.
const MUTABLE_MEMBERS = ['synthesis', 'analysis', 'aiProvider', 'aiModel', 'requestedAiModel', 'routedProvider'] as const;

export class CorruptRecordError extends Error {
  constructor(readonly where: 'record' | 'analysis') {
    super(`corrupt ${where}`);
    this.name = 'CorruptRecordError';
  }
}

function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Parse and minimally validate the immutable record (identity members only). */
export function parseRecord(recordJson: string, expectedId: string): StoredInterview {
  let parsed: unknown;
  try {
    parsed = JSON.parse(recordJson);
  } catch {
    throw new CorruptRecordError('record');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new CorruptRecordError('record');
  const record = parsed as Record<string, unknown>;
  if (
    record.id !== expectedId
    || typeof record.studyId !== 'string'
    || (record.status !== 'completed' && record.status !== 'in_progress')
    || typeof record.createdAt !== 'number'
    || typeof record.completedAt !== 'number'
  ) {
    throw new CorruptRecordError('record');
  }
  return parsed as StoredInterview;
}

/** The analysis state a researcher-facing record carries. No claim or epoch fields. */
export function projectAnalysisState(row: AnalysisRow): InterviewAnalysisState {
  if (!isSafeCount(row.attempts) || !isSafeCount(row.current_generation) || typeof row.last_attempt_at !== 'number') {
    throw new CorruptRecordError('analysis');
  }
  const state: InterviewAnalysisState = {
    status: row.status,
    attempts: row.attempts,
    lastAttemptAt: row.last_attempt_at,
    generation: row.current_generation,
  };
  if (row.status === 'failed') {
    if (!row.failure_kind) throw new CorruptRecordError('analysis');
    state.failureKind = row.failure_kind;
    state.recoveryRequired = row.recovery_required === 1;
  }
  if (row.status === 'complete' && row.study_revision !== null) state.studyRevision = row.study_revision;
  return state;
}

/**
 * Reconstruct the public StoredInterview. A null analysis row means a
 * supported legacy/imported record without analysis state: it is returned as
 * stored, and analysisStatus() derives its status from `synthesis`.
 */
export function projectInterview(recordJson: string, expectedId: string, row: AnalysisRow | null): StoredInterview {
  const record = parseRecord(recordJson, expectedId);
  if (!row) return record;
  const projected: Record<string, unknown> = { ...record };
  for (const member of MUTABLE_MEMBERS) delete projected[member];
  let synthesis: SynthesisResult | null = null;
  if (row.status === 'complete') {
    if (!row.synthesis_json || !row.provenance_json) throw new CorruptRecordError('analysis');
    try {
      synthesis = JSON.parse(row.synthesis_json) as SynthesisResult;
      const provenance = JSON.parse(row.provenance_json) as Provenance;
      projected.aiProvider = provenance.aiProvider;
      projected.aiModel = provenance.aiModel;
      projected.requestedAiModel = provenance.requestedAiModel;
      if (provenance.routedProvider !== undefined) projected.routedProvider = provenance.routedProvider;
    } catch {
      throw new CorruptRecordError('analysis');
    }
  }
  projected.synthesis = synthesis;
  projected.analysis = projectAnalysisState(row);
  return projected as unknown as StoredInterview;
}
