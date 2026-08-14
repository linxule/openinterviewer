import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import OAuthLogin from '@/components/OAuthLogin';

describe('OAuthLogin provider visibility', () => {
  it('renders only configured providers', () => {
    render(<OAuthLogin providers={{ google: true, github: false }} />);
    expect(screen.getByRole('button', { name: /sign in with google/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign in with github/i })).not.toBeInTheDocument();
  });

  it('renders no buttons when no providers are configured', () => {
    render(<OAuthLogin providers={{ google: false, github: false }} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText(/not configured/i)).toBeInTheDocument();
  });
});
