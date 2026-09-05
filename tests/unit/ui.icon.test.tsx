import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Icon, type IconName } from '@/components/ui';

const NAMES: IconName[] = ['close', 'copy', 'external', 'chevron', 'check', 'alert'];

describe('Icon', () => {
  it.each(NAMES)('renders exactly one accessible-hidden, non-focusable svg for "%s"', (name) => {
    const { container } = render(<Icon name={name} />);
    const svgs = container.querySelectorAll('svg');
    expect(svgs).toHaveLength(1);
    const svg = svgs[0];
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('focusable')).toBe('false');
    expect(svg.getAttribute('stroke')).toBe('currentColor');
    expect(svg).not.toHaveAttribute('role');
    expect(svg).not.toHaveAttribute('title');
    expect(svg).not.toHaveAttribute('aria-label');
  });

  it('defaults to size 16 and honors an explicit size', () => {
    const { container: defaultContainer } = render(<Icon name="close" />);
    const defaultSvg = defaultContainer.querySelector('svg')!;
    expect(defaultSvg.getAttribute('width')).toBe('16');
    expect(defaultSvg.getAttribute('height')).toBe('16');

    const { container: sizedContainer } = render(<Icon name="close" size={18} />);
    const sizedSvg = sizedContainer.querySelector('svg')!;
    expect(sizedSvg.getAttribute('width')).toBe('18');
    expect(sizedSvg.getAttribute('height')).toBe('18');
  });

  it('sets no colour class of its own beyond a caller-supplied one', () => {
    const { container: plain } = render(<Icon name="close" />);
    const plainSvg = plain.querySelector('svg')!;
    expect(plainSvg.className.baseVal ?? plainSvg.getAttribute('class') ?? '').not.toMatch(/text-|fill-/);

    const { container: withCaller } = render(<Icon name="close" className="rotate-180" />);
    const calledSvg = withCaller.querySelector('svg')!;
    expect(calledSvg.getAttribute('class')).toMatch(/rotate-180/);
  });
});
