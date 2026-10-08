// @vitest-environment node
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { makeStoredStudy, makeStudyConfig } from '../fixtures/models';
import { standaloneTestContext } from '../helpers/workspaceStoreFixture';
import type { RedisPort } from '@/lib/redisPort';

/**
 * Voice input: /api/transcribe and the Workers AI adapter
 * (lib/transcription/workersAi.ts), on the canonical-context harness.
 *
 * Participant API canonical-context contract.
 *
 * /api/interview and /api/greeting must derive the AI provider/model from the
 * canonical server-side study configuration (resolved from the token's
 * studyId), never from client-supplied request-body provider/model fields.
 *
 * Regression coverage: a client-controlled legacy studyConfig may identify the
 * study, but cannot steer the provider or model.
 */

const contextMock = vi.hoisted(() => ({
  getParticipantRequestContext: vi.fn(),
  resolveParticipantOrPreviewContext: vi.fn((request: Request, options?: unknown) =>
    contextMock.getParticipantRequestContext(request, options)
  ),
  selectedStudyIdFromParticipantBody: vi.fn((body: Record<string, unknown>) => {
    if (typeof body.studyId === 'string' && body.studyId.length > 0) return body.studyId;
    const studyConfig = body.studyConfig;
    if (studyConfig && typeof studyConfig === 'object' && studyConfig !== null && 'id' in studyConfig) {
      const id = (studyConfig as { id?: unknown }).id;
      if (typeof id === 'string' && id.length > 0) return id;
    }
    return undefined;
  }),
  providerKeysFromContext: vi.fn((context: Record<string, unknown>) => ({
    geminiApiKey: context.geminiApiKey,
    anthropicApiKey: context.anthropicApiKey,
    openaiApiKey: context.openaiApiKey,
    openrouterApiKey: context.openrouterApiKey,
  })),
}));

vi.mock('@/lib/researcherContext', () => contextMock);

const providersMock = vi.hoisted(() => ({
  getInterviewProvider: vi.fn(),
  resolveProviderType: vi.fn((config?: { aiProvider?: string }) => (
    config?.aiProvider === 'claude' ? 'claude' : 'gemini'
  )),
  resolveSynthesisModel: vi.fn((config: { aiProvider?: string; aiModel?: string }) => (
    config?.aiModel ?? (config?.aiProvider === 'claude' ? 'claude-opus-4-5' : 'gemini-3.1-pro-preview')
  )),
}));

vi.mock('@/lib/providers', () => providersMock);

// The Redis workspace store reads through getStudyChecked; derive it from the
// getStudy fixture so both see the same record.
const kvMock = vi.hoisted(() => {
  const getStudy = vi.fn();
  return {
    getStudy,
    getStudyChecked: vi.fn(async (id: string) => {
      const study = await getStudy(id);
      return study ? { status: 'found', study } : { status: 'not-found' };
    }),
  };
});

vi.mock('@/lib/kv', () => kvMock);

const rateLimitMock = vi.hoisted(() => ({
  participantStoreAdmissionResponse: vi.fn(),
  participantAdmissionRefusal: vi.fn(() => null),
}));

vi.mock('@/lib/rateLimit', () => rateLimitMock);

const platformRateLimitMock = vi.hoisted(() => ({
  hostedAiRateLimitResponse: vi.fn(),
}));

vi.mock('@/lib/platformAiRateLimit', () => platformRateLimitMock);

const consentMock = vi.hoisted(() => ({
  verifyParticipantConsent: vi.fn(),
}));

vi.mock('@/lib/participantConsent', () => consentMock);

import { POST as transcribePOST } from '@/app/api/transcribe/route';
import { encodeWav } from '@/lib/voice/wavClip';
import {
  isAcceptedVoiceClip,
  MAX_VOICE_BYTES,
  transcribeVoiceClip,
  voiceTranscriptionAvailable,
  WORKERS_AI_TRANSCRIPTION_MODEL,
} from '@/lib/transcription/workersAi';
import { WORKER_INVOCATION_ACCESSOR } from '@/lib/runtime/workerInvocation';

