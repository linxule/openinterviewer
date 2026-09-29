import type { StoredInterview, StudyConfig } from '@/types';

/**
 * Interpretation uses the collection's original meanings; execution still
 * uses the currently authorized provider/model. Legacy records never borrow
 * newer labels or research questions that were not recorded at collection.
 */
export function interviewAnalysisConfig(interview: StoredInterview, current: StudyConfig): StudyConfig {
  const original = interview.collectionConfig ?? {
    ...current,
    name: interview.studyName,
    description: '',
    researchQuestion: 'Original collection research question unavailable (legacy record).',
    coreQuestions: [],
    topicAreas: [],
    profileSchema: [],
    interviewerInstructions: interview.conductedWithInstructions,
  };
  return {
    ...original,
    aiProvider: current.aiProvider,
    aiModel: current.aiModel,
    enableReasoning: current.enableReasoning,
  };
}
