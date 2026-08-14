// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSynthesisReceipt, verifySynthesisReceipt } from '@/lib/synthesisReceipt';

const payload = {
  studyId: 'study-a',
  studyRevision: 1,
  participantSessionId: 'session-a',
  transcript: [{ id: 'm1', role: 'user', content: 'Hello', timestamp: 1 }],
  participantProfile: null,
  behaviorData: { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] },
  synthesis: {
    statedPreferences: [], revealedPreferences: [], themes: [], contradictions: [],
    keyInsights: ['Insight'], bottomLine: 'Bottom line',
  },
};

beforeEach(() => {
  process.env.PARTICIPANT_TOKEN_SECRET = 'participant-receipt-secret-12345678901234567890';
});

afterEach(() => {
  delete process.env.PARTICIPANT_TOKEN_SECRET;
});

describe('synthesis receipts', () => {
  it('binds synthesis to the session, study revision, transcript, profile, and behavior', async () => {
    const receipt = await createSynthesisReceipt(payload);

    await expect(verifySynthesisReceipt({ ...payload, receipt })).resolves.toBe(true);
    await expect(verifySynthesisReceipt({
      ...payload,
      receipt,
      transcript: [{ id: 'm1', role: 'user', content: 'Tampered', timestamp: 1 }],
    })).resolves.toBe(false);
    await expect(verifySynthesisReceipt({
      ...payload,
      receipt,
      participantSessionId: 'other-session',
    })).resolves.toBe(false);
  });
});
