'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import {
  AppStep,
  ViewMode,
  StudyConfig,
  ParticipantProfile,
  InterviewMessage,
  BehaviorData,
  SynthesisResult,
  ContextEntry,
  QuestionProgress,
  InterviewPhase,
  ProfileFieldStatus,
  ProfileField
} from './types';

// Example Study: "The Adaptive Self"
const EXAMPLE_STUDY: Omit<StudyConfig, 'id' | 'createdAt'> = {
  name: 'The Adaptive Self: Professional Identity in the Age of AI',
  description: 'This study explores how professionals across industries are rewriting their career narratives in response to AI. It investigates shifts in how workers perceive their value, future relevance, and the changing definition of expertise.',
  researchQuestion: 'How does the integration of generative AI into the workspace reshape an individual\'s sense of professional agency, creative identity, and long-term career planning?',
  coreQuestions: [
    'When you look at tasks you used to consider "highly skilled" or "uniquely yours," how has your perspective on them changed since tools like ChatGPT emerged?',
    'Can you describe a specific moment where you felt either significantly empowered by AI or, conversely, diminished by its capabilities?',
    'If you project your career forward five years, what human qualities do you believe will become your most valuable currency?',
    'There\'s often a gap between how we talk about AI publicly (efficiency!) and how we feel privately (uncertainty). Do you feel that tension?',
    'You\'re currently discussing AI\'s impact with an AI. Does this feel like collaboration, utility, or something else entirely?'
  ],
  topicAreas: [
    'The "Hollow Middle" - fears about disappearing entry-level work',
    'Creative Authenticity - ownership over AI-assisted work',
    'The Cyborg Identity - where "me" ends and "the tool" begins',
    'Social Comparison - peers adopting faster/slower',
    'Meaning of Work - satisfaction from process vs outcome'
  ],
  profileSchema: [
    {
      id: 'role',
      label: 'Current Role',
      extractionHint: 'Their job title or professional role',
      required: true
    },
    {
      id: 'ai_usage',
      label: 'AI Tool Usage',
      extractionHint: 'How frequently they use AI tools (daily, weekly, rarely, never)',
      required: true,
      options: ['Daily', 'Weekly', 'Monthly', 'Rarely', 'Never']
    },
    {
      id: 'ai_comfort',
      label: 'Comfort with AI',
      extractionHint: 'Their comfort level working alongside AI (scale: low/medium/high)',
      required: false,
      options: ['Low', 'Medium', 'High']
    }
  ],
  aiBehavior: 'standard',
  consentText: 'Welcome to The Adaptive Self study.\n\nBefore we begin, please understand you will be interviewed by an AI research assistant, not a human.\n\nThe purpose is to understand your personal thoughts and experiences regarding AI and your career. There are no right or wrong answers—we\'re interested in nuance: your hopes, anxieties, and honest reflections.\n\nYour responses will be anonymized and analyzed for research themes. You may decline any question or end the session anytime.\n\nBy proceeding, you acknowledge you\'re interacting with an AI and consent to this conversation being collected for research purposes.'
};

// Initial question progress state
const initialQuestionProgress: QuestionProgress = {
  questionsAsked: [],
  total: 0,
  currentPhase: 'background',
  isComplete: false
};

// Initial behavior data
const initialBehaviorData: BehaviorData = {
  timePerTopic: {},
  messagesPerTopic: {},
  topicsExplored: [],
  contradictions: []
};

interface ResearchState {
  // Navigation
  currentStep: AppStep;
  previousStep: AppStep | null;
  viewMode: ViewMode;

  // Study Configuration (Researcher-defined)
  studyConfig: StudyConfig | null;

  // Participant Data
  participantProfile: ParticipantProfile | null;
  consentGiven: boolean;
  consentTimestamp: number | null;

  // Interview Progress
  questionProgress: QuestionProgress;
  interviewHistory: InterviewMessage[];

  // Behavior Tracking
  behaviorData: BehaviorData;

  // Synthesis
  synthesis: SynthesisResult | null;

  // Context & Voice
  contextEntries: ContextEntry[];
  isRecording: boolean;
  streamingMessage: string | null;
  isAiThinking: boolean;

  // Participant Token (for URL-based study config)
  participantToken: string | null;

  // Actions - Navigation
  setStep: (step: AppStep) => void;
  setViewMode: (mode: ViewMode) => void;

  // Actions - Study Config
  setStudyConfig: (config: StudyConfig) => void;
  loadExampleStudy: () => void;

  // Actions - Consent & Profile
  giveConsent: () => void;
  initializeProfile: (schema: ProfileField[]) => void;
  updateProfileField: (fieldId: string, value: string | null, status: ProfileFieldStatus) => void;
  setProfileRawContext: (context: string) => void;

  // Actions - Interview Progress
  setInterviewPhase: (phase: InterviewPhase) => void;
  markQuestionAsked: (questionIndex: number) => void;
  completeInterview: () => void;
  addMessage: (message: InterviewMessage) => void;

  // Actions - Context
  appendContext: (text: string, source: 'voice' | 'text' | 'system') => void;
  clearContext: () => void;

  // Actions - AI State
  setRecording: (recording: boolean) => void;
  setStreamingMessage: (msg: string | null) => void;
  setAiThinking: (thinking: boolean) => void;

  // Actions - Synthesis
  setSynthesis: (result: SynthesisResult) => void;

  // Actions - Behavior Data
  setBehaviorData: (data: BehaviorData) => void;

  // Actions - Token
  setParticipantToken: (token: string | null) => void;