const voiceConfig = makeStudyConfig({
  id: 'study-a',
  aiProvider: 'gemini',
  aiModel: 'gemini-2.5-flash',
  consentText: 'English consent.',
  interviewLanguages: ['en', 'ja'],
  consentTextTranslations: { ja: '日本語の同意文。' },
  voiceInput: 'installation',
});

const sessionContext = standaloneTestContext({} as RedisPort, { researcherId: 'researcher-a' });

const clip = () => encodeWav(new Float32Array(16_000).map((_, i) => Math.sin(i / 10) * 0.2));
const aiRun = vi.fn();

function withAiBinding() {
  (globalThis as Record<symbol, unknown>)[WORKER_INVOCATION_ACCESSOR] = () => ({ env: { AI: { run: aiRun } }, identity: null, source: 'fetch' });
}

const transcribeRequest = (bytes: Uint8Array = clip(), query = 'studyId=study-a&language=ja', type = 'audio/wav') =>
  new Request(`http://localhost/api/transcribe?${query}`, {
    method: 'POST',
    headers: { 'Content-Type': type },
    body: bytes as BodyInit,
  });

beforeEach(() => {
  vi.clearAllMocks();
  delete (globalThis as Record<symbol, unknown>)[WORKER_INVOCATION_ACCESSOR];
  aiRun.mockResolvedValue({ text: '  こんにちは  ' });
  contextMock.getParticipantRequestContext.mockResolvedValue({
    valid: true,
    context: sessionContext,
    studyId: 'study-a',
    isAdmin: false,
    participantSessionId: 'participant-session-a',
  });
  kvMock.getStudy.mockResolvedValue(makeStoredStudy({ id: 'study-a', config: voiceConfig }));
  rateLimitMock.participantStoreAdmissionResponse.mockResolvedValue(null);
  consentMock.verifyParticipantConsent.mockResolvedValue({
    status: 'accepted',
    consent: {
      version: 1,
      participantSessionId: 'participant-session-a',
      studyId: 'study-a',
      studyRevision: 1,
      consentHash: 'a'.repeat(64),
      acceptedAt: 1_700_000_000_000,
    },
  });
});

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[WORKER_INVOCATION_ACCESSOR];
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('voice clips', () => {
  it('accepts only 16 kHz mono 16-bit PCM WAV of at most 60 seconds', () => {
    expect(isAcceptedVoiceClip(clip())).toBe(true);
    expect(isAcceptedVoiceClip(encodeWav(new Float32Array(10), 44_100))).toBe(false);
    expect(isAcceptedVoiceClip(new TextEncoder().encode('RIFF....WAVEnot audio at all, just text'))).toBe(false);
    expect(isAcceptedVoiceClip(encodeWav(new Float32Array(16_000 * 61)))).toBe(false);
    expect(encodeWav(new Float32Array(16_000 * 60)).byteLength).toBe(MAX_VOICE_BYTES);
    const truncated = clip().slice(0, 100);
    expect(isAcceptedVoiceClip(truncated)).toBe(false);
  });
});

