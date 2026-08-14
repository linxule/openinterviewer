import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import DemoSimulation from '@/components/DemoSimulation';

function beginDemo() {
  fireEvent.click(screen.getByRole('button', { name: /begin scripted interview/i }));
}

function completeProjectPath() {
  fireEvent.click(screen.getByRole('button', { name: /useful for a work project/i }));
  fireEvent.click(screen.getByRole('button', { name: /forgotten which project/i }));
  fireEvent.click(screen.getByRole('button', { name: /one-line note in my own words/i }));
}

describe('DemoSimulation', () => {
  it('presents a named study, a persistent disclosure, and accessible fictional choices', () => {
    render(<DemoSimulation />);

    expect(screen.getByRole('heading', { level: 1, name: /see an interview become an insight/i })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: /demo disclosure/i })).toHaveTextContent(/maya is fictional/i);

    beginDemo();

    expect(screen.getByRole('heading', { level: 1, name: /reading lists people actually return to/i })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/question 1 of 3/i);
    expect(screen.getByRole('group', { name: /choose maya’s response/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /useful for a work project/i })).toBeInTheDocument();
  });

  it('closes the loop from an adaptive branch to a provenance-backed researcher note', () => {
    render(<DemoSimulation />);
    beginDemo();
    completeProjectPath();

    expect(screen.getByRole('status')).toHaveTextContent(/interview complete/i);
    expect(screen.getByText(/compare this account with other interviews/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /see researcher view/i })).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: /see researcher view/i }));

    expect(screen.getByRole('heading', { level: 1, name: /illustrative synthesis/i })).toBeInTheDocument();
    expect(screen.getByTestId('demo-insight-disclosure')).toHaveTextContent(/no model analyzed maya/i);
    expect(screen.getByText(/lost context creates re-entry work/i)).toBeInTheDocument();
    expect(screen.getByText(/forgotten which project it was for/i)).toBeInTheDocument();
    expect(screen.getByText(/interpretation, not a research finding/i)).toBeInTheDocument();
  });

  it('keeps the alternate project evidence aligned with its branch-level interpretation', () => {
    render(<DemoSimulation />);
    beginDemo();

    fireEvent.click(screen.getByRole('button', { name: /useful for a work project/i }));
    fireEvent.click(screen.getByRole('button', { name: /could not remember why i had saved it/i }));
    fireEvent.click(screen.getByRole('button', { name: /project name and the question/i }));
    fireEvent.click(screen.getByRole('button', { name: /see researcher view/i }));

    expect(screen.getByText(/could not remember why i had saved it/i)).toBeInTheDocument();
    expect(screen.getByText(/lost context creates re-entry work/i)).toBeInTheDocument();
    expect(screen.getByText(/reconstructing purpose becomes part of the cost/i)).toBeInTheDocument();
  });

  it('changes both the probe and the illustrative synthesis when another path is chosen', () => {
    render(<DemoSimulation />);
    beginDemo();

    fireEvent.click(screen.getByRole('button', { name: /headline made me curious/i }));
    expect(screen.getByText(/curiosity was enough to save it/i)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/scripted branch: fading curiosity/i);

    fireEvent.click(screen.getByRole('button', { name: /dozens of saved pieces/i }));
    fireEvent.click(screen.getByRole('button', { name: /older items quietly expire/i }));
    fireEvent.click(screen.getByRole('button', { name: /see researcher view/i }));

    expect(screen.getByText(/saved curiosity becomes undifferentiated backlog/i)).toBeInTheDocument();
    expect(screen.getByText(/original spark restored or permission for the item to disappear/i)).toBeInTheDocument();
  });

  it('traces evidence back to the transcript and can replay from a clean path', () => {
    render(<DemoSimulation />);
    beginDemo();
    completeProjectPath();
    fireEvent.click(screen.getByRole('button', { name: /see researcher view/i }));

    fireEvent.click(screen.getByRole('button', { name: /trace this insight in the transcript/i }));

    expect(screen.getByTestId('demo-evidence-turn')).toHaveClass('ring-2');
    expect(screen.getByRole('button', { name: /return to researcher note/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /return to researcher note/i }));
    fireEvent.click(screen.getByRole('button', { name: /replay another path/i }));

    expect(screen.getByRole('status')).toHaveTextContent(/question 1 of 3/i);
    expect(screen.queryByText(/scripted branch: project context/i)).not.toBeInTheDocument();
  });
});
