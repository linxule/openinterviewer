// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { ThinkingLevel } from '@google/genai';
import { getGeminiInterviewThinkingConfig } from '@/lib/providers/gemini';

describe('Gemini interview thinking configuration', () => {
  it('leaves Gemini 2.5 Automatic dynamic', () => {
    expect(getGeminiInterviewThinkingConfig('gemini-2.5-pro')).toEqual({});
    expect(getGeminiInterviewThinkingConfig('gemini-2.5-flash')).toEqual({});
  });

  it('uses the supported minimum instead of disabling Gemini 2.5 Pro', () => {
    expect(getGeminiInterviewThinkingConfig('gemini-2.5-pro', false)).toEqual({
      thinkingConfig: { thinkingBudget: 128 },
    });
    expect(getGeminiInterviewThinkingConfig('gemini-2.5-flash', false)).toEqual({
      thinkingConfig: { thinkingBudget: 0 },
    });
  });

  it('uses thinking levels for Gemini 3 interview models', () => {
    expect(getGeminiInterviewThinkingConfig('gemini-3.1-pro-preview', false)).toEqual({
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
    });
    expect(getGeminiInterviewThinkingConfig('gemini-3.1-pro-preview', true)).toEqual({
      thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
    });
  });
});
