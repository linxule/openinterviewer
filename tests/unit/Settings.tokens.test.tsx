import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Slice E regressions for Settings: the provider-key DOM contract E4.3
 * depends on, icon-free status announcements, and the BYOS explanation
 * rendering as a fact block rather than an interruptive Disclosure.
 */

const routerMock = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => routerMock }));

import Settings from '@/components/Settings';

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

const PROVIDER_LABELS = ['Google Gemini', 'Anthropic Claude', 'OpenAI', 'OpenRouter'];

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const pathname = new URL(String(input), 'http://localhost').pathname;
    if (pathname === '/api/config/readiness') {
      return { ok: true, json: async () => ({ mode: 'hosted' }) };
    }
    if (pathname === '/api/auth/me') {
      return { ok: true, json: async () => ({ profile }) };
    }
    return { ok: false, json: async () => ({ error: 'not found' }) };
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Settings token reskin', () => {
  it('keeps each provider key input a direct sibling of its Test button', async () => {
    render(<Settings />);
    await screen.findByRole('heading', { level: 1, name: 'Settings' });

    for (const label of PROVIDER_LABELS) {
      const input = screen.getByLabelText(`${label} API Key`);
      expect(within(input.parentElement!).getByRole('button', { name: 'Test' })).toBeInTheDocument();
    }
  });

  it('announces configured status as hidden text with the sr-only strings intact', async () => {
    render(<Settings />);
    await screen.findByRole('heading', { level: 1, name: 'Settings' });

    const configuredWords = screen.getAllByText('Configured');
    expect(configuredWords.length).toBeGreaterThan(0);
    for (const word of configuredWords) {
      expect(word).toHaveAttribute('aria-hidden', 'true');
    }

    expect(screen.getAllByText(': configured', { selector: '.sr-only' }).length).toBeGreaterThan(0);
  });

  it('renders the BYOS explanation as a fact block, not an interruptive Disclosure', async () => {
    render(<Settings />);
    await screen.findByRole('heading', { level: 1, name: 'Settings' });

    const heading = screen.getByText('How hosted BYOS credentials are handled');
    expect(heading.closest('[role="note"]')).toBeNull();
  });

  it('carries no decorative icons', async () => {
    const { container } = render(<Settings />);
    await screen.findByRole('heading', { level: 1, name: 'Settings' });
    expect(container.querySelectorAll('svg')).toHaveLength(0);
  });
});
