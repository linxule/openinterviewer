// OpenInterviewer domain types

// ============================================
// Interview Phase & Progress Tracking
// ============================================

export type InterviewPhase =
  | 'background'      // AI gathers participant context
  | 'core-questions'  // Working through core research questions
  | 'exploration'     // Optional deeper exploration
  | 'feedback'        // Final feedback for researchers
  | 'wrap-up';        // AI concludes, interview complete

export interface QuestionProgress {
  questionsAsked: number[];  // Indices of completed questions
  total: number;
  currentPhase: InterviewPhase;
  isComplete: boolean;
}

// ============================================
// Profile Schema - Researcher-defined fields
// ============================================

export interface ProfileField {
  id: string;
  label: string;              // e.g., "Current Role"
  extractionHint: string;     // e.g., "Their job title or position"
  required: boolean;
  options?: string[];         // Optional preset options for validation
}

export type ProfileFieldStatus = 'pending' | 'extracted' | 'vague' | 'refused';

export interface ProfileFieldValue {
  fieldId: string;
  value: string | null;
  status: ProfileFieldStatus;
  extractedAt?: number;
}

export interface ParticipantProfile {
  id: string;
  fields: ProfileFieldValue[];  // Structured field values
  rawContext: string;           // Full context summary from conversation
  timestamp: number;
}

// ============================================
// Study Configuration
// ============================================

export type AIBehavior = 'structured' | 'standard' | 'exploratory';

export type AIProviderType = 'gemini' | 'claude' | 'openai' | 'openrouter';

// ============================================
// AI Model Configuration
// ============================================

export interface AIModelOption {
  id: string;
  label: string;
  desc: string;
}

