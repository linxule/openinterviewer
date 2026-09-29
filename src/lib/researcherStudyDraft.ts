import type { StudyConfig } from '@/types';
import { DEFAULT_MODEL_BY_PROVIDER } from '@/lib/providerRegistry';
import { DEFAULT_PROVIDER_COMMITMENT } from '@/lib/providerCommitment';

export type StudySetupIntent = 'create' | 'edit' | 'duplicate' | 'followup';

export function studySetupIntent(prefill: string | null): StudySetupIntent {
  return prefill === 'edit' || prefill === 'duplicate' || prefill === 'followup' ? prefill : 'create';
}

/** Legacy generated follow-up links omit their source ID; scope their draft by its lineage. */
export function followupDraftSourceId(): string | null {
  try {
    const config = JSON.parse(sessionStorage.getItem('prefillStudyConfig') ?? 'null');
    return typeof config?.parentStudyId === 'string' ? config.parentStudyId : null;
  } catch { return null; }
}

export function researcherDraftKey(intent: StudySetupIntent, studyId: string | null): string {
  return `oi:study-draft:v1:${intent}:${studyId ?? 'new'}`;
}

/** Only editable protocol fields cross a duplicate/draft boundary. Never records or authority. */
export function copyStudyConfiguration(config: Partial<StudyConfig>): StudyConfig {
  const provider = config.aiProvider ?? 'gemini';
  return {
    id: `study-${Date.now()}`,
    createdAt: Date.now(),
    name: config.name ?? '',
    description: config.description ?? '',
    researchQuestion: config.researchQuestion ?? '',
    coreQuestions: [...(config.coreQuestions ?? [''])],
    topicAreas: [...(config.topicAreas ?? [''])],
    profileSchema: (config.profileSchema ?? []).map(field => ({
      id: field.id, label: field.label, extractionHint: field.extractionHint, required: field.required,
      ...(field.options ? { options: [...field.options] } : {}),
    })),
    aiBehavior: config.aiBehavior ?? 'standard',
    aiProvider: provider,
    aiModel: config.aiModel ?? DEFAULT_MODEL_BY_PROVIDER[provider],
    aiProviderCommitment: config.aiProviderCommitment ?? DEFAULT_PROVIDER_COMMITMENT,
    enableReasoning: config.enableReasoning,
    linkExpiration: config.linkExpiration ?? '30days',
    linksEnabled: true,
    consentText: config.consentText ?? '',
    researcherContact: config.researcherContact ?? '',
    thankYouText: config.thankYouText ?? '',
    interviewerInstructions: config.interviewerInstructions ?? '',
  };
}

type StoredDraft = { version: 1; config: StudyConfig; revision: number | null };

export function readResearcherDraft(key: string): StoredDraft | null {
  try {
    const stored = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (stored?.version !== 1 || !stored.config || typeof stored.config !== 'object') return null;
    const config = stored.config;
    if (!['name', 'description', 'researchQuestion', 'consentText'].every(field => typeof config[field] === 'string')
      || !Array.isArray(config.coreQuestions) || !config.coreQuestions.every((value: unknown) => typeof value === 'string')
      || !Array.isArray(config.topicAreas) || !config.topicAreas.every((value: unknown) => typeof value === 'string')
      || !Array.isArray(config.profileSchema)
      || !config.profileSchema.every((field: Record<string, unknown> | null) => field && typeof field.id === 'string'
        && typeof field.label === 'string' && typeof field.extractionHint === 'string' && typeof field.required === 'boolean')
      || !['standard', 'structured', 'exploratory'].includes(config.aiBehavior)
      || !['gemini', 'claude', 'openai', 'openrouter'].includes(config.aiProvider)
      || typeof config.aiModel !== 'string'
      || !['fixed', 'may-change'].includes(config.aiProviderCommitment)
      || !['never', '7days', '30days', '90days'].includes(config.linkExpiration)
      || ['researcherContact', 'thankYouText', 'interviewerInstructions'].some(field => config[field] !== undefined && typeof config[field] !== 'string')
      || (config.enableReasoning !== undefined && typeof config.enableReasoning !== 'boolean')) return null;
    return {
      version: 1,
      config: copyStudyConfiguration(config),
      revision: Number.isSafeInteger(stored.revision) && stored.revision >= 1 ? stored.revision : null,
    };
  } catch { return null; }
}

export function writeResearcherDraft(key: string, config: StudyConfig, revision: number | null): boolean {
  try {
    sessionStorage.setItem(key, JSON.stringify({ version: 1, config: copyStudyConfiguration(config), revision }));
    return true;
  } catch { return false; }
}

export function discardResearcherDraft(key: string): boolean {
  try { sessionStorage.removeItem(key); return true; } catch { return false; }
}
