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
  StudyListItem,
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
import type { AdmissionIdentity } from '../runtime/workerInvocation';

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
  | 'workspace-uninitialized'
  /**
   * The running version lacks a valid WORKSPACE_ID or recovery epoch, so a
   * fresh object cannot initialize yet (for example the version before the
   * installer's secret upload). Distinct from an identity mismatch: supplying
   * the configuration resolves it without operator repair.
   */
  | 'workspace-unconfigured'
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
  /**
   * recordConsent only, durable store only: the transport the participant was
   * shown (absent = direct). Part of the record's identity: a replay with
   * another value is a conflict. The Redis store never receives it.
   */
  disclosedTransport?: 'cloudflare-gateway';
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

// ---------- Researcher AI budget (standalone targets, D15) ----------

/** Every researcher AI budget key starts with this; participant keys start with `rate-limit:`. */
export const RESEARCHER_AI_KEY_PREFIX = 'researcher-ai:';

export type ResearcherAiOperation = 'greeting' | 'interview' | 'synthesis' | 'aggregate' | 'followup' | 'analysis';

/**
 * One researcher budget scope. Keys start with `researcher-ai:` (never a
 * participant `rate-limit:` key); the durable store receives them salted and
 * digested.
 */
export type ResearcherAiCounter = {
  key: string;
  maximum: number;
  windowSeconds: number;
};

export type ResearcherAiAdmissionInput = {
  operation: ResearcherAiOperation;
  /** Counters in STANDALONE_RESEARCHER_AI_POLICY scope order. */
  counters: ResearcherAiCounter[];
  now: number;
};

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

/**
 * How a study list carries each study: `full` is the whole stored study (the
 * legacy GET /api/studies response); `summary` is a list item without the
 * configuration beyond its name and description (ST-08).
 */
export type StudyListView = 'full' | 'summary';
export type StudyListEntry<V extends StudyListView> = V extends 'summary' ? StudyListItem : StoredStudy;

export type ListInterviewsInput =
  | { scope: 'study'; studyId: string; maximum: number }
  | { scope: 'all'; maximum: number };

export interface WorkspaceStorePort {
  readonly backend: WorkspaceBackend;

  readiness(): Promise<StoreReadiness>;

  getStudy(studyId: string): Promise<StudyLoadResult>;
  /** Newest first, in the requested view; more than `maximum` is too-large. */
  listStudies<V extends StudyListView>(
    maximum: number,
    options: { view: V },
  ): Promise<CollectionLoadResult<StudyListEntry<V>>>;
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
  /**
   * Check every researcher AI counter, then charge every one, atomically,
   * before a researcher-initiated provider call. A hosted store never admits
   * (`unavailable`): hosted mode keeps its platform limiter.
   */
  admitResearcherAiRequest(input: ResearcherAiAdmissionInput): Promise<AdmissionOutcome>;

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
 * The paid route aggregate inputs feed (gap F26). Aggregate synthesis ends in
 * a researcher mutation, so the object serves its inputs only while open;
 * follow-up generation writes nothing and is also served while draining.
 * Absent means `aggregate`, the stricter fence.
 */
export type AggregateInputsPurpose = 'aggregate' | 'follow-up';

/**
 * Operations only the durable workspace provides. Routes narrow with
 * `isDurableWorkspaceStore(store)`; the Redis store never implements them.
 */
export interface DurableWorkspaceStorePort extends WorkspaceStorePort {
  readonly backend: 'durable-object';
  /**
   * `budget` is the researcher `analysis` counters: the object charges them
   * only when it allocates a new generation, so a receipt replay, an existing
   * active generation or any refusal is never charged.
   */
  acceptAnalysisRetry(input: Omit<AcceptAnalysisRetryInput, 'requestKeyDigest' | 'requestFingerprint' | 'budget'> & {
    rawIdempotencyKey: string;
    apiVersion: 2;
    budget: ResearcherAiCounter[];
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
    purpose?: AggregateInputsPurpose;
  }): Promise<AggregateInputsPage>;
}

export function isDurableWorkspaceStore(store: WorkspaceStorePort): store is DurableWorkspaceStorePort {
  return store.backend === 'durable-object';
}

// ---------- Point-in-time restore (Cloudflare target only, OPS-03) ----------

/** How far back Durable Object point-in-time recovery reaches. */
export const RESTORE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const RESTORE_BOOKMARK = /^[0-9A-Za-z][0-9A-Za-z._-]{0,255}$/;

/**
 * A point-in-time recovery bookmark as the platform prints it (an opaque,
 * mostly alphanumeric string with dashes), bounded before it reaches storage.
 */
export function isRestoreBookmark(value: unknown): value is string {
  return typeof value === 'string' && RESTORE_BOOKMARK.test(value);
}

// ---------- Researcher sign-in budget (standalone, both targets; gap F5) ----------

/** Per-client attempts counted in one window opened by the first counted attempt. */
export const LOGIN_CLIENT_MAX_FAILURES = 10;
export const LOGIN_CLIENT_WINDOW_SECONDS = 15 * 60;
/** Attempts counted across every client in one window opened by the first counted attempt. */
export const LOGIN_GLOBAL_MAX_FAILURES = 200;
export const LOGIN_GLOBAL_WINDOW_SECONDS = 60 * 60;

export type LoginBudgetInput = {
  /** The request's admission identity; the client digests it before it reaches storage. */
  identity: AdmissionIdentity | null;
  now: number;
};

export type LoginBudgetAdmitOutcome =
  | { status: 'admitted' }
  | { status: 'limited'; scope: 'client' | 'global'; retryAfterSeconds: number }
  | { status: 'unavailable' };

export type LoginBudgetRefundOutcome = { status: 'refunded' } | { status: 'unavailable' };

/**
 * The failed-sign-in budget: the WorkspaceStore object on Cloudflare
 * (durableObject.ts), the deployment's Redis on Node (redisLoginBudget.ts).
 * `admitLoginAttempt` atomically refuses at the limit or counts the attempt,
 * before the password is compared; a correct password refunds it, so only
 * failures stay counted. Any doubt on admission is `unavailable` (the route
 * fails closed); a lost refund leaves the attempt counted.
 */
export interface LoginAttemptBudgetPort {
  admitLoginAttempt(input: LoginBudgetInput): Promise<LoginBudgetAdmitOutcome>;
  refundLoginAttempt(input: LoginBudgetInput): Promise<LoginBudgetRefundOutcome>;
}