  // Actions - Reset
  reset: () => void;
  resetParticipant: () => void;
}

export const useStore = create<ResearchState>()(
  persist(
    (set) => ({
      currentStep: 'setup',
      previousStep: null,
      viewMode: 'researcher',
      studyConfig: null,
      participantProfile: null,
      consentGiven: false,
      consentTimestamp: null,
      questionProgress: initialQuestionProgress,
      interviewHistory: [],
      behaviorData: initialBehaviorData,
      synthesis: null,
      contextEntries: [],
      isRecording: false,
      streamingMessage: null,
      isAiThinking: false,
      participantToken: null,

      setStep: (step) => set((state) => ({
        previousStep: state.currentStep,
        currentStep: step
      })),

      setViewMode: (mode) => set({ viewMode: mode }),

      setStudyConfig: (config) => set({ studyConfig: config }),

      loadExampleStudy: () => set({
        studyConfig: {
          ...EXAMPLE_STUDY,
          id: `study-${Date.now()}`,
          createdAt: Date.now()
        }
      }),

      giveConsent: () => set({
        consentGiven: true,
        consentTimestamp: Date.now()
      }),

      initializeProfile: (schema) => set({
        participantProfile: {
          id: `p-${Date.now()}`,
          fields: schema.map(field => ({
            fieldId: field.id,
            value: null,
            status: 'pending' as ProfileFieldStatus
          })),
          rawContext: '',
          timestamp: Date.now()
        },
        questionProgress: {
          questionsAsked: [],
          total: 0,
          currentPhase: 'background',
          isComplete: false
        }
      }),

      updateProfileField: (fieldId, value, status) => set((state) => {
        if (!state.participantProfile) return state;
        return {
          participantProfile: {
            ...state.participantProfile,
            fields: state.participantProfile.fields.map(f =>
              f.fieldId === fieldId
                ? { ...f, value, status, extractedAt: Date.now() }
                : f
            )
          }
        };
      }),

      setProfileRawContext: (context) => set((state) => {
        if (!state.participantProfile) return state;
        return {
          participantProfile: {
            ...state.participantProfile,
            rawContext: context
          }
        };
      }),

      setInterviewPhase: (phase) => set((state) => ({
        questionProgress: {
          ...state.questionProgress,
          currentPhase: phase
        }
      })),

      markQuestionAsked: (questionIndex) => set((state) => {
        const alreadyAsked = state.questionProgress.questionsAsked.includes(questionIndex);
        if (alreadyAsked) return state;
        return {
          questionProgress: {
            ...state.questionProgress,
            questionsAsked: [...state.questionProgress.questionsAsked, questionIndex]
          }
        };
      }),

      completeInterview: () => set((state) => ({
        questionProgress: {
          ...state.questionProgress,
          currentPhase: 'wrap-up',
          isComplete: true
        }
      })),

      addMessage: (message) => set((state) => {
        const phase = state.questionProgress.currentPhase;
        const currentCount = state.behaviorData.messagesPerTopic[phase] || 0;
        return {
          interviewHistory: [...state.interviewHistory, message],
          behaviorData: {
            ...state.behaviorData,
            messagesPerTopic: {
              ...state.behaviorData.messagesPerTopic,
              [phase]: currentCount + 1
            }
          }
        };
      }),

      appendContext: (text, source) => set((state) => {
        const newEntry: ContextEntry = {
          id: `ctx-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
          text: text.trim(),
          source,
          timestamp: Date.now()
        };
        return { contextEntries: [...state.contextEntries, newEntry] };
      }),

      clearContext: () => set({ contextEntries: [] }),

      setRecording: (recording) => set({ isRecording: recording }),
      setStreamingMessage: (msg) => set({ streamingMessage: msg }),
      setAiThinking: (thinking) => set({ isAiThinking: thinking }),

      setSynthesis: (result) => set({ synthesis: result }),

      setBehaviorData: (data) => set({ behaviorData: data }),

      setParticipantToken: (token) => set({ participantToken: token }),

      reset: () => set({
        currentStep: 'setup',
        previousStep: null,
        viewMode: 'researcher',
        studyConfig: null,
        participantProfile: null,
        consentGiven: false,
        consentTimestamp: null,
        questionProgress: initialQuestionProgress,
        interviewHistory: [],
        behaviorData: initialBehaviorData,
        synthesis: null,
        contextEntries: [],
        isRecording: false,
        streamingMessage: null,
        isAiThinking: false,
        participantToken: null
      }),

      resetParticipant: () => set((state) => ({
        participantProfile: null,
        consentGiven: false,
        consentTimestamp: null,
        questionProgress: initialQuestionProgress,
        interviewHistory: [],
        behaviorData: initialBehaviorData,
        synthesis: null,
        contextEntries: [],
        currentStep: state.studyConfig ? 'consent' : 'setup'
      }))
    }),
    {
      name: 'research-tool-storage',
      storage: createJSONStorage(() => sessionStorage),
      version: 3,
      partialize: (state) => ({
        viewMode: state.viewMode,
        studyConfig: state.studyConfig,
        participantProfile: state.participantProfile,
        consentGiven: state.consentGiven,
        consentTimestamp: state.consentTimestamp,
        questionProgress: state.questionProgress,
        interviewHistory: state.interviewHistory,
        behaviorData: state.behaviorData,
        synthesis: state.synthesis,
        contextEntries: state.contextEntries,
        currentStep: state.currentStep,
        participantToken: state.participantToken
      })
    }
  )
);
