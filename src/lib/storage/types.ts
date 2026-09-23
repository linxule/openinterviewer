// WorkspaceStorePort: the backend-neutral standalone storage boundary
// (02-storage.md). Only complete domain operations cross it. Result unions are
// per operation and reuse the existing Redis-era shapes so HTTP mappings stay
// unchanged. Type-only imports keep this module free of backend code.
//
// Vocabulary: `not-found` is a confirmed miss; `unavailable` means storage
// could not establish a result (for a mutation it may still have committed —
// callers replay with the same identity); `ambiguous` is an explicitly
// possibly-committed mutation. Neither is ever converted to success.

import type {
  StoredAggregateSynthesis,
  StoredInterview,
  StoredStudy,
  StudyConfig,
} from '@/types';
import type {
  AggregateLoadResult,
  CollectionLoadResult,
  DeleteStudyResult,
  InterviewLoadResult,
  PersistCompletedInterviewResult,
  SaveAggregateResult,
  StudyLoadResult,
  StudyMutationResult,
} from '@/lib/kv';
import type { ParticipantLinkMetadata, ParticipantLinkRecord } from '@/lib/participantLinks';
import type {
  ParticipantConsentRecord,
  RecordParticipantConsentResult,
  VerifyParticipantConsentResult,
} from '@/lib/participantConsent';
import type { ParticipantRateLimitCounter, PersistRatePlanRow } from '@/lib/rateLimit';
import type {
  AcceptAnalysisRetryInput,
  AcceptAnalysisRetryOutcome,
  FrozenAnalysisInput,
  ReadAnalysisStatusOutcome,
} from './analysisProtocol';

export type {
  AggregateLoadResult,
  CollectionLoadResult,
  DeleteStudyResult,
  InterviewLoadResult,
  PersistCompletedInterviewResult,
  SaveAggregateResult,
  StudyLoadResult,
  StudyMutationResult,
};

export type WorkspaceBackend = 'redis' | 'durable-object';

export type MaintenanceState = 'open' | 'draining' | 'frozen' | 'recovery';

/** Why a durable workspace refuses work. Never produced by the Redis store. */
export type WorkspaceHoldReason =
  | 'maintenance'
  | 'schema-unsupported'
  | 'workspace-identity-mismatch'
  | 'recovery-epoch-mismatch';

export type StoreReadiness =
  | { status: 'ready'; maintenance: MaintenanceState }
  | { status: 'unavailable' }
  | { status: 'held'; reason: WorkspaceHoldReason; maintenance?: MaintenanceState };

// ---------- Studies ----------

export type CreateStudyInput = {
  /** sha256 digest of the scoped Idempotency-Key (never the raw key). */
  idempotencyKeyDigest: string;
  /** createFingerprint(config): identifies the intent bound to the key. */
  fingerprint: string;
  /** Study minted outside any retried transaction (id and time are stable). */
  candidate: StoredStudy;
};

export type CreateStudyOutcome =
  | { status: 'created'; study: StoredStudy; replayed: boolean }
  | { status: 'key-reuse' }
  | { status: 'key-consumed' }
  | { status: 'conflict' }
  | { status: 'quota' }
  | { status: 'held'; reason: WorkspaceHoldReason }
  | { status: 'unavailable' }
  | { status: 'ambiguous' };

export type StudyMutationOutcome = StudyMutationResult | { status: 'held'; reason: WorkspaceHoldReason };
export type DeleteStudyOutcome = DeleteStudyResult | { status: 'held'; reason: WorkspaceHoldReason; success: false };

// ---------- Participant links ----------

export type CreateLinkInput = {
  studyId: string;
  /** The revision the researcher's request observed; the store re-checks it. */
  studyRevision: number;
  expiresAt: number | null;
  now: number;
};

export type CreateLinkOutcome =
  | { status: 'created'; code: string; link: ParticipantLinkRecord }
  | { status: 'quota-exceeded' }
  | { status: 'study-not-found' }
  | { status: 'links-disabled' }
  | { status: 'revision-stale' }
  | { status: 'held'; reason: WorkspaceHoldReason }
  | { status: 'unavailable' }
  | { status: 'ambiguous' };

