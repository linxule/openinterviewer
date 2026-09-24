// Gap F5: the Login form must not bound the password. Only the Cloudflare
// target caps the sign-in body (1 KiB; the server answers 413, and the
// installer, operator CLI and readiness check refuse a longer ADMIN_PASSWORD).
// The Node/Vercel target has no such cap, so a limit in the form would lock
// out an operator whose longer password is valid there.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const routerMock = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  useSearchParams: () => ({ get: vi.fn(() => null) }),
}));

import Login from '@/components/Login';

type AuthReply = { status: number; body: Record<string, unknown> };

function stubServer(auth: AuthReply) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    if (String(input) === '/api/config/readiness') {
      return new Response(JSON.stringify({ mode: 'standalone', ready: true, oauth: { google: false, github: false } }));
    }
    if (String(input) === '/api/auth') return new Response(JSON.stringify(auth.body), { status: auth.status });
    throw new Error(`Unexpected fetch: ${String(input)}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function submit(password: string) {
  const input = await screen.findByPlaceholderText('Enter admin password');
  fireEvent.change(input, { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Login' }));
  return input;
}

beforeEach(() => {
  routerMock.push.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Login password field (gap F5)', () => {
  it('sends a password longer than the Cloudflare body bound unchanged, so a Node operator can still sign in', async () => {
    const fetchMock = stubServer({ status: 200, body: { success: true } });
    const password = 'n'.repeat(2_000);
    render(<Login />);

    const input = await submit(password);

    // A browser cuts typed, pasted and autofilled text at maxlength (jsdom
    // does not), so the attribute is what would truncate the password.
    expect(input).not.toHaveAttribute('maxlength');
    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith('/studies'));
    const auth = fetchMock.mock.calls.find(([url]) => String(url) === '/api/auth');
    expect(JSON.parse(String(auth?.[1]?.body))).toEqual({ password });
  });

  it('shows the Cloudflare server refusal (413) for a body over its bound', async () => {
    stubServer({ status: 413, body: { error: 'Request body is too large' } });
    render(<Login />);

    await submit('c'.repeat(1_010));

    expect(await screen.findByText('Request body is too large')).toBeInTheDocument();
    expect(routerMock.push).not.toHaveBeenCalled();
  });
});
