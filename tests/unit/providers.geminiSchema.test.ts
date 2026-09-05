// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { toGeminiResponseSchema } from '@/lib/providers/gemini';
import {
  aggregateSynthesisResponseSchema,
  followupStudyResponseSchema,
  interviewResponseSchema,
  synthesisResponseSchema,
  type ProviderJsonSchema,
} from '@/lib/providerSchemas';

// Gemini's Interactions API rejects response_format schemas containing these
// JSON Schema keywords with a 400. They are re-enforced server-side by
// src/lib/providerValidation.ts, so stripping them from the Gemini-bound wire
// schema loses no safety. See src/lib/providers/gemini.ts.
const REJECTED_KEYWORDS = ['maxLength', 'minimum', 'minItems'] as const;

const SCHEMAS: Record<string, ProviderJsonSchema> = {
  interviewResponseSchema,
  synthesisResponseSchema,
  aggregateSynthesisResponseSchema,
  followupStudyResponseSchema,
};

function collectKeys(value: unknown, keys: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, keys);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      keys.add(key);
      collectKeys(entry, keys);
    }
  }
}

// Deep copy that also strips the three rejected keywords, used as an
// independent expectation to deep-equal the sanitizer's output against.
function stripExpected(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripExpected);
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if ((REJECTED_KEYWORDS as readonly string[]).includes(key)) continue;
      result[key] = stripExpected(entry);
    }
    return result;
  }
  return value;
}

describe('toGeminiResponseSchema', () => {
  for (const [name, schema] of Object.entries(SCHEMAS)) {
    describe(name, () => {
      it('strips every rejected keyword at every nesting level', () => {
        const sanitized = toGeminiResponseSchema(schema);
        const keys = new Set<string>();
        collectKeys(sanitized, keys);
        for (const rejected of REJECTED_KEYWORDS) {
          expect(keys.has(rejected)).toBe(false);
        }
      });

      it('deep-equals the source once the rejected keys are stripped', () => {
        const sanitized = toGeminiResponseSchema(schema);
        expect(sanitized).toEqual(stripExpected(schema));
      });

      it('does not mutate the source schema', () => {
        const before = JSON.parse(JSON.stringify(schema));
        toGeminiResponseSchema(schema);
        expect(schema).toEqual(before);
      });
    });
  }

  it('preserves maxItems, additionalProperties: false, required, and enum where present', () => {
    const sanitized = toGeminiResponseSchema(interviewResponseSchema);
    expect(sanitized).toMatchObject({
      additionalProperties: false,
      required: [
        'message',
        'questionAddressed',
        'phaseTransition',
        'profileUpdates',
        'shouldConclude',
      ],
    });
    const sanitizedTyped = sanitized as {
      properties: {
        phaseTransition: { enum: unknown[] };
        profileUpdates: { maxItems: number; items: { required: unknown[] } };
      };
    };
    expect(sanitizedTyped.properties.phaseTransition.enum).toEqual([
      'background',
      'core-questions',
      'exploration',
      'feedback',
      'wrap-up',
      null,
    ]);
    expect(sanitizedTyped.properties.profileUpdates.maxItems).toBe(50);
    expect(sanitizedTyped.properties.profileUpdates.items.required).toEqual([
      'fieldId',
      'value',
      'status',
    ]);
  });

  it('preserves maxItems and additionalProperties: false in the synthesis schema evidenceRefs', () => {
    const sanitized = toGeminiResponseSchema(synthesisResponseSchema) as {
      properties: {
        themes: {
          items: {
            additionalProperties: boolean;
            properties: {
              evidenceRefs: { maxItems: number; items: { additionalProperties: boolean } };
            };
          };
        };
      };
    };
    expect(sanitized.properties.themes.items.additionalProperties).toBe(false);
    expect(sanitized.properties.themes.items.properties.evidenceRefs.maxItems).toBe(3);
    expect(
      sanitized.properties.themes.items.properties.evidenceRefs.items.additionalProperties
    ).toBe(false);
  });

  it('confirms the source schemas actually contain rejected keywords (sanity check)', () => {
    const keys = new Set<string>();
    collectKeys(synthesisResponseSchema, keys);
    collectKeys(aggregateSynthesisResponseSchema, keys);
    collectKeys(followupStudyResponseSchema, keys);
    for (const rejected of REJECTED_KEYWORDS) {
      expect(keys.has(rejected)).toBe(true);
    }
  });
});
