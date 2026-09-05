// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { resolveSynthesisModel } from '@/lib/providers';
import { makeStudyConfig } from '../fixtures/models';

/**
 * Synthesis (per-interview synthesis, aggregate synthesis, and follow-up
 * generation) uses the study's own configured provider and model — the
 * researcher's own choice — never a fixed per-provider override. See
 * AGENTS.md's synthesis-provenance invariant.
 */
describe('synthesis model resolution', () => {
  it.each(['gemini', 'claude', 'openai', 'openrouter'] as const)(
    'resolves a %s study to its own configured model, not a fixed override',
    (provider) => {
      const config = makeStudyConfig({ aiProvider: provider, aiModel: `${provider}-researcher-choice` });

      expect(resolveSynthesisModel(config)).toBe(`${provider}-researcher-choice`);
    },
  );

  it('fails closed rather than substituting a default when the study has no explicit model', () => {
    const config = makeStudyConfig({ aiProvider: 'gemini' });
    delete config.aiModel;

    expect(() => resolveSynthesisModel(config)).toThrow(
      'Study is missing an explicit AI model required for synthesis',
    );
  });

  it('fails closed on an empty-string model rather than treating it as configured', () => {
    const config = makeStudyConfig({ aiProvider: 'openai', aiModel: '' });

    expect(() => resolveSynthesisModel(config)).toThrow(
      'Study is missing an explicit AI model required for synthesis',
    );
  });
});
