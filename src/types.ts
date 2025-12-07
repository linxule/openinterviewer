// Research Interview Tool Types

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

export type AIProviderType = 'gemini' | 'claude';

// ============================================
// Voice Configuration
// ============================================

// Available Gemini Live API voices
export type VoiceName = 'Puck' | 'Charon' | 'Kore' | 'Fenrir' | 'Zephyr';

export interface VoiceConfig {
  ttsEnabled: boolean;           // Researcher: allow AI to speak
  ttsVoice: VoiceName;           // Voice name (Puck, Charon, Kore, etc.)
  sttEnabled: boolean;           // Allow speech input (usually true)
}

// Track participant audio preferences (for research insights)
export interface ParticipantAudioPreference {
  initialChoice: 'voice' | 'text-only';  // How they started
  wantsToHear: boolean;                   // Current TTS preference
  changedMidInterview: boolean;           // Did they toggle?
  toggleCount: number;                    // How many times toggled
  totalAudioDuration?: number;            // Seconds of AI audio played
}

export interface StudyConfig {
  id: string;
  name: string;
  description: string;
  researchQuestion: string;
  coreQuestions: string[];
  topicAreas: string[];           // General topic areas for synthesis
  profileSchema: ProfileField[];  // Fields to collect during interview
  aiBehavior: AIBehavior;
  aiProvider?: AIProviderType;    // Optional, defaults to env or 'gemini'
  voiceConfig?: VoiceConfig;      // Optional voice/audio settings
  consentText: string;
  createdAt: number;
  // Follow-up study lineage
  parentStudyId?: string;         // ID of parent study if this is a follow-up
  parentStudyName?: string;       // Name of parent study for display
  generatedFrom?: 'synthesis' | 'manual';  // How this study was created
}

// ============================================
// Interview Messages
// ============================================

export interface InterviewMessage {
  id: string;
  role: 'user' | 'ai' | 'system';
  content: string;
  timestamp: number;
  isVoice?: boolean;
}

// ============================================
// Behavior & Analysis Data
// ============================================

export interface BehaviorData {
  timePerTopic: Record<string, number>;
  messagesPerTopic: Record<string, number>;
  topicsExplored: string[];
  contradictions: string[];
  audioPreference?: ParticipantAudioPreference;  // Voice/audio tracking
}

export interface SynthesisResult {
  statedPreferences: string[];
  revealedPreferences: string[];
  themes: { theme: string; evidence: string; frequency: number }[];
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

export type ViewMode = 'researcher' | 'participant';

export interface ContextEntry {
  id: string;
  text: string;
  source: 'voice' | 'text' | 'system';
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
// Stored Interview (Vercel KV)
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
}

// ============================================
// Participant Token (URL)
// ============================================

export interface ParticipantToken {
  studyId: string;
  studyConfig: StudyConfig;
  createdAt: number;
  expiresAt?: number;
}

// ============================================
// Stored Study (Vercel KV)
// ============================================

export interface StoredStudy {
  id: string;                    // Server-assigned UUID
  config: StudyConfig;           // Full study configuration
  createdAt: number;
  updatedAt: number;
  interviewCount: number;        // Cached count for dashboard display
  isLocked: boolean;             // True after first interview collected
}

// ============================================
// Aggregate Synthesis (Cross-Interview)
// ============================================

export interface AggregateSynthesisResult {
  studyId: string;
  interviewCount: number;
  commonThemes: { theme: string; frequency: number; representativeQuotes: string[] }[];
  divergentViews: { topic: string; viewA: string; viewB: string }[];
  keyFindings: string[];
  researchImplications: string[];
  bottomLine: string;           // One-paragraph summary of all interviews
  generatedAt: number;
}
