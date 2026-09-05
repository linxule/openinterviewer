// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  buildAggregateInterviewIndex,
  participantLabel,
  resolveAggregateThemeEvidence,
  withRecordBackedEvidence,
} from '@/lib/evidence';
import { AggregateTheme, EvidenceRef, InterviewMessage, SynthesisResult, SynthesisTheme } from '@/types';

// All transcript and quote content below is invented for this test, in the
// register of DemoSimulation's Maya fixtures. Never real participant text.

function turn(role: InterviewMessage['role'], content: string, id = 'm'): InterviewMessage {
  return { id, role, content, timestamp: 1 };
}

function ref(quote: string, turnIndex: number, interviewId?: string): EvidenceRef {
  return { quote, turnIndex, ...(interviewId !== undefined ? { interviewId } : {}) };
}

describe('buildAggregateInterviewIndex', () => {
  it('numbers ascending by createdAt regardless of input order', () => {
    const index = buildAggregateInterviewIndex([
      { id: 'newest', createdAt: 3_000, transcript: [] },
      { id: 'oldest', createdAt: 1_000, transcript: [] },
      { id: 'middle', createdAt: 2_000, transcript: [] },
    ]);

    expect(index.get('oldest')?.participantNumber).toBe(1);
    expect(index.get('middle')?.participantNumber).toBe(2);
    expect(index.get('newest')?.participantNumber).toBe(3);
  });

  it('breaks a createdAt tie by id, lexicographically', () => {
    const index = buildAggregateInterviewIndex([
      { id: 'b-interview', createdAt: 1_000, transcript: [] },
      { id: 'a-interview', createdAt: 1_000, transcript: [] },
    ]);

    expect(index.get('a-interview')?.participantNumber).toBe(1);
    expect(index.get('b-interview')?.participantNumber).toBe(2);
  });

  it('is unaffected by a later append: a newer interview does not renumber existing ones', () => {
    const before = buildAggregateInterviewIndex([
      { id: 'first', createdAt: 1_000, transcript: [] },
      { id: 'second', createdAt: 2_000, transcript: [] },
    ]);
    const after = buildAggregateInterviewIndex([
      { id: 'first', createdAt: 1_000, transcript: [] },
      { id: 'second', createdAt: 2_000, transcript: [] },
      { id: 'third', createdAt: 3_000, transcript: [] },
    ]);

    expect(after.get('first')?.participantNumber).toBe(before.get('first')?.participantNumber);
    expect(after.get('second')?.participantNumber).toBe(before.get('second')?.participantNumber);
    expect(after.get('third')?.participantNumber).toBe(3);
  });
});

describe('participantLabel', () => {
  it('renders two-digit-minimum labels, never truncated', () => {
    expect(participantLabel(1)).toBe('P01');
    expect(participantLabel(9)).toBe('P09');
    expect(participantLabel(10)).toBe('P10');
    expect(participantLabel(100)).toBe('P100');
  });
});

