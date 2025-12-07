// AI Provider Factory
// Returns the appropriate provider based on study or environment configuration

import { AIProvider } from '../ai';
import { GeminiProvider } from './gemini';
import { ClaudeProvider } from './claude';
import { StudyConfig } from '@/types';

export type ProviderType = 'gemini' | 'claude';

// Get the interview AI provider based on configuration
// Priority: studyConfig.aiProvider > env.AI_PROVIDER > 'gemini'
export function getInterviewProvider(studyConfig?: StudyConfig): AIProvider {
  const providerType = (
    studyConfig?.aiProvider ||          // Study-level preference
    process.env.AI_PROVIDER ||          // Environment fallback
    'gemini'                            // Ultimate default
  ) as ProviderType;

  switch (providerType) {
    case 'claude':
      return new ClaudeProvider();
    case 'gemini':
    default:
      return new GeminiProvider();
  }
}

// Speech (STT/TTS) always uses Gemini for best cost/capability
// This returns a Gemini-specific client for speech operations
export function getSpeechProvider() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is required for speech services');
  }

  // Import dynamically to avoid issues when Gemini isn't needed
  const { GoogleGenAI } = require('@google/genai');
  return new GoogleGenAI({ apiKey });
}

export { GeminiProvider } from './gemini';
export { ClaudeProvider } from './claude';
