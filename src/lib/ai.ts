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

// Extract the JSON payload from optional provider prose or outer code fences.
// Delimiters and markdown inside JSON strings are research content, not syntax
// to strip. Leave incomplete or mismatched JSON for the caller to reject.
export const cleanJSON = (text: string): string => {
  if (!text) return '{}';
  const cleaned = text.trim();
  const start = cleaned.search(/[\[{]/);
  if (start === -1) return cleaned;

  const closingDelimiters: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = start; i < cleaned.length; i++) {
    const character = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') inString = true;
    else if (character === '{') closingDelimiters.push('}');
    else if (character === '[') closingDelimiters.push(']');
    else if (character === '}' || character === ']') {
      if (closingDelimiters.pop() !== character) return cleaned;
      if (closingDelimiters.length === 0) return cleaned.slice(start, i + 1);
    }
  }

  return cleaned;
};
