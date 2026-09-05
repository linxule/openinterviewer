// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Fixture model standing in for the study's researcher-configured model.
const GEMINI_SYNTHESIS_MODEL = 'gemini-3.7-flash';

/**
 * A9.5 — the single most valuable test in the I2a slice.
 *
 * /api/synthesis signs a receipt over `validateSynthesisResult(providerOutput)`.
 * /api/interviews/save re-runs `validateSynthesisResult` over the client's
 * payload and re-verifies the receipt against that output. If the two
 * validator invocations ever disagree on canonical shape, every save 403s.
 *
 * Unlike tests/unit/api.save.idempotent.test.ts, this suite does NOT mock
 * @/lib/synthesisReceipt — it signs a real receipt with the real validator
 * output and lets the real route re-verify it, proving digest equality
 * end-to-end for both the new evidenceRefs shape and the legacy evidence
 * shape (the A1.2 rollout-window guarantee).
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

import { POST } from '@/app/api/interviews/save/route';
import { createSynthesisReceipt } from '@/lib/synthesisReceipt';
import { validateSynthesisResult } from '@/lib/providerValidation';

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
  process.env.PARTICIPANT_TOKEN_SECRET = 'participant-receipt-secret-12345678901234567890';
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
    study: { id: 'study-a', revision: 1, config: { name: 'Canonical Study', consentText: 'Consent text' } },
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
  delete process.env.PARTICIPANT_TOKEN_SECRET;
});

async function signAndSave(providerOutput: unknown) {
  // Simulates /api/synthesis: validate the raw provider output once, and
  // sign a receipt over exactly that validated shape.
  const synthesis = validateSynthesisResult(providerOutput);
  const receipt = await createSynthesisReceipt({
    studyId: 'study-a',
    studyRevision: 1,
    participantSessionId: 'session-a',
    aiProvider: 'gemini',
    aiModel: GEMINI_SYNTHESIS_MODEL,
    requestedAiModel: GEMINI_SYNTHESIS_MODEL,
    transcript,
    participantProfile,
    behaviorData,
    synthesis,
  });

  // Simulates the client submitting the same validated synthesis back,
  // round-tripped through JSON exactly as a browser would.
  const body = JSON.parse(JSON.stringify({
    id: 'interview-evidence-refs',
    studyId: 'study-a',
    transcript,
    participantProfile,
    behaviorData,
    synthesis: { ...synthesis, _receipt: receipt },
  }));

  return POST(makeRequest(body));
}

describe('POST /api/interviews/save — evidenceRefs digest equality (A9.5)', () => {
  it('saves a new-shape synthesis whose themes carry evidenceRefs', async () => {
    const response = await signAndSave({
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
  });

  it('saves a legacy-shaped synthesis whose themes carry a free-text evidence string (A1.2 rollout window)', async () => {
    const response = await signAndSave({
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
  });
});
