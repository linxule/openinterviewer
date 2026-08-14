import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Revoked-link contract (standalone mode).
 *
 * A token whose study has linksEnabled:false must be denied at the context
 * layer with a clear error, and the denial must fail closed.
 */

const authMock = vi.hoisted(() => ({
  verifyParticipantToken: vi.fn(),
  verifySessionToken: vi.fn(),
  SESSION_COOKIE_NAME: 'research-auth',
}));

vi.mock('@/lib/auth', () => authMock);

const modeMock = vi.hoisted(() => ({
  isStandaloneMode: vi.fn(),
  isHostedMode: vi.fn(),
}));

vi.mock('@/lib/mode', () => modeMock);

const kvClientMock = vi.hoisted(() => ({
  getKVClient: vi.fn(),
}));

vi.mock('@/lib/kvClient', () => kvClientMock);

const kvMock = vi.hoisted(() => ({
  getStudy: vi.fn(),
}));

vi.mock('@/lib/kv', () => kvMock);

const participantLinksMock = vi.hoisted(() => ({
  getParticipantLinkById: vi.fn(),
}));

vi.mock('@/lib/participantLinks', () => participantLinksMock);

import { getParticipantRequestContext } from '@/lib/researcherContext';
import { makeStoredStudy } from '../fixtures/models';

const makeRequest = (token = 'token-x') =>
  new Request('http://localhost/api/greeting', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });

beforeEach(() => {
  vi.clearAllMocks();
  modeMock.isStandaloneMode.mockReturnValue(true);
  modeMock.isHostedMode.mockReturnValue(false);
  kvClientMock.getKVClient.mockReturnValue({} as never);
  participantLinksMock.getParticipantLinkById.mockResolvedValue({
    status: 'found',
    link: { id: 'a'.repeat(64), studyId: 'study-open', studyRevision: 1, researcherId: null },
  });
});

describe('getParticipantRequestContext revoked links', () => {
  it('denies access when the study has linksEnabled:false', async () => {
    authMock.verifyParticipantToken.mockResolvedValue({
      valid: true,
      studyId: 'study-revoked',
      linkId: 'a'.repeat(64),
      sessionId: 'session-a',
      studyRevision: 1,
    });
    participantLinksMock.getParticipantLinkById.mockResolvedValue({
      status: 'found',
      link: { id: 'a'.repeat(64), studyId: 'study-revoked', studyRevision: 1, researcherId: null },
    });
    kvMock.getStudy.mockResolvedValue(
      makeStoredStudy({ id: 'study-revoked', config: { ...makeStoredStudy().config, linksEnabled: false } })
    );

    const result = await getParticipantRequestContext(makeRequest());

    expect(result.valid).toBe(false);
    expect(result.error).toContain('disabled');
  });

  it('allows access when links are enabled', async () => {
    authMock.verifyParticipantToken.mockResolvedValue({
      valid: true,
      studyId: 'study-open',
      linkId: 'a'.repeat(64),
      sessionId: 'session-a',
      studyRevision: 1,
    });
    kvMock.getStudy.mockResolvedValue(makeStoredStudy({ id: 'study-open' }));

    const result = await getParticipantRequestContext(makeRequest());

    expect(result.valid).toBe(true);
    expect(result.studyId).toBe('study-open');
  });

  it('denies access when the study cannot be looked up (fail closed)', async () => {
    authMock.verifyParticipantToken.mockResolvedValue({
      valid: true,
      studyId: 'study-missing',
      linkId: 'a'.repeat(64),
      sessionId: 'session-a',
      studyRevision: 1,
    });
    participantLinksMock.getParticipantLinkById.mockResolvedValue({
      status: 'found',
      link: { id: 'a'.repeat(64), studyId: 'study-missing', studyRevision: 1, researcherId: null },
    });
    kvMock.getStudy.mockRejectedValue(new Error('kv down'));

    const result = await getParticipantRequestContext(makeRequest());

    expect(result.valid).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
