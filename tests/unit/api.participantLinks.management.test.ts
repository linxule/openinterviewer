// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const contextMock = vi.hoisted(() => ({ getRequestContext: vi.fn() }));
vi.mock('@/lib/researcherContext', () => contextMock);

const accessMock = vi.hoisted(() => ({ configurationRequiredResponse: vi.fn() }));
vi.mock('@/lib/researcherAccess', () => accessMock);

const kvMock = vi.hoisted(() => ({ getStudyChecked: vi.fn() }));
vi.mock('@/lib/kv', () => kvMock);

const modeMock = vi.hoisted(() => ({ isHostedMode: vi.fn() }));
vi.mock('@/lib/mode', () => modeMock);

const platformMock = vi.hoisted(() => ({ getStudyOwnerChecked: vi.fn() }));
vi.mock('@/lib/platformDb', () => platformMock);

const linksMock = vi.hoisted(() => ({
  listParticipantLinksForStudy: vi.fn(),
  revokeParticipantLink: vi.fn(),
}));
vi.mock('@/lib/participantLinks', () => linksMock);

import { DELETE, GET } from '@/app/api/studies/[id]/participant-links/route';

const routeContext = { params: Promise.resolve({ id: 'study-a' }) };
const kvClient = { marker: 'researcher-storage' };

beforeEach(() => {
  vi.clearAllMocks();
  accessMock.configurationRequiredResponse.mockReturnValue(null);
  contextMock.getRequestContext.mockResolvedValue({
    authorized: true,
    context: { kvClient },
    researcherId: 'researcher-a',
  });
  modeMock.isHostedMode.mockReturnValue(true);
  kvMock.getStudyChecked.mockResolvedValue({ status: 'found', study: { id: 'study-a' } });
  platformMock.getStudyOwnerChecked.mockResolvedValue({
    status: 'found', researcherId: 'researcher-a',
  });
});

describe('researcher participant-link management API', () => {
  it('returns only bounded metadata after canonical hosted ownership succeeds', async () => {
    const metadata = {
      id: 'a'.repeat(64),
      studyRevision: 2,
      createdAt: 100,
      expiresAt: 200,
      revokedAt: null,
    };
    linksMock.listParticipantLinksForStudy.mockResolvedValue({
      status: 'ok', links: [metadata], truncated: false,
    });

    const response = await GET(
      new Request('http://localhost/api/studies/study-a/participant-links'),
      routeContext
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body).toEqual({ links: [metadata], truncated: false });
    expect(JSON.stringify(body)).not.toContain('code');
    expect(JSON.stringify(body)).not.toContain('researcherId');
    expect(linksMock.listParticipantLinksForStudy).toHaveBeenCalledWith({
      studyId: 'study-a',
      researcherId: 'researcher-a',
      standaloneClient: kvClient,
      maximum: 1_000,
    });
  });

  it('fails closed without listing when hosted ownership is unavailable', async () => {
    platformMock.getStudyOwnerChecked.mockResolvedValue({ status: 'unavailable' });

    const response = await GET(
      new Request('http://localhost/api/studies/study-a/participant-links'),
      routeContext
    );

    expect(response.status).toBe(503);
    expect(linksMock.listParticipantLinksForStudy).not.toHaveBeenCalled();
  });

  it('requires canonical study existence in standalone mode', async () => {
    modeMock.isHostedMode.mockReturnValue(false);
    contextMock.getRequestContext.mockResolvedValue({ authorized: true, context: { kvClient } });
    kvMock.getStudyChecked.mockResolvedValue({ status: 'not-found' });

    const response = await GET(
      new Request('http://localhost/api/studies/study-a/participant-links'),
      routeContext
    );

    expect(response.status).toBe(404);
    expect(platformMock.getStudyOwnerChecked).not.toHaveBeenCalled();
    expect(linksMock.listParticipantLinksForStudy).not.toHaveBeenCalled();
  });

  it('revokes one link through the atomic owner-checked storage operation', async () => {
    linksMock.revokeParticipantLink.mockResolvedValue({
      status: 'revoked', revokedAt: 1_800_000_000_000,
    });
    const linkId = 'b'.repeat(64);
    const response = await DELETE(new Request(
      'http://localhost/api/studies/study-a/participant-links',
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ linkId }),
      }
    ), routeContext);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      link: { id: linkId, revoked: true, revokedAt: 1_800_000_000_000 },
    });
    expect(linksMock.revokeParticipantLink).toHaveBeenCalledWith({
      linkId,
      studyId: 'study-a',
      researcherId: 'researcher-a',
      standaloneClient: kvClient,
    });
  });

  it('does not translate an atomic owner conflict into success', async () => {
    linksMock.revokeParticipantLink.mockResolvedValue({ status: 'owner-conflict' });
    const response = await DELETE(new Request(
      'http://localhost/api/studies/study-a/participant-links',
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ linkId: 'c'.repeat(64) }),
      }
    ), routeContext);

    expect(response.status).toBe(403);
  });
});
