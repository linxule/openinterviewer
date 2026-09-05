// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { buildAggregateSynthesisPrompt } from '@/lib/prompts/synthesis';
import { SynthesisResult, StudyConfig } from '@/types';

// All quotes below are invented fixture content, never real participant text.

const studyConfig: Partial<StudyConfig> = {
  researchQuestion: 'How do people resume research?',
  topicAreas: ['Context switching'],
};

function baseSynthesis(overrides: Partial<SynthesisResult>): SynthesisResult {
  return {
    statedPreferences: [], revealedPreferences: [], themes: [],
    contradictions: [], keyInsights: [], bottomLine: 'A bottom line.',
    ...overrides,
  };
}

describe('buildAggregateSynthesisPrompt catalogue', () => {
  it('prints an [i.t]-style tag matching the interview index it sits in', () => {
    const syntheses: SynthesisResult[] = [
      baseSynthesis({ themes: [{ theme: 'A', frequency: 1, evidenceRefs: [{ quote: 'kept a short note', turnIndex: 4 }] }] }),
      baseSynthesis({ themes: [{ theme: 'B', frequency: 1, evidenceRefs: [{ quote: 'forgot the project', turnIndex: 9 }] }] }),
    ];

    const prompt = buildAggregateSynthesisPrompt(studyConfig as StudyConfig, syntheses, 2);

    expect(prompt).toContain('[1.4] "kept a short note"');
    expect(prompt).toContain('[2.9] "forgot the project"');
  });

  it('prints the honest-zero line for an interview whose synthesis is legacy-shaped', () => {
    const syntheses: SynthesisResult[] = [
      baseSynthesis({ themes: [{ theme: 'A', frequency: 1, evidence: 'A free-text passage.' }] }),
    ];

    const prompt = buildAggregateSynthesisPrompt(studyConfig as StudyConfig, syntheses, 1);

    expect(prompt).toContain('Citable quotes: none available for this interview.');
  });

  it('offers at most three entries per interview', () => {
    const syntheses: SynthesisResult[] = [
      baseSynthesis({
        themes: [{
          theme: 'A', frequency: 1,
          evidenceRefs: [
            { quote: 'first quote', turnIndex: 2 },
            { quote: 'second quote', turnIndex: 3 },
            { quote: 'third quote', turnIndex: 4 },
            { quote: 'fourth quote', turnIndex: 5 },
            { quote: 'fifth quote', turnIndex: 6 },
          ],
        }],
      }),
    ];

    const prompt = buildAggregateSynthesisPrompt(studyConfig as StudyConfig, syntheses, 1);

    expect(prompt).toContain('[1.2] "first quote"');
    expect(prompt).toContain('[1.3] "second quote"');
    expect(prompt).toContain('[1.4] "third quote"');
    expect(prompt).not.toContain('fourth quote');
    expect(prompt).not.toContain('fifth quote');
  });

  it('round-robins over interviews: every interview that appears contributes before any interview gets a second entry', () => {
    const INTERVIEW_COUNT = 100;
    const QUOTE = 'Q'.repeat(280); // ~300 rendered chars per catalogue line with tag + quote marks
    const syntheses: SynthesisResult[] = Array.from({ length: INTERVIEW_COUNT }, () => baseSynthesis({
      themes: [{
        theme: 'A', frequency: 1,
        evidenceRefs: [
          { quote: `${QUOTE}-1`, turnIndex: 2 },
          { quote: `${QUOTE}-2`, turnIndex: 3 },
          { quote: `${QUOTE}-3`, turnIndex: 4 },
        ],
      }],
    }));

    const prompt = buildAggregateSynthesisPrompt(studyConfig as StudyConfig, syntheses, INTERVIEW_COUNT);

    const counts = new Array(INTERVIEW_COUNT).fill(0);
    const tagPattern = /\[(\d+)\.\d+\]/g;
    for (const match of prompt.matchAll(tagPattern)) {
      const interviewIndex = Number(match[1]) - 1;
      counts[interviewIndex] += 1;
    }

    // The budget was hit (otherwise this test proves nothing): not every
    // interview got all three entries, and at least one got more than zero.
    expect(counts.some((c) => c < 3)).toBe(true);
    expect(counts.every((c) => c > 0)).toBe(true);

    // Round-robin, not a prefix cut: counts are non-increasing over interview
    // order and never differ by more than one pass.
    for (let i = 0; i < counts.length - 1; i += 1) {
      expect(counts[i]).toBeGreaterThanOrEqual(counts[i + 1]);
    }
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it('contains the verbatim honesty sentence about invented quotes', () => {
    const prompt = buildAggregateSynthesisPrompt(studyConfig as StudyConfig, [baseSynthesis({})], 1);

    // The source wraps the sentence across lines; compare on normalized
    // whitespace the way a reader (or a model) would read the rendered text.
    expect(prompt.replace(/\s+/g, ' ')).toContain('an invented quote is not.');
  });
});
