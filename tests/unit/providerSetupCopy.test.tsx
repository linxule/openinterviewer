import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const routerMock = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
}));

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: React.PropsWithChildren) => children,
  motion: new Proxy({}, {
    get: (_target, tag: string) => ({
      children,
      initial: _initial,
      animate: _animate,
      exit: _exit,
      ...props
    }: React.PropsWithChildren<Record<string, unknown>>) => React.createElement(tag, props, children),
  }),
}));

import { metadata } from '@/app/layout';
import Onboarding from '@/components/Onboarding';
import Settings from '@/components/Settings';
import {
  DEFAULT_MODEL_BY_PROVIDER,
  isKnownProviderModel,
  PROVIDER_MODELS,
  PROVIDER_OPTIONS,
} from '@/lib/providerRegistry';

const profile = {
  name: 'Ada Researcher',
  email: 'ada@example.test',
  avatarUrl: null,
  hasRedisConfigured: true,
  hasGeminiKey: true,
  hasAnthropicKey: true,
  hasOpenAiKey: true,
  hasOpenRouterKey: true,
  onboardingComplete: true,
};

const requestLog: Array<{ pathname: string; init?: RequestInit }> = [];

beforeEach(() => {
  requestLog.length = 0;
  vi.stubGlobal('confirm', vi.fn(() => true));
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const pathname = new URL(String(input), 'http://localhost').pathname;
    requestLog.push({ pathname, init });
    if (pathname === '/api/config/readiness') {
      return { ok: true, json: async () => ({ mode: 'hosted' }) };
    }
    if (pathname === '/api/auth/me') {
      return { ok: true, json: async () => ({ profile }) };
    }
    if (pathname === '/api/onboarding/validate-ai-key') {
      return { ok: true, json: async () => ({ valid: true }) };
    }
    if (pathname === '/api/onboarding/validate-redis') {
      return { ok: true, json: async () => ({ valid: true }) };
    }
    if (pathname === '/api/onboarding/save-credentials') {
      return { ok: true, json: async () => ({ success: true }) };
    }
    if (pathname === '/api/onboarding/complete') {
      return { ok: true, json: async () => ({ redirectPath: '/studies' }) };
    }
    if (pathname === '/api/account/credentials') {
      return { ok: true, json: async () => ({ configured: {} }) };
    }
    return { ok: false, json: async () => ({ error: 'not found' }) };
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('provider setup guidance', () => {
  it('routes onboarding users to provider-owned pricing and limit documentation', async () => {
    render(<Onboarding />);

    fireEvent.click(screen.getByRole('button', { name: /get started/i }));
    fireEvent.click(screen.getByRole('button', { name: /how to get a gemini api key/i }));
    fireEvent.click(screen.getByRole('button', { name: /how to get a claude api key/i }));
    fireEvent.click(screen.getByRole('button', { name: /how to get an openai api key/i }));
    fireEvent.click(screen.getByRole('button', { name: /how to get an openrouter api key/i }));

    expect(screen.getByText(/pricing, free-tier availability, and rate limits vary/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^rate-limit documentation/ })).toHaveAttribute(
      'href',
      'https://ai.google.dev/gemini-api/docs/rate-limits',
    );
    expect(screen.getByRole('link', { name: /^rate-limit documentation/ })).toHaveAccessibleName(/opens in a new tab/);
    expect(screen.getByText(/credits, billing requirements, pricing, and usage limits vary/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^current pricing documentation/ })).toHaveAttribute(
      'href',
      'https://platform.claude.com/docs/en/about-claude/pricing',
    );
    expect(screen.getByRole('link', { name: /^API pricing/ })).toHaveAttribute(
      'href',
      'https://developers.openai.com/api/docs/pricing',
    );
    expect(screen.getByRole('link', { name: /^privacy and ZDR documentation/ })).toHaveAttribute(
      'href',
      'https://openrouter.ai/docs/guides/features/zdr',
    );
    expect(screen.getByText(/routes requests to upstream inference providers/i)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/10 req\/min|250 req\/day|\$5 free|15-100 interviews/i);

    fireEvent.change(screen.getByLabelText(/OpenAI API Key/i), {
      target: { value: 'sk-openai-test' },
    });
    const openAiInput = screen.getByLabelText(/OpenAI API Key/i);
    fireEvent.click(within(openAiInput.parentElement!).getByRole('button', { name: 'Test' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /next/i })).toBeEnabled());
    expect(JSON.parse(String(requestLog.find(call => call.pathname === '/api/onboarding/validate-ai-key')?.init?.body))).toEqual({
      provider: 'openai',
      apiKey: 'sk-openai-test',
    });
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    fireEvent.click(screen.getByRole('button', { name: /how to set up upstash redis/i }));

    expect(screen.getByText(/plan availability, pricing, and limits vary/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Redis pricing/ })).toHaveAttribute(
      'href',
      'https://upstash.com/pricing/redis',
    );
    expect(document.body).not.toHaveTextContent(/256 MB|500K commands|free tier is more than enough/i);
  });

  it('keeps the same provider-owned guidance available when rotating credentials', async () => {
    render(<Settings />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Google Gemini setup guide' }));
    fireEvent.click(screen.getByRole('button', { name: 'Anthropic Claude setup guide' }));
    fireEvent.click(screen.getByRole('button', { name: 'OpenAI setup guide' }));
    fireEvent.click(screen.getByRole('button', { name: 'OpenRouter setup guide' }));
    fireEvent.click(screen.getByRole('button', { name: 'Setup guide' }));

    expect(screen.getByRole('link', { name: /^rate-limit documentation/ })).toHaveAttribute(
      'href',
      'https://ai.google.dev/gemini-api/docs/rate-limits',
    );
    expect(screen.getByRole('link', { name: /^current pricing documentation/ })).toHaveAttribute(
      'href',
      'https://platform.claude.com/docs/en/about-claude/pricing',
    );
    expect(screen.getByRole('link', { name: /^API pricing/ })).toHaveAttribute(
      'href',
      'https://developers.openai.com/api/docs/pricing',
    );
    expect(screen.getByRole('link', { name: /^privacy and ZDR documentation/ })).toHaveAttribute(
      'href',
      'https://openrouter.ai/docs/guides/features/zdr',
    );
    expect(screen.getByRole('link', { name: /^Redis pricing/ })).toHaveAttribute(
      'href',
      'https://upstash.com/pricing/redis',
    );
    expect(screen.getByRole('link', { name: /^Redis pricing/ })).toHaveAccessibleName(/opens in a new tab/);
    expect(document.body).not.toHaveTextContent(/10 req\/min|250 req\/day|\$5 free|15-100 interviews|256 MB|500K commands/i);
  });

  it('tests, saves, and clears all provider credentials without echoing stored secrets', async () => {
    render(<Settings />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();

    const credentials = [
      { label: 'Google Gemini API Key', value: 'AIza-replacement' },
      { label: 'Anthropic Claude API Key', value: 'sk-ant-replacement' },
      { label: 'OpenAI API Key', value: 'sk-openai-replacement' },
      { label: 'OpenRouter API Key', value: 'sk-or-v1-replacement' },
    ];
    for (const credential of credentials) {
      const input = screen.getByLabelText(credential.label);
      expect(input).toHaveAttribute('type', 'password');
      expect(input).toHaveValue('');
      fireEvent.change(input, { target: { value: credential.value } });
      await waitFor(() => expect(screen.getByLabelText(credential.label)).toHaveValue(credential.value));
      const currentInput = screen.getByLabelText(credential.label);
      const testButton = within(currentInput.parentElement!).getByRole('button', { name: 'Test' });
      expect(testButton).toBeEnabled();
      fireEvent.click(testButton);
    }
    await waitFor(() => expect(requestLog.filter(call => call.pathname === '/api/onboarding/validate-ai-key')).toHaveLength(4));

    fireEvent.click(screen.getByRole('button', { name: /Validate & rotate/i }));
    await waitFor(() => expect(requestLog.some(call => call.pathname === '/api/onboarding/save-credentials')).toBe(true));
    const saveBody = JSON.parse(String(requestLog.find(call => call.pathname === '/api/onboarding/save-credentials')?.init?.body));
    expect(saveBody).toEqual({
      geminiApiKey: 'AIza-replacement',
      anthropicApiKey: 'sk-ant-replacement',
      openAiApiKey: 'sk-openai-replacement',
      openRouterApiKey: 'sk-or-v1-replacement',
    });
    for (const credential of credentials) {
      expect(screen.getByLabelText(credential.label)).toHaveValue('');
    }

    const openRouterLabel = screen.getByText('OpenRouter API Key');
    fireEvent.click(within(openRouterLabel.parentElement!.parentElement!).getByRole('button', { name: 'Clear' }));
    await waitFor(() => {
      const deletion = requestLog.find(call => call.pathname === '/api/account/credentials');
      expect(JSON.parse(String(deletion?.init?.body))).toEqual({ target: 'openrouter' });
    });
  });
});

describe('provider registry metadata and model labels', () => {
  it('brands the root document as OpenInterviewer', () => {
    expect(metadata.title).toBe('OpenInterviewer');
  });

  it('covers four providers with valid defaults and no embedded prices', () => {
    expect(PROVIDER_OPTIONS.map(({ id }) => id)).toEqual(['gemini', 'claude', 'openai', 'openrouter']);
    for (const provider of PROVIDER_OPTIONS) {
      expect(PROVIDER_MODELS[provider.id].length).toBeGreaterThan(0);
      expect(isKnownProviderModel(provider.id, DEFAULT_MODEL_BY_PROVIDER[provider.id])).toBe(true);
      expect(PROVIDER_MODELS[provider.id].map(({ desc }) => desc).join(' ')).not.toMatch(/\$|per MTok/i);
    }
  });
});
