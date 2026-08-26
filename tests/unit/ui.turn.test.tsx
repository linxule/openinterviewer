import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Turn } from '@/components/ui';

describe('Turn', () => {
  it('applies serif participant typography and sans interviewer typography', () => {
    const { container: participantContainer } = render(
      <Turn speaker="participant">I think the onboarding was confusing.</Turn>
    );
    const participantText = screen.getByText('I think the onboarding was confusing.');
    expect(participantText.className).toContain('font-serif');
    expect(participantText.className).toContain('pl-8');

    participantContainer.remove();

    render(<Turn speaker="interviewer">What happened next?</Turn>);
    const interviewerText = screen.getByText('What happened next?');
    expect(interviewerText.className).toContain('font-sans');
    expect(interviewerText.className).not.toContain('font-serif');
  });

  it('hides the coordinate by default and shows it only with showCoordinate + turnIndex', () => {
    const { rerender } = render(<Turn speaker="participant" turnIndex={4}>Answer text</Turn>);
    expect(screen.queryByText(/t\. 4/)).not.toBeInTheDocument();

    rerender(
      <Turn speaker="participant" turnIndex={4} showCoordinate>
        Answer text
      </Turn>
    );
    expect(screen.getByText(/t\. 4/)).toBeInTheDocument();

    rerender(
      <Turn speaker="participant" showCoordinate>
        Answer text
      </Turn>
    );
    expect(screen.queryByText(/t\./)).not.toBeInTheDocument();
  });
});
