import { render, screen } from '@testing-library/react';
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

describe('Login hosted readiness', () => {
  it('fails closed without rendering usable OAuth controls', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        mode: 'hosted',
        ready: false,
        oauth: { google: true, github: true },
      }),
    }));

    render(<Login />);

    expect(await screen.findByText(/sign-in is disabled until the operator completes server configuration/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign in with google/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign in with github/i })).not.toBeInTheDocument();
  });

  it('renders only configured OAuth providers when hosted configuration is ready', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        mode: 'hosted',
        ready: true,
        oauth: { google: true, github: false },
      }),
    }));

    render(<Login />);

    expect(await screen.findByRole('button', { name: /sign in with google/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign in with github/i })).not.toBeInTheDocument();
  });
});
