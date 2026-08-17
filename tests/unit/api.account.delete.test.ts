import { beforeEach, describe, expect, it, vi } from 'vitest';

const identityMock = vi.hoisted(() => ({
  getHostedResearcherIdentity: vi.fn(),
  hasRecentResearcherSession: vi.fn(() => true),
}));
vi.mock('@/lib/researcherContext', () => identityMock);

const platformMock = vi.hoisted(() => ({
  consumePlatformRateLimit: vi.fn(),
  getResearcherByIdChecked: vi.fn(),
  hasAccountDeleteJournal: vi.fn(),
  beginAccountDeletion: vi.fn(),
  resumeAccountDeletion: vi.fn(),
}));
vi.mock('@/lib/platformDb', () => platformMock);

vi.mock('@/lib/mode', () => ({ isHostedMode: () => true }));
vi.mock('@/lib/auth', () => ({ SESSION_COOKIE_NAME: 'researcher-session' }));

import { DELETE } from '@/app/api/account/route';
import { POST as RECONCILE } from '@/app/api/account/reconcile-deletion/route';

const researcher = {
  id: 'researcher-a',
  email: 'owner@example.com',
  encryptedRedisUrl: 'encrypted-url',
};

const plan = { version: 2, subject: 'researcher-a', cursor: 0, length: 2, ops: [], journalLast: true };

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ACCOUNT_DELETE_RECONCILE_TOKEN;
  identityMock.hasRecentResearcherSession.mockReturnValue(true);
  identityMock.getHostedResearcherIdentity.mockResolvedValue({
    authorized: true,
    researcherId: 'researcher-a',
    issuedAt: Math.floor(Date.now() / 1000),
  });
  platformMock.consumePlatformRateLimit.mockResolvedValue({ status: 'allowed', remaining: 9 });
  platformMock.getResearcherByIdChecked.mockResolvedValue({ status: 'found', researcher });
  platformMock.hasAccountDeleteJournal.mockResolvedValue('no');
  platformMock.beginAccountDeletion.mockResolvedValue({ status: 'started', plan });
  platformMock.resumeAccountDeletion.mockResolvedValue({ status: 'complete' });
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
    expect(platformMock.beginAccountDeletion).toHaveBeenCalledWith(researcher);
    expect(platformMock.resumeAccountDeletion).toHaveBeenCalledWith('researcher-a');
    expect(body.externalDataDeleted).toBe(false);
    expect(body.success).toBe(true);
    expect(body.message).toContain('external Redis database was not changed');
    expect(response.headers.get('set-cookie')).toContain('researcher-session=');
  });

  it('returns 202 after the plan is persisted when resume is still pending', async () => {
    platformMock.resumeAccountDeletion.mockResolvedValue({ status: 'pending', plan });
    const request = new Request('http://localhost/api/account', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: 'owner@example.com' }),
    });
    const response = await DELETE(request);
    const body = await response.json();
    expect(response.status).toBe(202);
    expect(body.deletionPending).toBe(true);
    expect(body.researcherId).toBe('researcher-a');
  });

  it('does not delete for a mismatched confirmation', async () => {
    const request = new Request('http://localhost/api/account', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: 'wrong@example.com' }),
    });
    const response = await DELETE(request);

    expect(response.status).toBe(400);
    expect(platformMock.beginAccountDeletion).not.toHaveBeenCalled();
  });

  it('requires a recently issued researcher session when no journal exists', async () => {
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
    expect(platformMock.beginAccountDeletion).not.toHaveBeenCalled();
  });

  it('resumes an existing journal without email or recent-session checks', async () => {
    identityMock.hasRecentResearcherSession.mockReturnValue(false);
    platformMock.hasAccountDeleteJournal.mockResolvedValue('yes');
    platformMock.resumeAccountDeletion.mockResolvedValue({ status: 'pending', plan });
    const request = new Request('http://localhost/api/account', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: 'wrong@example.com' }),
    });
    const response = await DELETE(request);
    expect(response.status).toBe(202);
    expect(platformMock.beginAccountDeletion).not.toHaveBeenCalled();
    expect(platformMock.resumeAccountDeletion).toHaveBeenCalledWith('researcher-a');
  });

  it('maps preflight caps to 409 before pending', async () => {
    platformMock.beginAccountDeletion.mockResolvedValue({ status: 'too-many-records' });
    const request = new Request('http://localhost/api/account', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: 'owner@example.com' }),
    });
    const response = await DELETE(request);
    expect(response.status).toBe(409);
    expect(platformMock.resumeAccountDeletion).not.toHaveBeenCalled();
  });
});

describe('hosted account deletion reconcile', () => {
  it('lets the authenticated researcher resume without email', async () => {
    platformMock.hasAccountDeleteJournal.mockResolvedValue('yes');
    platformMock.resumeAccountDeletion.mockResolvedValue({ status: 'pending', plan });
    const response = await RECONCILE(new Request('http://localhost/api/account/reconcile-deletion', {
      method: 'POST',
    }));
    expect(response.status).toBe(202);
    expect(platformMock.resumeAccountDeletion).toHaveBeenCalledWith('researcher-a');
  });

  it('uses the operator token when configured and refuses when the env is unset', async () => {
    identityMock.getHostedResearcherIdentity.mockResolvedValue({ authorized: false, error: 'Unauthorized' });
    const unset = await RECONCILE(new Request('http://localhost/api/account/reconcile-deletion', {
      method: 'POST',
      headers: { ACCOUNT_DELETE_RECONCILE_TOKEN: 'secret' },
      body: JSON.stringify({ researcherId: 'researcher-a' }),
    }));
    expect(unset.status).toBe(503);

    process.env.ACCOUNT_DELETE_RECONCILE_TOKEN = 'secret';
    platformMock.hasAccountDeleteJournal.mockResolvedValue('yes');
    platformMock.resumeAccountDeletion.mockResolvedValue({ status: 'complete' });
    const ok = await RECONCILE(new Request('http://localhost/api/account/reconcile-deletion', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ACCOUNT_DELETE_RECONCILE_TOKEN: 'secret',
      },
      body: JSON.stringify({ researcherId: 'researcher-a' }),
    }));
    expect(ok.status).toBe(200);
    expect(platformMock.resumeAccountDeletion).toHaveBeenCalledWith('researcher-a');
  });

  it('returns 200 when the journal is already gone', async () => {
    platformMock.hasAccountDeleteJournal.mockResolvedValue('no');
    const response = await RECONCILE(new Request('http://localhost/api/account/reconcile-deletion', {
      method: 'POST',
    }));
    expect(response.status).toBe(200);
    expect(platformMock.resumeAccountDeletion).not.toHaveBeenCalled();
  });
});
