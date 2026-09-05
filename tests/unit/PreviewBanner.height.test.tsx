import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { useStore } from '@/store';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/interview',
}));

import PreviewBanner from '@/components/PreviewBanner';

// The global ResizeObserver stub in tests/setup.ts is a no-op that never
// invokes its callback. This slice-local stub tracks what was observed so we
// can assert the mechanism is wired up, per Ruling 1's instruction to stub
// locally rather than change the shared setup file.
class TrackingResizeObserver {
  static instances: TrackingResizeObserver[] = [];
  observed: Element[] = [];
  disconnected = false;
  constructor(_callback: ResizeObserverCallback) {
    TrackingResizeObserver.instances.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
}

let originalResizeObserver: typeof ResizeObserver;

beforeEach(() => {
  TrackingResizeObserver.instances = [];
  originalResizeObserver = window.ResizeObserver;
  window.ResizeObserver = TrackingResizeObserver as unknown as typeof ResizeObserver;
  useStore.setState(useStore.getInitialState(), true);
  useStore.setState({ viewMode: 'preview' });
});

afterEach(() => {
  window.ResizeObserver = originalResizeObserver;
});

describe('PreviewBanner height mechanism (Ruling 1)', () => {
  it('sets --preview-banner-height on mount when visible on a participant page in preview', () => {
    render(<PreviewBanner />);

    const value = document.documentElement.style.getPropertyValue('--preview-banner-height');
    expect(value).not.toBe('');
    expect(value.endsWith('px')).toBe(true);
    expect(TrackingResizeObserver.instances).toHaveLength(1);
    expect(TrackingResizeObserver.instances[0].observed).toHaveLength(1);
  });

  it('removes --preview-banner-height on unmount', () => {
    const { unmount } = render(<PreviewBanner />);
    expect(document.documentElement.style.getPropertyValue('--preview-banner-height')).not.toBe('');

    unmount();

    expect(document.documentElement.style.getPropertyValue('--preview-banner-height')).toBe('');
    expect(TrackingResizeObserver.instances[0].disconnected).toBe(true);
  });

  it('does not set the property when not visible (not preview mode)', () => {
    useStore.setState({ viewMode: 'researcher' });
    render(<PreviewBanner />);

    expect(document.documentElement.style.getPropertyValue('--preview-banner-height')).toBe('');
  });
});
