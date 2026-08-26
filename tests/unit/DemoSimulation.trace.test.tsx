import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import DemoSimulation from '@/components/DemoSimulation';

function beginDemo() {
  fireEvent.click(screen.getByRole('button', { name: /begin scripted interview/i }));
}

function completeProjectPath() {
  fireEvent.click(screen.getByRole('button', { name: /useful for a work project/i }));
  fireEvent.click(screen.getByRole('button', { name: /forgotten which project/i }));
  fireEvent.click(screen.getByRole('button', { name: /one-line note in my own words/i }));
}

describe('DemoSimulation trace grammar', () => {
  it('shows the insight-view evidence quote unfolded by default and toggles it', () => {
    render(<DemoSimulation />);
    beginDemo();
    completeProjectPath();
    fireEvent.click(screen.getByRole('button', { name: /see researcher view/i }));

    const trigger = screen.getByRole('button', { name: 't.4' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/forgotten which project it was for/i)).toBeInTheDocument();
    expect(screen.getByText('Maya · participant response · turn 4')).toBeInTheDocument();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/forgotten which project it was for/i)).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/forgotten which project it was for/i)).toBeInTheDocument();
  });

  it('keeps the log and status regions as siblings, one of each, on the interview view', () => {
    const { container } = render(<DemoSimulation />);
    beginDemo();

    const statusNodes = screen.getAllByRole('status');
    const logNodes = container.querySelectorAll('[role="log"]');

    expect(statusNodes).toHaveLength(1);
    expect(logNodes).toHaveLength(1);
    expect(logNodes[0].contains(statusNodes[0])).toBe(false);
  });

  it('carries no icon svgs across intro, interview, or insight views', () => {
    const { container } = render(<DemoSimulation />);
    expect(container.querySelectorAll('svg')).toHaveLength(0);

    beginDemo();
    expect(container.querySelectorAll('svg')).toHaveLength(0);

    completeProjectPath();
    fireEvent.click(screen.getByRole('button', { name: /see researcher view/i }));
    expect(container.querySelectorAll('svg')).toHaveLength(0);
  });
});
