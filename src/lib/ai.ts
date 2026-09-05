// AI Provider Abstraction Layer
// Supports direct native providers and the Vercel AI Gateway transport.

import {
  StudyConfig,
  ParticipantProfile,
  InterviewMessage,
  SynthesisResult,
  BehaviorData,
  AIInterviewResponse,
  QuestionProgress,
  AggregateSynthesisResult,
  AggregateSynthesisProviderPayload,
  AIProviderType,
} from '@/types';
import type { FollowupStudy } from './providerValidation';

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
  ): Promise<ProviderResult<SynthesisResult>>;

  synthesizeAggregate(
    studyConfig: StudyConfig,
    syntheses: SynthesisResult[],
    interviewCount: number
  ): Promise<ProviderResult<AggregateSynthesisProviderPayload>>;

  generateFollowupStudy(
    parentConfig: StudyConfig,
    synthesis: AggregateSynthesisResult
  ): Promise<ProviderResult<FollowupStudy>>;
}

export interface ProviderExecution {
  provider: AIProviderType;
  requestedModel: string;
  model: string;
  routedProvider?: string;
}

export interface ProviderResult<T> {
  value: T;
  execution: ProviderExecution;
}

export {
  interviewResponseSchema,
  synthesisResponseSchema,
  aggregateSynthesisResponseSchema,
  followupStudyResponseSchema,
} from './providerSchemas';

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
