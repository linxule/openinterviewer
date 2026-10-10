import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { SPEECH_TAGS, useVoiceInput } from '@/lib/voice/useVoiceInput';
import type { InterviewLanguage } from '@/lib/i18n/languages';

class Recognition {
  static available = vi.fn();
  static install = vi.fn();
  static sessions: Recognition[] = [];
  lang = '';
  processLocally = false;
  continuous = false;
  interimResults = false;
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  onaudiostart: (() => void) | null = null;
  onspeechstart: (() => void) | null = null;
  onnomatch: (() => void) | null = null;
  start = vi.fn(() => {
    // Every started instance must satisfy the local-only contract, including retries.
    expect(this.processLocally).toBe(true);
    Recognition.sessions.push(this);
  });
  stop = vi.fn();
  abort = vi.fn();
  result(results: [string, boolean][], resultIndex = 0) {
    this.onresult?.({ resultIndex, results: results.map(([transcript, isFinal]) => ({ isFinal, 0: { transcript } })) });
  }
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
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

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
    expect(result.current.state.kind).toBe('ready');
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

describe('shared speech lifecycle', () => {
  async function start() {
    const hook = mount();
    await act(async () => {});
    expect(hook.result.current.supported).toBe(true);
    act(() => hook.result.current.toggle());
    return { ...hook, session: Recognition.sessions[0] };
  }

  it('starts once, and waits for audio rather than speech before reporting listening', async () => {
    const { result, session } = await start();
    expect(result.current.state).toEqual({ kind: 'starting' });
    expect(session.interimResults).toBe(true);
    act(() => session.onspeechstart?.());
    expect(result.current.state.kind).toBe('starting');
    act(() => session.onaudiostart?.());
    expect(result.current.state).toEqual({ kind: 'listening' });
  });

  it('does not open two sessions for two presses before React renders', async () => {
    const { result } = mount();
    await act(async () => {});
    act(() => { result.current.toggle(); result.current.toggle(); });
    expect(Recognition.sessions).toHaveLength(1);
    expect(result.current.state.kind).toBe('starting');
  });

  it('aborts a startup after eight seconds, suppresses its aborted event, and permits retry', async () => {
    vi.useFakeTimers();
    const { result, session } = await start();
    session.abort.mockImplementation(() => {
      session.onerror?.({ error: 'aborted' });
      session.onend?.();
    });
    act(() => vi.advanceTimersByTime(7_999));
    expect(result.current.state.kind).toBe('starting');
    act(() => vi.advanceTimersByTime(1));
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(result.current.state).toEqual({ kind: 'error', reason: 'failed' });
    expect(result.current.supported).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    act(() => result.current.toggle());
    expect(Recognition.sessions).toHaveLength(2);
    act(() => { session.onaudiostart?.(); session.result([['stale', true]]); session.onend?.(); });
    expect(result.current.state.kind).toBe('starting');
    expect(onText).not.toHaveBeenCalled();
  });

  it('clears the startup timer and disables device mode when start throws', async () => {
    vi.useFakeTimers();
    class CannotStart extends Recognition {
      start = vi.fn(() => { throw new Error('cannot start'); });
    }
    vi.stubGlobal('SpeechRecognition', CannotStart);
    const { result } = mount();
    await act(async () => {});
    act(() => result.current.toggle());
    expect(result.current.state).toEqual({ kind: 'error', reason: 'deviceUnavailable' });
    expect(result.current.supported).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('clears the startup deadline when audio begins', async () => {
    vi.useFakeTimers();
    const { result, session } = await start();
    act(() => session.onaudiostart?.());
    act(() => vi.advanceTimersByTime(8_000));
    expect(result.current.state.kind).toBe('listening');
    expect(session.abort).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('replaces interim text per index, removes retracted results, and commits each final once', async () => {
    const { result, session } = await start();
    act(() => session.result([[' first ', false], ['draft', false]]));
    expect(result.current.preview).toBe('first draft');
    expect(onText).not.toHaveBeenCalled();
    act(() => session.result([['revised', false]]));
    expect(result.current.preview).toBe('revised');
    act(() => session.result([['finished', true], ['next', false]]));
    act(() => session.result([['finished', true], ['new next', false]], 1));
    act(() => session.result([['finished', true], ['new next', false]]));
    expect(result.current.preview).toBe('new next');
    expect(onText).toHaveBeenCalledExactlyOnceWith('finished');
    act(() => session.result([['finished', true], ['second', true]], 1));
    expect(result.current.preview).toBe('');
    expect(onText.mock.calls).toEqual([['finished'], ['second']]);
    act(() => session.onend?.());
    expect(result.current.state.kind).toBe('idle');
  });

  it('accepts a late final while stopping and clears the grace timer on end', async () => {
    vi.useFakeTimers();
    const { result, session } = await start();
    act(() => session.onaudiostart?.());
    act(() => result.current.toggle());
    expect(result.current.state.kind).toBe('stopping');
    expect(session.stop).toHaveBeenCalledTimes(1);
    act(() => result.current.toggle());
    expect(session.stop).toHaveBeenCalledTimes(1);
    expect(Recognition.sessions).toHaveLength(1);
    act(() => session.result([['late final', true]]));
    expect(onText).toHaveBeenCalledExactlyOnceWith('late final');
    act(() => session.onend?.());
    expect(result.current.state.kind).toBe('idle');
    expect(vi.getTimerCount()).toBe(0);
    expect(session.abort).not.toHaveBeenCalled();
  });

  it('commits interim-only speech once on end, and drops any late events', async () => {
    const { result, session } = await start();
    act(() => session.result([['你好', false], ['世界', false]]));
    expect(onText).not.toHaveBeenCalled();
    act(() => { session.onend?.(); session.onend?.(); session.result([['late', true]]); });
    expect(onText).toHaveBeenCalledExactlyOnceWith('你好 世界');
    expect(result.current.preview).toBe('');
    expect(result.current.state.kind).toBe('idle');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps an unfinished last phrase after a committed final, once', async () => {
    const { result, session } = await start();
    act(() => session.result([['final', true], ['unfinished', false]]));
    act(() => session.onend?.());
    expect(onText.mock.calls).toEqual([['final'], ['unfinished']]);
    expect(result.current.preview).toBe('');
    expect(result.current.state.kind).toBe('idle');
  });

  it.each(['empty', 'whitespace', 'nomatch'])('reports noText after %s and releases the session', async outcome => {
    vi.useFakeTimers();
    const { result, session } = await start();
    act(() => {
      if (outcome === 'whitespace') session.result([['  ', false]]);
      if (outcome === 'nomatch') session.onnomatch?.();
      session.onend?.();
    });
    expect(result.current.state).toEqual({ kind: 'error', reason: 'noText' });
    expect(result.current.supported).toBe(true);
    expect(onText).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports foreign aborted as interrupted without disabling the mic, even without end', async () => {
    vi.useFakeTimers();
    const { result, session } = await start();
    act(() => session.result([['kept draft', false]]));
    act(() => session.onerror?.({ error: 'aborted' }));
    expect(result.current.state).toEqual({ kind: 'error', reason: 'interrupted' });
    expect(result.current.supported).toBe(true);
    expect(result.current.preview).toBe('');
    expect(vi.getTimerCount()).toBe(0);
    act(() => result.current.toggle());
    expect(Recognition.sessions).toHaveLength(2);
    expect(onText).toHaveBeenCalledExactlyOnceWith('kept draft');
  });

  it('reports no-speech as noText', async () => {
    const { result, session } = await start();
    act(() => session.onerror?.({ error: 'no-speech' }));
    expect(result.current.state).toEqual({ kind: 'error', reason: 'noText' });
    expect(onText).not.toHaveBeenCalled();
  });

  it.each([false, true])('bounds stop during startup with a ten-second grace, interim=%s', async hasInterim => {
    vi.useFakeTimers();
    const { result, session } = await start();
    session.abort.mockImplementation(() => {
      session.onerror?.({ error: 'aborted' });
      session.onend?.();
    });
    if (hasInterim) act(() => session.result([['recovered', false]]));
    act(() => result.current.toggle());
    act(() => session.onaudiostart?.());
    act(() => vi.advanceTimersByTime(9_999));
    expect(result.current.state.kind).toBe('stopping');
    expect(session.abort).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(result.current.state).toEqual(hasInterim ? { kind: 'idle' } : { kind: 'error', reason: 'noText' });
    expect(result.current.preview).toBe('');
    expect(onText.mock.calls).toEqual(hasInterim ? [['recovered']] : []);
    expect(vi.getTimerCount()).toBe(0);
    act(() => result.current.toggle());
    expect(Recognition.sessions).toHaveLength(2);
  });

  it.each(['not-allowed', 'network', 'language-not-supported'])('clears timers and preview after %s without waiting for end', async error => {
    vi.useFakeTimers();
    const { result, session } = await start();
    act(() => session.result([['draft', false]]));
    act(() => result.current.toggle());
    act(() => session.onerror?.({ error }));
    expect(result.current.state.kind).toBe('error');
    expect(result.current.preview).toBe('');
    expect(vi.getTimerCount()).toBe(0);
    act(() => session.onend?.());
    expect(result.current.state.kind).toBe('error');
    // A terminal device failure drops the draft; other errors keep it for review.
    if (error === 'language-not-supported') expect(onText).not.toHaveBeenCalled();
    else expect(onText).toHaveBeenCalledExactlyOnceWith('draft');
  });

  it.each(['starting', 'stopping'])('aborts and clears timers on unmount while %s without committing', async phase => {
    vi.useFakeTimers();
    const { result, session, unmount } = await start();
    act(() => session.result([['discard', false]]));
    if (phase === 'stopping') act(() => result.current.toggle());
    unmount();
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    act(() => { session.onerror?.({ error: 'aborted' }); session.onend?.(); });
    expect(onText).not.toHaveBeenCalled();
  });

  it('cleans up a device session on language change and ignores its late events', async () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ language }) => useVoiceInput(options(language)), { initialProps: { language: 'en' as InterviewLanguage } });
    await act(async () => {});
    act(() => result.current.toggle());
    const session = Recognition.sessions[0];
    act(() => session.result([['discard', false]]));
    rerender({ language: 'zh' });
    await act(async () => {});
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(result.current.preview).toBe('');
    expect(vi.getTimerCount()).toBe(0);
    act(() => result.current.toggle());
    expect(Recognition.sessions[1].lang).toBe('zh-CN');
    act(() => { session.result([['stale', true]]); session.onend?.(); });
    expect(result.current.state.kind).toBe('starting');
    expect(onText).not.toHaveBeenCalled();
  });
});

describe('language changes outside device mode', () => {
  it('keeps browser dictation and its speech tag when the language prop changes', async () => {
    class CloudRecognition extends Recognition {
      start = vi.fn(() => { Recognition.sessions.push(this); });
    }
    vi.stubGlobal('SpeechRecognition', CloudRecognition);
    const { result, rerender } = renderHook(({ language }) => useVoiceInput({ ...options(language), mode: 'browser' }), { initialProps: { language: 'en' as InterviewLanguage } });
    await waitFor(() => expect(result.current.supported).toBe(true));
    act(() => result.current.toggle());
    const session = Recognition.sessions[0];
    expect(session.processLocally).toBe(false);
    act(() => session.onaudiostart?.());
    expect(result.current.state).toEqual({ kind: 'listening' });
    rerender({ language: 'ja' });
    expect(session.stop).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ kind: 'listening' });
    expect(result.current.speechTag).toBe('en-US');
  });
});
