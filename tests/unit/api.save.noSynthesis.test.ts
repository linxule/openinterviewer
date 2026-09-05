// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredInterview } from '../fixtures/models';

/**
 * The headline test of slice P: "Provider down, participant saved."
 *
 * A participant's transcript is durable the moment they finish, independent
 * of any provider call. This test mocks the provider (`synthesizeInterview`)
 * to reject, posts a body with no `_receipt` anywhere, and asserts the save
 * still succeeds with `synthesis: null` and a pending analysis record.
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

// The provider is down. `after()` is mocked so the deferred callback runs
// synchronously here — it must fail without ever touching the response.
const synthesizeInterview = vi.hoisted(() => vi.fn().mockRejectedValue(new Error('provider down')));
vi.mock('@/lib/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/providers')>();
  return {
    ...actual,
    getInterviewProvider: vi.fn(() => ({ synthesizeInterview })),
  };
});

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

beforeEach(() => {
  vi.clearAllMocks();
  synthesizeInterview.mockRejectedValue(new Error('provider down'));
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
      config: { name: 'Canonical Study', aiProvider: 'gemini', aiModel: 'gemini-3.7-flash' },
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

describe('POST /api/interviews/save — provider down, participant saved', () => {
  it('returns 200 with created:true and persists synthesis:null / analysis pending, with no _receipt anywhere in the body', async () => {
    const interview = makeStoredInterview({ id: 'interview-no-provider', studyId: 'study-a' });
    const bodyText = JSON.stringify(interview);
    expect(bodyText).not.toContain('_receipt');

    const response = await POST(makeRequest(interview));

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toMatchObject({ success: true, created: true });
    expect(JSON.stringify(json)).not.toMatch(/analysis/i);

    expect(kvMock.persistCompletedInterview).toHaveBeenCalledTimes(1);
    expect(kvMock.persistCompletedInterview.mock.calls[0][0]).toMatchObject({
      synthesis: null,
      analysis: { status: 'pending', attempts: 0, lastAttemptAt: expect.any(Number) },
    });

    // The deferred analysis was scheduled after the response, never awaited
    // by it — the provider's eventual failure is interviewAnalysis's problem
    // (see interviewAnalysis.idempotent.test.ts), not the participant's.
    expect(afterMock).toHaveBeenCalledTimes(1);
    expect(typeof afterMock.mock.calls[0][0]).toBe('function');
    expect(synthesizeInterview).not.toHaveBeenCalled();
  });
});
