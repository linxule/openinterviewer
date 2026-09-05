import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AggregateReading } from '@/components/SynthesisReading';
import { buildAggregateInterviewIndex, type AggregateInterviewIndex } from '@/lib/evidence';
import type { AggregateSynthesisResult } from '@/types';

// All transcript and quote content below is invented fixture content, never
// real participant text (AGENTS.md "Start here" §5).

const PARTICIPANT_TURN = 'I keep a short project note so I remember why I saved it.';

const interviewIndex: AggregateInterviewIndex = buildAggregateInterviewIndex([
  {
    id: 'interview-a',
    createdAt: 1_000,
    transcript: [
      { id: 'm-1', role: 'ai', content: 'How do you keep track of your work?', timestamp: 1 },
      { id: 'm-2', role: 'user', content: PARTICIPANT_TURN, timestamp: 2 },
    ],
  },
]);

const synthesis: AggregateSynthesisResult = {
  studyId: 'study-aggregate',
  studyRevision: 1,
  interviewIds: ['interview-a'],
  interviewCount: 1,
  aiProvider: 'gemini',
  aiModel: 'gemini-2.5-flash',
  commonThemes: [
    {
      theme: 'Verified theme', frequency: 1,
      // Model's copy differs in case from the record — the note must show
      // the RECORD's characters, not this string.
      quoteRefs: [{ quote: 'SHORT PROJECT NOTE', turnIndex: 2, interviewId: 'interview-a' }],
    },
    {
      theme: 'Unverified theme (interview not loaded)', frequency: 1,
      quoteRefs: [{ quote: 'anything at all', turnIndex: 2, interviewId: 'interview-deleted' }],
    },
    {
      theme: 'Empty theme', frequency: 1,
      quoteRefs: [],
    },
    {
      theme: 'Legacy theme', frequency: 1,
      representativeQuotes: ['A composed quote from before Slice L.'],
    },
  ],
  divergentViews: [],
  keyFindings: [],
  researchImplications: [],
  bottomLine: 'A bottom line.',
  generatedAt: Date.now(),
};

function Wrapper() {
  const [openNotes, setOpenNotes] = useState<Record<string, boolean>>({});
  return (
    <AggregateReading
      synthesis={synthesis}
      interviewIndex={interviewIndex}
      openNotes={openNotes}
      onNoteOpenChange={(themeIndex, refIndex, next) =>
        setOpenNotes((prev) => ({ ...prev, [`${themeIndex}:${refIndex}`]: next }))
      }
    />
  );
}

describe('AggregateReading citations (Slice L)', () => {
  it('renders a verified ref with the record\'s own characters, a P-coordinate, and a working transcript link', () => {
    render(<Wrapper />);

    const trigger = screen.getByRole('button', { name: 't.2' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    const note = trigger.parentElement!.querySelector('[role="region"]')!;
    expect(note.textContent).toContain('short project note');
    expect(note.textContent).not.toContain('SHORT PROJECT NOTE');
    expect(PARTICIPANT_TURN.includes('short project note')).toBe(true);

    expect(screen.getByText('P01 · turn 2')).toBeInTheDocument();

    const link = screen.getByRole('link', { name: "Read in P01's transcript" });
    expect(link).toHaveAttribute('href', '/dashboard/interview/interview-a?studyId=study-aggregate&turn=2');
  });

  it('toggles the note open and closed', () => {
    render(<Wrapper />);
    const trigger = screen.getByRole('button', { name: 't.2' });

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region')).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('region')).toBeInTheDocument();
  });

  it('renders an unverified ref (interview not in the index) as a serif unquoted passage with no trigger', () => {
    render(<Wrapper />);
    const passage = screen.getByText('anything at all');
    expect(passage.className).toMatch(/font-serif/);
    expect(passage.textContent).not.toMatch(/["“”]/);
    expect(passage.closest('li')!.querySelector('[aria-expanded]')).toBeNull();
  });

  it('renders an empty-quoteRefs theme with its name and no supporting passage', () => {
    render(<Wrapper />);
    const heading = screen.getByText('Empty theme');
    const item = heading.closest('li')!;
    expect(item.querySelectorAll('p.font-serif, [class*="font-serif"]').length).toBe(0);
  });

  it('renders a legacy representativeQuotes theme exactly as before, with no wine', () => {
    render(<Wrapper />);
    const passage = screen.getByText('A composed quote from before Slice L.');
    expect(passage.className).toMatch(/font-serif/);
    expect(passage.closest('li')!.querySelector('[aria-expanded]')).toBeNull();
  });

  it('renders no svg anywhere (the Slice F/I icon ratchet)', () => {
    const { container } = render(<Wrapper />);
    expect(container.querySelectorAll('svg')).toHaveLength(0);
  });

  it('carries no --evidence styling outside a Citation', () => {
    const { container } = render(<Wrapper />);
    const clone = container.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('button[aria-expanded]').forEach((trigger) => {
      trigger.parentElement?.remove();
    });
    expect(clone.innerHTML).not.toContain('--evidence');
  });
});