describe('resolveAggregateThemeEvidence', () => {
  const interviewA = [
    turn('ai', 'How do you keep track of your work?'),
    turn('user', 'I keep a short project note so I remember why I saved it.'),
  ];
  const interviewB = [
    turn('ai', 'How do you keep track of your work?'),
    turn('user', 'I keep a short project note so I remember why I saved it.'),
  ];

  function buildIndex() {
    return buildAggregateInterviewIndex([
      { id: 'interview-a', createdAt: 1_000, transcript: interviewA },
      { id: 'interview-b', createdAt: 2_000, transcript: interviewB },
    ]);
  }

  it('returns legacy for a representativeQuotes theme', () => {
    const theme: AggregateTheme = { theme: 'Note-taking', frequency: 2, representativeQuotes: ['A note.'] };
    const view = resolveAggregateThemeEvidence(theme, buildIndex());
    expect(view).toEqual({ kind: 'legacy', quotes: ['A note.'] });
  });

  it('returns none for an empty or absent quoteRefs array', () => {
    const empty: AggregateTheme = { theme: 'Note-taking', frequency: 2, quoteRefs: [] };
    expect(resolveAggregateThemeEvidence(empty, buildIndex())).toEqual({ kind: 'none' });

    const absent: AggregateTheme = { theme: 'Note-taking', frequency: 2 };
    expect(resolveAggregateThemeEvidence(absent, buildIndex())).toEqual({ kind: 'none' });
  });

  it('verifies a locatable ref with the record\'s own characters and the right participant number', () => {
    const theme: AggregateTheme = {
      theme: 'Note-taking', frequency: 2,
      quoteRefs: [ref('short project note', 2, 'interview-a')],
    };
    const view = resolveAggregateThemeEvidence(theme, buildIndex());
    expect(view.kind).toBe('refs');
    if (view.kind !== 'refs') throw new Error('expected refs');
    expect(view.entries).toHaveLength(1);
    expect(view.entries[0].match.status).toBe('verified');
    expect(view.entries[0].quotedFromRecord).toBe('short project note');
    expect(view.entries[0].participantNumber).toBe(1);
  });

  it('classifies an interviewId absent from the index as no-record', () => {
    const theme: AggregateTheme = {
      theme: 'Note-taking', frequency: 2,
      quoteRefs: [ref('short project note', 2, 'interview-deleted')],
    };
    const view = resolveAggregateThemeEvidence(theme, buildIndex());
    if (view.kind !== 'refs') throw new Error('expected refs');
    expect(view.entries[0].match).toEqual({ status: 'unverified', reason: 'no-record' });
    expect(view.entries[0].quotedFromRecord).toBeNull();
    expect(view.entries[0].participantNumber).toBeNull();
  });

  it('classifies a ref citing an interviewer turn that contains the quote as wrong-speaker', () => {
    const theme: AggregateTheme = {
      theme: 'Note-taking', frequency: 2,
      quoteRefs: [ref('How do you keep track', 1, 'interview-a')],
    };
    const view = resolveAggregateThemeEvidence(theme, buildIndex());
    if (view.kind !== 'refs') throw new Error('expected refs');
    expect(view.entries[0].match).toEqual({ status: 'unverified', reason: 'wrong-speaker' });
    expect(view.entries[0].participantNumber).toBe(1);
  });

  it('classifies an out-of-range turnIndex as no-turn', () => {
    const theme: AggregateTheme = {
      theme: 'Note-taking', frequency: 2,
      quoteRefs: [ref('short project note', 99, 'interview-a')],
    };
    const view = resolveAggregateThemeEvidence(theme, buildIndex());
    if (view.kind !== 'refs') throw new Error('expected refs');
    expect(view.entries[0].match).toEqual({ status: 'unverified', reason: 'no-turn' });
  });

  it('does not match across records: a quote present in a different interview than the one cited is not-found', () => {
    const index = buildAggregateInterviewIndex([
      { id: 'interview-a', createdAt: 1_000, transcript: [turn('ai', 'Q'), turn('user', 'Only interview A says this exact phrase.')] },
      { id: 'interview-b', createdAt: 2_000, transcript: [turn('ai', 'Q'), turn('user', 'Interview B says something unrelated.')] },
    ]);
    const theme: AggregateTheme = {
      theme: 'Cross-record', frequency: 1,
      // Cites interview-b, but the phrase only exists in interview-a's transcript.
      quoteRefs: [ref('Only interview A says this exact phrase.', 2, 'interview-b')],
    };
    const view = resolveAggregateThemeEvidence(theme, index);
    if (view.kind !== 'refs') throw new Error('expected refs');
    expect(view.entries[0].match).toEqual({ status: 'unverified', reason: 'not-found' });
  });

  it('never throws for a null, undefined, fractional, or NaN turn index, or an empty index', () => {
    const emptyIndex = buildAggregateInterviewIndex([]);
    const badRefs = [
      { quote: 'anything', turnIndex: null as unknown as number, interviewId: 'interview-a' },
      { quote: 'anything', turnIndex: undefined as unknown as number, interviewId: 'interview-a' },
      { quote: 'anything', turnIndex: 1.5, interviewId: 'interview-a' },
      { quote: 'anything', turnIndex: NaN, interviewId: 'interview-a' },
    ];
    for (const bad of badRefs) {
      const theme: AggregateTheme = { theme: 'Bad', frequency: 1, quoteRefs: [bad] };
      expect(() => resolveAggregateThemeEvidence(theme, buildIndex())).not.toThrow();
      expect(() => resolveAggregateThemeEvidence(theme, emptyIndex)).not.toThrow();
    }
  });
});

describe('withRecordBackedEvidence', () => {
  const transcript = [
    turn('ai', 'How do you keep track of your work?'),
    turn('user', 'I keep a short project note so I remember why I saved it.'),
  ];

  function synthesisWith(themes: SynthesisTheme[]): SynthesisResult {
    return {
      statedPreferences: [], revealedPreferences: [], themes,
      contradictions: [], keyInsights: [], bottomLine: 'Bottom line.',
    };
  }

  it('returns a legacy theme deep-equal to its input, with no evidenceRefs key added', () => {
    const legacyTheme: SynthesisTheme = { theme: 'Note-taking', evidence: 'Kept a note.', frequency: 1 };
    const synthesis = synthesisWith([legacyTheme]);
    const result = withRecordBackedEvidence(synthesis, transcript);

    expect(result.themes[0]).toEqual(legacyTheme);
    expect('evidenceRefs' in result.themes[0]).toBe(false);
  });

  it('drops an unlocatable ref', () => {
    const synthesis = synthesisWith([
      { theme: 'Note-taking', frequency: 1, evidenceRefs: [ref('this was never said', 2)] },
    ]);
    const result = withRecordBackedEvidence(synthesis, transcript);
    expect(result.themes[0].evidenceRefs).toEqual([]);
  });

  it("rewrites a locatable ref's quote to the record's own characters, a literal substring of the turn", () => {
    const synthesis = synthesisWith([
      { theme: 'Note-taking', frequency: 1, evidenceRefs: [ref('SHORT PROJECT NOTE', 2)] },
    ]);
    const result = withRecordBackedEvidence(synthesis, transcript);
    const [rewritten] = result.themes[0].evidenceRefs!;
    expect(rewritten.quote).toBe('short project note');
    expect(transcript[1].content.includes(rewritten.quote)).toBe(true);
  });
});
