// Browser-side: a recorded clip (whatever the browser records: WebM/Opus in
// Chrome and Firefox, MP4/AAC in Safari) as the 16 kHz mono 16-bit WAV that
// /api/transcribe accepts. Decoded and resampled with Web Audio, so the
// server never depends on a container format.

export const CLIP_SAMPLE_RATE = 16_000;
export const MAX_CLIP_SECONDS = 60;

export function encodeWav(samples: Float32Array, sampleRate = CLIP_SAMPLE_RATE): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, text: string) => { for (let i = 0; i < text.length; i += 1) bytes[offset + i] = text.charCodeAt(i); };
  write(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return bytes;
}

/** Decode, mix down to mono, resample to 16 kHz, cap at 60 seconds and encode. */
export async function toVoiceClip(recording: Blob): Promise<Uint8Array> {
  const AudioContextClass = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass || typeof OfflineAudioContext === 'undefined') throw new Error('audio-unsupported');
  const context = new AudioContextClass();
  let decoded: AudioBuffer;
  try {
    decoded = await context.decodeAudioData(await recording.arrayBuffer());
  } finally {
    void context.close().catch(() => undefined);
  }
  const frames = Math.max(1, Math.ceil(Math.min(decoded.duration, MAX_CLIP_SECONDS) * CLIP_SAMPLE_RATE));
  const offline = new OfflineAudioContext(1, frames, CLIP_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return encodeWav(rendered.getChannelData(0));
}
