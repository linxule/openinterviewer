import { describe, expect, it } from 'vitest';
import { DEMO_INTERVIEWS, DEMO_STORED_STUDY } from '@/lib/demoData';
import { isSampleFixtureInterview, SAMPLE_INTERVIEW_IDS, SAMPLE_STUDY_ID } from '@/lib/sampleFixtures';
import { participantDisclosures } from '@/lib/transportDisclosure';

describe('sample fixture ids', () => {
  it('name exactly the seeded fixtures', () => {
    expect(DEMO_STORED_STUDY.id).toBe(SAMPLE_STUDY_ID);
    expect(new Set(DEMO_INTERVIEWS.map(interview => interview.id))).toEqual(SAMPLE_INTERVIEW_IDS);
    for (const interview of DEMO_INTERVIEWS) expect(isSampleFixtureInterview(interview)).toBe(true);
  });

  it('never match a participant interview or a fixture id in another study', () => {
    expect(isSampleFixtureInterview({ id: 'session-0f1e2d3c', studyId: SAMPLE_STUDY_ID })).toBe(false);
    expect(isSampleFixtureInterview({ id: 'interview-demo-sarah', studyId: 'another-study' })).toBe(false);
    expect(isSampleFixtureInterview({ id: 'interview-demo-someone', studyId: SAMPLE_STUDY_ID })).toBe(false);
  });

  it('participantDisclosures drops only the fixtures', () => {
    expect(participantDisclosures([
      { id: 'interview-demo-sarah', studyId: SAMPLE_STUDY_ID },
      { id: 'session-a', studyId: SAMPLE_STUDY_ID, consentTransport: 'cloudflare-gateway' },
      { id: 'session-b', studyId: SAMPLE_STUDY_ID },
    ])).toEqual(['cloudflare-gateway', undefined]);
  });
});
