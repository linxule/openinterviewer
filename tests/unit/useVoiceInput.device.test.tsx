import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { SPEECH_TAGS, useVoiceInput } from '@/lib/voice/useVoiceInput';
import type { InterviewLanguage } from '@/lib/i18n/languages';

class Recognition {
  static available = vi.fn();
  static install = vi.fn();
  static sessions: Recognition[] = [];
  lang = '';
  processLocally = false;
  continuous = false;
  interimResults = true;
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn(() => {
    // Every started instance must satisfy the local-only contract, including retries.
    expect(this.processLocally).toBe(true);
    Recognition.sessions.push(this);
  });
  stop = vi.fn(() => this.onend?.());
}
const onText = vi.fn();
let sessionNumber = 0;
function options(language: InterviewLanguage = 'en') {
  return { mode: 'device' as const, language, studyId: 'study-device', researcherPreview: false,
    participantSessionHandle: `device-session-${sessionNumber}`, onText };
}
const mount = () => renderHook(() => useVoiceInput(options()));

beforeEach(() => {
  sessionNumber += 1;
  sessionStorage.clear();
  Recognition.sessions = [];
  Recognition.available.mockResolvedValue('available');
  Recognition.install.mockResolvedValue(true);
  vi.stubGlobal('SpeechRecognition', Recognition);
  vi.stubGlobal('webkitSpeechRecognition', undefined);
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe('device-only speech input', () => {
  it.each(['available', 'downloadable', 'downloading'])('offers the mic only after %s is resolved', async availability => {
    let resolve!: (value: string) => void;
    Recognition.available.mockReturnValue(new Promise<string>(r => { resolve = r; }));
    const { result } = mount();
    expect(result.current.supported).toBe(false);
    await act(async () => resolve(availability));
    expect(result.current.supported).toBe(true);
    expect(Recognition.available).toHaveBeenCalledWith({ langs: ['en-US'], processLocally: true });
    expect(Recognition.sessions).toHaveLength(0);
  });

  it.each(['unavailable', 'missing', 'missing-static', 'missing-install', 'rejected'])('hides the mic for %s and never starts any fallback', async availability => {
    if (availability === 'missing') vi.stubGlobal('SpeechRecognition', undefined);
    else if (availability === 'missing-static') vi.stubGlobal('SpeechRecognition', class {});
    else if (availability === 'missing-install') vi.stubGlobal('SpeechRecognition', class { static available = Recognition.available; });
    else if (availability === 'rejected') Recognition.available.mockRejectedValue(new Error('policy'));
    else Recognition.available.mockResolvedValue(availability);
    const { result } = mount();
    await act(async () => {});
    act(() => result.current.toggle());
    expect(result.current.supported).toBe(false);
    expect(Recognition.sessions).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['downloadable', 'downloading'])('prepares a %s pack once, then requires a fresh press to record locally', async availability => {
    Recognition.available.mockResolvedValue(availability);
    let resolve!: (value: boolean) => void;
    Recognition.install.mockReturnValue(new Promise<boolean>(r => { resolve = r; }));
    const { result } = mount();
    await waitFor(() => expect(result.current.supported).toBe(true));
    act(() => { result.current.toggle(); result.current.toggle(); });
    expect(result.current.state.kind).toBe('preparing');
    expect(Recognition.install).toHaveBeenCalledExactlyOnceWith({ langs: ['en-US'], processLocally: true });
    expect(Recognition.sessions).toHaveLength(0);
    await act(async () => resolve(true));
    expect(result.current.state.kind).toBe('idle');
    expect(Recognition.sessions).toHaveLength(0);
    act(() => result.current.toggle());
    expect(Recognition.sessions).toHaveLength(1);
    expect(Recognition.sessions[0].processLocally).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['false', 'rejected'])('disables local speech after install %s', async outcome => {
    Recognition.available.mockResolvedValue('downloadable');
    if (outcome === 'false') Recognition.install.mockResolvedValue(false);
    else Recognition.install.mockRejectedValue(new Error('download failed'));
    const { result } = mount();
    await waitFor(() => expect(result.current.supported).toBe(true));
    await act(async () => result.current.toggle());
    expect(result.current.supported).toBe(false);
    expect(result.current.state).toEqual({ kind: 'error', reason: 'deviceUnavailable' });
    act(() => result.current.toggle());
    expect(Recognition.install).toHaveBeenCalledTimes(1);
    expect(Recognition.sessions).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['language-not-supported', 'service-not-allowed'])('hides the mic for the session after %s, dropping late results', async error => {
    const { result, rerender } = renderHook(({ language }) => useVoiceInput(options(language)), { initialProps: { language: 'en' as InterviewLanguage } });
    await waitFor(() => expect(result.current.supported).toBe(true));
    act(() => result.current.toggle());
    const session = Recognition.sessions[0];
    act(() => session.onerror?.({ error }));
    expect(result.current.supported).toBe(false);
    expect(result.current.state).toEqual({ kind: 'error', reason: 'deviceUnavailable' });
    act(() => session.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'late' } }] }));
    expect(onText).not.toHaveBeenCalled();
    rerender({ language: 'ja' });
    act(() => result.current.toggle());
    expect(result.current.supported).toBe(false);
    expect(Recognition.sessions).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps a terminal failure hidden after remount, but not in a new participant session', async () => {
    const first = mount();
    await waitFor(() => expect(first.result.current.supported).toBe(true));
    act(() => first.result.current.toggle());
    act(() => Recognition.sessions[0].onerror?.({ error: 'service-not-allowed' }));
    first.unmount();
    const second = mount();
    await act(async () => {});
    expect(second.result.current.supported).toBe(false);
    expect(second.result.current.state).toEqual({ kind: 'error', reason: 'deviceUnavailable' });
    second.unmount();
    sessionNumber += 1;
    const third = mount();
    await waitFor(() => expect(third.result.current.supported).toBe(true));
  });

  it.each(Object.entries(SPEECH_TAGS))('uses the one language table for %s availability, installation and recognition', async (language, tag) => {
    Recognition.available.mockResolvedValue('downloadable');
    const { result } = renderHook(() => useVoiceInput(options(language as InterviewLanguage)));
    await waitFor(() => expect(result.current.supported).toBe(true));
    await act(async () => result.current.toggle());
    act(() => result.current.toggle());
    expect(Recognition.available).toHaveBeenCalledWith({ langs: [tag], processLocally: true });
    expect(Recognition.install).toHaveBeenCalledWith({ langs: [tag], processLocally: true });
    expect(Recognition.sessions[0]).toMatchObject({ lang: tag, processLocally: true });
  });

  it('never starts with processLocally false, including a second recording and a generic error retry', async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.supported).toBe(true));
    for (let i = 0; i < 3; i++) {
      act(() => result.current.toggle());
      const session = Recognition.sessions[i];
      act(() => {
        if (i === 1) session.onerror?.({ error: 'network' });
        session.onend?.();
      });
    }
    expect(Recognition.sessions).toHaveLength(3);
    expect(Recognition.sessions.every(s => s.processLocally === true)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never starts a recognizer that refuses the local-only flag', async () => {
    class RefusesLocal extends Recognition {
      constructor() {
        super();
        Object.defineProperty(this, 'processLocally', { get: () => false, set: () => {} });
      }
    }
    vi.stubGlobal('SpeechRecognition', RefusesLocal);
    const { result } = mount();
    await waitFor(() => expect(result.current.supported).toBe(true));
    act(() => result.current.toggle());
    expect(result.current.supported).toBe(false);
    expect(result.current.state).toEqual({ kind: 'error', reason: 'deviceUnavailable' });
    expect(Recognition.sessions).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never starts a recognizer that lacks the processLocally attribute (an older browser would ignore it and use the cloud)', async () => {
    class NoLocalAttribute extends Recognition {
      constructor() {
        super();
        delete (this as { processLocally?: boolean }).processLocally;
      }
    }
    vi.stubGlobal('SpeechRecognition', NoLocalAttribute);
    const { result } = mount();
    await waitFor(() => expect(result.current.supported).toBe(true));
    act(() => result.current.toggle());
    expect(result.current.state).toEqual({ kind: 'error', reason: 'deviceUnavailable' });
    expect(Recognition.sessions).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('ignores stale availability and install completions after a language change or unmount', async () => {
    let available!: (value: string) => void;
    Recognition.available.mockReturnValueOnce(new Promise<string>(r => { available = r; }));
    const { result, rerender, unmount } = renderHook(({ language }) => useVoiceInput(options(language)), { initialProps: { language: 'en' as InterviewLanguage } });
    Recognition.available.mockResolvedValue('unavailable');
    rerender({ language: 'ja' });
    await act(async () => available('available'));
    expect(result.current.supported).toBe(false);
    Recognition.available.mockResolvedValue('downloadable');
    rerender({ language: 'fr' });
    await waitFor(() => expect(result.current.supported).toBe(true));
    let install!: (value: boolean) => void;
    Recognition.install.mockReturnValueOnce(new Promise<boolean>(r => { install = r; }));
    act(() => result.current.toggle());
    unmount();
    await act(async () => install(true));
    expect(Recognition.sessions).toHaveLength(0);
  });
});