export type LinkLoadOutcome =
  | { status: 'found'; link: ParticipantLinkRecord }
  | { status: 'not-found' }
  | { status: 'expired' }
  | { status: 'revoked' }
  | { status: 'held'; reason: WorkspaceHoldReason }
  | { status: 'unavailable' };

export type LinkListOutcome =
  | { status: 'ok'; links: ParticipantLinkMetadata[]; truncated: boolean }
  | { status: 'unavailable' };

export type LinkRevokeOutcome =
  | { status: 'revoked'; revokedAt: number }
  | { status: 'already-revoked' }
  | { status: 'not-found' }
  | { status: 'owner-conflict' }
  | { status: 'held'; reason: WorkspaceHoldReason }
  | { status: 'unavailable' }
  | { status: 'ambiguous' };

// ---------- Consent ----------

export type ConsentBinding = {
  participantSessionId: string;
  studyId: string;
  studyRevision: number;
  consentText: string;
};

export type RecordConsentOutcome = RecordParticipantConsentResult | { status: 'held'; reason: WorkspaceHoldReason };
export type VerifyConsentOutcome = VerifyParticipantConsentResult;

// ---------- Participant admission (greeting/interview budgets) ----------

export type AdmissionInput = {
  operation: 'greeting' | 'interview';
  /** Counters in LIMITS order; keys are salted digests on the durable store. */
  counters: ParticipantRateLimitCounter[];
  now: number;
};

export type AdmissionOutcome =
  | { status: 'admitted' }
  | { status: 'limited'; rejectedIndex: number; retryAfterSeconds: number }
  | { status: 'held'; reason: WorkspaceHoldReason }
  | { status: 'unavailable' };

// ---------- Completion ----------

export type PersistCompletedInterviewInput = {
  interview: StoredInterview;
  fingerprint: string;
  expectedStudyRevision: number;
  allowDisabledLinks: boolean;
  ratePlan: PersistRatePlanRow[];
  identity: { participantSessionId: string | null; linkId: string | null };
  /**
   * Durable backend only: consent binding re-verified at the write boundary,
   * and the initial generation's frozen inputs. The Redis store ignores both
   * (its route-level checks and synchronous analysis are unchanged).
   */
  consent?: ConsentBinding;
  initialAnalysis?: FrozenAnalysisInput;
  now: number;
};

export type PersistCompletedInterviewOutcome =
  | PersistCompletedInterviewResult
  | { status: 'link-inactive' }
  | { status: 'consent-required' }
  | { status: 'held'; reason: WorkspaceHoldReason };

// ---------- Aggregate ----------

export type SaveAggregateOutcome = SaveAggregateResult | 'study-not-found' | 'held';

// ---------- Sample workspace ----------

export type SeedSampleInput = {
  studies: StoredStudy[];
  interviews: StoredInterview[];
  now: number;
};

export type SeedSampleOutcome =
  | { status: 'seeded'; studiesSeeded: number; interviewsSeeded: number }
  | { status: 'already-seeded' }
  | { status: 'held'; reason: WorkspaceHoldReason }
  | { status: 'unavailable' };

export type ClearSampleInput = {
  studyIds: string[];
  interviewIds: string[];
};

export type ClearSampleOutcome =
  | { status: 'cleared'; studiesDeleted: number; interviewsDeleted: number }
  | { status: 'has-participant-data' }
  | { status: 'held'; reason: WorkspaceHoldReason }
  | { status: 'unavailable' }
  | { status: 'ambiguous' };

// ---------- Collections ----------

export type ListInterviewsInput =
  | { scope: 'study'; studyId: string; maximum: number }
  | { scope: 'all'; maximum: number };

export interface WorkspaceStorePort {
  readonly backend: WorkspaceBackend;

  readiness(): Promise<StoreReadiness>;

