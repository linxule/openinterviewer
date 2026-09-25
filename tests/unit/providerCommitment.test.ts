import { describe, expect, it } from 'vitest';
import { commitmentCovers, DEFAULT_PROVIDER_COMMITMENT, isProviderCommitment } from '@/lib/providerCommitment';

describe('provider commitment', () => {
  const fixed = { providerCommitment: 'fixed' as const, conductedByProvider: 'claude' as const, conductedByModel: 'claude-sonnet-5' };

  it('a fixed record is covered only by its own provider and model', () => {
    expect(commitmentCovers(fixed, 'claude', 'claude-sonnet-5')).toBe(true);
    expect(commitmentCovers(fixed, 'openai', 'claude-sonnet-5')).toBe(false);
    expect(commitmentCovers(fixed, 'claude', 'claude-opus-5')).toBe(false);
    expect(commitmentCovers(fixed, undefined, undefined)).toBe(false);
  });

  it('a fixed record missing what it was conducted with is never covered', () => {
    expect(commitmentCovers({ providerCommitment: 'fixed' }, undefined, undefined)).toBe(false);
    expect(commitmentCovers({ providerCommitment: 'fixed', conductedByProvider: 'claude' }, 'claude', undefined)).toBe(false);
  });

  it('may-change and legacy records are always covered', () => {
    expect(commitmentCovers({ ...fixed, providerCommitment: 'may-change' }, 'openai', 'gpt-5.6-terra')).toBe(true);
    expect(commitmentCovers({ conductedByProvider: 'claude', conductedByModel: 'claude-sonnet-5' }, 'openai', 'gpt-5.6-terra')).toBe(true);
  });

  it('accepts only the two commitments; new studies start fixed', () => {
    expect(isProviderCommitment('fixed')).toBe(true);
    expect(isProviderCommitment('may-change')).toBe(true);
    expect(isProviderCommitment('sometimes')).toBe(false);
    expect(isProviderCommitment(undefined)).toBe(false);
    expect(DEFAULT_PROVIDER_COMMITMENT).toBe('fixed');
  });
});
