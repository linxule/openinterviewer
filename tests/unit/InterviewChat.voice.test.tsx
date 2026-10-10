import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { makeStudyConfig } from '../fixtures/models';
import { RESEARCH_STORE_KEY, useStore } from '@/store';
import type { VoiceInputMode } from '@/types';

const interviewApiMock = vi.hoisted(() => ({
  getInterviewGreeting: vi.fn(),
  generateInterviewResponse: vi.fn(),
}));
vi.mock('@/services/interviewApi', () => interviewApiMock);
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

import InterviewChat from '@/components/InterviewChat';
import Consent from '@/components/Consent';

class FakeRecognition {
  static last: FakeRecognition | null = null;
  static available = vi.fn();
  static install = vi.fn();
  processLocally = false;
  lang = '';
  continuous = false;
  interimResults = true;
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  onaudiostart: (() => void) | null = null;
  onnomatch: (() => void) | null = null;
  start = vi.fn(() => { FakeRecognition.last = this; });
  stop = vi.fn();
  abort = vi.fn();
}

function seed(voiceInput?: VoiceInputMode, extra: Parameters<typeof makeStudyConfig>[0] = {}) {
  useStore.setState(useStore.getInitialState(), true);
  useStore.setState({
    studyConfig: makeStudyConfig({ id: 'study-v', ...(voiceInput ? { voiceInput } : {}), ...extra }),
    viewMode: 'participant',
    participantProfile: null,
    questionProgress: { questionsAsked: [], total: 1, currentPhase: 'background', isComplete: false },
    interviewHistory: [{ id: 'g', role: 'ai', content: 'Welcome. What do you do?', timestamp: 1 }],
    contextEntries: [],
    isAiThinking: false,
  });
}

beforeEach(() => {
  Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query: vi.fn(async () => ({ state: 'granted', onchange: null })) } });
  vi.clearAllMocks();
  FakeRecognition.last = null;
  vi.stubGlobal('webkitSpeechRecognition', FakeRecognition);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('participant voice input', () => {
  it('offers no microphone for a study without voice input', () => {
    seed();
    render(<InterviewChat />);
    expect(screen.queryByRole('button', { name: 'Start voice input' })).not.toBeInTheDocument();
  });

  it('browser dictation adds the recognized text to the answer for review and never sends it', async () => {
    seed('browser', { interviewLanguages: ['en', 'ja'], consentTextTranslations: { ja: '同意' } });
    useStore.setState({ participantLanguage: 'ja' });
    render(<InterviewChat />);
    const textarea = screen.getByLabelText('あなたの回答') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '私は' } });
    fireEvent.click(await screen.findByRole('button', { name: '音声入力を開始' }));
    expect(FakeRecognition.last?.lang).toBe('ja-JP');
    expect(screen.getByRole('button', { name: '送信' })).toBeDisabled();
    act(() => {
      FakeRecognition.last?.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: ' 研究者です ' } }] });
    });
    fireEvent.click(screen.getByRole('button', { name: '録音を停止' }));
    expect(screen.getByRole('button', { name: '送信' })).toBeDisabled();
    act(() => FakeRecognition.last?.onend?.());
    await waitFor(() => expect(textarea.value).toBe('私は研究者です'));
    expect(screen.getByRole('button', { name: '送信' })).toBeEnabled();
    expect(screen.getByText('送信する前に文字をご確認ください。')).toBeInTheDocument();
    expect(interviewApiMock.generateInterviewResponse).not.toHaveBeenCalled();
  });

  it('shows a polite speech-tagged preview without storing or sending it, then commits interim-only text for review', async () => {
    seed('browser', { interviewLanguages: ['zh'] });
    useStore.setState({ participantLanguage: 'zh' });
    render(<InterviewChat />);
    const textarea = screen.getByLabelText('您的回答');
    const storedBefore = sessionStorage.getItem(RESEARCH_STORE_KEY);
    expect(storedBefore).not.toBeNull();
    const historyBefore = useStore.getState().interviewHistory;
    fireEvent.click(await screen.findByRole('button', { name: '开始语音输入' }));
    expect(screen.getByRole('status')).toHaveTextContent('正在启动麦克风……');
    expect(screen.getByRole('button', { name: '停止录音' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.change(textarea, { target: { value: '手动输入' } });
    expect(textarea).toBeEnabled();
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    expect(interviewApiMock.generateInterviewResponse).not.toHaveBeenCalled();
    act(() => FakeRecognition.last?.onaudiostart?.());
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    expect(interviewApiMock.generateInterviewResponse).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('正在聆听……');
    act(() => FakeRecognition.last?.onresult?.({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: '临时文字' } }] }));
    const preview = screen.getByText('临时文字');
    expect(preview).toHaveAttribute('lang', 'zh-CN');
    expect(preview).not.toHaveAttribute('aria-live');
    expect(preview).toHaveClass('text-ink-500');
    expect(textarea).toHaveValue('手动输入');
    expect(sessionStorage.getItem(RESEARCH_STORE_KEY)).toBe(storedBefore);
    expect(useStore.getState().interviewHistory).toBe(historyBefore);
    fireEvent.click(screen.getByRole('button', { name: '停止录音' }));
    // While Chrome finalizes, the button still reads Stop (pressed) but is disabled.
    expect(screen.getByRole('button', { name: '停止录音' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '停止录音' })).toBeDisabled();
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    expect(interviewApiMock.generateInterviewResponse).not.toHaveBeenCalled();
    expect(screen.getByText('临时文字')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    act(() => FakeRecognition.last?.onend?.());
    expect(textarea).toHaveValue('手动输入临时文字');
    expect(screen.queryByText('临时文字')).not.toBeInTheDocument();
    expect(screen.getByText('发送前请检查文字。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
    expect(interviewApiMock.generateInterviewResponse).not.toHaveBeenCalled();
  });

  it.each(['end', 'aborted', 'startup', 'grace'])('releases Send and preserves typing after %s', async terminal => {
    vi.useFakeTimers();
    seed('browser');
    render(<InterviewChat />);
    fireEvent.change(screen.getByLabelText('Your response'), { target: { value: 'typed answer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start voice input' }));
    await act(async () => {}); // permission query
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    act(() => {
      if (terminal === 'end') FakeRecognition.last?.onend?.();
      if (terminal === 'aborted') FakeRecognition.last?.onerror?.({ error: 'aborted' });
      if (terminal === 'startup') vi.advanceTimersByTime(8_000);
    });
    if (terminal === 'grace') {
      fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }));
      act(() => vi.advanceTimersByTime(10_000));
    }
    expect(screen.getByRole('alert')).toHaveTextContent(terminal === 'aborted' ? 'Voice input stopped unexpectedly'
      : terminal === 'startup' ? 'Your recording could not be turned into text' : 'No text was captured');
    expect(screen.getByLabelText('Your response')).toHaveValue('typed answer');
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Start voice input' })).toBeEnabled();
    expect(interviewApiMock.generateInterviewResponse).not.toHaveBeenCalled();
  });

  it('a blocked microphone says so and leaves typing available', async () => {
    seed('browser');
    render(<InterviewChat />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start voice input' }));
    act(() => { FakeRecognition.last?.onerror?.({ error: 'not-allowed' }); });
    expect(await screen.findByRole('alert')).toHaveTextContent('Microphone access was blocked');
  });

  it('hides the microphone where the browser cannot provide the chosen mode', () => {
    vi.unstubAllGlobals();
    seed('browser');
    render(<InterviewChat />);
    expect(screen.queryByRole('button', { name: 'Start voice input' })).not.toBeInTheDocument();
  });
});

