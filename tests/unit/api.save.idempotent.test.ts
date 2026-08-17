import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredInterview } from '../fixtures/models';
import { CLAUDE_SYNTHESIS_MODEL, GEMINI_SYNTHESIS_MODEL } from '@/types';
import { resolveProviderType, resolveSynthesisModel } from '@/lib/providers';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)])
    );
  }
  return value;
}

function submissionFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

/**
 * Interview save idempotency contract.
 *
 * POST /api/interviews/save with the same interview id must be idempotent across
 * server instances. The storage primitive owns create-vs-duplicate detection;
 * completed records are never overwritten by the route.
 */

const contextMock = vi.hoisted(() => ({
  getParticipantRequestContext: vi.fn(),
  resolveParticipantOrPreviewContext: vi.fn((request: Request, options?: unknown) =>
    contextMock.getParticipantRequestContext(request, options)
  ),
  selectedStudyIdFromParticipantBody: vi.fn((body: Record<string, unknown>) => {
    if (typeof body.studyId === 'string' && body.studyId.length > 0) return body.studyId;
    const studyConfig = body.studyConfig;
    if (studyConfig && typeof studyConfig === 'object' && studyConfig !== null && 'id' in studyConfig) {
      const id = (studyConfig as { id?: unknown }).id;
      if (typeof id === 'string' && id.length > 0) return id;
    }
    return undefined;
  }),
}));

vi.mock('@/lib/researcherContext', () => contextMock);

const canonicalMock = vi.hoisted(() => ({
  loadCanonicalStudy: vi.fn(),
}));

vi.mock('@/lib/canonicalStudy', () => canonicalMock);

const receiptMock = vi.hoisted(() => ({ verifySynthesisReceipt: vi.fn() }));
vi.mock('@/lib/synthesisReceipt', () => receiptMock);

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

