import type { EvidenceRef, ProfileField, StoredInterview, StudyConfig } from '@/types';
import type { ProviderExecution } from '@/lib/ai';

export type RecordedProfileFilter =
  | { fieldId: string; operator: 'equals'; value: string }
  | { fieldId: string; operator: 'one-of'; values: string[] }
  | { fieldId: string; operator: 'number-between'; minimum: number; maximum: number };

export interface DatasetSelection {
  interviewIds?: string[];
  revisions?: number[];
  filters?: RecordedProfileFilter[];
}

export interface DatasetSource {
  interviewId: string;
  studyRevision: number | null;
  contentHash: string;
}

export interface DatasetManifest {
  studyId: string;
  selection: DatasetSelection;
  sources: DatasetSource[];
  totalSaved: number;
  selectedCount: number;
  excludedCount: number;
  unknownProfileCount: number;
  pendingAnalysisCount: number;
  sourceFingerprint: string;
}

export interface DatasetDescription {
  manifest: DatasetManifest;
  revisions: Array<{ revision: number | null; count: number; analyzedCount: number }>;
  profileFields: ProfileField[];
  historicalProfileUnknownCount: number;
  /** These IDs have conflicting original definitions; narrow revisions to filter safely. */
  ambiguousProfileFieldIds?: string[];
}

/** Provider positions are resolved by the server; no model-supplied record ids. */
export interface ExplorationQuoteClaim {
  interviewIndex: number;
  turnIndex: number;
  quote: string;
}

export interface ExplorationFinding<Ref = EvidenceRef> {
  heading: string;
  interpretation: string;
  supporting: Ref[];
  challenging: Ref[];
  uncertain: Ref[];
}

export interface ExplorationResponse<Ref = EvidenceRef> {
  answer: string;
  findings: Array<ExplorationFinding<Ref>>;
  limitations: string[];
}

export type ExplorationProviderPayload = ExplorationResponse<ExplorationQuoteClaim>;

export interface ExplorationProviderInput {
  question: string;
  studyConfig: StudyConfig;
  interviews: StoredInterview[];
  /** Previous questions provide continuity, never substitute for source records. */
  previousQuestions?: string[];
}

export type ExplorationStatus = 'running' | 'complete' | 'failed' | 'recovery-required';

export interface ExplorationAnswer {
  id: string;
  studyId: string;
  question: string;
  parentAnswerId?: string;
  scope: DatasetManifest;
  createdAt: number;
  updatedAt: number;
  status: ExplorationStatus;
  requestFingerprint: string;
  result?: ExplorationResponse;
  execution?: ProviderExecution;
  failureKind?: string;
  promptVersion: 1;
}

export interface ExplorationReservation {
  answer: ExplorationAnswer;
  keyDigest: string;
  expectedStudyRevision: number;
}

export type ExplorationReserveOutcome =
  | { status: 'created' | 'replay'; answer: ExplorationAnswer }
  | { status: 'key-reuse' | 'quota' | 'study-not-found' | 'revision-stale' | 'held' | 'unavailable' };

export type ExplorationReadOutcome =
  | { status: 'found'; answer: ExplorationAnswer }
  | { status: 'not-found' | 'unavailable' };

export type ExplorationLookupOutcome =
  | { status: 'found'; answer: ExplorationAnswer }
  | { status: 'not-found' | 'key-reuse' | 'unavailable' };

export type ExplorationListOutcome =
  | { status: 'ok'; answers: ExplorationAnswer[]; nextCursor?: string | null }
  | { status: 'too-large' | 'unavailable' };

export interface CompleteExplorationInput {
  studyId: string;
  answerId: string;
  requestFingerprint: string;
  result: ExplorationResponse;
  execution: ProviderExecution;
  now: number;
}

export interface FailExplorationInput {
  studyId: string;
  answerId: string;
  requestFingerprint: string;
  status: 'failed' | 'recovery-required';
  failureKind: string;
  now: number;
}

export type ExplorationWriteOutcome =
  | { status: 'saved'; answer: ExplorationAnswer }
  | { status: 'study-not-found' | 'not-found' | 'conflict' | 'held' | 'unavailable' };

/** Optional capability on old test adapters; production backends implement it. */
export interface ExplorationStorePort {
  /** Replay lookup precedes current-corpus/provider preflight; never admits work. */
  lookup?(input: { studyId: string; keyDigest: string; requestFingerprint: string }): Promise<ExplorationLookupOutcome>;
  reserve(input: ExplorationReservation): Promise<ExplorationReserveOutcome>;
  get(input: { studyId: string; answerId: string }): Promise<ExplorationReadOutcome>;
  list(input: { studyId: string; maximum: number; pageSize?: number; cursor?: string }): Promise<ExplorationListOutcome>;
  complete(input: CompleteExplorationInput): Promise<ExplorationWriteOutcome>;
  fail(input: FailExplorationInput): Promise<ExplorationWriteOutcome>;
}

export const MAX_EXPLORATION_ANSWERS = 500;
export const MAX_EXPLORATION_SELECTED_INTERVIEWS = 100;
export const MAX_EXPLORATION_CORPUS_BYTES = 256 * 1024;
/** Corpus plus the current study context, question, continuity and system instructions. */
export const MAX_EXPLORATION_PROMPT_BYTES = 320 * 1024;
export const MAX_EXPLORATION_QUESTION_CHARS = 2_000;
export const EXPLORATION_ATTEMPT_DEADLINE_MS = 120_000;
