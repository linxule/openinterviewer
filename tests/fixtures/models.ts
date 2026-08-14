import { StudyConfig, StoredInterview, StoredStudy } from '@/types';

/**
 * Fixture builders for tests. Keep these minimal and stable — they encode
 * the data shapes used across the regression suite.
 */

let counter = 0;

export function makeStudyConfig(overrides: Partial<StudyConfig> = {}): StudyConfig {
  counter += 1;
  return {
    id: `study-${counter}`,
    name: `Study ${counter}`,
    description: 'A fixture study',
    researchQuestion: 'Fixture research question?',
    coreQuestions: ['First core question?'],
    topicAreas: ['Fixture topic'],
    profileSchema: [
      { id: 'role', label: 'Current Role', extractionHint: 'Their role', required: true },
    ],
    aiBehavior: 'standard',
    aiProvider: 'gemini',
    aiModel: 'gemini-2.5-flash',
    consentText: 'Fixture consent text.',
    createdAt: Date.now(),
    ...overrides,
  };
}

export function makeStoredStudy(overrides: Partial<StoredStudy> = {}): StoredStudy {
  const config = makeStudyConfig();
  return {
    id: config.id,
    config,
    interviewCount: 0,
    isLocked: false,
    revision: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

export function makeStoredInterview(overrides: Partial<StoredInterview> = {}): StoredInterview {
  const now = Date.now();
  return {
    id: `interview-${counter}-${now}`,
    studyId: 'study-1',
    studyName: 'Study 1',
    participantProfile: { id: 'p-1', fields: [], rawContext: '', timestamp: now },
    transcript: [{ id: 'm-1', role: 'ai' as const, content: 'Hello', timestamp: now }],
    synthesis: null,
    behaviorData: { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] },
    createdAt: now,
    completedAt: now,
    status: 'completed' as const,
    ...overrides,
  };
}
