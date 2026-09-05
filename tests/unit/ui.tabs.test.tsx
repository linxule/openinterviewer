import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { Tabs, type TabItem } from '@/components/ui';

const ITEMS: TabItem<'a' | 'b' | 'c'>[] = [
  { id: 'a', label: 'A' },
  { id: 'b', label: 'B' },
  { id: 'c', label: 'C' },
];

function ControlledTabs({ onValueChange }: { onValueChange: (id: 'a' | 'b' | 'c') => void }) {
  const [value, setValue] = useState<'a' | 'b' | 'c'>('a');
  return (
    <Tabs
      items={ITEMS}
      value={value}
      onValueChange={(id) => {
        setValue(id);
        onValueChange(id);
      }}
      label="Example sections"
    >
      <p>{`Panel ${value}`}</p>
    </Tabs>
  );
}

describe('Tabs', () => {
  it('renders a tablist with the given label and tabs with roles, aria-selected, aria-controls, and tabIndex', () => {
    const onValueChange = vi.fn();
    render(
      <Tabs items={ITEMS} value="a" onValueChange={onValueChange} label="Example sections">
        <p>Panel content</p>
      </Tabs>
    );

    const tablist = screen.getByRole('tablist', { name: 'Example sections' });
    expect(tablist).toBeInTheDocument();

    const tabA = screen.getByRole('tab', { name: 'A' });
    const tabB = screen.getByRole('tab', { name: 'B' });
    const tabC = screen.getByRole('tab', { name: 'C' });

    expect(tabA).toHaveAttribute('aria-selected', 'true');
    expect(tabB).toHaveAttribute('aria-selected', 'false');
    expect(tabC).toHaveAttribute('aria-selected', 'false');

    expect(tabA).toHaveAttribute('tabIndex', '0');
    expect(tabB).toHaveAttribute('tabIndex', '-1');
    expect(tabC).toHaveAttribute('tabIndex', '-1');

    const panel = screen.getByRole('tabpanel');
    expect(tabA).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveAttribute('aria-labelledby', tabA.id);
    expect(panel).toHaveAttribute('tabIndex', '0');

    for (const tab of [tabA, tabB, tabC]) {
      expect(tab).toHaveClass('min-h-11');
    }
  });

  it('only renders the active panel content', () => {
    render(
      <Tabs items={ITEMS} value="a" onValueChange={vi.fn()} label="Example sections">
        {'a' === 'a' ? <p>Only A content</p> : <p>Other content</p>}
      </Tabs>
    );
    expect(screen.getByText('Only A content')).toBeInTheDocument();
    expect(screen.queryByText('Other content')).not.toBeInTheDocument();
  });

  it('a click calls onValueChange exactly once with the clicked tab id', () => {
    const onValueChange = vi.fn();
    render(
      <Tabs items={ITEMS} value="a" onValueChange={onValueChange} label="Example sections">
        <p>Panel content</p>
      </Tabs>
    );

    fireEvent.click(screen.getByRole('tab', { name: 'B' }));
    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith('b');
  });

  it('ArrowRight moves focus without activating (manual activation), and Enter activates the focused tab', () => {
    const onValueChange = vi.fn();
    render(
      <Tabs items={ITEMS} value="a" onValueChange={onValueChange} label="Example sections">
        <p>Panel content</p>
      </Tabs>
    );

    const tabA = screen.getByRole('tab', { name: 'A' });
    const tabB = screen.getByRole('tab', { name: 'B' });
    tabA.focus();

    tabA.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(tabB);
    expect(onValueChange).not.toHaveBeenCalled();

    tabB.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith('b');
  });

  it('ArrowRight wraps from the last tab to the first, and ArrowLeft wraps from the first to the last', () => {
    render(
      <Tabs items={ITEMS} value="a" onValueChange={vi.fn()} label="Example sections">
        <p>Panel content</p>
      </Tabs>
    );

    const tabA = screen.getByRole('tab', { name: 'A' });
    const tabC = screen.getByRole('tab', { name: 'C' });

    tabC.focus();
    tabC.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(tabA);

    tabA.focus();
    tabA.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(document.activeElement).toBe(tabC);
  });

  it('Home and End move focus to the first and last tabs', () => {
    render(
      <Tabs items={ITEMS} value="a" onValueChange={vi.fn()} label="Example sections">
        <p>Panel content</p>
      </Tabs>
    );

    const tabA = screen.getByRole('tab', { name: 'A' });
    const tabB = screen.getByRole('tab', { name: 'B' });
    const tabC = screen.getByRole('tab', { name: 'C' });

    tabB.focus();
    tabB.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement).toBe(tabC);

    tabC.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(document.activeElement).toBe(tabA);
  });

  it('composes with a controlled parent: clicking a tab switches the visible panel', () => {
    const onValueChange = vi.fn();
    render(<ControlledTabs onValueChange={onValueChange} />);

    expect(screen.getByText('Panel a')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'B' }));
    expect(onValueChange).toHaveBeenCalledWith('b');
    expect(screen.getByText('Panel b')).toBeInTheDocument();
    expect(screen.queryByText('Panel a')).not.toBeInTheDocument();
  });
});
