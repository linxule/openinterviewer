import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

/**
 * M8.2: the seven border-l-2 notice blocks StudySetup carries become Notice,
 * byte-identical in classes, roles, and (where present) eyebrow structure.
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
const searchParamsMock = vi.hoisted(() => ({ value: new URLSearchParams() }));
vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  useSearchParams: () => searchParamsMock.value,
}));

import StudySetup from '@/components/StudySetup';

function seedStore(overrides: Record<string, unknown> = {}) {
  storeMock.seed({
    studyConfig: null,
    setStudyConfig: vi.fn(),
    setStep: vi.fn(),
    loadExampleStudy: vi.fn(),
    setViewMode: vi.fn(),
    setAiTransport: vi.fn(),
    resetParticipant: vi.fn(),
    ...overrides,
  });
}

beforeEach(() => {
  searchParamsMock.value = new URLSearchParams();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('StudySetup notice blocks (Notice primitive, C3)', () => {
  it('renders the provider-unavailable alert as the document\'s only role="alert" when the config-status check fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = new URL(url, 'http://localhost').pathname;
      if (path === '/api/auth') {
        return { ok: true, status: 200, json: async () => ({ authenticated: true }) };
      }
      if (path === '/api/config/status') {
        return { ok: false, status: 503, json: async () => ({ error: 'status unavailable' }) };
      }
      return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
    }));
    seedStore();

    render(<StudySetup />);

    const alert = await screen.findByRole('alert');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(alert).toHaveClass('border-l-2', 'border-error', 'bg-paper-2', 'px-4', 'py-3');
    expect(alert).toHaveTextContent('Provider availability could not be verified');
  });

  it('carries the Open self-host setup guide control on the provider-unavailable alert for a standalone deployment missing the key', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = new URL(url, 'http://localhost').pathname;
      if (path === '/api/auth') {
        return { ok: true, status: 200, json: async () => ({ authenticated: true }) };
      }
      if (path === '/api/config/status') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            mode: 'standalone',
            aiTransport: 'direct',
            hasAnthropicKey: false,
            hasGeminiKey: false,
            hasOpenAiKey: false,
            hasOpenRouterKey: false,
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
    }));
    seedStore();

    render(<StudySetup />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveClass('border-l-2', 'border-error', 'bg-paper-2', 'px-4', 'py-3');
    expect(screen.getByRole('button', { name: 'Open self-host setup guide' })).toBeInTheDocument();
  });

  it('carries role="status" while providers are still being checked', async () => {
    const statusGate: { resolve: (() => void) | null } = { resolve: null };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = new URL(url, 'http://localhost').pathname;
      if (path === '/api/auth') {
        return { ok: true, status: 200, json: async () => ({ authenticated: true }) };
      }
      if (path === '/api/config/status') {
        await new Promise<void>((resolve) => { statusGate.resolve = resolve; });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            mode: 'hosted',
            aiTransport: 'direct',
            hasAnthropicKey: true,
            hasGeminiKey: true,
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
    }));
    seedStore();

    render(<StudySetup />);

    const status = await screen.findByRole('status');
    expect(status).toHaveClass('border-l-2', 'border-ink-500', 'bg-paper-2', 'px-4', 'py-3');
    expect(status).toHaveTextContent('Checking configured AI providers…');

    statusGate.resolve?.();
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });

  it('renders the follow-up notice with neither role', () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = new URL(url, 'http://localhost').pathname;
      if (path === '/api/auth') {
        return { ok: true, status: 200, json: async () => ({ authenticated: false }) };
      }
      return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
    }));
    sessionStorage.setItem('prefillStudyConfig', JSON.stringify({
      name: 'Follow-up study',
      researchQuestion: 'What next?',
      parentStudyId: 'parent-1',
      parentStudyName: 'Parent Study',
    }));
    searchParamsMock.value = new URLSearchParams('prefill=followup');
    seedStore();

    render(<StudySetup />);

    const notice = screen.getByText('Follow-up Study').closest('div')!;
    expect(notice).not.toHaveAttribute('role');
    expect(notice).toHaveClass('border-l-2', 'border-ink-500', 'bg-paper-2', 'px-4', 'py-3');

    sessionStorage.removeItem('prefillStudyConfig');
  });
});
