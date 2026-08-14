import { beforeEach, describe, expect, it, vi } from 'vitest';

const identityMock = vi.hoisted(() => ({
  getHostedResearcherIdentity: vi.fn(),
  hasRecentResearcherSession: vi.fn(() => true),
}));
vi.mock('@/lib/researcherContext', () => identityMock);

const platformMock = vi.hoisted(() => ({
  consumePlatformRateLimit: vi.fn(),
  getResearcherByIdChecked: vi.fn(),
  deleteResearcherAccount: vi.fn(),
}));
vi.mock('@/lib/platformDb', () => platformMock);

const cacheMock = vi.hoisted(() => ({ evictResearcherClients: vi.fn() }));
vi.mock('@/lib/kvClient', () => cacheMock);
vi.mock('@/lib/crypto', () => ({ decrypt: () => 'https://owner.upstash.io' }));
vi.mock('@/lib/mode', () => ({ isHostedMode: () => true }));
vi.mock('@/lib/auth', () => ({ SESSION_COOKIE_NAME: 'researcher-session' }));

import { DELETE } from '@/app/api/account/route';

const researcher = {
  id: 'researcher-a',
  email: 'owner@example.com',
  encryptedRedisUrl: 'encrypted-url',
};

beforeEach(() => {
  vi.clearAllMocks();
  identityMock.hasRecentResearcherSession.mockReturnValue(true);
  identityMock.getHostedResearcherIdentity.mockResolvedValue({
    authorized: true,
    researcherId: 'researcher-a',
    issuedAt: Math.floor(Date.now() / 1000),
  });
  platformMock.consumePlatformRateLimit.mockResolvedValue({ status: 'allowed', remaining: 9 });
  platformMock.getResearcherByIdChecked.mockResolvedValue({ status: 'found', researcher });
  platformMock.deleteResearcherAccount.mockResolvedValue({ status: 'deleted', detachedStudyCount: 2 });
});

describe('hosted account deletion', () => {
  it('requires the account email and reports that external BYOS data is untouched', async () => {
    const request = new Request('http://localhost/api/account', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: 'owner@example.com' }),
    });
    const response = await DELETE(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(platformMock.deleteResearcherAccount).toHaveBeenCalledWith(researcher);
    expect(body.externalDataDeleted).toBe(false);
    expect(body.message).toContain('external Redis database was not changed');
    expect(cacheMock.evictResearcherClients).toHaveBeenCalledWith('https://owner.upstash.io');
    expect(response.headers.get('set-cookie')).toContain('researcher-session=');
  });

  it('does not delete for a mismatched confirmation', async () => {
    const request = new Request('http://localhost/api/account', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: 'wrong@example.com' }),
    });
    const response = await DELETE(request);

    expect(response.status).toBe(400);
    expect(platformMock.deleteResearcherAccount).not.toHaveBeenCalled();
  });

  it('requires a recently issued researcher session', async () => {
    identityMock.hasRecentResearcherSession.mockReturnValue(false);
    identityMock.getHostedResearcherIdentity.mockResolvedValue({
      authorized: true,
      researcherId: 'researcher-a',
      issuedAt: Math.floor(Date.now() / 1000) - 901,
    });
    const request = new Request('http://localhost/api/account', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: 'owner@example.com' }),
    });

    const response = await DELETE(request);
    expect(response.status).toBe(403);
    expect(platformMock.deleteResearcherAccount).not.toHaveBeenCalled();
  });
});
