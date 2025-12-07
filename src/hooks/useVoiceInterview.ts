// Voice Interview Hook - Gemini Live API Integration
// Handles speech-to-text and text-to-speech for interviews

'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { VoiceConfig, VoiceName, ParticipantAudioPreference } from '@/types';
import { createPcmBlob, base64ToUint8Array, decodeAudioData } from '@/utils/audioUtils';

// Gemini Live API model for voice
const VOICE_MODEL = 'gemini-2.5-flash-native-audio-preview-09-2025';

export interface UseVoiceInterviewOptions {
  voiceConfig: VoiceConfig;
  onTranscript: (text: string) => void;
  onError?: (error: string) => void;
}

export interface UseVoiceInterviewReturn {
  isConnected: boolean;
  isRecording: boolean;
  isSpeaking: boolean;
  audioLevel: number;
  audioPreference: ParticipantAudioPreference;
  startRecording: () => Promise<void>;
  stopRecording: () => void;
  toggleTTS: () => void;
  playAudioResponse: (text: string) => Promise<void>;
  disconnect: () => void;
}

export function useVoiceInterview({
  voiceConfig,
  onTranscript,
  onError
}: UseVoiceInterviewOptions): UseVoiceInterviewReturn {
  // Connection state
  const [isConnected, setIsConnected] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);

  // Audio preference tracking
  const [audioPreference, setAudioPreference] = useState<ParticipantAudioPreference>({
    initialChoice: voiceConfig.sttEnabled ? 'voice' : 'text-only',
    wantsToHear: voiceConfig.ttsEnabled,
    changedMidInterview: false,
    toggleCount: 0,
    totalAudioDuration: 0
  });

  // Refs for audio management
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const outputContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const liveSessionRef = useRef<any>(null);
  const audioQueueRef = useRef<AudioBufferSourceNode[]>([]);
  // Use ref for recording state to avoid stale closure in onaudioprocess callback
  const isRecordingRef = useRef<boolean>(false);

  // Cleanup function
  const cleanup = useCallback(() => {
    // Stop media stream
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }

    // Disconnect audio nodes
    if (processorRef.current) {
      try { processorRef.current.disconnect(); } catch (e) { /* ignore */ }
      processorRef.current = null;
    }

    // Stop queued audio
    audioQueueRef.current.forEach(source => {
      try { source.stop(); source.disconnect(); } catch (e) { /* ignore */ }
    });
    audioQueueRef.current = [];

    // Close audio contexts
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      try { audioContextRef.current.close(); } catch (e) { /* ignore */ }
    }
    if (outputContextRef.current && outputContextRef.current.state !== 'closed') {
      try { outputContextRef.current.close(); } catch (e) { /* ignore */ }
    }

    // Close live session
    if (liveSessionRef.current) {
      try { liveSessionRef.current.close(); } catch (e) { /* ignore */ }
      liveSessionRef.current = null;
    }

    setIsConnected(false);
    setIsRecording(false);
    setIsSpeaking(false);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  // Connect to Gemini Live API for speech
  const connectLiveAPI = useCallback(async () => {
    const apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY;
    if (!apiKey) {
      onError?.('Gemini API key not configured for voice');
      return null;
    }

    try {
      // Dynamic import to avoid SSR issues
      const { GoogleGenAI, Modality, StartSensitivity, EndSensitivity } = await import('@google/genai');
      const ai = new GoogleGenAI({ apiKey });

      const session = await ai.live.connect({
        model: VOICE_MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: voiceConfig.ttsVoice }
            }
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          realtimeInputConfig: {
            automaticActivityDetection: {
              disabled: false,
              startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
              endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
              prefixPaddingMs: 100,
              silenceDurationMs: 500
            }
          }
        },
        callbacks: {
          onopen: () => {
            setIsConnected(true);
          },
          onclose: () => {
            setIsConnected(false);
            setIsRecording(false);
            isRecordingRef.current = false;
            // Clear session ref so next startRecording reconnects
            liveSessionRef.current = null;
          },
          onerror: (event: ErrorEvent) => {
            console.error('Live API error:', event);
            onError?.(event.message || 'Voice connection error');
          },
          onmessage: async (message: any) => {
            // Handle transcription
            if (message.serverContent?.inputTranscript) {
              const transcript = message.serverContent.inputTranscript;
              if (transcript.trim()) {
                onTranscript(transcript);
              }
            }

            // Handle audio response (TTS)
            if (message.serverContent?.modelTurn?.parts) {
              for (const part of message.serverContent.modelTurn.parts) {
                if (part.inlineData?.mimeType?.startsWith('audio/') && audioPreference.wantsToHear) {
                  await playAudioChunk(part.inlineData.data);
                }
              }
            }
          }
        }
      });

      return session;
    } catch (error) {
      console.error('Failed to connect to Live API:', error);
      onError?.('Failed to connect to voice service');
      return null;
    }
  }, [voiceConfig.ttsVoice, onTranscript, onError, audioPreference.wantsToHear]);

  // Play audio chunk from Live API
  const playAudioChunk = useCallback(async (base64Audio: string) => {
    if (!audioPreference.wantsToHear) return;

    try {
      if (!outputContextRef.current || outputContextRef.current.state === 'closed') {
        outputContextRef.current = new AudioContext({ sampleRate: 24000 });
      }

      const ctx = outputContextRef.current;
      const audioBuffer = await decodeAudioData(base64ToUint8Array(base64Audio), ctx, 24000);

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);

      setIsSpeaking(true);
      source.onended = () => {
        setIsSpeaking(false);
        // Remove from queue to prevent memory leak
        const idx = audioQueueRef.current.indexOf(source);
        if (idx > -1) audioQueueRef.current.splice(idx, 1);
        // Track audio duration
        setAudioPreference(prev => ({
          ...prev,
          totalAudioDuration: (prev.totalAudioDuration || 0) + audioBuffer.duration
        }));
      };

      source.start(0);
      audioQueueRef.current.push(source);
    } catch (error) {
      console.error('Audio playback error:', error);
    }
  }, [audioPreference.wantsToHear]);

  // Start recording
  const startRecording = useCallback(async () => {
    if (!voiceConfig.sttEnabled) {
      onError?.('Speech input is disabled for this study');
      return;
    }

    try {
      // Connect to Live API if not connected
      if (!liveSessionRef.current) {
        const session = await connectLiveAPI();
        if (!session) return;
        liveSessionRef.current = session;
      }

      // Request microphone access
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true
        }
      });
      mediaStreamRef.current = stream;

      // Create audio context for input (16kHz)
      audioContextRef.current = new AudioContext({ sampleRate: 16000 });
      const ctx = audioContextRef.current;

      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        // Use ref instead of state to avoid stale closure
        // (state is captured at callback creation time)
        if (!liveSessionRef.current || !isRecordingRef.current) return;

        const inputData = e.inputBuffer.getChannelData(0);

        // Calculate audio level for visualization
        let sum = 0;
        for (let i = 0; i < inputData.length; i++) {
          sum += inputData[i] * inputData[i];
        }
        const rms = Math.sqrt(sum / inputData.length);
        setAudioLevel(Math.min(1, rms * 10));

        // Send audio to Live API
        const pcmBlob = createPcmBlob(inputData, 16000);
        liveSessionRef.current.sendRealtimeInput({ media: pcmBlob });
      };

      source.connect(processor);
      processor.connect(ctx.destination);

      // Set ref BEFORE state to ensure callback sees correct value immediately
      isRecordingRef.current = true;
      setIsRecording(true);
    } catch (error) {
      console.error('Failed to start recording:', error);
      onError?.('Could not access microphone');
    }
  }, [voiceConfig.sttEnabled, connectLiveAPI, onError]);

  // Stop recording
  const stopRecording = useCallback(() => {
    if (processorRef.current) {
      try { processorRef.current.disconnect(); } catch (e) { /* ignore */ }
      processorRef.current = null;
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }

    isRecordingRef.current = false;
    setIsRecording(false);
    setAudioLevel(0);
  }, []);

  // Toggle TTS preference
  const toggleTTS = useCallback(() => {
    setAudioPreference(prev => ({
      ...prev,
      wantsToHear: !prev.wantsToHear,
      changedMidInterview: true,
      toggleCount: prev.toggleCount + 1
    }));
  }, []);

  // Play audio response (for TTS synthesis via API)
  const playAudioResponse = useCallback(async (text: string) => {
    if (!audioPreference.wantsToHear || !voiceConfig.ttsEnabled) return;

    // For TTS, we can use the standard TTS API or Live API
    // This is a placeholder - in production you'd call a TTS endpoint
    console.log('TTS requested for:', text);
  }, [audioPreference.wantsToHear, voiceConfig.ttsEnabled]);

  // Disconnect
  const disconnect = useCallback(() => {
    isRecordingRef.current = false;
    cleanup();
  }, [cleanup]);

  return {
    isConnected,
    isRecording,
    isSpeaking,
    audioLevel,
    audioPreference,
    startRecording,
    stopRecording,
    toggleTTS,
    playAudioResponse,
    disconnect
  };
}
