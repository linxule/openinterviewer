import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { makeStudyConfig } from '../fixtures/models';
import { useStore } from '@/store';
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
  start = vi.fn(() => { FakeRecognition.last = this; });
  stop = vi.fn(() => this.onend?.());
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
  vi.clearAllMocks();
  FakeRecognition.last = null;
  vi.stubGlobal('webkitSpeechRecognition', FakeRecognition);
});

afterEach(() => {
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
    await waitFor(() => expect(textarea.value).toBe('私は 研究者です'));
    expect(screen.getByText('送信する前に文字をご確認ください。')).toBeInTheDocument();
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
