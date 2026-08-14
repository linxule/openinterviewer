// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStudyConfig } from '../fixtures/models';

const contextMock = vi.hoisted(() => ({
  getParticipantRequestContext: vi.fn(),
  getRequestContext: vi.fn(),
}));

vi.mock('@/lib/researcherContext', () => contextMock);

const participantLinksMock = vi.hoisted(() => ({
  createParticipantLinkRecord: vi.fn(),
  getParticipantLinkByCode: vi.fn(),
}));

vi.mock('@/lib/participantLinks', () => participantLinksMock);

vi.mock('@/lib/kv', () => ({ getStudyChecked: vi.fn() }));
vi.mock('@/lib/researcherAccess', () => ({ configurationRequiredResponse: vi.fn() }));
vi.mock('@/lib/mode', () => ({ isHostedMode: vi.fn(() => false) }));
vi.mock('@/lib/platformDb', () => ({
  consumePlatformRateLimit: vi.fn(),
  getStudyOwnerChecked: vi.fn(),
}));
vi.mock('@/lib/appBaseUrl', () => ({ getAppBaseUrl: vi.fn(() => 'http://localhost') }));

import { GET } from '@/app/api/generate-link/route';

const handleA = '00000000-0000-4000-8000-000000000001';
const handleB = '00000000-0000-4000-8000-000000000002';
const link = {
  id: 'a'.repeat(64),
  version: 1 as const,
  studyId: 'study-a',
  studyRevision: 1,
  researcherId: null,
  createdAt: Date.now(),
  expiresAt: null,
  revokedAt: null,
};
const studyConfig = makeStudyConfig({ id: 'study-a' });

beforeEach(() => {
  process.env.PARTICIPANT_TOKEN_SECRET = 'participant-test-secret-value-1234567890';
  participantLinksMock.getParticipantLinkByCode.mockResolvedValue({ status: 'found', link });
  contextMock.getParticipantRequestContext.mockResolvedValue({
    valid: true,
    study: { id: 'study-a', config: studyConfig, revision: 1 },
  });
});

afterEach(() => {
  delete process.env.PARTICIPANT_TOKEN_SECRET;
  vi.restoreAllMocks();
});

describe('GET /api/generate-link participant-session exchange', () => {
  it('mints a distinct HttpOnly cookie and returns its non-secret selector for each tab', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce(handleA)
      .mockReturnValueOnce(handleB);

    const responseA = await GET(new Request('http://localhost/api/generate-link?token=code-a'));
    const responseB = await GET(new Request('http://localhost/api/generate-link?token=code-b'));
    const bodyA = await responseA.json();
    const bodyB = await responseB.json();
    const cookieA = responseA.headers.get('set-cookie');
    const cookieB = responseB.headers.get('set-cookie');

    expect(responseA.status).toBe(200);
    expect(responseB.status).toBe(200);
    expect(bodyA.data.sessionHandle).toBe(handleA);
    expect(bodyB.data.sessionHandle).toBe(handleB);
    expect(cookieA).toContain(`participant-session-${handleA}=`);
    expect(cookieB).toContain(`participant-session-${handleB}=`);
    expect(cookieA).toContain('HttpOnly');
    expect(cookieB).toContain('HttpOnly');
    expect(cookieA).not.toBe(cookieB);
  });
});
