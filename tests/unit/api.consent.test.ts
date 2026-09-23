// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredStudy } from '../fixtures/models';
import { standaloneTestContext } from '../helpers/workspaceStoreFixture';
import type { RedisPort } from '@/lib/redisPort';

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

const consentMock = vi.hoisted(() => ({ recordParticipantConsent: vi.fn() }));
vi.mock('@/lib/participantConsent', () => consentMock);

const canonicalMock = vi.hoisted(() => ({ loadCanonicalStudy: vi.fn() }));
vi.mock('@/lib/canonicalStudy', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/canonicalStudy')>(),
  ...canonicalMock,
}));

import { POST } from '@/app/api/consent/route';

const study = makeStoredStudy({ id: 'study-a', revision: 3 });
study.config.consentText = 'Canonical consent text.';

const request = (body: Record<string, unknown> = { studyId: 'study-a' }, preview = false) =>
  new Request('http://localhost/api/consent', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(preview ? { 'X-OpenInterviewer-Preview': '1' } : {}),
    },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  contextMock.getParticipantRequestContext.mockResolvedValue({
    valid: true,
    context: standaloneTestContext({} as RedisPort),
    studyId: 'study-a',
    study,
    studyRevision: 3,
    participantSessionId: 'participant-session-a',
    isAdmin: false,
  });
  consentMock.recordParticipantConsent.mockResolvedValue({
    status: 'accepted',
    consent: {
      version: 1,
      participantSessionId: 'participant-session-a',
      studyId: 'study-a',
      studyRevision: 3,
      consentHash: 'a'.repeat(64),
      acceptedAt: 1_700_000_000_000,
    },
  });
});

describe('POST /api/consent', () => {
  it('records only server-resolved binding data and returns the server acceptedAt', async () => {
    const response = await POST(request({
      studyId: 'study-a',
      acceptedAt: 1,
      consentHash: 'client-controlled',
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      preview: false,
      acceptedAt: 1_700_000_000_000,
    });
    expect(consentMock.recordParticipantConsent).toHaveBeenCalledWith(
      {
        participantSessionId: 'participant-session-a',
        studyId: 'study-a',
        studyRevision: 3,
        consentText: 'Canonical consent text.',
      },
      {}
    );
  });

  it('fails closed with a retryable 503 when consent storage is unavailable', async () => {
    consentMock.recordParticipantConsent.mockResolvedValue({ status: 'unavailable' });

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ retryable: true });
  });

  it.each([
    [{ statusCode: 401, error: 'Participant session expired.' }, 401, { error: 'Participant session expired.' }],
    [
      { statusCode: 403, error: 'Participant link is no longer active.', retryable: false },
      403,
      { error: 'Participant link is no longer active.' },
    ],
    [
      { statusCode: 503, error: 'Unable to verify participant link.', retryable: true },
      503,
      { error: 'Unable to verify participant link.', retryable: true },
    ],
  ])('OPS-01: an unresolved session context %o keeps its status and message; only a 503 carries retryable', async (
    denial,
    status,
    body,
  ) => {
    contextMock.getParticipantRequestContext.mockResolvedValue({ valid: false, context: null, ...denial });

    const response = await POST(request());

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(body);
    expect(consentMock.recordParticipantConsent).not.toHaveBeenCalled();
  });

  it('authorizes researcher preview without persisting a consent record', async () => {
    contextMock.getParticipantRequestContext.mockResolvedValue({
      valid: true,
      context: standaloneTestContext({} as RedisPort),
      isAdmin: true,
    });
    canonicalMock.loadCanonicalStudy.mockResolvedValue({ ok: true, study });
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_001);

    const response = await POST(request({ studyId: 'study-a' }, true));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      preview: true,
      acceptedAt: 1_700_000_000_001,
    });
    expect(consentMock.recordParticipantConsent).not.toHaveBeenCalled();
  });
});
