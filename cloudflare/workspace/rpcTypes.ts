// RPC input/outcome shapes for WorkspaceStore methods that are not already
// defined by the portable port (src/lib/storage/types.ts) or the analysis
// protocol (src/lib/storage/analysisProtocol.ts). Everything here must be
// structured-clone safe plain data.

import type {
  StoredAggregateSynthesis,
  StoredInterview as DomainStoredInterview,
  StoredStudy as DomainStoredStudy,
  StudyConfig,
} from '../../src/types';
import type { ParticipantLinkRecord } from '../../src/lib/participantLinks';
import type { BackupImportManifest } from '../../src/lib/backup/format';
import type {
  AggregateInputsPurpose,
  LoginBudgetAdmitOutcome,
  LoginBudgetRefundOutcome,
  MaintenanceState,
  PersistCompletedInterviewInput,
  WorkspaceHoldReason,
} from '../../src/lib/storage/types';

export type StoredStudy = DomainStoredStudy;
export type StoredInterview = DomainStoredInterview;

export type StudyIdInput = { studyId: string };
export type InterviewIdInput = { interviewId: string };
export type MaximumInput = { maximum: number };

export type ReplaceStudyConfigInput = {
  studyId: string;
  expectedRevision: number;
  config: StudyConfig;
  now: number;
};

export type SetLinksEnabledInput = { studyId: string; enabled: boolean; now: number };
export type DeleteStudyInput = { studyId: string; now: number };

/**
 * The raw link code never reaches the object: the caller mints it, sends only
 * its sha256 digest (the link id) and returns the code to the researcher once.
 */
export type CreateLinkRecordInput = {
  linkId: string;
  studyId: string;
  studyRevision: number;
  expiresAt: number | null;
  now: number;
};

export type CreateLinkRecordOutcome =
  | { status: 'created'; link: ParticipantLinkRecord }
  | { status: 'id-collision' }
  | { status: 'quota-exceeded' }
  | { status: 'study-not-found' }
  | { status: 'links-disabled' }
  | { status: 'revision-stale' }
  | { status: 'held'; reason: WorkspaceHoldReason }
  | { status: 'unavailable' };

export type GetLinkInput = {
  linkId: string;
  now: number;
  /** `exchange` is a new collection start (refused while draining). */
  purpose: 'exchange' | 'session' | 'researcher';
};

export type ListLinksInput = { studyId: string; maximum: number; now: number };
export type RevokeLinkInput = { studyId: string; linkId: string; now: number };

/** Consent binding with the text already hashed by the caller. */
export type ConsentInput = {
  participantSessionId: string;
  studyId: string;
  studyRevision: number;
  consentHash: string;
  now: number;
};

export type PersistInput = Omit<PersistCompletedInterviewInput, 'consent'> & {
  consent: ConsentInput;
  /** Minted by the caller before the call; reused on replay of the same submission. */
  initialJobId: string;
};

export type SaveAggregateInput = { aggregate: StoredAggregateSynthesis; now: number };

/**
 * Bounded aggregate/follow-up inputs: analyzed interviews of one study at one
 * revision, selecting only the fields prompt assembly needs. Paged by keyset.
 * `purpose` selects the maintenance fence of the paid route they feed
 * (absent: `aggregate`).
 */
export type AggregateInputsInput = {
  studyId: string;
  studyRevision: number;
  cursor: string | null;
  pageSize: number;
  maxPageBytes: number;
  purpose?: AggregateInputsPurpose;
};

export type AggregateInputsOutcome =
  | { status: 'ok'; interviews: StoredInterview[]; nextCursor: string | null; totalEligible: number }
  | { status: 'unavailable' };

export type AnalysisStatusInput = { studyId: string; interviewId: string };

// ---------- Researcher export ----------

export type BeginExportInput = { maximum: number };

export type BeginExportOutcome =
  | { status: 'ok'; sequence: number; count: number; studyIds: string[] }
  | { status: 'empty' }
  | { status: 'too-large'; count: number; maximum: number }
  | { status: 'unavailable' };

export type ExportPageInput = {
  sequence: number;
  /** Keyset cursor over (created_at DESC, id DESC); null for the first page. */
  cursor: string | null;
  pageSize: number;
  maxPageBytes: number;
};

export type ExportPageOutcome =
  | { status: 'ok'; interviews: StoredInterview[]; aggregates: StoredAggregateSynthesis[]; nextCursor: string | null }
  | { status: 'changed' }
  | { status: 'unavailable' };

export type ExportSequenceInput = { sequence: number };
export type ExportSequenceOutcome = { status: 'unchanged' } | { status: 'changed' } | { status: 'unavailable' };

// ---------- Operator ----------

