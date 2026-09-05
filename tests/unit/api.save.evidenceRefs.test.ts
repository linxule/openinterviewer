// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A9.5, updated for slice P.
 *
 * Originally: /api/synthesis signed a receipt over `validateSynthesisResult`'s
 * output, and /api/interviews/save re-verified a digest of the same shape —
 * this file proved the two invocations agreed for both the new evidenceRefs
 * shape and the legacy free-text evidence shape. The receipt is retired
 * (slice P §P9): a participant save now carries no synthesis at all, and the
 * server writes its own analysis later. What remains worth pinning is that
 * `validateInterviewSubmission` still accepts a synthesis body in either
 * shape without 400ing the save — a submission's shape must never gate
 * whether the interview itself is durable — even though the value is
 * discarded on the participant path (P5.1).
 */

const contextMock = vi.hoisted(() => ({
  getParticipantRequestContext: vi.fn(),
  resolveParticipantOrPreviewContext: vi.fn((request: Request, options?: unknown) =>
    contextMock.getParticipantRequestContext(request, options)
  ),
  selectedStudyIdFromParticipantBody: vi.fn((body: Record<string, unknown>) => {
    if (typeof body.studyId === 'string' && body.studyId.length > 0) return body.studyId;
    return undefined;
  }),
  providerKeysFromContext: vi.fn(() => ({})),
}));
vi.mock('@/lib/researcherContext', () => contextMock);

const canonicalMock = vi.hoisted(() => ({ loadCanonicalStudy: vi.fn() }));
vi.mock('@/lib/canonicalStudy', () => canonicalMock);

const rateLimitMock = vi.hoisted(() => ({ getSavePersistRatePlan: vi.fn() }));
vi.mock('@/lib/rateLimit', () => rateLimitMock);

const consentMock = vi.hoisted(() => ({ verifyParticipantConsent: vi.fn() }));
vi.mock('@/lib/participantConsent', () => consentMock);

const kvMock = vi.hoisted(() => ({
  persistCompletedInterview: vi.fn(),
  INTERVIEW_PERSISTING_PREFIX: 'interview-persisting:',
  parsePersistingGuard: vi.fn(),
}));
vi.mock('@/lib/kv', () => kvMock);

const afterMock = vi.hoisted(() => vi.fn());
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return { ...actual, after: afterMock };
});

import { POST } from '@/app/api/interviews/save/route';

const makeRequest = (body: unknown) =>
  new Request('http://localhost/api/interviews/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

// Invented fixture content only — never real participant text.
const transcript = [
  { id: 'm1', role: 'ai' as const, content: 'What was onboarding like for you?', timestamp: 1 },
  {
    id: 'm2',
    role: 'user' as const,
    content: 'I started the onboarding flow and immediately got stuck on the settings page.',
    timestamp: 2,
  },
];
const participantProfile = { id: 'p1', fields: [], rawContext: '', timestamp: 1 };
const behaviorData = {
  timePerTopic: {},
  messagesPerTopic: {},
  topicsExplored: [],
  contradictions: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  contextMock.getParticipantRequestContext.mockResolvedValue({
    valid: true,
    context: { kvClient: {} },
    studyId: 'study-a',
    isAdmin: false,
    linkId: 'a'.repeat(64),
    participantSessionId: 'session-a',
    studyRevision: 1,
  });
  canonicalMock.loadCanonicalStudy.mockResolvedValue({
    ok: true,
    study: {
      id: 'study-a',
      revision: 1,
      config: { name: 'Canonical Study', consentText: 'Consent text', aiProvider: 'gemini', aiModel: 'gemini-3.7-flash' },
    },
  });
  consentMock.verifyParticipantConsent.mockResolvedValue({
    status: 'accepted',
    consent: {
      version: 1,
      participantSessionId: 'session-a',
      studyId: 'study-a',
      studyRevision: 1,
      consentHash: 'a'.repeat(64),
      acceptedAt: 1_700_000_000_000,
    },
  });
  rateLimitMock.getSavePersistRatePlan.mockReturnValue([
    { key: 'interview-rate:session:0', maximum: 2, windowSeconds: 86_400, windowStart: 0 },
  ]);
  kvMock.persistCompletedInterview.mockResolvedValue({ status: 'created' });
});

afterEach(() => {
  vi.clearAllMocks();
});

async function save(id: string, synthesis: unknown) {
  // Round-tripped through JSON exactly as a browser would post it.
  const body = JSON.parse(JSON.stringify({
    id,
    studyId: 'study-a',
    transcript,
    participantProfile,
    behaviorData,
    synthesis,
  }));

  return POST(makeRequest(body));
}

describe('POST /api/interviews/save — a submitted synthesis shape never gates durability', () => {
  it('accepts a new-shape synthesis whose themes carry evidenceRefs, and discards it', async () => {
    const response = await save('interview-evidence-refs', {
      statedPreferences: ['Clarity'],
      revealedPreferences: ['Needs guidance'],
      themes: [
        {
          theme: 'Onboarding friction',
          frequency: 1,
          evidenceRefs: [
            { quote: 'I started the onboarding flow and immediately got stuck on the settings page.', turnIndex: 2 },
          ],
        },
      ],
      contradictions: [],
      keyInsights: ['Onboarding needs a walkthrough.'],
      bottomLine: 'The participant struggled during onboarding.',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, created: true });
    expect(kvMock.persistCompletedInterview).toHaveBeenCalledTimes(1);
    expect(kvMock.persistCompletedInterview.mock.calls[0][0]).toMatchObject({ synthesis: null });
  });

  it('accepts a legacy-shaped synthesis whose themes carry a free-text evidence string, and discards it', async () => {
    const response = await save('interview-evidence-legacy', {
      statedPreferences: ['Clarity'],
      revealedPreferences: ['Needs guidance'],
      themes: [
        {
          theme: 'Onboarding friction',
          evidence: 'The participant got stuck on the settings page during onboarding.',
          frequency: 1,
        },
      ],
      contradictions: [],
      keyInsights: ['Onboarding needs a walkthrough.'],
      bottomLine: 'The participant struggled during onboarding.',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, created: true });
    expect(kvMock.persistCompletedInterview).toHaveBeenCalledTimes(1);
    expect(kvMock.persistCompletedInterview.mock.calls[0][0]).toMatchObject({ synthesis: null });
  });

  it('saves with no synthesis field at all', async () => {
    const response = await save('interview-no-synthesis', undefined);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, created: true });
  });
});
