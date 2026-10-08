'use client';

// Participant voice input (study setting voiceInput). 'installation' records
// a clip of at most 60 seconds, converts it to 16 kHz WAV in the browser and
// sends it to /api/transcribe (Workers AI); 'browser' uses the browser's own
// SpeechRecognition. Either way the text lands in the answer box for the
// participant to check before sending; nothing is sent automatically.

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
  | { kind: 'error'; reason: 'denied' | 'failed' | 'unsupported' | 'limited' | 'unavailable' };

/** Regional tags the browsers' speech services expect. */
const SPEECH_TAGS: Record<InterviewLanguage, string> = {
  en: 'en-US', zh: 'zh-CN', fr: 'fr-FR', ja: 'ja-JP', ko: 'ko-KR', es: 'es-ES',
};

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
};

function speechRecognitionClass(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null;
  const candidate = (window as unknown as Record<string, unknown>).SpeechRecognition
    ?? (window as unknown as Record<string, unknown>).webkitSpeechRecognition;
  return typeof candidate === 'function' ? candidate as new () => SpeechRecognitionLike : null;
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

export function useVoiceInput(options: {
  mode: VoiceInputMode | undefined;
  language: InterviewLanguage;
  studyId: string | undefined;
  researcherPreview: boolean;
  participantSessionHandle: string | null;
  onText: (text: string) => void;
}) {
  const { mode, language, studyId, researcherPreview, participantSessionHandle, onText } = options;
  const [state, setState] = useState<VoiceState>({ kind: 'idle' });
  const [supported, setSupported] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const mounted = useRef(true);
  const onTextRef = useRef(onText);
  useEffect(() => { onTextRef.current = onText; }, [onText]);

  // Feature detection runs after mount so the server and first client render agree.
  useEffect(() => { setSupported(voiceInputSupported(mode)); }, [mode]);

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
      setState({ kind: 'error', reason: 'unsupported' });
      return;
    }
    const session = new Recognition();
    session.lang = SPEECH_TAGS[language];
    session.continuous = true;
    session.interimResults = false;
    session.onresult = (event) => {
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result.isFinal && result[0].transcript.trim()) onTextRef.current(result[0].transcript.trim());
      }
    };
    session.onerror = (event) => {
      if (!mounted.current) return;
      setState({ kind: 'error', reason: event.error === 'not-allowed' || event.error === 'service-not-allowed' ? 'denied' : 'failed' });
    };
    session.onend = () => {
      recognition.current = null;
      if (mounted.current) setState((current) => (current.kind === 'listening' ? { kind: 'idle' } : current));
    };
    recognition.current = session;
    session.start();
    setState({ kind: 'listening' });
  }, [language]);

  const toggle = useCallback(() => {
    if (state.kind === 'recording') {
      recorder.current?.stop();
      return;
    }
    if (state.kind === 'listening') {
      recognition.current?.stop();
      return;
    }
    if (state.kind === 'transcribing') return;
    if (mode === 'installation') void startRecording();
    else if (mode === 'browser') startListening();
  }, [mode, startListening, startRecording, state.kind]);

  return { enabled: mode === 'installation' || mode === 'browser', supported, state, toggle };
}
