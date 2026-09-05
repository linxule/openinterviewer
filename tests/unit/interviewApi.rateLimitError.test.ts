import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, synthesizeInterview } from '@/services/interviewApi';
import { makeStudyConfig } from '../fixtures/models';

// synthesizeInterview et al. throw a typed ApiRequestError on any non-OK
// response so callers (Synthesis.tsx) can distinguish a 429 rate limit —
// with a server-provided Retry-After — from every other failure.

function jsonResponse(status: number, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => ({}),
  } as unknown as Response;
}

const studyConfig = makeStudyConfig({ id: 'study-rate-limit' });

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('interviewApi ApiRequestError', () => {
  it('parses Retry-After into retryAfterSeconds on a 429', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(429, { 'Retry-After': '900' })));

    await expect(
      synthesizeInterview([], studyConfig, { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] }, null)
    ).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 900,
      message: 'API error: 429',
    });
  });

  it('leaves retryAfterSeconds null when the header is missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(429)));

    await expect(
      synthesizeInterview([], studyConfig, { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] }, null)
    ).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: null,
    });
  });

  it('leaves retryAfterSeconds null when the header is unparseable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(429, { 'Retry-After': 'not-a-number' })));

    await expect(
      synthesizeInterview([], studyConfig, { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] }, null)
    ).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: null,
    });
  });

  it('raises the same ApiRequestError shape for a non-429 failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(500)));

    await expect(
      synthesizeInterview([], studyConfig, { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] }, null)
    ).rejects.toMatchObject({
      status: 500,
      retryAfterSeconds: null,
      message: 'API error: 500',
    });
  });

  it('is an instance of ApiRequestError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(429, { 'Retry-After': '30' })));

    try {
      await synthesizeInterview([], studyConfig, { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] }, null);
      expect.unreachable('expected synthesizeInterview to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiRequestError);
    }
  });
});
