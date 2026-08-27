// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { resolveEvidenceRef, resolveThemeEvidence } from '@/lib/evidence';
import { EvidenceRef, InterviewMessage } from '@/types';

// All transcript and quote content below is invented for this test, in the
// register of DemoSimulation's Maya fixtures. Never real participant text.

function turn(role: InterviewMessage['role'], content: string, id = 'm'): InterviewMessage {
  return { id, role, content, timestamp: 1 };
}

function ref(quote: string, turnIndex: number): EvidenceRef {
  return { quote, turnIndex };
}

describe('resolveEvidenceRef', () => {
  it('folds curly quotes and apostrophes on the turn side to match a straight-quoted citation', () => {
    const transcript = [
      turn('ai', 'What was that migration like for you?'),
      turn('user', 'Her exact words were: “I can’t keep up.”'),
    ];
    const match = resolveEvidenceRef(ref("I can't keep up.", 2), transcript);
    expect(match.status).toBe('verified');
  });

  it('folds curly quotes and apostrophes on the quote side, including a self-wrapped citation, to match a straight turn', () => {
    const transcript = [
      turn('ai', 'How did that feel?'),
      turn('user', 'She told me, "I can\'t keep up," during the call.'),
    ];
    const match = resolveEvidenceRef(ref('“I can’t keep up”', 2), transcript);
    expect(match.status).toBe('verified');
  });

  it('strips quotation marks the model added around a citation the turn does not itself contain', () => {
    const transcript = [
      turn('ai', 'How was the new process?'),
      turn('user', 'I felt overwhelmed by the new process.'),
    ];
    const match = resolveEvidenceRef(ref('"felt overwhelmed by the new process"', 2), transcript);
    expect(match.status).toBe('verified');
  });

  it('collapses NBSP, tab, and newline runs in the turn to single spaces and still matches', () => {
    const transcript = [
      turn('ai', 'Tell me about the layout.'),
      turn('user', 'I was\t\tconfused\n\nby the new layout.'),
    ];
    const match = resolveEvidenceRef(ref('I was confused by the new layout', 2), transcript);
    expect(match.status).toBe('verified');
  });

  it('matches across a case difference', () => {
    const transcript = [
      turn('ai', 'What did you think?'),
      turn('user', 'The new layout was CONFUSING at first.'),
    ];
    const match = resolveEvidenceRef(ref('confusing at first', 2), transcript);
    expect(match.status).toBe('verified');
  });

  it('folds an en dash in the turn to match a hyphen in the quote', () => {
    const transcript = [
      turn('ai', 'What was the tradeoff?'),
      turn('user', 'It was a trade–off between speed and accuracy.'),
    ];
    const match = resolveEvidenceRef(ref('trade-off between speed and accuracy', 2), transcript);
    expect(match.status).toBe('verified');
  });

  it('matches a combining-accent form of a word against a precomposed form via NFKC', () => {
    const transcript = [
      turn('ai', 'Where did you meet?'),
      turn('user', 'The café closed early.'), // precomposed é
    ];
    const match = resolveEvidenceRef(ref('café closed early', 2), transcript); // decomposed e + combining acute
    expect(match.status).toBe('verified');
  });

  it('verifies an internal-ellipsis citation whose segments appear in order, both with ... and with the single-character ellipsis', () => {
    const transcript = [
      turn('ai', 'Walk me through onboarding.'),
      turn(
        'user',
        'I started the onboarding flow, got confused by the settings page, and then gave up for the day.'
      ),
    ];
    const dotted = resolveEvidenceRef(
      ref('I started the onboarding flow...gave up for the day', 2),
      transcript
    );
    expect(dotted.status).toBe('verified');

    const curly = resolveEvidenceRef(
      ref('I started the onboarding flow…gave up for the day', 2),
      transcript
    );
    expect(curly.status).toBe('verified');
  });

  it('rejects an internal-ellipsis citation whose segments appear out of order', () => {
    const transcript = [
      turn('ai', 'Walk me through onboarding.'),
      turn(
        'user',
        'I started the onboarding flow, got confused by the settings page, and then gave up for the day.'
      ),
    ];
    const match = resolveEvidenceRef(
      ref('gave up for the day...I started the onboarding flow', 2),
      transcript
    );
    expect(match).toEqual({ status: 'unverified', reason: 'not-found' });
  });

  it('refuses a collage of more than six ellipsis segments rather than verifying a truncated prefix', () => {
    const transcript = [
      turn('ai', 'Tell me about the tool.'),
      turn(
        'user',
        'I opened the app, found the dashboard, clicked the export button, saved the file, shared the link, closed the tab, and made a coffee.'
      ),
    ];
    // Seven in-order segments: every one is present, so a silent cap at six
    // would wrongly verify the first six and drop the seventh.
    const collage =
      'opened the app...found the dashboard...clicked the export...saved the file...shared the link...closed the tab...made a coffee';
    const match = resolveEvidenceRef(ref(collage, 2), transcript);
    expect(match).toEqual({ status: 'unverified', reason: 'not-found' });

    // Six segments from the same turn still verify.
    const sixSegments =
      'opened the app...found the dashboard...clicked the export...saved the file...shared the link...closed the tab';
    expect(resolveEvidenceRef(ref(sixSegments, 2), transcript).status).toBe('verified');
  });

  it('strips a leading and trailing ellipsis on the quote rather than treating it as a segment marker', () => {
    const transcript = [
      turn('ai', 'How did onboarding go?'),
      turn('user', 'I started the onboarding flow and immediately got stuck.'),
    ];
    const match = resolveEvidenceRef(
      ref('…I started the onboarding flow…', 2),
      transcript
    );
    expect(match.status).toBe('verified');
    if (match.status === 'verified') {
      expect(match.spans).toHaveLength(1);
    }
  });

  it('reports not-found when the quote is genuinely absent from the cited turn', () => {
    const transcript = [
      turn('ai', 'How was the onboarding?'),
      turn('user', 'It went smoothly, no complaints.'),
    ];
    const match = resolveEvidenceRef(ref('a complete disaster from start to finish', 2), transcript);
    expect(match).toEqual({ status: 'unverified', reason: 'not-found' });
  });

  it('reports not-found when the quote is present in a different turn than the one cited', () => {
    const transcript = [
      turn('user', 'The onboarding flow was a complete disaster from start to finish.', 'm1'),
      turn('user', 'Everything after that went fine.', 'm2'),
    ];
    const match = resolveEvidenceRef(
      ref('a complete disaster from start to finish', 2),
      transcript
    );
    expect(match).toEqual({ status: 'unverified', reason: 'not-found' });
  });

  it('reports no-turn for zero, negative, fractional, and NaN turn indexes', () => {
    const transcript = [turn('user', 'Some content here.')];
    for (const bad of [0, -1, 1.5, NaN]) {
      const match = resolveEvidenceRef(ref('some content here', bad), transcript);
      expect(match).toEqual({ status: 'unverified', reason: 'no-turn' });
    }
  });

  it('reports no-turn one past the end and resolves the boundary index to the last turn', () => {
    const transcript = [
      turn('ai', 'Opening question.', 'm1'),
      turn('user', 'The final answer was quite clear.', 'm2'),
    ];
    const tooFar = resolveEvidenceRef(ref('the final answer was quite clear', 3), transcript);
    expect(tooFar).toEqual({ status: 'unverified', reason: 'no-turn' });

    const atBoundary = resolveEvidenceRef(ref('the final answer was quite clear', 2), transcript);
    expect(atBoundary.status).toBe('verified');
  });

  it('reports wrong-speaker for an interviewer or system turn even when the quote is present', () => {
    const transcript = [
      turn('ai', 'The onboarding flow felt confusing to many participants.', 'm1'),
      turn('system', 'The onboarding flow felt confusing to many participants.', 'm2'),
    ];
    expect(
      resolveEvidenceRef(ref('the onboarding flow felt confusing to many participants', 1), transcript)
    ).toEqual({ status: 'unverified', reason: 'wrong-speaker' });
    expect(
      resolveEvidenceRef(ref('the onboarding flow felt confusing to many participants', 2), transcript)
    ).toEqual({ status: 'unverified', reason: 'wrong-speaker' });
  });

  it('reports empty-quote for a whitespace-only quote and too-short for a three-character quote', () => {
    const transcript = [turn('user', 'It felt like work every single day.')];
    expect(resolveEvidenceRef(ref('   ', 1), transcript)).toEqual({
      status: 'unverified',
      reason: 'empty-quote',
    });
    expect(resolveEvidenceRef(ref('day', 1), transcript)).toEqual({
      status: 'unverified',
      reason: 'too-short',
    });
  });

  it('verifies a phrase repeated twice in one turn, counting occurrences and anchoring the span at the first', () => {
    const transcript = [
      turn('user', 'It felt like work. It felt like work every single day.'),
    ];
    const match = resolveEvidenceRef(ref('it felt like work', 1), transcript);
    expect(match.status).toBe('verified');
    if (match.status === 'verified') {
      expect(match.occurrences).toBe(2);
      expect(match.spans).toHaveLength(1);
      const [span] = match.spans;
      expect(transcript[0].content.slice(span.start, span.end)).toBe('It felt like work');
    }
  });

  it('never throws for a malformed ref, an empty transcript, or an oversized quote', () => {
    expect(() => resolveEvidenceRef(ref('x'.repeat(2_000), 1), [])).not.toThrow();
    expect(() => resolveEvidenceRef({} as EvidenceRef, [])).not.toThrow();
    expect(() => resolveEvidenceRef(ref('anything', 1), [])).not.toThrow();
    expect(resolveEvidenceRef(ref('anything', 1), [])).toEqual({
      status: 'unverified',
      reason: 'no-turn',
    });
  });
});

