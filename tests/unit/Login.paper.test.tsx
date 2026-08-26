import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const routerMock = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  useSearchParams: () => ({ get: vi.fn(() => null) }),
}));

import Login from '@/components/Login';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Login paper styling', () => {
  it('routes the password control through Field and enables Login only once filled', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        mode: 'standalone',
        ready: true,
        oauth: { google: false, github: false },
      }),
    }));

    render(<Login />);

    const input = await screen.findByLabelText('Password');
    expect(input).toHaveAttribute('type', 'password');
    const submit = screen.getByRole('button', { name: /login/i });
    expect(submit).toBeDisabled();

    fireEvent.change(input, { target: { value: 'secret' } });
    expect(submit).not.toBeDisabled();
  });

  it('carries no svg in the standalone state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        mode: 'standalone',
        ready: true,
        oauth: { google: false, github: false },
      }),
    }));

    const { container } = render(<Login />);
    await screen.findByLabelText('Password');

    expect(container.querySelectorAll('svg')).toHaveLength(0);
  });

  it('carries no svg in the hosted-not-ready state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        mode: 'hosted',
        ready: false,
        oauth: { google: true, github: true },
      }),
    }));

    const { container } = render(<Login />);
    await screen.findByText(/sign-in is disabled until the operator completes server configuration/i);

    expect(container.querySelectorAll('svg')).toHaveLength(0);
  });

  it('keeps svg nodes confined to the kept OAuth brand marks in the hosted-ready state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        mode: 'hosted',
        ready: true,
        oauth: { google: true, github: true },
      }),
    }));

    const { container } = render(<Login />);
    const providerButtons = await screen.findAllByRole('button', { name: /sign in with (google|github)/i });

    const svgs = container.querySelectorAll('svg');
    expect(svgs.length).toBe(providerButtons.length);
    svgs.forEach((svg) => {
      expect(svg.closest('button')).not.toBeNull();
    });
  });

  it('renders the missing-configuration sentence with no role="alert"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        mode: 'hosted',
        ready: false,
        oauth: { google: false, github: false },
      }),
    }));

    render(<Login />);

    const message = await screen.findByText('This hosted instance is missing required configuration.');
    expect(message).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('carries no legacy classes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        mode: 'standalone',
        ready: true,
        oauth: { google: false, github: false },
      }),
    }));

    const { container } = render(<Login />);
    await screen.findByLabelText('Password');

    container.querySelectorAll('[class]').forEach((el) => {
      expect(el.className).not.toMatch(/stone-|red-500|red-400/);
    });
  });
});
