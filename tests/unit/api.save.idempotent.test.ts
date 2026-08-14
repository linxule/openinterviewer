import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeStoredInterview } from '../fixtures/models';

/**
 * Interview save idempotency contract.
 *
 * POST /api/interviews/save with the same interview id must be idempotent across
 * server instances. The storage primitive owns create-vs-duplicate detection;
 * completed records are never overwritten by the route.
 */

const contextMock = vi.hoisted(() => ({
  getParticipantRequestContext: vi.fn(),
}));

vi.mock('@/lib/researcherContext', () => contextMock);

const canonicalMock = vi.hoisted(() => ({
  loadCanonicalStudy: vi.fn(),
}));

vi.mock('@/lib/canonicalStudy', () => canonicalMock);

const receiptMock = vi.hoisted(() => ({ verifySynthesisReceipt: vi.fn() }));
vi.mock('@/lib/synthesisReceipt', () => receiptMock);

const rateLimitMock = vi.hoisted(() => ({ getParticipantRateLimitCounters: vi.fn() }));
vi.mock('@/lib/rateLimit', () => rateLimitMock);

const consentMock = vi.hoisted(() => ({ verifyParticipantConsent: vi.fn() }));
vi.mock('@/lib/participantConsent', () => consentMock);

const kvMock = vi.hoisted(() => ({
  persistCompletedInterview: vi.fn(),
}));

vi.mock('@/lib/kv', () => kvMock);

import { POST } from '@/app/api/interviews/save/route';

const makeRequest = (body: unknown) =>
  new Request('http://localhost/api/interviews/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

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
      config: { name: 'Canonical Study' },
    },
  });
  receiptMock.verifySynthesisReceipt.mockResolvedValue(true);
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
  rateLimitMock.getParticipantRateLimitCounters.mockReturnValue([
    { key: 'rate:session', maximum: 2, windowSeconds: 86_400 },
  ]);
  kvMock.persistCompletedInterview
    .mockResolvedValueOnce({ status: 'created' })
    .mockResolvedValue({ status: 'duplicate' });
});

describe('POST /api/interviews/save idempotency', () => {
  it('fails closed before receipt verification or persistence when consent is missing', async () => {
    consentMock.verifyParticipantConsent.mockResolvedValue({ status: 'missing' });
    const interview = makeStoredInterview({ id: 'interview-x', studyId: 'study-a' });

    const response = await POST(makeRequest({
      ...interview,
      synthesis: {
        statedPreferences: [], revealedPreferences: [], themes: [], contradictions: [],
        keyInsights: ['Insight'], bottomLine: 'Bottom line', _receipt: 'receipt',
      },
    }));

    expect(response.status).toBe(428);
    expect(receiptMock.verifySynthesisReceipt).not.toHaveBeenCalled();
    expect(kvMock.persistCompletedInterview).not.toHaveBeenCalled();
  });

  it('reports create then duplicate without overwriting in the route', async () => {
    const interview = makeStoredInterview({ id: 'interview-x', studyId: 'study-a' });
    const body = {
      id: interview.id,
      studyId: interview.studyId,
      studyName: interview.studyName,
      transcript: interview.transcript,
      participantProfile: interview.participantProfile,
      behaviorData: interview.behaviorData,
      synthesis: {
        statedPreferences: [], revealedPreferences: [], themes: [], contradictions: [],
        keyInsights: ['Insight'], bottomLine: 'Bottom line', _receipt: 'receipt',
      },
      createdAt: interview.createdAt,
    };

    const first = await POST(makeRequest(body));
    const second = await POST(makeRequest(body));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.json()).toMatchObject({ success: true, created: true });
    expect(await second.json()).toMatchObject({ success: true, created: false });
    expect(kvMock.persistCompletedInterview).toHaveBeenCalledTimes(2);
    expect(kvMock.persistCompletedInterview).toHaveBeenLastCalledWith(
      expect.any(Object),
      expect.any(String),
      expect.objectContaining({
        expectedStudyRevision: 1,
        rateLimits: [{ key: 'rate:session', maximum: 2, windowSeconds: 86_400 }],
      }),
      expect.any(Object)
    );
  });

  it('delegates concurrent duplicate detection to the atomic storage primitive', async () => {
    const interview = makeStoredInterview({ id: 'interview-x', studyId: 'study-a' });
    const body = {
      id: interview.id,
      studyId: interview.studyId,
      studyName: interview.studyName,
      transcript: interview.transcript,
      participantProfile: interview.participantProfile,
      behaviorData: interview.behaviorData,
      synthesis: {
        statedPreferences: [], revealedPreferences: [], themes: [], contradictions: [],
        keyInsights: ['Insight'], bottomLine: 'Bottom line', _receipt: 'receipt',
      },
    };

    kvMock.persistCompletedInterview
      .mockReset()
      .mockResolvedValueOnce({ status: 'created' })
      .mockResolvedValueOnce({ status: 'duplicate' });

    const [first, second] = await Promise.all([
      POST(makeRequest(body)),
      POST(makeRequest(body)),
    ]);

    expect([await first.json(), await second.json()]).toEqual([
      expect.objectContaining({ created: true }),
      expect.objectContaining({ created: false }),
    ]);
    expect(kvMock.persistCompletedInterview).toHaveBeenCalledTimes(2);
  });

  it('rejects a body whose studyId does not match the token studyId', async () => {
    const res = await POST(
      makeRequest({
        id: 'interview-y',
        studyId: 'other-study',
        transcript: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }],
        participantProfile: { id: 'p1', fields: [], rawContext: '', timestamp: 1 },
        behaviorData: { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] },
        synthesis: {
          statedPreferences: [], revealedPreferences: [], themes: [], contradictions: [],
          keyInsights: ['Insight'], bottomLine: 'Bottom line', _receipt: 'receipt',
        },
      })
    );

    expect(res.status).toBe(403);
    expect(kvMock.persistCompletedInterview).not.toHaveBeenCalled();
  });

  it('rejects reuse of an interview id with different content', async () => {
    kvMock.persistCompletedInterview.mockReset().mockResolvedValue({ status: 'conflict' });

    const interview = makeStoredInterview({
      id: 'interview-x',
      studyId: 'study-a',
      synthesis: {
        statedPreferences: [], revealedPreferences: [], themes: [], contradictions: [],
        keyInsights: ['Insight'], bottomLine: 'Bottom line', _receipt: 'receipt',
      },
    });
    const res = await POST(makeRequest(interview));

    expect(res.status).toBe(409);
  });

  it('maps an atomic save quota rejection without persisting a partial interview', async () => {
    kvMock.persistCompletedInterview.mockReset().mockResolvedValue({ status: 'rate-limited' });
    const interview = makeStoredInterview({
      id: 'interview-limited',
      studyId: 'study-a',
      synthesis: {
        statedPreferences: [], revealedPreferences: [], themes: [], contradictions: [],
        keyInsights: ['Insight'], bottomLine: 'Bottom line', _receipt: 'receipt',
      },
    });

    const response = await POST(makeRequest(interview));

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('3600');
  });
});
