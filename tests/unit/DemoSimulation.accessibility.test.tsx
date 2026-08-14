import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import DemoSimulation from '@/components/DemoSimulation';

describe('DemoSimulation accessibility', () => {
  it('names the sample response input and icon-only send control', () => {
    render(<DemoSimulation />);
    fireEvent.click(screen.getByRole('button', { name: /start sample/i }));

    expect(screen.getByRole('textbox', { name: 'Sample response' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send sample response' })).toBeInTheDocument();
  });
});
