import type { StoredInterview } from '@/types';

/** Exact provider-facing records. Admission and prompt rendering share this projection. */
export function explorationCorpus(interviews: StoredInterview[]) {
  return interviews.map((interview, index) => {
    const original = interview.collectionConfig;
    const fields = interview.participantProfile.fields;
    const definitions = original?.profileSchema ?? [];
    const profile = definitions.map((definition) => {
      const field = fields.find((value) => value.fieldId === definition.id);
      return {
        fieldId: definition.id,
        originalLabel: definition.label,
        originalDefinition: definition.extractionHint,
        status: field?.status ?? 'pending',
        value: field?.value ?? null,
      };
    });
    for (const field of fields) {
      if (definitions.some((definition) => definition.id === field.fieldId)) continue;
      profile.push({
        fieldId: field.fieldId,
        originalLabel: 'UNKNOWN ORIGINAL FIELD DEFINITION',
        originalDefinition: 'Unknown; do not infer a meaning from the field id or current study schema.',
        status: field.status,
        value: field.value,
      });
    }
    return {
      interviewIndex: index + 1,
      studyRevision: interview.studyRevision ?? null,
      originalProtocol: original
        ? { researchQuestion: original.researchQuestion, coreQuestions: original.coreQuestions, topicAreas: original.topicAreas }
        : null,
      originalProfileDefinitionsKnown: Boolean(original),
      recordedProfile: profile,
      turns: interview.transcript.map((message, turn) => ({
        turnIndex: turn + 1,
        speaker: message.role === 'user' ? 'PARTICIPANT' : message.role === 'ai' ? 'INTERVIEWER' : 'SYSTEM EVENT',
        content: message.content,
      })),
    };
  });
}
