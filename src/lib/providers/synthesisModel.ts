import type { AIProviderType, StudyConfig } from '@/types';

export type ProviderType = AIProviderType;

export const PROVIDER_TYPES: readonly ProviderType[] = [
  'gemini',
  'claude',
  'openai',
  'openrouter',
];

export function isProviderType(value: unknown): value is ProviderType {
  return typeof value === 'string' && (PROVIDER_TYPES as readonly string[]).includes(value);
}

/**
 * Every synthesis-family operation (per-interview synthesis, aggregate
 * synthesis, follow-up study generation) uses the study's own configured
 * model — the researcher's own choice — never a fixed per-provider override.
 * Fails closed: a study missing an explicit model must never fall back to a
 * default (AGENTS.md "never substitute a plausible ... synthesis").
 */
export function resolveSynthesisModel(
  studyConfig: Pick<StudyConfig, 'aiProvider' | 'aiModel'>,
): string {
  if (!studyConfig.aiModel) {
    throw new Error('Study is missing an explicit AI model required for synthesis');
  }
  return studyConfig.aiModel;
}
