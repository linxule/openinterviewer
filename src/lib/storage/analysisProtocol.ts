// Durable analysis job protocol (03-analysis-jobs.md). Portable: shared by the
// Next routes (projection, HTTP contract), the Queue consumer and the
// WorkspaceStore Durable Object. No backend code here.

import type {
  AIProviderType,
  InterviewAnalysisFailureKind,
  StudyConfig,
  SynthesisResult,
} from '@/types';

// ---------- Tested constants (JOB-06/07/08/10) ----------

export const ANALYSIS_CLAIM_LEASE_MS = 180_000;
export const QUEUED_SYNTHESIS_DEADLINE_MS = 120_000;
export const ANALYSIS_ATTACH_MARGIN_MS = 20_000;
export const ANALYSIS_MAX_DISPATCH_ATTEMPTS = 16;
export const ANALYSIS_MAX_PRESTART_AGE_MS = 24 * 60 * 60 * 1000;
export const ANALYSIS_DISPATCH_BACKOFF_BASE_MS = 5_000;
export const ANALYSIS_DISPATCH_BACKOFF_CAP_MS = 30 * 60 * 1000;
export const ANALYSIS_WATCHDOG_AFTER_SEND_MS = 5 * 60 * 1000;
export const ANALYSIS_ALARM_BATCH = 25;
export const ANALYSIS_ALARM_FAILURE_RETRY_MS = 30_000;
export const ANALYSIS_RETRY_RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const ANALYSIS_TERMINAL_JOB_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const ANALYSIS_POLL_AFTER_MS = 2_000;
export const ANALYSIS_INPUT_SCHEMA_VERSION = 1;

/** Backoff before re-dispatching an unacknowledged send (attempt ≥ 1). */
export function dispatchBackoffMs(attempt: number): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 20));
  return Math.min(ANALYSIS_DISPATCH_BACKOFF_BASE_MS * 2 ** exponent, ANALYSIS_DISPATCH_BACKOFF_CAP_MS);
}

// ---------- Internal state (never exposed publicly) ----------

export type AnalysisJobState =
  | 'pending'
  | 'claimed'
  | 'started'
  | 'complete'
  | 'failed'
  | 'recovery-required'
  | 'cancelled';

export const NONTERMINAL_JOB_STATES: ReadonlyArray<AnalysisJobState> = ['pending', 'claimed', 'started'];

export function isNonterminalJobState(state: AnalysisJobState): boolean {
  return state === 'pending' || state === 'claimed' || state === 'started';
}

/**
 * Immutable per-generation inputs, resolved before persistence. The model is
 * explicit: execution never substitutes a later study edit or deployment
 * default. Transcript/profile/behavior come from the immutable interview row.
 */
export type FrozenAnalysisInput = {
  inputSchemaVersion: typeof ANALYSIS_INPUT_SCHEMA_VERSION;
  studyConfig: StudyConfig;
  studyRevision: number;
  requestedProvider: AIProviderType;
  requestedModel: string;
};

// ---------- Queue envelope (JOB-06) ----------

export type AnalysisMessageV1 = {
  v: 1;
  workspaceId: string;
  interviewId: string;
  jobId: string;
  generation: number;
  recoveryEpoch: string;
};

const INTERVIEW_ID = /^[A-Za-z0-9_-]{1,120}$/;
const JOB_ID = /^[a-f0-9-]{36}$/;
const WORKSPACE_ID = /^ws_[a-f0-9]{32}$/;
const EPOCH = /^ep_[a-f0-9]{32}$/;

export function isValidWorkspaceId(value: unknown): value is string {
  return typeof value === 'string' && WORKSPACE_ID.test(value);
}

export function isValidRecoveryEpoch(value: unknown): value is string {
  return typeof value === 'string' && EPOCH.test(value);
}

export type MessageValidation =
  | { status: 'valid'; message: AnalysisMessageV1 }
  | { status: 'unknown-version' }
  | { status: 'invalid' };