const makeRequest = (body: unknown) =>
  new Request('http://localhost/api/interviews/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('AI_PROVIDER', '');
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
  receiptMock.verifySynthesisReceipt.mockResolvedValue({
    aiProvider: 'gemini',
    aiModel: GEMINI_SYNTHESIS_MODEL,
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
  kvMock.persistCompletedInterview
    .mockResolvedValueOnce({ status: 'created' })
    .mockResolvedValue({ status: 'duplicate' });
});

afterEach(() => {
  vi.unstubAllEnvs();
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
      expect.objectContaining({
        aiProvider: 'gemini',
        aiModel: GEMINI_SYNTHESIS_MODEL,
      }),
      expect.any(String),
      expect.objectContaining({
        expectedStudyRevision: 1,
        rateLimits: [{
          key: 'interview-rate:session:0',
          maximum: 2,
          windowSeconds: 86_400,
          windowStart: 0,
        }],
        identity: { participantSessionId: 'session-a', linkId: 'a'.repeat(64) },
      }),
      expect.any(Object)
    );
  });

  it('stores signed generation-time provenance when provider resolution changes before save', async () => {
    vi.stubEnv('AI_PROVIDER', 'claude');
    const generationProvider = resolveProviderType();
    const generationModel = resolveSynthesisModel(generationProvider);
    receiptMock.verifySynthesisReceipt.mockResolvedValue({
      aiProvider: generationProvider,
      aiModel: generationModel,
    });

    // The deployment default can change while a participant holds a valid
    // receipt. Save must not recompute provenance from this later value.
    vi.stubEnv('AI_PROVIDER', 'gemini');
    expect(resolveProviderType()).toBe('gemini');
    const interview = makeStoredInterview({ id: 'interview-claude', studyId: 'study-a' });

    const response = await POST(makeRequest({
      ...interview,
      synthesis: {
        statedPreferences: [], revealedPreferences: [], themes: [], contradictions: [],
        keyInsights: ['Insight'], bottomLine: 'Bottom line', _receipt: 'receipt',
      },
    }));

    expect(response.status).toBe(200);
    expect(kvMock.persistCompletedInterview).toHaveBeenCalledWith(
      expect.objectContaining({
        aiProvider: 'claude',
        aiModel: CLAUDE_SYNTHESIS_MODEL,
      }),
      expect.any(String),
      expect.any(Object),
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

  it('treats a second POST with a different Date.now as an immutable duplicate', async () => {
    const interview = makeStoredInterview({ id: 'interview-x', studyId: 'study-a' });
    const body = {
      id: interview.id,
      studyId: interview.studyId,
      studyName: interview.studyName,
      transcript: interview.transcript,
      participantProfile: interview.participantProfile,
      behaviorData: interview.behaviorData,
      createdAt: 1_700_000_000_000,
      synthesis: {
        statedPreferences: [], revealedPreferences: [], themes: [], contradictions: [],
        keyInsights: ['Insight'], bottomLine: 'Bottom line', _receipt: 'receipt',
      },
    };

    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_100_000);
    const first = await POST(makeRequest(body));
    vi.setSystemTime(1_700_000_200_000);
    const second = await POST(makeRequest(body));
    vi.useRealTimers();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ success: true, created: false, duplicate: true });

    const firstInterview = kvMock.persistCompletedInterview.mock.calls[0][0] as { completedAt: number };
    const secondInterview = kvMock.persistCompletedInterview.mock.calls[1][0] as { completedAt: number };
    const firstFingerprint = kvMock.persistCompletedInterview.mock.calls[0][1] as string;
    const secondFingerprint = kvMock.persistCompletedInterview.mock.calls[1][1] as string;
    expect(firstInterview.completedAt).toBe(1_700_000_100_000);
    expect(secondInterview.completedAt).toBe(1_700_000_200_000);
    expect(firstFingerprint).toBe(secondFingerprint);
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

  it('asks participant context for new-persist so live create cannot start a save', async () => {
    const interview = makeStoredInterview({ id: 'interview-x', studyId: 'study-a' });
    await POST(makeRequest({
      ...interview,
      synthesis: {
        statedPreferences: [], revealedPreferences: [], themes: [], contradictions: [],
        keyInsights: ['Insight'], bottomLine: 'Bottom line', _receipt: 'receipt',
      },
    }));
    expect(contextMock.getParticipantRequestContext).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ purpose: 'new-persist', selectedStudyId: 'study-a' }),
    );
  });

  it('does not persist a preview save even with a selected study id', async () => {
    contextMock.getParticipantRequestContext.mockResolvedValue({
      valid: true,
      context: { kvClient: { get: vi.fn() } },
      isAdmin: true,
      studyId: 'study-a',
    });
    const interview = makeStoredInterview({ id: 'interview-preview', studyId: 'study-a' });

    const response = await POST(makeRequest({
      ...interview,
      synthesis: {
        statedPreferences: [], revealedPreferences: [], themes: [], contradictions: [],
        keyInsights: ['Insight'], bottomLine: 'Bottom line', _receipt: 'receipt',
      },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, preview: true, created: false });
    expect(kvMock.persistCompletedInterview).not.toHaveBeenCalled();
  });

  it('finishes persist-repair only when the stored guard matches identity and fingerprint', async () => {
    const get = vi.fn().mockResolvedValue('oi:pguard:{}');
    contextMock.getParticipantRequestContext.mockResolvedValue({
      valid: true,
      context: { kvClient: { get } },
      studyId: 'study-a',
      isAdmin: false,
      linkId: 'a'.repeat(64),
      participantSessionId: 'session-a',
      studyRevision: 1,
      persistRepairOnly: true,
    });
    const interview = makeStoredInterview({ id: 'interview-x', studyId: 'study-a' });
    const synthesis = {
      statedPreferences: [],
      revealedPreferences: [],
      themes: [],
      contradictions: [],
      keyInsights: ['Insight'],
      bottomLine: 'Bottom line',
    };
    const fingerprint = submissionFingerprint({
      id: 'session-session-a',
      studyId: 'study-a',
      participantProfile: interview.participantProfile,
      transcript: interview.transcript,
      synthesis,
      behaviorData: interview.behaviorData,
      createdAt: interview.createdAt ?? null,
      consentHash: 'a'.repeat(64),
      consentAcceptedAt: 1_700_000_000_000,
      aiProvider: 'gemini',
      aiModel: GEMINI_SYNTHESIS_MODEL,
      requestedAiModel: undefined,
      routedProvider: undefined,
    });
    kvMock.parsePersistingGuard.mockReturnValue({
      interviewId: 'session-session-a',
      studyId: 'study-a',
      fingerprint,
      identity: { participantSessionId: 'session-a', linkId: 'a'.repeat(64) },
    });
    kvMock.persistCompletedInterview.mockReset().mockResolvedValue({ status: 'created' });

    const response = await POST(makeRequest({
      ...interview,
      synthesis: { ...synthesis, _receipt: 'receipt' },
    }));

    expect(response.status).toBe(200);
    expect(get).toHaveBeenCalledWith('interview-persisting:session-session-a');
    expect(kvMock.persistCompletedInterview).toHaveBeenCalledOnce();
  });

  it('returns opaque 404 and does not persist when persist-repair has no matching guard', async () => {
    const get = vi.fn().mockResolvedValue(null);
    contextMock.getParticipantRequestContext.mockResolvedValue({
      valid: true,
      context: { kvClient: { get } },
      studyId: 'study-a',
      isAdmin: false,
      linkId: 'a'.repeat(64),
      participantSessionId: 'session-a',
      studyRevision: 1,
      persistRepairOnly: true,
    });
    kvMock.parsePersistingGuard.mockReturnValue(null);
    const interview = makeStoredInterview({ id: 'interview-x', studyId: 'study-a' });

    const response = await POST(makeRequest({
      ...interview,
      synthesis: {
        statedPreferences: [], revealedPreferences: [], themes: [], contradictions: [],
        keyInsights: ['Insight'], bottomLine: 'Bottom line', _receipt: 'receipt',
      },
    }));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'This study is no longer active.' });
    expect(kvMock.persistCompletedInterview).not.toHaveBeenCalled();
  });
});
