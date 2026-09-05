import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SynthesisReading, ProvenanceFooter } from '@/components/SynthesisReading';
import type { InterviewMessage, SynthesisResult } from '@/types';

const transcript: InterviewMessage[] = [
  { id: 'm-1', role: 'ai', content: 'What brought you here today?', timestamp: 1000 },
  { id: 'm-2', role: 'user', content: 'I wanted to understand my options before deciding.', timestamp: 2000 },
];

const synthesis: SynthesisResult = {
  statedPreferences: ['Said A'],
  revealedPreferences: ['Revealed B'],
  themes: [
    {
      theme: 'Verified theme',
      frequency: 1,
      evidenceRefs: [
        { quote: 'understand my options', turnIndex: 2 },
        { quote: 'before deciding', turnIndex: 2 },
      ],
    },
    {
      theme: 'Legacy theme',
      frequency: 1,
      evidence: 'A supporting passage from before Initiative 2.',
    },
  ],
  contradictions: ['A contradiction'],
  keyInsights: ['An insight'],
  bottomLine: 'A bottom line',
};

describe('SynthesisReading', () => {
  it('renders the five sections in order with verbatim headings and the harmonized sub-label', () => {
    const { container } = render(
      <SynthesisReading
        synthesis={synthesis}
        transcript={transcript}
        openNotes={{}}
        onNoteOpenChange={vi.fn()}
      />
    );

    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(['Stated vs Revealed', 'Key Themes', 'Potential Contradictions', 'Additional Insights']);

    const bottomLineIndex = container.textContent!.indexOf('Bottom line');
    const statedIndex = container.textContent!.indexOf('Stated vs Revealed');
    expect(bottomLineIndex).toBeGreaterThanOrEqual(0);
    expect(bottomLineIndex).toBeLessThan(statedIndex);

    expect(screen.getByText('What their behavior revealed')).toBeInTheDocument();
    expect(screen.queryByText('What behavior revealed')).not.toBeInTheDocument();
  });

  it('renders a verified ref as a Citation trigger; with onTraceToTurn the note carries the jump button', () => {
    const onTraceToTurn = vi.fn();
    render(
      <SynthesisReading
        synthesis={synthesis}
        transcript={transcript}
        openNotes={{}}
        onNoteOpenChange={vi.fn()}
        onTraceToTurn={onTraceToTurn}
      />
    );

    const triggers = screen.getAllByRole('button', { name: 't.2' });
    expect(triggers).toHaveLength(2);

    const jumpButtons = screen.getAllByRole('button', { name: 'Read in full transcript' });
    expect(jumpButtons).toHaveLength(2);
    fireEvent.click(jumpButtons[0]);
    expect(onTraceToTurn).toHaveBeenCalledWith(2);
  });

  it('renders no jump button anywhere when onTraceToTurn is omitted', () => {
    render(
      <SynthesisReading
        synthesis={synthesis}
        transcript={transcript}
        openNotes={{}}
        onNoteOpenChange={vi.fn()}
      />
    );
    expect(screen.queryByRole('button', { name: 'Read in full transcript' })).not.toBeInTheDocument();
  });

  it('renders a legacy evidence theme as a serif unquoted passage with no trigger', () => {
    render(
      <SynthesisReading
        synthesis={synthesis}
        transcript={transcript}
        openNotes={{}}
        onNoteOpenChange={vi.fn()}
      />
    );
    const passage = screen.getByText('A supporting passage from before Initiative 2.');
    expect(passage.className).toMatch(/font-serif/);
    expect(passage.textContent).not.toMatch(/["“”]/);
  });

  it('an explicit false in openNotes collapses that one note and leaves its sibling open', () => {
    render(
      <SynthesisReading
        synthesis={synthesis}
        transcript={transcript}
        openNotes={{ '0:0': false }}
        onNoteOpenChange={vi.fn()}
      />
    );

    const triggers = screen.getAllByRole('button', { name: 't.2' });
    expect(triggers[0]).toHaveAttribute('aria-expanded', 'false');
    expect(triggers[1]).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('ProvenanceFooter', () => {
  it('prints the saved-record grammar with all fields present', () => {
    render(<ProvenanceFooter model="m" studyRevision={3} timestamp="Jan 1, 2026" verb="saved" />);
    expect(screen.getByText('Synthesized by m · study rev 3 · saved Jan 1, 2026')).toBeInTheDocument();
  });

  it('falls back to "unrecorded model" when model is missing', () => {
    render(<ProvenanceFooter studyRevision={3} timestamp="Jan 1, 2026" verb="saved" />);
    expect(screen.getByText(/^Synthesized by unrecorded model/)).toBeInTheDocument();
  });

  it('falls back to "—" when studyRevision is missing', () => {
    render(<ProvenanceFooter model="m" timestamp="Jan 1, 2026" verb="saved" />);
    expect(screen.getByText(/study rev —/)).toBeInTheDocument();
  });

  it('appends a trailing note for the generated verb', () => {
    render(
      <ProvenanceFooter
        model="m"
        studyRevision={4}
        timestamp="Jan 2, 2026, 10:00 AM"
        verb="generated"
        note="not saved — regenerate to refresh"
      />
    );
    expect(
      screen.getByText('Synthesized by m · study rev 4 · generated Jan 2, 2026, 10:00 AM · not saved — regenerate to refresh')
    ).toBeInTheDocument();
  });

  it('never prints a receipt clause', () => {
    const { container } = render(<ProvenanceFooter model="m" studyRevision={1} timestamp="Jan 1, 2026" verb="saved" />);
    expect(container.textContent).not.toMatch(/receipt/i);
  });
});
