// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredStudy } from '../fixtures/models';

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
vi.mock('@/lib/canonicalStudy', () => canonicalMock);

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
    context: { kvClient: {} },
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

  it('authorizes researcher preview without persisting a consent record', async () => {
    contextMock.getParticipantRequestContext.mockResolvedValue({
      valid: true,
      context: { kvClient: {} },
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
