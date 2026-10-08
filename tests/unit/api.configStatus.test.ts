import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const modeMock = vi.hoisted(() => ({ isHostedMode: vi.fn() }));
vi.mock('@/lib/mode', () => modeMock);

const contextMock = vi.hoisted(() => ({
  getHostedResearcherIdentity: vi.fn(),
  getRequestContext: vi.fn(),
}));
vi.mock('@/lib/researcherContext', () => contextMock);

const platformMock = vi.hoisted(() => ({
  getResearcherByIdChecked: vi.fn(),
  toResearcherProfile: vi.fn(),
}));
vi.mock('@/lib/platformDb', () => platformMock);

import { GET } from '@/app/api/config/status/route';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/config/status', () => {
  it('identifies hosted account credential availability without disclosing values', async () => {
    modeMock.isHostedMode.mockReturnValue(true);
    contextMock.getHostedResearcherIdentity.mockResolvedValue({
      authorized: true,
      researcherId: 'researcher-a',
    });
    platformMock.getResearcherByIdChecked.mockResolvedValue({
      status: 'found',
      researcher: { id: 'researcher-a' },
    });
    platformMock.toResearcherProfile.mockReturnValue({
      hasAnthropicKey: true,
      hasGeminiKey: false,
      hasOpenAiKey: true,
      hasOpenRouterKey: false,
    });

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      mode: 'hosted',
      aiTransport: 'direct',
      hasAnthropicKey: true,
      hasGeminiKey: false,
      hasOpenAiKey: true,
      hasOpenRouterKey: false,
      hasVoiceTranscription: false,
    });
  });

  it('identifies standalone environment credential availability', async () => {
    modeMock.isHostedMode.mockReturnValue(false);
    contextMock.getRequestContext.mockResolvedValue({
      authorized: true,
      context: {
        anthropicApiKey: null,
        geminiApiKey: 'configured-but-never-returned',
        openaiApiKey: null,
        openrouterApiKey: 'configured-but-never-returned',
      },
    });

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      mode: 'standalone',
      aiTransport: 'direct',
      hasAnthropicKey: false,
      hasGeminiKey: true,
      hasOpenAiKey: false,
      hasOpenRouterKey: true,
      hasVoiceTranscription: false,
    });
  });

  it('reports Gateway-backed provider availability without pretending OpenRouter is supported', async () => {
    vi.stubEnv('AI_TRANSPORT', 'gateway');
    vi.stubEnv('VERCEL', '1');
    modeMock.isHostedMode.mockReturnValue(false);
    contextMock.getRequestContext.mockResolvedValue({
      authorized: true,
      context: {
        anthropicApiKey: null,
        geminiApiKey: null,
        openaiApiKey: null,
        openrouterApiKey: null,
      },
    });

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      mode: 'standalone',
      aiTransport: 'gateway',
      hasAnthropicKey: true,
      hasGeminiKey: true,
      hasOpenAiKey: true,
      hasOpenRouterKey: false,
      hasVoiceTranscription: false,
    });
  });
});
