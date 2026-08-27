// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { resolveEvidenceRef } from '@/lib/evidence';
import { DEMO_INTERVIEWS } from '@/lib/demoData';
import { SynthesisTheme } from '@/types';

// Pins the intentional coexistence in the authenticated sample workspace
// (Slice I2e): Sarah's synthesis is evidenceRefs-shaped, Marcus's and
// Priya's stay legacy-shaped. A future edit to the seeded transcripts or
// refs must not silently break this showcase.

describe('sample-workspace evidence seeding', () => {
  for (const interview of DEMO_INTERVIEWS) {
    const themes: SynthesisTheme[] = interview.synthesis!.themes;
    const refs = themes.flatMap((theme) =>
      (theme.evidenceRefs ?? []).map((ref) => ({ theme, ref }))
    );

    it(`resolves every evidenceRef in ${interview.id} as verified against its own transcript`, () => {
      for (const { theme, ref } of refs) {
        const match = resolveEvidenceRef(ref, interview.transcript);
        expect(match.status, `${interview.id} · "${theme.theme}" · turn ${ref.turnIndex}`).toBe('verified');
      }
    });

    it(`cites only participant turns for every evidenceRef in ${interview.id}`, () => {
      for (const { theme, ref } of refs) {
        const turn = interview.transcript[ref.turnIndex - 1];
        expect(turn?.role, `${interview.id} · "${theme.theme}" · turn ${ref.turnIndex}`).toBe('user');
      }
    });
  }

  it('converts every theme in Sarah\'s synthesis to evidenceRefs, with the legacy field absent', () => {
    const sarah = DEMO_INTERVIEWS.find((i) => i.id === 'interview-demo-sarah');
    expect(sarah).toBeDefined();
    const themes = sarah!.synthesis!.themes;
    expect(themes.length).toBeGreaterThan(0);
    for (const theme of themes) {
      expect(theme.evidence).toBeUndefined();
      expect(Array.isArray(theme.evidenceRefs)).toBe(true);
      expect(theme.evidenceRefs!.length).toBeGreaterThan(0);
      expect(theme.evidenceRefs!.length).toBeLessThanOrEqual(3);
    }
  });

  it('keeps Marcus and Priya legacy-shaped, the coexistence this showcase is meant to demonstrate', () => {
    const legacy = DEMO_INTERVIEWS.filter((i) => i.id !== 'interview-demo-sarah');
    expect(legacy.length).toBeGreaterThan(0);
    for (const interview of legacy) {
      const themes = interview.synthesis!.themes;
      expect(themes.length).toBeGreaterThan(0);
      for (const theme of themes) {
        expect(typeof theme.evidence).toBe('string');
        expect(theme.evidence!.length).toBeGreaterThan(0);
        expect(theme.evidenceRefs).toBeUndefined();
      }
    }
  });
});
