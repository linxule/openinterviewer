// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const contextMock = vi.hoisted(() => ({ getRequestContext: vi.fn() }));
vi.mock('@/lib/researcherContext', () => contextMock);

const kvMock = vi.hoisted(() => ({
  clearSampleWorkspaceRecords: vi.fn(),
  getStudyChecked: vi.fn(),
  isKVAvailable: vi.fn(),
  saveInterview: vi.fn(),
  saveStudy: vi.fn(),
  studyKeysExist: vi.fn(),
}));
vi.mock('@/lib/kv', () => kvMock);

import { DELETE, POST } from '@/app/api/demo/seed/route';
import { DEMO_INTERVIEWS, DEMO_STORED_STUDY, DEMO_STUDIES } from '@/lib/demoData';
import { standaloneTestContext } from '../helpers/workspaceStoreFixture';
import type { RedisPort } from '@/lib/redisPort';

const kvClient = {} as RedisPort;

function authorizeWithKeys(options: {
  geminiApiKey: string | null;
  anthropicApiKey: string | null;
  openaiApiKey?: string | null;
  openrouterApiKey?: string | null;
}) {
  contextMock.getRequestContext.mockResolvedValue({
    authorized: true,
    context: standaloneTestContext(kvClient, {
      ...options,
      openaiApiKey: options.openaiApiKey ?? null,
      openrouterApiKey: options.openrouterApiKey ?? null,
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authorizeWithKeys({ geminiApiKey: 'gemini-key', anthropicApiKey: null });
  kvMock.isKVAvailable.mockResolvedValue(true);
  kvMock.studyKeysExist.mockResolvedValue('absent');
  kvMock.getStudyChecked.mockResolvedValue({ status: 'not-found' });
  kvMock.saveStudy.mockResolvedValue(true);
  kvMock.saveInterview.mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('authenticated sample-workspace seed', () => {
  it('keeps every synthetic interview eligible for its study revision', () => {
    expect(DEMO_INTERVIEWS).toHaveLength(3);
    expect(DEMO_INTERVIEWS.every(
      interview => interview.studyRevision === DEMO_STORED_STUDY.revision
    )).toBe(true);
  });

  it('prefers a configured Gemini key without mutating module fixtures', async () => {
    authorizeWithKeys({ geminiApiKey: 'gemini-key', anthropicApiKey: 'claude-key' });

    const response = await POST();

    expect(response.status).toBe(200);
    const seededStudy = kvMock.saveStudy.mock.calls[0][0];
    expect(seededStudy).not.toBe(DEMO_STUDIES[0]);
    expect(seededStudy.config).not.toBe(DEMO_STUDIES[0].config);
    expect(seededStudy.config.aiProvider).toBe('gemini');
    expect(seededStudy.config.enableReasoning).toBe(true);
    expect(DEMO_STUDIES[0].config.aiProvider).toBe('gemini');
    expect(DEMO_STUDIES[0].config.enableReasoning).toBe(true);
  });

  it('selects Claude when it is the only configured provider', async () => {
    authorizeWithKeys({ geminiApiKey: null, anthropicApiKey: 'claude-key' });

    const response = await POST();

    expect(response.status).toBe(200);
    const seededStudy = kvMock.saveStudy.mock.calls[0][0];
    expect(seededStudy.config.aiProvider).toBe('claude');
    expect(seededStudy.config).not.toHaveProperty('enableReasoning');
    expect(kvMock.saveInterview).toHaveBeenCalledTimes(3);
    for (const [interview, client] of kvMock.saveInterview.mock.calls) {
      expect(interview.studyRevision).toBe(seededStudy.revision);
      expect(client).toBe(kvClient);
    }

    // A later warm-function request must still start from untouched fixtures.
    expect(DEMO_STUDIES[0].config.aiProvider).toBe('gemini');
    expect(DEMO_STUDIES[0].config.enableReasoning).toBe(true);
  });

  it.each([
    ['openai', { openaiApiKey: 'openai-key' }],
    ['openrouter', { openrouterApiKey: 'openrouter-key' }],
  ] as const)('selects %s after the existing providers and removes Gemini-only reasoning', async (provider, keys) => {
    authorizeWithKeys({
      geminiApiKey: null,
      anthropicApiKey: null,
      ...keys,
    });

    const response = await POST();

    expect(response.status).toBe(200);
    const seededStudy = kvMock.saveStudy.mock.calls[0][0];
    expect(seededStudy.config.aiProvider).toBe(provider);
    expect(seededStudy.config).not.toHaveProperty('enableReasoning');
  });

  it('fails before writing when no AI provider is configured', async () => {
    authorizeWithKeys({ geminiApiKey: null, anthropicApiKey: null });

    const response = await POST();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'AI provider not configured. Configure the active AI transport before loading sample workspace data.',
    });
    expect(kvMock.getStudyChecked).toHaveBeenCalledWith(DEMO_STUDIES[0].id, kvClient);
    expect(kvMock.saveStudy).not.toHaveBeenCalled();
    expect(kvMock.saveInterview).not.toHaveBeenCalled();
  });

  it('uses the configured Gateway provider without a direct provider key', async () => {
    vi.stubEnv('AI_TRANSPORT', 'gateway');
    vi.stubEnv('AI_PROVIDER', 'openai');
    vi.stubEnv('VERCEL', '1');
    authorizeWithKeys({ geminiApiKey: null, anthropicApiKey: null });

    const response = await POST();

    expect(response.status).toBe(200);
    expect(kvMock.saveStudy.mock.calls[0][0].config).toMatchObject({
      aiProvider: 'openai',
      aiModel: 'gpt-5.6-terra',
    });
  });
});

describe('authenticated sample-workspace seed collisions and clear on Redis (ST-07)', () => {
  it('ST-07: refuses a present fixture study with 409 and writes nothing', async () => {
    kvMock.studyKeysExist.mockResolvedValue('present');

    const response = await POST();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'Sample workspace data is already loaded. Clear it before reloading.',
    });
    expect(kvMock.studyKeysExist).toHaveBeenCalledWith(DEMO_STUDIES.map(study => study.id), kvClient);
    expect(kvMock.saveStudy).not.toHaveBeenCalled();
    expect(kvMock.saveInterview).not.toHaveBeenCalled();
  });

  it('ST-07: an already-loaded sample stays 409 ahead of a missing provider, as before', async () => {
    authorizeWithKeys({ geminiApiKey: null, anthropicApiKey: null });
    kvMock.getStudyChecked.mockResolvedValue({ status: 'found', study: DEMO_STORED_STUDY });

    const response = await POST();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'Sample workspace data is already loaded. Clear it before reloading.',
    });
    expect(kvMock.getStudyChecked).toHaveBeenCalledWith(DEMO_STUDIES[0].id, kvClient);
    expect(kvMock.saveStudy).not.toHaveBeenCalled();
  });

  it('ST-07: the seeding path adds no fixture read before the store collision check', async () => {
    const response = await POST();

    expect(response.status).toBe(200);
    expect(kvMock.getStudyChecked).not.toHaveBeenCalled();
    expect(kvMock.studyKeysExist).toHaveBeenCalledTimes(1);
  });

  it('ST-07: reports unconfigured storage before provider configuration', async () => {
    kvMock.isKVAvailable.mockResolvedValue(false);
    authorizeWithKeys({ geminiApiKey: null, anthropicApiKey: null });

    const response = await POST();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'Storage not configured. Connect Upstash Redis before loading sample workspace data.',
    });
    expect(kvMock.saveStudy).not.toHaveBeenCalled();
  });

  it('ST-07: clears exactly the fixture study and interview ids through the store and reports counts', async () => {
    kvMock.clearSampleWorkspaceRecords.mockResolvedValue({
      status: 'cleared',
      studiesDeleted: DEMO_STUDIES.length,
      interviewsDeleted: DEMO_INTERVIEWS.length,
    });

    const response = await DELETE();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      message: 'Sample workspace data cleared',
      data: { studiesDeleted: DEMO_STUDIES.length, interviewsDeleted: DEMO_INTERVIEWS.length },
    });
    expect(kvMock.clearSampleWorkspaceRecords).toHaveBeenCalledWith({
      studyIds: DEMO_STUDIES.map(study => study.id),
      interviewIds: DEMO_INTERVIEWS.map(interview => interview.id),
    }, kvClient);
  });

  it('ST-07: fails closed without clearing when storage is unavailable, and 503s a possibly partial clear', async () => {
    kvMock.isKVAvailable.mockResolvedValue(false);
    const unavailable = await DELETE();
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({ error: 'Storage not configured.' });
    expect(kvMock.clearSampleWorkspaceRecords).not.toHaveBeenCalled();

    kvMock.isKVAvailable.mockResolvedValue(true);
    kvMock.clearSampleWorkspaceRecords.mockResolvedValue({ status: 'ambiguous' });
    const ambiguous = await DELETE();
    expect(ambiguous.status).toBe(503);
    await expect(ambiguous.json()).resolves.toMatchObject({ retryable: true, reason: 'ambiguous' });
  });

  it('ST-07: requires an authenticated researcher before any storage call', async () => {
    contextMock.getRequestContext.mockResolvedValue({ authorized: false, context: null, error: 'Unauthorized' });

    const response = await DELETE();

    expect(response.status).toBe(401);
    expect(kvMock.isKVAvailable).not.toHaveBeenCalled();
    expect(kvMock.clearSampleWorkspaceRecords).not.toHaveBeenCalled();
  });
});
