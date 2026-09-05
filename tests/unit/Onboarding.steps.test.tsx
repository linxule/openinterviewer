import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Slice E regressions for Onboarding: the four-bar progress indicator is
 * replaced by a single mono line that must never announce, and every step
 * carries no decorative icons.
 */

const routerMock = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => routerMock }));

import Onboarding from '@/components/Onboarding';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const pathname = new URL(String(input), 'http://localhost').pathname;
    if (pathname === '/api/auth/me') {
      return { ok: true, json: async () => ({ profile: null }) };
    }
    if (pathname === '/api/onboarding/validate-ai-key') {
      return { ok: true, json: async () => ({ valid: true }) };
    }
    if (pathname === '/api/onboarding/validate-redis') {
      return { ok: true, json: async () => ({ valid: true }) };
    }
    return { ok: false, json: async () => ({ error: 'not found' }) };
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Onboarding step reskin', () => {
  it('renders a silent progress line on the welcome step', () => {
    render(<Onboarding />);

    const progress = screen.getByText('Step 1 of 4 · Welcome');
    expect(progress).not.toHaveAttribute('role');
    expect(progress).not.toHaveAttribute('aria-live');
  });

  it('advances the progress line when moving to the AI keys step', () => {
    render(<Onboarding />);

    fireEvent.click(screen.getByRole('button', { name: /get started/i }));

    const progress = screen.getByText('Step 2 of 4 · AI API Key');
    expect(progress).not.toHaveAttribute('role');
    expect(progress).not.toHaveAttribute('aria-live');
  });

  it('carries no decorative icons on the welcome, ai-keys, and done steps', async () => {
    const { container } = render(<Onboarding />);
    expect(container.querySelectorAll('svg')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: /get started/i }));
    expect(container.querySelectorAll('svg')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: /how to get an openai api key/i }));
    const guideSvgs = Array.from(container.querySelectorAll('svg'));
    expect(guideSvgs.length).toBeGreaterThan(0);
    for (const svg of guideSvgs) {
      expect(svg).toHaveAttribute('aria-hidden', 'true');
      expect(svg.closest('a, button')).not.toBeNull();
    }

    fireEvent.change(screen.getByLabelText(/OpenAI API Key/i), {
      target: { value: 'sk-openai-test' },
    });
    const openAiInput = screen.getByLabelText(/OpenAI API Key/i);
    fireEvent.click(within(openAiInput.parentElement!).getByRole('button', { name: 'Test' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /next/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /next/i }));

    fireEvent.change(screen.getByLabelText('REST API URL'), {
      target: { value: 'https://example.upstash.io' },
    });
    fireEvent.change(screen.getByLabelText('REST API Token'), {
      target: { value: 'token-value' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /next/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /next/i }));

    await screen.findByText("You're all set!");
    expect(container.querySelectorAll('svg')).toHaveLength(0);
  });

  it('never wraps a step in a bordered bg-paper-1 card (rules over boxes)', () => {
    const { container } = render(<Onboarding />);
    container.querySelectorAll('*').forEach((el) => {
      const className = typeof el.className === 'string' ? el.className : '';
      if (className.includes('bg-paper-1')) {
        expect(className).not.toMatch(/\bborder\b/);
      }
    });
  });
});
