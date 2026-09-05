// @vitest-environment node

import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { validateResolvedAggregateSynthesis } from '@/lib/providerValidation';
import { aggregateSynthesisResponseSchema } from '@/lib/providerSchemas';
import { MAX_AGGREGATE_QUOTE_REFS } from '@/lib/prompts/synthesis';

// Duplicated from synthesisReceipt.ts's canonicalize/digest — those internals
// are not exported, and this local copy is honest about what it duplicates
// (see tests/unit/synthesisSchema.roundTrip.test.ts for the same pattern).
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
const resolvedAggregate = {
  commonThemes: [
    {
      theme: 'Context notes', frequency: 2,
      quoteRefs: [
        { quote: 'I keep a short project note.', turnIndex: 2, interviewId: 'interview-a' },
        { quote: 'the note reminds me why I saved it', turnIndex: 4, interviewId: 'interview-b' },
      ],
    },
    {
      theme: 'Legacy-shaped theme in the same payload', frequency: 1,
      representativeQuotes: ['A composed quote from before Slice L.'],
    },
  ],
  divergentViews: [{ topic: 'Frequency', viewA: 'Daily notes', viewB: 'Weekly notes' }],
  keyFindings: ['Notes help recall.'],
  researchImplications: ['Investigate note-taking cadence.'],
  bottomLine: 'Participants rely on short notes to resume work.',
};

describe('validateResolvedAggregateSynthesis round trip', () => {
  it('pins MAX_AGGREGATE_QUOTE_REFS equal to the wire schema\'s quoteRefs.maxItems', () => {
    const themeItemSchema = (
      aggregateSynthesisResponseSchema.properties.commonThemes as {
        items: { properties: { quoteRefs: { maxItems: number } } };
      }
    ).items;

    expect(themeItemSchema.properties.quoteRefs.maxItems).toBe(MAX_AGGREGATE_QUOTE_REFS);
  });

  it('produces byte-identical digests across two independent validator invocations', () => {
    const first = validateResolvedAggregateSynthesis(resolvedAggregate);
    const roundTripped = JSON.parse(JSON.stringify(first));
    const second = validateResolvedAggregateSynthesis(roundTripped);

    expect(digest(second)).toBe(digest(first));
  });

  it('is unaffected by quoteRefs field order in the input', () => {
    const reordered = {
      ...resolvedAggregate,
      commonThemes: [
        {
          theme: 'Context notes', frequency: 2,
          quoteRefs: [
            { turnIndex: 2, interviewId: 'interview-a', quote: 'I keep a short project note.' },
            { interviewId: 'interview-b', quote: 'the note reminds me why I saved it', turnIndex: 4 },
          ],
        },
        resolvedAggregate.commonThemes[1],
      ],
    };

    const canonicalResult = validateResolvedAggregateSynthesis(resolvedAggregate);
    const reorderedResult = validateResolvedAggregateSynthesis(reordered);

    expect(digest(reorderedResult)).toBe(digest(canonicalResult));
  });

  it('rejects an unknown key on a ref', () => {
    const withUnknownKey = {
      ...resolvedAggregate,
      commonThemes: [
        {
          theme: 'Context notes', frequency: 2,
          quoteRefs: [
            { quote: 'I keep a short project note.', turnIndex: 2, interviewId: 'interview-a', sourceUrl: 'https://example.invalid' },
          ],
        },
      ],
    };

    expect(() => validateResolvedAggregateSynthesis(withUnknownKey)).toThrow();
  });

  it('rejects a ref carrying an unresolved interviewIndex instead of interviewId', () => {
    const unresolved = {
      ...resolvedAggregate,
      commonThemes: [
        {
          theme: 'Context notes', frequency: 2,
          quoteRefs: [{ quote: 'I keep a short project note.', turnIndex: 2, interviewIndex: 1 }],
        },
      ],
    };

    expect(() => validateResolvedAggregateSynthesis(unresolved)).toThrow();
  });
});
