// Speech-to-text for participant voice input (study setting voiceInput =
// 'installation'): Cloudflare Workers AI Whisper large-v3-turbo. On the
// Cloudflare target through the Worker's `AI` binding, never through AI
// Gateway (the gateway is BYOK-only; Workers AI is billed by Cloudflare). On
// Node through the Workers AI REST API with an account id and an API token.
//
// One request, one attempt: no retry, no fallback. The audio is never
// stored or logged, and neither is the text; only the outcome kind is.

import { workerBinding } from '@/lib/runtime/workerInvocation';
import { LANGUAGE_TAGS, type InterviewLanguage } from '@/lib/i18n/languages';

export const WORKERS_AI_TRANSCRIPTION_MODEL = '@cf/openai/whisper-large-v3-turbo';

/** The clip the browser sends: 16 kHz mono 16-bit PCM WAV, at most 60 seconds. */
export const VOICE_SAMPLE_RATE = 16_000;
export const MAX_VOICE_SECONDS = 60;
const WAV_HEADER_BYTES = 44;
export const MAX_VOICE_BYTES = WAV_HEADER_BYTES + VOICE_SAMPLE_RATE * 2 * MAX_VOICE_SECONDS;
const TRANSCRIPTION_TIMEOUT_MS = 30_000;
const MAX_TRANSCRIPT_CHARACTERS = 5_000;

export type TranscriptionOutcome =
  | { ok: true; text: string }
  | { ok: false; reason: 'unavailable' | 'provider-failure' | 'timeout' };

type AiBinding = { run(model: string, input: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown> };

function aiBinding(): AiBinding | null {
  const binding = workerBinding('AI');
  return binding && typeof (binding as Record<string, unknown>).run === 'function' ? binding as AiBinding : null;
}

function restCredentials(): { accountId: string; token: string } | null {
  const accountId = process.env.CLOUDFLARE_WORKERS_AI_ACCOUNT_ID?.trim();
  const token = process.env.CLOUDFLARE_WORKERS_AI_TOKEN?.trim();
  return accountId && token && /^[a-f0-9]{32}$/.test(accountId) ? { accountId, token } : null;
}

/** Whether this deployment can transcribe: the Worker binding, else the Node REST credentials. */
export function voiceTranscriptionAvailable(): boolean {
  return aiBinding() !== null || restCredentials() !== null;
}

/**
 * A 16 kHz mono 16-bit PCM WAV of at most 60 seconds, checked byte by byte:
 * anything else is refused before any provider request.
 */
export function isAcceptedVoiceClip(bytes: Uint8Array): boolean {
  if (bytes.byteLength <= WAV_HEADER_BYTES || bytes.byteLength > MAX_VOICE_BYTES) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  const dataBytes = view.getUint32(40, true);
  return tag(0) === 'RIFF'
    && tag(8) === 'WAVE'
    && tag(12) === 'fmt '
    && view.getUint32(16, true) === 16       // PCM fmt chunk size
    && view.getUint16(20, true) === 1        // PCM
    && view.getUint16(22, true) === 1        // mono
    && view.getUint32(24, true) === VOICE_SAMPLE_RATE
    && view.getUint16(34, true) === 16       // bits per sample
    && tag(36) === 'data'
    && dataBytes > 0
    && dataBytes % 2 === 0
    && dataBytes === bytes.byteLength - WAV_HEADER_BYTES;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function modelInput(bytes: Uint8Array, language: InterviewLanguage): Record<string, unknown> {
  return {
    audio: base64(bytes),
    task: 'transcribe',
    // Whisper takes the ISO 639-1 code.
    language: LANGUAGE_TAGS[language].split('-')[0],
    vad_filter: true,
    condition_on_previous_text: false,
  };
}

function textFrom(result: unknown): string | null {
  const text = (result as { text?: unknown } | null)?.text;
  return typeof text === 'string' ? text.trim().slice(0, MAX_TRANSCRIPT_CHARACTERS) : null;
}

export async function transcribeVoiceClip(bytes: Uint8Array, language: InterviewLanguage): Promise<TranscriptionOutcome> {
  const timeout = AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS);
  try {
    const binding = aiBinding();
    if (binding) {
      const result = await Promise.race([
        binding.run(WORKERS_AI_TRANSCRIPTION_MODEL, modelInput(bytes, language)),
        new Promise<never>((_, reject) => timeout.addEventListener('abort', () => reject(timeout.reason), { once: true })),
      ]);
      const text = textFrom(result);
      return text === null ? { ok: false, reason: 'provider-failure' } : { ok: true, text };
    }
    const credentials = restCredentials();
    if (!credentials) return { ok: false, reason: 'unavailable' };
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/ai/run/${WORKERS_AI_TRANSCRIPTION_MODEL}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(modelInput(bytes, language)),
        signal: timeout,
      },
    );
    if (!response.ok) return { ok: false, reason: 'provider-failure' };
    const body = await response.json().catch(() => null) as { success?: unknown; result?: unknown } | null;
    const text = body?.success === true ? textFrom(body.result) : null;
    return text === null ? { ok: false, reason: 'provider-failure' } : { ok: true, text };
  } catch (error) {
    return { ok: false, reason: timeout.aborted || (error as Error)?.name === 'TimeoutError' ? 'timeout' : 'provider-failure' };
  }
}
