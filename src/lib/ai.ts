// AI Provider Abstraction Layer
// Supports Gemini (default) and Claude for interview AI
// Speech (STT/TTS) always uses Gemini for best cost/capability

import {
  StudyConfig,
  ParticipantProfile,
  InterviewMessage,
  SynthesisResult,
  BehaviorData,
  AIInterviewResponse,
  QuestionProgress,
  AggregateSynthesisResult
} from '@/types';

// Re-export prompts from centralized location
// See src/lib/prompts/ for customization
export {
  buildInterviewSystemPrompt,
  getAIBehaviorInstruction,
  formatProfileFields
} from './prompts';

// Provider interface for interview AI
export interface AIProvider {
  generateInterviewResponse(
    history: InterviewMessage[],
    studyConfig: StudyConfig,
    participantProfile: ParticipantProfile | null,
    questionProgress: QuestionProgress,
    currentContext: string
  ): Promise<AIInterviewResponse>;

  getInterviewGreeting(studyConfig: StudyConfig): Promise<string>;

  synthesizeInterview(
    history: InterviewMessage[],
    studyConfig: StudyConfig,
    behaviorData: BehaviorData,
    participantProfile: ParticipantProfile | null
  ): Promise<SynthesisResult>;

  synthesizeAggregate(
    studyConfig: StudyConfig,
    syntheses: SynthesisResult[],
    interviewCount: number
  ): Promise<Omit<AggregateSynthesisResult, 'studyId' | 'interviewCount' | 'generatedAt'>>;

  generateFollowupStudy(
    parentConfig: StudyConfig,
    synthesis: AggregateSynthesisResult
  ): Promise<{ name: string; researchQuestion: string; coreQuestions: string[] }>;
}

// Response schema for structured output (Gemini format)
export const interviewResponseSchema = {
  type: 'OBJECT' as const,
  properties: {
    message: {
      type: 'STRING' as const,
      description: 'Your response to the participant'
    },
    questionAddressed: {
      type: 'NUMBER' as const,
      nullable: true,
      description: '0-based index of core question substantially addressed in this exchange, or null'
    },
    phaseTransition: {
      type: 'STRING' as const,
      nullable: true,
      enum: ['background', 'core-questions', 'exploration', 'feedback', 'wrap-up'],
      description: 'If interview should move to a new phase, specify it'
    },
    profileUpdates: {
      type: 'ARRAY' as const,
      items: {
        type: 'OBJECT' as const,
        properties: {
          fieldId: { type: 'STRING' as const },
          value: { type: 'STRING' as const, nullable: true },
          status: {
            type: 'STRING' as const,
            enum: ['extracted', 'vague', 'refused']
          }
        },
        required: ['fieldId', 'status']
      },
      description: 'Profile fields extracted or updated from user response'
    },
    shouldConclude: {
      type: 'BOOLEAN' as const,
      description: 'True if interview should end (after wrap-up message)'
    }
  },
  required: ['message', 'profileUpdates', 'shouldConclude']
};

// Synthesis response schema
export const synthesisResponseSchema = {
  type: 'OBJECT' as const,
  properties: {
    statedPreferences: {
      type: 'ARRAY' as const,
      items: { type: 'STRING' as const },
      description: 'What participant explicitly said they value/want'
    },
    revealedPreferences: {
      type: 'ARRAY' as const,
      items: { type: 'STRING' as const },
      description: 'What their behavior/emphasis revealed'
    },
    themes: {
      type: 'ARRAY' as const,
      items: {
        type: 'OBJECT' as const,
        properties: {
          theme: { type: 'STRING' as const },
          evidence: { type: 'STRING' as const },
          frequency: { type: 'NUMBER' as const }
        }
      }
    },
    contradictions: {
      type: 'ARRAY' as const,
      items: { type: 'STRING' as const }
    },
    keyInsights: {
      type: 'ARRAY' as const,
      items: { type: 'STRING' as const }
    },
    bottomLine: {
      type: 'STRING' as const,
      description: 'One-sentence summary insight for the researcher'
    }
  },
  required: ['statedPreferences', 'revealedPreferences', 'themes', 'keyInsights', 'bottomLine']
};

// Clean JSON from AI response
export const cleanJSON = (text: string): string => {
  if (!text) return '{}';
  let cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

  const firstBracket = cleaned.indexOf('[');
  const firstBrace = cleaned.indexOf('{');

  if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
    let depth = 0;
    for (let i = firstBracket; i < cleaned.length; i++) {
      if (cleaned[i] === '[') depth++;
      if (cleaned[i] === ']') depth--;
      if (depth === 0) return cleaned.substring(firstBracket, i + 1);
    }
  }

  if (firstBrace !== -1) {
    let depth = 0;
    for (let i = firstBrace; i < cleaned.length; i++) {
      if (cleaned[i] === '{') depth++;
      if (cleaned[i] === '}') depth--;
      if (depth === 0) return cleaned.substring(firstBrace, i + 1);
    }
  }

  return cleaned;
};

// Default fallback responses
export const defaultInterviewResponse: AIInterviewResponse = {
  message: "I appreciate you sharing that. What else comes to mind?",
  questionAddressed: null,
  phaseTransition: null,
  profileUpdates: [],
  shouldConclude: false
};

export const defaultSynthesisResult: SynthesisResult = {
  statedPreferences: [],
  revealedPreferences: [],
  themes: [],
  contradictions: [],
  keyInsights: ['Analysis pending...'],
  bottomLine: 'Interview synthesis in progress.'
};

// Aggregate synthesis response schema (Gemini format)
export const aggregateSynthesisResponseSchema = {
  type: 'OBJECT' as const,
  properties: {
    commonThemes: {
      type: 'ARRAY' as const,
      items: {
        type: 'OBJECT' as const,
        properties: {
          theme: { type: 'STRING' as const },
          frequency: { type: 'NUMBER' as const },
          representativeQuotes: {
            type: 'ARRAY' as const,
            items: { type: 'STRING' as const }
          }
        }
      },
      description: 'Patterns appearing across multiple interviews'
    },
    divergentViews: {
      type: 'ARRAY' as const,
      items: {
        type: 'OBJECT' as const,
        properties: {
          topic: { type: 'STRING' as const },
          viewA: { type: 'STRING' as const },
          viewB: { type: 'STRING' as const }
        }
      },
      description: 'Areas where participants had different perspectives'
    },
    keyFindings: {
      type: 'ARRAY' as const,
      items: { type: 'STRING' as const },
      description: 'Major discoveries that answer the research question'
    },
    researchImplications: {
      type: 'ARRAY' as const,
      items: { type: 'STRING' as const },
      description: 'What these findings mean for the field/practice'
    },
    bottomLine: {
      type: 'STRING' as const,
      description: 'One paragraph summarizing key takeaways from all interviews'
    }
  },
  required: ['commonThemes', 'keyFindings', 'bottomLine']
};

// Default fallback for aggregate synthesis
export const defaultAggregateSynthesisResult = {
  commonThemes: [],
  divergentViews: [],
  keyFindings: ['Analysis pending...'],
  researchImplications: [],
  bottomLine: 'Aggregate synthesis in progress.'
};
