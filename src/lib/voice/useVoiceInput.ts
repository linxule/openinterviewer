'use client';

// Participant voice input (study setting voiceInput). 'installation' records
// a clip of at most 60 seconds, converts it to 16 kHz WAV in the browser and
// sends it to /api/transcribe (Workers AI); 'browser' uses the browser's own
// SpeechRecognition; device mode requires local processing with no fallback.
// The text lands in the answer box to check; nothing is sent automatically.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { VoiceInputMode } from '@/types';
import type { InterviewLanguage } from '@/lib/i18n/languages';
import { buildParticipantOrPreviewHeaders } from '@/services/participantHeaders';
import { MAX_CLIP_SECONDS, toVoiceClip } from './wavClip';

export type VoiceState =
  | { kind: 'idle' }
  | { kind: 'recording'; seconds: number }
  | { kind: 'listening' }
  | { kind: 'transcribing' }
  | { kind: 'preparing' }
  | { kind: 'error'; reason: 'denied' | 'failed' | 'unsupported' | 'limited' | 'unavailable' | 'deviceUnavailable' };

/** Shared by local availability, installation and recognition.
 * Chrome 155 reports all six as available or downloadable for local processing (checked 2026-10-10).
 */
export const SPEECH_TAGS: Record<InterviewLanguage, string> = {
  en: 'en-US', zh: 'zh-CN', fr: 'fr-FR', ja: 'ja-JP', ko: 'ko-KR', es: 'es-ES',
};

type SpeechRecognitionLike = {
  lang: string;
  processLocally?: boolean;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
};

type DeviceAvailability = 'available' | 'downloadable' | 'downloading' | 'unavailable';
type LocalSpeechOptions = { langs: string[]; processLocally: true };
type SpeechRecognitionClass = {
  new (): SpeechRecognitionLike;
  available?: (options: LocalSpeechOptions) => Promise<DeviceAvailability>;
  install?: (options: LocalSpeechOptions) => Promise<boolean>;
};

function speechRecognitionClass(): SpeechRecognitionClass | null {
  if (typeof window === 'undefined') return null;
  const candidate = (window as unknown as Record<string, unknown>).SpeechRecognition
    ?? (window as unknown as Record<string, unknown>).webkitSpeechRecognition;
  return typeof candidate === 'function' ? candidate as SpeechRecognitionClass : null;
}

export function voiceInputSupported(mode: VoiceInputMode | undefined): boolean {
  if (typeof window === 'undefined') return false;
  if (mode === 'installation') {
    return typeof navigator !== 'undefined'
      && typeof navigator.mediaDevices?.getUserMedia === 'function'
      && typeof window.MediaRecorder === 'function';
  }
  if (mode === 'browser') return speechRecognitionClass() !== null;
  return false;
}

// Remember terminal device failures across interview remounts in this tab.
// Only a capability decision and non-secret session selector, never audio/text.
// Memory retains it when sessionStorage is unavailable.
const disabledDeviceSessions = new Set<string>();
function deviceSessionDisabled(key: string): boolean {
  if (disabledDeviceSessions.has(key)) return true;
  try { return sessionStorage.getItem(key) === '1'; } catch { return false; }
}