  getStudy(studyId: string): Promise<StudyLoadResult>;
  listStudies(maximum: number): Promise<CollectionLoadResult<StoredStudy>>;
  createStudy(input: CreateStudyInput): Promise<CreateStudyOutcome>;
  replaceStudyConfig(input: {
    studyId: string;
    expectedRevision: number;
    config: StudyConfig;
    now: number;
  }): Promise<StudyMutationOutcome>;
  setStudyLinksEnabled(input: {
    studyId: string;
    enabled: boolean;
    now: number;
  }): Promise<StudyMutationOutcome>;
  deleteStudy(input: { studyId: string; now: number }): Promise<DeleteStudyOutcome>;

  createParticipantLink(input: CreateLinkInput): Promise<CreateLinkOutcome>;
  /** Link exchange: resolves the opaque code (digest lookup; raw code never stored). */
  resolveParticipantLinkByCode(input: { code: string; now: number; purpose: 'exchange' }): Promise<LinkLoadOutcome>;
  getParticipantLinkById(input: { linkId: string; now: number }): Promise<LinkLoadOutcome>;
  listParticipantLinks(input: { studyId: string; maximum: number; now: number }): Promise<LinkListOutcome>;
  revokeParticipantLink(input: { studyId: string; linkId: string; now: number }): Promise<LinkRevokeOutcome>;

  recordConsent(input: ConsentBinding & { now: number }): Promise<RecordConsentOutcome>;
  verifyConsent(input: ConsentBinding & { now: number }): Promise<VerifyConsentOutcome>;
  admitParticipantRequest(input: AdmissionInput): Promise<AdmissionOutcome>;

  persistCompletedInterview(input: PersistCompletedInterviewInput): Promise<PersistCompletedInterviewOutcome>;

  getInterview(interviewId: string): Promise<InterviewLoadResult>;
  listInterviews(input: ListInterviewsInput): Promise<CollectionLoadResult<StoredInterview>>;

  getAggregate(studyId: string): Promise<AggregateLoadResult>;
  saveAggregate(aggregate: StoredAggregateSynthesis): Promise<SaveAggregateOutcome>;

  seedSampleWorkspace(input: SeedSampleInput): Promise<SeedSampleOutcome>;
  clearSampleWorkspace(input: ClearSampleInput): Promise<ClearSampleOutcome>;
}

export type { ParticipantConsentRecord };

// ---------- Durable-only capability (Cloudflare target) ----------

export type ExportBegin =
  | { status: 'ok'; sequence: number; count: number; studyIds: string[] }
  | { status: 'empty' }
  | { status: 'too-large'; count: number; maximum: number }
  | { status: 'unavailable' };

export type ExportPage =
  | { status: 'ok'; interviews: StoredInterview[]; aggregates: StoredAggregateSynthesis[]; nextCursor: string | null }
  | { status: 'changed' }
  | { status: 'unavailable' };

export type AggregateInputsPage =
  | { status: 'ok'; interviews: StoredInterview[]; nextCursor: string | null; totalEligible: number }
  | { status: 'unavailable' };

/**
 * Operations only the durable workspace provides. Routes narrow with
 * `isDurableWorkspaceStore(store)`; the Redis store never implements them.
 */
export interface DurableWorkspaceStorePort extends WorkspaceStorePort {
  readonly backend: 'durable-object';
  acceptAnalysisRetry(input: Omit<AcceptAnalysisRetryInput, 'requestKeyDigest' | 'requestFingerprint'> & {
    rawIdempotencyKey: string;
    apiVersion: 2;
  }): Promise<AcceptAnalysisRetryOutcome>;
  readAnalysisStatus(input: { studyId: string; interviewId: string }): Promise<ReadAnalysisStatusOutcome>;
  beginExport(input: { maximum: number }): Promise<ExportBegin>;
  readExportPage(input: { sequence: number; cursor: string | null; pageSize: number; maxPageBytes: number }): Promise<ExportPage>;
  verifyExportSequence(input: { sequence: number }): Promise<'unchanged' | 'changed' | 'unavailable'>;
  readAggregateInputs(input: {
    studyId: string;
    studyRevision: number;
    cursor: string | null;
    pageSize: number;
    maxPageBytes: number;
  }): Promise<AggregateInputsPage>;
}

export function isDurableWorkspaceStore(store: WorkspaceStorePort): store is DurableWorkspaceStorePort {
  return store.backend === 'durable-object';
}
