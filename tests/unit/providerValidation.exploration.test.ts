// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { validateExplorationPayload } from '@/lib/providerValidation';
import { MAX_EXPLORATION_PAYLOAD_BYTES, explorationResponseSchema } from '@/lib/providerSchemas';
import { isExplorationProviderPayload } from '@/lib/exploration/validation';

const claim = { interviewIndex: 1, turnIndex: 2, quote: 'Synthetic evidence.' };
const finding = {
  heading: 'One provisional pattern', interpretation: 'A tentative interpretation.',
  supporting: [claim], challenging: [], uncertain: [],
};
const payload = () => ({ answer: 'Insufficient evidence for three archetypes.', findings: [structuredClone(finding)], limitations: ['Only one interview.'] });

describe('exploration provider output boundary', () => {
  it('accepts an honest insufficient-evidence answer with no findings or citations', () => {
    const value = { answer: 'The profiles do not record age.', findings: [], limitations: ['Age is unknown.'] };
    expect(validateExplorationPayload(value)).toEqual(value);
    expect(isExplorationProviderPayload(value)).toBe(true);
  });

  it.each([
    ['unknown root property', () => ({ ...payload(), toolCall: 'read external source' })],
    ['unknown finding property', () => ({ ...payload(), findings: [{ ...finding, prevalence: 0.8 }] })],
    ['model record identity', () => ({ ...payload(), findings: [{ ...finding, supporting: [{ ...claim, interviewId: 'i1' }] }] })],
    ['zero-based position', () => ({ ...payload(), findings: [{ ...finding, supporting: [{ ...claim, interviewIndex: 0 }] }] })],
    ['oversize position', () => ({ ...payload(), findings: [{ ...finding, supporting: [{ ...claim, interviewIndex: 101 }] }] })],
    ['fractional turn', () => ({ ...payload(), findings: [{ ...finding, supporting: [{ ...claim, turnIndex: 2.5 }] }] })],
    ['unsafe turn', () => ({ ...payload(), findings: [{ ...finding, supporting: [{ ...claim, turnIndex: Number.MAX_SAFE_INTEGER + 1 }] }] })],
    ['missing category', () => ({ ...payload(), findings: [{ heading: 'A', interpretation: 'B', supporting: [], challenging: [] }] })],
    ['too many quotes', () => ({ ...payload(), findings: [{ ...finding, supporting: Array.from({ length: 11 }, () => claim) }] })],
    ['oversize quote', () => ({ ...payload(), findings: [{ ...finding, supporting: [{ ...claim, quote: 'x'.repeat(2_001) }] }] })],
    ['empty answer', () => ({ ...payload(), answer: ' ' })],
    ['oversize answer', () => ({ ...payload(), answer: 'x'.repeat(20_001) })],
    ['too many findings', () => ({ ...payload(), findings: Array.from({ length: 21 }, () => finding) })],
    ['too many limitations', () => ({ ...payload(), limitations: Array.from({ length: 21 }, () => 'Missing') })],
  ])('refuses %s', (_label, make) => {
    expect(() => validateExplorationPayload(make())).toThrow(/invalid exploration/);
    expect(isExplorationProviderPayload(make())).toBe(false);
  });

  it('enforces a serialized UTF-8 byte cap even when each field is within its character bound', () => {
    const quotes = Array.from({ length: 6 }, () => ({ ...claim, quote: '界'.repeat(2_000) }));
    const value = { ...payload(), findings: Array.from({ length: 4 }, () => ({ ...finding, supporting: quotes, challenging: quotes, uncertain: quotes })) };
    expect(new TextEncoder().encode(JSON.stringify(value)).byteLength).toBeGreaterThan(MAX_EXPLORATION_PAYLOAD_BYTES);
    expect(() => validateExplorationPayload(value)).toThrow(/serialize to at most/);
    expect(isExplorationProviderPayload(value)).toBe(false);
  });

  it('pins runtime list bounds to the strict schema', () => {
    expect(explorationResponseSchema.properties.findings.maxItems).toBe(20);
    expect(explorationResponseSchema.properties.findings.items.properties.supporting.maxItems).toBe(10);
    expect(explorationResponseSchema.properties.findings.items.properties.challenging.maxItems).toBe(10);
    expect(explorationResponseSchema.properties.findings.items.properties.uncertain.maxItems).toBe(10);
  });
});
