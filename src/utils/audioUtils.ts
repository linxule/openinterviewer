// Audio utilities for Gemini Live API integration
// Handles PCM audio encoding/decoding for voice interviews

import { Blob } from '@google/genai';

export function base64ToUint8Array(base64: string): Uint8Array {
  if (!base64 || typeof base64 !== 'string') {
    console.warn("Empty base64 input");
    return new Uint8Array(0);
  }

  // Remove any whitespace/newlines
  const cleanBase64 = base64.replace(/\s/g, '');

  try {
    const binaryString = atob(cleanBase64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  } catch (e) {
    console.warn("Base64 decode issue:", e);
    return new Uint8Array(0);
  }
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number = 24000,
  numChannels: number = 1
): Promise<AudioBuffer> {
  if (!data || data.byteLength === 0) {
    throw new Error("Empty audio data provided to decodeAudioData");
  }

  // Ensure strict alignment for Int16Array
  let alignedData = data;
  if (data.byteOffset % 2 !== 0 || data.byteLength % 2 !== 0) {
    alignedData = new Uint8Array(data.length);
    alignedData.set(data);
  }

  // Convert raw PCM 16-bit LE to AudioBuffer
  const dataInt16 = new Int16Array(alignedData.buffer, alignedData.byteOffset, alignedData.byteLength / 2);
  const frameCount = dataInt16.length / numChannels;

  try {
    const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

    for (let channel = 0; channel < numChannels; channel++) {
      const channelData = buffer.getChannelData(channel);
      for (let i = 0; i < frameCount; i++) {
        // Convert int16 to float32 [-1.0, 1.0]
        const val = dataInt16[i * numChannels + channel] / 32768.0;
        channelData[i] = Math.max(-1, Math.min(1, val));
      }
    }
    return buffer;
  } catch (e) {
    console.error("Audio buffer creation failed", e);
    return ctx.createBuffer(1, 1, sampleRate);
  }
}

export function createPcmBlob(data: Float32Array, sampleRate: number = 16000): Blob {
  // Convert Float32 from AudioContext to PCM 16-bit
  const l = data.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    // Clamp and convert
    const s = Math.max(-1, Math.min(1, data[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }

  return {
    data: arrayBufferToBase64(int16.buffer),
    mimeType: `audio/pcm;rate=${sampleRate}`,
  };
}

export async function playAudioData(base64Audio: string, sampleRate = 24000): Promise<void> {
  let ctx: AudioContext | null = null;
  try {
    ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)({ sampleRate });
    const audioBuffer = await decodeAudioData(base64ToUint8Array(base64Audio), ctx, sampleRate);
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    source.start(0);
    return new Promise((resolve) => {
      source.onended = () => {
        ctx?.close().catch(() => { /* ignore if already closed */ });
        resolve();
      };
    });
  } catch (e) {
    console.error("Audio playback error", e);
    ctx?.close().catch(() => { /* ignore */ });
  }
}