describe('Workers AI adapter', () => {
  it('calls the Worker binding once, directly, with the clip and the ISO language', async () => {
    withAiBinding();
    expect(voiceTranscriptionAvailable()).toBe(true);
    expect(await transcribeVoiceClip(clip(), 'zh')).toEqual({ ok: true, text: 'こんにちは' });
    expect(aiRun).toHaveBeenCalledTimes(1);
    const [model, input, options] = aiRun.mock.calls[0];
    expect(model).toBe(WORKERS_AI_TRANSCRIPTION_MODEL);
    expect(input).toMatchObject({ task: 'transcribe', language: 'zh', vad_filter: true });
    expect(typeof input.audio).toBe('string');
    expect(options).toBeUndefined();
  });

  it('uses the REST API on Node with an account id and token, and fails closed without them', async () => {
    expect(voiceTranscriptionAvailable()).toBe(false);
    expect(await transcribeVoiceClip(clip(), 'en')).toEqual({ ok: false, reason: 'unavailable' });
    vi.stubEnv('CLOUDFLARE_WORKERS_AI_ACCOUNT_ID', 'a'.repeat(32));
    vi.stubEnv('CLOUDFLARE_WORKERS_AI_TOKEN', 'fixture-token');
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ success: true, result: { text: 'hello' } }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await transcribeVoiceClip(clip(), 'en')).toEqual({ ok: true, text: 'hello' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/ai/run/${WORKERS_AI_TRANSCRIPTION_MODEL}`);
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }));
    expect(await transcribeVoiceClip(clip(), 'en')).toEqual({ ok: false, reason: 'provider-failure' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('POST /api/transcribe', () => {
  it('verifies consent in the named language, admits the request, then transcribes once', async () => {
    withAiBinding();
    const res = await transcribePOST(transcribeRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'こんにちは' });
    expect(consentMock.verifyParticipantConsent).toHaveBeenCalledWith(expect.objectContaining({ consentText: '日本語の同意文。' }), expect.anything());
    expect(rateLimitMock.participantStoreAdmissionResponse).toHaveBeenCalledWith(expect.anything(), 'study-a', 'transcribe', expect.anything(), expect.anything());
    expect(aiRun).toHaveBeenCalledTimes(1);
  });

  it('refuses a study that does not offer transcription by this installation', async () => {
    withAiBinding();
    for (const voiceInput of [undefined, 'off', 'browser'] as const) {
      kvMock.getStudy.mockResolvedValue(makeStoredStudy({ id: 'study-a', config: { ...voiceConfig, voiceInput } }));
      const res = await transcribePOST(transcribeRequest());
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('VOICE_NOT_ENABLED');
    }
    expect(aiRun).not.toHaveBeenCalled();
  });

  it('refuses before any provider call without consent, a format, a size or an offered language', async () => {
    withAiBinding();
    consentMock.verifyParticipantConsent.mockResolvedValueOnce({ status: 'missing' });
    expect((await transcribePOST(transcribeRequest())).status).toBe(428);
    expect((await transcribePOST(transcribeRequest(clip(), 'studyId=study-a&language=ja', 'audio/webm'))).status).toBe(415);
    expect((await transcribePOST(transcribeRequest(new Uint8Array(MAX_VOICE_BYTES + 1)))).status).toBe(413);
    expect((await transcribePOST(transcribeRequest(encodeWav(new Float32Array(100), 48_000)))).status).toBe(400);
    expect((await transcribePOST(transcribeRequest(clip(), 'studyId=study-a&language=ko'))).status).toBe(400);
    expect(aiRun).not.toHaveBeenCalled();
  });

  it('a limited request is not transcribed, and an unconfigured deployment says so', async () => {
    withAiBinding();
    rateLimitMock.participantStoreAdmissionResponse.mockResolvedValueOnce(new Response(null, { status: 429 }));
    expect((await transcribePOST(transcribeRequest())).status).toBe(429);
    expect(aiRun).not.toHaveBeenCalled();
    delete (globalThis as Record<symbol, unknown>)[WORKER_INVOCATION_ACCESSOR];
    const res = await transcribePOST(transcribeRequest());
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('VOICE_UNAVAILABLE');
  });

  it('a provider failure is a retryable 502 that never echoes the audio', async () => {
    withAiBinding();
    aiRun.mockRejectedValueOnce(new Error('boom'));
    const res = await transcribePOST(transcribeRequest());
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: 'VOICE_FAILED', retryable: true });
    expect(aiRun).toHaveBeenCalledTimes(1);
  });
});