// Available Gemini models
export const GEMINI_MODELS: AIModelOption[] = [
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', desc: 'Newest Flash model' },
  { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash', desc: 'Balanced capability and speed' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', desc: 'Fast, cost-effective' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', desc: 'Higher quality' },
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview', desc: 'Higher capability (preview)' },
];

// Available Claude models
export const CLAUDE_MODELS: AIModelOption[] = [
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', desc: 'Optimized for speed' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', desc: 'Balanced capability and speed' },
  { id: 'claude-opus-5', label: 'Claude Opus 5', desc: 'Highest capability' },
  { id: 'claude-fable-5', label: 'Claude Fable 5', desc: 'Creative and expressive' },
  { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', desc: 'Balanced capability and speed' },
  { id: 'claude-opus-4-5', label: 'Claude Opus 4.5', desc: 'Higher capability' },
];

// Available OpenAI Responses API models
export const OPENAI_MODELS: AIModelOption[] = [
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', desc: 'Cost-efficient' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', desc: 'Balanced capability and speed' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', desc: 'Highest capability' },
];

// Curated OpenRouter models. A bounded provider/model slug can also be entered
// by self-hosters, but automatic model routing is intentionally not supported.
export const OPENROUTER_MODELS: AIModelOption[] = [
  { id: 'openai/gpt-5.6-luna', label: 'GPT-5.6 Luna', desc: 'Cost-efficient' },
  { id: 'openai/gpt-5.6-terra', label: 'GPT-5.6 Terra', desc: 'Balanced capability and speed' },
  { id: 'openai/gpt-5.6-sol', label: 'GPT-5.6 Sol', desc: 'Highest capability' },
  { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5', desc: 'Balanced capability and speed' },
  { id: 'anthropic/claude-opus-5', label: 'Claude Opus 5', desc: 'Highest capability' },
  { id: 'google/gemini-3.7-flash', label: 'Gemini 3.7 Flash', desc: 'Fast multimodal model' },
];

// Default models for each provider
export const DEFAULT_GEMINI_MODEL = 'gemini-3.7-flash';
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5';
export const DEFAULT_OPENAI_MODEL = 'gpt-5.6-terra';
export const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-5.6-terra';

// Link expiration options
export type LinkExpirationOption = 'never' | '7days' | '30days' | '90days';

export interface StudyConfig {
  id: string;
  name: string;
  description: string;
  researchQuestion: string;
  coreQuestions: string[];
  topicAreas: string[];           // General topic areas for synthesis
  profileSchema: ProfileField[];  // Fields to collect during interview
  aiBehavior: AIBehavior;
  // Optional in the TypeScript shape only so pre-explicit-provider records can
  // be loaded for researcher repair. Canonical save/runtime validation requires
  // both fields; participant access remains blocked until a legacy study is
  // reviewed and resaved with an explicit provider and model.
  aiProvider?: AIProviderType;
  aiModel?: string;
  consentText: string;
  /**
   * Optional. Shown to participants on their submission receipt so they can
   * reach the study's data controller. Free text — a name, an address, a lab
   * page — and deliberately not format-validated: the server cannot verify a
   * contact, so it must never be presented as verified.
   */
  researcherContact?: string;
  /**
   * Optional. The researcher-authored screen a participant reads once their
   * interview is saved. Absent means "render the generated default", and
   * unlike `consentText` it is deliberately NOT frozen into the record at
   * save time: no consent hash binds it, and a stored copy would freeze one
   * deployment's default forever.
   */
  thankYouText?: string;
  createdAt: number;
  // Follow-up study lineage
  parentStudyId?: string;         // ID of parent study if this is a follow-up
  parentStudyName?: string;       // Name of parent study for display
  generatedFrom?: 'synthesis' | 'manual';  // How this study was created
  // Link management
  linksEnabled?: boolean;         // Whether participant links are active (default: true)
  linkExpiration?: LinkExpirationOption;  // When links expire (default: 'never')
  // AI Reasoning
  enableReasoning?: boolean;      // undefined=auto, true=force on, false=force off
}

// ============================================
// Interview Messages
// ============================================

export interface InterviewMessage {
  id: string;
  role: 'user' | 'ai' | 'system';
  content: string;
  timestamp: number;
}

// ============================================
// Behavior & Analysis Data
// ============================================

export interface BehaviorData {
  timePerTopic: Record<string, number>;
  messagesPerTopic: Record<string, number>;
  topicsExplored: string[];
  contradictions: string[];
}

/**
 * A citation: the model's excerpt plus the coordinate it claims the excerpt
 * came from. `turnIndex` is 1-based over the interview's `transcript` array —
 * the same number the researcher sees as `t. N` on the turn. `interviewId` is
 * omitted for citations inside a single interview's synthesis (the containing
 * record is the interview) and is set only on aggregate citations, where the
 * server resolves it. A ref is a claim, not a verified fact: see
 * src/lib/evidence.ts for how a claim is checked against the record.
 */
export interface EvidenceRef {
  quote: string;
  turnIndex: number;
  interviewId?: string;
}

export interface SynthesisTheme {
  theme: string;
  frequency: number;
  /**
   * Free-text supporting passage. Written only by syntheses produced before
   * Initiative 2. Never written by new syntheses; never rewritten on old
   * records, which are receipt-signed and immutable.
   */
  evidence?: string;
  /** Structured citations. Written by every synthesis produced after Initiative 2. */
  evidenceRefs?: EvidenceRef[];
}

export interface SynthesisResult {
  statedPreferences: string[];
  revealedPreferences: string[];
  themes: SynthesisTheme[];
  contradictions: string[];
  keyInsights: string[];
  bottomLine: string;
}

// ============================================
// App State
// ============================================

export type AppStep =
  | 'setup'        // Researcher configures study
  | 'consent'      // Participant sees consent + foreshadowing
  | 'interview'    // Main interview chat (includes background gathering)
  | 'synthesis'    // Analysis results
  | 'export';      // Export data

export type ViewMode = 'researcher' | 'participant' | 'preview';

export interface ContextEntry {
  id: string;
  text: string;
  source: 'text' | 'system';
  timestamp: number;
}

// ============================================
// AI Response Structure (for API routes)
// ============================================

export interface AIInterviewResponse {
  message: string;
  questionAddressed: number | null;     // Which core question was covered (0-indexed)
  phaseTransition: InterviewPhase | null;  // If moving to new phase
  profileUpdates: {
    fieldId: string;
    value: string | null;
    status: 'extracted' | 'vague' | 'refused';
  }[];
  shouldConclude: boolean;              // AI signals interview should end
}

// ============================================
// Interview analysis (Slice P — save first, analyze later)
// ============================================

/** How the analysis of one interview stands. Enums and counts only. */
export type InterviewAnalysisStatus = 'pending' | 'running' | 'complete' | 'failed';

/**
 * Why the last attempt produced no synthesis. Deliberately coarse: a provider
 * message, status line or payload must never reach a stored record or a
 * researcher's screen (AGENTS.md counts-only logging).
 */
export type InterviewAnalysisFailureKind =
  | 'provider'        // the call threw or returned an error
  | 'invalid-output'  // the response did not validate as a SynthesisResult
  | 'too-large'       // over MAX_ATTACHED_SYNTHESIS_BYTES
  | 'timeout'         // the deferred run outlived its lease
  | 'storage';        // the attach write failed

export interface InterviewAnalysisState {
  status: InterviewAnalysisStatus;
  attempts: number;          // completed attempts, successful or not; never decremented
  lastAttemptAt: number;     // epoch ms of the most recent attempt start
  claimId?: string;          // present only while `running`; the CAS token
  claimedAt?: number;
  failureKind?: InterviewAnalysisFailureKind;  // only when `status === 'failed'`
  studyRevision?: number;    // the revision the successful analysis ran under
}

// ============================================
// Stored Interview (Upstash Redis)
// ============================================

export interface StoredInterview {
  id: string;
  studyId: string;
  studyName: string;
  participantProfile: ParticipantProfile;
  transcript: InterviewMessage[];
  synthesis: SynthesisResult | null;
  behaviorData: BehaviorData;
  createdAt: number;
  completedAt: number;
  status: 'in_progress' | 'completed';
  studyRevision?: number;
  consentHash?: string;
  consentAcceptedAt?: number;

  /**
   * The provider and model that produced this record's SYNTHESIS, written by
   * the server at analysis time — which, because an analysis may run days
   * later and after an edit, is not necessarily the config the conversation
   * ran under. That divergence is why `conductedBy*` still exists below.
   */
  aiProvider?: AIProviderType;
  aiModel?: string;
  requestedAiModel?: string;
  routedProvider?: string;

  /**
   * The provider and model that conducted the CONVERSATION — the researcher's
   * own choice, snapshotted server-side from the canonical study config at
   * save time. Safe to treat as the model every turn used: the participant
   * session is pinned to a study revision (auth.ts), a config edit advances
   * that revision (kv.ts REPLACE_STUDY_CONFIG_SCRIPT), and a moved revision
   * refuses every participant request (researcherContext.ts) — so the config
   * cannot change inside one interview.
   *
   * This is the model that was ASKED FOR, not one a provider reported: an
   * interview turn returns no execution provenance (ai.ts AIProvider). Absent
   * on every interview saved before Slice O; render those as "not recorded"
   * and never fill them in from the study's current config.
   */
  conductedByProvider?: AIProviderType;
  conductedByModel?: string;

  /**
   * Absent on every record written before Slice P. Read it through
   * `analysisStatus()` (src/lib/analysisState.ts), never directly: a legacy
   * record's status is derived from whether it carries a synthesis.
   */
  analysis?: InterviewAnalysisState;

  participantLinkId?: string;
}

// ============================================
// Researcher Account (Platform DB - Hosted Mode)
// ============================================

export interface ResearcherAccount {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  oauthProvider: 'google' | 'github';
  oauthId: string;
  createdAt: number;
  lastLoginAt: number;
  onboardingComplete: boolean;

  // Encrypted credentials — never sent to client
  encryptedRedisUrl: string | null;
  encryptedRedisToken: string | null;
  encryptedGeminiApiKey: string | null;
  encryptedAnthropicApiKey: string | null;
  encryptedOpenAiApiKey?: string | null;
  encryptedOpenRouterApiKey?: string | null;

  redisConfiguredAt: number | null;
  // Monotonic CAS value for credential/onboarding lifecycle mutations.
  // Accounts created before this field existed are treated as revision 0.
  credentialRevision?: number;
}

// Safe subset for client-side display
export interface ResearcherProfile {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  onboardingComplete: boolean;
  hasRedisConfigured: boolean;
  hasGeminiKey: boolean;
  hasAnthropicKey: boolean;
  hasOpenAiKey?: boolean;
  hasOpenRouterKey?: boolean;
}

// ============================================
// Stored Study (Upstash Redis)
// ============================================

export interface StoredStudy {
  id: string;                    // Server-assigned UUID
  config: StudyConfig;           // Full study configuration
  createdAt: number;
  updatedAt: number;
  interviewCount: number;        // Cached count for dashboard display
  isLocked: boolean;             // True after first interview collected
  revision: number;              // Monotonic config/link-status revision
}

export interface PendingStudyStub {
  id: string;
  reconciliationPending: true;
  operationId: string;
  phase: string;
}

export type StudyWorkspaceItem = StoredStudy | PendingStudyStub;

export function isPendingStudyStub(study: StudyWorkspaceItem): study is PendingStudyStub {
  return 'reconciliationPending' in study && study.reconciliationPending === true;
}

// ============================================
// Aggregate Synthesis (Cross-Interview)
// ============================================

/**
 * An aggregate citation as the MODEL returns it. The interview is named by its
 * 1-based position in the prompt's interview list — never by id. The server
 * owns the position→id mapping; see src/app/api/synthesis/aggregate/route.ts.
 */
export interface AggregateQuoteClaim {
  quote: string;
  turnIndex: number;
  interviewIndex: number;
}

/** A common theme as the model returns it, before the server resolves ids. */
export interface AggregateThemeClaim {
  theme: string;
  frequency: number;
  /** Positions in the prompt catalogue. Empty is honest and expected. */
  quoteRefs: AggregateQuoteClaim[];
}

export interface AggregateTheme {
  theme: string;
  frequency: number;
  /**
   * Free-text quotes composed by the model from interview summaries. Written
   * only by aggregates generated before Slice L. Optional since Slice L; the
   * aggregate is never persisted, so this shape survives only in a browser tab
   * held open across a deploy (see generate-followup, L12).
   */
  representativeQuotes?: string[];
  /**
   * Structured citations, each carrying the interviewId the SERVER resolved
   * from the model's catalogue position. A ref is a claim, not a verified
   * fact: src/lib/evidence.ts checks it against the record at render time.
   */
  quoteRefs?: EvidenceRef[];
}

export interface AggregateSynthesisResult {
  studyId: string;
  studyRevision: number;
  interviewIds: string[];
  interviewCount: number;
  aiProvider: AIProviderType;
  aiModel: string;
  requestedAiModel?: string;
  routedProvider?: string;
  commonThemes: AggregateTheme[];
  divergentViews: { topic: string; viewA: string; viewB: string }[];
  keyFindings: string[];
  researchImplications: string[];
  bottomLine: string;           // One-paragraph summary of all interviews
  generatedAt: number;
  /**
   * Server clock at the moment this aggregate was written to the researcher's
   * database. Present exactly when the record is stored: a response carrying
   * no `savedAt` was generated and not saved, and the footer says so. Never
   * client-supplied.
   */
  savedAt?: number;
}

/**
 * The aggregate as it is stored: the verified facts plus the server's write
 * timestamp.
 */
export type StoredAggregateSynthesis =
  AggregateSynthesisResult & { savedAt: number };

/** What an AIProvider returns for an aggregate: ids are not resolved yet. */
export type AggregateSynthesisProviderPayload = Omit<
  AggregateSynthesisResult,
  | 'studyId' | 'studyRevision' | 'interviewIds' | 'interviewCount'
  | 'aiProvider' | 'aiModel' | 'requestedAiModel' | 'routedProvider'
  | 'generatedAt' | 'commonThemes'
> & { commonThemes: AggregateThemeClaim[] };
