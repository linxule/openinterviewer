import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  AI_PROVIDER_SETUP,
  emptyValidationState,
  initialProviderRecord,
  providerInputId,
  ValidationBadge,
} from '@/components/providerSetup';

describe('providerSetup', () => {
  it('carries the four provider ids in registry order', () => {
    expect(AI_PROVIDER_SETUP.map((provider) => provider.id)).toEqual([
      'gemini', 'claude', 'openai', 'openrouter',
    ]);
  });

  it('produces the eight literal input ids the two surfaces used before this slice', () => {
    const [gemini, claude, openai, openrouter] = AI_PROVIDER_SETUP;
    expect(providerInputId('settings', gemini)).toBe('settings-gemini-key');
    expect(providerInputId('settings', claude)).toBe('settings-claude-key');
    expect(providerInputId('settings', openai)).toBe('settings-openai-key');
    expect(providerInputId('settings', openrouter)).toBe('settings-openrouter-key');
    expect(providerInputId('onboarding', gemini)).toBe('onboarding-gemini-key');
    expect(providerInputId('onboarding', claude)).toBe('onboarding-claude-key');
    expect(providerInputId('onboarding', openai)).toBe('onboarding-openai-key');
    expect(providerInputId('onboarding', openrouter)).toBe('onboarding-openrouter-key');
  });

  it('renders the OpenRouter guidance with "requests fail" and never the singular variant', () => {
    const openrouter = AI_PROVIDER_SETUP.find((provider) => provider.id === 'openrouter')!;
    render(<div>{openrouter.guidance}</div>);
    expect(screen.getByText(/requests fail if those restrictions cannot be met/)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/a request fails/);
  });

  it('keeps the three-step gemini setup list', () => {
    const gemini = AI_PROVIDER_SETUP.find((provider) => provider.id === 'gemini')!;
    expect(gemini.steps).toEqual([
      'Sign in with a Google account',
      'Create an API key',
      'Copy the new key',
    ]);
  });

  it('initialProviderRecord returns four independent values', () => {
    let counter = 0;
    const record = initialProviderRecord(() => ({ n: counter++ }));
    expect(record.gemini).toEqual({ n: 0 });
    expect(record.claude).toEqual({ n: 1 });
    expect(record.openai).toEqual({ n: 2 });
    expect(record.openrouter).toEqual({ n: 3 });
    record.gemini.n = 99;
    expect(record.claude.n).toBe(1);
  });

  it('emptyValidationState is the neutral shape', () => {
    expect(emptyValidationState()).toEqual({ loading: false, valid: null, error: null });
  });

  describe('ValidationBadge', () => {
    it('renders the loading branch with its sr-only string', () => {
      render(<ValidationBadge state={{ loading: true, valid: null, error: null }} label="Gemini" />);
      expect(screen.getByText('Testing…')).toHaveAttribute('aria-hidden', 'true');
      expect(screen.getByText('Testing Gemini key')).toHaveClass('sr-only');
    });

    it('renders the valid branch with its sr-only string', () => {
      render(<ValidationBadge state={{ loading: false, valid: true, error: null }} label="Gemini" />);
      expect(screen.getByText('Valid')).toHaveAttribute('aria-hidden', 'true');
      expect(screen.getByText('Gemini key validated')).toHaveClass('sr-only');
    });

    it('renders the invalid branch', () => {
      render(<ValidationBadge state={{ loading: false, valid: false, error: 'bad key' }} label="Gemini" />);
      expect(screen.getByText('Invalid')).toHaveAttribute('aria-hidden', 'true');
    });

    it('renders nothing when valid is null and not loading', () => {
      const { container } = render(<ValidationBadge state={{ loading: false, valid: null, error: null }} label="Gemini" />);
      expect(container).toBeEmptyDOMElement();
    });
  });
});
