// @vitest-environment node

import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { MAX_EVIDENCE_REFS, validateSynthesisResult } from '@/lib/providerValidation';
import { synthesisResponseSchema } from '@/lib/providerSchemas';

// Duplicated from synthesisReceipt.ts's canonicalize/digest — those internals
// are not exported, and this local copy is honest about what it duplicates
// (see tests/unit/api.save.idempotent.test.ts for the same pattern).
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== '_receipt')
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)])
    );
  }
  return value;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

// All quotes below are invented fixture content, never real participant text.
const newShapePayload = {
  statedPreferences: ['Speed'],
  revealedPreferences: ['Efficiency'],
  themes: [
    {
      theme: 'Onboarding friction',
      frequency: 2,
      evidenceRefs: [
        { quote: 'I started the onboarding flow and immediately got stuck.', turnIndex: 2 },
        { quote: 'the settings page confused me', turnIndex: 4, interviewId: 'interview-abc123' },
      ],
    },
    {
      theme: 'Legacy-shaped theme in the same payload',
      frequency: 1,
      evidence: 'A free-text supporting passage from before Initiative 2.',
    },
  ],
  contradictions: [],
  keyInsights: ['Onboarding needs a walkthrough.'],
  bottomLine: 'Participants struggle with onboarding.',
};

describe('validateSynthesisResult round trip (A3.4)', () => {
  it('produces byte-identical digests across two independent validator invocations', () => {
    const first = validateSynthesisResult(newShapePayload);
    const roundTripped = JSON.parse(JSON.stringify(first));
    const second = validateSynthesisResult(roundTripped);

    expect(digest(second)).toBe(digest(first));
  });

  it('is unaffected by evidenceRefs field order in the input', () => {
    const reordered = {
      ...newShapePayload,
      themes: [
        {
          theme: 'Onboarding friction',
          frequency: 2,
          evidenceRefs: [
            { turnIndex: 2, quote: 'I started the onboarding flow and immediately got stuck.' },
            { interviewId: 'interview-abc123', turnIndex: 4, quote: 'the settings page confused me' },
          ],
        },
        newShapePayload.themes[1],
      ],
    };

    const canonicalResult = validateSynthesisResult(newShapePayload);
    const reorderedResult = validateSynthesisResult(reordered);

    expect(digest(reorderedResult)).toBe(digest(canonicalResult));
  });

  it('rejects an unknown key on a ref', () => {
    const withUnknownKey = {
      ...newShapePayload,
      themes: [
        {
          theme: 'Onboarding friction',
          frequency: 2,
          evidenceRefs: [
            {
              quote: 'I started the onboarding flow and immediately got stuck.',
              turnIndex: 2,
              sourceUrl: 'https://example.invalid',
            },
          ],
        },
      ],
    };

    expect(() => validateSynthesisResult(withUnknownKey)).toThrow();
  });

  it('pins MAX_EVIDENCE_REFS equal to the wire schema\'s evidenceRefs.maxItems', () => {
    const themeItemSchema = (
      synthesisResponseSchema.properties.themes as {
        items: { properties: { evidenceRefs: { maxItems: number } } };
      }
    ).items;

    expect(themeItemSchema.properties.evidenceRefs.maxItems).toBe(MAX_EVIDENCE_REFS);
  });
});