export function useVoiceInput(options: {
  mode: VoiceInputMode | undefined;
  language: InterviewLanguage;
  studyId: string | undefined;
  researcherPreview: boolean;
  participantSessionHandle: string | null;
  onText: (text: string) => void;
}) {
  const { mode, language, studyId, researcherPreview, participantSessionHandle, onText } = options;
  const deviceSessionKey = `oi:device-voice-unavailable:${researcherPreview ? 'preview' : participantSessionHandle ?? 'session'}:${studyId ?? ''}`;
  const [state, setState] = useState<VoiceState>({ kind: 'idle' });
  const [supported, setSupported] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const mounted = useRef(true);
  const onTextRef = useRef(onText);
  const deviceAvailability = useRef<DeviceAvailability>('unavailable');
  const deviceDisabled = useRef(false);
  const preparing = useRef(false);
  const generation = useRef(0);
  useEffect(() => { onTextRef.current = onText; }, [onText]);

  // Feature detection runs after mount so the server and first client render agree.
  useEffect(() => {
    if (mode !== 'device') setSupported(voiceInputSupported(mode));
  }, [mode]);

  // Device mode re-checks local availability per language. Kept separate so a
  // language change never resets or stops installation/browser voice input.
  useEffect(() => {
    if (mode !== 'device') return;
    const currentGeneration = ++generation.current;
    deviceDisabled.current = deviceSessionDisabled(deviceSessionKey);
    setState(deviceDisabled.current ? { kind: 'error', reason: 'deviceUnavailable' } : { kind: 'idle' });
    preparing.current = false;
    deviceAvailability.current = 'unavailable';
    setSupported(false);
    if (!deviceDisabled.current) {
      const Recognition = speechRecognitionClass();
      if (typeof Recognition?.available === 'function' && typeof Recognition.install === 'function') {
        // A missing/rejected API is not permission to use remote dictation.
        void (async () => {
          try {
            const availability = await Recognition.available!({ langs: [SPEECH_TAGS[language]], processLocally: true });
            if (generation.current !== currentGeneration) return;
            deviceAvailability.current = availability;
            setSupported(['available', 'downloadable', 'downloading'].includes(availability));
          } catch {
            if (generation.current === currentGeneration) setSupported(false);
          }
        })();
      }
    }
    return () => {
      generation.current += 1;
      const session = recognition.current;
      recognition.current = null;
      session?.stop();
    };
  }, [mode, language, deviceSessionKey]);

  const disableDevice = useCallback(() => {
    deviceDisabled.current = true;
    disabledDeviceSessions.add(deviceSessionKey);
    try { sessionStorage.setItem(deviceSessionKey, '1'); } catch { /* In-memory fallback. */ }
    deviceAvailability.current = 'unavailable';
    setSupported(false);
    setState({ kind: 'error', reason: 'deviceUnavailable' });
    const session = recognition.current;
    recognition.current = null;
    session?.stop();
  }, [deviceSessionKey]);

  const clearTimer = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimer();
      recognition.current?.stop();
      if (recorder.current?.state === 'recording') recorder.current.stop();
      recorder.current?.stream.getTracks().forEach((track) => track.stop());
    };
  }, []);

  const transcribe = useCallback(async (recording: Blob) => {
    try {
      const clip = await toVoiceClip(recording);
      const query = new URLSearchParams({ ...(studyId ? { studyId } : {}), language });
      const response = await fetch(`/api/transcribe?${query}`, {
        method: 'POST',
        headers: { ...buildParticipantOrPreviewHeaders({ researcherPreview, participantSessionHandle }), 'Content-Type': 'audio/wav' },
        body: clip as BodyInit,
      });
      const data = await response.json().catch(() => ({})) as { text?: unknown };
      if (!mounted.current) return;
      if (!response.ok || typeof data.text !== 'string') {
        // A limit or an outage is not a failed recording: say which.
        setState({ kind: 'error', reason: response.status === 429 ? 'limited' : response.status === 503 ? 'unavailable' : 'failed' });
        return;
      }
      if (data.text.trim()) onTextRef.current(data.text.trim());
      setState({ kind: 'idle' });
    } catch {
      if (mounted.current) setState({ kind: 'error', reason: 'failed' });
    }
  }, [language, participantSessionHandle, researcherPreview, studyId]);

  const startRecording = useCallback(async () => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setState({ kind: 'error', reason: 'denied' });
      return;
    }
    if (!mounted.current) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const chunks: Blob[] = [];
    const media = new MediaRecorder(stream);
    recorder.current = media;
    media.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data); };
    media.onstop = () => {
      clearTimer();
      stream.getTracks().forEach((track) => track.stop());
      recorder.current = null;
      if (!mounted.current) return;
      setState({ kind: 'transcribing' });
      void transcribe(new Blob(chunks, { type: media.mimeType || 'audio/webm' }));
    };
    media.start();
    const started = Date.now();
    setState({ kind: 'recording', seconds: 0 });
    timer.current = setInterval(() => {
      const seconds = Math.floor((Date.now() - started) / 1000);
      if (seconds >= MAX_CLIP_SECONDS && media.state === 'recording') media.stop();
      else setState({ kind: 'recording', seconds });
    }, 250);
  }, [transcribe]);

  const startListening = useCallback(() => {
    const Recognition = speechRecognitionClass();
    if (!Recognition) {
      if (mode === 'device') disableDevice();
      else setState({ kind: 'error', reason: 'unsupported' });
      return;
    }
    let session: SpeechRecognitionLike;
    try { session = new Recognition(); } catch {
      if (mode === 'device') disableDevice();
      else setState({ kind: 'error', reason: 'failed' });
      return;
    }
    if (mode === 'device') {
      // Never start a device recognizer without the browser's local-only flag.
      // A rejected/ignored setter fails closed too.
      try {
        // A browser without the attribute would accept the assignment as a plain
        // property and recognize in the cloud, so require it to exist first.
        if (!('processLocally' in session)) throw new Error('Local recognition unsupported');
        session.processLocally = true;
        if (session.processLocally !== true) throw new Error('Local recognition unavailable');
      } catch {
        disableDevice();
        return;
      }
    }
    session.lang = SPEECH_TAGS[language];
    session.continuous = true;
    session.interimResults = false;
    session.onresult = (event) => {
      if (!mounted.current || recognition.current !== session) return;
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result.isFinal && result[0].transcript.trim()) onTextRef.current(result[0].transcript.trim());
      }
    };
    session.onerror = (event) => {
      if (!mounted.current || recognition.current !== session) return;
      if (mode === 'device' && ['language-not-supported', 'service-not-allowed'].includes(event.error)) {
        disableDevice();
        return;
      }
      setState({ kind: 'error', reason: event.error === 'not-allowed' || event.error === 'service-not-allowed' ? 'denied' : 'failed' });
    };
    session.onend = () => {
      if (recognition.current !== session) return;
      recognition.current = null;
      if (mounted.current) setState((current) => (current.kind === 'listening' ? { kind: 'idle' } : current));
    };
    recognition.current = session;
    setState({ kind: 'listening' });
    try {
      session.start();
    } catch {
      if (mode === 'device') disableDevice();
      else {
        recognition.current = null;
        setState({ kind: 'error', reason: 'failed' });
      }
    }
  }, [language, mode, disableDevice]);

  const prepareDevice = useCallback(async () => {
    if (preparing.current || deviceDisabled.current) return;
    const Recognition = speechRecognitionClass();
    if (typeof Recognition?.install !== 'function') {
      disableDevice();
      return;
    }
    preparing.current = true;
    const currentGeneration = generation.current;
    setState({ kind: 'preparing' });
    try {
      const installed = await Recognition.install({ langs: [SPEECH_TAGS[language]], processLocally: true });
      if (!mounted.current || generation.current !== currentGeneration) return;
      if (!installed) disableDevice();
      else {
        deviceAvailability.current = 'available';
        // Do not open the microphone unexpectedly after a slow download.
        // The participant can keep typing/sending, then press the mic when ready.
        setState({ kind: 'idle' });
      }
    } catch {
      if (mounted.current && generation.current === currentGeneration) disableDevice();
    } finally {
      if (generation.current === currentGeneration) preparing.current = false;
    }
  }, [language, disableDevice]);

  const toggle = useCallback(() => {
    if (state.kind === 'recording') {
      recorder.current?.stop();
      return;
    }
    if (state.kind === 'listening') {
      recognition.current?.stop();
      return;
    }
    if (state.kind === 'transcribing' || preparing.current || !supported) return;
    if (mode === 'installation') void startRecording();
    else if (mode === 'browser') startListening();
    else if (mode === 'device' && !deviceDisabled.current) {
      if (deviceAvailability.current === 'available') startListening();
      else if (deviceAvailability.current === 'downloadable' || deviceAvailability.current === 'downloading') void prepareDevice();
    }
  }, [mode, startListening, startRecording, prepareDevice, state.kind, supported]);

  return { enabled: mode === 'installation' || mode === 'browser' || mode === 'device', supported, state, toggle };
}
