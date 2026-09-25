/**
 * The sample workspace's fixed ids (fixtures in `demoData.ts`). Its interviews
 * are synthetic: no participant took part, so no consent disclosure applies to
 * them. A participant's saved interview id is always `session-<id>`, built by
 * the server, so a participant record can never take one of these ids.
 */
export const SAMPLE_STUDY_ID = 'demo-study-adaptive-self';

export const SAMPLE_INTERVIEW_IDS: ReadonlySet<string> = new Set([
  'interview-demo-sarah',
  'interview-demo-marcus',
  'interview-demo-priya',
]);

/** A seeded sample interview: one of the fixture ids, in the sample study. */
export function isSampleFixtureInterview(interview: { id: string; studyId: string }): boolean {
  return interview.studyId === SAMPLE_STUDY_ID && SAMPLE_INTERVIEW_IDS.has(interview.id);
}
