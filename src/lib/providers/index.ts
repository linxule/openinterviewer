// AI Provider Factory
// Returns the appropriate provider based on study or environment configuration

import { AIProvider } from '../ai';
import { GeminiProvider } from './gemini';
import { ClaudeProvider } from './claude';
import { StudyConfig } from '@/types';

export type ProviderType = 'gemini' | 'claude';

// Get the interview AI provider based on configuration
// Provider priority: studyConfig.aiProvider > env.AI_PROVIDER > 'gemini'
// Model priority: studyConfig.aiModel > env.GEMINI_MODEL/CLAUDE_MODEL > env.AI_MODEL > default
export function getInterviewProvider(studyConfig?: StudyConfig): AIProvider {
  const providerType = (
    studyConfig?.aiProvider ||          // Study-level preference
    process.env.AI_PROVIDER ||          // Environment fallback
    'gemini'                            // Ultimate default
  ) as ProviderType;

  // Pass model from studyConfig (if set) to provider constructor
  const model = studyConfig?.aiModel;

  switch (providerType) {
    case 'claude':
      return new ClaudeProvider(model);
    case 'gemini':
    default:
      return new GeminiProvider(model);
  }
}

export { GeminiProvider } from './gemini';
export { ClaudeProvider } from './claude';