describe('resolveThemeEvidence — span fidelity and joining', () => {
  it('renders the note from the record\'s own characters — capital, curly marks and all', () => {
    const transcript = [
      turn('ai', 'How did that go?', 'm1'),
      turn('user', 'She said, “I can’t keep up” at review.', 'm2'),
    ];
    const theme = { theme: 'Overload', frequency: 1, evidenceRefs: [ref("i can't keep up", 2)] };

    const view = resolveThemeEvidence(theme, transcript);
    expect(view.kind).toBe('refs');
    if (view.kind === 'refs') {
      const [entry] = view.entries;
      expect(entry.match.status).toBe('verified');
      expect(entry.quotedFromRecord).toBe('I can’t keep up');
      expect(entry.quotedFromRecord).not.toBeNull();
      expect(transcript[1].content).toContain(entry.quotedFromRecord as string);
    }
  });

  it('joins a multi-segment quotedFromRecord with a hair-spaced ellipsis, each piece a literal substring of the turn', () => {
    const transcript = [
      turn('ai', 'Walk me through onboarding.', 'm1'),
      turn(
        'user',
        'I started the onboarding flow, got confused by the settings page, and then gave up for the day.',
        'm2'
      ),
    ];
    const theme = {
      theme: 'Onboarding friction',
      frequency: 1,
      evidenceRefs: [ref('I started the onboarding flow...gave up for the day', 2)],
    };

    const view = resolveThemeEvidence(theme, transcript);
    expect(view.kind).toBe('refs');
    if (view.kind === 'refs') {
      const [entry] = view.entries;
      expect(entry.match.status).toBe('verified');
      const joined = entry.quotedFromRecord as string;
      expect(joined).toContain(' … ');
      for (const piece of joined.split(' … ')) {
        expect(transcript[1].content).toContain(piece);
      }
    }
  });

  it('returns kind: none for a new-shape theme with an empty evidenceRefs array', () => {
    const transcript = [turn('user', 'Anything at all.')];
    const view = resolveThemeEvidence({ theme: 'Empty', frequency: 0, evidenceRefs: [] }, transcript);
    expect(view).toEqual({ kind: 'none' });
  });

  it('returns kind: legacy for an old-shape theme carrying a free-text evidence string', () => {
    const transcript = [turn('user', 'Anything at all.')];
    const view = resolveThemeEvidence(
      { theme: 'Legacy', frequency: 1, evidence: 'A free-text supporting passage.' },
      transcript
    );
    expect(view).toEqual({ kind: 'legacy', text: 'A free-text supporting passage.' });
  });
});
