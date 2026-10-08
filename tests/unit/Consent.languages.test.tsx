import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useStore } from '@/store';
import { makeStudyConfig } from '../fixtures/models';

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => navigation }));

import Consent from '@/components/Consent';

const multilingual = makeStudyConfig({
  id: 'study-a',
  consentText: 'English consent text.',
  interviewLanguages: ['en', 'ja'],
  consentTextTranslations: { ja: '日本語の同意文です。' },
  aiProvider: 'claude',
  aiModel: 'claude-sonnet-5',
  aiProviderCommitment: 'fixed',
});

function setLanguages(...languages: string[]) {
  Object.defineProperty(navigator, 'languages', { value: languages, configurable: true });
}

beforeEach(() => {
  sessionStorage.clear();
  useStore.setState(useStore.getInitialState(), true);
  navigation.push.mockReset();
  setLanguages('en-US');
  useStore.getState().beginParticipantSession(multilingual, 'participant-handle-a-123456');
});

afterEach(() => {
  vi.unstubAllGlobals();
  setLanguages('en-US');
  document.documentElement.lang = 'en';
});

describe('Consent page languages', () => {
  it('preselects the browser\'s language and shows that language\'s consent, notice and controls', () => {
    setLanguages('ja-JP', 'en');
    render(<Consent />);
    expect(screen.getByText('日本語の同意文です。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '同意してインタビューを始める' })).toBeInTheDocument();
    expect(screen.getByText(/あなたの回答は Anthropic Claude に送信されます。/)).toBeInTheDocument();
    expect(screen.getByText(/Claude Sonnet 5（Anthropic Claude）/)).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('ja');
  });

  it('switching language re-renders the page and records consent for the text read', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ acceptedAt: 1_700_000_000_000 })));
    vi.stubGlobal('fetch', fetchMock);
    render(<Consent />);
    expect(screen.getByText('English consent text.')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('日本語'));
    expect(screen.getByText('日本語の同意文です。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '同意してインタビューを始める' }));
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith('/interview'));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ studyId: 'study-a', language: 'ja' });
    expect(useStore.getState().participantLanguage).toBe('ja');
  });

  it('shows no picker for a single-language study and sends no language for a study without the setting', async () => {
    useStore.setState(useStore.getInitialState(), true);
    useStore.getState().beginParticipantSession(makeStudyConfig({ id: 'study-b' }), 'participant-handle-b-123456');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ acceptedAt: 1_700_000_000_000 })));
    vi.stubGlobal('fetch', fetchMock);
    render(<Consent />);
    expect(screen.queryByRole('group', { name: 'Language' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /I consent/i }));
    await waitFor(() => expect(navigation.push).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('language');
    expect(useStore.getState().participantLanguage).toBeNull();
  });

  it('shows a refusal in the chosen language', async () => {
    setLanguages('ja');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'DISCLOSURE_CHANGED', error: 'English server copy' }), { status: 409 })));
    render(<Consent />);
    fireEvent.click(screen.getByRole('button', { name: '同意してインタビューを始める' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('このページを読み込んだ後に');
  });
});