export type OperatorStatusOutcome =
  | {
      status: 'ok';
      workspaceId: string;
      schemaVersion: number;
      maintenance: { state: MaintenanceState; version: number };
      epoch: { activated: string; configuredMatches: boolean };
      counts: Record<string, number>;
      jobs: { pending: number; claimed: number; started: number; recoveryRequired: number; oldestActiveAgeMs: number | null };
      alarm: { scheduledAt: number | null };
    }
  | { status: 'held'; reason: WorkspaceHoldReason }
  | { status: 'unavailable' };

export type MaintenanceTransitionInput = {
  expectedState: MaintenanceState;
  expectedVersion: number;
  nextState: MaintenanceState;
  /** Required to freeze while attempts are in flight (claimed → pending, started → recovery-required). */
  classifyInFlight?: boolean;
  now: number;
};

export type MaintenanceTransitionOutcome =
  | { status: 'transitioned'; state: MaintenanceState; version: number }
  | { status: 'already'; state: MaintenanceState; version: number }
  | { status: 'conflict'; state: MaintenanceState; version: number }
  | { status: 'in-flight'; claimed: number; started: number }
  | { status: 'invalid-transition' }
  | { status: 'held'; reason: WorkspaceHoldReason }
  | { status: 'unavailable' };

export type BackupPageInput = {
  /** Watermark captured by the first page; every later page must match it. */
  watermark: { maintenanceVersion: number; mutationSeq: number } | null;
  family: string;
  cursor: string | null;
  pageSize: number;
};

export type BackupPageOutcome =
  | {
      status: 'ok';
      watermark: { maintenanceVersion: number; mutationSeq: number };
      family: string;
      rows: unknown[];
      nextCursor: string | null;
      families: string[];
      schemaVersion: number;
      workspaceId: string;
    }
  | { status: 'not-frozen' }
  | { status: 'watermark-changed' }
  | { status: 'held'; reason: WorkspaceHoldReason }
  | { status: 'unavailable' };

export type BackupImportInput = {
  /** importManifestOf(validated backup manifest): binds every chunk to its descriptor. */
  manifest: BackupImportManifest;
  chunk: { family: string; index: number; sha256: string; rows: unknown[] } | null;
  /** Final call: validate references/counts and keep dispatch suspended. */
  finalize?: boolean;
  now: number;
};

export type BackupImportOutcome =
  | { status: 'accepted'; family: string; index: number; duplicate: boolean }
  | { status: 'finalized'; counts: Record<string, number> }
  | { status: 'rejected'; errorClass: string; counts?: Record<string, number> }
  | { status: 'not-empty' }
  | { status: 'not-recovery' }
  | { status: 'held'; reason: WorkspaceHoldReason }
  | { status: 'unavailable' };

export type ActivateEpochInput = {
  /** The currently activated epoch the operator observed (compare-and-set). */
  expectedActivatedEpoch: string;
  now: number;
};

export type ActivateEpochOutcome =
  | { status: 'activated'; reconciledJobs: number }
  | { status: 'already-active' }
  | { status: 'conflict' }
  | { status: 'not-recovery' }
  | { status: 'held'; reason: WorkspaceHoldReason }
  | { status: 'unavailable' };

export type RestoreBookmarkInput = {
  /** The held state (`frozen` or `recovery`) and version status reported (compare-and-set). */
  expectedState: MaintenanceState;
  expectedVersion: number;
  /** Exactly one of `bookmark` and `at` (epoch ms, resolved to a bookmark by the object). */
  bookmark: string | null;
  at: number | null;
  now: number;
};

export type RestoreBookmarkOutcome =
  /** The next session opens on `bookmark`; restoring `undoBookmark` reverses it. */
  | { status: 'scheduled'; bookmark: string; undoBookmark: string }
  | { status: 'conflict'; state: MaintenanceState; version: number }
  /** The workspace is not `frozen` or `recovery`. */
  | { status: 'not-held'; state: MaintenanceState; version: number }
  /** The configured epoch is invalid, still the activated one, or one this object already replaced. */
  | { status: 'epoch-not-rotated' }
  /** The platform refused the time or bookmark; nothing was scheduled. */
  | { status: 'bookmark-refused' }
  | { status: 'invalid-request' }
  | { status: 'held'; reason: WorkspaceHoldReason }
  | { status: 'unavailable' };

// ---------- Researcher sign-in budget (gap F5) ----------

export type LoginAttemptInput = {
  /** HMAC-SHA-256 hex digest of the admission identity, computed by the durable client. */
  clientKey: string;
  now: number;
};

export type LoginAdmitOutcome =
  | LoginBudgetAdmitOutcome
  | { status: 'held'; reason: WorkspaceHoldReason };

export type LoginRefundOutcome =
  | LoginBudgetRefundOutcome
  | { status: 'held'; reason: WorkspaceHoldReason };