/** Closed-shape validation. Unknown versions go to the dead-letter path. */
export function validateAnalysisMessage(body: unknown): MessageValidation {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 'invalid' };
  const record = body as Record<string, unknown>;
  if (record.v !== 1) {
    return typeof record.v === 'number' && Number.isSafeInteger(record.v) && record.v > 1
      ? { status: 'unknown-version' }
      : { status: 'invalid' };
  }
  const keys = Object.keys(record).sort();
  const expected = ['generation', 'interviewId', 'jobId', 'recoveryEpoch', 'v', 'workspaceId'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return { status: 'invalid' };
  }
  if (
    !isValidWorkspaceId(record.workspaceId)
    || typeof record.interviewId !== 'string' || !INTERVIEW_ID.test(record.interviewId)
    || typeof record.jobId !== 'string' || !JOB_ID.test(record.jobId)
    || typeof record.generation !== 'number' || !Number.isSafeInteger(record.generation) || record.generation < 1
    || !isValidRecoveryEpoch(record.recoveryEpoch)
  ) {
    return { status: 'invalid' };
  }
  return { status: 'valid', message: record as unknown as AnalysisMessageV1 };
}

// ---------- Public projection (API-02) ----------

export type AnalysisPhase = 'queued' | 'running' | 'not-scheduled';

/** GET/POST response bodies. Closed: no synthesis, job ids, claims or epochs. */
export type AnalysisStatusBody =
  | { status: 'pending'; generation: number; phase: AnalysisPhase; pollAfterMs?: number }
  | { status: 'complete'; generation: number }
  | { status: 'already-complete'; generation: number }
  | { status: 'failed'; generation: number; failureKind: InterviewAnalysisFailureKind; recoveryRequired: boolean };

// ---------- Store operations (durable capability only) ----------

export type AcceptAnalysisRetryInput = {
  studyId: string;
  interviewId: string;
  /** sha256 over workspace, study, interview and the raw Idempotency-Key. */
  requestKeyDigest: string;
  /** sha256 over API version and expectedGeneration. */
  requestFingerprint: string;
  expectedGeneration: number;
  /** Acceptance-time frozen inputs; used only when a generation is allocated. */
  input: FrozenAnalysisInput;
  now: number;
};

export type AcceptAnalysisRetryOutcome =
  | { status: 'accepted'; body: AnalysisStatusBody }
  | { status: 'existing'; body: AnalysisStatusBody }
  | { status: 'already-complete'; body: AnalysisStatusBody }
  | { status: 'state-changed' }
  | { status: 'key-conflict' }
  | { status: 'not-found' }
  | { status: 'held'; reason: string }
  | { status: 'corrupt' }
  | { status: 'unavailable' };

export type ReadAnalysisStatusOutcome =
  | { status: 'ok'; body: AnalysisStatusBody }
  | { status: 'not-found' }
  | { status: 'corrupt' }
  | { status: 'unavailable' };

// ---------- Queue consumer ↔ Durable Object RPC ----------

export type JobFence = {
  workspaceId: string;
  interviewId: string;
  jobId: string;
  generation: number;
  recoveryEpoch: string;
};

export type ClaimAnalysisJobInput = JobFence & { claimNonce: string; now: number };

export type ClaimedAnalysisInputs = {
  frozen: FrozenAnalysisInput;
  interview: {
    id: string;
    studyId: string;
    transcript: unknown;
    participantProfile: unknown;
    behaviorData: unknown;
  };
  leaseExpiresAt: number;
};

export type ClaimAnalysisJobOutcome =
  | { status: 'claimed'; inputs: ClaimedAnalysisInputs; replayed: boolean }
  | { status: 'busy' }
  | { status: 'stale' }
  | { status: 'terminal' }
  | { status: 'cancelled' }
  | { status: 'not-found' }
  | { status: 'held' }
  | { status: 'corrupt' }
  | { status: 'unavailable' };

export type MarkStartedInput = JobFence & { claimNonce: string; requiredRemainingMs: number; now: number };

export type MarkStartedOutcome =
  | { status: 'started'; replayed: boolean; leaseExpiresAt: number }
  | { status: 'lease-insufficient' }
  | { status: 'stale' }
  | { status: 'held' }
  | { status: 'unavailable' };

export type ProviderProvenance = {
  aiProvider: AIProviderType;
  aiModel: string;
  requestedAiModel: string;
  routedProvider?: string;
};

export type FinishAnalysisJobInput = JobFence & {
  claimNonce: string;
  now: number;
  outcome:
    | { kind: 'complete'; synthesis: SynthesisResult; provenance: ProviderProvenance }
    | { kind: 'failed'; failureKind: Exclude<InterviewAnalysisFailureKind, 'timeout'> }
    | { kind: 'uncertain' };
};

export type FinishAnalysisJobOutcome =
  | { status: 'written'; replayed: boolean }
  | { status: 'too-large' }
  | { status: 'lease-expired' }
  | { status: 'stale' }
  | { status: 'held' }
  | { status: 'corrupt' }
  | { status: 'unavailable' };
