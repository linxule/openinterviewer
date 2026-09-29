// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  aggregateSynthesisResponseSchema,
  explorationResponseSchema,
  followupStudyResponseSchema,
  interviewResponseSchema,
  synthesisResponseSchema,
} from '@/lib/providerSchemas';

function expectStrictObjects(schema: unknown): void {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return;
  const node = schema as Record<string, unknown>;
  if (node.type === 'object') {
    expect(node.additionalProperties).toBe(false);
    const properties = node.properties as Record<string, unknown>;
    expect(new Set(node.required as string[])).toEqual(new Set(Object.keys(properties)));
  }
  Object.values(node).forEach(expectStrictObjects);
}

describe('provider-neutral structured output schemas', () => {
  it('closes every object and requires every declared field', () => {
    for (const schema of [
      interviewResponseSchema,
      synthesisResponseSchema,
      aggregateSynthesisResponseSchema,
      explorationResponseSchema,
      followupStudyResponseSchema,
    ]) {
      expectStrictObjects(schema);
    }
  });

  it('represents optional interview values as explicit nullable fields', () => {
    expect(interviewResponseSchema.properties.questionAddressed.type).toEqual(['integer', 'null']);
    expect(interviewResponseSchema.properties.phaseTransition.type).toEqual(['string', 'null']);
    expect(
      interviewResponseSchema.properties.profileUpdates.items.properties.value.type,
    ).toEqual(['string', 'null']);
  });

  it('requires contradictions and complete aggregate arrays', () => {
    expect(synthesisResponseSchema.required).toContain('contradictions');
    expect(aggregateSynthesisResponseSchema.required).toEqual(expect.arrayContaining([
      'divergentViews',
      'researchImplications',
    ]));
  });
});
