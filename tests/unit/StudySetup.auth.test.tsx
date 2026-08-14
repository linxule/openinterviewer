import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { makeStudyConfig } from '../fixtures/models';

/**
 * StudySetup auth contract: a 200 response with body {authenticated:false}
 * must be treated as NOT authenticated. HTTP status alone is not the truth.
 */

const storeMock = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  seed: (initial: Record<string, unknown>) => {
    storeMock.state = { ...initial };
  },
}));

vi.mock('@/store', () => ({
  useStore: Object.assign(
    () => storeMock.state,
    { getState: () => storeMock.state }
  ),
}));

const routerMock = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(),
}));

import StudySetup from '@/components/StudySetup';

const fetchMock = vi.hoisted(() => ({
  fn: vi.fn(),
  calls: [] as Array<{ url: string; method: string }>,
  authenticated: false,
  configStatus: {
    mode: 'hosted' as 'hosted' | 'standalone',
    hasAnthropicKey: true,
    hasGeminiKey: true,
  },
  configStatusCode: 200,
}));

beforeEach(() => {
  fetchMock.fn.mockReset();
  fetchMock.calls.length = 0;
  fetchMock.authenticated = false;
  fetchMock.configStatus = {
    mode: 'hosted',
    hasAnthropicKey: true,
    hasGeminiKey: true,
  };
  fetchMock.configStatusCode = 200;
  routerMock.push.mockReset();
  fetchMock.fn.mockImplementation(async (url: string, init?: RequestInit) => {
    fetchMock.calls.push({ url, method: init?.method || 'GET' });
    const path = new URL(url, 'http://localhost').pathname;
    if (path === '/api/auth') {
      return { ok: true, status: 200, json: async () => ({ authenticated: fetchMock.authenticated }) };
    }
    if (path === '/api/config/status') {
      return {
        ok: fetchMock.configStatusCode === 200,
        status: fetchMock.configStatusCode,
        json: async () => fetchMock.configStatusCode === 200
          ? fetchMock.configStatus
          : { error: 'status unavailable' },
      };
    }
    if (path === '/api/studies') {
      return { ok: true, status: 201, json: async () => ({ study: { id: 's-1', config: {} } }) };
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
  });
  vi.stubGlobal('fetch', fetchMock.fn);

  storeMock.seed({
    studyConfig: null,
    setStudyConfig: vi.fn(),
    setStep: vi.fn(),
    loadExampleStudy: vi.fn(),
    setViewMode: vi.fn(),
    setParticipantToken: vi.fn(),
    resetParticipant: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function fillRequiredFields() {
  fireEvent.change(screen.getByPlaceholderText('e.g., AI Adoption in Healthcare'), {
    target: { value: 'Auth Gate Study' },
  });
  fireEvent.change(screen.getByPlaceholderText('What are you trying to understand?'), {
    target: { value: 'Does the gate work?' },
  });
}

describe('StudySetup auth gate (JSON body, not HTTP status)', () => {
  it('shows the login-required block when /api/auth returns 200 with authenticated:false', async () => {
    render(<StudySetup />);
    fillRequiredFields();

    // Fix expectation: body.authenticated === false must drive the UI.
    await waitFor(() => {
      expect(screen.getByText('Login required to generate participant links.')).toBeInTheDocument();
    });
  });

  it('blocks a hosted Claude-only account from saving or publishing the default Gemini study', async () => {
    fetchMock.authenticated = true;
    fetchMock.configStatus = {
      mode: 'hosted',
      hasAnthropicKey: true,
      hasGeminiKey: false,
    };
    storeMock.seed({
      ...storeMock.state,
      studyConfig: makeStudyConfig({
        id: '4e52c093-96b2-4b56-88a9-330d740a42ea',
        name: 'Claude-only account study',
        aiProvider: 'gemini',
      }),
    });

    render(<StudySetup />);

    expect(await screen.findByText('Google Gemini is not available')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Saved' })).toBeDisabled();
    expect(screen.getAllByRole('button', { name: /preview/i })).toHaveLength(2);
    screen.getAllByRole('button', { name: /preview/i }).forEach((button) => {
      expect(button).toBeDisabled();
    });
    expect(screen.getByRole('button', { name: 'Generate Participant Link' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Account & connections' }));
    expect(routerMock.push).toHaveBeenCalledWith('/settings');

    fireEvent.click(screen.getByRole('radio', { name: /Anthropic Claude/ }));
    await waitFor(() => {
      expect(screen.queryByText('Google Gemini is not available')).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Update Study' })).toBeEnabled();
  });

  it('gives standalone deployments provider-specific server setup guidance', async () => {
    fetchMock.authenticated = true;
    fetchMock.configStatus = {
      mode: 'standalone',
      hasAnthropicKey: false,
      hasGeminiKey: true,
    };

    render(<StudySetup />);
    fillRequiredFields();
    fireEvent.click(screen.getByRole('radio', { name: /Anthropic Claude/ }));

    expect(await screen.findByText('Anthropic Claude is not available')).toBeInTheDocument();
    expect(screen.getByText('ANTHROPIC_API_KEY')).toBeInTheDocument();
    expect(screen.getByText('npm run setup:check')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Study' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Open self-host setup guide' }));
    expect(routerMock.push).toHaveBeenCalledWith('/self-host');
    expect(document.body.textContent).not.toMatch(/Vercel dashboard|github\.com\/your-repo/i);
  });

  it('fails closed when provider availability cannot be verified', async () => {
    fetchMock.authenticated = true;
    fetchMock.configStatusCode = 503;

    render(<StudySetup />);
    fillRequiredFields();

    expect(await screen.findByText('Provider availability could not be verified')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Study' })).toBeDisabled();
  });

  it('names icon-only field, question, and topic removal controls', () => {
    render(<StudySetup />);

    fireEvent.click(screen.getByRole('button', { name: /Current Role/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Question' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Topic' }));

    expect(screen.getByRole('button', { name: 'Remove Current Role' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove question 2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove topic 2' })).toBeInTheDocument();
  });

});