describe('consent notice for voice input', () => {
  it.each([
    ['installation', /recording is sent to Cloudflare to be turned into text by Cloudflare Workers AI/],
    ['browser', /in Chrome this is Google, in Safari Apple/],
    ['device', /your browser turns your speech into text on this computer/],
  ] as const)('names who turns speech into text: %s', (mode, text) => {
    useStore.setState(useStore.getInitialState(), true);
    useStore.getState().beginParticipantSession(makeStudyConfig({ id: 'study-v', voiceInput: mode }), 'participant-handle-v-123456');
    render(<Consent />);
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it('says nothing about voice when the study has none', () => {
    useStore.setState(useStore.getInitialState(), true);
    useStore.getState().beginParticipantSession(makeStudyConfig({ id: 'study-v' }), 'participant-handle-v-123456');
    render(<Consent />);
    expect(screen.queryByText(/microphone/i)).not.toBeInTheDocument();
  });
});


describe('device mic and consent', () => {
  it('keeps typing and Send available during preparation, then shows a localized failure without a mic', async () => {
    FakeRecognition.available.mockResolvedValue('downloadable');
    let finish!: (value: boolean) => void;
    FakeRecognition.install.mockReturnValue(new Promise<boolean>(resolve => { finish = resolve; }));
    seed('device', { interviewLanguages: ['ja'] });
    useStore.setState({ participantLanguage: 'ja' });
    render(<InterviewChat />);
    fireEvent.click(await screen.findByRole('button', { name: '音声入力を開始' }));
    expect(screen.getByRole('status')).toHaveTextContent('このデバイスで音声入力を準備しています…');
    fireEvent.change(screen.getByLabelText('あなたの回答'), { target: { value: '入力できます' } });
    expect(screen.getByRole('button', { name: '送信' })).toBeEnabled();
    await act(async () => finish(false));
    expect(screen.queryByRole('button', { name: '音声入力を開始' })).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('このデバイスでは音声入力を利用できません');
    expect(screen.getByLabelText('あなたの回答')).toHaveValue('入力できます');
  });

  it('announces ready after installation without opening the microphone or blocking Send', async () => {
    sessionStorage.clear();
    FakeRecognition.available.mockResolvedValue('downloadable');
    FakeRecognition.install.mockResolvedValue(true);
    seed('device', { id: 'ready-study', interviewLanguages: ['fr'] });
    useStore.setState({ participantLanguage: 'fr' });
    render(<InterviewChat />);
    fireEvent.change(screen.getByLabelText('Votre réponse'), { target: { value: 'Ma réponse' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Démarrer la saisie vocale' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('La saisie vocale est prête. Appuyez sur le micro pour parler.'));
    expect(FakeRecognition.last).toBeNull();
    expect(screen.getByRole('button', { name: 'Envoyer' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Démarrer la saisie vocale' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Démarrer la saisie vocale' }));
    expect(FakeRecognition.last?.processLocally).toBe(true);
    expect(screen.getByRole('status')).toHaveTextContent('Démarrage du micro…');
  });

  it.each([
    ['ja', /録音はこのコンピューターの外に出ないとしています/],
    ['zh', /浏览器会在这台电脑上将您的语音转为文字/],
  ] as const)('renders the device consent notice in %s', (language, text) => {
    useStore.setState(useStore.getInitialState(), true);
    useStore.getState().beginParticipantSession(makeStudyConfig({ id: 'study-v', voiceInput: 'device', interviewLanguages: [language] }), 'participant-handle-v-123456');
    render(<Consent />);
    expect(screen.getByText(text)).toHaveTextContent(/60 MB/);
    expect(screen.queryByText(/Cloudflare Workers AI/)).not.toBeInTheDocument();
  });
});
